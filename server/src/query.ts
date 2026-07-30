import type { Pool } from './db.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { countOpenChildren, screen } from './readiness.js';
import { viewContext, type ViewContext } from './view.js';

/**
 * The one query over work items: a predicate, resolved once.
 *
 * `next` is `find(ready, ordered by priority)`. `why` is a query for one item
 * that returns the predicate's reasons instead of discarding them. `tree` is a
 * query with a hierarchy projection. They were four implementations of that one
 * thing, and both defects found on 2026-07-30 came from the gap between them:
 * four disagreeing item shapes, and a `find(ready:true)` that ignored the token's
 * capabilities while its description promised the opposite.
 *
 * So readiness is computed **here and nowhere else**. Tools become presets that
 * choose a predicate and a projection; none of them filters.
 */

export type Priority = WorkItem['priority'];

export interface Predicate {
  projectId: string;
  /** Exactly this item. */
  workItemId?: string | undefined;
  /** Direct children of this item. */
  parentId?: string | undefined;
  labels?: string[] | undefined;
  priority?: Priority | undefined;
  stateGroup?: State['group'] | undefined;
  /** Restrict to members of a module; the caller resolves the ids. */
  moduleMembers?: Set<string> | null | undefined;
  /** An agent name, or 'any' / 'none'. */
  holder?: string | undefined;
  /** Keep only items with no reason to withhold them — what `claim` will accept. */
  ready?: boolean | undefined;
  /**
   * The token's capabilities.
   *
   * Applied as a *reason*, so it filters exactly when `ready` is asked for and
   * merely reports otherwise. Browsing should show work you cannot claim — you
   * may want to link it as a blocker — but "ready" must mean claimable by *you*,
   * or `next` and `find` disagree, which is precisely the bug this replaces.
   */
  capabilities?: string[] | undefined;
  limit?: number | undefined;
  fields?: string[] | undefined;
}

export interface Resolved {
  /** Every item in the project. Structure — parent links, child counts — needs it. */
  all: WorkItem[];
  /** Items matching the predicate, in claim order. */
  items: WorkItem[];
  /** Matches before `limit`, so a truncated answer is visibly truncated. */
  matched: number;
  ctx: ViewContext;
  groupOf: Map<string, State['group']>;
  /**
   * Every reason this item is not claimable right now. Empty means claimable.
   * The single definition of readiness — `ready` filters on it, `why` prints it.
   */
  reasons: (item: WorkItem) => string[];
}

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export async function resolve(
  plane: PlaneClient,
  pool: Pool,
  p: Predicate,
): Promise<Resolved> {
  const [all, states, ctx] = await Promise.all([
    plane.listWorkItems(p.projectId),
    plane.states(p.projectId),
    viewContext(plane, pool, p.projectId, p.fields),
  ]);

  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const openChildren = countOpenChildren(all, groupOf);
  const wanted = (p.capabilities ?? []).map((c) => c.toLowerCase());

  const reasons = (item: WorkItem): string[] => {
    const out = screen(item, groupOf.get(item.state), ctx.labelNames, openChildren.get(item.id) ?? 0);

    // A live lease is not a defect in the item, which is why the gate keeps it
    // separate — but to anyone asking why they cannot have it, it is the answer.
    const held = ctx.leases.get(item.id);
    if (held) out.push(`held by ${held.holder} until ${held.expiresAt}`);

    if (wanted.length) {
      const names = item.labels.map((id) => (ctx.labelNames.get(id) ?? id).toLowerCase());
      if (!wanted.some((w) => names.includes(w))) {
        // Stated plainly: the item is fine, it is simply not yours. Without this a
        // capability-scoped agent sees an empty queue and no cause.
        out.push(
          `does not match your capabilities (${wanted.join(', ')}) — its labels are ` +
            (names.length ? names.join(', ') : 'none'),
        );
      }
    }
    return out;
  };

  const labels = (p.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);

  const matches = all.filter((i) => {
    if (p.workItemId && i.id !== p.workItemId) return false;
    if (p.parentId && i.parent !== p.parentId) return false;
    if (p.priority && i.priority !== p.priority) return false;
    if (p.stateGroup && groupOf.get(i.state) !== p.stateGroup) return false;
    if (p.moduleMembers && !p.moduleMembers.has(i.id)) return false;

    if (labels.length) {
      // Every named label must be present: narrowing is the point, and "any of"
      // would make a second label widen the result rather than narrow it.
      const has = i.labels.map((id) => (ctx.labelNames.get(id) ?? id).toLowerCase());
      if (!labels.every((w) => has.includes(w))) return false;
    }

    if (p.holder) {
      const held = ctx.leases.get(i.id)?.holder;
      if (p.holder === 'none' && held) return false;
      if (p.holder === 'any' && !held) return false;
      if (p.holder !== 'none' && p.holder !== 'any' && held !== p.holder) return false;
    }

    if (p.ready && reasons(i).length) return false;
    return true;
  });

  // Claim order, always. `next` and `find` differing on it would be one more way
  // for two views of the same question to disagree.
  matches.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.created_at.localeCompare(b.created_at),
  );

  return {
    all,
    items: p.limit ? matches.slice(0, p.limit) : matches,
    matched: matches.length,
    ctx,
    groupOf,
    reasons,
  };
}
