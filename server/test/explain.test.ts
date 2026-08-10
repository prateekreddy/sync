import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { explain } from '../src/readiness.js';
import { PlaneClient } from '../src/plane.js';
import { NO_RELATIONS } from './relations.js';
import type { Label, Relations, State, WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import * as lease from '../src/lease.js';

/**
 * The gate has always computed exactly why an item is withheld and then kept only
 * the count, so "next returned nothing" was unanswerable — the top entry in both
 * troubleshooting tables. These tests pin the two properties that make the answer
 * worth trusting: it reports every reason at once, and it agrees with the gate,
 * because an explanation that can disagree sends someone off fixing the wrong
 * thing.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ITEM = randomUUID();

beforeEach(async () => {
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: ITEM,
  sequence_id: 42,
  project: PROJECT,
  name: 'Do the thing',
  description_html: '<p>Clear enough to act on.</p>',
  state: 'backlog-state',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const STATES: State[] = [
  { id: 'backlog-state', name: 'Backlog', group: 'backlog', default: true },
  { id: 'done-state', name: 'Done', group: 'completed', default: false },
];


const fakePlane = (
  items: WorkItem[],
  opts: { labels?: Label[]; relations?: Partial<Relations>; blockers?: WorkItem[] } = {},
): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labels: async () => opts.labels ?? [],
    relations: async () => ({ ...NO_RELATIONS, ...opts.relations }),
    getWorkItem: async (_p: string, id: string) =>
      opts.blockers?.find((b) => b.id === id) ?? items.find((i) => i.id === id)!,
  });

const ask = (plane: PlaneClient, capabilities?: string[]) =>
  explain(plane, pool, {
    projectId: PROJECT,
    workItemId: ITEM,
    ...(capabilities ? { capabilities } : {}),
  });

describe('explain', () => {
  it('says an ordinary ready item is claimable, with nothing to report', async () => {
    const got = await ask(fakePlane([item()]));
    expect(got).toMatchObject({ claimable: true, reasons: [] });
    expect(got.item.readableId).toBe('#42');
  });

  it('names the live holder and when the lease runs out', async () => {
    // "Someone else has it" is the most common answer and the one the item itself
    // cannot show — the lease lives here, not in Plane.
    await lease.claim(pool, {
      workItemId: ITEM,
      projectId: PROJECT,
      holder: 'agent:someone-else',
      ttlSeconds: 600,
    });
    const got = await ask(fakePlane([item()]));
    expect(got.claimable).toBe(false);
    // One spelling for a lease, the same one tree and find use.
    expect(got.item.holder).toBe('agent:someone-else');
    expect(got.item.expiresAt).toMatch(/^20/);
    expect(got.reasons.join(' ')).toContain('agent:someone-else');
  });

  it('does not report a lapsed lease as a holder', async () => {
    await lease.claim(pool, {
      workItemId: ITEM,
      projectId: PROJECT,
      holder: 'agent:gone',
      ttlSeconds: 30,
    });
    await pool.query("update lease set expires_at = now() - interval '1 second'");
    const got = await ask(fakePlane([item()]));
    expect(got.item.holder).toBeUndefined();
    expect(got.claimable).toBe(true);
  });

  it('reports a blocking label by name', async () => {
    const got = await ask(
      fakePlane([item({ labels: ['l1'] })], { labels: [{ id: 'l1', name: 'needs-human' }] }),
    );
    expect(got.reasons.join(' ')).toContain('needs-human');
  });

  it('names the unfinished blocker rather than just saying blocked', async () => {
    const blocker = item({ id: 'blk', sequence_id: 7, state: 'backlog-state' });
    const got = await ask(
      fakePlane([item()], {
        relations: { blocked_by: [{ project_id: PROJECT, issue_id: 'blk' }] },
        blockers: [blocker],
      }),
    );
    expect(got.reasons.join(' ')).toContain('#7');
  });

  it('stays silent about a blocker that is already finished', async () => {
    const done = item({ id: 'blk', sequence_id: 7, state: 'done-state' });
    const got = await ask(
      fakePlane([item()], {
        relations: { blocked_by: [{ project_id: PROJECT, issue_id: 'blk' }] },
        blockers: [done],
      }),
    );
    expect(got.claimable).toBe(true);
  });

  it('explains a capability mismatch, which otherwise looks like an empty queue', async () => {
    const got = await ask(
      fakePlane([item({ labels: ['l1'] })], { labels: [{ id: 'l1', name: 'frontend' }] }),
      ['backend'],
    );
    expect(got.reasons.join(' ')).toContain('capabilities');
    expect(got.reasons.join(' ')).toContain('frontend');
  });

  it('says nothing about capabilities when the item does match', async () => {
    const got = await ask(
      fakePlane([item({ labels: ['l1'] })], { labels: [{ id: 'l1', name: 'backend' }] }),
      ['backend'],
    );
    expect(got.claimable).toBe(true);
  });

  it('reports every reason at once, so one pass fixes the item', async () => {
    const got = await ask(
      fakePlane([item({ description_html: '', is_draft: true, labels: ['l1'] })], {
        labels: [{ id: 'l1', name: 'blocked' }],
      }),
    );
    expect(got.reasons.length).toBe(3);
    expect(got.claimable).toBe(false);
  });

  it('counts unfinished children, which is why a parent is withheld', async () => {
    const child = item({ id: 'c1', sequence_id: 43, parent: ITEM, state: 'backlog-state' });
    const got = await ask(fakePlane([item(), child]));
    expect(got.reasons.join(' ')).toContain('1 unfinished sub-item');
  });

  it('refuses an item that is not in this project', async () => {
    await expect(ask(fakePlane([]))).rejects.toThrow(GatewayError);
  });
});
