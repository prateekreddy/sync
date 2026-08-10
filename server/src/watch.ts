/**
 * The credential a background process polls with, and the liveness it produces.
 *
 * Keeping a claim alive used to be the agent's job — call `heartbeat` or lose the
 * lease. That failed the way obligations-for-later always fail: an agent worked
 * for an hour without calling it, the lease lapsed, another agent took the item,
 * and the two collided. A model has no clock and forgets its own history at every
 * compaction, so anything it must do *later* is something it will eventually not
 * do.
 *
 * So liveness moved out of the model and into a process. The plugin runs a
 * monitor for the life of the session; it polls this endpoint; the poll is the
 * heartbeat. Nothing is asked of the agent beyond the `claim` it already makes.
 *
 * The monitor is a separate OS process and cannot reach the OAuth token Claude
 * Code holds, so `claim` hands back a capability URL instead: possession is
 * authorisation. That is only safe because of how little it can do — extend this
 * session's leases and report on them. It cannot claim, complete, capture, or
 * read a work item. Its lifetime is generous precisely because its powers are
 * not, and it is bound to a session so it can never speak for another one.
 *
 * Only the hash is stored. The raw value is returned at mint and on every
 * rotation, and must never be logged: the URL *is* the password.
 *
 * The case that motivated all of this is a closed laptop. No hook fires — the
 * session suspends rather than ending — so nothing can announce the gap. The
 * monitor suspends and resumes with the machine, which makes its first poll
 * after a gap the resume signal, and this is where that is handled: either the
 * lapsed lease is reinstated because nobody took the work, or the agent is told
 * plainly that somebody did.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from './db.js';

/**
 * How long a capability survives without being used.
 *
 * Measured from the last poll, not from the mint — every rotation pushes it out
 * again. It was fixed at mint until 2026-08-10, which made it a ceiling on the
 * whole session rather than an idle timeout, and expiry is indistinguishable at
 * this endpoint from having the work taken away.
 */
export const WATCH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ceiling on activity-extension, measured from the original claim.
 *
 * Derived liveness has one failure mode: an agent stuck in a loop keeps calling
 * the gateway and therefore keeps its lease forever, holding work hostage while
 * making no progress. This is the bound that ends that. It is not a deadline for
 * honest work — it is the point past which "still calling" stops being evidence
 * of "still working".
 */
export const MAX_HOLD_MS = 4 * 60 * 60 * 1000;

/** How far each poll pushes the lease out. Short, because polls are frequent. */
export const EXTEND_S = 600;

/**
 * How long a credential a poll just retired is still accepted.
 *
 * Every poll rotates, so a caller that polled and then failed to store the
 * replacement — a crash between the GET and the write, or two hooks polling at
 * the same instant — is left one rotation behind. Without this, being one
 * rotation behind was indistinguishable from having had the work taken away,
 * because both matched no row and both were answered 410. The push fence treats
 * 410 as a verdict, so the check manufactured the evidence it acted on: pushes
 * refused, correct work declared not yours.
 *
 * Longer than the monitor's poll interval so a stale caller always gets a chance
 * to catch up, and short because this is a bearer credential — accepting a
 * retired one widens how long a leaked URL keeps working.
 */
export const WATCH_GRACE_S = 300;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface WatchState {
  /** The URL to poll next. Rotated every time, so a captured URL ages out fast. */
  watchUrl: string;
  /** What this session holds, for a resumed session that has forgotten. */
  holding?: string;
  /** True when this session's work is no longer its own. The push fence reads this. */
  stale?: boolean;
  /** A line for the human or agent. The monitor relays it verbatim. */
  say?: string;
}

/**
 * Issue a capability covering everything one session holds. Returns the raw
 * value, once.
 *
 * The new credential is stamped onto the item just claimed *and* onto every
 * lease this session already holds, which retires the previous one everywhere.
 * That is what keeps a session down to exactly one credential.
 *
 * Minting per item instead would be quietly broken: `claim` hands the URL back
 * for a hook to store, and a second claim would overwrite the stored value, so
 * the monitor could only ever poll the most recent item. The first would stop
 * being heartbeated and lapse while the agent was still working it — an agent
 * losing a lease it never let go of, which is the failure this design removes.
 *
 * A session id is required for that grouping. Clients that do not report one
 * fall back to a per-item credential, which is degraded but not wrong: such a
 * client has no way to hold two leases at once under one monitor anyway.
 */
export async function mintWatch(
  pool: Pool,
  args: { sessionId: string | null; workItemId: string },
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `update lease
        set watch_sha256      = $2,
            -- A freshly minted credential supersedes everything, including
            -- whatever the last rotation was still honouring. Leaving a previous
            -- value here would keep an older URL alive past a new claim.
            watch_prev_sha256 = null,
            watch_prev_at     = null,
            watch_expires_at  = now() + make_interval(secs => $3)
      where work_item_id = $1
         or ($4::text is not null
             and session_id = $4
             and state = 'held'
             and expires_at > now())`,
    [args.workItemId, sha256(raw), WATCH_TTL_MS / 1000, args.sessionId],
  );
  return raw;
}

interface Row {
  work_item_id: string;
  session_id: string | null;
  state: string;
  epoch: number;
  claimed_at: Date;
  expires_at: Date;
  end_reason: string | null;
}

/**
 * One poll: prove the session is alive, and say what changed.
 *
 * Returns null when the capability is unknown or spent — the caller answers 410.
 * That case is load-bearing rather than an error path: when another session
 * claims the same item, its `claim` clears this row's credential, so the old
 * monitor's next poll finds nothing. A 410 therefore means "this work is
 * definitively not yours any more", which is exactly what the push fence must
 * refuse on. It is *not* the same as being unable to reach the gateway, and
 * callers must not conflate the two: one is a verdict, the other is ignorance,
 * and only the verdict may block a push.
 *
 * A *superseded* credential is deliberately not in that set any more, and this
 * is the correction that matters. Every poll rotates, so a caller that polled and
 * lost the replacement holds the previous value — and answering that with the
 * same 410 made "you are one rotation behind" indistinguishable from "somebody
 * took your work". The fence acted on it: pushes refused, correct work declared
 * not yours, on evidence the check produced itself. The previous value is now
 * accepted for WATCH_GRACE_S, and only `claim` and `closeWatch` clear it — which
 * is what keeps a genuine theft answering 410.
 */
export async function pollWatch(
  pool: Pool,
  raw: string,
  publicUrl: string,
): Promise<WatchState | null> {
  const hash = sha256(raw);
  const { rows } = await pool.query<Row>(
    `select work_item_id, session_id, state, epoch, claimed_at, expires_at, end_reason
       from lease
      where watch_expires_at > now()
        and ( watch_sha256 = $1
              -- One rotation behind is not theft. See WATCH_GRACE_S: a caller
              -- that polled and lost the replacement used to be answered exactly
              -- as if somebody else had taken its work.
              or ( watch_prev_sha256 = $1
                   and watch_prev_at > now() - make_interval(secs => $2) ) )`,
    [hash, WATCH_GRACE_S],
  );
  if (rows.length === 0) return null;

  const say: string[] = [];
  const holding: string[] = [];
  let stale = false;

  for (const row of rows) {
    // Taken back in Plane while the agent was working. This is the one ending it
    // cannot find out about any other way — nobody told it, and from inside the
    // conversation nothing looks different — so it is said plainly and the reason
    // a human's action produced is passed through verbatim.
    if (row.state === 'revoked') {
      stale = true;
      say.push(row.end_reason ?? `${row.work_item_id} is no longer yours — stop and discard that work.`);
      continue;
    }

    // Finished on purpose, by this session. Not a lapse and not a theft, so
    // neither reinstate it nor cry stale — the agent already knows, and telling
    // it to "discard that work" after a successful complete would be a lie that
    // costs real work. Skipped silently; `closeWatch` and the next claim are what
    // clear the credential.
    if (row.state === 'completed' || row.state === 'released') continue;

    const lapsed = row.state !== 'held' || row.expires_at.getTime() <= Date.now();
    const capped = Date.now() - row.claimed_at.getTime() > MAX_HOLD_MS;

    if (!lapsed && !capped) {
      // The heartbeat. Deliberately not conditional on anything the agent said or
      // did beyond being alive enough to be polled for.
      await pool.query(
        `update lease
            set heartbeat_at = now(),
                expires_at   = now() + make_interval(secs => $2)
          where work_item_id = $1 and state = 'held'`,
        [row.work_item_id, EXTEND_S],
      );
      holding.push(row.work_item_id);
      continue;
    }

    if (!lapsed && capped) {
      // Still nominally held, but past the ceiling. Say so rather than letting it
      // lapse silently, because from the agent's side this looks identical to
      // working normally right up until the lease is gone.
      stale = true;
      say.push(
        `You have held ${row.work_item_id} for over ${Math.round(MAX_HOLD_MS / 3600000)} hours. ` +
          `Finish it or release it — activity alone will not keep it any longer.`,
      );
      continue;
    }

    // Lapsed. The laptop case: nobody took the work while we were away, so give
    // it back rather than making the agent rediscover it. The epoch is kept on
    // purpose — anything done before the gap is still done under this epoch, and
    // bumping it would invalidate work that was never actually contended.
    const { rowCount } = await pool.query(
      `update lease
          set state        = 'held',
              -- The hold starts again here, and this is not bookkeeping.
              --
              -- MAX_HOLD_MS is measured from claimed_at, and it exists because
              -- "still polling" stops being evidence of "still working". A gap
              -- is the opposite: positive evidence that nobody was working. Left
              -- at the original claim, a laptop closed at six and opened at nine
              -- the next morning came back fifteen hours over the ceiling, so
              -- the poll that restored the work was followed two minutes later
              -- by one declaring it forfeit — with stale set, which is what the
              -- push fence refuses on. Restored, then blocked from pushing it,
              -- in a loop every ten minutes.
              claimed_at   = now(),
              expires_at   = now() + make_interval(secs => $2),
              heartbeat_at = now(),
              ended_at     = null,
              end_reason   = null
        where work_item_id = $1
          and watch_sha256 = $3
          -- Expired or lapsed only. A finished or revoked lease is excluded here
          -- as well as above: this statement is the actual guard, and a reinstate
          -- that reopened a completed item, or handed back one a human had just
          -- taken away, would be silent and unrecoverable.
          and state not in ('completed', 'released', 'revoked')
          and (state <> 'held' or expires_at <= now())`,
      [row.work_item_id, EXTEND_S, hash],
    );

    if (rowCount && rowCount > 0) {
      holding.push(row.work_item_id);
      say.push(`Your lease on ${row.work_item_id} had lapsed, but nobody took it. Restored.`);
    } else {
      stale = true;
      say.push(`${row.work_item_id} is no longer yours — stop and discard that work.`);
    }
  }

  // Rotate, keeping what was just retired. The match is on either column for the
  // same reason the select above is: a caller arriving with the previous value is
  // legitimate, and rotating only on an exact current match would leave it stuck
  // one behind forever.
  const next = randomBytes(32).toString('base64url');
  await pool.query(
    `update lease
        set watch_sha256      = $2,
            watch_prev_sha256 = watch_sha256,
            watch_prev_at     = now(),
            -- Measured from last use, not from the mint.
            --
            -- This was set once at mint and never touched again, so the ceiling
            -- was 24 hours from the CLAIM however heavily the credential was
            -- used. An agent that claimed at nine and worked into the next
            -- afternoon lost its credential while polling every two minutes,
            -- and the only answer this endpoint has for a credential it does not
            -- recognise is 410 -- which the monitor reports as somebody having
            -- taken the work.
            --
            -- Sliding, the window means what it was always described as meaning:
            -- how long an IDLE credential stays usable. An ordinary night is
            -- comfortably inside it. A laptop shut on Friday and opened on
            -- Monday is not, and there the 410 is still a lie -- see SYNC-104.
            watch_expires_at  = now() + make_interval(secs => $4)
      where watch_sha256 = $1
         or ( watch_prev_sha256 = $1
              and watch_prev_at > now() - make_interval(secs => $3) )`,
    [hash, sha256(next), WATCH_GRACE_S, WATCH_TTL_MS / 1000],
  );

  return {
    watchUrl: `${publicUrl.replace(/\/$/, '')}/v1/watch/${next}`,
    ...(holding.length ? { holding: holding.join(', ') } : {}),
    ...(stale ? { stale } : {}),
    ...(say.length ? { say: say.join(' ') } : {}),
  };
}

/**
 * The session ended: hand back whatever it still holds.
 *
 * Best-effort by construction — this is driven by a `SessionEnd` hook, which does
 * not run when a process is killed. It exists to make the common case immediate,
 * not to be the guarantee; the lease TTL remains the thing that cannot be
 * skipped.
 */
export async function closeWatch(pool: Pool, raw: string): Promise<string[]> {
  const { rows } = await pool.query<{ work_item_id: string }>(
    `update lease
        set state          = 'released',
            ended_at       = now(),
            end_reason     = 'session ended with the item still held',
            expires_at     = now(),
            mirrored       = false,
            watch_sha256   = null,
            -- Both, always. A cleared credential that leaves its predecessor
            -- behind is a credential that still works.
            watch_prev_sha256 = null,
            watch_prev_at     = null,
            -- Queued rather than merely flagged. This used to set the mirrored
            -- flag and stop, and nothing anywhere acted on it -- so every session
            -- that ended holding work left it assigned and in progress on the
            -- board, permanently, with no record that anything had been skipped.
            -- The drain performs the return; this only records that one is owed.
            pending_mirror = jsonb_build_object(
              'kind',      'return',
              'projectId', project_id,
              'reason',    'the agent''s session ended while it still held this',
              'holder',    holder
            ),
            mirror_attempts = 0,
            mirror_after    = now()
      where state = 'held'
        and ( watch_sha256 = $1
              or ( watch_prev_sha256 = $1
                   and watch_prev_at > now() - make_interval(secs => $2) ) )
    returning work_item_id`,
    [sha256(raw), WATCH_GRACE_S],
  );
  return rows.map((r) => r.work_item_id);
}
