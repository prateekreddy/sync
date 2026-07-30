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

export interface Board {
  projectId: string;
  modules: ModuleProgress[];
  /** Items in no module at all — the work the epic layer does not account for. */
  unfiled: Progress;
  project: Progress;
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
