import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { claim } from '../src/lease.js';
import { EXTEND_S, MAX_HOLD_MS, WATCH_TTL_MS, closeWatch, mintWatch, pollWatch, watchExpired } from '../src/watch.js';

/**
 * The credential the background monitor polls with, and the liveness it produces.
 *
 * Every one of these is database behaviour, so they run against real Postgres for
 * the same reason the lease tests do: the interesting parts are conditional
 * UPDATEs, and a mocked pool would prove nothing about them.
 *
 * The case worth naming is the closed laptop. No hook fires -- the session
 * suspends rather than ending -- so the monitor's first poll after a gap is the
 * only resume signal that exists. Two outcomes have to be told apart there, and
 * getting them backwards is the collision this whole design exists to remove:
 * nobody took the work (give it back), or somebody did (say so, plainly).
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const BASE = 'https://gw.example';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The raw capability out of a URL, which is all the route passes on. */
const capOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

async function held(opts: { sessionId?: string | null; ttlSeconds?: number } = {}) {
  const workItemId = randomUUID();
  const lease = await claim(pool, {
    workItemId,
    projectId: PROJECT,
    holder: 'agent:t',
    ttlSeconds: opts.ttlSeconds ?? 600,
    sessionId: opts.sessionId ?? 's-1',
  });
  const raw = await mintWatch(pool, { sessionId: opts.sessionId ?? 's-1', workItemId });
  return { workItemId, lease: lease!, raw };
}

const expiryOf = async (workItemId: string): Promise<Date> => {
  const { rows } = await pool.query<{ expires_at: Date }>(
    'select expires_at from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]!.expires_at;
};

const stateOf = async (workItemId: string) => {
  const { rows } = await pool.query<{ state: string; epoch: number; watch_sha256: string | null }>(
    'select state, epoch, watch_sha256 from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]!;
};

/** Push a lease into the past without waiting for it. */
const ageTo = (workItemId: string, ago: string) =>
  pool.query(`update lease set expires_at = now() - interval '${ago}' where work_item_id = $1`, [
    workItemId,
  ]);

beforeEach(async () => {
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

describe('minting', () => {
  it('stores only the hash, never the credential itself', async () => {
    // A leaked database must not be replayable against the gateway.
    const { workItemId, raw } = await held();
    const { watch_sha256 } = await stateOf(workItemId);
    expect(watch_sha256).toBe(sha256(raw));
    expect(watch_sha256).not.toBe(raw);
  });

  it('refuses a credential that was never issued', async () => {
    expect(await pollWatch(pool, 'not-a-real-capability', BASE)).toBeNull();
  });

  it('refuses a credential past its absolute expiry', async () => {
    // Rotation must not extend a capability forever: it renews on every poll, so
    // without this ceiling it would live as long as the process does.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set watch_expires_at = now() - interval '1 minute' where work_item_id = $1`,
      [workItemId],
    );
    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });
});

describe('the poll is the heartbeat', () => {
  it('extends a live lease without the agent asking', async () => {
    // The point of the whole design: liveness derived from a process that cannot
    // forget, rather than promised by a model that can.
    const { workItemId, raw } = await held({ ttlSeconds: 60 });
    const before = await expiryOf(workItemId);

    const state = await pollWatch(pool, raw, BASE);

    const after = await expiryOf(workItemId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(state!.holding).toBe(workItemId);
    expect(state!.stale).toBeUndefined();
  });

  it('reports every item the session holds on one poll', async () => {
    // One credential covers the session, so a monitor polls once regardless of
    // how many items the agent has taken.
    const a = await held();
    const b = await held();

    const state = await pollWatch(pool, b.raw, BASE);
    expect(state!.holding).toContain(a.workItemId);
    expect(state!.holding).toContain(b.workItemId);
  });

  it('keeps a session to one credential, so a second claim cannot orphan the first item', async () => {
    // The bug this pins: minting per item meant `claim` handed back a second URL,
    // the hook overwrote the stored one, and the monitor could only ever poll the
    // newest item. The first would stop being heartbeated and lapse while the
    // agent was still working it.
    const a = await held();
    const b = await held();

    // Claiming the second retired the first credential rather than adding one.
    expect(await pollWatch(pool, a.raw, BASE)).toBeNull();

    // And the surviving credential keeps the FIRST item alive.
    const before = await expiryOf(a.workItemId);
    await ageTo(a.workItemId, '1 second');
    await pollWatch(pool, b.raw, BASE);
    expect((await expiryOf(a.workItemId)).getTime()).toBeGreaterThan(before.getTime() - 1000);
    expect((await stateOf(a.workItemId)).state).toBe('held');
  });

  it('does not sweep up another session holding the same item', async () => {
    // Grouping is by session, not by holder: agents authenticate as their human,
    // so every window that person opens shares a `holder` string.
    const mine = await held({ sessionId: 's-1' });
    const theirs = await held({ sessionId: 's-2' });

    const state = await pollWatch(pool, mine.raw, BASE);
    expect(state!.holding).toBe(mine.workItemId);
    expect(state!.holding).not.toContain(theirs.workItemId);
  });

  it('rotates the credential on every poll', async () => {
    // A captured URL ages out rather than lasting the session.
    const { raw } = await held();
    const state = await pollWatch(pool, raw, BASE);
    const next = capOf(state!.watchUrl);

    expect(next).not.toBe(raw);
    expect(await pollWatch(pool, next, BASE)).not.toBeNull();
  });

  /**
   * The credential a poll just retired keeps working for a short grace period,
   * and this test used to assert the opposite.
   *
   * It was asserting a real behaviour that turned out to be a serious defect.
   * Three callers poll this endpoint and any of them can lose the replacement —
   * a crash between the GET and the write, or two hooks polling at once. The
   * answer to a retired credential was the same 410 given when another session
   * genuinely takes the item, and the push fence treats 410 as a verdict. So
   * being one rotation behind was reported as theft: pushes refused, correct
   * work declared not the agent's, the lease then left to lapse. Measured live
   * 2026-08-10, a minute after a good claim, on evidence the check manufactured.
   *
   * What must still answer 410 is a credential somebody else's claim cleared,
   * which is why `claim` clears both columns and is covered below.
   */
  it('still accepts the credential the last poll retired', async () => {
    const { raw } = await held();
    const first = capOf((await pollWatch(pool, raw, BASE))!.watchUrl);

    // The caller that lost `first` and is still holding `raw`.
    const recovered = await pollWatch(pool, raw, BASE);
    expect(recovered).not.toBeNull();
    expect(recovered!.stale).toBeUndefined();
    expect(capOf(recovered!.watchUrl)).not.toBe(first);
  });

  it('stops accepting it once it is two rotations behind', async () => {
    // One behind is a lost write. Further back than that is not a case any
    // honest caller reaches, and this is a bearer credential.
    const { raw } = await held();
    const a = capOf((await pollWatch(pool, raw, BASE))!.watchUrl);
    await pollWatch(pool, a, BASE);
    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });

  it('stops accepting it the moment another session claims the item', async () => {
    // The case 410 exists for, and the one the grace period must not swallow.
    const { raw, workItemId } = await held();
    await pollWatch(pool, raw, BASE); // retire it, so only the grace could save it

    // A live lease cannot be taken, so the theft this guards against is one that
    // happens after it lapses — the closed-laptop case the watch endpoint exists
    // for. Without this the claim below is simply refused and the test proves
    // nothing.
    await pool.query('update lease set expires_at = now() - interval \'1 minute\' where work_item_id = $1', [
      workItemId,
    ]);

    await claim(pool, {
      workItemId,
      projectId: PROJECT,
      holder: 'agent:someone-else/w',
      ttlSeconds: 600,
      sessionId: 's-other',
    });
    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });

  it('hands back a URL the monitor can use as-is', async () => {
    const { raw } = await held();
    const state = await pollWatch(pool, raw, BASE);
    expect(state!.watchUrl.startsWith(`${BASE}/v1/watch/`)).toBe(true);
  });

  it('does not double the slash when the public URL has a trailing one', async () => {
    const { raw } = await held();
    const state = await pollWatch(pool, raw, `${BASE}/`);
    expect(state!.watchUrl).not.toContain('//v1/');
  });
});

describe('the closed laptop', () => {
  it('gives the work back when the lease lapsed and nobody took it', async () => {
    // The machine slept, the lease expired, and no other session was interested.
    // Making the agent rediscover this would be a needless loss of context.
    const { workItemId, raw } = await held();
    await ageTo(workItemId, '10 minutes');

    const state = await pollWatch(pool, raw, BASE);

    expect(state!.stale).toBeUndefined();
    expect(state!.holding).toBe(workItemId);
    expect(state!.say).toMatch(/nobody took it/i);
    expect((await stateOf(workItemId)).state).toBe('held');
  });

  it('keeps the epoch when reinstating, because nothing was ever contended', async () => {
    // Work done before the gap is still done under this epoch. Bumping it would
    // invalidate writes that no second claimant ever threatened.
    const { workItemId, raw, lease } = await held();
    await ageTo(workItemId, '10 minutes');

    await pollWatch(pool, raw, BASE);

    expect((await stateOf(workItemId)).epoch).toBe(lease.epoch);
  });

  it('tells the agent plainly when somebody else took the work', async () => {
    // The verdict. Everything downstream -- the push fence above all -- keys off
    // this rather than off a failure to reach the gateway.
    const { workItemId, raw } = await held();
    await ageTo(workItemId, '10 minutes');

    // Another session claims it, which clears the credential as a side effect.
    await claim(pool, {
      workItemId,
      projectId: PROJECT,
      holder: 'agent:t',
      ttlSeconds: 600,
      sessionId: 's-2',
    });

    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });

  /**
   * A night, not ten minutes.
   *
   * The tests above age a lease by minutes, which is the coffee-break gap. The
   * real shape of this is a laptop closed at six and opened at nine the next
   * morning, and two things that are invisible at ten minutes dominate at
   * fifteen hours: the hold is now far past MAX_HOLD_MS, and the credential is
   * approaching a life of its own.
   */
  it('does not restore the work and then immediately declare it forfeit', async () => {
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease
          set claimed_at = now() - interval '15 hours',
              expires_at = now() - interval '14 hours'
        where work_item_id = $1`,
      [workItemId],
    );

    // First poll after opening the lid: nobody took it overnight, so it comes
    // back. This part already worked.
    const first = await pollWatch(pool, raw, BASE);
    expect(first!.say).toMatch(/nobody took it/i);
    expect(first!.stale).toBeUndefined();

    // The very next poll, two minutes later. The lease is live again, so the
    // lapsed branch no longer applies and the ceiling is measured from a
    // claimed_at that is still fifteen hours old -- so the work is declared
    // forfeit within one interval of being handed back.
    //
    // stale is not a cosmetic flag: the push fence refuses on it. The agent
    // would open its laptop, be told its work was restored, and be blocked from
    // pushing it two minutes later.
    const second = await pollWatch(pool, capOf(first!.watchUrl), BASE);
    expect(second!.stale).toBeUndefined();
    expect(second!.holding).toBe(workItemId);
  });

  it('does not let a night away read as an agent stuck in a loop', async () => {
    // MAX_HOLD_MS exists because "still polling" stops being evidence of "still
    // working". A gap is the opposite: it is positive evidence that nobody was
    // working, so the ceiling has to start again from the resume rather than
    // from a claim made before the machine slept.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease
          set claimed_at = now() - interval '15 hours',
              expires_at = now() - interval '14 hours'
        where work_item_id = $1`,
      [workItemId],
    );

    await pollWatch(pool, raw, BASE);

    const { rows } = await pool.query<{ age: number }>(
      `select extract(epoch from (now() - claimed_at)) as age from lease where work_item_id = $1`,
      [workItemId],
    );
    expect(Number(rows[0]!.age)).toBeLessThan(60);
  });

  it('does not age a credential out from under a session that is using it', async () => {
    // WATCH_TTL_MS was measured from the mint and nothing refreshed it, so it
    // capped the whole session rather than the idle time it was described as
    // capping: poll every two minutes for a day and the credential still died
    // 24 hours after the claim. The endpoint has exactly one answer for a
    // credential it does not recognise -- 410 -- which the monitor reports as
    // somebody having taken the work, and the push fence refuses on.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set watch_expires_at = now() + interval '1 minute' where work_item_id = $1`,
      [workItemId],
    );

    const state = await pollWatch(pool, raw, BASE);

    const { rows } = await pool.query<{ left: number }>(
      `select extract(epoch from (watch_expires_at - now())) as left from lease where work_item_id = $1`,
      [workItemId],
    );
    // Pushed back out to a full idle window by the act of being used.
    expect(Number(rows[0]!.left)).toBeGreaterThan(WATCH_TTL_MS / 1000 - 60);
    expect(state).not.toBeNull();
  });

  it('keeps the credential alive across an ordinary night', async () => {
    // The plain case, and the one that decides whether any of the above is
    // reachable: fifteen hours between the last poll last night and the first
    // poll this morning, against a 24 hour credential life.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease
          set claimed_at       = now() - interval '15 hours',
              expires_at       = now() - interval '14 hours',
              watch_expires_at = now() + interval '9 hours'
        where work_item_id = $1`,
      [workItemId],
    );

    const state = await pollWatch(pool, raw, BASE);
    expect(state).not.toBeNull();
    expect(state!.holding).toBe(workItemId);
  });

  /**
   * The pair. Both of these make pollWatch return null, and until they could be
   * told apart both were answered 410 -- which the monitor reports as theft and
   * the push fence refuses on.
   */
  it('can tell an aged-out credential from one another session cleared', async () => {
    // Aged out: the row is still perfectly matchable, only the expiry passed.
    const old = await held();
    await pool.query(
      `update lease set watch_expires_at = now() - interval '1 minute' where work_item_id = $1`,
      [old.workItemId],
    );
    expect(await pollWatch(pool, old.raw, BASE)).toBeNull();
    expect(await watchExpired(pool, old.raw)).toBe(true);

    // Taken: the winning claim clears watch_sha256, so it matches no row at any
    // expiry. This one must stay a verdict, or the fence stops protecting
    // anything.
    //
    // Its own session, deliberately. One credential covers a whole session, so
    // minting here would otherwise stamp this credential onto the aged-out lease
    // above and refresh its expiry -- and the poll would then find the work item
    // through the wrong row.
    const mine = await held({ sessionId: 's-taken' });
    await ageTo(mine.workItemId, '1 minute');
    await claim(pool, {
      workItemId: mine.workItemId,
      projectId: PROJECT,
      holder: 'agent:someone-else/w',
      ttlSeconds: 600,
      sessionId: 's-other',
    });
    expect(await pollWatch(pool, mine.raw, BASE)).toBeNull();
    expect(await watchExpired(pool, mine.raw)).toBe(false);
  });

  it('grants nothing on the aged-out path', async () => {
    // Answering at all is only safe because it extends no lease and returns no
    // work item -- it reports a fact about a credential the caller already has.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set watch_expires_at = now() - interval '1 minute' where work_item_id = $1`,
      [workItemId],
    );
    const before = await expiryOf(workItemId);

    await watchExpired(pool, raw);

    expect((await expiryOf(workItemId)).getTime()).toBe(before.getTime());
    // And the credential is not renewed by asking, or the ceiling means nothing.
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from lease
        where work_item_id = $1 and watch_expires_at > now()`,
      [workItemId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('does not resurrect a lease the agent deliberately finished', async () => {
    // Reinstatement is for lapses, not for undoing a completion. The credential
    // outlives the completion by design -- the session may still hold other work
    // -- so this row stays reachable and the guard has to be explicit.
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set state = 'completed', ended_at = now(), expires_at = now() where work_item_id = $1`,
      [workItemId],
    );

    const state = await pollWatch(pool, raw, BASE);

    expect((await stateOf(workItemId)).state).toBe('completed');
    // And no false alarm: "stop and discard that work" after a successful
    // complete would be a lie that costs real work.
    expect(state!.stale).toBeUndefined();
    expect(state!.holding).toBeUndefined();
  });

  it('says nothing alarming about work the agent released on purpose', async () => {
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set state = 'released', ended_at = now(), expires_at = now() where work_item_id = $1`,
      [workItemId],
    );

    const state = await pollWatch(pool, raw, BASE);

    expect((await stateOf(workItemId)).state).toBe('released');
    expect(state!.stale).toBeUndefined();
  });
});

describe('the ceiling on derived liveness', () => {
  it('stops extending once the hold has run past the cap', async () => {
    // An agent stuck in a loop keeps polling and would otherwise keep its lease
    // forever. Past this point "still calling" stops being evidence of "working".
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease set claimed_at = now() - make_interval(secs => $2) where work_item_id = $1`,
      [workItemId, MAX_HOLD_MS / 1000 + 60],
    );
    const before = await expiryOf(workItemId);

    const state = await pollWatch(pool, raw, BASE);

    expect(state!.stale).toBe(true);
    expect(state!.say).toMatch(/Finish it or release it/i);
    expect((await expiryOf(workItemId)).getTime()).toBe(before.getTime());
  });

  it('extends by the documented amount', async () => {
    const { workItemId, raw } = await held({ ttlSeconds: 10 });
    await pollWatch(pool, raw, BASE);
    const after = await expiryOf(workItemId);
    const seconds = (after.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(EXTEND_S - 30);
    expect(seconds).toBeLessThan(EXTEND_S + 30);
  });
});

describe('closing the session', () => {
  it('hands back what the session still holds', async () => {
    const { workItemId, raw } = await held();
    expect(await closeWatch(pool, raw)).toEqual([workItemId]);

    const row = await stateOf(workItemId);
    expect(row.state).toBe('released');
    expect(row.watch_sha256).toBeNull();
  });

  it('retires the credential, so a late poll cannot revive the lease', async () => {
    const { raw } = await held();
    await closeWatch(pool, raw);
    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });

  it('is silent about a session that held nothing', async () => {
    // SessionEnd fires whether or not the agent ever claimed anything.
    expect(await closeWatch(pool, 'never-issued')).toEqual([]);
  });

  it('leaves a completed lease alone rather than reopening it', async () => {
    const { workItemId, raw } = await held();
    await pool.query(`update lease set state = 'completed' where work_item_id = $1`, [workItemId]);
    expect(await closeWatch(pool, raw)).toEqual([]);
    expect((await stateOf(workItemId)).state).toBe('completed');
  });

  it('marks the release for mirroring, so Plane stops showing it as taken', async () => {
    const { workItemId, raw } = await held();
    await pool.query('update lease set mirrored = true where work_item_id = $1', [workItemId]);
    await closeWatch(pool, raw);
    const { rows } = await pool.query<{ mirrored: boolean }>(
      'select mirrored from lease where work_item_id = $1',
      [workItemId],
    );
    expect(rows[0]!.mirrored).toBe(false);
  });
});

describe('one session cannot speak for another', () => {
  it('drops the old credential when the item is claimed again', async () => {
    // This is what makes a 410 mean something: the credential is cleared by the
    // next claim, so the previous monitor's poll finds nothing.
    const { workItemId, raw } = await held();
    await ageTo(workItemId, '1 minute');

    await claim(pool, {
      workItemId,
      projectId: PROJECT,
      holder: 'agent:other',
      ttlSeconds: 600,
      sessionId: 's-2',
    });

    expect((await stateOf(workItemId)).watch_sha256).toBeNull();
    expect(await pollWatch(pool, raw, BASE)).toBeNull();
  });

  it('records the session that took the lease', async () => {
    const { workItemId } = await held({ sessionId: 's-abc' });
    const { rows } = await pool.query<{ session_id: string }>(
      'select session_id from lease where work_item_id = $1',
      [workItemId],
    );
    expect(rows[0]!.session_id).toBe('s-abc');
  });
});

/**
 * Telling the monitor apart from the hooks.
 *
 * Three things poll this endpoint: the liveness monitor, the push fence, and the
 * resume report. Only the monitor's poll says anything about whether liveness is
 * working, and they were indistinguishable on the wire -- so the gateway read
 * "something polled" as "the monitor is running" and stayed quiet about sessions
 * whose monitor was dead while their hooks fired. Measured 2026-08-10: exactly
 * that session existed, with the monitor latched in a 900s backoff.
 */
describe('who is doing the polling', () => {
  const seenAt = async (holder: string) => {
    const { rows } = await pool.query<{ monitor_seen_at: Date | null }>(
      `select monitor_seen_at from agent_token where 'agent:' || name = $1`,
      [holder],
    );
    return rows[0]?.monitor_seen_at ?? null;
  };

  const withToken = async (name: string) => {
    await pool.query(
      `insert into agent_token (name, token_sha256) values ($1, $2)
       on conflict (name) do update set monitor_seen_at = null`,
      [name, randomUUID()],
    );
    return `agent:${name}`;
  };

  it('records the monitor checking in', async () => {
    const holder = await withToken(`w-${randomUUID()}`);
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder, ttlSeconds: 600, sessionId: 's-m' });
    const raw = await mintWatch(pool, { sessionId: 's-m', workItemId });

    await pollWatch(pool, raw, BASE, true);

    expect(await seenAt(holder)).not.toBeNull();
  });

  it('does not let a hook stand in for the monitor', async () => {
    // The push fence polls exactly this endpoint, and a fence firing on every
    // `git push` must never be mistaken for liveness.
    const holder = await withToken(`w-${randomUUID()}`);
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder, ttlSeconds: 600, sessionId: 's-h' });
    const raw = await mintWatch(pool, { sessionId: 's-h', workItemId });

    const state = await pollWatch(pool, raw, BASE);

    // It still did its real job -- the lease was extended.
    expect(state!.holding).toBe(workItemId);
    // It simply proved nothing about the monitor.
    expect(await seenAt(holder)).toBeNull();
  });

  it('counts a monitor polling for work that was already taken', async () => {
    // "Is the monitor running" and "does this agent still hold anything" are
    // different questions. A monitor polling for a lease somebody else claimed
    // is still a monitor that is running, and going quiet here would withdraw
    // the agent's proof exactly when it most needs to be believed.
    const holder = await withToken(`w-${randomUUID()}`);
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder, ttlSeconds: 600, sessionId: 's-x' });
    const raw = await mintWatch(pool, { sessionId: 's-x', workItemId });
    await pool.query(
      `update lease set state = 'revoked', end_reason = 'taken back' where work_item_id = $1`,
      [workItemId],
    );

    const state = await pollWatch(pool, raw, BASE, true);

    expect(state!.stale).toBe(true);
    expect(await seenAt(holder)).not.toBeNull();
  });
});

/**
 * How long a revocation goes on refusing pushes.
 *
 * It used to be forever, and that was hit for real: one scratch item revoked in
 * one project refused EVERY push from that session afterwards, in every repo,
 * while `held` returned an empty list. Revocation is the SUPPORTED way for a
 * person to take work back, so doing the right thing once cost the agent its
 * ability to push anything until it restarted.
 *
 * The tempting fix — "the agent holds nothing, so allow" — is worse than the
 * bug, because losing a lease always leaves you holding nothing. That is
 * precisely the case the fence exists for, and the first test here is the one
 * that must never be weakened to make the second pass.
 */
describe('a revocation, over time', () => {
  const revoked = async (agoMinutes: number) => {
    const { workItemId, raw } = await held();
    await pool.query(
      `update lease
          set state = 'revoked',
              ended_at = now() - make_interval(mins => $2),
              end_reason = 'This item was taken off you in Plane.',
              expires_at = now()
        where work_item_id = $1`,
      [workItemId, agoMinutes],
    );
    return { workItemId, raw };
  };

  it('refuses a push right after the work was taken', async () => {
    // The whole point of the fence: the agent may still be holding what it just
    // did, and this is the only thing standing between that and a push.
    const { raw } = await revoked(0);
    const state = await pollWatch(pool, raw, BASE);
    expect(state!.stale).toBe(true);
    expect(state!.say).toMatch(/taken off you/i);
  });

  it('still refuses well inside the window', async () => {
    const { raw } = await revoked(30);
    expect((await pollWatch(pool, raw, BASE))!.stale).toBe(true);
  });

  it('stops refusing once the revocation is old news', async () => {
    // Measured hitting this: a commit for an unrelated repo, refused, with the
    // agent holding nothing at all.
    const { raw } = await revoked(90);
    const state = await pollWatch(pool, raw, BASE);
    expect(state!.stale).toBeUndefined();
    expect(state!.say).toBeUndefined();
  });

  it('does not reinstate the revoked lease on the way past', async () => {
    // Aged out of the warning is not the same as given back. Somebody took this
    // work; the lease must stay ended however long ago that was.
    const { workItemId, raw } = await revoked(90);
    await pollWatch(pool, raw, BASE);
    expect((await stateOf(workItemId)).state).toBe('revoked');
  });
});
