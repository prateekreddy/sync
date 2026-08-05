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
  /**
   * The client session taking this lease.
   *
   * Agents authenticate as the human running them, so every window that person
   * opens resolves to the same `holder`. Without this the gateway cannot tell two
   * concurrent sessions apart, and activity in one would keep the other's lease
   * alive -- the exact failure this design removes, reintroduced by the identity
   * simplification. Null for clients that do not report one; those fall back to
   * holder-level behaviour, which is today's semantics.
   */
  sessionId?: string | null;
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
       (work_item_id, project_id, holder, holder_chain, epoch, state, expires_at, session_id)
     values ($1, $2, $3, $4, 1, 'held', now() + make_interval(secs => $5), $6)
     on conflict (work_item_id) do update
        set holder       = excluded.holder,
            holder_chain = excluded.holder_chain,
            project_id   = excluded.project_id,
            session_id   = excluded.session_id,
            -- Cleared, not carried: the credential belongs to the session that
            -- held the lease, and a new claimant must not inherit the old
            -- monitor's ability to speak for this item. The previous session's
            -- next poll finds nothing, which is how it learns the work is gone.
            watch_sha256 = null,
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
    [
      opts.workItemId,
      opts.projectId,
      opts.holder,
      opts.holderChain ?? [],
      opts.ttlSeconds,
      opts.sessionId ?? null,
    ],
  );
  if (rows[0]) return toLease(rows[0]);

  // The statement above refused, which normally means somebody else holds it.
  // One case hiding in there is this caller's own lease: the 2026-07-28 MCP
  // revision dropped stream resumability, so a client whose connection breaks
  // mid-request re-issues it, and the honest answer to "did I get it?" is yes --
  // the claim landed, the reply is what was lost.
  //
  // Answered here rather than by widening the predicate above, so that the one
  // statement responsible for mutual exclusion keeps meaning exactly one thing.
  // This costs a round trip only on the path that was about to fail anyway, and
  // it stays correct when both copies of a retried request arrive at once: the
  // insert is still what decides, and the loser reads back the winner's row.
  return retryOf(pool, opts);
}

/**
 * Recognise a re-sent claim, and nothing else.
 *
 * The match is deliberately narrow, because the near-miss is dangerous. Agents
 * authenticate as the person running them, so `holder` is identical across every
 * window that person has open; matching on holder alone would let a second
 * session join the first one's lease with both believing they owned the item --
 * the collision this design exists to prevent, reintroduced as a convenience.
 *
 * So the session must be known and equal. A client that reports no session gets
 * today's behaviour, which is a refusal: degraded, never wrong. Treating null as
 * matching null would collapse every such client into one identity.
 */
async function retryOf(pool: Pool, opts: ClaimOpts): Promise<Lease | null> {
  if (!opts.sessionId) return null;
  const { rows } = await pool.query<Row>(
    `select ${RETURNING} from lease
      where work_item_id = $1
        and session_id   = $2
        and holder       = $3
        and state        = 'held'
        and expires_at   > now()`,
    [opts.workItemId, opts.sessionId, opts.holder],
  );
  // Returned exactly as it stands: same epoch, same claimed_at. Bumping the
  // epoch would invalidate work the agent has already done under it, and moving
  // claimed_at would push out the maximum-hold ceiling, so an agent that retried
  // often enough could hold an item indefinitely.
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

/**
 * Who holds these items right now, by work item id. Absent means nobody.
 *
 * "Live" is `state = 'held' and expires_at > now()`, and that predicate belongs
 * in exactly one place. It was written inline in the view builder and was about
 * to be written a third time; a lease that one caller counts as live and another
 * does not is two agents believing different things about the same item, which is
 * the one failure this table exists to prevent.
 *
 * Pass no ids for every live lease — what the view builder wants — or a list to
 * scope it.
 */
export async function liveHolders(
  pool: Pool,
  workItemIds?: string[],
): Promise<Map<string, { holder: string; expiresAt: Date }>> {
  const scoped = workItemIds !== undefined;
  if (scoped && workItemIds.length === 0) return new Map();

  const { rows } = await pool.query<{ work_item_id: string; holder: string; expires_at: Date }>(
    `select work_item_id, holder, expires_at from lease
      where state = 'held' and expires_at > now()
      ${scoped ? 'and work_item_id = any($1::uuid[])' : ''}`,
    scoped ? [workItemIds] : [],
  );
  return new Map(rows.map((r) => [r.work_item_id, { holder: r.holder, expiresAt: r.expires_at }]));
}

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
export interface LeaseRecord {
  workItemId: string;
  /** Claims ever made on this item. Monotonic, never reset, survives release. */
  claims: number;
  /** How many of those ended by lapsing rather than by an agent finishing. */
  expiries: number;
  state: string;
  holder: string | null;
  holderChain: string[];
  claimedAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
}

/**
 * What the lease knows about this item's past.
 *
 * A fold, not an event log. `lease` is one row per work item, upserted in place,
 * so prior holders and per-claim timings do not exist anywhere — `epoch` and
 * `expiry_count` are counters that survived the overwrites. That is enough for
 * the question worth asking before claiming ("has this killed agents before, and
 * how did the last attempt end?") and not enough for a timeline.
 *
 * Recording real events would mean writing on the claim path, and claim is
 * deliberately one atomic statement with no transaction — the foundation the
 * whole system rests on. Adding a second write there is a decision worth taking
 * on its own, not a side effect of wanting a report.
 */
export async function record(pool: Pool, workItemId: string): Promise<LeaseRecord | null> {
  const { rows } = await pool.query<{
    work_item_id: string;
    epoch: string;
    expiry_count: number;
    state: string;
    holder: string;
    holder_chain: string[];
    claimed_at: Date;
    heartbeat_at: Date;
    expires_at: Date;
    ended_at: Date | null;
    end_reason: string | null;
  }>(
    `select work_item_id, epoch, expiry_count, state, holder, holder_chain,
            claimed_at, heartbeat_at, expires_at, ended_at, end_reason
       from lease where work_item_id = $1`,
    [workItemId],
  );

  const r = rows[0];
  // No row means nobody has ever claimed it — a fact, not an error, and a
  // different answer from "claimed once and released".
  if (!r) return null;

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    workItemId: r.work_item_id,
    claims: Number(r.epoch),
    expiries: r.expiry_count,
    state: r.state,
    holder: r.holder,
    holderChain: r.holder_chain,
    claimedAt: iso(r.claimed_at),
    heartbeatAt: iso(r.heartbeat_at),
    expiresAt: iso(r.expires_at),
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
  };
}

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
