import type { Pool } from './db.js';
import type { PlaneClient, State, WorkItem } from './plane.js';

/**
 * Readiness gate.
 *
 * Storing tasks is easy; the product problem is "is this specified well enough
 * that an agent will succeed?". An agent that claims an underspecified item burns
 * tokens and produces plausible garbage that a human then has to review -- which
 * is worse than the item sitting untouched. So readiness is a gate, not a hint:
 * items that fail it are visible to humans and invisible to `claim`.
 */

/** Labels that mean "a human has to look at this first". */
export const BLOCKING_LABELS = ['needs-human', 'needs-refinement', 'blocked', 'wontfix'];

const PRIORITY_RANK: Record<WorkItem['priority'], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export interface Candidate {
  workItemId: string;
  projectId: string;
  readableId: string;
  title: string;
  priority: WorkItem['priority'];
  labels: string[];
  updatedAt: string;
}

export interface NotReady {
  workItemId: string;
  readableId: string;
  reasons: string[];
}

/**
 * The cheap predicate — everything decidable from a single list call.
 *
 * Deliberately does NOT check `blocked_by` relations: that needs one API call per
 * item, which would make browsing cost O(backlog) against a shared rate limit.
 * Blockers are verified at claim time instead, where correctness actually matters.
 * See verifyClaimable().
 */
export function screen(
  item: WorkItem,
  stateGroup: string | undefined,
  labelNames: Map<string, string>,
  openChildren = 0,
): string[] {
  const reasons: string[] = [];

  if (item.is_draft) reasons.push('is a draft');

  // A parent with unfinished children is not a unit of work, it is a container:
  // the work itself lives in the children, and whoever holds them is already
  // doing it. Handing the parent to a second agent produces duplicated effort
  // that no lease can detect, because the two agents hold different items.
  if (openChildren > 0) {
    reasons.push(
      `has ${openChildren} unfinished sub-item${openChildren === 1 ? '' : 's'} — claim those instead`,
    );
  }
  if (stateGroup !== 'backlog' && stateGroup !== 'unstarted') {
    reasons.push(`state group is "${stateGroup}", not backlog/unstarted`);
  }

  const body = (item.description_html ?? '').replace(/<[^>]*>/g, '').trim();
  if (body.length === 0) {
    reasons.push('no description — an agent cannot infer the acceptance criteria');
  }

  const names = item.labels.map((id) => labelNames.get(id) ?? id).map((n) => n.toLowerCase());
  const blocking = names.filter((n) => BLOCKING_LABELS.includes(n));
  if (blocking.length) reasons.push(`labelled ${blocking.join(', ')}`);

  return reasons;
}

interface ReadyOpts {
  projectId: string;
  capabilities?: string[];
  limit?: number;
}

/**
 * Ready, unleased candidates in claim order.
 *
 * Live leases are filtered out here as an optimisation only — `claim` is atomic
 * regardless, so a stale read costs a wasted attempt, never a double-claim.
 */
export async function readyCandidates(
  plane: PlaneClient,
  pool: Pool,
  opts: ReadyOpts,
): Promise<Candidate[]> {
  const [items, states, leased] = await Promise.all([
    plane.listWorkItems(opts.projectId),
    plane.states(opts.projectId),
    pool
      .query<{ work_item_id: string }>(
        `select work_item_id from lease where state = 'held' and expires_at > now()`,
      )
      .then((r) => new Set(r.rows.map((x) => x.work_item_id))),
  ]);

  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const labelNames = new Map<string, string>(); // resolved lazily; ids are fine for matching

  // Children come free — every item in the list already carries its parent — so
  // the sub-item check costs no extra API calls on the browse path.
  const openChildren = countOpenChildren(items, groupOf);

  const wanted = (opts.capabilities ?? []).map((c) => c.toLowerCase());

  return items
    .filter((i) => !leased.has(i.id))
    .filter(
      (i) => screen(i, groupOf.get(i.state), labelNames, openChildren.get(i.id) ?? 0).length === 0,
    )
    .filter((i) => {
      if (!wanted.length) return true;
      const names = i.labels.map((l) => l.toLowerCase());
      return wanted.some((w) => names.includes(w));
    })
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.created_at.localeCompare(b.created_at),
    )
    .slice(0, opts.limit ?? 20)
    .map((i) => ({
      workItemId: i.id,
      projectId: opts.projectId,
      readableId: `#${i.sequence_id}`,
      title: i.name,
      priority: i.priority,
      labels: i.labels,
      updatedAt: i.updated_at,
    }));
}

/** Unfinished sub-items, keyed by parent. Derived from a list already in hand. */
export function countOpenChildren(
  items: WorkItem[],
  groupOf: Map<string, State['group']>,
): Map<string, number> {
  const open = new Map<string, number>();
  for (const i of items) {
    if (!i.parent) continue;
    const g = groupOf.get(i.state);
    if (g === 'completed' || g === 'cancelled') continue;
    open.set(i.parent, (open.get(i.parent) ?? 0) + 1);
  }
  return open;
}

/**
 * The expensive half of the gate, run only for the item actually being claimed.
 *
 * An item with an unfinished `blocked_by` is not workable no matter how well it
 * is written, and handing it to an agent guarantees wasted tokens.
 */
export async function verifyClaimable(
  plane: PlaneClient,
  projectId: string,
  workItemId: string,
  opts: { checkChildren?: boolean } = {},
): Promise<string[]> {
  const reasons: string[] = [];

  // Only needed when claiming a specific item by id. On the pick path the
  // candidates have already been screened against the full item list, and
  // re-listing once per candidate would turn one call into O(candidates).
  if (opts.checkChildren) {
    const [items, states] = await Promise.all([
      plane.listWorkItems(projectId),
      plane.states(projectId),
    ]);
    const n =
      countOpenChildren(items, new Map(states.map((s) => [s.id, s.group]))).get(workItemId) ?? 0;
    if (n > 0) {
      reasons.push(`has ${n} unfinished sub-item${n === 1 ? '' : 's'} — claim those instead`);
    }
  }

  const [rel, states] = await Promise.all([
    plane.relations(projectId, workItemId),
    plane.states(projectId),
  ]);
  if (rel.blocked_by.length === 0) return reasons;

  const groupOf = new Map(states.map((s) => [s.id, s.group]));

  // Plane's relations payload carries ids only — no state — so each blocker has
  // to be fetched to find out whether it is finished. Skipping this and treating
  // every relation as open would strand an item permanently the moment anyone
  // linked a blocker, even after that blocker was completed.
  const blockers = await Promise.all(
    rel.blocked_by.map((b) =>
      plane
        .getWorkItem(b.project_id ?? projectId, b.issue_id)
        .catch(() => null),
    ),
  );

  // Note this reads Plane, which `complete` updates asynchronously — the lease is
  // the source of truth and Plane is a mirror, so a completion is never made to
  // wait on Plane being reachable. The cost is that a dependent item can stay
  // blocked for a second or so after its blocker finishes. That lag is in the
  // safe direction (briefly withholding work, never double-issuing it), so it is
  // left alone rather than papered over with a read of the lease table.
  const open = blockers.filter((b) => {
    // A blocker we cannot read is treated as open: refusing work that might be
    // blocked is cheaper than dispatching an agent at work that cannot succeed.
    if (!b) return true;
    const g = groupOf.get(b.state);
    return g !== 'completed' && g !== 'cancelled';
  });

  if (open.length === 0) return reasons;

  const names = open.map((b) => (b ? `#${b.sequence_id}` : 'an unreadable item')).join(', ');
  return [...reasons, `blocked by ${names}`];
}
