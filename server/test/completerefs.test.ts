import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { forgetAccess } from '../src/access.js';
import { PlaneClient } from '../src/plane.js';
import type { State, WorkItem } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { callTool } from '../src/tools.js';
import { authenticate } from '../src/auth.js';
import { NO_RELATIONS } from './relations.js';

/**
 * `refs` through the real route, not through linkReferences alone.
 *
 * Since SYNC-106 this is the only way a completion can create a relation, and
 * relations are what `claim` builds its briefing from — so if refs silently stop
 * working, edges quietly stop being made and nothing says so.
 *
 * The unit tests for linkReferences all pass, which is exactly why these exist:
 * whatever happens to refs happens between the tool call and that function.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ME = randomUUID();

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

let related: Array<{ from: string; to: string[] }> = [];

const item = (id: string, sequence: number): WorkItem => ({
  id,
  sequence_id: sequence,
  project: PROJECT,
  name: `item ${sequence}`,
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

async function harness(items: WorkItem[]) {
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'SYNC', name: 'Project' }],
    projectIdentifier: async () => 'SYNC',
    identifierFor: () => 'SYNC',
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id),
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[2],
    updateWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id)!,
    comment: async () => ({}),
    search: async () => [],
    relate: async (_p: string, from: string, _kind: string, to: string[]) => {
      related.push({ from, to });
      return {};
    },
  }) as unknown as PlaneClient;

  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane,
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
    name: `t-cr-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: ME,
  });
  const auth = { authorization: `Bearer ${token}`, 'x-sync-session': 's-refs' };

  return {
    app,
    token,
    plane,
    /** The same call an agent actually makes: through the MCP tool layer. */
    viaTool: async (name: string, args: Record<string, unknown>) => {
      const actor = await authenticate(pool, `Bearer ${token}`);
      return callTool(
        { app, pool, plane: null, rest: plane },
        actor,
        `Bearer ${token}`,
        name,
        args,
      );
    },
    claim: (workItemId: string) =>
      app.inject({ method: 'POST', url: '/v1/claim', headers: auth, body: { projectId: PROJECT, workItemId } }),
    complete: (body: unknown) =>
      app.inject({ method: 'POST', url: '/v1/complete', headers: auth, body }),
  };
}

beforeEach(async () => {
  forgetAccess();
  related = [];
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

describe('completing with refs', () => {
  it('turns a declared ref into a relation', async () => {
    const mine = randomUUID();
    const target = randomUUID();
    const h = await harness([item(mine, 1), item(target, 42)]);
    const lease = (await h.claim(mine)).json();

    const res = await h.complete({
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'Done. Nothing named in this sentence at all.',
      refs: ['SYNC-42'],
    });

    const body = res.json();
    expect(body.references).toEqual([
      { readableId: 'SYNC-42', workItemId: target, linked: true },
    ]);
    expect(related).toEqual([{ from: mine, to: [target] }]);
    await h.app.close();
  });

  it('does not make an edge from a name in the prose', async () => {
    const mine = randomUUID();
    const target = randomUUID();
    const h = await harness([item(mine, 1), item(target, 42)]);
    const lease = (await h.claim(mine)).json();

    const res = await h.complete({
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'Measured against SYNC-42, which is data rather than a relation.',
    });

    expect(related).toEqual([]);
    expect(res.json().references[0]).toMatchObject({ readableId: 'SYNC-42', linked: false });
    await h.app.close();
  });

  it('links a ref the prose also happens to name, without complaining about it', async () => {
    const mine = randomUUID();
    const target = randomUUID();
    const h = await harness([item(mine, 1), item(target, 42)]);
    const lease = (await h.claim(mine)).json();

    const res = await h.complete({
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'Supersedes SYNC-42.',
      refs: ['SYNC-42'],
    });

    expect(res.json().references).toEqual([
      { readableId: 'SYNC-42', workItemId: target, linked: true },
    ]);
    expect(related).toEqual([{ from: mine, to: [target] }]);
    await h.app.close();
  });
});

/**
 * The same completion, through the MCP tool layer an agent actually uses.
 *
 * The REST tests above pass and the linkReferences unit tests pass, so if refs
 * go missing in production they go missing between the two — which is precisely
 * the gap that let this reach a live board.
 */
describe('completing with refs through the tool surface', () => {
  it('creates the relation, exactly as the REST route does', async () => {
    const mine = randomUUID();
    const target = randomUUID();
    const h = await harness([item(mine, 1), item(target, 42)]);
    const lease = (await h.claim(mine)).json();

    const out = await h.viaTool('complete', {
      projectId: PROJECT,
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'Done. Nothing named in this sentence at all.',
      refs: ['SYNC-42'],
    });

    const body = JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text);
    expect(body.references).toEqual([
      { readableId: 'SYNC-42', workItemId: target, linked: true },
    ]);
    expect(related).toEqual([{ from: mine, to: [target] }]);
    await h.app.close();
  });
});

/**
 * What a completion says about the item it is completing.
 *
 * Reported from the other box in the two-box run: completing SYNCE2E-2 came back
 * advising that SYNCE2E-2 be passed in refs. Every thorough outcome names its own
 * item, and a self-edge is the one relation that can never be wanted — so this is
 * pure noise on exactly the completions that took the most care.
 */
describe('an outcome that names its own item', () => {
  it('does not advise linking the item to itself', async () => {
    const mine = randomUUID();
    const h = await harness([item(mine, 7)]);
    const lease = (await h.claim(mine)).json();

    const res = await h.complete({
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'SYNC-7 is done. Fixed exactly as SYNC-7 described.',
    });

    // Absent rather than empty: the reply carries `references` only when it has
    // something to say, so a completion that named only itself reads clean.
    expect(res.json().references).toBeUndefined();
    await h.app.close();
  });

  it('still reports a different item named in the prose', async () => {
    const mine = randomUUID();
    const other = randomUUID();
    const h = await harness([item(mine, 7), item(other, 8)]);
    const lease = (await h.claim(mine)).json();

    const res = await h.complete({
      workItemId: mine,
      epoch: lease.lease.epoch,
      outcome: 'SYNC-7 is done. It supersedes SYNC-8.',
    });

    expect(res.json().references).toEqual([
      {
        readableId: 'SYNC-8',
        linked: false,
        reason: 'named in the outcome, which does not create a relation — pass it in refs if it is one',
      },
    ]);
    await h.app.close();
  });
});
