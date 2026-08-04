import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { forgetAccess } from '../src/access.js';
import { PlaneClient } from '../src/plane.js';
import type { State, WorkItem } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { NO_RELATIONS } from './relations.js';

/**
 * SYNC-64: an agent could read any project in the workspace by naming its id.
 *
 * `find`, `tree`, `board`, `next`, `why` and `history` called the gateway's own
 * service account, which can see everything, so a caller that passed some other
 * project id got that project's items, titles, descriptions and lease state back.
 * `search` was the one exception and its comment gave the reasoning — which had
 * simply not been applied to the others.
 *
 * Decision recorded in architecture.md: agent tokens are scoped to what their own
 * Plane user can see. Minting only ever reduces privilege, and reads bypassing
 * that made the reduction cosmetic.
 *
 * These tests drive the real router, because the defect was never in a function —
 * every one of those tools did exactly what it said. It was in which client the
 * route handed them, which is only visible from outside.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const MINE = randomUUID();
const THEIRS = randomUUID();
const ITEM = randomUUID();

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];

const wi = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: ITEM,
  sequence_id: 1,
  project: THEIRS,
  name: 'a secret roadmap item',
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
});

let listCalls = 0;

/** A workspace with two projects, of which this caller is a member of one. */
function fakePlane(visible: string[] = [MINE]): PlaneClient {
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => {
      listCalls++;
      return visible.map((id) => ({ id, identifier: 'P', name: `project ${id.slice(0, 4)}` }));
    },
    listWorkItems: async () => [wi()],
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    getWorkItem: async () => wi(),
  }) as unknown as PlaneClient;
  return plane;
}

async function harness(visible: string[] = [MINE]) {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(visible),
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
  const name = `t-acc-${randomUUID().slice(0, 8)}/worker`;
  const { token } = await issueToken(pool, {
    name,
    principal: 'human:t@example.com',
    planeToken: 'plane_pat_test',
  });

  const get = (path: string) =>
    app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });

  return { app, get, token };
}

beforeEach(() => {
  forgetAccess();
  listCalls = 0;
});

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-acc-%/worker'");
  await pool.query('truncate lease');
  await pool.end();
});

/** Every project-scoped read. The point is that none of them is the exception. */
const READS = [
  ['find', (p: string) => `/v1/find?projectId=${p}`],
  ['next', (p: string) => `/v1/next?projectId=${p}`],
  ['board', (p: string) => `/v1/board?projectId=${p}`],
  ['tree', (p: string) => `/v1/tree?projectId=${p}&workItemId=${ITEM}`],
  ['why', (p: string) => `/v1/why?projectId=${p}&workItemId=${ITEM}`],
  ['history', (p: string) => `/v1/history?projectId=${p}&workItemId=${ITEM}`],
] as const;

describe('a project the caller is not a member of', () => {
  for (const [tool, url] of READS) {
    it(`${tool} refuses it`, async () => {
      const { get, app } = await harness();
      const res = await get(url(THEIRS));
      expect(res.statusCode).toBe(403);
      // And says nothing about the project it refused.
      expect(res.body).not.toContain('a secret roadmap item');
      await app.close();
    });
  }

  it('names the projects the caller CAN see, so recovery is not guesswork', async () => {
    const { get, app } = await harness();
    const body = JSON.parse((await get(`/v1/find?projectId=${THEIRS}`)).body);
    expect(body.visibleProjects.map((p: { id: string }) => p.id)).toEqual([MINE]);
    await app.close();
  });

  it('refuses a claim too, since the lease is gateway-side', async () => {
    // Reading someone else's project is the reported bug; taking work in it and
    // blocking whoever can see it is the worse version of the same gap.
    const { app, token } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId: THEIRS, workItemId: ITEM },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('a project the caller is a member of', () => {
  for (const [tool, url] of READS) {
    it(`${tool} allows it`, async () => {
      const { get, app } = await harness();
      expect((await get(url(MINE))).statusCode).toBe(200);
      await app.close();
    });
  }
});

describe('the check itself', () => {
  it('is cached, so it does not double the request count of every read', async () => {
    const { get, app } = await harness();
    await get(`/v1/find?projectId=${MINE}`);
    await get(`/v1/board?projectId=${MINE}`);
    await get(`/v1/next?projectId=${MINE}`);
    expect(listCalls).toBe(1);
    await app.close();
  });

  it('refuses rather than falls through when Plane cannot answer', async () => {
    // The one behaviour that matters most. An access check that fails open is an
    // access check that does nothing on the day it matters — and the fallback it
    // would fall through to is the workspace-wide service account.
    const app = Fastify();
    const plane = Object.assign(fakePlane(), {
      listProjects: async () => {
        throw new Error('plane unreachable');
      },
    });
    Object.assign(plane, { as: () => plane });
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
      name: `t-acc-${randomUUID().slice(0, 8)}/worker`,
      principal: 'human:t@example.com',
      planeToken: 'plane_pat_test',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/find?projectId=${MINE}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain('a secret roadmap item');
    await app.close();
  });

  it('refuses an agent with no Plane identity rather than downgrading it', async () => {
    // The same choice `search` already made. A token with no Plane user has
    // nothing to check against, and the only fallback available is the service
    // account — which is the privilege this exists to stop it having.
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
    const { token } = await issueToken(pool, {
      name: `t-acc-${randomUUID().slice(0, 8)}/worker`,
      principal: 'human:t@example.com',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/find?projectId=${MINE}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('no Plane identity');
    await app.close();
  });
});
