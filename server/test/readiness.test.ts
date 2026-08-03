import { afterAll, describe, expect, it } from 'vitest';
import { readyCandidates, screen } from '../src/readiness.js';
import { PlaneClient } from '../src/plane.js';
import { NO_RELATIONS } from './relations.js';
import type { Label, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';

/**
 * The cheap half of the readiness gate is a pure function, so it belongs in a unit
 * test rather than being inferred from counts in an end-to-end run.
 *
 * What it protects: an agent that claims an underspecified item burns tokens and
 * produces plausible garbage a human then has to review — worse than the item
 * sitting untouched.
 */
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'i',
  sequence_id: 1,
  project: 'p',
  name: 'Do the thing',
  description_html: '<p>Clear enough to act on.</p>',
  state: 's',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const labels = new Map<string, string>();

describe('readiness screen', () => {
  it('passes a well-formed unstarted item', () => {
    expect(screen(item(), 'unstarted', labels)).toEqual([]);
    expect(screen(item(), 'backlog', labels)).toEqual([]);
  });

  it('withholds items with no description', () => {
    expect(screen(item({ description_html: '' }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('no description'),
    );
  });

  it('treats markup-only descriptions as empty', () => {
    // An empty rich-text field round-trips as '<p></p>', which is not a spec.
    expect(screen(item({ description_html: '<p></p>' }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('no description'),
    );
  });

  it('withholds drafts', () => {
    expect(screen(item({ is_draft: true }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('draft'),
    );
  });

  it('withholds work already started, finished or cancelled', () => {
    for (const g of ['started', 'completed', 'cancelled']) {
      expect(screen(item(), g, labels).length).toBeGreaterThan(0);
    }
  });

  it('withholds items a human has flagged', () => {
    const m = new Map([['l1', 'needs-human']]);
    expect(screen(item({ labels: ['l1'] }), 'unstarted', m)).toContainEqual(
      expect.stringContaining('needs-human'),
    );
  });

  it('withholds a parent that still has unfinished sub-items', () => {
    // The work lives in the children. Handing the parent to a second agent
    // duplicates effort that no lease can detect, because the two agents are
    // holding different items.
    expect(screen(item(), 'unstarted', labels, 2)).toContainEqual(
      expect.stringContaining('2 unfinished sub-items'),
    );
    expect(screen(item(), 'unstarted', labels, 1)).toContainEqual(
      expect.stringContaining('1 unfinished sub-item'),
    );
  });

  it('releases the parent once every sub-item is done', () => {
    expect(screen(item(), 'unstarted', labels, 0)).toEqual([]);
  });

  it('reports every reason, not just the first', () => {
    // The item surfaces in Plane with all of its problems, so a human can fix them
    // in one pass rather than discovering them one at a time.
    const m = new Map([['l1', 'blocked']]);
    const reasons = screen(
      item({ description_html: '', is_draft: true, labels: ['l1'] }),
      'completed',
      m,
    );
    expect(reasons.length).toBe(4);
  });
});

/**
 * The screen above is pure and was always correct. What shipped broken for
 * months was the wiring that feeds it: `readyCandidates` passed an empty id->name
 * map, so every label check compared a human's word against a uuid and matched
 * nothing. Testing `screen()` alone cannot see that, which is exactly why it went
 * unnoticed — so these tests drive the real entry point instead.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

afterAll(async () => {
  await pool.end();
});

/** A PlaneClient with only its HTTP surface stubbed — `labelNames()` stays real. */
const fakePlane = (items: WorkItem[], labels: Label[] = []): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'key', 'ws'), {
    listWorkItems: async () => items,
    states: async (): Promise<State[]> => [
      { id: 's', name: 'Backlog', group: 'backlog', default: true },
    ],
    labels: async () => labels,
    // Since SYNC-65 the gate resolves blockers on the browse path too, so an
    // unstubbed fake reaches for the network. Blocker behaviour itself is
    // covered in blockers.test.ts.
    relations: async () => NO_RELATIONS,
  });

describe('readyCandidates', () => {
  const ready = (over: Partial<WorkItem> = {}) => item({ id: `i-${over.labels?.[0] ?? 'x'}`, ...over });

  it('withholds an item a human flagged, resolving the label id to its name', async () => {
    const got = await readyCandidates(
      fakePlane([ready({ labels: ['lbl-uuid-1'] })], [{ id: 'lbl-uuid-1', name: 'needs-human' }]),
      pool,
      { projectId: 'p' },
    );
    expect(got).toEqual([]);
  });

  it('matches the label name whatever case a human typed it in', async () => {
    const got = await readyCandidates(
      fakePlane([ready({ labels: ['l'] })], [{ id: 'l', name: 'Needs-Refinement' }]),
      pool,
      { projectId: 'p' },
    );
    expect(got).toEqual([]);
  });

  it('leaves an item carrying only ordinary labels claimable', async () => {
    const got = await readyCandidates(
      fakePlane([ready({ labels: ['l'] })], [{ id: 'l', name: 'backend' }]),
      pool,
      { projectId: 'p' },
    );
    expect(got.map((c) => c.title)).toEqual(['Do the thing']);
  });

  it('routes by capability against label names, not label ids', async () => {
    // The bug here was worse than a missing filter: comparing a capability to a
    // uuid matched nothing, so a token minted WITH capabilities got no work at
    // all while a token with none worked fine.
    const items = [
      ready({ id: 'a', labels: ['l-be'] }),
      ready({ id: 'b', labels: ['l-fe'] }),
    ];
    const labels = [
      { id: 'l-be', name: 'backend' },
      { id: 'l-fe', name: 'frontend' },
    ];
    const got = await readyCandidates(fakePlane(items, labels), pool, {
      projectId: 'p',
      capabilities: ['backend'],
    });
    expect(got.map((c) => c.workItemId)).toEqual(['a']);
  });

  it('survives a label id it cannot resolve rather than throwing', async () => {
    // A label created between the cache fill and this read resolves to nothing.
    // Falling back to the id means it matches no blocking label and no
    // capability — it must not crash the browse for everyone else.
    const got = await readyCandidates(fakePlane([ready({ labels: ['unknown'] })], []), pool, {
      projectId: 'p',
    });
    expect(got.map((c) => c.title)).toEqual(['Do the thing']);
  });
});
