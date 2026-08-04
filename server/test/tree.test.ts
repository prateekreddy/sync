import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tree } from '../src/tree.js';
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
  assignees: [],
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
