import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import {
  claim,
  claimFirstOf,
  complete,
  heartbeat,
  heldBy,
  release,
  sweepExpired,
} from '../src/lease.js';

const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ??
    'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.end();
});

describe('claim', () => {
  it('grants the item to exactly one of many simultaneous agents', async () => {
    // This is the scenario the client-side read-back protocol fails: N agents
    // racing for the same item at the same instant. See docs/race.py.
    const workItemId = randomUUID();
    const agents = Array.from({ length: 20 }, (_, i) => `agent:${i}`);

    const results = await Promise.all(
      agents.map((holder) => claim(pool, { workItemId, projectId: PROJECT, holder, ttlSeconds: 60 })),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.epoch).toBe(1);

    // And Plane-side truth agrees there is exactly one holder.
    const { rows } = await pool.query('select holder, epoch from lease where work_item_id = $1', [
      workItemId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBe(winners[0]!.holder);
  });

  it('hands distinct items to concurrent agents rather than colliding', async () => {
    const items = Array.from({ length: 8 }, () => ({
      workItemId: randomUUID(),
      projectId: PROJECT,
    }));
    const agents = Array.from({ length: 8 }, (_, i) => `agent:${i}`);

    const leases = await Promise.all(
      agents.map((holder) => claimFirstOf(pool, items, { holder, ttlSeconds: 60 })),
    );

    const got = leases.filter((l) => l !== null);
    expect(got).toHaveLength(8);
    // No item handed out twice.
    expect(new Set(got.map((l) => l!.workItemId)).size).toBe(8);
  });

  it('refuses an item that is already held', async () => {
    const workItemId = randomUUID();
    expect(await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60 })).not.toBeNull();
    expect(await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 })).toBeNull();
  });

  it('allows reclaim once the lease lapses, without the sweeper running', async () => {
    // Correctness must not depend on the sweeper. Expiry is evaluated in the
    // claim predicate itself.
    const workItemId = randomUUID();
    const first = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.3 });
    expect(first!.epoch).toBe(1);

    expect(await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 })).toBeNull();
    await sleep(400);

    const second = await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 });
    expect(second).not.toBeNull();
    expect(second!.holder).toBe('b');
    expect(second!.epoch).toBe(2); // monotonic across the steal
  });

  it('makes a released item immediately claimable', async () => {
    const workItemId = randomUUID();
    const l = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 3600 });
    await release(pool, { workItemId, holder: 'a', epoch: l!.epoch, reason: 'blocked' });

    const next = await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 });
    expect(next).not.toBeNull();
    expect(next!.epoch).toBe(2);
  });
});

describe('fencing', () => {
  it('rejects a late-waking agent whose item was reclaimed', async () => {
    // The failure that silently corrupts state without a fencing token: agent A
    // stalls, its lease lapses, agent B picks the item up, then A wakes and tries
    // to write results derived from stale context.
    const workItemId = randomUUID();
    const a = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.3 });
    await sleep(400);
    const b = await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 });
    expect(b!.epoch).toBe(2);

    // A wakes up and tries to finish.
    await expect(
      complete(pool, { workItemId, holder: 'a', epoch: a!.epoch, reason: 'done' }),
    ).rejects.toMatchObject({ code: 'STALE_EPOCH' });

    // B's lease is untouched.
    const still = await heldBy(pool, 'b');
    expect(still).toHaveLength(1);
    expect(still[0]!.epoch).toBe(2);
  });

  it('tells the late agent to discard its work, not retry', async () => {
    const workItemId = randomUUID();
    const a = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.3 });
    await sleep(400);
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 });

    const err = await complete(pool, { workItemId, holder: 'a', epoch: a!.epoch })
      .then(() => null)
      .catch((e: GatewayError) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect(err!.detail).toMatchObject({ yourEpoch: 1, currentEpoch: 2, currentHolder: 'b' });
  });

  it('refuses a non-holder even with a valid-looking epoch', async () => {
    const workItemId = randomUUID();
    const l = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60 });
    await expect(
      release(pool, { workItemId, holder: 'impostor', epoch: l!.epoch }),
    ).rejects.toMatchObject({ code: 'NOT_HOLDER' });
  });
});

describe('heartbeat', () => {
  it('extends a live lease', async () => {
    const workItemId = randomUUID();
    const l = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 1 });
    await sleep(200);
    const beat = await heartbeat(pool, { workItemId, holder: 'a', epoch: l!.epoch, ttlSeconds: 60 });
    expect(beat.expiresAt.getTime()).toBeGreaterThan(l!.expiresAt.getTime());
  });

  it('will not revive an expired lease', async () => {
    // Reviving would produce two live holders if the item was already reclaimed,
    // so an expired lease is terminal for its holder.
    const workItemId = randomUUID();
    const l = await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.3 });
    await sleep(400);
    await expect(
      heartbeat(pool, { workItemId, holder: 'a', epoch: l!.epoch, ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
  });
});

describe('sweeper', () => {
  it('marks lapsed leases expired and counts repeat offenders', async () => {
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.2 });
    await sleep(300);

    const swept = await sweepExpired(pool);
    expect(swept.map((l) => l.workItemId)).toContain(workItemId);

    // An item that keeps killing its agent accumulates evidence.
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 0.2 });
    await sleep(300);
    await sweepExpired(pool);

    const { rows } = await pool.query('select expiry_count from lease where work_item_id = $1', [
      workItemId,
    ]);
    expect(rows[0].expiry_count).toBe(2);
  });

  it('is not required for correctness', async () => {
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 0.2 });
    await sleep(300);
    // No sweep call at all.
    expect(await claim(pool, { workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60 })).not.toBeNull();
  });
});
