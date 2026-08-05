/**
 * What the board says, when it disagrees with the lease.
 *
 * Plane is where humans work. Someone opens it, unassigns an agent or closes an
 * item, and reasonably expects that to mean something — but the lease lived only
 * in the gateway, so it meant nothing at all: the agent kept working and
 * eventually submitted results against an item its owner had already moved on
 * from. The person who did the unassigning had no way to know their intervention
 * had been ignored, which is worse than it sounds, because the whole point of
 * doing it in Plane was that Plane is the thing they can see.
 *
 * So the board is authoritative about *whether the work is still the agent's*,
 * while the lease stays authoritative about *who holds it*. Those are different
 * questions and this is the only place they meet.
 *
 * Two signals count, and only two:
 *
 *   - the agent is no longer among the assignees — somebody took it off them
 *   - the item moved to a completed or cancelled state — it is finished or dropped
 *
 * Everything else a human might change (title, priority, labels, description) is
 * not a statement about ownership and is deliberately ignored. A revocation stops
 * an agent mid-task, so the bar for triggering one is an act that can only mean
 * "this is not yours any more".
 *
 * This is only safe because `claim` mirrors into Plane synchronously. When the
 * mirror was fire-and-forget there was a window where the gateway held a lease
 * Plane had not heard about, and reconciling during it would have revoked the
 * lease for the crime of being new. The `mirrored` guard below closes what
 * remains of that: a lease is compared against Plane only once Plane has been
 * told about it.
 */
import type { Pool } from './db.js';
import type { PlaneClient, WorkItem } from './plane.js';
import { log } from './log.js';

/** State groups that mean the work is over, whoever ended it. */
const FINISHED = new Set(['completed', 'cancelled']);

export interface Revocation {
  workItemId: string;
  projectId: string;
  holder: string;
  epoch: number;
  /** Said to the agent verbatim, so it must read as an instruction. */
  reason: string;
}

interface HeldRow {
  work_item_id: string;
  project_id: string;
  holder: string;
  epoch: number;
  plane_user_id: string | null;
}

/**
 * Compare every live lease against the board, and end the ones the board has
 * moved on from.
 *
 * One listing per project rather than one lookup per lease: a sweep runs every
 * thirty seconds against every held item, and per-item reads would make the cost
 * of holding work scale with how much of it there is.
 */
export async function reconcileLeases(
  plane: PlaneClient,
  pool: Pool,
): Promise<Revocation[]> {
  const { rows } = await pool.query<HeldRow>(
    `select l.work_item_id, l.project_id, l.holder, l.epoch, t.plane_user_id
       from lease l
       -- holder is 'agent:<name>'; agent_token.name is the bare name. Joining
       -- them directly matches nothing at all, and nothing at all is silent here:
       -- plane_user_id comes back null for every row, divergence() declines to
       -- judge, and the assignee half of revocation simply never fires. The test
       -- fixture hid it by naming its token 'agent:t'.
       left join agent_token t on l.holder = 'agent:' || t.name
      where l.state = 'held'
        and l.expires_at > now()
        -- Only leases Plane has been told about. A claim whose mirror has not
        -- landed yet would otherwise look exactly like one a human had undone.
        and l.mirrored = true`,
  );
  if (rows.length === 0) return [];

  const byProject = new Map<string, HeldRow[]>();
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  }

  const revocations: Revocation[] = [];

  for (const [projectId, leases] of byProject) {
    let items: WorkItem[];
    try {
      items = await plane.listWorkItems(projectId);
    } catch (err) {
      // Plane unreachable is not evidence of anything. Revoking on a failed read
      // would turn an outage into every agent losing its work at once.
      log.warn({ err, projectId }, 'reconcile skipped: could not read the board');
      continue;
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    const finishedStates = await finishedStateIds(plane, projectId);

    for (const lease of leases) {
      const item = byId.get(lease.work_item_id);
      // Absent from the listing is not proof of deletion — pagination, filters and
      // permissions all produce the same silence — so it is left alone. The TTL
      // remains the backstop for anything this cannot see.
      if (!item) continue;

      const reason = divergence(item, lease, finishedStates);
      if (!reason) continue;

      const revoked = await revokeLease(pool, lease.work_item_id, lease.epoch, reason);
      if (revoked) {
        log.warn(
          { workItemId: lease.work_item_id, holder: lease.holder, epoch: lease.epoch, reason },
          'lease revoked from the board',
        );
        revocations.push({
          workItemId: lease.work_item_id,
          projectId,
          holder: lease.holder,
          epoch: lease.epoch,
          reason,
        });
      }
    }
  }

  return revocations;
}

/** Why this lease should end, or null when the board and the lease agree. */
function divergence(
  item: WorkItem,
  lease: HeldRow,
  finishedStates: Set<string>,
): string | null {
  if (finishedStates.has(item.state)) {
    return 'This item was closed in Plane while you held it. Stop working it and do not submit results.';
  }

  // Unknown is not empty. Plane omitting the field from a listing must never read
  // as "nobody is assigned", which would revoke every lease on the board at once.
  if (item.assignees === undefined) return null;

  // An agent with no Plane identity of its own cannot be checked this way: there
  // is no id to look for, and every listing would look like a revocation.
  if (!lease.plane_user_id) return null;

  if (!item.assignees.includes(lease.plane_user_id)) {
    return 'This item was taken off you in Plane. Stop working it and do not submit results.';
  }

  return null;
}

/** The state ids that mean "over" in this project. Empty when Plane will not say. */
async function finishedStateIds(plane: PlaneClient, projectId: string): Promise<Set<string>> {
  try {
    const states = await plane.states(projectId);
    return new Set(states.filter((s) => FINISHED.has(s.group)).map((s) => s.id));
  } catch {
    // Without the state list, closure cannot be detected. Say nothing rather than
    // guessing: assignee divergence is still checked, and the TTL still applies.
    return new Set();
  }
}

/**
 * End one lease, guarded on the epoch it was read at.
 *
 * The guard matters because the listing above is a snapshot. Between reading it
 * and writing this the item may have been claimed again — by the same agent
 * retrying, or a different one — and revoking then would take the work away from
 * a holder the board was never consulted about.
 */
export async function revokeLease(
  pool: Pool,
  workItemId: string,
  epoch: number,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update lease
        set state        = 'revoked',
            ended_at     = now(),
            expires_at   = now(),
            end_reason   = $3,
            -- Plane is already correct: this ran because of what it says. Marking
            -- it unmirrored would queue a write to undo a change a human made on
            -- purpose.
            mirrored     = true
      where work_item_id = $1 and epoch = $2 and state = 'held'`,
    [workItemId, epoch, reason],
  );
  return (rowCount ?? 0) > 0;
}
