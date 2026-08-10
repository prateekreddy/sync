import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Which completions actually earn `evidence-missing`, through the real route.
 *
 * `unproven` is unit-tested in ghcheck.test.ts; this is the other half, and the
 * half that had no coverage at all: whether the label the board shows is decided
 * by that rule. A correct rule wired to nothing is the recurring defect in this
 * repo, so the useful question is "who calls it?".
 *
 * The case being held open is the mixed one — real commits beside hex words that
 * are not commits — because that is the one that exists in practice. The other
 * box produced it by putting three md5 checksums of the watch file into an
 * outcome as rotation evidence, which is careful work, and got told its
 * completion was unproven for doing it.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ME = randomUUID();
const REPO = 'owner/repo';
const LABEL_ID = randomUUID();

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

/** Label ids the gateway wrote onto the item. */
let labelled: string[] = [];

const item = (id: string): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name: 'something to finish',
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

function fakePlane(id: string): PlaneClient {
  const items = [item(id)];
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'SYNC', name: 'Project' }],
    projectIdentifier: async () => 'SYNC',
    identifierFor: () => 'SYNC',
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, i: string) => items.find((x) => x.id === i),
    states: async () => STATES,
    // Real ids for the two labels a completion can earn, so resolveLabels
    // finds them rather than trying to create one through a fake that has no
    // creation path. What is being tested is which label is asked for, not how
    // Plane stores it.
    labels: async () => [
      { id: LABEL_ID, name: 'evidence-missing' },
      { id: randomUUID(), name: 'unverified' },
    ],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[2],
    updateWorkItem: async (_p: string, i: string, body: Record<string, unknown>) => {
      // The mirror labels by read-modify-write on the item, because Plane's
      // `labels` is a replacement rather than an append — so the label lands
      // here, not on a call of its own.
      if (Array.isArray(body['labels'])) labelled.push(...(body['labels'] as string[]));
      return items.find((x) => x.id === i)!;
    },
    comment: async () => ({}),
    search: async () => [],
    relate: async () => ({}),
  }) as unknown as PlaneClient;
  return plane;
}

/**
 * GitHub, answering for exactly the shas named. Anything else is a 404, which is
 * what makes a stray checksum `absent` rather than merely unknown.
 */
function githubKnowing(real: string[]) {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    const found = real.some((sha) => u.includes(sha));
    return {
      ok: found,
      status: found ? 200 : 404,
      json: async () => (found ? { status: 'behind' } : {}),
    } as Response;
  });
}

async function harness(id: string) {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(id),
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: { token: 'ghp_test', defaultRepo: REPO, apiBase: 'https://api.github.invalid' },
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.ready();

  process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
  const { token } = await issueToken(pool, {
    name: `t-el-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: ME,
  });
  const auth = { authorization: `Bearer ${token}`, 'x-sync-session': 's-ev' };

  const lease = (
    await app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: auth,
      body: { projectId: PROJECT, workItemId: id },
    })
  ).json();

  return {
    app,
    complete: (outcome: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: auth,
        body: { workItemId: id, epoch: lease.lease.epoch, outcome },
      }),
  };
}

beforeEach(async () => {
  forgetAccess();
  labelled = [];
  await pool.query('truncate lease');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.query('truncate lease');
  await pool.end();
});

/** The mirror is fired without awaiting, so give it a turn to land. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('a completion citing both real commits and things that are not commits', () => {
  it('is not labelled evidence-missing', async () => {
    const id = randomUUID();
    githubKnowing(['8b9220e1111111111111111111111111111111a1']);
    const h = await harness(id);

    const res = await h.complete(
      'Fixed in 8b9220e1111111111111111111111111111111a1. Watch file rotated — md5 went ' +
        '0c64e2c9 then c9835b1e then d2735e9a across three polls.',
    );
    await settle();

    const body = res.json();
    // One landed, three absent. The old rule flagged this; it is the shape a
    // careful completion actually has.
    expect(body.evidence.filter((c: { status: string }) => c.status === 'absent')).toHaveLength(3);
    expect(body.verified).toBe(true);
    expect(labelled).not.toContain(LABEL_ID);

    // Still SAID, though, because a citation that resolved to nothing is usually
    // a typo the agent can fix. Not flagging it is not the same as hiding it.
    expect(body.warning).toMatch(/could not be found/);
    expect(body.warning).toMatch(/not flagged/);

    await h.app.close();
  });

  it('is labelled when nothing cited could be found', async () => {
    const id = randomUUID();
    githubKnowing([]);
    const h = await harness(id);

    const res = await h.complete('Done — see 0c64e2c9 and c9835b1e for the proof.');
    await settle();

    expect(labelled).toContain(LABEL_ID);
    expect(res.json().warning).toMatch(/labelled "evidence-missing"/);

    await h.app.close();
  });
});
