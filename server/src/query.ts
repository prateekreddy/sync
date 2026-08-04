import {
  approvedTakeovers,
  assigneePass,
  assigneeReason,
  foreignAssignees,
  gatewayWrites,
  needsAssignees,
  UNKNOWN_ASSIGNEE_REASON,
} from './assignment.js';
import { blockerPass, BROWSE_BUDGET } from './blockers.js';
import { retractedIn } from './retraction.js';
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
  /**
   * The caller's Plane user id, or null if their token carries no Plane identity.
   *
   * Required rather than optional, and required even where readiness is not being
   * asked for, because the assignee rule needs it to tell "assigned to you" from
   * "assigned to someone else" — and a caller that omitted it would get a stricter
   * gate than `claim` applies, silently. An optional correctness input is a caller
   * that can quietly get a different answer, which is what SYNC-65 was.
   */
  viewer: string | null;
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
  /**
   * Look up `blocked_by` for the items that survive the cheap screen.
   *
   * On by default, because off by default is what SYNC-65 was: every caller that
   * forgot to ask got a looser gate than `claim` enforces and no sign of it. Turn
   * it off only where readiness is not being reported at all, and say why.
   */
  blockers?: boolean | undefined;
  /** Relation lookups this query may spend. See BROWSE_BUDGET. */
  blockerBudget?: number | undefined;
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
   *
   * Includes unfinished `blocked_by`, which is why this is worth having rather
   * than each caller composing its own: the blocker lookups are already done and
   * memoised into the answer by the time `resolve` returns, so reading them stays
   * synchronous and no caller can get the cheap half by accident.
   */
  reasons: (item: WorkItem) => string[];
  /**
   * Screen-passing items whose blockers were not looked up, because the budget
   * ran out. Zero for every ordinary board. Non-zero means `ready` is an upper
   * bound rather than an answer, and whoever displays it should say so.
   */
  blockersUnchecked: number;
}

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * The assignee half of the gate, for the items whose answer turns on it.
 *
 * Kept out of `screen` on purpose. `screen` is "everything one list call can
 * decide", and this needs the gateway's own record of which assignees it wrote —
 * without that, a name Plane shows is unreadable: `mirrorClaim` puts one on every
 * claim, so treating any name as a human's would withhold every item an agent has
 * ever touched. See assignment.ts for the rule and SYNC-70 for why it is that one.
 */
async function assigneePassFor(
  plane: PlaneClient,
  pool: Pool,
  p: Predicate,
  candidates: WorkItem[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (candidates.length === 0) return out;

  const ids = candidates.map((i) => i.id);
  const [wrote, approved] = await Promise.all([
    gatewayWrites(pool, ids),
    approvedTakeovers(pool, ids),
  ]);

  // Normally does nothing: LIST_FIELDS asks Plane for assignees. It earns its
  // keep only if Plane stops honouring that, which would otherwise turn this gate
  // off silently rather than loudly.
  const filled = candidates.some(needsAssignees)
    ? await assigneePass(plane, p.projectId, candidates)
    : { resolved: new Map<string, string[]>(), unchecked: 0 };

  const foreignBy = new Map<string, string[]>();
  for (const item of candidates) {
    // A recorded approval is a human's answer to this exact question about this
    // exact item, so it settles it. The reassignment happens inside `claim`.
    if (approved.has(item.id)) continue;

    const resolved = filled.resolved.get(item.id);
    const foreign = foreignAssignees(
      resolved ? { id: item.id, assignees: resolved } : item,
      p.viewer,
      wrote,
    );
    if (foreign === null) out.set(item.id, [UNKNOWN_ASSIGNEE_REASON]);
    else if (foreign.length) foreignBy.set(item.id, foreign);
  }

  // Fetched only when there is a name to print. Resolving member names on every
  // board read to render nothing would be a per-read Plane call for no answer.
  if (foreignBy.size) {
    const members = await plane.members();
    for (const [id, foreign] of foreignBy) out.set(id, [assigneeReason(foreign, members)]);
  }
  return out;
}

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

  // The cheap half: everything one list call can decide. Never returned to a
  // caller on its own — `reasons` below is what anyone gets — so there is no
  // shape of this function that reads like a readiness answer.
  const screened = (item: WorkItem): string[] => {
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

  // Split from `ready` deliberately. Everything here is decidable from data
  // already in hand, so it runs first and narrows what the blocker pass has to
  // pay for — a query for one item costs one relation lookup, not the project's.
  const selects = (i: WorkItem): boolean => {
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

    return true;
  };

  const selected = all.filter(selects);

  // Pay for blockers only where the answer turns on them: an item the screen
  // already withholds stays withheld whatever its relations say, and a finished
  // one is nobody's candidate. On a healthy board this is the ready set, which is
  // the same set `claim` would have verified one at a time anyway.
  const candidates = selected.filter((i) => {
    const g = groupOf.get(i.state);
    return g !== 'completed' && g !== 'cancelled' && screened(i).length === 0;
  });

  // Same reasoning as the blocker pass, one layer earlier: an item the screen
  // already withholds stays withheld whatever its assignees say. See SYNC-70 for
  // the rule itself; this is only where it is paid for.
  const assigneeReasons = await assigneePassFor(plane, pool, p, candidates);

  const needsBlockers = p.blockers === false ? [] : candidates;

  const byId = new Map(all.map((i) => [i.id, i]));
  const pass = needsBlockers.length
    ? await blockerPass(
        plane,
        p.projectId,
        needsBlockers,
        groupOf,
        // One query for the project's retractions, not one per item — this sits
        // in the path of every find, next and board.
        { known: byId, retracted: await retractedIn(pool, p.projectId) },
        p.blockerBudget ?? BROWSE_BUDGET,
      )
    : { reasons: new Map<string, string[]>(), checked: 0, unchecked: 0 };

  const reasons = (item: WorkItem): string[] => [
    ...screened(item),
    ...(assigneeReasons.get(item.id) ?? []),
    ...(pass.reasons.get(item.id) ?? []),
  ];

  const matches = p.ready ? selected.filter((i) => reasons(i).length === 0) : selected;

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
    blockersUnchecked: pass.unchecked,
  };
}
