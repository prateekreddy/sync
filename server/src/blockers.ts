import type { PlaneClient, Relations, State, WorkItem } from './plane.js';

/**
 * The blocker half of the readiness gate.
 *
 * An item with an unfinished `blocked_by` is not workable no matter how well it
 * is written. That rule was implemented twice — once at claim time, correctly,
 * and not at all on the browse path — so `find(ready:true)` listed items that
 * `claim` then refused, and `board` reported a dependency gate looser than the
 * one being enforced. Nothing errored: the browse path simply computed a subset
 * of the rule and returned it under the name of the whole (SYNC-65).
 *
 * The cause was structural rather than an oversight. `screen()` is what a single
 * list call can decide, `blocked_by` needs a request per item, and the two were
 * different kinds of thing joined by a convention that whoever needed the strict
 * answer would remember to ask for the second half. Three callers remembered;
 * two did not, and the two that did not were the ones humans read.
 *
 * So the rule lives here once, and both paths call it. What differs between them
 * is only the budget: `claim` judges one item and must be exact, while a browse
 * judges many and is capped — reporting what it did not reach rather than
 * quietly counting it ready.
 */

/** Groups that mean a blocker no longer blocks. */
const DONE = new Set<State['group']>(['completed', 'cancelled']);

/**
 * How many items one browse will look up relations for.
 *
 * Only items that already passed the cheap screen are ever counted against it —
 * an item withheld for some other reason needs no blocker lookup to stay
 * withheld — so this is a ceiling on the *ready* set, not on the backlog. Boards
 * with more than this much simultaneously-ready work exist, and for those the
 * result says how many went unchecked instead of implying it looked at all of
 * them.
 */
export const BROWSE_BUDGET = 100;

/** Plane's rate limit is shared by every agent, so these do not go out at once. */
const CONCURRENCY = 6;

async function pooled<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Which of an item's blockers are still open, given its relations.
 *
 * Split out from any fetching so the rule itself is testable without a Plane,
 * and so the claim path and the browse path cannot drift: they differ in what
 * they fetch and agree on what it means.
 *
 * `known` is the project's item list when the caller already has one. Plane's
 * relations payload carries ids but no state, so each blocker's state has to
 * come from somewhere; taking it from a listing already in hand turns what used
 * to be a fetch per blocker into none at all for the ordinary case, where a
 * blocker lives in the same project as the thing it blocks.
 */
export interface BlockerContext {
  /**
   * The project's item list, when the caller already has one. Plane's relations
   * payload carries ids but no state, so a blocker's state has to come from
   * somewhere; taking it from a listing in hand turns what used to be a fetch per
   * blocker into none at all for the ordinary case, where a blocker lives in the
   * same project as the thing it blocks.
   */
  known?: Map<string, WorkItem> | undefined;
  /**
   * `item|blocker` keys the gate has been told to disregard — see retraction.ts.
   * Plane cannot delete a relation, so a dependency that turns out not to be real
   * is retracted here rather than removed there.
   */
  retracted?: Set<string> | undefined;
}

export async function openBlockers(
  plane: PlaneClient,
  projectId: string,
  workItemId: string,
  rel: Relations,
  groupOf: Map<string, State['group']>,
  ctx: BlockerContext = {},
): Promise<string[]> {
  const known = ctx.known ?? new Map<string, WorkItem>();
  // Not `rel.blocked_by.length`. Plane is not obliged to send a bucket it has
  // nothing to put in, and an absent one used to be unreachable — this ran only
  // for items someone had already linked. Now it runs across a whole board, so
  // the first project with no relations at all would have thrown on every browse.
  const all = Array.isArray(rel?.blocked_by) ? rel.blocked_by : [];

  // Retractions are applied before anything is fetched, so a disregarded edge
  // costs no request either.
  const edges = ctx.retracted?.size
    ? all.filter((b) => !ctx.retracted!.has(`${workItemId}|${b.issue_id}`))
    : all;
  if (edges.length === 0) return [];

  const blockers = await Promise.all(
    edges.map(async (b) => {
      const hit = known.get(b.issue_id);
      const item = hit ?? (await plane.getWorkItem(b.project_id ?? projectId, b.issue_id).catch(() => null));
      // Paired with the edge, not just collected: an unreadable blocker has no
      // item to name itself with, and its id is the only handle left.
      return { id: b.issue_id, item };
    }),
  );

  // A blocker we cannot read counts as open. Withholding work that might be
  // blocked costs a pause; dispatching an agent at work that cannot succeed
  // costs a run and produces something a human then has to review.
  // An unrecognised state group counts as open for the same reason an unreadable
  // blocker does — the two failures are the same one seen from either end.
  const open = blockers.filter(({ item }) => {
    if (!item) return true;
    const g = groupOf.get(item.state);
    return g === undefined || !DONE.has(g);
  });
  if (open.length === 0) return [];

  // The unreadable case names the id, because that is the only thing an agent can
  // do anything with. A blocker that was deleted out from under its relation
  // gates the item forever — Plane cannot delete a relation, so the edge survives
  // its own target — and the repair is `unlink`, which takes exactly this id.
  // Saying "an unreadable item" and stopping described the trap without handing
  // over the one value needed to get out of it, so the only way out was a human
  // in Plane's web UI. Observed on SLATE-2, which froze a four-item chain.
  const named = open.map(({ id, item }) =>
    item ? `#${item.sequence_id}` : `an unreadable item (${id})`,
  );
  const stale = open.some(({ item }) => !item);
  return [
    `blocked by ${named.join(', ')}` +
      (stale ? ' — if it no longer exists, unlink that id to stop the gate honouring it' : ''),
  ];
}

/**
 * Blocker reasons for one item, fetching its relations. The exact, unbudgeted
 * answer — what `claim` needs, for the single item it is about to hand out.
 */
export async function blockersOf(
  plane: PlaneClient,
  projectId: string,
  workItemId: string,
  groupOf: Map<string, State['group']>,
  ctx: BlockerContext = {},
): Promise<string[]> {
  const rel = await plane.relations(projectId, workItemId);
  return openBlockers(plane, projectId, workItemId, rel, groupOf, ctx);
}

export interface BlockerPass {
  /** Blocker reasons by work item id. Absent means "nothing found or not checked". */
  reasons: Map<string, string[]>;
  /** How many items had their relations fetched. */
  checked: number;
  /**
   * Items that needed a lookup and did not get one, because the budget ran out.
   * Reported rather than absorbed: a caller that cannot tell a clean pass from a
   * truncated one will read the truncated one as clean, which is the failure
   * this whole module exists to remove.
   */
  unchecked: number;
}

/**
 * Resolve blockers for a set of candidates, against a budget.
 *
 * Candidates should be only those an answer actually depends on — items that
 * already passed the cheap screen. Everything else is withheld regardless, so
 * paying a request to learn it is also blocked buys nothing.
 */
export async function blockerPass(
  plane: PlaneClient,
  projectId: string,
  candidates: WorkItem[],
  groupOf: Map<string, State['group']>,
  ctx: BlockerContext,
  budget = BROWSE_BUDGET,
): Promise<BlockerPass> {
  const within = candidates.slice(0, budget);
  const reasons = new Map<string, string[]>();

  const found = await pooled(within, CONCURRENCY, async (item) => {
    // A project-wide read must not fail because one item's relations are
    // unreadable. Treated as "nothing known to block it", which matches what the
    // browse path did before this existed and leaves claim to be the strict one.
    const rel = await plane.relations(projectId, item.id).catch(() => null);
    if (!rel) return [item.id, [] as string[]] as const;
    return [item.id, await openBlockers(plane, projectId, item.id, rel, groupOf, ctx)] as const;
  });

  for (const [id, why] of found) if (why.length) reasons.set(id, why);

  return { reasons, checked: within.length, unchecked: candidates.length - within.length };
}
