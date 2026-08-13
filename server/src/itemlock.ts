import type { Pool } from './db.js';

/**
 * One work item's Plane writes, serialised across every gateway process.
 *
 * Mirror writes were ordered within a single process and nowhere else, so two
 * replicas serving one project could land a completion before the claim that
 * preceded it and leave a finished item displaying as "In Progress" (SYNC-6).
 * The lease itself stayed correct — this is display, not coordination — but the
 * consequence was that the gateway could not be run redundantly at all, which
 * made it the single point of failure for every agent.
 *
 * A Postgres advisory lock rather than a version column, for two reasons. It
 * covers writers that have no row of their own to version — the drain replaying
 * a queued intent and a live claim are different code paths onto the same item —
 * and it needs no migration, so a replica running either build is safe beside
 * one running the other. The cost is that a lock is held across an HTTP call to
 * Plane, which is bounded by that client's own timeout and is the same exposure
 * the awaited mirror already had.
 *
 * Keyed on the work item, never the project: two agents working different items
 * in one project must not queue behind each other, and that is the normal case.
 *
 * `hashtextextended` gives the bigint the single-argument lock form wants.
 * Collisions across different uuids are possible and harmless — two unrelated
 * items would occasionally serialise, costing latency and nothing else.
 */
const KEY = 'hashtextextended($1, 0)';

/**
 * Items this process already holds, and how deep.
 *
 * A Postgres advisory lock is SESSION-scoped, so re-taking one from a second
 * connection in the same process blocks forever against itself. That is not
 * hypothetical: the drain takes an item's lock and then calls the mirror
 * functions, which go through `serial` and take it again. The first version
 * deadlocked every drain test.
 *
 * Re-entrancy is also the honest model. The thing being excluded is a second
 * WRITER, and inside one process the in-memory chain in serial.ts is already
 * doing that job — so a nested acquisition is the same logical writer reaching
 * the same item, not a competitor.
 */
const held = new WeakMap<Pool, Map<string, number>>();

/**
 * Per POOL, not per process, and the distinction is load-bearing.
 *
 * The deadlock this avoids is one pool's connection waiting on a lock another of
 * its own connections holds — which is exactly the drain nesting into serial(),
 * where both are handed the same pool. Two different pools are two genuinely
 * different lock sessions even inside one process, and must exclude each other,
 * or the guarantee would evaporate the moment anything held two pools. Keyed on
 * the process, the two-replica test below passes while excluding nothing.
 */
const mine = (pool: Pool): Map<string, number> => {
  let m = held.get(pool);
  if (!m) held.set(pool, (m = new Map()));
  return m;
};

const owns = (pool: Pool, id: string) => mine(pool).has(id);
const enter = (pool: Pool, id: string) => {
  const m = mine(pool);
  m.set(id, (m.get(id) ?? 0) + 1);
};
const leave = (pool: Pool, id: string) => {
  const m = mine(pool);
  const n = (m.get(id) ?? 1) - 1;
  if (n > 0) m.set(id, n);
  else m.delete(id);
};

/**
 * Run `fn` with this item's write lock held, waiting for it if necessary.
 *
 * For writers whose work cannot simply be dropped: a claim's mirror is awaited
 * and its failure hands the lease back, so skipping would turn contention into
 * a refused claim.
 *
 * The lock is session-scoped, so it must be taken and released on ONE
 * connection — hence the explicit checkout rather than `pool.query`. Releasing
 * in `finally` and returning the client in an outer `finally` is what keeps a
 * throw inside `fn` from leaking either.
 */
export async function withItemLock<T>(
  pool: Pool,
  workItemId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Already ours in this process: run it, and let the outermost holder do the
  // releasing. Taking it again from another connection would block on ourselves.
  if (owns(pool, workItemId)) return fn();

  const client = await pool.connect();
  enter(pool, workItemId);
  try {
    await client.query(`select pg_advisory_lock(${KEY})`, [workItemId]);
    try {
      return await fn();
    } finally {
      await client.query(`select pg_advisory_unlock(${KEY})`, [workItemId]);
    }
  } finally {
    leave(pool, workItemId);
    client.release();
  }
}

/**
 * Run `fn` only if nobody else is writing this item; otherwise do nothing.
 *
 * For the drain, where skipping is the right answer: another process holding the
 * lock is another process doing this exact work, and the row stays queued with
 * its backoff so a genuinely dropped write is picked up on the next sweep. Two
 * drains replaying the same intent is not merely wasteful — it is the reordering
 * this file exists to prevent, arriving from a second direction.
 *
 * Returns whether `fn` ran, so a caller can tell "skipped" from "did nothing".
 */
export async function tryItemLock(
  pool: Pool,
  workItemId: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (owns(pool, workItemId)) {
    await fn();
    return true;
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ got: boolean }>(
      `select pg_try_advisory_lock(${KEY}) as got`,
      [workItemId],
    );
    if (!rows[0]?.got) return false;
    enter(pool, workItemId);
    try {
      await fn();
      return true;
    } finally {
      leave(pool, workItemId);
      await client.query(`select pg_advisory_unlock(${KEY})`, [workItemId]);
    }
  } finally {
    client.release();
  }
}
