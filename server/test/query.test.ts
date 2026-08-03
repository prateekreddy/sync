import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from '../src/query.js';
import { readyCandidates, explain } from '../src/readiness.js';
import { find } from '../src/find.js';
import { tree } from '../src/tree.js';
import { PlaneClient } from '../src/plane.js';
import { NO_RELATIONS } from './relations.js';
import type { Label, Relations, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';

/**
 * `next` is `find(ready, ordered)`. `why` is a query for one item that keeps the
 * predicate's reasons. `tree` is a query with a hierarchy projection. They were
 * four implementations, and the gap between them produced a real defect:
 * `find(ready:true)` ignored the token's capabilities while its description
 * promised it applied "the same gate claim uses".
 *
 * These tests assert the tools **agree**, not that each is individually right.
 * A fifth preset that re-implements the predicate fails them.
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
const LABELS: Label[] = [
  { id: 'l-be', name: 'backend' },
  { id: 'l-fe', name: 'frontend' },
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
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
  ...(over.parent ? { parent: id(over.parent) } : {}),
});

const BOARD = [
  wi('be-task', { labels: ['l-be'] }),
  wi('fe-task', { labels: ['l-fe'] }),
  wi('plain'),
  wi('no-spec', { description_html: '' }),
];

const fakePlane = (items: WorkItem[] = BOARD): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labels: async () => LABELS,
    relations: async () => NO_RELATIONS,
    getWorkItem: async (_p: string, i: string) => items.find((x) => x.id === i)!,
  });

const titles = (xs: Array<{ title: string }>) => xs.map((x) => x.title).sort();

describe('one predicate, several presets', () => {
  it('find(ready) and next return the same set — the defect this replaces', async () => {
    const plane = fakePlane();
    const fromNext = await readyCandidates(plane, pool, { projectId: PROJECT, limit: 50 });
    const fromFind = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(titles(fromFind.items)).toEqual(titles(fromNext));
  });

  it('and they still agree once the token is capability-scoped', async () => {
    // Before SYNC-32 this failed: next applied capabilities, find did not, so
    // find offered work claim would refuse.
    const plane = fakePlane();
    const caps = ['backend'];
    const fromNext = await readyCandidates(plane, pool, {
      projectId: PROJECT,
      capabilities: caps,
      limit: 50,
    });
    const fromFind = await find(plane, pool, {
      projectId: PROJECT,
      ready: true,
      capabilities: caps,
      limit: 50,
    });
    expect(titles(fromNext)).toEqual(['be-task']);
    expect(titles(fromFind.items)).toEqual(titles(fromNext));
  });

  it('browsing still shows work you cannot claim', async () => {
    // Capabilities filter only when `ready` is asked for. An agent may need to
    // see an item it cannot take — to link it as a blocker, for instance.
    const got = await find(fakePlane(), pool, {
      projectId: PROJECT,
      capabilities: ['backend'],
      limit: 50,
    });
    expect(titles(got.items)).toContain('fe-task');
  });

  it('why agrees with the filter about the same item', async () => {
    const plane = fakePlane();
    const withheld = await explain(plane, pool, {
      projectId: PROJECT,
      workItemId: id('no-spec'),
    });
    const offered = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(withheld.claimable).toBe(false);
    expect(titles(offered.items)).not.toContain('no-spec');
  });

  it('a lease withholds an item from every preset at once', async () => {
    await lease.claim(pool, {
      workItemId: id('plain'),
      projectId: PROJECT,
      holder: 'agent:someone',
      ttlSeconds: 600,
    });
    const plane = fakePlane();
    expect(titles(await readyCandidates(plane, pool, { projectId: PROJECT, limit: 50 }))).not.toContain('plain');
    expect(
      titles((await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 })).items),
    ).not.toContain('plain');
    const why = await explain(plane, pool, { projectId: PROJECT, workItemId: id('plain') });
    expect(why.reasons.join(' ')).toContain('agent:someone');
  });
});

describe('tree(ready) — the capability the decomposition made possible', () => {
  const items = [
    wi('epic'),
    wi('claimable', { parent: 'epic', labels: ['l-be'] }),
    wi('blocked-child', { parent: 'epic', description_html: '' }),
    wi('deep-parent', { parent: 'epic' }),
    wi('deep-leaf', { parent: 'deep-parent' }),
  ];

  it('shows only what could be picked up', async () => {
    const got = await tree(fakePlane(items), pool, {
      projectId: PROJECT,
      workItemId: id('epic'),
      ready: true,
    });
    const names = (got.node.children ?? []).map((c) => c.title);
    expect(names).toContain('claimable');
    expect(names).not.toContain('blocked-child');
  });

  it('keeps a container whose child is claimable, or it would hide the answer', async () => {
    // A parent is unclaimable *because* the work is in its children. Pruning it
    // under `ready` would prune exactly what was asked for.
    const got = await tree(fakePlane(items), pool, {
      projectId: PROJECT,
      workItemId: id('epic'),
      ready: true,
    });
    const deep = (got.node.children ?? []).find((c) => c.title === 'deep-parent');
    expect(deep).toBeDefined();
    expect((deep?.children ?? []).map((c) => c.title)).toEqual(['deep-leaf']);
  });

  it('leaves the tree whole without ready', async () => {
    const got = await tree(fakePlane(items), pool, { projectId: PROJECT, workItemId: id('epic') });
    expect((got.node.children ?? []).length).toBe(3);
  });
});

describe('resolve', () => {
  it('reports matches before the limit, so truncation is visible', async () => {
    const got = await resolve(fakePlane(), pool, { projectId: PROJECT, limit: 1 });
    expect(got.items.length).toBe(1);
    expect(got.matched).toBe(BOARD.length);
  });

  it('returns every item for structure, not just the matches', async () => {
    // `tree` needs parent links for items a filter excluded, or the tree breaks.
    const got = await resolve(fakePlane(), pool, { projectId: PROJECT, ready: true });
    expect(got.all.length).toBe(BOARD.length);
    expect(got.items.length).toBeLessThan(BOARD.length);
  });
});
