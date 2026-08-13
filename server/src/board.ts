import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { resolve } from './query.js';
import { readableId } from './view.js';
import { classify, leasesOf, REPAIRABLE, REPAIR_CEILING, type DriftKind } from './reconcile.js';

/**
 * Where a project stands: progress per module, and what other agents are holding.
 *
 * Plane reports its own per-module counts, and they are not the interesting ones.
 * Plane can say how many items are done; it cannot say how many are **ready** —
 * that needs the readiness gate and the lease table, both of which live here. The
 * question an agent actually has when choosing work is "what is left that I could
 * pick up", and the question a human has is "is this feature nearly finished".
 * Neither is answerable from Plane alone.
 *
 * Buckets are exhaustive and disjoint, deliberately: done + held + ready +
 * blocked = total, so the numbers add up and nothing hides in an overlap. An
 * item in progress that nobody holds — a human working it, or a lagging mirror —
 * lands in `blocked`, because the gate will not offer it.
 */

export interface Progress {
  total: number;
  /** Finished or cancelled. */
  done: number;
  /** Someone holds a live lease. */
  held: number;
  /** `claim` would accept it right now. The number Plane cannot produce. */
  ready: number;
  /** Everything else: no description, drafts, blockers, unfinished children, flags. */
  blocked: number;
}

export interface ModuleProgress extends Progress {
  moduleId: string;
  name: string;
}

/**
 * How much shape the board has.
 *
 * Progress answers "how much is left"; this answers "does any of it hang
 * together". They are different questions and a board that reports only the
 * first looks healthy while being an inbox — which is exactly what happened here:
 * 35 items, zero parents, 25 in no module, discovered only because a human asked
 * directly. A number nobody can see is a number nobody fixes.
 *
 * Deliberately computed from placement alone — parent, children, module — and
 * not from relations. A `relates_to` edge is provenance, not placement: it says
 * where an item came from, not what rolls it up. It would also cost one Plane
 * request per item, since relations live behind their own endpoint, and this must
 * add no calls to a board that is already several.
 */
export interface Structure {
  items: number;
  /** In a module. The epic layer, one level deep — Plane's modules do not nest. */
  filed: number;
  /** Has a parent. */
  parented: number;
  /** Has at least one child, so it is a container rather than a task. */
  containers: number;
  /** Neither filed, nor parented, nor a container. Nothing rolls these up. */
  unplaced: number;
  /** The actionable half of `unplaced`: placing finished work changes nothing. */
  unplacedOpen: number;
  /**
   * Open leaf items with no parent — filed in a module or not.
   *
   * Distinct from `unplaced`, and the distinction is the point. `unplaced`
   * requires an item to be in no module AND have no parent, so a board where
   * every item was filed in a module and none had a parent reported
   * `unplaced: 0` and read as fully structured. Filed and placed are two
   * different properties, and conflating them made the metric say "fine" while
   * the thing it measured decayed.
   *
   * Measured on a real project the day this was added: 63 items, `unplaced: 0`,
   * and 14 with no parent at all.
   *
   * Containers are excluded on purpose — an item with children belongs at the
   * root, that is what a root is. What this counts is leaf work sitting at top
   * level, which is the shape of an inbox rather than a plan.
   */
  rootlessOpen: number;
  /** Longest parent chain. 1 means flat — every item is top level. */
  depth: number;
}

export interface Board {
  projectId: string;
  modules: ModuleProgress[];
  /** Items in no module at all — the work the epic layer does not account for. */
  unfiled: Progress;
  project: Progress;
  /**
   * Whether the board has any shape. Omitted for a single-module query, which
   * cannot see enough of the project to say.
   */
  structure?: Structure;
  /**
   * Set only when the blocker budget ran out, which takes an extraordinary
   * number of simultaneously-ready items. It means `ready` is an upper bound and
   * `blocked` a lower one, rather than a count. Absent is the normal case and
   * means every bucket was decided.
   */
  blockersUnchecked?: number;
  /** Live leases, so "what is everyone doing" is answered in the same call. */
  active: Array<{
    holder: string;
    workItemId: string;
    readableId: string;
    title: string;
    expiresAt: string;
  }>;
  /**
   * Where Plane and the lease table disagree. Absent when they do not.
   *
   * Reported here because this is a place a person actually looks, and a
   * reconciliation whose findings live only in a log line is the same silence it
   * was built to end. The scheduled pass repairs; this only counts, so reading a
   * board never writes to Plane.
   *
   * `humanIntervened` and `untracked` are not faults to be fixed — they are a
   * person having taken work back, and work nobody told the gateway about. They
   * are here so somebody can see them, not so something can act on them.
   */
  drift?: Record<DriftKind, number>;
  /**
   * Set when reconciliation is refusing to repair because there is too much to
   * repair. Present only in that case, so it never becomes background noise.
   */
  driftUnrepaired?: string;
}

const DONE = new Set<State['group']>(['completed', 'cancelled']);

/**
 * Open leaf items with no parent — the shape of an inbox rather than a plan.
 *
 * Returns the ITEMS, not a count, and everything that needs the number takes
 * `.length`. A count computed separately from the list it describes is how a
 * summary ends up disagreeing with the evidence behind it, which is the failure
 * this whole metric exists to catch. The periodic review names offenders and
 * `structure` reports how many there are; both come from here, so they cannot
 * drift apart.
 *
 * Containers are excluded deliberately: an item with children belongs at the
 * root, that is what a root is.
 */
export function rootlessOpenOf(
  all: WorkItem[],
  groupOf: Map<string, State['group']>,
): WorkItem[] {
  const hasChild = new Set<string>();
  for (const i of all) if (i.parent) hasChild.add(i.parent);
  return all.filter(
    (i) => !i.parent && !hasChild.has(i.id) && !DONE.has(groupOf.get(i.state) as State['group']),
  );
}

function structureOf(
  all: WorkItem[],
  filed: Set<string>,
  groupOf: Map<string, State['group']>,
): Structure {
  const byId = new Map(all.map((i) => [i.id, i]));
  const childCount = new Map<string, number>();
  for (const i of all) {
    if (i.parent) childCount.set(i.parent, (childCount.get(i.parent) ?? 0) + 1);
  }

  // Longest parent chain. Memoised, and guarded against a cycle Plane should
  // never produce but which would otherwise hang the board rather than misreport
  // it — the worse of the two failures.
  const depthOf = new Map<string, number>();
  const chain = (id: string, seen: Set<string>): number => {
    const memo = depthOf.get(id);
    if (memo !== undefined) return memo;
    if (seen.has(id)) return 1;
    const parent = byId.get(id)?.parent;
    seen.add(id);
    const d = parent && byId.has(parent) ? chain(parent, seen) + 1 : 1;
    depthOf.set(id, d);
    return d;
  };

  const s: Structure = {
    items: all.length,
    filed: 0,
    parented: 0,
    containers: 0,
    unplaced: 0,
    unplacedOpen: 0,
    rootlessOpen: 0,
    depth: 0,
  };

  for (const i of all) {
    const inModule = filed.has(i.id);
    const hasChildren = (childCount.get(i.id) ?? 0) > 0;
    const open = !DONE.has(groupOf.get(i.state) as State['group']);
    if (inModule) s.filed++;
    if (i.parent) s.parented++;
    if (hasChildren) s.containers++;
    if (!inModule && !i.parent && !hasChildren) {
      s.unplaced++;
      if (open) s.unplacedOpen++;
    }
    s.depth = Math.max(s.depth, chain(i.id, new Set()));
  }
  // From the shared rule rather than a second inline condition, so this number
  // and the items the periodic review names are always the same set.
  s.rootlessOpen = rootlessOpenOf(all, groupOf).length;
  return s;
}

/** The four buckets, named. Exhaustive and disjoint — see `Progress`. */
export type Bucket = 'done' | 'held' | 'ready' | 'blocked';

/**
 * Which bucket one item falls in.
 *
 * Split out from `tally` so that anything else counting the same items counts
 * them the same way. `tree` reports a rollup per node, and a second copy of these
 * four lines is how a branch would come to disagree with the board about its own
 * children — the failure the exhaustive-and-disjoint rule exists to prevent,
 * reintroduced one file over.
 *
 * Order is load-bearing: a held item is usually also unready, and calling it
 * blocked would double-count it out of the bucket that explains it.
 */
export function bucketOf(
  item: WorkItem,
  groupOf: Map<string, State['group']>,
  held: (id: string) => boolean,
  reasons: (i: WorkItem) => string[],
): Bucket {
  if (DONE.has(groupOf.get(item.state) as State['group'])) return 'done';
  if (held(item.id)) return 'held';
  return reasons(item).length === 0 ? 'ready' : 'blocked';
}

const tally = (
  items: WorkItem[],
  groupOf: Map<string, State['group']>,
  held: (id: string) => boolean,
  reasons: (i: WorkItem) => string[],
): Progress => {
  const p: Progress = { total: items.length, done: 0, held: 0, ready: 0, blocked: 0 };
  for (const i of items) p[bucketOf(i, groupOf, held, reasons)]++;
  return p;
};

export async function board(
  plane: PlaneClient,
  pool: Pool,
  opts: {
    projectId: string;
    /** The caller's Plane user id; see `Predicate.viewer`. */
    viewer: string | null;
    moduleId?: string | undefined;
    capabilities?: string[] | undefined;
  },
): Promise<Board> {
  const [{ all, ctx, groupOf, reasons, blockersUnchecked }, modules] = await Promise.all([
    resolve(plane, pool, {
      projectId: opts.projectId,
      viewer: opts.viewer,
      ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
    }),
    plane.modules(opts.projectId).catch(() => []),
  ]);

  const wanted = opts.moduleId ? modules.filter((m) => m.id === opts.moduleId) : modules;

  // Read-only, and cheap: both sides are already in hand. Only project-wide,
  // like `structure` and for the same reason -- scoped to one module the lease
  // rows outside it would all read as drift.
  const found = opts.moduleId
    ? []
    : classify(all, await leasesOf(pool, opts.projectId), (id) => groupOf.get(id));
  const drift = found.reduce(
    (acc, d) => ({ ...acc, [d.kind]: (acc[d.kind] ?? 0) + 1 }),
    {} as Record<DriftKind, number>,
  );
  // Said here as well as in the log, because "nothing is being repaired and
  // somebody should look" is a fact about the board rather than about the
  // gateway's plumbing. See REPAIR_CEILING.
  const wouldRepair = found.filter((d) => REPAIRABLE.has(d.kind)).length;

  // One call per module. Membership lives behind its own endpoint, so there is no
  // way to get this from the item listing — worth knowing before pointing this at
  // a project with fifty modules.
  // Not `.catch(() => empty)`. A blanket catch here once swallowed a real bug —
  // the readback shape was misread, `.map` threw, and every module reported zero
  // items with no error anywhere. Only a genuinely absent module is tolerated.
  const membership = await Promise.all(
    wanted.map((m) =>
      plane
        .moduleIssueIds(opts.projectId, m.id)
        .then((ids) => ({ m, ids }))
        .catch((err: unknown) => {
          if (err instanceof GatewayError && err.code === 'NOT_FOUND') {
            return { m, ids: new Set<string>() };
          }
          throw err;
        }),
    ),
  );

  const held = (id: string) => ctx.leases.has(id);
  const byId = new Map(all.map((i) => [i.id, i]));
  const filed = new Set<string>();

  const moduleProgress = membership.map(({ m, ids }) => {
    for (const id of ids) filed.add(id);
    const items = [...ids].map((id) => byId.get(id)).filter((i): i is WorkItem => Boolean(i));
    return { moduleId: m.id, name: m.name, ...tally(items, groupOf, held, reasons) };
  });

  return {
    projectId: opts.projectId,
    modules: moduleProgress,
    // Only meaningful across the whole board; a single-module view would call
    // everything else unfiled, which would be a lie about the project.
    unfiled: opts.moduleId
      ? { total: 0, done: 0, held: 0, ready: 0, blocked: 0 }
      : tally(all.filter((i) => !filed.has(i.id)), groupOf, held, reasons),
    project: tally(all, groupOf, held, reasons),
    // Only project-wide. Scoped to one module, `filed` holds that module's members
    // alone, so every item outside it would be reported unplaced — a number that
    // is not merely incomplete but wrong.
    ...(opts.moduleId ? {} : { structure: structureOf(all, filed, groupOf) }),
    ...(blockersUnchecked ? { blockersUnchecked } : {}),
    ...(Object.keys(drift).length ? { drift: drift as Record<DriftKind, number> } : {}),
    ...(wouldRepair > REPAIR_CEILING
      ? {
          driftUnrepaired:
            `${wouldRepair} items would be repaired in one pass, over the ceiling of ` +
            `${REPAIR_CEILING}, so reconciliation is repairing nothing here. That many at ` +
            'once is more often a broken rule than a broken board — look before clearing it.',
        }
      : {}),
    active: [...ctx.leases.entries()]
      .map(([id, l]) => {
        const item = byId.get(id);
        return item
          ? {
              holder: l.holder,
              workItemId: id,
              readableId: readableId(item.sequence_id, ctx.identifier),
              title: item.name,
              expiresAt: l.expiresAt,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
  };
}
