import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { tryItemLock, withItemLock } from '../src/itemlock.js';

/**
 * Ordering Plane writes across gateway processes (SYNC-6).
 *
 * Mirror writes were chained per item in memory and nowhere else, so two
 * replicas serving one project could land a completion before the claim that
 * preceded it — leaving a finished item displaying "In Progress" forever, since
 * nothing recomputes it. The lease stayed correct throughout; the cost was that
 * the gateway could not be run redundantly, making it the single point of
 * failure for every agent.
 *
 * TWO POOLS, deliberately. A Postgres advisory lock is session-scoped, so a
 * single pool would prove nothing about the case that matters: one pool would
 * either reuse a connection or hit the in-process re-entrancy path, and both
 * would pass while two real replicas still raced. Each pool here stands in for a
 * replica.
 */
const url =
  process.env['GATEWAY_DATABASE_URL'] ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway';

const replicaA = createPool(url);
const replicaB = createPool(url);

afterAll(async () => {
  await Promise.all([replicaA.end(), replicaB.end()]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two gateway processes writing the same item', () => {
  it('does not let the second one start until the first has finished', async () => {
    const item = randomUUID();
    const order: string[] = [];

    const first = withItemLock(replicaA, item, async () => {
      order.push('A in');
      await sleep(150);
      order.push('A out');
    });
    // Late enough that A certainly holds it, early enough that B is genuinely
    // contending rather than arriving after the fact.
    await sleep(30);
    const second = withItemLock(replicaB, item, async () => {
      order.push('B in');
      order.push('B out');
    });

    await Promise.all([first, second]);
    // Interleaving is the whole defect: "A in, B in, B out, A out" is a
    // completion landing inside a claim's write sequence.
    expect(order).toEqual(['A in', 'A out', 'B in', 'B out']);
  });

  it('lets different items run at the same time', async () => {
    // The lock is keyed on the work item and must stay that way. Keyed on the
    // project, every agent in a busy project would queue behind every other one
    // — a cure worse than a display bug.
    const order: string[] = [];
    const slow = withItemLock(replicaA, randomUUID(), async () => {
      order.push('slow in');
      await sleep(120);
      order.push('slow out');
    });
    await sleep(20);
    await withItemLock(replicaB, randomUUID(), async () => order.push('fast'));
    await slow;

    expect(order).toEqual(['slow in', 'fast', 'slow out']);
  });

  it('releases the lock when the writer throws', async () => {
    // A mirror write that fails must not wedge the item for every later writer.
    // The lease would stay correct and the board would freeze, which is the
    // original bug made permanent.
    const item = randomUUID();
    await expect(
      withItemLock(replicaA, item, async () => {
        throw new Error('Plane said no');
      }),
    ).rejects.toThrow('Plane said no');

    let ran = false;
    await withItemLock(replicaB, item, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('the drain, which skips rather than waits', () => {
  it('does not run when another process is already writing that item', async () => {
    // Two replicas draw the same batch — the select has no FOR UPDATE SKIP
    // LOCKED — so both would replay the same intent and both would push
    // mirror_after forward. Skipping is safe because the row stays queued.
    const item = randomUUID();
    let drained = false;

    const holder = withItemLock(replicaA, item, () => sleep(150));
    await sleep(30);
    const ran = await tryItemLock(replicaB, item, async () => {
      drained = true;
    });

    expect(ran).toBe(false);
    expect(drained).toBe(false);
    await holder;
  });

  it('runs once the other process is done', async () => {
    const item = randomUUID();
    await withItemLock(replicaA, item, async () => {});
    expect(await tryItemLock(replicaB, item, async () => {})).toBe(true);
  });
});

describe('taking the lock again inside the same process', () => {
  it('does not deadlock against itself', async () => {
    // The drain takes an item's lock and then calls the mirror functions, which
    // go through serial() and take it again on a different connection. A
    // session-scoped advisory lock blocks forever on that, and the first version
    // of this deadlocked every drain test.
    const item = randomUUID();
    let inner = false;

    await tryItemLock(replicaA, item, async () => {
      await withItemLock(replicaA, item, async () => {
        inner = true;
      });
    });

    expect(inner).toBe(true);
  });

  it('still holds other processes out for the whole nested run', async () => {
    // Re-entrancy must not release early. If the inner exit dropped the lock,
    // the outer writer would finish unprotected — which is worse than no lock,
    // because it looks protected.
    const item = randomUUID();
    const order: string[] = [];

    const outer = withItemLock(replicaA, item, async () => {
      order.push('outer in');
      await withItemLock(replicaA, item, async () => sleep(120));
      order.push('outer out');
    });
    await sleep(40);
    const other = withItemLock(replicaB, item, async () => order.push('other'));

    await Promise.all([outer, other]);
    expect(order).toEqual(['outer in', 'outer out', 'other']);
  });
});
