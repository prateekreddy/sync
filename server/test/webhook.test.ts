import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { corroborate } from '../src/attest.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';
import { PlaneClient, type Label, type State, type WorkItem } from '../src/plane.js';
import { handleDelivery } from '../src/webhook.js';

/**
 * This is the only path that can change a work item with no agent involved, so
 * the tests worth having are the ones about *not* acting: a mention that is not a
 * closing reference, a reference to something that is not a project, an item
 * somebody is holding.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ITEM = randomUUID();

const STATES: State[] = [
  { id: 'todo', name: 'Todo', group: 'unstarted', default: true },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];
const LABELS: Label[] = [
  { id: 'lbl-unverified', name: 'unverified', color: '#000' },
  { id: 'lbl-keep', name: 'keepme', color: '#000' },
];

interface Recorder {
  patches: Array<Record<string, unknown>>;
  comments: string[];
}

function fakePlane(item: Partial<WorkItem> = {}): PlaneClient & { rec: Recorder } {
  const rec: Recorder = { patches: [], comments: [] };
  const workItem: WorkItem = {
    id: ITEM,
    sequence_id: 42,
    project: PROJECT,
    name: 'the item',
    description_html: '<p>spec</p>',
    state: 'todo',
    priority: 'medium',
    labels: [],
    parent: null,
    is_draft: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...item,
  };
  const client = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    rec,
    projects: async () => [{ id: PROJECT, identifier: 'SYNC', name: 'Sync' }],
    byReadableId: async (id: string) => {
      if (id !== 'SYNC-42') throw new Error('not found');
      return workItem;
    },
    getWorkItem: async () => workItem,
    states: async () => STATES,
    labels: async () => LABELS,
    stateGroupOf: async (_p: string, s: string) => STATES.find((x) => x.id === s)?.group,
    stateByGroup: async (_p: string, g: string) => STATES.find((x) => x.group === g),
    updateWorkItem: async (_p: string, _i: string, body: Record<string, unknown>) => {
      rec.patches.push(body);
      // Applied, not just recorded: a redelivery must see the state the first
      // delivery left behind, or the test cannot tell "idempotent" from
      // "happened to run once".
      Object.assign(workItem, body);
      return workItem;
    },
    comment: async (_p: string, _i: string, html: string) => {
      rec.comments.push(html);
      return {};
    },
  });
  return client as PlaneClient & { rec: Recorder };
}

const mergedPr = (text: string) => ({
  action: 'closed',
  repository: { full_name: 'acme/app', default_branch: 'main' },
  pull_request: {
    merged: true,
    html_url: 'https://github.com/acme/app/pull/7',
    title: text,
    body: '',
    number: 7,
    merge_commit_sha: '3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4',
    merged_by: { login: 'octo' },
  },
});

beforeEach(async () => {
  await pool.query('truncate attestation');
  await pool.query('truncate lease');
});
afterAll(async () => {
  await pool.query('truncate attestation');
  await pool.query('truncate lease');
  await pool.end();
});

describe('a merged pull request', () => {
  it('closes an item it says it fixes, citing what landed', async () => {
    const plane = fakePlane();
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Fixes SYNC-42'),
    );

    expect(out.refs).toEqual([{ readableId: 'SYNC-42', workItemId: ITEM, action: 'closed' }]);
    expect(plane.rec.patches).toEqual([{ state: 'done' }]);
    expect(plane.rec.comments[0]).toContain('acme/app#7 merged');
    // And the evidence is on record, so the item can be audited later.
    expect((await corroborate(pool, ITEM)).observed).toHaveLength(2);
  });

  it('does not close an item it merely mentions', async () => {
    // The difference between "touches" and "finishes", and the reason a bare
    // cross-reference cannot silently close somebody's work.
    const plane = fakePlane();
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Groundwork for SYNC-42'),
    );

    expect(out.refs[0]?.action).toBe('mentioned');
    expect(plane.rec.patches).toEqual([]);
    expect(plane.rec.comments).toEqual([]);
    // Evidence is still recorded — it just does not decide anything.
    expect((await corroborate(pool, ITEM)).observed.length).toBeGreaterThan(0);
  });

  it('leaves an item alone while an agent holds it', async () => {
    await lease.claim(pool, {
      workItemId: ITEM,
      projectId: PROJECT,
      holder: 'agent:w1',
      ttlSeconds: 600,
    });
    const plane = fakePlane();
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Fixes SYNC-42'),
    );

    expect(out.refs[0]?.action).toBe('held');
    expect(plane.rec.patches).toEqual([]);
    expect(plane.rec.comments[0]).toContain('agent:w1');
  });

  it('ignores a reference to something that is not a project', async () => {
    // `UTF-8` has exactly the shape of a reference. Only the project list can
    // tell it apart from one.
    const plane = fakePlane();
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Fixes UTF-8 handling'),
    );
    expect(out.refs).toEqual([{ readableId: 'UTF-8', action: 'no-such-item' }]);
    expect(plane.rec.patches).toEqual([]);
  });

  it('respects autoClose being off', async () => {
    const plane = fakePlane();
    const out = await handleDelivery(
      { pool, plane, autoClose: false },
      'pull_request',
      mergedPr('Fixes SYNC-42'),
    );
    expect(out.refs[0]?.action).toBe('autoclose-disabled');
    expect(plane.rec.patches).toEqual([]);
  });
});

describe('an item that was already completed', () => {
  it('lifts the unverified label when a merge says it fixed this', async () => {
    // The real shape of this case, and the one an earlier draft got wrong: an
    // item is labelled `unverified` precisely because the completion cited
    // *nothing*, so there is no agent claim for a merge to match. What lifts it
    // is external and item-level — a merged change saying `Fixes SYNC-42`.
    const plane = fakePlane({ state: 'done', labels: ['lbl-unverified', 'lbl-keep'] });
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Fixes SYNC-42'),
    );

    expect(out.refs[0]?.action).toBe('verified');
    // Read-modify-write: Plane's `labels` is a replacement, so the unrelated
    // label must survive having one removed.
    expect(plane.rec.patches).toEqual([{ labels: ['lbl-keep'] }]);
    expect(plane.rec.comments[0]).toContain('Evidence confirmed');
  });

  it('confirms a completion whose cited pull request has now merged', async () => {
    // The other ordering: the agent cited PR 7 at completion, and it merges
    // afterwards. No label was ever set — citing a URL is not "cited nothing" —
    // so the visible outcome is the confirmation itself.
    await pool.query(
      `insert into attestation (work_item_id, project_id, source, kind, value, match_key, actor)
       values ($1, $2, 'agent', 'url', 'https://github.com/acme/app/pull/7', 'pr:acme/app#7', 'agent:w1')`,
      [ITEM, PROJECT],
    );

    const plane = fakePlane({ state: 'done' });
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      // A mention, not a closing keyword: the confirmation comes from the
      // artefact matching, not from the wording.
      mergedPr('Part of SYNC-42'),
    );

    expect(out.refs[0]?.action).toBe('verified');
    expect((await corroborate(pool, ITEM)).claimed[0]).toMatchObject({ confirmed: true });
    expect(plane.rec.patches).toEqual([]);
    expect(plane.rec.comments[0]).toContain('Evidence confirmed');
  });

  it('does not reopen or re-comment on a completed item it merely mentions', async () => {
    const plane = fakePlane({ state: 'done' });
    const out = await handleDelivery(
      { pool, plane, autoClose: true },
      'pull_request',
      mergedPr('Follow-up to SYNC-42'),
    );
    expect(out.refs[0]?.action).toBe('recorded');
    expect(plane.rec.patches).toEqual([]);
    expect(plane.rec.comments).toEqual([]);
  });

  it('says nothing twice when GitHub redelivers', async () => {
    const plane = fakePlane({ state: 'done', labels: ['lbl-unverified'] });
    const deps = { pool, plane, autoClose: true };

    const first = await handleDelivery(deps, 'pull_request', mergedPr('Fixes SYNC-42'));
    expect(first.refs[0]?.action).toBe('verified');
    expect(plane.rec.comments).toHaveLength(1);

    const second = await handleDelivery(deps, 'pull_request', mergedPr('Fixes SYNC-42'));
    expect(second.refs[0]?.action).toBe('recorded');
    // Nothing said twice, and nothing written twice.
    expect(plane.rec.comments).toHaveLength(1);
    expect(plane.rec.patches).toHaveLength(1);
    expect((await corroborate(pool, ITEM)).observed).toHaveLength(2);
  });
});
