import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { resolve } from './query.js';

/**
 * Where a project stands: progress per module, and what the fleet is holding.
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
  /** Live leases, so "what is the fleet doing" is answered in the same call. */
  fleet: Array<{
    holder: string;
    workItemId: string;
    readableId: string;
    title: string;
    expiresAt: string;
  }>;
}

const DONE = new Set<State['group']>(['completed', 'cancelled']);

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
    // Deliberately not gated on `inModule`: being filed is what made the old
    // number look healthy while the tree was flat.
    if (open && !i.parent && !hasChildren) s.rootlessOpen++;
    s.depth = Math.max(s.depth, chain(i.id, new Set()));
  }
  return s;
}

const tally = (
  items: WorkItem[],
  groupOf: Map<string, State['group']>,
  held: (id: string) => boolean,
  reasons: (i: WorkItem) => string[],
): Progress => {
  const p: Progress = { total: items.length, done: 0, held: 0, ready: 0, blocked: 0 };
  for (const i of items) {
    if (DONE.has(groupOf.get(i.state) as State['group'])) p.done++;
    else if (held(i.id)) p.held++;
    else if (reasons(i).length === 0) p.ready++;
    else p.blocked++;
  }
  return p;
};

export async function board(
  plane: PlaneClient,
  pool: Pool,
  opts: { projectId: string; moduleId?: string | undefined; capabilities?: string[] | undefined },
): Promise<Board> {
  const [{ all, ctx, groupOf, reasons }, modules] = await Promise.all([
    resolve(plane, pool, {
      projectId: opts.projectId,
      ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
    }),
    plane.modules(opts.projectId).catch(() => []),
  ]);

  const wanted = opts.moduleId ? modules.filter((m) => m.id === opts.moduleId) : modules;

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
    fleet: [...ctx.leases.entries()]
      .map(([id, l]) => {
        const item = byId.get(id);
        return item
          ? {
              holder: l.holder,
              workItemId: id,
              readableId: `#${item.sequence_id}`,
              title: item.name,
              expiresAt: l.expiresAt,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
  };
}
