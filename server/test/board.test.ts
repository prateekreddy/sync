import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { board } from '../src/board.js';
import { PlaneClient } from '../src/plane.js';
import type { Relations, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';

/**
 * Plane reports per-module counts, and they are not the interesting ones. It can
 * say how many items are done; it cannot say how many are **ready**, because that
 * needs the readiness gate and the lease table. So the property worth pinning is
 * that the buckets are exhaustive and disjoint — done + held + ready + blocked
 * must equal total, or a number quietly hides in an overlap and someone plans
 * against it.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ids = new Map<string, string>();
const id = (k: string): string => {
  const hit = ids.get(k);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(k, made);
  return made;
};

beforeEach(async () => {
  await pool.query('truncate lease');
});
afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

let seq = 0;
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: id(key),
  sequence_id: ++seq,
  name: key,
  description_html: '<p>spec</p>',
  state: 'backlog',
  priority: 'medium',
  labels: [],
  parent: null,
  is_draft: false,
  assignees: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

const BOARD = [
  wi('ready-1'),
  wi('ready-2'),
  wi('finished', { state: 'done' }),
  wi('no-spec', { description_html: '' }),
  wi('leased'),
  wi('unfiled-one'),
];

const MODULES = [{ id: 'mod-a', name: 'Feature A' }];
const MEMBERS = ['ready-1', 'ready-2', 'finished', 'no-spec', 'leased'];

const fakePlane = (opts: { modulesFail?: boolean } = {}): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => BOARD,
    states: async () => STATES,
    labels: async () => [],
    relations: async () => ({}) as Relations,
    modules: async () => {
      if (opts.modulesFail) throw new Error('modules not enabled');
      return MODULES;
    },
    moduleIssueIds: async () => new Set(MEMBERS.map(id)),
  });

describe('board', () => {
  it('buckets every item exactly once, so the numbers add up', async () => {
    const got = await board(fakePlane(), pool, { projectId: PROJECT });
    const p = got.project;
    expect(p.done + p.held + p.ready + p.blocked).toBe(p.total);
    expect(p.total).toBe(BOARD.length);
  });

  it('counts ready — the number Plane cannot produce', async () => {
    const got = await board(fakePlane(), pool, { projectId: PROJECT });
    const m = got.modules[0]!;
    expect(m.name).toBe('Feature A');
    expect(m.ready).toBe(3); // ready-1, ready-2, leased (no lease yet)
    expect(m.done).toBe(1);
    expect(m.blocked).toBe(1); // no-spec
  });

  it('moves an item from ready to held the moment someone claims it', async () => {
    const before = await board(fakePlane(), pool, { projectId: PROJECT });
    await lease.claim(pool, {
      workItemId: id('leased'),
      projectId: PROJECT,
      holder: 'agent:w1',
      ttlSeconds: 600,
    });
    const after = await board(fakePlane(), pool, { projectId: PROJECT });
    expect(after.modules[0]!.ready).toBe(before.modules[0]!.ready - 1);
    expect(after.modules[0]!.held).toBe(1);
    expect(after.project.total).toBe(before.project.total);
  });

  it('reports what other agents are holding, oldest lease first', async () => {
    await lease.claim(pool, {
      workItemId: id('leased'),
      projectId: PROJECT,
      holder: 'agent:w1',
      ttlSeconds: 600,
    });
    const got = await board(fakePlane(), pool, { projectId: PROJECT });
    expect(got.active).toHaveLength(1);
    expect(got.active[0]).toMatchObject({ holder: 'agent:w1', title: 'leased' });
  });

  it('counts work the epic layer does not account for', async () => {
    // Unfiled is the honest measure of how much the module view is missing.
    const got = await board(fakePlane(), pool, { projectId: PROJECT });
    expect(got.unfiled.total).toBe(1);
  });

  it('does not claim everything is unfiled when asked about one module', async () => {
    const got = await board(fakePlane(), pool, { projectId: PROJECT, moduleId: 'mod-a' });
    expect(got.modules).toHaveLength(1);
    expect(got.unfiled.total).toBe(0);
  });

  it('still reports the project when modules are disabled', async () => {
    // provision.sh enables module_view now, but an older project may not have it,
    // and a board that fails entirely would be a worse answer than one without
    // the epic layer.
    const got = await board(fakePlane({ modulesFail: true }), pool, { projectId: PROJECT });
    expect(got.modules).toEqual([]);
    expect(got.project.total).toBe(BOARD.length);
  });

  it('applies the token capabilities to what counts as ready', async () => {
    // A capability-scoped agent asking "what is left for me" must not be told
    // about work it cannot take.
    const got = await board(fakePlane(), pool, {
      projectId: PROJECT,
      capabilities: ['nothing-matches'],
    });
    expect(got.project.ready).toBe(0);
    expect(got.project.total).toBe(BOARD.length);
  });
});

/**
 * Progress answers "how much is left". It says nothing about whether any of it
 * hangs together, so a board can report healthy numbers while being an inbox —
 * which is what happened here: 35 items, zero parents, 25 unfiled, noticed only
 * because a human asked. A number nobody can see is a number nobody fixes.
 */
describe('structure', () => {
  const flat = [wi('a'), wi('b'), wi('c')];
  const shaped = [
    wi('epic'),
    wi('story', { parent: id('epic') }),
    wi('task', { parent: id('story') }),
    wi('loose'),
  ];

  const planeWith = (items: WorkItem[], members: string[] = []): PlaneClient =>
    Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
      listWorkItems: async () => items,
      states: async () => STATES,
      labels: async () => [],
      relations: async () => ({}) as Relations,
      modules: async () => MODULES,
      moduleIssueIds: async () => new Set(members),
    });

  it('reports a flat board as flat', async () => {
    const got = await board(planeWith(flat), pool, { projectId: PROJECT });
    expect(got.structure).toMatchObject({
      items: 3,
      parented: 0,
      containers: 0,
      filed: 0,
      unplaced: 3,
      depth: 1,
    });
  });

  it('measures how deep the hierarchy actually goes', async () => {
    const got = await board(planeWith(shaped), pool, { projectId: PROJECT });
    expect(got.structure).toMatchObject({
      parented: 2,
      containers: 2, // epic and story
      depth: 3,
      unplaced: 1, // only `loose`
    });
  });

  it('counts an item in a module as filed even with no parent', async () => {
    const got = await board(planeWith(flat, [id('a')]), pool, { projectId: PROJECT });
    expect(got.structure).toMatchObject({ filed: 1, unplaced: 2 });
  });

  it('still calls a filed item rootless when it has no parent', async () => {
    // The failure this exists for: `unplaced` needs an item to be in no module
    // AND have no parent, so a board with everything filed and nothing parented
    // reported unplaced: 0 and read as fully structured. Measured on a real
    // project: 63 items, unplaced: 0, 14 with no parent.
    const got = await board(planeWith(flat, flat.map((i) => i.id)), pool, { projectId: PROJECT });

    expect(got.structure).toMatchObject({ filed: 3, unplaced: 0, rootlessOpen: 3 });
  });

  it('does not count a container as rootless — a root is where containers belong', async () => {
    const got = await board(planeWith(shaped), pool, { projectId: PROJECT });
    // `epic` has children, `loose` does not: only `loose` is rootless leaf work.
    expect(got.structure?.rootlessOpen).toBe(1);
  });

  it('does not count finished work as rootless', async () => {
    const mixed = [wi('open-1'), wi('shipped', { state: 'done' })];
    const got = await board(planeWith(mixed), pool, { projectId: PROJECT });
    expect(got.structure?.rootlessOpen).toBe(1);
  });

  it('separates the unplaced work you can still act on', async () => {
    // Placing a finished item changes nothing; the actionable number is the open
    // half, and reporting only the total would overstate the problem.
    const mixed = [wi('open-1'), wi('open-2'), wi('shipped', { state: 'done' })];
    const got = await board(planeWith(mixed), pool, { projectId: PROJECT });
    expect(got.structure).toMatchObject({ unplaced: 3, unplacedOpen: 2 });
  });

  it('says nothing about structure when asked about one module', async () => {
    // Scoped that way, `filed` holds one module's members, so everything outside
    // it would be reported unplaced — wrong, not merely partial.
    const got = await board(planeWith(flat), pool, { projectId: PROJECT, moduleId: 'mod-a' });
    expect(got.structure).toBeUndefined();
  });

  it('does not hang on a parent cycle', async () => {
    // Plane should never produce one. Misreporting depth is survivable; hanging
    // the board is not.
    const cyclic = [wi('x', { parent: id('y') }), wi('y', { parent: id('x') })];
    const got = await board(planeWith(cyclic), pool, { projectId: PROJECT });
    expect(got.structure?.items).toBe(2);
  });
});
