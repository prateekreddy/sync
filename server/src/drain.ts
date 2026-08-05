/**
 * Retrying the Plane writes that failed.
 *
 * `mirrored = false` was documented as a retry queue for months and was never
 * one. Nothing selected on it, so a mirror write that failed simply stayed
 * failed: a completed item went on showing "In Progress" until a human noticed,
 * and every session that ended holding work left that work assigned to an agent
 * that was gone. This is the queue actually being drained — the mechanism
 * existed, was described as working, and nothing called it, which is the defect
 * this codebase keeps producing.
 *
 * The shape is an ordinary outbox. The intent is written to the lease row before
 * the attempt and cleared after Plane accepts it, so a crash in between costs a
 * repeat rather than a loss. Every mirror write is idempotent — set a state,
 * clear the assignees, add a comment — so a repeat is cheap and a loss is not.
 *
 * What this deliberately does not do is give up quietly. A write Plane refuses on
 * its merits (the item was deleted, the state no longer exists) would otherwise
 * be retried every thirty seconds forever, so attempts are bounded and the final
 * one says so at `error` rather than dropping the row and leaving the board wrong
 * with nothing in the log to explain it.
 */
import type { Pool } from './db.js';
import { log } from './log.js';
import { mirrorComplete, mirrorReturn, type MirrorIntent, type PortableActor } from './mirror.js';
import type { PlaneClient } from './plane.js';
import type { Actor } from './auth.js';

/**
 * How many times to try before giving up on one row.
 *
 * With the backoff below this spans roughly half an hour, which is long enough to
 * ride out a Plane restart or a deploy and short enough that a genuinely
 * impossible write stops shouting the same thing every half minute.
 */
export const MAX_ATTEMPTS = 6;

/** Exponential, capped. Per row, so one stuck item cannot hold up the queue. */
export const backoffSeconds = (attempt: number): number =>
  Math.min(30 * 2 ** attempt, 600);

/** How many rows one pass will take on, so a large backlog cannot stall a sweep. */
const BATCH = 25;

interface Row {
  work_item_id: string;
  project_id: string;
  pending_mirror: MirrorIntent;
  mirror_attempts: number;
}

export interface DrainResult {
  attempted: number;
  settled: number;
  abandoned: number;
}

/**
 * Replay whatever is owed and due.
 *
 * Success is measured by the row having been cleared, not by the mirror function
 * returning — those functions swallow their own failures by design, so their
 * completing tells us nothing about whether Plane accepted anything.
 */
export async function drainMirrors(
  plane: PlaneClient,
  pool: Pool,
): Promise<DrainResult> {
  const { rows } = await pool.query<Row>(
    `select work_item_id, project_id, pending_mirror, mirror_attempts
       from lease
      where pending_mirror is not null
        and (mirror_after is null or mirror_after <= now())
      order by mirror_after nulls first
      limit ${BATCH}`,
  );

  const result: DrainResult = { attempted: 0, settled: 0, abandoned: 0 };

  for (const row of rows) {
    const intent = row.pending_mirror;
    result.attempted += 1;

    // Counted before the attempt, not after. Counting afterwards means a write
    // that throws somewhere unexpected never increments, and the row is retried
    // forever — which is the failure mode a retry limit exists to prevent.
    const attempts = row.mirror_attempts + 1;
    await pool.query(
      `update lease
          set mirror_attempts = $2,
              mirror_after    = now() + make_interval(secs => $3)
        where work_item_id = $1`,
      [row.work_item_id, attempts, backoffSeconds(attempts)],
    );

    try {
      await replay(plane, pool, row.work_item_id, intent);
    } catch (err) {
      log.warn({ err, workItemId: row.work_item_id, kind: intent.kind }, 'mirror retry threw');
    }

    const cleared = await isSettled(pool, row.work_item_id);
    if (cleared) {
      result.settled += 1;
      log.info(
        { workItemId: row.work_item_id, kind: intent.kind, attempts },
        'queued plane write finally landed',
      );
      continue;
    }

    if (attempts >= MAX_ATTEMPTS) {
      await pool.query(
        'update lease set pending_mirror = null, mirror_after = null where work_item_id = $1',
        [row.work_item_id],
      );
      result.abandoned += 1;
      // Loud, and at error: the board is now wrong in a way nothing will fix on
      // its own, and this line is the only record that it happened.
      log.error(
        { workItemId: row.work_item_id, projectId: row.project_id, kind: intent.kind, attempts },
        'giving up on a plane write; the board is out of date for this item and needs a human',
      );
    }
  }

  return result;
}

async function isSettled(pool: Pool, workItemId: string): Promise<boolean> {
  const { rows } = await pool.query<{ pending: boolean }>(
    'select pending_mirror is null as pending from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]?.pending ?? false;
}

/**
 * Run the intent again through the same function that recorded it.
 *
 * Going back through `mirrorComplete` / `mirrorReturn` rather than reimplementing
 * their writes here is the point: a retry that drifts from the original is worse
 * than no retry, because it produces a board state nobody has ever reviewed.
 */
async function replay(
  plane: PlaneClient,
  pool: Pool,
  workItemId: string,
  intent: MirrorIntent,
): Promise<void> {
  if (intent.kind === 'return') {
    await mirrorReturn(plane, pool, {
      projectId: intent.projectId,
      workItemId,
      reason: intent.reason,
      holder: intent.holder,
      ...(intent.expiryCount === undefined ? {} : { expiryCount: intent.expiryCount }),
    });
    return;
  }

  await mirrorComplete(plane, pool, {
    projectId: intent.projectId,
    workItemId,
    actor: rehydrate(intent.actor),
    outcome: intent.outcome,
    close: intent.close,
    ...(intent.labels?.length ? { labels: intent.labels } : {}),
  });
}

/**
 * The stored actor, as the mirror functions expect one.
 *
 * `planeToken` is absent on purpose — it was never stored — so the retry writes
 * as the gateway's service account and `actorNote` takes its "no token of its
 * own" branch, which names both the agent and the human it acted for. That is
 * the honest rendering of what happened: this comment really was posted by the
 * gateway, later, on the agent's behalf.
 */
const rehydrate = (a: PortableActor): Actor =>
  ({
    holder: a.holder,
    principal: a.principal,
    planeUserId: a.planeUserId,
    capabilities: [],
  }) as unknown as Actor;
