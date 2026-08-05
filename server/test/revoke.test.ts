import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { claim, heartbeat } from '../src/lease.js';
import { PlaneClient } from '../src/plane.js';
import type { State, WorkItem } from '../src/plane.js';
import { reconcileLeases, revokeLease } from '../src/revoke.js';
import { mintWatch, pollWatch } from '../src/watch.js';

/**
 * What the board says, when it disagrees with the lease.
 *
 * Somebody opens Plane, unassigns an agent or closes an item, and reasonably
 * expects that to mean something. It meant nothing: the lease lived only in the
 * gateway, so the agent kept working and eventually submitted results against an
 * item its owner had moved on from -- and the person who intervened had no way to
 * know they had been ignored, which is the worse half, because doing it in Plane
 * was the whole reason they could see it at all.
 *
 * Two signals count and only two, because a revocation stops an agent mid-task:
 * the assignee is gone, or the item is closed. The tests that matter most here
 * are the ones about what must NOT revoke -- an outage, a missing field, a title
 * change -- since a false revocation is indistinguishable from the bug being
 * fixed.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const AGENT_USER = randomUUID();
const SOMEONE_ELSE = randomUUID();
/**
 * A token name and the holder string built from it, kept apart on purpose.
 *
 * `auth.ts` builds a holder as `agent:<token name>`, so a fixture that used one
 * string for both would join them together in a way production never does — and
 * that is exactly what hid a join here that matched nothing at all.
 */
const TOKEN_NAME = 't-rev/worker';
const HOLDER = `agent:${TOKEN_NAME}`;

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
  { id: 'done', name: 'Done', group: 'completed', default: false },
  { id: 'binned', name: 'Cancelled', group: 'cancelled', default: false },
];

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name: 'work',
  state: 'started',
  priority: 'medium',
  assignees: [AGENT_USER],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

interface Faults {
  list?: Error;
  states?: Error;
}

function fakePlane(items: WorkItem[], faults: Faults = {}): PlaneClient {
  return Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => {
      if (faults.list) throw faults.list;
      return items;
    },
    states: async () => {
      if (faults.states) throw faults.states;
      return STATES;
    },
  }) as unknown as PlaneClient;
}

/** A live, mirrored lease — the only kind reconcile looks at. */
async function heldItem(): Promise<string> {
  const workItemId = randomUUID();
  await claim(pool, {
    workItemId,
    projectId: PROJECT,
    holder: HOLDER,
    ttlSeconds: 600,
    sessionId: 's-1',
  });
  await pool.query('update lease set mirrored = true where work_item_id = $1', [workItemId]);
  return workItemId;
}

const stateOf = async (workItemId: string) => {
  const { rows } = await pool.query<{ state: string; end_reason: string | null }>(
    'select state, end_reason from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]!;
};

beforeEach(async () => {
  await pool.query('truncate lease');
  await pool.query('delete from agent_token where name = $1', [TOKEN_NAME]);
  // The agent's Plane identity is what an assignee list is checked against.
  await pool.query(
    `insert into agent_token (name, token_sha256, capabilities, plane_user_id, principal)
     values ($1, $2, '{}', $3, 'human:me@example.com')
     on conflict (name) do update set plane_user_id = excluded.plane_user_id`,
    [TOKEN_NAME, randomUUID().replace(/-/g, ''), AGENT_USER],
  );
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.query('delete from agent_token where name = $1', [TOKEN_NAME]);
  await pool.end();
});

describe('a human takes the work back', () => {
  it('revokes the lease when the agent is unassigned', async () => {
    const id = await heldItem();
    const revoked = await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);

    expect(revoked.map((r) => r.workItemId)).toEqual([id]);
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('revokes when the item is reassigned to somebody else', async () => {
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { assignees: [SOMEONE_ELSE] })]), pool);
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('revokes when the item is closed', async () => {
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { state: 'done' })]), pool);
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('revokes when the item is cancelled', async () => {
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { state: 'binned' })]), pool);
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('records a reason the agent can act on, not a code', async () => {
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);
    const { end_reason } = await stateOf(id);
    expect(end_reason).toMatch(/taken off you in Plane/i);
    expect(end_reason).toMatch(/do not submit/i);
  });

  it('distinguishes being unassigned from the item being closed', async () => {
    // Different human acts, and the agent should be able to tell which happened.
    const unassigned = await heldItem();
    const closed = await heldItem();
    await reconcileLeases(
      fakePlane([item(unassigned, { assignees: [] }), item(closed, { state: 'done' })]),
      pool,
    );
    expect((await stateOf(unassigned)).end_reason).toMatch(/taken off you/i);
    expect((await stateOf(closed)).end_reason).toMatch(/closed in Plane/i);
  });
});

describe('what must never revoke', () => {
  it('leaves a lease alone when the board agrees', async () => {
    const id = await heldItem();
    expect(await reconcileLeases(fakePlane([item(id)]), pool)).toEqual([]);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('ignores edits that say nothing about ownership', async () => {
    // A retitled, reprioritised, relabelled item is still the agent's.
    const id = await heldItem();
    await reconcileLeases(
      fakePlane([item(id, { name: 'renamed', priority: 'urgent', labels: ['x'] })]),
      pool,
    );
    expect((await stateOf(id)).state).toBe('held');
  });

  it('does not revoke because Plane was unreachable', async () => {
    // The failure that would matter most: an outage turning into every agent on
    // the board losing its work at once.
    const id = await heldItem();
    await reconcileLeases(fakePlane([], { list: new Error('plane 503') }), pool);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('treats a missing assignees field as unknown, not as nobody', async () => {
    // Plane omitting the field from a listing must never read as "unassigned".
    const id = await heldItem();
    const missing = item(id);
    delete (missing as { assignees?: string[] }).assignees;
    await reconcileLeases(fakePlane([missing]), pool);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('still checks assignees when the state list is unavailable', async () => {
    // Closure cannot be detected without it, but the other signal is unaffected
    // and silently dropping both would be a bigger hole.
    const id = await heldItem();
    await reconcileLeases(
      fakePlane([item(id, { assignees: [] })], { states: new Error('no states') }),
      pool,
    );
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('leaves an item absent from the listing alone', async () => {
    // Pagination, filters and permissions all produce the same silence, so
    // absence is not evidence. The TTL remains the backstop.
    const id = await heldItem();
    await reconcileLeases(fakePlane([]), pool);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('does not touch a lease Plane has not been told about yet', async () => {
    // A claim whose mirror has not landed looks exactly like one a human undid.
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder: HOLDER, ttlSeconds: 600 });
    await pool.query('update lease set mirrored = false where work_item_id = $1', [workItemId]);

    await reconcileLeases(fakePlane([item(workItemId, { assignees: [] })]), pool);
    expect((await stateOf(workItemId)).state).toBe('held');
  });

  it('does not revoke an agent with no Plane identity of its own', async () => {
    // There is no id to look for, so every listing would read as a revocation.
    await pool.query('update agent_token set plane_user_id = null where name = $1', [TOKEN_NAME]);
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { assignees: [SOMEONE_ELSE] })]), pool);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('leaves an already-expired lease to the sweeper', async () => {
    const id = await heldItem();
    await pool.query(`update lease set expires_at = now() - interval '1 minute' where work_item_id = $1`, [id]);
    await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);
    expect((await stateOf(id)).state).toBe('held'); // untouched; the sweeper expires it
  });

  it('does not revoke a lease that was re-claimed since the board was read', async () => {
    // The listing is a snapshot. Between reading it and writing, the item may
    // have been claimed again -- and revoking then takes work from a holder the
    // board was never consulted about.
    const id = await heldItem();
    const epochWhenRead = 1;
    // The re-claim lands first.
    await pool.query('update lease set epoch = epoch + 1 where work_item_id = $1', [id]);

    const revoked = await revokeLease(pool, id, epochWhenRead, 'taken off you');

    expect(revoked).toBe(false);
    expect((await stateOf(id)).state).toBe('held');
  });

  it('revokes when the epoch is still the one the board was read at', async () => {
    // The other half of the guard: it must not be so strict that nothing passes.
    const id = await heldItem();
    expect(await revokeLease(pool, id, 1, 'taken off you')).toBe(true);
    expect((await stateOf(id)).state).toBe('revoked');
  });
});

describe('how the agent finds out', () => {
  it('is told plainly on its next poll', async () => {
    const id = await heldItem();
    const raw = await mintWatch(pool, { sessionId: 's-1', workItemId: id });
    await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);

    const state = await pollWatch(pool, raw, 'https://gw.example');

    expect(state!.stale).toBe(true);
    expect(state!.say).toMatch(/taken off you in Plane/i);
  });

  it('is not handed the work back by the resume path', async () => {
    // A revoked lease is expired-looking. Reinstating it would undo a human's
    // decision, silently, on the next poll after a laptop woke up.
    const id = await heldItem();
    const raw = await mintWatch(pool, { sessionId: 's-1', workItemId: id });
    await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);

    await pollWatch(pool, raw, 'https://gw.example');
    expect((await stateOf(id)).state).toBe('revoked');
  });

  it('refuses the next write with REVOKED rather than "claim it again"', async () => {
    // LEASE_EXPIRED's advice is to re-claim, which here would undo the decision.
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { assignees: [] })]), pool);

    await expect(
      heartbeat(pool, { workItemId: id, holder: HOLDER, epoch: 1, ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'REVOKED' });
  });

  it('carries the human\'s reason into the refusal', async () => {
    const id = await heldItem();
    await reconcileLeases(fakePlane([item(id, { state: 'done' })]), pool);

    await expect(
      heartbeat(pool, { workItemId: id, holder: HOLDER, epoch: 1, ttlSeconds: 60 }),
    ).rejects.toThrow(/closed in Plane/i);
  });
});
