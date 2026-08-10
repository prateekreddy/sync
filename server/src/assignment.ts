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
 * Rule 4 is the hard one. `mirrorClaim` sets an assignee on every claim and clears
 * it on release, so most names in Plane were put there by us; if the gate could not
 * tell its own writes from a human's, either it withholds work nobody is doing
 * (every item any agent ever claimed) or it honours nothing.
 *
 * That used to be answered by an `assignment_write` table — a row per write we
 * made, deleted after the clear succeeded. It was a second copy of something the
 * lease already knows, kept in step by hand: the delete had to happen after the
 * Plane write and not before, and if the process died between them the copy was
 * wrong in the direction that freezes an item forever.
 *
 * The lease answers it directly, because a person never takes one:
 *
 *   - a lease that is `held` — the assignee is ours by construction, we set it on
 *     the claim
 *   - a lease that is not mirrored, or has a write still queued — we owe Plane a
 *     clear that has not landed, so the name on the item is residue rather than
 *     intent
 *
 * Anything else is a person's. Note the second case only became expressible when
 * the mirror got a real outbox: before that "we owe Plane a write" was not
 * recorded anywhere, which is why a separate table was needed to stand in for it.
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
import { readableId } from './view.js';

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
  return (
    `assigned to ${namesOf(foreign, members)} — not yours to take. Ask the person you are ` +
    `working with; if they agree, claim again and the gateway will put the question to them`
  );
}

/** Display names for a set of Plane users, falling back to the raw id. */
export const namesOf = (ids: string[], members: Member[]): string => {
  const byId = new Map(members.map((m) => [m.id, m.name]));
  return ids.map((u) => byId.get(u) ?? u).join(', ');
};

/**
 * Whether this claim is blocked *only* by somebody's name being on the item, and
 * who that is.
 *
 * Split out from the gate's reason strings because the answer has to be acted on
 * rather than read: it is what turns a refusal into a question for a human, and
 * matching on prose to find that out would break the first time the wording
 * improved.
 *
 * Returns null when the item is free, already approved, assigned to the caller,
 * or unreadable — anything that is not a clear "a person owns this". Asking a
 * human to approve a takeover that was never needed trains them to click yes.
 */
export async function approvalNeeded(
  plane: PlaneClient,
  pool: Pool,
  opts: { projectId: string; workItemId: string; viewer: string | null },
): Promise<{ assignees: string[]; names: string; readableId: string } | null> {
  const [item, wrote, approved] = await Promise.all([
    plane.getWorkItem(opts.projectId, opts.workItemId).catch(() => null),
    gatewayWrites(pool, [opts.workItemId]),
    approvedTakeovers(pool, [opts.workItemId]),
  ]);
  if (!item || approved.has(opts.workItemId)) return null;

  const foreign = foreignAssignees(item, opts.viewer, wrote);
  if (!foreign?.length) return null;

  return {
    assignees: foreign,
    names: namesOf(foreign, await plane.members()),
    // Formatted here because this is the layer holding the item. The question
    // this ends up in is read by a person, and going back for the number would
    // put a request on the path of asking one — the mistake that cost 85 seconds
    // on one test file when the readable id was threaded through the read tools.
    readableId: readableId(item.sequence_id, plane.identifierFor(opts.projectId)),
  };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only the ids Postgres will accept as uuids.
 *
 * `lease` keys on `uuid`, so an id that is not one cannot have a row by
 * definition — dropping it and dropping the row it could never have matched are
 * the same answer. Without this, one odd id makes the query throw and takes the
 * gate down for the whole project, which is a much worse failure than the one it
 * would be reporting.
 */
const uuidsOnly = (ids: string[]): string[] => ids.filter((id) => UUID.test(id));

/**
 * The assignees in Plane that this gateway put there, for a set of items or for
 * every lease it has.
 *
 * Read off the lease rather than a table of its own — see the rule 4 note at the
 * top. The three disjuncts are the whole definition of "ours":
 *
 *   held            — we set the assignee on the claim and have not cleared it
 *   not mirrored    — Plane has not been told about this lease's ending yet
 *   pending_mirror  — the clear is queued and the drain has not landed it
 *
 * `holder` is `agent:<name>` and `agent_token.name` is the bare name, so the join
 * has to add the prefix back. Matching them directly silently matches nothing,
 * which is how the assignee half of revocation was dead on arrival.
 */
export async function gatewayWrites(pool: Pool, workItemIds?: string[]): Promise<GatewayWrites> {
  const ids = workItemIds ? uuidsOnly(workItemIds) : undefined;
  if (ids && ids.length === 0) return new Map();

  const { rows } = await pool.query<{ work_item_id: string; plane_user_id: string }>(
    `select l.work_item_id, t.plane_user_id
       from lease l
       join agent_token t on l.holder = 'agent:' || t.name
      where t.plane_user_id is not null
        and (l.state = 'held' or l.mirrored = false or l.pending_mirror is not null)
        ${ids ? 'and l.work_item_id = any($1::uuid[])' : ''}`,
    ids ? [ids] : [],
  );
  return new Map(rows.map((r) => [r.work_item_id, r.plane_user_id]));
}

export interface Takeover {
  workItemId: string;
  approvedBy: string;
  takenFrom?: string | null;
  reason?: string;
}

/**
 * How long a person's yes keeps meaning yes.
 *
 * It used to mean it forever. An approval recorded once made that item
 * permanently takeable by anyone, with no way to withdraw it — a decision
 * somebody made in one moment still applying long after they had stopped meaning
 * it, which is the same shape as handing back work they had just taken.
 *
 * Not consumed on first use, deliberately: the approval is recorded before the
 * claim is retried precisely so a compaction between the yes and the claim does
 * not lose it, and one-shot semantics would put that failure straight back. A
 * day is far longer than that gap and far shorter than forever.
 *
 * Written once and used by both readers below, because two queries that decide
 * the same thing are two queries that will disagree.
 */
const APPROVAL_TTL = "interval '24 hours'";
const STILL_VALID = `created_at > now() - ${APPROVAL_TTL}`;

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

/**
 * The recorded approval for one item, if there is one.
 *
 * `takenFrom` is why this is read on the claim path rather than only checked:
 * claiming overwrites the assignee, so the one fact the whole exchange was about
 * — whose work this was — is gone the moment the claim lands unless it was
 * captured when the human answered.
 */
export async function takeoverApproval(
  pool: Pool,
  workItemId: string,
): Promise<{ approvedBy: string; takenFrom: string | null } | null> {
  if (uuidsOnly([workItemId]).length === 0) return null;
  const { rows } = await pool.query<{ approved_by: string; taken_from: string | null }>(
    `select approved_by, taken_from from takeover_approval
      where work_item_id = $1 and ${STILL_VALID}`,
    [workItemId],
  );
  const row = rows[0];
  return row ? { approvedBy: row.approved_by, takenFrom: row.taken_from } : null;
}

/** Items in this set that a human has already cleared for takeover. */
export async function approvedTakeovers(pool: Pool, workItemIds: string[]): Promise<Set<string>> {
  const ids = uuidsOnly(workItemIds);
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ work_item_id: string }>(
    `select work_item_id from takeover_approval
      where work_item_id = any($1::uuid[]) and ${STILL_VALID}`,
    [ids],
  );
  return new Set(rows.map((r) => r.work_item_id));
}
