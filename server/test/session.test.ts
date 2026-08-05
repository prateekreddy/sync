import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { forgetAccess } from '../src/access.js';
import { PlaneClient } from '../src/plane.js';
import type { State, WorkItem } from '../src/plane.js';
import { registerRoutes, sessionOf } from '../src/routes.js';
import { NO_RELATIONS } from './relations.js';

/**
 * Which session a request belongs to, and where that fact comes from.
 *
 * It arrives on a header the plugin fills from `${CLAUDE_CODE_SESSION_ID}`, which
 * the client substitutes when it connects -- so the model is never asked for it,
 * never sees it, and cannot forget or invent it.
 *
 * The reason to test the wiring and not just the helper: the recurring defect in
 * this codebase is a mechanism that exists, is documented as working, and is
 * called by nothing. This field had exactly that shape -- the tool description
 * said the plugin sent it automatically while the plugin sent nothing at all, so
 * every lease was session-less and every protection built on sessions was inert.
 * The useful question is "who calls it?", so these drive the real router.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ME = randomUUID();
const ITEM = randomUUID();

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];

const item = (): WorkItem => ({
  id: ITEM,
  sequence_id: 1,
  project: PROJECT,
  name: 'something to claim',
  description_html: '<p>enough to act on</p>',
  state: 'backlog',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

function fakePlane(): PlaneClient {
  const items = [item()];
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'P', name: 'Project' }],
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id),
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[0],
    updateWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id)!,
    comment: async () => ({}),
    search: async () => [],
  }) as unknown as PlaneClient;
  return plane;
}

async function harness() {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(),
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: null,
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.ready();

  process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
  const { token } = await issueToken(pool, {
    name: `t-ses-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: ME,
  });

  const claim = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    });

  return { app, claim };
}

const sessionInDb = async (workItemId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ session_id: string | null }>(
    'select session_id from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]?.session_id ?? null;
};

beforeEach(async () => {
  forgetAccess();
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-ses-%/worker'");
  await pool.query('truncate lease');
  await pool.end();
});

describe('reading the session off a request', () => {
  const req = (headers: Record<string, unknown>) => ({ headers }) as never;

  it('takes it from the header the plugin sets', () => {
    expect(sessionOf(req({ 'x-sync-session': 'abc-123' }))).toBe('abc-123');
  });

  it('prefers the header over anything the model typed', () => {
    // The header is the harness speaking; the body is the model guessing at its
    // own identity. When they disagree the harness is right.
    expect(sessionOf(req({ 'x-sync-session': 'real' }), { sessionId: 'made-up' })).toBe('real');
  });

  it('falls back to the body for a client that cannot set headers', () => {
    expect(sessionOf(req({}), { sessionId: 'from-body' })).toBe('from-body');
  });

  it('reports no session rather than an empty one', () => {
    expect(sessionOf(req({}))).toBeNull();
    expect(sessionOf(req({ 'x-sync-session': '   ' }))).toBeNull();
  });

  it('ignores a variable the client never substituted', () => {
    // The dangerous case. A client that failed to expand it would send one
    // identical literal from every window on every machine, collapsing every
    // agent everywhere into a single session -- so retries would match across
    // unrelated agents and hand one of them the other's lease. Worse than none.
    expect(sessionOf(req({ 'x-sync-session': '${CLAUDE_CODE_SESSION_ID}' }))).toBeNull();
  });

  it('still refuses the literal when a body value could paper over it', () => {
    expect(
      sessionOf(req({ 'x-sync-session': '${CLAUDE_CODE_SESSION_ID}' }), { sessionId: 'b' }),
    ).toBe('b');
  });

  it('bounds the length, since it reaches a text column', () => {
    expect(sessionOf(req({ 'x-sync-session': 'x'.repeat(500) }))!.length).toBe(200);
  });

  it('takes the first value when a proxy duplicates the header', () => {
    expect(sessionOf(req({ 'x-sync-session': ['first', 'second'] }))).toBe('first');
  });
});

describe('the session reaches the lease', () => {
  it('records what the header said, without the model mentioning it', async () => {
    const { app, claim } = await harness();
    const res = await claim(
      { projectId: PROJECT, workItemId: ITEM },
      { 'x-sync-session': 'session-from-harness' },
    );

    expect(res.statusCode).toBe(200);
    expect(await sessionInDb(ITEM)).toBe('session-from-harness');
    await app.close();
  });

  it('makes a re-sent claim succeed instead of reporting a conflict', async () => {
    // End to end, this is the payoff: the client's connection drops, it re-issues
    // the request, and the gateway agrees the work is already theirs.
    const { app, claim } = await harness();
    const headers = { 'x-sync-session': 'session-retrying' };

    const first = await claim({ projectId: PROJECT, workItemId: ITEM }, headers);
    const again = await claim({ projectId: PROJECT, workItemId: ITEM }, headers);

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json().lease.epoch).toBe(first.json().lease.epoch);
    await app.close();
  });

  it('still refuses a different window belonging to the same person', async () => {
    // The near-miss that makes the header worth having: same token, same holder,
    // different session. Without the header both windows look identical.
    const { app, claim } = await harness();
    const mine = await claim({ projectId: PROJECT, workItemId: ITEM }, { 'x-sync-session': 'w-1' });
    const other = await claim({ projectId: PROJECT, workItemId: ITEM }, { 'x-sync-session': 'w-2' });

    expect(mine.statusCode).toBe(200);
    expect(other.statusCode).toBe(HTTP_CONFLICT);
    await app.close();
  });

  it('works for a client that sends no session at all', async () => {
    // Degraded, never wrong: the claim still succeeds, it just cannot be told
    // apart from another window later.
    const { app, claim } = await harness();
    const res = await claim({ projectId: PROJECT, workItemId: ITEM });

    expect(res.statusCode).toBe(200);
    expect(await sessionInDb(ITEM)).toBeNull();
    await app.close();
  });

  it('hands back a watch URL for the hook to store', async () => {
    // The credential has to arrive with the claim, because `claim` is the one
    // call an agent reliably makes.
    const { app, claim } = await harness();
    const res = await claim({ projectId: PROJECT, workItemId: ITEM }, { 'x-sync-session': 'w-1' });

    expect(res.json().watchUrl).toMatch(/\/v1\/watch\/.+/);
    await app.close();
  });
});

/** What the router answers when someone else holds the item. */
const HTTP_CONFLICT = 409;
