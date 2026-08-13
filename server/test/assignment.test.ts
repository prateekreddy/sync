import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken } from '../src/auth.js';
import type { Actor } from '../src/auth.js';
import {
  approveTakeover,
  approvedTakeovers,
  foreignAssignees,
  gatewayWrites,
  nameOf,
  principalPlaneUser,
  takeoverApproval,
} from '../src/assignment.js';
import { createPool } from '../src/db.js';
import { callTool, type AskHuman } from '../src/tools.js';
import { forgetAccess } from '../src/access.js';
import { PlaneClient } from '../src/plane.js';
import type { Member, State, WorkItem } from '../src/plane.js';
import { mirrorComplete } from '../src/mirror.js';
import { registerRoutes } from '../src/routes.js';
import { NO_RELATIONS } from './relations.js';

/**
 * SYNC-70: work a human had assigned was offered to agents as if it were free.
 *
 * The lease was enforced and the assignee was not, so `find(ready: true)` listed
 * it, `board` counted it, `next` offered it and `claim` handed it over.
 *
 * The rule these tests pin down, decided with the project owner:
 *
 *   nobody assigned            -> free
 *   assigned to the caller     -> free; a name on an item is a work order
 *   assigned to anyone else    -> withheld, until a human says otherwise, per item
 *   assigned by us, lease over -> residue from a failed mirror write; free
 *
 * The fourth case is the one with teeth. `mirrorClaim` puts an assignee on every
 * claim, so most names in Plane were written by the gateway — a gate that could
 * not tell its own writes from a human's would either withhold every item any
 * agent had ever touched, or honour nothing at all.
 *
 * These drive the real router wherever they can. The defect was never inside a
 * function: every one of these tools did exactly what it said, and the gate simply
 * had no opinion about a field that was sitting right there.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ME = randomUUID();
const DANA = randomUUID();

const FREE = randomUUID();
const MINE = randomUUID();
const THEIRS = randomUUID();
const RESIDUE = randomUUID();

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];

const MEMBERS: Member[] = [
  { id: ME, name: 'Alice', email: 'me@example.com' },
  { id: DANA, name: 'Dana', email: 'dana@example.com' },
];

const wi = (id: string, name: string, assignees: string[]): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name,
  description_html: '<p>enough to act on</p>',
  state: 'backlog',
  priority: 'medium',
  assignees,
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const BOARD = (): WorkItem[] => [
  wi(FREE, 'nobody assigned', []),
  wi(MINE, 'assigned to me', [ME]),
  wi(THEIRS, "assigned to Dana", [DANA]),
  wi(RESIDUE, 'left assigned by a failed mirror write', [DANA]),
];

let updates: Array<{ id: string; body: Record<string, unknown> }> = [];
let created: Array<Record<string, unknown>> = [];

function fakePlane(): PlaneClient {
  const items = BOARD();
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
    members: async () => MEMBERS,
    stateByGroup: async () => STATES[0],
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      updates.push({ id, body });
      return items.find((i) => i.id === id)!;
    },
    comment: async () => ({}),
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      created.push(body);
      return { ...wi(randomUUID(), String(body['name']), []), ...body };
    },
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
  const name = `t-asg-${randomUUID().slice(0, 8)}/worker`;
  const { token } = await issueToken(pool, {
    name,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: ME,
  });

  const get = (path: string) =>
    app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });
  const post = (path: string, body: unknown) =>
    app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` }, body });

  return { app, get, post, token };
}

/**
 * A claim made the way an agent actually makes one — through the tool surface,
 * where a question can be put to a person.
 *
 * The REST endpoint has no channel to a human and never will: an approval has to
 * come from somebody who was asked, and every other door into this gateway is
 * one an agent can open by itself.
 */
async function claimViaTool(
  app: Awaited<ReturnType<typeof harness>>['app'],
  token: string,
  args: Record<string, unknown>,
  askHuman?: AskHuman,
) {
  const deps = {
    app,
    pool,
    plane: null,
    rest: fakePlane(),
    ...(askHuman ? { askHuman } : {}),
  } as unknown as Parameters<typeof callTool>[0];
  const actor = {
    holder: 'agent:t-asg/worker',
    principal: 'human:me@example.com',
    defaultProjectId: PROJECT,
    capabilities: [],
  } as unknown as Actor;
  const out = await callTool(deps, actor, `Bearer ${token}`, 'claim', args);
  return { isError: out.isError === true, text: out.content[0]?.text ?? '' };
}

const idsIn = (body: { items: Array<{ workItemId: string }> }) => body.items.map((i) => i.workItemId);

/**
 * A name in Plane that the gateway put there and never managed to clear.
 *
 * The lease is what says so: it ended, but `mirrored` is false, so the write
 * that would have removed the assignee has not landed. There is no separate
 * record of our writes any more — the fact this used to be looked up in
 * `assignment_write` is derived from the lease itself.
 */
async function residue(workItemId: string, planeUserId: string): Promise<void> {
  process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
  const name = `t-asg-${randomUUID().slice(0, 8)}/other`;
  await issueToken(pool, {
    name,
    principal: 'human:dana@example.com',
    planeToken: 'plane_pat_test',
    planeUserId,
  });
  await pool.query(
    `insert into lease (work_item_id, project_id, holder, epoch, state, expires_at, mirrored)
     values ($1, $2, $3, 1, 'released', now(), false)`,
    [workItemId, PROJECT, `agent:${name}`],
  );
}

beforeEach(async () => {
  forgetAccess();
  updates = [];
  created = [];
  await pool.query('truncate lease');
  await pool.query('delete from takeover_approval');
});

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-asg-%'");
  await pool.query('truncate lease');
  await pool.query('delete from takeover_approval');
  await pool.end();
});

describe('the rule', () => {
  it('leaves unassigned work claimable', () => {
    expect(foreignAssignees({ id: FREE, assignees: [] }, ME, new Map())).toEqual([]);
  });

  it('treats a name that is your own as a work order, not a barrier', () => {
    expect(foreignAssignees({ id: MINE, assignees: [ME] }, ME, new Map())).toEqual([]);
  });

  it('withholds work assigned to somebody else', () => {
    expect(foreignAssignees({ id: THEIRS, assignees: [DANA] }, ME, new Map())).toEqual([DANA]);
  });

  it('ignores a name the gateway wrote itself', () => {
    // The residue case. Without this, every item any agent ever claimed reads as
    // assigned-by-a-human the moment its lease ends and the mirror fails to clear.
    const wrote = new Map([[RESIDUE, DANA]]);
    expect(foreignAssignees({ id: RESIDUE, assignees: [DANA] }, ME, wrote)).toEqual([]);
  });

  it('reports an absent field as unknown, never as unassigned', () => {
    // Treating "we were not told" as "nobody is assigned" is a gate that fails
    // open on exactly the items it exists to withhold.
    expect(foreignAssignees({ id: FREE, assignees: undefined }, ME, new Map())).toBeNull();
  });

  it('withholds from an agent with no Plane identity of its own', () => {
    expect(foreignAssignees({ id: MINE, assignees: [ME] }, null, new Map())).toEqual([ME]);
  });
});

describe('browsing agrees with claiming', () => {
  it('omits work assigned to someone else from find(ready: true)', async () => {
    const { app, get } = await harness();
    const body = await get(`/v1/find?projectId=${PROJECT}&ready=true`).then((r) => r.json());
    expect(idsIn(body)).toContain(FREE);
    expect(idsIn(body)).toContain(MINE);
    expect(idsIn(body)).not.toContain(THEIRS);
    await app.close();
  });

  it('still shows it when not asked for ready, because you may want to link it', async () => {
    const { app, get } = await harness();
    const body = await get(`/v1/find?projectId=${PROJECT}`).then((r) => r.json());
    expect(idsIn(body)).toContain(THEIRS);
    await app.close();
  });

  it('never offers it through next', async () => {
    const { app, get } = await harness();
    const body = await get(`/v1/next?projectId=${PROJECT}`).then((r) => r.json());
    const ids = body.candidates.map((c: { workItemId: string }) => c.workItemId);
    expect(ids).toContain(FREE);
    expect(ids).not.toContain(THEIRS);
    await app.close();
  });

  it('names the person in why, rather than printing a uuid at you', async () => {
    const { app, get } = await harness();
    const body = await get(`/v1/why?projectId=${PROJECT}&workItemId=${THEIRS}`).then((r) => r.json());
    expect(body.claimable).toBe(false);
    expect(body.reasons.join(' ')).toContain('Dana');
    await app.close();
  });

  it('offers an item whose only assignee is our own residue', async () => {
    await residue(RESIDUE, DANA);
    const { app, get } = await harness();
    const body = await get(`/v1/find?projectId=${PROJECT}&ready=true`).then((r) => r.json());
    expect(idsIn(body)).toContain(RESIDUE);
    await app.close();
  });
});

describe('telling our own writes from a human’s', () => {
  /** A lease in whatever state, held by an agent with its own Plane identity. */
  async function lease(
    workItemId: string,
    state: string,
    over: { mirrored?: boolean; pending?: boolean } = {},
  ): Promise<void> {
    process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
    const name = `t-asg-${randomUUID().slice(0, 8)}/w`;
    await issueToken(pool, {
      name,
      principal: 'human:dana@example.com',
      planeToken: 'plane_pat_test',
      planeUserId: DANA,
    });
    await pool.query(
      `insert into lease (work_item_id, project_id, holder, epoch, state, expires_at, mirrored, pending_mirror)
       values ($1, $2, $3, 1, $4::lease_state, now() + interval '10 minutes', $5, $6::jsonb)`,
      [
        workItemId,
        PROJECT,
        `agent:${name}`,
        state,
        over.mirrored ?? true,
        over.pending ? JSON.stringify({ kind: 'return' }) : null,
      ],
    );
  }

  it('claims the assignee on a lease it currently holds', async () => {
    const id = randomUUID();
    await lease(id, 'held');
    expect((await gatewayWrites(pool, [id])).get(id)).toBe(DANA);
  });

  it('claims it while a clear is still owed', async () => {
    // The residue case. The lease is over, but the write that would have removed
    // the name has not landed, so the name is ours and the item is free.
    const queued = randomUUID();
    const unmirrored = randomUUID();
    await lease(queued, 'released', { pending: true });
    await lease(unmirrored, 'released', { mirrored: false });

    const wrote = await gatewayWrites(pool, [queued, unmirrored]);
    expect(wrote.get(queued)).toBe(DANA);
    expect(wrote.get(unmirrored)).toBe(DANA);
  });

  it('disclaims it once Plane has been told the lease ended', async () => {
    // Nothing is owed and the lease is over, so we cleared the assignee. A name
    // on the item now is a person's, and withholding it is the correct answer.
    const id = randomUUID();
    await lease(id, 'released');
    expect((await gatewayWrites(pool, [id])).has(id)).toBe(false);
  });

  it('matches the holder back to the token that issued it', async () => {
    // holder is `agent:<name>` and agent_token.name is the bare name. A join that
    // compares them directly matches nothing, silently, and every name in Plane
    // then reads as a human's.
    const id = randomUUID();
    await lease(id, 'held');
    const { rows } = await pool.query<{ holder: string }>(
      'select holder from lease where work_item_id = $1',
      [id],
    );
    expect(rows[0]!.holder).toMatch(/^agent:/);
    expect((await gatewayWrites(pool)).get(id)).toBe(DANA);
  });
});

describe('claim', () => {
  it('refuses an item assigned to someone else', async () => {
    const { app, post } = await harness();
    const res = await post('/v1/claim', { projectId: PROJECT, workItemId: THEIRS });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().message).toContain('Dana');
    await app.close();
  });

  it('allows an item assigned to the caller', async () => {
    const { app, post } = await harness();
    const res = await post('/v1/claim', { projectId: PROJECT, workItemId: MINE });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('never picks an assigned item when told to choose', async () => {
    const { app, post } = await harness();
    for (let i = 0; i < 3; i++) {
      const res = await post('/v1/claim', { projectId: PROJECT });
      if (res.statusCode !== 200) break;
      expect(res.json().lease.workItemId).not.toBe(THEIRS);
    }
    await app.close();
  });

  it('never asks about an item the gateway picked itself', async () => {
    // A person approves taking a specific piece of work off somebody, not
    // whatever comes next off the queue — and an unnamed claim only ever picks
    // from what is already free.
    const { app, token } = await harness();
    const asked: string[] = [];
    const out = await claimViaTool(app, token, { projectId: PROJECT }, async (m) => {
      asked.push(m);
      return 'approved';
    });
    expect(asked).toEqual([]);
    expect(out.text).not.toContain(THEIRS);
    await app.close();
  });
});

describe('taking work off a person', () => {
  /**
   * `takeover: true` used to be how this worked: an argument the model set to
   * assert that somebody had agreed. The gateway could not tell the model's word
   * from a person's, so the argument WAS the trust — one boolean between an agent
   * and somebody else's work. The server now asks, over a channel the model does
   * not author.
   */
  it('asks a person, naming the item and who has it', async () => {
    const { app, token } = await harness();
    const asked: string[] = [];
    await claimViaTool(app, token, { projectId: PROJECT, workItemId: THEIRS }, async (m) => {
      asked.push(m);
      return 'approved';
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Dana');
    await app.close();
  });

  it('lets the claim through once they say yes', async () => {
    const { app, token } = await harness();
    const out = await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'approved',
    );
    expect(out.isError).toBe(false);
    await app.close();
  });

  it('records the approval against the item, so nobody has to ask twice', async () => {
    // Recorded rather than remembered: a compaction, a restart, or a different
    // agent picking the work up would otherwise lose the human's answer — and an
    // approval prompt people see repeatedly is one they stop reading.
    const { app, token } = await harness();
    await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'approved',
    );
    const { rows } = await pool.query<{ approved_by: string; taken_from: string }>(
      'select approved_by, taken_from from takeover_approval where work_item_id = $1',
      [THEIRS],
    );
    expect(rows[0]?.approved_by).toBe('human:me@example.com');
    expect(rows[0]?.taken_from).toBe(DANA);
    await app.close();
  });

  it('refuses and records nothing when they say no', async () => {
    const { app, token } = await harness();
    const out = await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'refused',
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('said no');
    const { rows } = await pool.query('select 1 from takeover_approval where work_item_id = $1', [
      THEIRS,
    ]);
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it('leaves the refusal standing when there is nobody to ask', async () => {
    // Measured: `claude -p` declares elicitation at initialize and then refuses
    // the form when asked. A headless run has no human, and "could not ask" must
    // never read as "was approved".
    const { app, token } = await harness();
    const out = await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'unavailable',
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('NEEDS_APPROVAL');
    await app.close();
  });

  it('refuses on a path that has no way to reach a person at all', async () => {
    const { app, token } = await harness();
    const out = await claimViaTool(app, token, { projectId: PROJECT, workItemId: THEIRS });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('NEEDS_APPROVAL');
    await app.close();
  });

  it('is not something the caller can assert for itself', async () => {
    // The whole point. An argument the model sets cannot grant this any more.
    const { app, post } = await harness();
    const res = await post('/v1/claim', {
      projectId: PROJECT,
      workItemId: THEIRS,
      takeover: true,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('NEEDS_APPROVAL');
    await app.close();
  });

  it('leaves the item claimable afterwards without repeating the approval', async () => {
    const { app, token, post } = await harness();
    await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'approved',
    );
    await post('/v1/release', { workItemId: THEIRS, epoch: 1, reason: 'handing back' });

    const { app: app2, post: post2 } = await harness();
    const again = await post2('/v1/claim', { projectId: PROJECT, workItemId: THEIRS });
    expect(again.statusCode).toBe(200);
    await app.close();
    await app2.close();
  });
});

describe('who the item ends up with', () => {
  it('moves an approved takeover to the human who authorised it', async () => {
    // Their decision, so their name on it — the agent executing it is what the
    // lease is for.
    const { app, token } = await harness();
    await claimViaTool(
      app,
      token,
      { projectId: PROJECT, workItemId: THEIRS },
      async () => 'approved',
    );
    await new Promise((r) => setImmediate(r));
    const assign = updates.find((u) => u.id === THEIRS && 'assignees' in u.body);
    expect(assign?.body['assignees']).toEqual([ME]);
    await app.close();
  });

  it('resolves the approving human against the workspace', () => {
    const actor = { principal: 'human:dana@example.com' } as Actor;
    expect(principalPlaneUser(actor, MEMBERS)).toBe(DANA);
  });

  it('gives up on a principal that is not an email rather than guessing', () => {
    const actor = { principal: 'human:alice' } as Actor;
    expect(principalPlaneUser(actor, MEMBERS)).toBeNull();
  });

  it('falls back to the raw id when a member is unknown', () => {
    expect(nameOf(MEMBERS, DANA)).toBe('Dana');
    expect(nameOf(MEMBERS, 'not-a-member')).toBe('not-a-member');
    expect(nameOf(MEMBERS, null)).toBe('nobody');
  });
});

describe('finishing work', () => {
  it('clears the assignee on complete, as release already did', async () => {
    // An assignee means somebody is on this, and once the work is reported done
    // nobody is. Leaving it made every finished item read as assigned-to-a-human,
    // which under this rule would withhold it forever.
    const plane = fakePlane();
    await mirrorComplete(plane, pool, {
      projectId: PROJECT,
      workItemId: MINE,
      actor: { holder: 'agent:t', principal: 'human:me@example.com', planeUserId: ME } as Actor,
      outcome: 'done',
      close: true,
    });
    expect(updates.find((u) => u.id === MINE)?.body['assignees']).toEqual([]);
  });
});

describe('marking what an agent wrote', () => {
  it('stamps a capture with the agent, since created_by records the human', async () => {
    // An agent minted from a personal token authenticates AS its owner, so Plane
    // records that person as created_by for everything the agent captures. This is
    // the only field that can say a machine wrote it. Informational: it gates
    // nothing.
    const { app, post } = await harness();
    const res = await post('/v1/capture', {
      projectId: PROJECT,
      title: 'something an agent noticed',
      body: 'enough for someone else to act on it without me',
    });
    expect(res.statusCode).toBe(200);
    expect(String(created[0]?.['external_source'])).toMatch(/^agent:t-asg-/);
    await app.close();
  });
});

/**
 * A yes stops meaning yes eventually.
 *
 * An approval recorded once made that item permanently takeable by anyone, with
 * no way to withdraw it — a decision somebody made in one moment still applying
 * long after they had stopped meaning it. Same shape as handing back work they
 * had just taken (SYNC-85), and it lived in the same item.
 */
describe('how long a takeover approval lasts', () => {
  const aged = async (workItemId: string, age: string) => {
    await approveTakeover(pool, { workItemId, approvedBy: 'human:me@example.com' });
    await pool.query(
      `update takeover_approval set created_at = now() - $2::interval where work_item_id = $1`,
      [workItemId, age],
    );
  };

  it('still counts a yes given moments ago', async () => {
    // Recorded before the claim is retried precisely so a compaction between the
    // yes and the claim does not lose it. One-shot semantics would put that
    // failure straight back, which is why this expires rather than being consumed.
    const id = randomUUID();
    await aged(id, '1 minute');
    expect(await approvedTakeovers(pool, [id])).toContain(id);
    expect(await takeoverApproval(pool, id)).not.toBeNull();
  });

  it('stops counting one from last week', async () => {
    const id = randomUUID();
    await aged(id, '7 days');
    expect(await approvedTakeovers(pool, [id])).not.toContain(id);
    expect(await takeoverApproval(pool, id)).toBeNull();
  });

  it('agrees between the browse path and the claim path', async () => {
    // Two queries deciding the same thing are two queries that will disagree, and
    // a browse that offers what claim then refuses is the defect this project has
    // already paid for twice.
    const id = randomUUID();
    await aged(id, '25 hours');
    const listed = (await approvedTakeovers(pool, [id])).has(id);
    const single = (await takeoverApproval(pool, id)) !== null;
    expect(listed).toBe(single);
    expect(listed).toBe(false);
  });
});
