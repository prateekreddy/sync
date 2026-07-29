import type { Pool } from './db.js';
import { GatewayError } from './errors.js';

export type LeaseState = 'held' | 'released' | 'expired' | 'completed';

export interface Lease {
  workItemId: string;
  projectId: string;
  holder: string;
  holderChain: string[];
  epoch: number;
  state: LeaseState;
  claimedAt: Date;
  expiresAt: Date;
  heartbeatAt: Date;
}

interface Row {
  work_item_id: string;
  project_id: string;
  holder: string;
  holder_chain: string[];
  epoch: number;
  state: LeaseState;
  claimed_at: Date;
  expires_at: Date;
  heartbeat_at: Date;
}

const toLease = (r: Row): Lease => ({
  workItemId: r.work_item_id,
  projectId: r.project_id,
  holder: r.holder,
  holderChain: r.holder_chain,
  epoch: r.epoch,
  state: r.state,
  claimedAt: r.claimed_at,
  expiresAt: r.expires_at,
  heartbeatAt: r.heartbeat_at,
});

const RETURNING =
  'work_item_id, project_id, holder, holder_chain, epoch, state, claimed_at, expires_at, heartbeat_at';

export interface ClaimOpts {
  workItemId: string;
  projectId: string;
  holder: string;
  holderChain?: string[];
  ttlSeconds: number;
}

/**
 * Take an exclusive, time-bounded lease on one work item.
 *
 * The whole of mutual exclusion is this single statement. It is atomic without a
 * transaction or an explicit lock: either the INSERT wins, or the ON CONFLICT
 * fires and the WHERE decides whether the existing lease may be taken over.
 *
 * Expiry is evaluated inside the predicate, so an abandoned lease becomes
 * claimable the instant it lapses. Nothing depends on the sweeper having run --
 * the sweeper exists only to tidy Plane's UI, never for correctness.
 *
 * Returns null when a live lease already exists. That is a normal outcome under
 * contention, not an error: the caller simply tries the next candidate.
 */
export async function claim(pool: Pool, opts: ClaimOpts): Promise<Lease | null> {
  const { rows } = await pool.query<Row>(
    `insert into lease as l
       (work_item_id, project_id, holder, holder_chain, epoch, state, expires_at)
     values ($1, $2, $3, $4, 1, 'held', now() + make_interval(secs => $5))
     on conflict (work_item_id) do update
        set holder       = excluded.holder,
            holder_chain = excluded.holder_chain,
            project_id   = excluded.project_id,
            -- Monotonic across steals, and never reset. This is what makes a
            -- late-waking previous holder detectable instead of destructive.
            epoch        = l.epoch + 1,
            state        = 'held',
            claimed_at   = now(),
            heartbeat_at = now(),
            expires_at   = excluded.expires_at,
            ended_at     = null,
            end_reason   = null,
            mirrored     = false,
            expiry_count = case when l.state = 'expired'
                                then l.expiry_count else 0 end
      where l.state <> 'held' or l.expires_at <= now()
     returning ${RETURNING}`,
    [opts.workItemId, opts.projectId, opts.holder, opts.holderChain ?? [], opts.ttlSeconds],
  );
  return rows[0] ? toLease(rows[0]) : null;
}

/**
 * Try candidates in order and return the first successfully claimed.
 *
 * Deliberately a loop of atomic single-item claims rather than one clever
 * statement. Each attempt is independently correct, so contention degrades into
 * "try the next one" rather than into a subtle locking bug. Candidate lists are
 * small; clarity is worth more here than saving a round trip.
 */
export async function claimFirstOf(
  pool: Pool,
  candidates: Array<{ workItemId: string; projectId: string }>,
  opts: { holder: string; holderChain?: string[]; ttlSeconds: number },
): Promise<Lease | null> {
  for (const c of candidates) {
    const lease = await claim(pool, {
      workItemId: c.workItemId,
      projectId: c.projectId,
      holder: opts.holder,
      ...(opts.holderChain ? { holderChain: opts.holderChain } : {}),
      ttlSeconds: opts.ttlSeconds,
    });
    if (lease) return lease;
  }
  return null;
}

/**
 * Turn a failed epoch-guarded write into an error the agent can act on.
 *
 * Order matters. The epoch check comes first because it is the most consequential
 * outcome: it means the item was reclaimed while this agent was away, so whatever
 * the agent computed is derived from stale state and must be discarded rather
 * than written anywhere.
 */
async function explainFailure(
  pool: Pool,
  workItemId: string,
  holder: string,
  epoch: number,
): Promise<never> {
  const { rows } = await pool.query<Row>(
    `select ${RETURNING} from lease where work_item_id = $1`,
    [workItemId],
  );
  const row = rows[0];
  if (!row) throw new GatewayError('NOT_FOUND', `No lease for work item ${workItemId}`, { workItemId });

  if (row.epoch > epoch) {
    throw new GatewayError(
      'STALE_EPOCH',
      `Lease was reclaimed: you hold epoch ${epoch}, current is ${row.epoch}`,
      { workItemId, yourEpoch: epoch, currentEpoch: row.epoch, currentHolder: row.holder },
    );
  }
  if (row.holder !== holder) {
    throw new GatewayError('NOT_HOLDER', `Work item ${workItemId} is held by ${row.holder}`, {
      workItemId,
      currentHolder: row.holder,
    });
  }
  // Distinguish "your lease lapsed, claim it again" from "this lease is finished,
  // there is nothing more to do here" — the recovery advice is opposite.
  if (row.state === 'completed' || row.state === 'released') {
    throw new GatewayError('LEASE_ENDED', `Lease was already ${row.state}`, {
      workItemId,
      state: row.state,
    });
  }
  if (row.state !== 'held') {
    throw new GatewayError('LEASE_EXPIRED', `Lease is ${row.state}, not held`, {
      workItemId,
      state: row.state,
    });
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new GatewayError('LEASE_EXPIRED', `Lease expired at ${row.expires_at.toISOString()}`, {
      workItemId,
      expiredAt: row.expires_at,
    });
  }
  // Epoch ahead of the stored value means the caller invented one.
  throw new GatewayError('INVALID', `Epoch ${epoch} does not match ${row.epoch}`, {
    workItemId,
    currentEpoch: row.epoch,
  });
}

/** Extend a live lease. Fails rather than silently reviving an expired one. */
export async function heartbeat(
  pool: Pool,
  args: { workItemId: string; holder: string; epoch: number; ttlSeconds: number },
): Promise<Lease> {
  const { rows } = await pool.query<Row>(
    `update lease
        set heartbeat_at = now(),
            expires_at   = now() + make_interval(secs => $4)
      where work_item_id = $1
        and holder       = $2
        and epoch        = $3
        and state        = 'held'
        -- An expired lease must not be revivable: the item may already belong to
        -- someone else, and reviving it would create two live holders.
        and expires_at   > now()
     returning ${RETURNING}`,
    [args.workItemId, args.holder, args.epoch, args.ttlSeconds],
  );
  return rows[0] ? toLease(rows[0]) : explainFailure(pool, args.workItemId, args.holder, args.epoch);
}

async function end(
  pool: Pool,
  state: Extract<LeaseState, 'released' | 'completed'>,
  args: { workItemId: string; holder: string; epoch: number; reason?: string },
): Promise<Lease> {
  const { rows } = await pool.query<Row>(
    `update lease
        set state      = $4,
            ended_at   = now(),
            end_reason = $5,
            -- Released and completed leases are immediately re-claimable, so an
            -- item handed back does not sit idle until its TTL runs out.
            expires_at = now(),
            mirrored   = false
      where work_item_id = $1
        and holder       = $2
        and epoch        = $3
        and state        = 'held'
     returning ${RETURNING}`,
    [args.workItemId, args.holder, args.epoch, state, args.reason ?? null],
  );
  return rows[0] ? toLease(rows[0]) : explainFailure(pool, args.workItemId, args.holder, args.epoch);
}

/** Hand the item back to the pool. */
export const release = (
  pool: Pool,
  args: { workItemId: string; holder: string; epoch: number; reason?: string },
) => end(pool, 'released', args);

/** Terminal: the agent finished the work. */
export const complete = (
  pool: Pool,
  args: { workItemId: string; holder: string; epoch: number; reason?: string },
) => end(pool, 'completed', args);

/** What this agent currently holds — used when an agent restarts mid-task. */
export async function heldBy(pool: Pool, holder: string): Promise<Lease[]> {
  const { rows } = await pool.query<Row>(
    `select ${RETURNING} from lease
      where holder = $1 and state = 'held' and expires_at > now()
      order by claimed_at`,
    [holder],
  );
  return rows.map(toLease);
}

/**
 * Mark lapsed leases expired so the Plane-side mirror can be repaired.
 *
 * Correctness never depends on this running -- `claim` already treats a lapsed
 * lease as available. This exists so a dead agent's item does not sit in Plane
 * showing "In Progress" with an assignee that is never coming back.
 */
export async function sweepExpired(pool: Pool): Promise<Lease[]> {
  const { rows } = await pool.query<Row>(
    `update lease
        set state        = 'expired',
            ended_at     = now(),
            end_reason   = 'lease expired: no heartbeat',
            expiry_count = expiry_count + 1,
            mirrored     = false
      where state = 'held' and expires_at <= now()
     returning ${RETURNING}`,
  );
  return rows.map(toLease);
}
