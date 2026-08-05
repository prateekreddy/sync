import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { viewContext, viewOf, parseFields, type WorkItemView } from '../src/view.js';
import { readyCandidates, explain } from '../src/readiness.js';
import { find } from '../src/find.js';
import { tree } from '../src/tree.js';
import { PlaneClient } from '../src/plane.js';
import { NO_RELATIONS } from './relations.js';
import type { Label, Relations, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';

/**
 * Five read tools used to hand-build five shapes for one work item, and two of
 * them disagreed: `next` returned label uuids where `find` returned label names.
 * Same field, different content, in tools an agent uses interchangeably — the
 * label bug of 3f7a891 reintroduced a layer up, because resolution lived at each
 * call site instead of in one primitive.
 *
 * The point of these tests is not that today's shapes happen to match. It is that
 * a future tool cannot diverge without failing here.
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

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];
const LABELS: Label[] = [{ id: 'l-be', name: 'backend' }];

let seq = 0;
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: id(key),
  sequence_id: ++seq,
  name: key,
  description_html: '<p>spec</p>',
  state: 'backlog',
  priority: 'medium',
  labels: ['l-be'],
  parent: null,
  is_draft: false,
  assignees: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
  ...(over.parent ? { parent: id(over.parent) } : {}),
});

const fakePlane = (items: WorkItem[]): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labels: async () => LABELS,
    relations: async () => NO_RELATIONS,
    getWorkItem: async (_p: string, i: string) => items.find((x) => x.id === i)!,
  });

describe('every read tool returns the same shape', () => {
  const items = [wi('root'), wi('child', { parent: 'root' })];

  it('agrees on what `labels` contains — names, in all of them', async () => {
    // This is the regression that motivated the whole change. `next` used to
    // return uuids here, so an agent matching capability names got nothing.
    const plane = fakePlane(items);
    const fromNext = await readyCandidates(plane, pool, { projectId: PROJECT, limit: 10 });
    const fromFind = await find(plane, pool, { projectId: PROJECT });
    const fromTree = await tree(plane, pool, { projectId: PROJECT, workItemId: id('root') });
    const fromWhy = await explain(plane, pool, {
      projectId: PROJECT,
      workItemId: id('child'),
    });

    expect(fromNext[0]?.labels).toEqual(['backend']);
    expect(fromFind.items[0]?.labels).toEqual(['backend']);
    expect(fromTree.node.labels).toEqual(['backend']);
    expect(fromWhy.item.labels).toEqual(['backend']);
  });

  it('spells the readable id the way Plane does, in every tool', async () => {
    // Two spellings used to be in circulation with no rule about which: `find`
    // and capture's dedup branch said `SYNC-42`, while `board`, `tree`, `next`
    // and capture's create branch said `#42`. An agent quoting the second to a
    // human quoted a number that means nothing outside the project.
    const plane = Object.assign(fakePlane(items), { identifierFor: () => 'SYNC' });

    const fromNext = await readyCandidates(plane, pool, { projectId: PROJECT, limit: 10 });
    const fromFind = await find(plane, pool, { projectId: PROJECT });
    const fromTree = await tree(plane, pool, { projectId: PROJECT, workItemId: id('child') });
    const fromWhy = await explain(plane, pool, { projectId: PROJECT, workItemId: id('root') });

    for (const readable of [
      fromNext[0]?.readableId,
      fromFind.items[0]?.readableId,
      fromTree.node.readableId,
      fromTree.path[0]?.readableId,
      fromWhy.item.readableId,
    ]) {
      expect(readable).toMatch(/^SYNC-\d+$/);
    }
  });

  it('still answers with a number a human can find when the identifier is unknown', async () => {
    // The display path is not allowed to fetch — putting a request in front of
    // every read to prettify a string cost 85 seconds on one test file. So an
    // unknown identifier degrades to `#42`, which is ambiguous across projects
    // but still findable, rather than blocking on a lookup.
    const fromFind = await find(fakePlane(items), pool, { projectId: PROJECT });
    expect(fromFind.items[0]?.readableId).toMatch(/^#\d+$/);
  });

  it('agrees on the key set, so an agent learns one shape', async () => {
    const plane = fakePlane(items);
    const keys = (v: WorkItemView) => Object.keys(v).filter((k) => k !== 'children').sort();

    const fromFind = (await find(plane, pool, { projectId: PROJECT })).items[0]!;
    const fromTree = (await tree(plane, pool, { projectId: PROJECT, workItemId: id('root') })).node;
    const fromWhy = (await explain(plane, pool, { projectId: PROJECT, workItemId: id('root') }))
      .item;

    expect(keys(fromTree)).toEqual(keys(fromWhy));
    // find returns a leaf, tree's root has a parentId difference only.
    expect(keys(fromFind)).toEqual(expect.arrayContaining(['labels', 'state', 'priority', 'title']));
  });

  it('spells a lease the same way everywhere', async () => {
    // `tree` said `expiresAt`, `why` said `heldBy.expiresAt`. One datum, two
    // spellings, so anything reading both had to handle both.
    await lease.claim(pool, {
      workItemId: id('root'),
      projectId: PROJECT,
      holder: 'agent:w1',
      ttlSeconds: 600,
    });
    const plane = fakePlane(items);
    const fromTree = (await tree(plane, pool, { projectId: PROJECT, workItemId: id('root') })).node;
    const fromWhy = (await explain(plane, pool, { projectId: PROJECT, workItemId: id('root') }))
      .item;
    const fromFind = (await find(plane, pool, { projectId: PROJECT, holder: 'any' })).items[0]!;

    for (const v of [fromTree, fromWhy, fromFind]) {
      expect(v.holder).toBe('agent:w1');
      expect(v.expiresAt).toMatch(/^20/);
    }
  });

  it('resolves state to a name, never a uuid', async () => {
    const plane = fakePlane(items);
    const v = (await find(plane, pool, { projectId: PROJECT })).items[0]!;
    expect(v.state).toBe('Backlog');
  });
});

describe('field selection on the view', () => {
  const ctx = async () => viewContext(fakePlane([]), pool, PROJECT, ['title', 'state']);

  it('returns only the named keys', async () => {
    const v = viewOf(wi('a'), await ctx());
    expect(Object.keys(v).sort()).toEqual(['state', 'title', 'workItemId']);
  });

  it('always keeps workItemId, because a row you cannot address is not a result', async () => {
    const c = await viewContext(fakePlane([]), pool, PROJECT, ['title']);
    expect(viewOf(wi('a'), c).workItemId).toBeTruthy();
  });

  it('falls back to the full view when nothing is named', async () => {
    const c = await viewContext(fakePlane([]), pool, PROJECT, []);
    expect(Object.keys(viewOf(wi('a'), c))).toContain('labels');
  });

  it('parses the shared query parameter, ignoring padding and blanks', () => {
    expect(parseFields(' title , state ,, ')).toEqual(['title', 'state']);
    expect(parseFields(undefined)).toBeUndefined();
  });
});
