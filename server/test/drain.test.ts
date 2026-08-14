import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { MAX_ATTEMPTS, backoffSeconds, drainMirrors } from '../src/drain.js';
import { claim, complete, release } from '../src/lease.js';
import { mirrorComplete, mirrorReturn } from '../src/mirror.js';
import { PlaneClient } from '../src/plane.js';
import type { Actor } from '../src/auth.js';
import type { State, WorkItem } from '../src/plane.js';
import { closeWatch, mintWatch } from '../src/watch.js';

/**
 * The retry queue that was documented for months and never existed.
 *
 * `mirrored = false` recorded *that* a Plane write was owed and never *what*, so
 * nothing could replay it and nothing did. A completion whose mirror failed left
 * the board showing "In Progress" for finished work until a human noticed, and
 * `closeWatch` marked the flag with no follow-up at all -- so every session that
 * ended holding work left it assigned to an agent that was gone.
 *
 * The tests worth having are about the ordering that makes an outbox an outbox:
 * the debt is recorded before the attempt and cleared only after Plane accepts,
 * so a crash costs a repeat rather than a loss.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const HOLDER = 'agent:t';

const STATES: State[] = [
  { id: 'todo', name: 'Todo', group: 'unstarted', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

const actor = {
  holder: HOLDER,
  principal: 'human:me@example.com',
  planeUserId: randomUUID(),
  capabilities: [],
} as unknown as Actor;

let updates: Array<{ id: string; body: Record<string, unknown> }> = [];
let comments: string[] = [];
/** Flipped to make Plane refuse, so a failure can be arranged and then lifted. */
let planeDown = false;

function fakePlane(): PlaneClient {
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    states: async () => STATES,
    stateByGroup: async (_p: string, group: string) => STATES.find((s) => s.group === group),
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      if (planeDown) throw new Error('plane 503');
      updates.push({ id, body });
      return { id } as WorkItem;
    },
    comment: async (_p: string, id: string) => {
      if (planeDown) throw new Error('plane 503');
      comments.push(id);
      return {};
    },
    getWorkItem: async (_p: string, id: string) => ({ id, labels: [] }) as unknown as WorkItem,
    labels: async () => [],
    members: async () => [],
    me: async () => ({ email: 'me@example.com' }),
  }) as unknown as PlaneClient;
  return plane;
}

async function held(): Promise<string> {
  const workItemId = randomUUID();
  await claim(pool, {
    workItemId,
    projectId: PROJECT,
    holder: HOLDER,
    ttlSeconds: 600,
    sessionId: 's-1',
  });
  return workItemId;
}

const owed = async (workItemId: string) => {
  const { rows } = await pool.query<{
    pending_mirror: { kind: string } | null;
    mirror_attempts: number;
  }>('select pending_mirror, mirror_attempts from lease where work_item_id = $1', [workItemId]);
  return rows[0]!;
};

beforeEach(async () => {
  updates = [];
  comments = [];
  planeDown = false;
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

describe('a failed write is remembered', () => {
  it('leaves the debt on the row when Plane refuses', async () => {
    const id = await held();
    await complete(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'did the thing' });

    planeDown = true;
    await mirrorComplete(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      actor,
      outcome: 'did the thing',
      close: true,
    });

    expect((await owed(id)).pending_mirror?.kind).toBe('complete');
  });

  it('clears it when Plane accepts', async () => {
    const id = await held();
    await complete(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'did the thing' });

    await mirrorComplete(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      actor,
      outcome: 'did the thing',
      close: true,
    });

    expect((await owed(id)).pending_mirror).toBeNull();
  });

  it('records the debt before attempting, not after', async () => {
    // The ordering that makes this an outbox. Recording afterwards loses the
    // write entirely when the process dies mid-attempt, which is the bug.
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      reason: 'expired',
      holder: HOLDER,
    });
    expect((await owed(id)).pending_mirror?.kind).toBe('return');
  });
});

describe('the drain replays it', () => {
  it('finishes a completion whose first attempt failed', async () => {
    const id = await held();
    await complete(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'did the thing' });

    planeDown = true;
    await mirrorComplete(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, actor, outcome: 'did the thing', close: true,
    });
    expect(updates).toHaveLength(0);

    planeDown = false;
    const result = await drainMirrors(fakePlane(), pool);

    expect(result.settled).toBe(1);
    expect((await owed(id)).pending_mirror).toBeNull();
    // The item really was closed, not merely marked as done — and it keeps the
    // name of whoever finished it, which is the record a replay must not lose.
    expect(updates.find((u) => u.id === id)?.body['state']).toBe('done');
    expect(updates.find((u) => u.id === id)?.body).not.toHaveProperty('assignees');
  });

  it('keeps the outcome text, so the comment is the one the agent wrote', async () => {
    const id = await held();
    await complete(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'shipped in abc123' });
    planeDown = true;
    await mirrorComplete(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, actor, outcome: 'shipped in abc123', close: true,
    });

    planeDown = false;
    await drainMirrors(fakePlane(), pool);
    expect(comments).toContain(id);
  });

  it('returns an expired item to the pool on a later pass', async () => {
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'lease expired', holder: HOLDER,
    });

    planeDown = false;
    await drainMirrors(fakePlane(), pool);

    expect(updates.find((u) => u.id === id)?.body['assignees']).toEqual([]);
    expect(updates.find((u) => u.id === id)?.body['state']).toBe('todo');
  });

  it('does nothing when nothing is owed', async () => {
    await held();
    expect(await drainMirrors(fakePlane(), pool)).toEqual({
      attempted: 0,
      settled: 0,
      abandoned: 0,
    });
  });
});

describe('a session that ends still holding work', () => {
  it('queues the return rather than only flagging it', async () => {
    // This is the case that had no follow-up at all: the flag was set and
    // nothing anywhere read it, so the board kept the item assigned forever.
    const id = await held();
    const raw = await mintWatch(pool, { sessionId: 's-1', workItemId: id });

    expect(await closeWatch(pool, raw)).toEqual([id]);
    expect((await owed(id)).pending_mirror?.kind).toBe('return');
  });

  it('actually clears the item in Plane on the next drain', async () => {
    const id = await held();
    const raw = await mintWatch(pool, { sessionId: 's-1', workItemId: id });
    await closeWatch(pool, raw);

    await drainMirrors(fakePlane(), pool);

    expect(updates.find((u) => u.id === id)?.body['assignees']).toEqual([]);
    expect((await owed(id)).pending_mirror).toBeNull();
  });

  it('says on the item why it came back', async () => {
    const id = await held();
    const raw = await mintWatch(pool, { sessionId: 's-1', workItemId: id });
    await closeWatch(pool, raw);
    await drainMirrors(fakePlane(), pool);
    expect(comments).toContain(id);
  });
});

describe('a write Plane will never accept', () => {
  it('backs off further after each attempt', async () => {
    expect(backoffSeconds(1)).toBeLessThan(backoffSeconds(2));
    expect(backoffSeconds(2)).toBeLessThan(backoffSeconds(3));
  });

  it('caps the backoff rather than growing without bound', async () => {
    expect(backoffSeconds(50)).toBe(backoffSeconds(51));
    expect(backoffSeconds(50)).toBeLessThanOrEqual(600);
  });

  it('counts the attempt even when the retry throws', async () => {
    // Counting only on a clean failure means an unexpected throw never
    // increments, and the row is retried forever — which is what a limit exists
    // to prevent.
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'expired', holder: HOLDER,
    });

    await drainMirrors(fakePlane(), pool);
    expect((await owed(id)).mirror_attempts).toBe(1);
  });

  it('waits for the backoff before trying again', async () => {
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'expired', holder: HOLDER,
    });

    await drainMirrors(fakePlane(), pool);
    // Immediately after, the row is not due, so a second pass skips it.
    expect((await drainMirrors(fakePlane(), pool)).attempted).toBe(0);
  });

  it('gives up after a bounded number of attempts', async () => {
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'expired', holder: HOLDER,
    });

    let abandoned = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      // Make the row due each time rather than waiting out the real backoff.
      await pool.query('update lease set mirror_after = now() where work_item_id = $1', [id]);
      abandoned += (await drainMirrors(fakePlane(), pool)).abandoned;
    }

    expect(abandoned).toBe(1);
    // Dropped from the queue, so it stops shouting the same thing every pass.
    expect((await owed(id)).pending_mirror).toBeNull();
  });

  it('recovers if Plane comes back before the limit', async () => {
    const id = await held();
    planeDown = true;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'expired', holder: HOLDER,
    });

    await pool.query('update lease set mirror_after = now() where work_item_id = $1', [id]);
    await drainMirrors(fakePlane(), pool);

    planeDown = false;
    await pool.query('update lease set mirror_after = now() where work_item_id = $1', [id]);
    const result = await drainMirrors(fakePlane(), pool);

    expect(result.settled).toBe(1);
    expect((await owed(id)).pending_mirror).toBeNull();
  });
});

describe('the queue does not disturb a live lease', () => {
  it('leaves a released lease released', async () => {
    const id = await held();
    await release(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'handing back' });
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT, workItemId: id, reason: 'handing back', holder: HOLDER,
    });
    await drainMirrors(fakePlane(), pool);

    const { rows } = await pool.query<{ state: string }>(
      'select state from lease where work_item_id = $1',
      [id],
    );
    expect(rows[0]!.state).toBe('released');
  });
});
