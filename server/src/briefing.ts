import type { PlaneClient, RelatedRef } from './plane.js';
import { plainText } from './textsearch.js';
import { readableId } from './view.js';

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
 * we get here, so it would double the cost of every claim. Fetching
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

export interface BriefingOpts {
  projectId: string;
  workItemId: string;
  /**
   * Retracted edges on this item, as `blocker|relation` keys — see retraction.ts.
   *
   * A loader rather than a value so the lookup happens INSIDE this function, and
   * therefore inside `briefingFor`'s catch. The alternative — resolving it at the
   * call site — puts a database read between acquiring a lease and returning it,
   * where a failure strands the agent holding a lease it was never told about.
   * That is SYNC-67 again, one layer up.
   *
   * Called only when there is something to filter, so a project that has never
   * retracted anything pays nothing per claim.
   */
  retracted?: (() => Promise<Set<string>>) | undefined;
}

export async function briefing(plane: PlaneClient, opts: BriefingOpts): Promise<Briefing> {
  const identifier = plane.identifierFor(opts.projectId);
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

  // Plane cannot delete a relation, so a wrong edge is retracted rather than
  // removed — and a briefing is the one place a non-blocking one is ever read. A
  // bogus `relates_to` gates nothing, but a briefing lists open related items
  // first and with their text, so it puts noise in front of every future claimer
  // that reads as a requirement they should honour (PLANE-15).
  //
  // Loaded only when there is something to filter.
  const hasRefs = KINDS.some((k) => (rel?.[k] ?? []).length > 0);
  const retracted = hasRefs && opts.retracted ? await opts.retracted() : new Set<string>();

  // Flattened with its kind attached, so one pass fetches each linked item once
  // even when two relation types name it.
  const refs: Array<{ ref: RelatedRef; relation: string }> = [];
  const seen = new Set<string>();
  for (const kind of KINDS) {
    for (const ref of rel?.[kind] ?? []) {
      // Before the dedupe, not after. Retraction is per (target, kind), so a pair
      // whose `blocked_by` was retracted but which is also `relates_to` must still
      // be briefed on — as `relates_to`. Filtering after the dedupe would drop the
      // pair on the strength of an edge nobody is honouring.
      if (retracted.has(`${ref.issue_id}|${kind}`)) continue;
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
          readableId: readableId(linked.sequence_id, identifier),
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
    readableId: readableId(item.sequence_id, identifier),
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
/**
 * The briefing, or an explicit statement that it could not be built.
 *
 * The catch is right and stays: a claim must never fail because the briefing
 * could not be assembled. The lease is the thing the agent asked for and it is
 * already held, so losing the context is a degraded answer where losing the
 * lease would be a broken one.
 *
 * Discarding the reason was the defect (SYNC-67). `.catch(() => null)` made a
 * briefing that threw indistinguishable from a gateway too old to have the
 * feature, and that ambiguity cost a real diagnosis: observed twice in one
 * session on 2026-08-03, against the same project and the same token, one claim
 * came back with a full briefing and one with nothing — and the absence was read
 * as evidence that production was running a stale build, which it was not.
 *
 * It matters past the wrong diagnosis. The whole point of the briefing is that
 * an agent should not have to remember to go and ask for context after claiming.
 * An agent that silently gets none does not know it is missing anything, and
 * neither does anyone reading the transcript later — so the failure is invisible
 * in exactly the situation it was built for.
 *
 * Returned as a spreadable pair rather than a bare value so both keys reach the
 * caller together and neither can be forgotten at a call site.
 */
export async function briefingFor(
  plane: PlaneClient,
  opts: BriefingOpts,
  /** Somewhere to put the real error, since the agent only gets a summary. */
  log?: (err: unknown) => void,
): Promise<{ briefing: Briefing | null; briefingError?: string }> {
  try {
    return { briefing: await briefing(plane, opts) };
  } catch (err) {
    log?.(err);
    return {
      briefing: null,
      // Short, and never the stack. The agent's decision here is binary — do I
      // have context or not — and the detail belongs in the gateway's log where
      // whoever can act on it is looking.
      briefingError:
        `could not be built: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }
}
