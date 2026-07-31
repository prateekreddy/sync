import type { PlaneClient, RelatedRef } from './plane.js';
import { plainText } from './textsearch.js';

/**
 * Everything an agent needs to start work on an item, handed over with the lease.
 *
 * `claim` used to return `{ lease }` and nothing else: permission to work, and
 * none of the context written down about how the work must be done. That gap is
 * what makes "write it down first" fail quietly at the far end. A finding can be
 * noticed, captured, correctly placed and still never reach the one agent whose
 * behaviour it needed to change — every layer looking right on its own.
 *
 * The case this was built from: BRIDGEETHB-63 records that a protective rate
 * limit must bind on `_credit`, not `_debit`, and that the LayerZero API naming
 * actively invites the wrong reading. It is a requirement on two implementation
 * items. Without a briefing, an agent claims one of them, writes the natural and
 * wrong version, completes honestly, and the finding sits open beside a contract
 * that is already wrong. Re-parenting does not fix that — a sibling is exactly as
 * unreachable as an orphan. Delivery is a separate problem from placement, and
 * this is the delivery half.
 *
 * Deliberately built from targeted reads rather than a project listing. The
 * obvious implementation reuses `listWorkItems`, which is not cached and pages
 * the whole project — and `verifyClaimable` has already paged it once by the time
 * we get here, so it would double the cost of every claim in the fleet. Fetching
 * the item, its relations and the handful of items they name is a few small
 * requests that do not grow with the size of the board.
 */

export interface RelatedBrief {
  workItemId: string;
  readableId: string;
  title: string;
  /** State *name*, never the uuid. */
  state: string;
  /** Whether it is finished — an open constraint is live, a closed one is history. */
  done: boolean;
  relation: string;
  /**
   * The full text, present only for items that are NOT done.
   *
   * An open related item may be a live requirement on the work just claimed, and
   * a title alone does not carry a requirement — "Apply the protective rate limit
   * to _credit, not _debit" is unusually self-describing, and most are not. A
   * finished one is history: its title and state are enough to know it happened,
   * and its detail is one `get_issue` away if anyone wants it.
   *
   * This is what bounds the response. The count of open related items is small in
   * practice, and when it is not, that is itself worth seeing.
   */
  description?: string | undefined;
}

export interface Briefing {
  workItemId: string;
  readableId: string;
  title: string;
  priority: string;
  state: string;
  labels: string[];
  /** The acceptance criteria, as plain text — the gate refuses to lease an item without one. */
  description: string;
  parent?: { workItemId: string; title: string } | undefined;
  /**
   * Items linked to this one, open ones first.
   *
   * Ordered rather than grouped by kind because the question an agent has is
   * "what could change what I am about to do", and the answer is the open ones
   * whatever their relation type. Plane's vocabulary flattens most of our edges
   * to `relates_to` anyway (see SYNC-44), so grouping by kind would present a
   * distinction the data does not actually carry.
   */
  related: RelatedBrief[];
}

/** Relation kinds worth briefing on. Scheduling edges say nothing about how to do the work. */
const KINDS = ['blocked_by', 'blocking', 'duplicate', 'relates_to'] as const;

export async function briefing(
  plane: PlaneClient,
  opts: { projectId: string; workItemId: string },
): Promise<Briefing> {
  const [item, rel, states, labelNames] = await Promise.all([
    plane.getWorkItem(opts.projectId, opts.workItemId),
    plane.relations(opts.projectId, opts.workItemId).catch(() => null),
    plane.states(opts.projectId),
    plane.labelNames(opts.projectId),
  ]);

  const stateNames = new Map(states.map((s) => [s.id, s.name]));
  const stateGroups = new Map(states.map((s) => [s.id, s.group]));
  const closed = (s: string) => {
    const g = stateGroups.get(s);
    return g === 'completed' || g === 'cancelled';
  };

  // Flattened with its kind attached, so one pass fetches each linked item once
  // even when two relation types name it.
  const refs: Array<{ ref: RelatedRef; relation: string }> = [];
  const seen = new Set<string>();
  for (const kind of KINDS) {
    for (const ref of rel?.[kind] ?? []) {
      if (seen.has(ref.issue_id)) continue;
      seen.add(ref.issue_id);
      refs.push({ ref, relation: kind });
    }
  }

  const related = (
    await Promise.all(
      refs.map(async ({ ref, relation }): Promise<RelatedBrief | null> => {
        // A relation that cannot be read must not fail the claim: the lease is
        // already held by this point, and refusing to hand it over because one
        // linked item was unreachable would strand the agent holding it.
        const linked = await plane
          .getWorkItem(ref.project_id ?? opts.projectId, ref.issue_id)
          .catch(() => null);
        if (!linked) return null;
        const isDone = closed(linked.state);
        return {
          workItemId: linked.id,
          readableId: `#${linked.sequence_id}`,
          title: linked.name,
          state: stateNames.get(linked.state) ?? 'unknown',
          done: isDone,
          relation,
          ...(isDone ? {} : { description: plainText(linked.description_html) }),
        };
      }),
    )
  ).filter((r): r is RelatedBrief => r !== null);

  // Open first: those are the ones that can still change what the agent does.
  related.sort((a, b) => Number(a.done) - Number(b.done));

  const parent = item.parent
    ? await plane.getWorkItem(opts.projectId, item.parent).catch(() => null)
    : null;

  return {
    workItemId: item.id,
    readableId: `#${item.sequence_id}`,
    title: item.name,
    priority: item.priority,
    state: stateNames.get(item.state) ?? 'unknown',
    labels: item.labels.map((id) => labelNames.get(id) ?? id),
    description: plainText(item.description_html),
    ...(parent ? { parent: { workItemId: parent.id, title: parent.name } } : {}),
    related,
  };
}

/** Build a work item's briefing, or nothing at all if it cannot be built. */
export async function briefingOrNull(
  plane: PlaneClient,
  opts: { projectId: string; workItemId: string },
): Promise<Briefing | null> {
  // A claim must never fail because the briefing could not be assembled. The
  // lease is the thing the agent asked for and it is already held; losing the
  // context is a degraded answer, losing the lease is a broken one.
  return briefing(plane, opts).catch(() => null);
}
