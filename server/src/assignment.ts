/**
 * Work with someone else's name on it.
 *
 * The lease says who is working an item right now. Plane's `assignees` says who a
 * human meant to do it. Until now the gate enforced only the first, so an item a
 * person had assigned was listed as ready, counted ready by `board`, offered by
 * `next`, and handed over by `claim` — the tracker's own record of intent had no
 * effect on the tool built to respect it.
 *
 * The rule, decided with the project owner on 2026-08-04 (SYNC-70):
 *
 *   1. nobody assigned            -> free
 *   2. assigned to the caller     -> free; a name on an item is a work order
 *   3. assigned to anyone else    -> withhold, and ask a human, per item
 *   4. assigned by us, lease over -> residue from a failed mirror write, not
 *                                    intent; free
 *
 * Who *created* an item never withholds it. Assignment is the only gate.
 *
 * Rule 4 is why `assignment_write` exists. `mirrorClaim` sets an assignee on every
 * claim and clears it on release, so most names in Plane were put there by us; if
 * the gate could not tell its own writes from a human's, either it withholds work
 * nobody is doing (every item any agent ever claimed) or it honours nothing. The
 * table records the writes we make, and anything unrecorded is a person's intent.
 *
 * The sharp edge, and it is deliberate: an agent minted from a personal token
 * authenticates AS that human — measured, `get_user` through such a token returns
 * the owner's account. So for that agent rule 2 swallows rule 3: an item its owner
 * assigns to themselves reads as a work order, not as "hands off". The owner was
 * shown this and chose it. Do not quietly reverse it; see SYNC-70.
 */
import type { Actor } from './auth.js';
import type { Pool } from './db.js';
import type { Member, PlaneClient, WorkItem } from './plane.js';

/** Work item id -> the Plane user this gateway assigned it to. */
export type GatewayWrites = Map<string, string>;

/** How many single-item reads a browse may spend resolving assignees. */
export const ASSIGNEE_BUDGET = 60;
const CONCURRENCY = 6;

/**
 * The assignees that withhold this item: neither the caller's own, nor ours.
 *
 * `null` means the item does not carry the field, which is *not* the same as
 * having no assignees — treating unknown as empty is how a gate fails open on
 * exactly the items it exists to withhold. Callers resolve it or say they could
 * not; see `assigneePass`.
 */
export function foreignAssignees(
  item: Pick<WorkItem, 'id' | 'assignees'>,
  viewer: string | null | undefined,
  wrote: GatewayWrites,
): string[] | null {
  if (item.assignees === undefined) return null;
  const ours = wrote.get(item.id);
  return item.assignees.filter((u) => u !== viewer && u !== ours);
}

/**
 * Whether an item needs a look-up before the rule can be applied to it.
 *
 * Only `ready` queries ask: browsing shows work you cannot claim on purpose, and
 * paying a request per row to annotate a listing nobody is claiming from would be
 * the cost of the old `board` for none of the benefit.
 */
export function needsAssignees(item: Pick<WorkItem, 'assignees'>): boolean {
  return item.assignees === undefined;
}

/**
 * Fill in assignees for items whose listing did not carry them.
 *
 * `PlaneClient.LIST_FIELDS` asks Plane for `assignees`, so in the normal case this
 * does nothing at all. It exists because that request is unverified against a live
 * Plane: if the list endpoint ignores the field the way its own docs leave open,
 * every row arrives without it, and the browse path would silently disagree with
 * `claim` about what is claimable. That disagreement is SYNC-65 exactly, and it
 * cost a day. So the fallback is bounded, measured, and reported rather than
 * assumed away.
 *
 * Returns what it managed to resolve plus how many it could not afford, so a
 * caller can say "ready is an upper bound" instead of implying it checked.
 */
export async function assigneePass(
  plane: PlaneClient,
  projectId: string,
  items: WorkItem[],
  budget = ASSIGNEE_BUDGET,
): Promise<{ resolved: Map<string, string[]>; unchecked: number }> {
  const missing = items.filter(needsAssignees);
  const affordable = missing.slice(0, budget);
  const resolved = new Map<string, string[]>();

  for (let i = 0; i < affordable.length; i += CONCURRENCY) {
    const slice = affordable.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (item) => {
        try {
          const full = await plane.getWorkItem(projectId, item.id);
          resolved.set(item.id, full.assignees ?? []);
        } catch {
          // Left unresolved rather than assumed empty. An item we could not read
          // is counted as unchecked, which the caller reports; guessing "nobody
          // is assigned" would hand over exactly the work this protects.
        }
      }),
    );
  }

  return { resolved, unchecked: missing.length - resolved.size };
}

/** The reason string the gate reports, with names rather than uuids where we have them. */
export function assigneeReason(foreign: string[], members: Member[]): string {
  const byId = new Map(members.map((m) => [m.id, m.name]));
  const who = foreign.map((u) => byId.get(u) ?? u).join(', ');
  return (
    `assigned to ${who} — not yours to take. Ask the human you are working with, ` +
    `and claim with takeover: true once they agree`
  );
}

/** A Plane user as a person would recognise them, falling back to the raw id. */
export function nameOf(members: Member[], id: string | null | undefined): string {
  if (!id) return 'nobody';
  return members.find((m) => m.id === id)?.name ?? id;
}

/**
 * The Plane user of the human an agent acts for, if the workspace has one.
 *
 * Used on an approved takeover, where the item moves to the person who authorised
 * it rather than to the machine executing it — their decision, their name on it.
 *
 * Returns null when the principal is not an email, or names nobody in this
 * workspace. Callers fall back to the holder rather than failing: an unresolvable
 * principal is a reason to record the takeover differently, not to refuse work a
 * human has already approved.
 */
export function principalPlaneUser(actor: Actor, members: Member[]): string | null {
  if (!actor.principal.startsWith('human:')) return null;
  const email = actor.principal.slice('human:'.length).trim().toLowerCase();
  if (!email.includes('@')) return null;
  return members.find((m) => m.email.trim().toLowerCase() === email)?.id ?? null;
}

/** The reason string when the field could not be resolved at all. */
export const UNKNOWN_ASSIGNEE_REASON =
  'could not read who this is assigned to, so it is withheld rather than guessed';

// ── persistence ────────────────────────────────────────────────────────────

/** Record that we set this item's assignee, so a later read knows it was not a human. */
export async function recordAssignment(
  pool: Pool,
  workItemId: string,
  planeUserId: string,
  epoch: number,
): Promise<void> {
  await pool.query(
    `insert into assignment_write (work_item_id, plane_user_id, epoch)
     values ($1, $2, $3)
     on conflict (work_item_id) do update
       set plane_user_id = excluded.plane_user_id,
           epoch         = excluded.epoch,
           written_at    = now()`,
    [workItemId, planeUserId, epoch],
  );
}

/**
 * Forget our write, because we have just cleared the assignee in Plane.
 *
 * Deliberately called *after* the Plane write succeeds. Dropping the row first
 * would turn a failed clear into a name we no longer recognise as ours — which is
 * the residue case, reported as a human assignment, freezing the item.
 */
export async function forgetAssignment(pool: Pool, workItemId: string): Promise<void> {
  await pool.query('delete from assignment_write where work_item_id = $1', [workItemId]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only the ids Postgres will accept as uuids.
 *
 * Both tables key on `uuid`, so an id that is not one cannot have a row by
 * definition — dropping it and dropping the row it could never have matched are
 * the same answer. Without this, one odd id makes the query throw and takes the
 * gate down for the whole project, which is a much worse failure than the one it
 * would be reporting.
 */
const uuidsOnly = (ids: string[]): string[] => ids.filter((id) => UUID.test(id));

/** Our own assignment writes, for a set of items or for everything we have recorded. */
export async function gatewayWrites(pool: Pool, workItemIds?: string[]): Promise<GatewayWrites> {
  const ids = workItemIds ? uuidsOnly(workItemIds) : undefined;
  if (ids && ids.length === 0) return new Map();
  const { rows } = ids
    ? await pool.query<{ work_item_id: string; plane_user_id: string }>(
        'select work_item_id, plane_user_id from assignment_write where work_item_id = any($1::uuid[])',
        [ids],
      )
    : await pool.query<{ work_item_id: string; plane_user_id: string }>(
        'select work_item_id, plane_user_id from assignment_write',
      );
  return new Map(rows.map((r) => [r.work_item_id, r.plane_user_id]));
}

export interface Takeover {
  workItemId: string;
  approvedBy: string;
  takenFrom?: string | null;
  reason?: string;
}

/** Record a human's permission to take one item from its assignee. */
export async function approveTakeover(pool: Pool, t: Takeover): Promise<void> {
  await pool.query(
    `insert into takeover_approval (work_item_id, approved_by, taken_from, reason)
     values ($1, $2, $3, $4)
     on conflict (work_item_id) do update
       set approved_by = excluded.approved_by,
           taken_from  = excluded.taken_from,
           reason      = excluded.reason,
           created_at  = now()`,
    [t.workItemId, t.approvedBy, t.takenFrom ?? null, t.reason ?? ''],
  );
}

/** Items in this set that a human has already cleared for takeover. */
export async function approvedTakeovers(pool: Pool, workItemIds: string[]): Promise<Set<string>> {
  const ids = uuidsOnly(workItemIds);
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ work_item_id: string }>(
    'select work_item_id from takeover_approval where work_item_id = any($1::uuid[])',
    [ids],
  );
  return new Set(rows.map((r) => r.work_item_id));
}
