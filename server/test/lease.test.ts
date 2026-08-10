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
  monitorSeen,
  record,
  release,
  sweepExpired,
  EXPIRED_WHILE_ALIVE,
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

/**
 * A claim that never arrived, sent again.
 *
 * The 2026-07-28 MCP revision removed stream resumability, so a client whose
 * connection drops mid-request is expected to re-issue it. The gateway therefore
 * has to answer the same `claim` twice, and the honest answer to "did I get it?"
 * is yes -- the first one succeeded, the reply is what was lost.
 *
 * Telling the agent "another agent holds this item" would be true only in the
 * uselessly literal sense that the other agent is itself, and the recovery advice
 * attached to that error sends it off to find different work while its own lease
 * sits there held and unworked until it expires.
 */
describe('a retried claim', () => {
  it('returns the same lease rather than reporting a conflict', async () => {
    const workItemId = randomUUID();
    const session = `s-${randomUUID()}`;
    const first = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });
    const again = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });

    expect(again).not.toBeNull();
    expect(again!.epoch).toBe(first!.epoch);
  });

  it('does not restart the clock the maximum-hold cap is measured against', async () => {
    // If a retry reset claimed_at, an agent that retried periodically would push
    // the ceiling out forever -- the runaway case that cap exists to bound.
    const workItemId = randomUUID();
    const session = `s-${randomUUID()}`;
    const first = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });
    await sleep(50);
    const again = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });

    expect(again!.claimedAt.getTime()).toBe(first!.claimedAt.getTime());
  });

  it('is not confused with a second window belonging to the same human', async () => {
    // The dangerous near-miss. Agents authenticate as the person running them, so
    // `holder` alone is the same across every window they open; matching on it
    // would let a second session silently join the first one's lease and both
    // would work the item believing they owned it.
    const workItemId = randomUUID();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: 's-one',
    })).not.toBeNull();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: 's-two',
    })).toBeNull();
  });

  it('refuses when the session is unknown, rather than guessing', async () => {
    // A client that reports no session gets today's semantics: degraded, never
    // wrong. Treating null as matching null would make every such client share
    // one identity, which is the failure above with no way to detect it.
    const workItemId = randomUUID();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60,
    })).not.toBeNull();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60,
    })).toBeNull();
  });

  it('still refuses a different agent in the same session', async () => {
    const workItemId = randomUUID();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: 's-one',
    })).not.toBeNull();
    expect(await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'b', ttlSeconds: 60, sessionId: 's-one',
    })).toBeNull();
  });

  it('does not revive a lease the session already finished', async () => {
    // `complete` then `claim` is not a retry, it is starting over -- and it must
    // go through the normal path so the epoch moves.
    const workItemId = randomUUID();
    const session = `s-${randomUUID()}`;
    const l = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });
    await release(pool, { workItemId, holder: 'a', epoch: l!.epoch, reason: 'done for now' });

    const again = await claim(pool, {
      workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session,
    });
    expect(again!.epoch).toBe(2);
  });

  it('survives the same claim being sent twice at once', async () => {
    // Not hypothetical: a client that retries on timeout can have both requests
    // in flight, since the first was never cancelled -- only unanswered.
    const workItemId = randomUUID();
    const session = `s-${randomUUID()}`;
    const both = await Promise.all([
      claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session }),
      claim(pool, { workItemId, projectId: PROJECT, holder: 'a', ttlSeconds: 60, sessionId: session }),
    ]);

    expect(both.every((l) => l !== null)).toBe(true);
    expect(new Set(both.map((l) => l!.epoch)).size).toBe(1);
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

/**
 * `history` is a fold, not an event log: `lease` is one row per work item,
 * upserted, so prior holders do not exist anywhere. `epoch` and `expiry_count`
 * are the counters that survive the overwrites, and they answer the question
 * worth asking before a claim — has this killed agents before?
 */
describe('lease record', () => {
  it('says nothing for an item nobody has claimed, rather than inventing a zero', async () => {
    // Distinct from "claimed once and released", which a zeroed record would hide.
    expect(await record(pool, randomUUID())).toBeNull();
  });

  it('counts every claim, including the ones that lapsed', async () => {
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'agent:a', ttlSeconds: 30 });
    await pool.query("update lease set expires_at = now() - interval '1 second'");
    await sweepExpired(pool);
    await claim(pool, { workItemId, projectId: PROJECT, holder: 'agent:b', ttlSeconds: 30 });

    const r = await record(pool, workItemId);
    expect(r?.claims).toBe(2);
    expect(r?.expiries).toBe(1);
    expect(r?.holder).toBe('agent:b');
  });

  it('remembers how the last attempt ended', async () => {
    const workItemId = randomUUID();
    const l = await claim(pool, {
      workItemId,
      projectId: PROJECT,
      holder: 'agent:a',
      ttlSeconds: 30,
    });
    await release(pool, {
      workItemId,
      holder: 'agent:a',
      epoch: l!.epoch,
      reason: 'handing back, needs a decision',
    });

    const r = await record(pool, workItemId);
    expect(r?.endReason).toContain('needs a decision');
    expect(r?.endedAt).toMatch(/^20/);
  });
});

/**
 * Whether the thing that protects a claim actually exists.
 *
 * The liveness chain — hook matcher, credential harvest, watch file, poll — was
 * broken end to end for weeks, and every link reported success. Nothing on the
 * agent's machine could notice, because each failure looks exactly like "nothing
 * to do". A poll is the only thing that moves heartbeat_at past claimed_at, so
 * the gateway can see the absence without any cooperation, and it is the only
 * participant that can.
 */
describe('noticing that a liveness monitor is not running', () => {
  const holder = () => `agent:t-mon-${randomUUID().slice(0, 8)}/w`;

  /** A finished lease of a given age and duration, optionally ever polled. */
  const past = async (h: string, opts: { minutes: number; polled: boolean }) => {
    const workItemId = randomUUID();
    await claim(pool, { workItemId, projectId: PROJECT, holder: h, ttlSeconds: 600 });
    await pool.query(
      `update lease
          set claimed_at   = now() - make_interval(mins => $2),
              ended_at     = now(),
              state        = 'released',
              heartbeat_at = case when $3 then now() else now() - make_interval(mins => $2) end
        where work_item_id = $1`,
      [workItemId, opts.minutes, opts.polled],
    );
    return workItemId;
  };

  it('says nothing about an agent it has never seen', async () => {
    // A new agent's first claim must not cry wolf: no history is not evidence.
    expect(await monitorSeen(pool, holder())).toEqual({ known: false, polled: false });
  });

  it('reports a monitor that has never polled a long-held lease', async () => {
    const h = holder();
    await past(h, { minutes: 45, polled: false });
    expect(await monitorSeen(pool, h)).toEqual({ known: true, polled: false });
  });

  it('is satisfied by a single poll across all of an agent\u2019s leases', async () => {
    // One working session is proof the chain is wired. This is about "does the
    // mechanism exist", not about auditing every lease.
    const h = holder();
    await past(h, { minutes: 45, polled: false });
    await past(h, { minutes: 30, polled: true });
    expect((await monitorSeen(pool, h)).polled).toBe(true);
  });

  it('does not count a lease that is merely young with a long TTL', async () => {
    // Caught in review: the first cut measured expires_at - claimed_at, so a
    // lease claimed one second ago with a ten minute TTL read as ten minutes
    // old, and every agent's very first claim warned that its monitor was
    // missing before the monitor had had any chance to poll. Elapsed time, not
    // the time it is allowed to run for.
    const h = holder();
    await claim(pool, { workItemId: randomUUID(), projectId: PROJECT, holder: h, ttlSeconds: 3600 });
    expect(await monitorSeen(pool, h)).toEqual({ known: false, polled: false });
  });

  it('does not judge an agent on work shorter than one poll interval', async () => {
    // The monitor polls every two minutes, so a lease that started and finished
    // inside one interval showing no poll means nothing at all.
    const h = holder();
    await past(h, { minutes: 1, polled: false });
    expect(await monitorSeen(pool, h)).toEqual({ known: false, polled: false });
  });
});

/**
 * A lease that lapses under an agent which is demonstrably still working.
 *
 * SYNC-73 delivered two of its three parts. The third -- "a lease that expires
 * while its holder is demonstrably alive is not silently recycled" -- was closed
 * by prevention: the liveness monitor stops the expiry happening. That holds
 * only where the monitor can run, and it cannot run for a client that is not the
 * plugin, or on a box with none of jq, node or python3. There the 2026-08-04
 * collision is reachable exactly as it was.
 *
 * The evidence was already being collected and thrown away: `authenticate`
 * stamps agent_token.last_seen_at on every call.
 *
 * The rule under test needs no tuned window: the previous holder called the
 * gateway AFTER its own lease had expired.
 */
describe('taking work from an agent that never stopped', () => {
  const token = async (name: string, seenAt: string | null) => {
    await pool.query(
      `insert into agent_token (name, token_sha256, last_seen_at)
       values ($1, $2, $3::timestamptz)
       on conflict (name) do update set last_seen_at = excluded.last_seen_at`,
      [name, randomUUID(), seenAt],
    );
    return `agent:${name}`;
  };

  /** A lease held by `holder` that lapsed `agoSeconds` ago. */
  const lapsed = async (workItemId: string, holder: string, agoSeconds = 60) => {
    await claim(pool, { workItemId, projectId: PROJECT, holder, ttlSeconds: 600 });
    await pool.query(
      `update lease set expires_at = now() - make_interval(secs => $2) where work_item_id = $1`,
      [workItemId, agoSeconds],
    );
  };

  it('says so when the displaced holder was calling after its lease had gone', async () => {
    // Alive at a moment its lease no longer covered: not a dead agent whose work
    // is free, but one about to duplicate whatever the new claimant does.
    const victim = await token(`v-${randomUUID()}`, new Date().toISOString());
    const id = randomUUID();
    await lapsed(id, victim);

    const taken = await claim(pool, {
      workItemId: id,
      projectId: PROJECT,
      holder: 'agent:the-next-one',
      ttlSeconds: 600,
    });

    expect(taken!.tookOverFrom?.holder).toBe(victim);
  });

  it('stays quiet when the holder really did stop', async () => {
    // Last seen before its lease expired, which is what a dead agent looks like.
    const gone = await token(`g-${randomUUID()}`, new Date(Date.now() - 3_600_000).toISOString());
    const id = randomUUID();
    await lapsed(id, gone);

    const taken = await claim(pool, {
      workItemId: id,
      projectId: PROJECT,
      holder: 'agent:the-next-one',
      ttlSeconds: 600,
    });

    expect(taken!.tookOverFrom).toBeUndefined();
  });

  it('does not accuse an agent of stealing from itself', async () => {
    // Without this exclusion it fires on EVERY self-reclaim: authenticate stamps
    // last_seen_at at the start of the request, so the condition is true by
    // construction the moment an agent takes back its own lapsed lease.
    const me = await token(`m-${randomUUID()}`, new Date().toISOString());
    const id = randomUUID();
    await lapsed(id, me);

    const taken = await claim(pool, {
      workItemId: id,
      projectId: PROJECT,
      holder: me,
      ttlSeconds: 600,
    });

    expect(taken!.tookOverFrom).toBeUndefined();
  });

  it('says nothing on a first claim, which displaces nobody', async () => {
    const taken = await claim(pool, {
      workItemId: randomUUID(),
      projectId: PROJECT,
      holder: 'agent:the-next-one',
      ttlSeconds: 600,
    });
    expect(taken!.tookOverFrom).toBeUndefined();
  });

  it('records the reason on the expiry itself, not only for a claimant', async () => {
    // Nobody may ever claim the item, and the fact must still survive -- it is
    // what a human reads to find out an agent's liveness is broken. The ordinary
    // reason describes a dead agent, which is the opposite of what happened.
    const victim = await token(`s-${randomUUID()}`, new Date().toISOString());
    const id = randomUUID();
    await claim(pool, { workItemId: id, projectId: PROJECT, holder: victim, ttlSeconds: 600 });
    await pool.query(
      `update lease set expires_at = now() - interval '1 minute' where work_item_id = $1`,
      [id],
    );

    await sweepExpired(pool);

    const { rows } = await pool.query<{ end_reason: string }>(
      'select end_reason from lease where work_item_id = $1',
      [id],
    );
    expect(rows[0]!.end_reason).toBe(EXPIRED_WHILE_ALIVE);
  });

  it('keeps the ordinary reason for an agent that stopped', async () => {
    const gone = await token(`q-${randomUUID()}`, new Date(Date.now() - 3_600_000).toISOString());
    const id = randomUUID();
    await claim(pool, { workItemId: id, projectId: PROJECT, holder: gone, ttlSeconds: 600 });
    await pool.query(
      `update lease set expires_at = now() - interval '1 minute' where work_item_id = $1`,
      [id],
    );

    await sweepExpired(pool);

    const { rows } = await pool.query<{ end_reason: string }>(
      'select end_reason from lease where work_item_id = $1',
      [id],
    );
    expect(rows[0]!.end_reason).toBe('lease expired: no heartbeat');
  });
});
