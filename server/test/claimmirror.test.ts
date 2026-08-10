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
 * A claim is only worth having if a human can see it.
 *
 * The mirror into Plane used to be fired and forgotten, so a claim could succeed
 * while Plane went on showing the item as free. Every consumer of that view --
 * the board, a person reading it, the next agent asking for work -- then believed
 * the item was available, which is how two agents end up doing the same task.
 *
 * So the claim now waits for Plane, and hands the lease back if Plane will not
 * take the write. The line these tests hold is *where* that stops being true:
 * only the write that makes the claim visible may fail a claim. The comment that
 * follows may not, because rolling back after the item is already assigned and
 * started would leave exactly the inconsistency this change removes, with the
 * two halves swapped.
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

/** What the fake Plane should do on the next write. Set per test. */
interface Faults {
  update?: Error;
  comment?: Error;
}

let updates: Array<{ id: string; body: Record<string, unknown> }> = [];
let comments: string[] = [];

const item = (id: string): WorkItem => ({
  id,
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

function fakePlane(ids: string[], faults: Faults): PlaneClient {
  const items = ids.map(item);
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
    stateByGroup: async () => STATES[1],
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      if (faults.update) throw faults.update;
      updates.push({ id, body });
      return items.find((i) => i.id === id)!;
    },
    comment: async (_p: string, id: string, html: string) => {
      if (faults.comment) throw faults.comment;
      comments.push(`${id}:${html}`);
      return {};
    },
    search: async () => [],
  }) as unknown as PlaneClient;
  return plane;
}

async function harness(ids: string[], faults: Faults = {}) {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(ids, faults),
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
    name: `t-cm-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: ME,
  });

  const claim = (body: unknown, session = 's-1') =>
    app.inject({
      method: 'POST',
      url: '/v1/claim',
      headers: { authorization: `Bearer ${token}`, 'x-sync-session': session },
      body,
    });

  return { app, claim };
}

const leaseRow = async (workItemId: string) => {
  const { rows } = await pool.query<{ state: string; epoch: number; end_reason: string | null }>(
    'select state, epoch, end_reason from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0];
};

beforeEach(async () => {
  forgetAccess();
  updates = [];
  comments = [];
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-cm-%/worker'");
  await pool.query('truncate lease');
  await pool.end();
});

describe('when Plane will not take the claim', () => {
  it('refuses the claim rather than granting one nobody can see', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id], { update: new Error('plane 503') });

    const res = await claim({ projectId: PROJECT, workItemId: id });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('UPSTREAM');
    await app.close();
  });

  it('hands the lease back instead of leaving it held', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id], { update: new Error('plane 503') });

    await claim({ projectId: PROJECT, workItemId: id });

    const row = await leaseRow(id);
    expect(row!.state).toBe('released');
    expect(row!.end_reason).toMatch(/rolled back/i);
    await app.close();
  });

  it('leaves the item claimable again straight away', async () => {
    // The rollback is only worth anything if the work becomes available again --
    // otherwise a Plane blip quietly retires an item until its lease expires.
    const id = randomUUID();
    const failing = await harness([id], { update: new Error('plane 503') });
    await failing.claim({ projectId: PROJECT, workItemId: id });
    await failing.app.close();

    const working = await harness([id]);
    const res = await working.claim({ projectId: PROJECT, workItemId: id });

    expect(res.statusCode).toBe(200);
    await working.app.close();
  });

  it('tells the agent what to do about it', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id], { update: new Error('plane 503') });

    const body = (await claim({ projectId: PROJECT, workItemId: id })).json();

    expect(body.recovery).toMatch(/retry/i);
    // And it must not read as "someone else has it", which would send the agent
    // off to find different work when the item is in fact free.
    expect(JSON.stringify(body)).not.toMatch(/another agent/i);
    await app.close();
  });

  it('applies the same rule when the gateway picked the item', async () => {
    // Pick-and-claim is a separate code path, and an invisible lease taken by it
    // is no better than one taken by name.
    const id = randomUUID();
    const { app, claim } = await harness([id], { update: new Error('plane 503') });

    const res = await claim({ projectId: PROJECT });

    expect(res.statusCode).toBe(502);
    expect((await leaseRow(id))?.state ?? 'no row').not.toBe('held');
    await app.close();
  });
});

describe('past the point where the claim is visible', () => {
  it('keeps the claim when only the comment fails', async () => {
    // The item is assigned and started in Plane, so the agent's claim is exactly
    // as visible as it needs to be. Rolling back here would release a lease while
    // leaving Plane showing the work as taken -- the same inconsistency, inverted.
    const id = randomUUID();
    const { app, claim } = await harness([id], { comment: new Error('comments are down') });

    const res = await claim({ projectId: PROJECT, workItemId: id });

    expect(res.statusCode).toBe(200);
    expect((await leaseRow(id))!.state).toBe('held');
    await app.close();
  });

  it('still records the assignment when the comment fails', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id], { comment: new Error('comments are down') });

    await claim({ projectId: PROJECT, workItemId: id });

    expect(updates.find((u) => u.id === id)?.body['assignees']).toEqual([ME]);
    await app.close();
  });
});

describe('when it worked', () => {
  it('has already written to Plane by the time the agent is told', async () => {
    // The point of awaiting: a caller that reads the board immediately after
    // claiming must not see the item as free.
    const id = randomUUID();
    const { app, claim } = await harness([id]);

    await claim({ projectId: PROJECT, workItemId: id });

    expect(updates.find((u) => u.id === id)).toBeDefined();
    expect((await leaseRow(id))!.state).toBe('held');
    await app.close();
  });

  it('moves the item into a started state and onto the agent', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id]);

    await claim({ projectId: PROJECT, workItemId: id });

    const body = updates.find((u) => u.id === id)!.body;
    expect(body['state']).toBe('started');
    expect(body['assignees']).toEqual([ME]);
    await app.close();
  });

  it('does not comment twice when the claim is re-sent', async () => {
    // A retry is one claim, not two, and the comment lands on an item a human
    // reads. Duplicated notes there are how a board becomes unreadable.
    const id = randomUUID();
    const { app, claim } = await harness([id]);

    await claim({ projectId: PROJECT, workItemId: id });
    const again = await claim({ projectId: PROJECT, workItemId: id });

    expect(again.statusCode).toBe(200);
    expect(comments.filter((c) => c.startsWith(id)).length).toBe(1);
    await app.close();
  });

  it('does not re-write Plane when the claim is re-sent', async () => {
    const id = randomUUID();
    const { app, claim } = await harness([id]);

    await claim({ projectId: PROJECT, workItemId: id });
    await claim({ projectId: PROJECT, workItemId: id });

    expect(updates.filter((u) => u.id === id).length).toBe(1);
    await app.close();
  });
});

/**
 * The two claim paths must hand back the same things.
 *
 * `claim` can be given a work item or asked to pick one, and the tool
 * description actively steers agents to the second -- "omit workItemId ...
 * calling next and then claim is a race". That path returned no watchUrl at all,
 * so the harvest hook found nothing to store, the monitor had nothing to poll,
 * and the lease lapsed while the agent worked. The advice that avoids a race
 * walked into a lapse instead. See SYNC-105.
 *
 * Asserted as an agreement between the paths rather than as "each works",
 * because the defect was not that either path was broken -- it was that they
 * drifted. Only one of them got the credential when it was introduced.
 */
describe('however the item was chosen', () => {
  it('hands back a watch credential either way', async () => {
    const id = randomUUID();
    const named = await harness([id]);
    const byName = (await named.claim({ projectId: PROJECT, workItemId: id })).json();
    await named.app.close();
    await pool.query('truncate lease');

    const other = randomUUID();
    const picked = await harness([other]);
    const byPick = (await picked.claim({ projectId: PROJECT })).json();
    await picked.app.close();

    expect(byName.watchUrl).toMatch(/\/v1\/watch\//);
    expect(byPick.watchUrl).toMatch(/\/v1\/watch\//);
  });

  it('does not quietly drop the liveness warning on the picked path', async () => {
    // 26f7fda added the warning to the named path only, so an agent taking the
    // recommended route was never told its monitor was missing either.
    const id = randomUUID();
    const named = await harness([id]);
    const byName = Object.keys((await named.claim({ projectId: PROJECT, workItemId: id })).json());
    await named.app.close();
    await pool.query('truncate lease');

    const other = randomUUID();
    const picked = await harness([other]);
    const byPick = Object.keys((await picked.claim({ projectId: PROJECT })).json());
    await picked.app.close();

    // `item` is the picked path's own addition -- it says WHICH item was chosen,
    // which the caller of the named path already knows.
    expect(byName.filter((k) => !byPick.includes(k))).toEqual([]);
  });
});
