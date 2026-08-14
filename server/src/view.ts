import type { Pool } from './db.js';
import type { PlaneClient, WorkItem } from './plane.js';
import { liveHolders } from './lease.js';

/**
 * The one agent-facing representation of a work item.
 *
 * Every read tool used to build its own. That is not merely untidy — it diverged.
 * `next` returned `labels` as Plane uuids while `find` returned label *names*,
 * same field name and different content, in two tools an agent uses
 * interchangeably. An agent matching those uuids against capability names got
 * nothing, which is the exact failure fixed at the gate in 3f7a891, reintroduced
 * one layer up because each shape was hand-built. `tree` also said `expiresAt`
 * where `why` said `heldBy.expiresAt`, so anything reading both needed both.
 *
 * Resolving ids to names in one place means that class of bug cannot recur by
 * omission: there is nowhere else for it to happen.
 *
 * Three deliberate choices:
 *
 * - **Names, not ids.** `state` and `labels` are what a human wrote. An agent
 *   cannot act on a uuid, and every tool that returned one forced a second call.
 * - **No `projectId` per row.** Every one of these tools is project-scoped and
 *   the caller supplied it or it came from the token. It belongs on the envelope,
 *   once, not repeated on every item.
 * - **Lease state is part of the item.** Only the gateway knows it, and "open"
 *   without "and nobody is on it" is the misleading half of the truth.
 */
export interface WorkItemView {
  workItemId: string;
  readableId: string;
  title: string;
  priority: WorkItem['priority'];
  /** State *name*, e.g. "In Progress" — never the uuid. */
  state: string;
  /** Label *names* — never uuids. */
  labels: string[];
  parentId?: string;
  /** Present only while a live lease exists. */
  holder?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface Lease {
  holder: string;
  expiresAt: string;
  /**
   * Which window took it, or null for a client that reports none.
   *
   * Carried because `holder` is the same string for every session a person has
   * open, so a fleet view listing two rows as `agent:dev2/worker-1` gave no way
   * to tell whether that was one agent holding two items or two agents holding
   * one each — and no way for either to recognise its own (PLANE-5).
   */
  sessionId: string | null;
}

/** Everything needed to turn work items into views, fetched once per request. */
export interface ViewContext {
  stateNames: Map<string, string>;
  labelNames: Map<string, string>;
  leases: Map<string, Lease>;
  /** The project's identifier — the `SYNC` in `SYNC-42`. Absent if unreadable. */
  identifier?: string | undefined;
  /** When set, views carry exactly these keys. */
  fields?: Set<string> | undefined;
}

/**
 * Build the context for one request.
 *
 * States and labels are client-cached, so in the common case this is one query
 * against the lease table and nothing else.
 */
export async function viewContext(
  plane: PlaneClient,
  pool: Pool,
  projectId: string,
  fields?: string[] | undefined,
): Promise<ViewContext> {
  const [states, labelNames, leaseRows] = await Promise.all([
    plane.states(projectId),
    plane.labelNames(projectId),
    // From the shared definition of "live", not a second copy of the predicate.
    liveHolders(pool),
  ]);

  // Read from cache only, never fetched. The access check in front of every
  // project-scoped read has already listed the caller's projects, which fills
  // this in; when it has not, the readable id falls back to `#42` rather than
  // making the display path wait on a request.
  const identifier = plane.identifierFor(projectId);

  return {
    stateNames: new Map(states.map((s) => [s.id, s.name])),
    labelNames,
    ...(identifier ? { identifier } : {}),
    leases: new Map(
      [...leaseRows].map(([id, l]) => [
        id,
        { holder: l.holder, expiresAt: l.expiresAt.toISOString(), sessionId: l.sessionId },
      ]),
    ),
    ...(fields?.length ? { fields: new Set(fields) } : {}),
  };
}

/**
 * The id a person uses — `SYNC-42`, exactly as Plane's own UI writes it.
 *
 * One function because the codebase had two spellings of this and no rule about
 * which to use: `find` and `capture`'s dedup branch answered `SYNC-42` while
 * `board`, `tree`, `next` and `capture`'s create branch answered `#42`. An agent
 * quoting one of them to a human quoted a number that means nothing outside the
 * project, and an agent comparing two of them compared different things.
 *
 * `#42` survives only as the fallback for when the project's identifier could not
 * be read. It is worse — ambiguous across projects — but it is still a number a
 * human can find, which beats printing nothing.
 */
export const readableId = (sequenceId: number, identifier?: string | undefined): string =>
  identifier ? `${identifier}-${sequenceId}` : `#${sequenceId}`;

/** One work item, as an agent should see it. */
export function viewOf(item: WorkItem, ctx: ViewContext): WorkItemView {
  const held = ctx.leases.get(item.id);
  const full: WorkItemView = {
    workItemId: item.id,
    readableId: readableId(item.sequence_id, ctx.identifier),
    title: item.name,
    priority: item.priority,
    state: ctx.stateNames.get(item.state) ?? 'unknown',
    // The single place label ids become names. Anything else resolving them
    // itself is a divergence waiting to happen.
    labels: item.labels.map((id) => ctx.labelNames.get(id) ?? id),
    ...(item.parent ? { parentId: item.parent } : {}),
    ...(held ? { holder: held.holder, expiresAt: held.expiresAt } : {}),
    updatedAt: item.updated_at,
  };

  if (!ctx.fields) return full;

  // `workItemId` always survives: a row you cannot address is not a result, and
  // an agent that omitted it by accident would get an unusable answer rather
  // than an error.
  const out: Record<string, unknown> = { workItemId: full.workItemId };
  for (const [k, v] of Object.entries(full)) {
    if (ctx.fields.has(k)) out[k] = v;
  }
  return out as unknown as WorkItemView;
}

/** Parse the `fields` query parameter shared by every read tool. */
export const parseFields = (raw: string | undefined): string[] | undefined =>
  raw
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
