import {
  approvedTakeovers,
  assigneeReason,
  foreignAssignees,
  gatewayWrites,
  UNKNOWN_ASSIGNEE_REASON,
} from './assignment.js';
import { blockersOf } from './blockers.js';
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { resolve } from './query.js';
import { retractedIn } from './retraction.js';
import { viewOf, type WorkItemView } from './view.js';

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

/** @deprecated Candidates are `WorkItemView`s now; kept only as a type alias. */
export type Candidate = WorkItemView;

export interface NotReady {
  workItemId: string;
  readableId: string;
  reasons: string[];
}

/**
 * The cheap predicate — everything decidable from a single list call.
 *
 * Does NOT check `blocked_by`, which needs a request per item; see blockers.ts.
 * That split is a cost decision and nothing more. It is emphatically not a
 * definition of readiness, and reading it as one is what SYNC-65 was: the browse
 * path called this and reported the result as "what claim will accept", so items
 * with unfinished blockers were listed as ready and `board` counted them so.
 *
 * Nothing outside `resolve` should call this. `resolve` composes it with the
 * blocker pass and hands out only the total, which is the shape that keeps the
 * two halves from being mistaken for each other again.
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

  const blocking = labelsOf(item, labelNames).filter((n) => BLOCKING_LABELS.includes(n));
  if (blocking.length) reasons.push(`labelled ${blocking.join(', ')}`);

  return reasons;
}

/**
 * A work item's labels as lowercased names.
 *
 * Plane returns label **ids** on a work item, so an unresolved id falls back to
 * itself and simply matches nothing -- which is how both the blocking-label gate
 * and capability routing were silently inert while looking correct. Both callers
 * go through here so neither can regress to comparing names against uuids again.
 */
function labelsOf(item: WorkItem, labelNames: Map<string, string>): string[] {
  return item.labels.map((id) => (labelNames.get(id) ?? id).toLowerCase());
}

interface ReadyOpts {
  projectId: string;
  /** The caller's Plane user id; see `Predicate.viewer`. Required for the same reason. */
  viewer: string | null;
  capabilities?: string[];
  limit?: number;
  fields?: string[] | undefined;
}

/**
 * Ready, unleased candidates in claim order.
 *
 * A preset over `resolve`: predicate = ready, ordered, limited. It contains no
 * filtering of its own, deliberately — `next` and `find(ready:true)` returning
 * different sets was a real defect, and the only durable fix is that neither
 * decides what ready means.
 */
export async function readyCandidates(
  plane: PlaneClient,
  pool: Pool,
  opts: ReadyOpts,
): Promise<Candidate[]> {
  const { items, ctx } = await resolve(plane, pool, {
    projectId: opts.projectId,
    viewer: opts.viewer,
    ready: true,
    ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
    limit: opts.limit ?? 20,
    ...(opts.fields ? { fields: opts.fields } : {}),
  });
  return items.map((i) => viewOf(i, ctx));
}

export interface Explanation {
  /** The item itself, in the same shape every other read tool returns. */
  item: WorkItemView;
  claimable: boolean;
  reasons: string[];
}

/**
 * Why this item is not claimable.
 *
 * The gate already computes every reason and then discards all but the count, so
 * "`next` returned nothing" has been the top entry in both troubleshooting tables
 * with no way for an agent to answer it. This returns what the gate knows.
 *
 * Deliberately calls the same `screen` and `verifyClaimable` the gate calls rather
 * than restating the rules: an explanation that can disagree with the decision is
 * worse than none, because it sends someone off fixing the wrong thing.
 */
export async function explain(
  plane: PlaneClient,
  pool: Pool,
  opts: { projectId: string; workItemId: string; viewer: string | null; capabilities?: string[] },
): Promise<Explanation> {
  const { items, ctx, reasons } = await resolve(plane, pool, {
    projectId: opts.projectId,
    viewer: opts.viewer,
    workItemId: opts.workItemId,
    ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
  });

  const item = items[0];
  if (!item) {
    throw new GatewayError('NOT_FOUND', 'No such work item in this project', {
      workItemId: opts.workItemId,
    });
  }

  // Blockers included: the predicate resolved them for the one item this query
  // selected. It used to add `verifyClaimable` on top, which was correct and is
  // now double-counting — the reason this reads as a simplification is that the
  // gap it was compensating for is closed.
  const why = reasons(item);

  return { item: viewOf(item, ctx), claimable: why.length === 0, reasons: why };
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
 * The last word before an item is handed out.
 *
 * Deliberately re-reads rather than trusting a browse: `claim` may be minutes
 * behind whatever listing suggested the item, and this is the only check whose
 * being wrong costs an agent run. It is also unbudgeted — one item, so there is
 * nothing to ration — which is the one real difference between it and the pass
 * `resolve` runs. The rule they apply is the same function.
 */
export async function verifyClaimable(
  plane: PlaneClient,
  projectId: string,
  workItemId: string,
  // `pool` is required rather than optional on purpose. Retractions are part of
  // the gate, and an optional correctness input is a caller that can silently get
  // a different answer — which is exactly what SYNC-65 was.
  // `viewer` is required for the same reason `pool` is: the assignee rule is part
  // of the gate, and a caller that could omit it would get a different answer from
  // the browse path without either side saying so.
  opts: { checkChildren?: boolean; pool: Pool; viewer: string | null },
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

  const states = await plane.states(projectId);
  const groupOf = new Map(states.map((s) => [s.id, s.group]));

  // Note this reads Plane, which `complete` updates asynchronously — the lease is
  // the source of truth and Plane is a mirror, so a completion is never made to
  // wait on Plane being reachable. The cost is that a dependent item can stay
  // blocked for a second or so after its blocker finishes. That lag is in the
  // safe direction (briefly withholding work, never double-issuing it), so it is
  // left alone rather than papered over with a read of the lease table.
  // Retractions apply here exactly as they do on the browse path. Omitting them
  // would put claim back into disagreeing with find — the shape of SYNC-65, in a
  // new place, and this time refusing work the board says is ready.
  const retracted = await retractedIn(opts.pool, projectId);

  // Read from Plane rather than from the browse listing, for the same reason the
  // rest of this function does: an item can be assigned in the seconds between a
  // listing and a claim, and this is the check whose being wrong hands an agent
  // work a person is already doing. The single-item read carries `assignees`
  // whatever the list endpoint decides to do about `?fields=`.
  const [item, wrote, approved] = await Promise.all([
    plane.getWorkItem(projectId, workItemId),
    gatewayWrites(opts.pool, [workItemId]),
    approvedTakeovers(opts.pool, [workItemId]),
  ]);
  if (!approved.has(workItemId)) {
    const foreign = foreignAssignees(item, opts.viewer, wrote);
    if (foreign === null) reasons.push(UNKNOWN_ASSIGNEE_REASON);
    else if (foreign.length) reasons.push(assigneeReason(foreign, await plane.members()));
  }

  return [...reasons, ...(await blockersOf(plane, projectId, workItemId, groupOf, { retracted }))];
}
