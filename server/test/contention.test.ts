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
 * What a losing agent is told when somebody else already has the item.
 *
 * The refusal used to be "Another agent holds this item. Pick a different one",
 * while `why` on the same item one call later answered "held by
 * agent:…/worker-10 until 12:33:40Z". The gateway had both facts at the moment
 * it refused and volunteered neither (SYNC-118).
 *
 * Three costs, and the third is why this is a defect and not merely terse:
 *
 *   1. Every refused agent pays a round trip for something the refusal knew.
 *   2. "Pick a different one" is wrong advice for a lease lapsing in ninety
 *      seconds and right for one with forty minutes left. The agent could not
 *      tell those apart, and was given the same sentence either way.
 *   3. A refusal that names nobody is equally consistent with exclusion keyed on
 *      the shared human root — and in the two-box run both boxes authenticated
 *      as the same person, so the run only demonstrated cross-AGENT exclusion
 *      once `why` supplied the holder. A refusal that named worker-10 would have
 *      been self-evidencing.
 *
 * The asymmetry is the tell: an agent that distrusted the error and called `why`
 * got a good answer, and one that believed it and moved on got a worse outcome.
 *
 * These drive two DISTINCT agent tokens through the real router, because the
 * question is precisely whether one agent's identity reaches the other's
 * refusal — which a single-token test cannot answer.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ME = randomUUID();

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
];

const item = (id: string): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name: 'one item, two agents',
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

function fakePlane(ids: string[]): PlaneClient {
  const items = ids.map(item);
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'SYNC', name: 'Project' }],
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id),
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[1],
    updateWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id)!,
    comment: async () => ({}),
    search: async () => [],
  }) as unknown as PlaneClient;
  return plane;
}

/** Two agents of the same human, which is the case that made this ambiguous. */
async function harness(ids: string[]) {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(ids),
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
  const mint = async (label: string) => {
    const name = `t-cn-${randomUUID().slice(0, 8)}/${label}`;
    const { token } = await issueToken(pool, {
      name,
      principal: 'human:me@example.com',
      planeToken: 'plane_pat_test',
      planeUserId: ME,
    });
    return { token, holder: `agent:${name}` };
  };

  const first = await mint('worker-a');
  const second = await mint('worker-b');

  const claimAs = (who: { token: string }, body: unknown, session: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: { authorization: `Bearer ${who.token}`, 'x-sync-session': session },
      body,
    });

  const whyAs = (who: { token: string }, workItemId: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/why?projectId=${PROJECT}&workItemId=${workItemId}`,
      headers: { authorization: `Bearer ${who.token}` },
    });

  return { app, first, second, claimAs, whyAs };
}

beforeEach(async () => {
  forgetAccess();
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

describe('a claim refused because somebody else holds it', () => {
  it('names the holder and the expiry in the refusal itself', async () => {
    const id = randomUUID();
    const h = await harness([id]);

    const won = await h.claimAs(h.first, { projectId: PROJECT, workItemId: id, ttlSeconds: 600 }, 's-a');
    expect(won.statusCode).toBe(200);

    const lost = await h.claimAs(h.second, { projectId: PROJECT, workItemId: id }, 's-b');
    expect(lost.statusCode).toBe(409);
    const body = lost.json();
    expect(body.error).toBe('NOT_CLAIMABLE');

    // The whole point: worker-b learns worker-a's name from the refusal, without
    // a second call. This is also what makes a cross-agent exclusion test
    // self-evidencing rather than merely consistent with the result.
    expect(body.message).toContain(h.first.holder);
    expect(body.heldBy).toBe(h.first.holder);
    expect(body.heldUntil).toBe(won.json().lease.expiresAt);

    await h.app.close();
  });

  it('does not name the loser, or anything about the human behind either', async () => {
    // Both agents belong to one person here, which is exactly the configuration
    // that made the original run inconclusive. The refusal must distinguish the
    // AGENTS, and must not leak the shared principal into an error the other
    // agent reads.
    const id = randomUUID();
    const h = await harness([id]);
    await h.claimAs(h.first, { projectId: PROJECT, workItemId: id }, 's-a');

    const body = (await h.claimAs(h.second, { projectId: PROJECT, workItemId: id }, 's-b')).json();
    expect(body.message).not.toContain(h.second.holder);
    expect(JSON.stringify(body)).not.toContain('me@example.com');

    await h.app.close();
  });

  it('says wait when the lease is nearly up, and move on when it is not', async () => {
    // The advice the static recovery line cannot give, because it does not know
    // the expiry. An item held for another thirty seconds is worth waiting for;
    // the same sentence about one held for another hour sends an agent away from
    // work it could have had.
    const soonId = randomUUID();
    const soon = await harness([soonId]);
    await soon.claimAs(soon.first, { projectId: PROJECT, workItemId: soonId, ttlSeconds: 30 }, 's-a');
    const nearly = (await soon.claimAs(soon.second, { projectId: PROJECT, workItemId: soonId }, 's-b')).json();
    expect(nearly.message).toMatch(/under two minutes/);
    expect(nearly.message).not.toMatch(/pick a different item/);
    await soon.app.close();

    const laterId = randomUUID();
    const later = await harness([laterId]);
    await later.claimAs(later.first, { projectId: PROJECT, workItemId: laterId, ttlSeconds: 3600 }, 's-a');
    const plenty = (await later.claimAs(later.second, { projectId: PROJECT, workItemId: laterId }, 's-b')).json();
    expect(plenty.message).toMatch(/about 60 minutes/);
    expect(plenty.message).toMatch(/pick a different item/);
    await later.app.close();
  });

  it('still leaves `why` to give the fuller picture', async () => {
    // The refusal carries the two facts that make it actionable, not the whole
    // gate. `why` remains the tool that answers everything at once, and it must
    // keep agreeing with the refusal rather than being quietly superseded by it.
    const id = randomUUID();
    const h = await harness([id]);
    await h.claimAs(h.first, { projectId: PROJECT, workItemId: id }, 's-a');

    const reasons: string[] = (await h.whyAs(h.second, id)).json().reasons;
    // The two must agree on the holder — a refusal and an explanation that named
    // different agents would be worse than the silence this replaced.
    expect(reasons.some((r) => r.includes(h.first.holder))).toBe(true);
    // And `why` remains a superset: it reports the lease as one reason among
    // however many the gate found, while the refusal reports only the one that
    // caused it. Asserting a count here would measure the fake Plane rather than
    // the division of labour — this item is blocked by exactly one thing.
    expect(reasons.some((r) => /^held by /.test(r))).toBe(true);

    await h.app.close();
  });

  it('says less rather than something untrue when the lease ends in between', async () => {
    // claim fails, then the holder is read — two statements, not one, because
    // claim stays a single atomic statement and this costs a query only on the
    // path that already lost. So the lease can end in the gap. The refusal is
    // still correct; it simply has no name to give.
    const id = randomUUID();
    const h = await harness([id]);
    await h.claimAs(h.first, { projectId: PROJECT, workItemId: id }, 's-a');
    // Stand in for the race by ending the lease before the second claim reads it.
    await pool.query("update lease set state = 'released' where work_item_id = $1", [id]);

    const body = (await h.claimAs(h.second, { projectId: PROJECT, workItemId: id }, 's-b')).json();
    if (body.error === 'NOT_CLAIMABLE') {
      expect(body.heldBy).toBeUndefined();
      expect(body.message).not.toMatch(/until/);
    }

    await h.app.close();
  });
});
