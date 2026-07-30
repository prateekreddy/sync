import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { find } from '../src/find.js';
import { PlaneClient } from '../src/plane.js';
import type { Label, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';

/**
 * Plane's v1 API ignores every list filter — measured on a 34-item board, where
 * `?priority=urgent`, `?labels=<uuid>` and `?state_group=backlog` each returned all
 * 34 — and exposes no views endpoint. So filtering happens here or nowhere, and
 * `holder` has no equivalent in any Plane view at all: it comes from the lease
 * table.
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
  { id: 'doing', name: 'In Progress', group: 'started', default: false },
];
const LABELS: Label[] = [
  { id: 'l-be', name: 'backend' },
  { id: 'l-fe', name: 'Frontend' },
];

const ids = new Map<string, string>();
const id = (k: string): string => {
  const hit = ids.get(k);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(k, made);
  return made;
};

let seq = 0;
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
  ...(over.parent ? { parent: id(over.parent) } : {}),
});

const fakePlane = (items: WorkItem[], moduleMembers?: string[]): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labels: async () => LABELS,
    moduleIssueIds: async () => new Set((moduleMembers ?? []).map(id)),
  });

const BOARD = [
  wi('be-ready', { labels: ['l-be'], priority: 'high' }),
  wi('fe-ready', { labels: ['l-fe'] }),
  wi('both', { labels: ['l-be', 'l-fe'] }),
  wi('doing', { state: 'doing' }),
  wi('no-spec', { description_html: '' }),
];

const q = (over: Record<string, unknown> = {}) =>
  find(fakePlane(BOARD), pool, { projectId: PROJECT, ...over });

describe('find', () => {
  it('filters by label name, not uuid', async () => {
    const got = await q({ labels: ['backend'] });
    expect(got.items.map((i) => i.title).sort()).toEqual(['be-ready', 'both']);
  });

  it('matches a label whatever case it was written in', async () => {
    expect((await q({ labels: ['frontend'] })).matched).toBe(2);
  });

  it('requires every named label, so a second one narrows', async () => {
    // "any of" would make adding a filter widen the result, which is the opposite
    // of what someone asking for two labels means.
    const got = await q({ labels: ['backend', 'frontend'] });
    expect(got.items.map((i) => i.title)).toEqual(['both']);
  });

  it('filters by priority and state group', async () => {
    expect((await q({ priority: 'high' })).items.map((i) => i.title)).toEqual(['be-ready']);
    expect((await q({ stateGroup: 'started' })).items.map((i) => i.title)).toEqual(['doing']);
  });

  it('filters by module membership', async () => {
    const got = await find(fakePlane(BOARD, ['both', 'doing']), pool, {
      projectId: PROJECT,
      moduleId: randomUUID(),
    });
    expect(got.items.map((i) => i.title).sort()).toEqual(['both', 'doing']);
  });

  it('filters by direct parent', async () => {
    const items = [wi('parent'), wi('kid', { parent: 'parent' }), wi('other')];
    const got = await find(fakePlane(items), pool, { projectId: PROJECT, parentId: id('parent') });
    expect(got.items.map((i) => i.title)).toEqual(['kid']);
  });

  it('answers what the fleet is holding — which no Plane view can', async () => {
    await lease.claim(pool, {
      workItemId: id('doing'),
      projectId: PROJECT,
      holder: 'agent:worker-1',
      ttlSeconds: 600,
    });
    expect((await q({ holder: 'any' })).items.map((i) => i.title)).toEqual(['doing']);
    expect((await q({ holder: 'agent:worker-1' })).items.map((i) => i.title)).toEqual(['doing']);
    expect((await q({ holder: 'agent:nobody' })).matched).toBe(0);
    expect((await q({ holder: 'none' })).matched).toBe(BOARD.length - 1);
  });

  it('does not count a lapsed lease as held', async () => {
    await lease.claim(pool, {
      workItemId: id('doing'),
      projectId: PROJECT,
      holder: 'agent:gone',
      ttlSeconds: 30,
    });
    await pool.query("update lease set expires_at = now() - interval '1 second'");
    expect((await q({ holder: 'any' })).matched).toBe(0);
  });

  it('agrees with the gate about what ready means', async () => {
    // Reuses screen() rather than restating it: an item with no description and
    // one that is already started must both be withheld, exactly as claim would.
    const got = await q({ ready: true });
    const titles = got.items.map((i) => i.title);
    expect(titles).not.toContain('no-spec');
    expect(titles).not.toContain('doing');
    expect(titles).toContain('be-ready');
  });

  it('treats a held item as not ready', async () => {
    await lease.claim(pool, {
      workItemId: id('be-ready'),
      projectId: PROJECT,
      holder: 'agent:someone',
      ttlSeconds: 600,
    });
    expect((await q({ ready: true })).items.map((i) => i.title)).not.toContain('be-ready');
  });

  it('reports the full match count when it truncates', async () => {
    // A short list must not read as a small result set.
    const got = await q({ limit: 1 });
    expect(got.items.length).toBe(1);
    expect(got.matched).toBe(BOARD.length);
  });

  it('combines filters rather than picking one', async () => {
    const got = await q({ labels: ['backend'], priority: 'high', stateGroup: 'backlog' });
    expect(got.items.map((i) => i.title)).toEqual(['be-ready']);
  });

  it('returns label names, not the uuids the caller cannot read', async () => {
    const got = await q({ labels: ['backend'], priority: 'high' });
    expect(got.items[0]?.labels).toEqual(['backend']);
  });
});
