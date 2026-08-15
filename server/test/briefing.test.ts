import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { briefing, briefingFor } from '../src/briefing.js';
import { issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { registerRoutes } from '../src/routes.js';
import { PlaneClient } from '../src/plane.js';
import type { Relations, WorkItem } from '../src/plane.js';

/**
 * `claim` returned `{ lease }`: permission to work, and none of the context
 * written down about how the work must be done.
 *
 * The case these are built from is BRIDGEETHB-63 — a finding that a protective
 * rate limit must bind on inbound credit, not outbound send, recorded against the
 * items it constrains. Noticed, captured, correctly placed, and still invisible
 * to the agent who claims the implementation and writes the natural, wrong
 * version. What these pin is that an open linked item arrives WITH ITS TEXT, and
 * that nothing about assembling it can cost an agent the lease it already holds.
 */

const PROJECT = 'p1';

const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-brief-%/worker'");
  await pool.end();
});

const STATES = [
  { id: 'backlog', name: 'Backlog', group: 'backlog' },
  { id: 'done', name: 'Done', group: 'completed' },
  { id: 'cancelled', name: 'Cancelled', group: 'cancelled' },
];

const NO_RELATIONS: Relations = {
  blocking: [],
  blocked_by: [],
  duplicate: [],
  relates_to: [],
  start_after: [],
  start_before: [],
  finish_after: [],
  finish_before: [],
};

const item = (over: Partial<WorkItem> & { id: string }): WorkItem => ({
  sequence_id: 1,
  name: 'An item',
  description_html: '<p>Body.</p>',
  state: 'backlog',
  priority: 'medium',
  labels: [],
  parent: null,
  is_draft: false,
  assignees: [],
  created_at: '',
  updated_at: '',
  ...over,
});

function fakePlane(opts: {
  items: Record<string, WorkItem>;
  relations?: Partial<Relations>;
  relationsThrows?: boolean;
  missing?: Set<string>;
}): PlaneClient {
  return Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    getWorkItem: async (_p: string, id: string) => {
      if (opts.missing?.has(id)) throw new Error('gone');
      const found = opts.items[id];
      if (!found) throw new Error(`no item ${id}`);
      return found;
    },
    relations: async () => {
      if (opts.relationsThrows) throw new Error('relations unavailable');
      return { ...NO_RELATIONS, ...opts.relations };
    },
    states: async () => STATES,
    labelNames: async () => new Map([['l1', 'backend']]),
  }) as unknown as PlaneClient;
}

describe('the item itself', () => {
  it('carries the description as text, since that is the acceptance criteria', async () => {
    const plane = fakePlane({
      items: {
        a: item({ id: 'a', sequence_id: 42, description_html: '<p>Do <b>this</b>.</p>' }),
      },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.readableId).toBe('#42');
    expect(b.description).toBe('Do this.');
  });

  it('resolves state and label ids to names', async () => {
    const plane = fakePlane({ items: { a: item({ id: 'a', labels: ['l1'] }) } });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.state).toBe('Backlog');
    expect(b.labels).toEqual(['backend']);
  });

  it('names the parent, so work handed over in isolation still says what it is part of', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a', parent: 'p' }), p: item({ id: 'p', name: 'The container' }) },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.parent).toEqual({ workItemId: 'p', title: 'The container' });
  });
});

describe('linked items', () => {
  it('includes the text of an OPEN linked item, which is the whole point', async () => {
    // A title does not carry a requirement. This is the BRIDGEETHB-63 case: the
    // constraint lives in the body, and an agent that never reads it writes the
    // natural and wrong version.
    const plane = fakePlane({
      items: {
        a: item({ id: 'a' }),
        c: item({
          id: 'c',
          name: 'Rate limit binds on credit',
          description_html: '<p>_outflow reads like the send path. It is not.</p>',
        }),
      },
      relations: { relates_to: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related).toHaveLength(1);
    expect(b.related[0]?.done).toBe(false);
    expect(b.related[0]?.description).toBe('_outflow reads like the send path. It is not.');
  });

  it('omits the text of a finished linked item, which is history not a constraint', async () => {
    const plane = fakePlane({
      items: {
        a: item({ id: 'a' }),
        c: item({ id: 'c', state: 'done', description_html: '<p>Long since handled.</p>' }),
      },
      relations: { blocked_by: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related[0]?.done).toBe(true);
    expect(b.related[0]?.description).toBeUndefined();
  });

  it('treats a cancelled item as finished too', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c', state: 'cancelled' }) },
      relations: { relates_to: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });
    expect(b.related[0]?.done).toBe(true);
  });

  it('puts open links first, ahead of finished ones', async () => {
    // Ordering is the difference between a warning and a footnote: an agent that
    // reads the first entry and stops must hit the live constraint.
    const plane = fakePlane({
      items: {
        a: item({ id: 'a' }),
        old: item({ id: 'old', state: 'done' }),
        live: item({ id: 'live' }),
      },
      relations: {
        blocked_by: [{ project_id: PROJECT, issue_id: 'old' }],
        relates_to: [{ project_id: PROJECT, issue_id: 'live' }],
      },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related.map((r) => r.workItemId)).toEqual(['live', 'old']);
  });

  it('reports each linked item once even when two relation kinds name it', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c' }) },
      relations: {
        blocked_by: [{ project_id: PROJECT, issue_id: 'c' }],
        relates_to: [{ project_id: PROJECT, issue_id: 'c' }],
      },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related).toHaveLength(1);
    expect(b.related[0]?.relation).toBe('blocked_by');
  });

  it('ignores scheduling relations, which say nothing about how to do the work', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), s: item({ id: 's' }) },
      relations: { start_after: [{ project_id: PROJECT, issue_id: 's' }] },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });
    expect(b.related).toEqual([]);
  });
});

/**
 * PLANE-15: retraction existed only for the readiness gate, so it meant something
 * only for `blocked_by`.
 *
 * A wrong `relates_to` gates nothing, which is why it was left out — but it is
 * not free. These briefings list open related items first and WITH THEIR TEXT,
 * exactly so a linked constraint reaches the claimer. That is what makes a bogus
 * edge expensive: it arrives in the same position, with the same weight, and
 * reads as a requirement to honour. So the place an agent can undo it has to be
 * the place it is read.
 */
describe('retracted edges', () => {
  const retracted = (...keys: string[]) => () => Promise.resolve(new Set(keys));

  it('omits a retracted relates_to, which is the only place it was visible', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c', name: 'Not actually related' }) },
      relations: { relates_to: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const b = await briefing(plane, {
      projectId: PROJECT,
      workItemId: 'a',
      retracted: retracted('c|relates_to'),
    });
    expect(b.related).toEqual([]);
  });

  it('retracts per kind — a retracted relates_to leaves a blocked_by briefed', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c' }), d: item({ id: 'd' }) },
      relations: {
        blocked_by: [{ project_id: PROJECT, issue_id: 'd' }],
        relates_to: [{ project_id: PROJECT, issue_id: 'c' }],
      },
    });
    const b = await briefing(plane, {
      projectId: PROJECT,
      workItemId: 'a',
      retracted: retracted('c|relates_to'),
    });
    expect(b.related.map((r) => r.workItemId)).toEqual(['d']);
  });

  it('keeps a pair whose OTHER relation is retracted, under the kind that stands', async () => {
    // Plane keeps every relation on a pair rather than replacing one, so a pair
    // can hold two kinds at once. The briefing dedupes to the first kind it
    // finds; if the filter ran after that dedupe, retracting the first kind would
    // drop the pair entirely and hide an edge nobody retracted.
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c' }) },
      relations: {
        blocked_by: [{ project_id: PROJECT, issue_id: 'c' }],
        relates_to: [{ project_id: PROJECT, issue_id: 'c' }],
      },
    });
    const b = await briefing(plane, {
      projectId: PROJECT,
      workItemId: 'a',
      retracted: retracted('c|blocked_by'),
    });
    expect(b.related).toHaveLength(1);
    expect(b.related[0]?.relation).toBe('relates_to');
  });

  it('does not look retractions up when the item has no relations at all', async () => {
    // This sits in the path of every claim. A project that has never retracted
    // anything should pay nothing for the feature.
    let looked = 0;
    const plane = fakePlane({ items: { a: item({ id: 'a' }) } });
    await briefing(plane, {
      projectId: PROJECT,
      workItemId: 'a',
      retracted: () => {
        looked++;
        return Promise.resolve(new Set<string>());
      },
    });
    expect(looked).toBe(0);
  });

  it('briefs normally when no retractions are supplied', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c' }) },
      relations: { relates_to: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });
    expect(b.related).toHaveLength(1);
  });

  it('says the briefing failed rather than silently dropping the filter', async () => {
    // The lookup lives inside briefingFor's catch deliberately. A briefing built
    // as though nothing were retracted would show edges the gateway is not
    // honouring, and look completely healthy doing it.
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), c: item({ id: 'c' }) },
      relations: { relates_to: [{ project_id: PROJECT, issue_id: 'c' }] },
    });
    const out = await briefingFor(plane, {
      projectId: PROJECT,
      workItemId: 'a',
      retracted: () => Promise.reject(new Error('database gone')),
    });
    expect(out.briefing).toBeNull();
    expect(out.briefingError).toContain('database gone');
  });
});

/**
 * The lease is the thing the agent asked for, and by the time a briefing is built
 * it is already held. Every failure here has to degrade the answer, never revoke
 * the claim.
 */
describe('nothing here may cost an agent its lease', () => {
  it('still briefs when a linked item cannot be read', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a' }), ok: item({ id: 'ok' }) },
      relations: {
        relates_to: [
          { project_id: PROJECT, issue_id: 'ok' },
          { project_id: 'other', issue_id: 'unreadable' },
        ],
      },
      missing: new Set(['unreadable']),
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related.map((r) => r.workItemId)).toEqual(['ok']);
  });

  it('still briefs when relations cannot be fetched at all', async () => {
    const plane = fakePlane({ items: { a: item({ id: 'a' }) }, relationsThrows: true });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });

    expect(b.related).toEqual([]);
    expect(b.title).toBe('An item');
  });

  it('still briefs when the parent cannot be read', async () => {
    const plane = fakePlane({
      items: { a: item({ id: 'a', parent: 'gone' }) },
      missing: new Set(['gone']),
    });
    const b = await briefing(plane, { projectId: PROJECT, workItemId: 'a' });
    expect(b.parent).toBeUndefined();
  });

  it('returns null rather than throwing when the item itself cannot be read', async () => {
    // briefingFor is what `claim` calls: a lease already granted must not be
    // undone by a context lookup failing.
    const plane = fakePlane({ items: {}, missing: new Set(['a']) });
    expect(
      (await briefingFor(plane, { projectId: PROJECT, workItemId: randomUUID() })).briefing,
    ).toBeNull();
  });

  it('says why, instead of leaving the absence to speak for itself', async () => {
    // The defect: `.catch(() => null)` made a briefing that threw look exactly
    // like a gateway too old to have the feature. That ambiguity cost a real
    // diagnosis on 2026-08-03 — two claims in one session against the same
    // project and token, one briefed and one not, and the absence was read as
    // evidence of a stale production build. It was not.
    const plane = fakePlane({ items: {}, missing: new Set(['a']) });
    const out = await briefingFor(plane, { projectId: PROJECT, workItemId: randomUUID() });
    expect(out.briefingError).toMatch(/could not be built/);
  });

  it('hands the real error somewhere a person can act on it', async () => {
    // The agent gets a summary; the gateway log gets the thing itself. Splitting
    // them is the point — an agent cannot debug Plane, and whoever can is not
    // reading the agent's transcript.
    const plane = fakePlane({ items: {}, missing: new Set(['a']) });
    const seen: unknown[] = [];
    await briefingFor(plane, { projectId: PROJECT, workItemId: randomUUID() }, (e) => seen.push(e));
    expect(seen).toHaveLength(1);
  });

  it('says nothing about an error when there was none', async () => {
    // `briefingError` present on a healthy claim would be worse than the bug:
    // every agent would learn to ignore the field.
    const plane = fakePlane({ items: { a: item({ id: 'a' }) } });
    const out = await briefingFor(plane, { projectId: PROJECT, workItemId: 'a' });
    expect(out.briefing).not.toBeNull();
    expect(out.briefingError).toBeUndefined();
  });
});

/**
 * That `briefing()` is correct says nothing about whether `claim` returns it.
 *
 * Three defects this month were of exactly that shape — a correct function whose
 * caller passed an empty map, dropped the field, or never called it — so this
 * drives the real router and asserts on what an agent actually receives.
 */
describe('claim hands the briefing over with the lease', () => {
  it('returns the briefing in the claim response', async () => {
    const projectId = randomUUID();
    const target = randomUUID();
    const constraint = randomUUID();

    const items: Record<string, WorkItem> = {
      [target]: item({
        id: target,
        sequence_id: 10,
        name: 'Implement the thing',
        description_html: '<p>Acceptance criteria here.</p>',
      }),
      [constraint]: item({
        id: constraint,
        sequence_id: 11,
        name: 'It must bind on credit',
        description_html: '<p>The obvious reading is wrong.</p>',
      }),
    };

    const plane = Object.assign(
      fakePlane({
        items,
        relations: { relates_to: [{ project_id: projectId, issue_id: constraint }] },
      }),
      {
        listWorkItems: async () => Object.values(items),
        comment: async () => ({}),
        updateWorkItem: async () => items[target],
      },
    ) as unknown as PlaneClient;
    // Since SYNC-64 every project-scoped route checks the caller's Plane access
    // first, so a fake that cannot answer "which projects can you see" now gets
    // refused before the route under test runs.
    Object.assign(plane, {
      as: () => plane,
      listProjects: async () => [{ id: projectId, identifier: 'T', name: 'Test' }],
    });

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

    const name = `t-brief-${randomUUID().slice(0, 8)}/worker`;
    // Needs a Plane identity: since SYNC-64 a token without one is refused
    // rather than silently downgraded to the workspace-wide service account,
    // which is the same choice `search` has always made.
    process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
    const { token } = await issueToken(pool, {
      name,
      principal: 'human:t@example.com',
      planeToken: 'plane_pat_test',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { projectId, workItemId: target, ttlSeconds: 60 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      lease: { epoch: number };
      briefing: { description: string; related: Array<{ title: string; description?: string }> };
    };

    expect(body.lease.epoch).toBeGreaterThan(0);
    expect(body.briefing.description).toBe('Acceptance criteria here.');
    // The constraint, and its text, without the agent asking for either.
    expect(body.briefing.related[0]?.title).toBe('It must bind on credit');
    expect(body.briefing.related[0]?.description).toBe('The obvious reading is wrong.');

    await pool.query('delete from lease where work_item_id = $1', [target]);
    await app.close();
  });

  it('drops a retracted edge from the briefing an agent is actually handed', async () => {
    // The half of PLANE-15 that could most easily have been declared done while
    // changing nothing: `unlink` writing a relates_to row, `briefing()` filtering
    // correctly, and `claim` never passing the two to each other. Nothing would
    // have errored — the agent would just have kept seeing the retracted edge.
    const projectId = randomUUID();
    const target = randomUUID();
    const noise = randomUUID();

    const items: Record<string, WorkItem> = {
      [target]: item({ id: target, sequence_id: 20, description_html: '<p>Criteria.</p>' }),
      [noise]: item({ id: noise, sequence_id: 21, name: 'Linked by mistake' }),
    };

    const plane = Object.assign(
      fakePlane({ items, relations: { relates_to: [{ project_id: projectId, issue_id: noise }] } }),
      {
        listWorkItems: async () => Object.values(items),
        comment: async () => ({}),
        updateWorkItem: async () => items[target],
        relate: async () => ({}),
      },
    ) as unknown as PlaneClient;
    Object.assign(plane, {
      as: () => plane,
      listProjects: async () => [{ id: projectId, identifier: 'T', name: 'Test' }],
    });

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
      name: `t-brief-${randomUUID().slice(0, 8)}/worker`,
      principal: 'human:t@example.com',
      planeToken: 'plane_pat_test',
    });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const briefed = async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/claim',
        headers,
        payload: { projectId, workItemId: target, ttlSeconds: 60 },
      });
      const body = JSON.parse(res.body) as { briefing: { related: Array<{ title: string }> } };
      await pool.query('delete from lease where work_item_id = $1', [target]);
      return body.briefing.related.map((r) => r.title);
    };

    expect(await briefed()).toEqual(['Linked by mistake']);

    // Through the real tool, with the arguments PLANE-15 asks for.
    const undone = await app.inject({
      method: 'POST',
      url: '/v1/unlink',
      headers,
      payload: {
        projectId,
        workItemId: target,
        relation: 'relates_to',
        targets: [noise],
        reason: 'linked the wrong item',
      },
    });
    expect(undone.statusCode).toBe(200);

    expect(await briefed()).toEqual([]);

    await pool.query('delete from relation_retraction where project_id = $1', [projectId]);
    await app.close();
  });
});
