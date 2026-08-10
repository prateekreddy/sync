/**
 * Does Plane still agree with the lease table?
 *
 * The gateway is authoritative for who holds what and Plane is a mirror, and
 * nothing ever checked that the mirror still reflects the source. Drift was
 * therefore permanent and silent, and the way it got found was a human noticing
 * something odd — which is how the 2026-08-04 collision surfaced.
 *
 * SYNC-72 retries writes that FAILED. This is the broader case, and the classes
 * it covers are ones no retry can reach, because nothing was ever owed:
 *
 *   - a person edits state or assignees in Plane's UI
 *   - two gateway replicas race their mirror writes and the loser sticks
 *   - a write landed and was later overwritten by something else
 *   - an item is deleted or moved while a lease still points at it
 *
 * ### Why this cannot be "make Plane match the table"
 *
 * Because for one of these classes Plane is right and the table is not. A person
 * putting their name on an item an agent holds is the SYNC-71 revoke signal —
 * the supported way to take work back — and overwriting it would undo a human's
 * decision silently, using machinery built to protect them. So reconciliation
 * has to know which side is authoritative for each field, and it repairs only
 * what is unambiguous.
 *
 * The test for "did we write this name" is the same one `assignment.ts` uses and
 * for the same reason: the lease already knows. A `held` lease means the
 * assignee is ours by construction, because we set it on the claim and a person
 * never takes a lease.
 *
 * ### Nothing is repaired while something is owed
 *
 * A lease with a queued write, or one not yet marked mirrored, is the outbox's
 * business. Repairing it here would race the drain and double the Plane writes.
 * Drift is only drift once the gateway believes it has finished writing.
 */
import type { Pool } from './db.js';
import { log } from './log.js';
import { mirrorReclaim, mirrorReturn } from './mirror.js';
import type { PlaneClient, WorkItem } from './plane.js';

/**
 * The four ways the two sides disagree, kept distinct because the right response
 * differs for each — and two of them must never be "fix it".
 */
export type DriftKind =
  /** Lease is live; Plane does not show it claimed. Our write was lost. Repairable. */
  | 'claimLost'
  /** Lease ended; Plane still carries the name we put there. Repairable. */
  | 'staleAssignee'
  /** Someone else's name on an item we hold. A person intervened. Report only. */
  | 'humanIntervened'
  /** Plane shows work in progress that no lease covers. Report only. */
  | 'untracked';

export interface Drift {
  kind: DriftKind;
  workItemId: string;
  detail: string;
}

/**
 * The one class this pass will act on. Everything else is reported and left.
 *
 * `claimLost` was here until it was driven end to end on 2026-08-10, and the
 * run showed it cannot be repaired safely. The reason is not a bug in the rule,
 * it is that the rule asks a question the gateway cannot answer.
 *
 * Observed: a held item was edited in Plane to Backlog with no assignee — what a
 * person does when taking work back. `revoke.ts` saw it and ended the lease with
 * "This item was taken off you in Plane", correctly, within 32 seconds. `board`
 * reported `claimLost: 1` for the same item in the same window, and the repair
 * for that class re-assigns the item and puts it back to In Progress.
 *
 * The same observation, two opposite conclusions. Revoke won only because the
 * sweep runs every 30s and this every 15 minutes, which is a race and not a
 * design. And there is a case revoke never sees at all: a human who leaves the
 * assignee alone and only moves the item OUT of In Progress. `divergence()`
 * returns null there; `claimLost` fires on the state alone and would put it
 * back, every fifteen minutes, forever.
 *
 * So the gateway cannot tell "our write was lost" from "a human undid it" —
 * exactly the ambiguity SYNC-75 named for assignees, which revoke.ts already
 * resolves in the safe direction. Where the two overlap revoke is right; where
 * they do not, repairing is wrong. Reporting it stays useful; acting on it does
 * not.
 *
 * `staleAssignee` survives because it is safe on its own terms: the lease has
 * ENDED and Plane still shows the item in progress under our name. No human
 * action produces that, and nothing else will ever clean it up.
 */
export const REPAIRABLE: ReadonlySet<DriftKind> = new Set<DriftKind>(['staleAssignee']);

/**
 * More repairs than this in one project and the pass does nothing at all.
 *
 * Not a rate limit — a plausibility check, and it exists because of a specific
 * near-miss. On the first live pass a missing state condition matched 65
 * finished items, and the repair for that class returns an item to the pool:
 * unstarted, unassigned, with a comment. It was caught by a human reading the
 * output before the timer fired, which is luck rather than design.
 *
 * The reasoning generalises past that bug. A classification rule is a predicate
 * over a whole board, so being wrong about it is never wrong about one item — it
 * is wrong about every item of that shape at once, unattended, every fifteen
 * minutes. Real drift is a handful: a lost write, a raced replica. Sixty five is
 * a diagnosis, not a workload.
 *
 * So a large repair set is treated as evidence against the rule rather than
 * against the board. The pass refuses, says so at error, and `board` reports it,
 * because a genuine backlog of drift is worth a person deciding to clear rather
 * than a timer clearing it at 3am.
 */
export const REPAIR_CEILING = 10;

export interface Reconciliation {
  projectId: string;
  /** Leases examined. */
  checked: number;
  drift: Drift[];
  counts: Record<DriftKind, number>;
  /** How many repairs were queued. Zero when `repair` was not asked for. */
  repaired: number;
  /**
   * Set when repairs were refused because there were implausibly many. The
   * drift is still reported in full — this stops the writing, not the looking.
   */
  refused?: number;
}

const EMPTY: Record<DriftKind, number> = {
  claimLost: 0,
  staleAssignee: 0,
  humanIntervened: 0,
  untracked: 0,
};

interface LeaseRow {
  work_item_id: string;
  state: string;
  holder: string;
  live: boolean;
  owed: boolean;
  plane_user_id: string | null;
}

/**
 * Compare, without touching anything.
 *
 * Split out from the pass that repairs so the comparison can be tested on its
 * own and read by anything that already holds both sides — `board` does, and a
 * count nobody sees is the failure this file exists to end.
 */
export function classify(
  items: Pick<WorkItem, 'id' | 'assignees' | 'state'>[],
  leases: LeaseRow[],
  groupOf: (stateId: string) => string | undefined,
): Drift[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const leased = new Set(leases.map((l) => l.work_item_id));
  const out: Drift[] = [];

  for (const l of leases) {
    // Owed writes belong to the drain. See the note above: repairing here would
    // race it, and reporting it would be reporting the outbox doing its job.
    if (l.owed) continue;

    const item = byId.get(l.work_item_id);
    if (!item) {
      // Deleted or moved out of the project under a live lease. Not repairable
      // by definition — there is nothing left to write to.
      if (l.live) {
        out.push({
          kind: 'untracked',
          workItemId: l.work_item_id,
          detail: `held by ${l.holder}, but no such item is in this project any more`,
        });
      }
      continue;
    }

    // `undefined` is not `[]`. A listing that omits the field tells us nothing,
    // and treating unknown as empty is how a check fires on every item at once.
    const assignees = item.assignees;
    const group = groupOf(item.state);

    if (l.live) {
      if (assignees === undefined) continue;
      const foreign = assignees.filter((a) => a !== l.plane_user_id);
      if (foreign.length) {
        // The one case where Plane is right and we are not.
        out.push({
          kind: 'humanIntervened',
          workItemId: l.work_item_id,
          detail: `held by ${l.holder}, but assigned in Plane to someone else — a person took this back`,
        });
        continue;
      }
      const ours = l.plane_user_id ? assignees.includes(l.plane_user_id) : false;
      if (!ours || group !== 'started') {
        out.push({
          kind: 'claimLost',
          workItemId: l.work_item_id,
          detail: `held by ${l.holder}, but Plane shows it ${ours ? 'not in progress' : 'unassigned'}`,
        });
      }
      continue;
    }

    // The lease is over and the item is STILL SHOWING AS IN PROGRESS.
    //
    // The state condition is the whole rule, and leaving it out was very nearly
    // expensive. Measured on the first live pass, 2026-08-10: without it this
    // reported 65 items, every one of them finished. A completed item keeps a
    // name on it because that is the record of who did it, and `mirrorComplete`
    // sets the done state in the same write — so "ended lease, name still there"
    // describes the normal end of every piece of work ever done here.
    //
    // The repair made it worse than a noisy count. `mirrorReturn` sets the item
    // back to an unstarted state and clears the assignee, so the pass would have
    // reopened 65 finished items and commented "Returned to the pool" on each.
    // That is the reconciliation destroying the board it exists to protect.
    //
    // With the condition, the class means what the item that asked for it said:
    // the lease is over and Plane never heard, so the item sits In Progress
    // forever with a name on it and no one working it. Returning that to the
    // pool is exactly right.
    if (
      group === 'started' &&
      assignees?.length &&
      l.plane_user_id &&
      assignees.includes(l.plane_user_id)
    ) {
      out.push({
        kind: 'staleAssignee',
        workItemId: l.work_item_id,
        detail: `lease ended (${l.state}) but Plane still shows it in progress and assigned`,
      });
    }
  }

  // Work in progress the gateway knows nothing about. Pre-gateway items and
  // hand-edited ones both land here, which is why it is reported and never
  // touched: there is no lease to be authoritative with.
  for (const i of items) {
    if (leased.has(i.id)) continue;
    if (groupOf(i.state) !== 'started') continue;
    if (!i.assignees?.length) continue;
    out.push({
      kind: 'untracked',
      workItemId: i.id,
      detail: 'in progress and assigned in Plane, with no lease behind it',
    });
  }

  return out;
}

/** Every lease this project has ever granted, with what the mirror owes. */
export async function leasesOf(pool: Pool, projectId: string): Promise<LeaseRow[]> {
  const { rows } = await pool.query<LeaseRow>(
    `select l.work_item_id,
            l.state,
            l.holder,
            (l.state = 'held' and l.expires_at > now())               as live,
            (l.mirrored = false or l.pending_mirror is not null)      as owed,
            t.plane_user_id
       from lease l
       left join agent_token t on l.holder = 'agent:' || t.name
      where l.project_id = $1`,
    [projectId],
  );
  return rows;
}

/**
 * One project: compare, and put back what is unambiguously ours to put back.
 *
 * Repairs go through the outbox rather than writing to Plane inline, so they
 * inherit the retry, the backoff and the give-up bound that already exist —
 * and so a reconciliation pass that dies halfway leaves its intent recorded
 * rather than half-applied.
 */
export async function reconcile(
  plane: PlaneClient,
  pool: Pool,
  opts: { projectId: string; repair?: boolean; ceiling?: number },
): Promise<Reconciliation> {
  const [items, states, leases] = await Promise.all([
    plane.listWorkItems(opts.projectId),
    plane.states(opts.projectId),
    leasesOf(pool, opts.projectId),
  ]);

  const groups = new Map(states.map((s) => [s.id, s.group]));
  const drift = classify(items, leases, (id) => groups.get(id));

  const counts = { ...EMPTY };
  for (const d of drift) counts[d.kind] += 1;

  const wanted = drift.filter((d) => REPAIRABLE.has(d.kind));

  // Refused before anything is attempted, not part-way through. A pass that
  // repaired nine and then stopped would leave the board in a state neither the
  // rule nor a human chose.
  if (opts.repair && wanted.length > (opts.ceiling ?? REPAIR_CEILING)) {
    log.error(
      { projectId: opts.projectId, wouldRepair: wanted.length, ceiling: opts.ceiling ?? REPAIR_CEILING, ...counts },
      'refusing to reconcile: this many repairs at once is more likely a broken rule than a broken board',
    );
    return { projectId: opts.projectId, checked: leases.length, drift, counts, repaired: 0, refused: wanted.length };
  }

  let repaired = 0;
  if (opts.repair) {
    const byId = new Map(leases.map((l) => [l.work_item_id, l]));
    for (const d of wanted) {
      const l = byId.get(d.workItemId);
      if (!l) continue;
      try {
        if (d.kind === 'claimLost') {
          await mirrorReclaim(plane, pool, {
            projectId: opts.projectId,
            workItemId: d.workItemId,
            holder: l.holder,
            planeUserId: l.plane_user_id,
          });
          repaired += 1;
        } else if (d.kind === 'staleAssignee') {
          await mirrorReturn(plane, pool, {
            projectId: opts.projectId,
            workItemId: d.workItemId,
            reason: 'the lease had ended but Plane still showed it assigned',
            holder: l.holder,
          });
          repaired += 1;
        }
        // No else: `wanted` already excludes humanIntervened and untracked, and
        // the exclusion lives in REPAIRABLE where it can be read in one place.
      } catch (err) {
        log.warn({ err, workItemId: d.workItemId, kind: d.kind }, 'reconciliation repair failed');
      }
    }
  }

  return { projectId: opts.projectId, checked: leases.length, drift, counts, repaired };
}

/** Every project, one at a time, one bad project never stopping the rest. */
export async function reconcileAll(
  plane: PlaneClient,
  pool: Pool,
  opts: { repair?: boolean; ceiling?: number } = {},
): Promise<Reconciliation[]> {
  const projects = await plane.listProjects();
  const out: Reconciliation[] = [];
  for (const p of projects) {
    try {
      out.push(await reconcile(plane, pool, { projectId: p.id, ...opts }));
    } catch (err) {
      log.warn({ err, projectId: p.id }, 'reconciliation failed for a project');
    }
  }
  return out;
}
