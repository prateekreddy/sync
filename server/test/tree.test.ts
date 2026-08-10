import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tree } from '../src/tree.js';
import { board } from '../src/board.js';
import { PlaneClient } from '../src/plane.js';
import { NO_RELATIONS } from './relations.js';
import type { State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import * as lease from '../src/lease.js';

/**
 * "What is under this, and what is left?" has no answer in Plane alone: Plane
 * holds the parent links, the gateway holds the leases, and a count of unfinished
 * children without lease state is actively misleading — an item can be unfinished
 * *and* already being worked, and an agent that cannot tell those apart duplicates
 * somebody's run.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();

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

/**
 * Items are addressed by readable key in these tests but need real uuids: the
 * lease table's work_item_id is a uuid column, so a fixture using 'busy' as an id
 * fails in the database rather than in the code under test.
 */
const ids = new Map<string, string>();
const id = (key: string): string => {
  const hit = ids.get(key);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(key, made);
  return made;
};

const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: id(key),
  sequence_id: ++seq,
  project: PROJECT,
  name: key,
  description_html: '<p>spec</p>',
  state: 'backlog',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
  // Parents are given by key too, and translated here so no test has to know a uuid.
  ...(over.parent ? { parent: id(over.parent) } : {}),
});

const fakePlane = (items: WorkItem[]): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    // The shared view context resolves label ids to names, so every fake feeding
    // a read tool has to answer this or it falls through to a real fetch.
    labels: async () => [],
    // Likewise since SYNC-65: the readiness gate resolves blockers on every
    // browse, not only at claim time.
    relations: async () => NO_RELATIONS,
    // Only `board` asks, and only so the two can be compared against the same
    // items — see the per-node rollup tests below.
    modules: async () => [],
  });

const ask = (items: WorkItem[], key: string, depth?: number) =>
  tree(fakePlane(items), pool, {
    projectId: PROJECT,
    workItemId: id(key),
    ...(depth ? { depth } : {}),
  });

describe('tree', () => {
  it('returns the children of an item', async () => {
    const got = await ask([wi('epic'), wi('a', { parent: 'epic' }), wi('b', { parent: 'epic' })], 'epic');
    expect(got.node.children?.map((c) => c.title)).toEqual(['a', 'b']);
    expect(got.openDescendants).toBe(2);
  });

  it('walks past the first level — the whole point of a tree', async () => {
    const got = await ask(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story' })],
      'epic',
    );
    expect(got.node.children?.[0]?.children?.[0]?.title).toBe('task');
    expect(got.openDescendants).toBe(2);
  });

  it('counts only unfinished descendants, at any depth', async () => {
    const got = await ask(
      [
        wi('epic'),
        wi('done-one', { parent: 'epic', state: 'done' }),
        wi('open-one', { parent: 'epic' }),
        wi('deep', { parent: 'open-one' }),
      ],
      'epic',
    );
    expect(got.openDescendants).toBe(2);
  });

  it('names the agent holding a child, and when the lease lapses', async () => {
    // Without this an agent reads "unfinished" and starts work someone is already doing.
    await lease.claim(pool, {
      workItemId: id('busy'),
      projectId: PROJECT,
      holder: 'agent:worker-1',
      ttlSeconds: 600,
    });
    const got = await ask([wi('epic'), wi('busy', { parent: 'epic' })], 'epic');
    expect(got.node.children?.[0]?.holder).toBe('agent:worker-1');
    expect(got.node.children?.[0]?.expiresAt).toMatch(/^20/);
  });

  it('does not report a lapsed lease as a holder', async () => {
    await lease.claim(pool, {
      workItemId: id('stale'),
      projectId: PROJECT,
      holder: 'agent:gone',
      ttlSeconds: 30,
    });
    await pool.query("update lease set expires_at = now() - interval '1 second'");
    const got = await ask([wi('epic'), wi('stale', { parent: 'epic' })], 'epic');
    expect(got.node.children?.[0]?.holder).toBeUndefined();
  });

  it('shows a leaf what it is part of, root first', async () => {
    const got = await ask(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story' })],
      'task',
    );
    expect(got.path.map((p) => p.title)).toEqual(['epic', 'story']);
    expect(got.node.title).toBe('task');
  });

  it('gives an empty path for an item with no parent', async () => {
    const got = await ask([wi('epic')], 'epic');
    expect(got.path).toEqual([]);
  });

  it('marks a tree cut short, so truncation is never read as completeness', async () => {
    const got = await ask(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story' })],
      'epic',
      1,
    );
    expect(got.node.children?.[0]?.truncated).toBe(true);
    expect(got.node.children?.[0]?.children).toBeUndefined();
  });

  it('survives a parent cycle rather than recursing forever', async () => {
    // capture cannot create one, but update_issue can set any parent and Plane
    // does not stop it. Reporting the walkable tree beats hanging the gateway.
    const got = await ask([wi('a', { parent: 'b' }), wi('b', { parent: 'a' })], 'a');
    expect(got.node.title).toBe('a');
    expect(got.path.length).toBeLessThanOrEqual(1);
  });

  it('refuses an item that is not in this project', async () => {
    await expect(ask([wi('other')], 'missing')).rejects.toThrow(GatewayError);
  });
});

/**
 * "Which of these is nearly finished and which has not started" is what anyone
 * scanning a list of containers is actually asking, and one figure for the whole
 * tree cannot answer it.
 */
describe('how much is left under each branch', () => {
  it('reports a leaf as one item in its own bucket', async () => {
    const got = await ask([wi('epic'), wi('task', { parent: 'epic' })], 'task');
    expect(got.node?.progress).toMatchObject({ total: 1, ready: 1, done: 0 });
  });

  it('counts a container together with everything under it', async () => {
    const got = await ask(
      [wi('epic'), wi('a', { parent: 'epic', state: 'done' }), wi('b', { parent: 'epic' })],
      'epic',
    );
    // Three, not two: the container counts itself. It sits in `blocked` because
    // a parent with an open child is unclaimable — and once that child lands the
    // rollup closes the container and this same node reads 3 done of 3.
    expect(got.node?.progress).toMatchObject({ total: 3, done: 1, ready: 1, blocked: 1 });
  });

  it('separates work already being done from work anyone could pick up', async () => {
    await lease.claim(pool, {
      workItemId: id('taken'),
      projectId: PROJECT,
      holder: 'agent:worker-1',
      ttlSeconds: 600,
    });
    const got = await ask(
      [wi('epic'), wi('taken', { parent: 'epic' }), wi('free', { parent: 'epic' })],
      'epic',
    );
    expect(got.node?.progress).toMatchObject({ held: 1, ready: 1 });
  });

  it('rolls counts up through every level, not just the one below', async () => {
    const got = await ask(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story', state: 'done' })],
      'epic',
    );
    expect(got.node?.progress.total).toBe(3);
    expect(got.node?.progress.done).toBe(1);
    expect(got.node?.children?.[0]?.progress).toMatchObject({ total: 2, done: 1 });
  });

  it('still says how much is inside a node it stopped expanding', async () => {
    // The point of counting separately from the walk: a branch you chose not to
    // open must still be able to tell you how big it is, or truncation hides the
    // work rather than deferring it.
    const got = await ask(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story' })],
      'epic',
      1,
    );
    const story = got.node?.children?.[0];
    expect(story?.truncated).toBe(true);
    expect(story?.progress.total).toBe(2);
  });

  it('does not let a ready filter change what it says exists', async () => {
    // The view narrows; the work does not. A branch reporting "1 of 1" because
    // the finished siblings were filtered out would be a lie about progress.
    const got = await tree(
      fakePlane([wi('epic'), wi('done-one', { parent: 'epic', state: 'done' }), wi('open-one', { parent: 'epic' })]),
      pool,
      { projectId: PROJECT, viewer: null, workItemId: id('epic'), ready: true },
    );
    expect(got.node?.children?.map((c) => c.title)).toEqual(['open-one']);
    expect(got.node?.progress).toMatchObject({ total: 3, done: 1 });
  });
});

/**
 * The top level, asked for without knowing an id first.
 *
 * This is the question a person opens a tracker with, and until now nothing could
 * answer it: `tree` needed an id you already had, which assumes you know what you
 * are looking for, and `board` counts modules, which is a different cut and says
 * nothing about what any item is part of.
 */
const askRoots = (
  items: WorkItem[],
  over: { depth?: number; ready?: boolean; includeDone?: boolean } = {},
) => tree(fakePlane(items), pool, { projectId: PROJECT, ...over });

describe('tree of a whole project', () => {
  it('answers with the top-level items when no item is named', async () => {
    const got = await askRoots([
      wi('epic-a'),
      wi('epic-b'),
      wi('task', { parent: 'epic-a' }),
    ]);
    expect(got.roots?.map((r) => r.title)).toEqual(['epic-a', 'epic-b']);
    expect(got.node).toBeUndefined();
    expect(got.path).toEqual([]);
  });

  it('shows what is under each root, not just the roots', async () => {
    const got = await askRoots([wi('epic'), wi('a', { parent: 'epic' }), wi('b', { parent: 'epic' })]);
    expect(got.roots?.[0]?.children?.map((c) => c.title)).toEqual(['a', 'b']);
  });

  it('counts top-level work as unfinished, not only what is under it', async () => {
    // The failure this guards: a board of nothing but unparented open items would
    // otherwise report openDescendants 0 and read as an empty project. The
    // implicit parent of a forest is the project, so a root IS a descendant of
    // what was asked about.
    const got = await askRoots([wi('loose-one'), wi('loose-two')]);
    expect(got.openDescendants).toBe(2);
  });

  it('stops two levels down by default, so a project is a screen and not a listing', async () => {
    const got = await askRoots([
      wi('epic'),
      wi('story', { parent: 'epic' }),
      wi('task', { parent: 'story' }),
    ]);
    const story = got.roots?.[0]?.children?.[0];
    expect(story?.title).toBe('story');
    expect(story?.truncated).toBe(true);
    expect(story?.children).toBeUndefined();
  });

  it('expands further when asked', async () => {
    const got = await askRoots(
      [wi('epic'), wi('story', { parent: 'epic' }), wi('task', { parent: 'story' })],
      { depth: 3 },
    );
    expect(got.roots?.[0]?.children?.[0]?.children?.[0]?.title).toBe('task');
  });

  it('keeps an item whose parent was deleted rather than hiding it', async () => {
    // Plane allows the parent to go while the child stays. An item that appears
    // in no tree at all is work nobody can find, which is the failure this view
    // exists to end, arriving by another door.
    const got = await askRoots([wi('orphan', { parent: 'long-gone' })]);
    expect(got.roots?.map((r) => r.title)).toEqual(['orphan']);
  });

  it('narrows the top level to what could actually be picked up', async () => {
    const got = await askRoots(
      [wi('ready-one'), wi('draft', { is_draft: true })],
      { ready: true },
    );
    expect(got.roots?.map((r) => r.title)).toEqual(['ready-one']);
  });

  it('adds up to exactly what the board reports for the project', async () => {
    // The invariant that makes the two views trustworthy together: every item is
    // in exactly one root's sub-tree, so the roots partition the project. If a
    // second copy of the bucket rule ever appears, this is what catches it.
    const items = [
      wi('epic'),
      wi('a', { parent: 'epic' }),
      wi('b', { parent: 'epic', state: 'done' }),
      wi('loose'),
      wi('draft', { is_draft: true }),
    ];
    const plane = fakePlane(items);
    const got = await tree(plane, pool, { projectId: PROJECT, viewer: null });
    const view = await board(plane, pool, { projectId: PROJECT, viewer: null });
    const sum = (k: 'total' | 'done' | 'held' | 'ready' | 'blocked') =>
      (got.roots ?? []).reduce((n, r) => n + r.progress[k], 0);

    expect(sum('total')).toBe(view.project.total);
    expect(sum('done')).toBe(view.project.done);
    expect(sum('ready')).toBe(view.project.ready);
    expect(sum('blocked')).toBe(view.project.blocked);
  });

  it('keeps a container at the top level when the claimable work is inside it', async () => {
    // A parent is unclaimable *because* the work is in its children, so pruning
    // it under `ready` would prune the answer.
    const got = await askRoots([wi('epic'), wi('task', { parent: 'epic' })], { ready: true });
    expect(got.roots?.map((r) => r.title)).toEqual(['epic']);
    expect(got.roots?.[0]?.children?.map((c) => c.title)).toEqual(['task']);
  });
});

/**
 * Finished work stops sitting at the top of the default view.
 *
 * This reverses an earlier decision on purpose. The argument then was that
 * filtering finished work would be a hidden policy, and that a caller wanting
 * less could pass `ready`. Measured on the real board six weeks later, the top
 * level returned 66 roots, 52 of them Done — the unreadable project listing this
 * view exists to replace, arriving from the other direction. "No policy" was
 * itself a policy: everything ever finished, forever, at the top.
 *
 * `ready` was never the answer either. It drops any container whose children are
 * all finished, so the completed structure disappears from a view whose whole
 * job is to show shape.
 */
describe('what the top level leaves out', () => {
  const done = (key: string, over: Partial<WorkItem> = {}) => wi(key, { ...over, state: 'done' });

  it('leaves out a root whose whole subtree is finished', async () => {
    const got = await askRoots([done('shipped'), wi('live')]);
    expect(got.roots?.map((r) => r.title)).toEqual(['live']);
  });

  it('says how many it left out, so the default is not a hidden policy', async () => {
    // The objection that kept this view unfiltered was that a filter would be
    // invisible. It is answered by the count, not by refusing to filter.
    const got = await askRoots([done('a'), done('b'), wi('live')]);
    expect(got.finishedRootsHidden).toBe(2);
  });

  it('says nothing when nothing was left out', async () => {
    // A field that appears only when it has something to report is one nobody
    // learns to ignore.
    const got = await askRoots([wi('live')]);
    expect(got.finishedRootsHidden).toBeUndefined();
  });

  it('keeps a finished container that still has unfinished work inside it', async () => {
    // The rule is the whole subtree, not the root's own state. Hiding this would
    // hide open work, which no readability argument can justify.
    const got = await askRoots([done('epic'), wi('leftover', { parent: 'epic' })]);
    expect(got.roots?.map((r) => r.title)).toEqual(['epic']);
    expect(got.finishedRootsHidden).toBeUndefined();
  });

  it('brings the finished ones back when asked', async () => {
    const got = await askRoots([done('shipped'), wi('live')], { includeDone: true });
    expect(got.roots?.map((r) => r.title)).toEqual(['shipped', 'live']);
    expect(got.finishedRootsHidden).toBeUndefined();
  });

  it('still shows a finished container to anyone who asks for it by name', async () => {
    // The other half of done-when: not in the way, but never unreachable.
    const got = await ask([done('shipped'), done('detail', { parent: 'shipped' })], 'shipped');
    expect(got.node.title).toBe('shipped');
    expect(got.node.children?.map((c) => c.title)).toEqual(['detail']);
  });

  it('does not change what the tree says exists', async () => {
    // Same guarantee the `ready` filter carries: what is shown may narrow, what
    // is counted may not. A hidden root would otherwise quietly shrink the
    // project's totals and make the board and the tree disagree.
    const items = [done('shipped'), done('detail', { parent: 'shipped' }), wi('live')];
    const shown = await askRoots(items);
    const all = await askRoots(items, { includeDone: true });
    expect(shown.openDescendants).toBe(all.openDescendants);
  });
});
