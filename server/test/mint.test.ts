import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  issueToken,
  authenticate,
  listOwnedAgents,
  revokeByToken,
  revokeOwnedAgent,
} from '../src/auth.js';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import { agentName, createRateLimiter } from '../src/mint.js';

/**
 * Self-service minting turns a Plane personal token into an agent token, which
 * means anyone in the workspace can create agent identities. The invariant that
 * makes that safe is ownership: you may rotate your own agents and nobody
 * else's.
 *
 * Without it, the upsert on `name` in issueToken is a takeover primitive — ask
 * for a name someone else already uses and their token is silently replaced,
 * logging their agent out and giving you its identity in Plane's activity log.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

afterAll(async () => {
  // These tests create real token rows. Left behind they accumulate on every run
  // and make `list-tokens` useless for seeing what is actually deployed.
  await pool.query("delete from agent_token where name like 't-%/worker'");
  await pool.query("delete from agent_token where name = 't-orphan/worker'");
  await pool.end();
});

const identity = (over: Partial<{ id: string; email: string; displayName: string }> = {}) => ({
  id: randomUUID(),
  email: 'alice@example.com',
  displayName: 'alice',
  ...over,
});

describe('agent names', () => {
  it('namespaces by the owner, so two people can both have a worker-1', () => {
    const a = agentName(identity({ email: 'alice@example.com' }), 'worker-1');
    const b = agentName(identity({ email: 'bob@example.com' }), 'worker-1');
    expect(a).toBe('alice/worker-1');
    expect(b).toBe('bob/worker-1');
    expect(a).not.toBe(b);
  });

  it('falls back to display name, then to the user id, when there is no email', () => {
    expect(agentName(identity({ email: '', displayName: 'Ann Lee' }), 'w1')).toBe('ann-lee/w1');
    const id = randomUUID();
    expect(agentName({ id, email: '', displayName: '' }, 'w1')).toBe(`${id.slice(0, 8)}/w1`);
  });

  it('strips characters that would make the holder string ambiguous', () => {
    expect(agentName(identity({ email: 'a.b+tag@x.com' }), 'Worker 1!')).toBe('a.b-tag/worker-1');
  });

  it('rejects a label with nothing usable in it', () => {
    expect(() => agentName(identity(), '!!!')).toThrow(GatewayError);
  });
});

describe('ownership guard', () => {
  it('lets the same Plane user rotate their own agent', async () => {
    const owner = randomUUID();
    const name = `t-${randomUUID().slice(0, 8)}/worker`;

    const first = await issueToken(pool, {
      name,
      principal: 'human:a',
      planeUserId: owner,
      onlyIfOwnedBy: owner,
    });
    const second = await issueToken(pool, {
      name,
      principal: 'human:a',
      planeUserId: owner,
      onlyIfOwnedBy: owner,
    });

    expect(second.token).not.toBe(first.token);
    // Rotation must actually take effect, or a "rotated" credential keeps working.
    await expect(authenticate(pool, `Bearer ${second.token}`)).resolves.toMatchObject({ name });
    await expect(authenticate(pool, `Bearer ${first.token}`)).rejects.toThrow(GatewayError);
  });

  it('refuses to let a different Plane user take over the name', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const name = `t-${randomUUID().slice(0, 8)}/worker`;

    const mine = await issueToken(pool, {
      name,
      principal: 'human:a',
      planeUserId: owner,
      onlyIfOwnedBy: owner,
    });

    await expect(
      issueToken(pool, {
        name,
        principal: 'human:b',
        planeUserId: attacker,
        onlyIfOwnedBy: attacker,
      }),
    ).rejects.toThrow(/already belongs to a different Plane user/);

    // The victim's token must still work — a rejected takeover that still rotated
    // the credential would be a denial of service dressed as a refusal.
    await expect(authenticate(pool, `Bearer ${mine.token}`)).resolves.toMatchObject({ name });
  });

  it('still lets the CLI rotate by name, which is the operator\'s intent there', async () => {
    const name = `t-${randomUUID().slice(0, 8)}/worker`;
    await issueToken(pool, { name, principal: 'human:a', planeUserId: randomUUID() });
    // No onlyIfOwnedBy: an operator at a shell is trusted to rotate anything.
    await expect(
      issueToken(pool, { name, principal: 'human:b', planeUserId: randomUUID() }),
    ).resolves.toMatchObject({ name });
  });
});

describe('revocation', () => {
  const agent = async (owner: string) => {
    const name = `t-${randomUUID().slice(0, 8)}/worker`;
    const { token } = await issueToken(pool, {
      name,
      principal: 'human:a',
      planeUserId: owner,
      onlyIfOwnedBy: owner,
    });
    return { name, token };
  };

  it('kills a token when the holder presents it (RFC 7009)', async () => {
    const { token } = await agent(randomUUID());
    await expect(authenticate(pool, `Bearer ${token}`)).resolves.toBeTruthy();
    await revokeByToken(pool, token);
    await expect(authenticate(pool, `Bearer ${token}`)).rejects.toThrow(GatewayError);
  });

  it('tolerates a Bearer prefix and an unknown token without complaining', async () => {
    const { token } = await agent(randomUUID());
    await revokeByToken(pool, `Bearer ${token}`);
    await expect(authenticate(pool, `Bearer ${token}`)).rejects.toThrow(GatewayError);
    // An unknown token must not be distinguishable from a revoked one.
    await expect(revokeByToken(pool, 'sync_agent_never_existed')).resolves.toBeUndefined();
  });

  it('lets the owner revoke by name', async () => {
    const owner = randomUUID();
    const { name, token } = await agent(owner);
    expect(await revokeOwnedAgent(pool, name, owner)).toBe(true);
    await expect(authenticate(pool, `Bearer ${token}`)).rejects.toThrow(GatewayError);
  });

  it('refuses to revoke an agent belonging to someone else', async () => {
    const owner = randomUUID();
    const { name, token } = await agent(owner);
    expect(await revokeOwnedAgent(pool, name, randomUUID())).toBe(false);
    // The victim's agent must keep working — a rejected revoke that still
    // disabled the token would be the denial of service the check exists to stop.
    await expect(authenticate(pool, `Bearer ${token}`)).resolves.toMatchObject({ name });
  });

  it('reports nothing revoked the second time, so callers can tell', async () => {
    const owner = randomUUID();
    const { name } = await agent(owner);
    expect(await revokeOwnedAgent(pool, name, owner)).toBe(true);
    expect(await revokeOwnedAgent(pool, name, owner)).toBe(false);
  });

  it('re-minting the same name brings the agent back with a fresh token', async () => {
    const owner = randomUUID();
    const { name, token } = await agent(owner);
    await revokeOwnedAgent(pool, name, owner);
    const again = await issueToken(pool, {
      name,
      principal: 'human:a',
      planeUserId: owner,
      onlyIfOwnedBy: owner,
    });
    await expect(authenticate(pool, `Bearer ${again.token}`)).resolves.toMatchObject({ name });
    // The revoked one stays dead.
    await expect(authenticate(pool, `Bearer ${token}`)).rejects.toThrow(GatewayError);
  });
});

/**
 * The limiter, counted in Postgres so it means one thing however many replicas
 * run (SYNC-122).
 *
 * It was an in-memory Map and therefore per process, which failed in the worst
 * direction: two replicas meant twice the limit from one address. That scales
 * the exact exposure the limit exists to bound — a stranger burning the
 * workspace's Plane rate budget — precisely when replicas are added.
 *
 * The window is real time now rather than an injected clock, so these assert the
 * properties that hold within one window and drive the recovery case through a
 * backdated row instead of sleeping a minute.
 */
describe('mint rate limiter', () => {
  const address = () => `ip-${randomUUID().slice(0, 8)}`;

  beforeEach(async () => {
    await pool.query('truncate mint_attempt');
  });

  it('allows up to the limit, then refuses', async () => {
    const allow = createRateLimiter(pool, 3);
    const ip = address();
    expect([await allow(ip), await allow(ip), await allow(ip)]).toEqual([true, true, true]);
    expect(await allow(ip)).toBe(false);
  });

  it('recovers once the attempts fall outside the window', async () => {
    const allow = createRateLimiter(pool, 2);
    const ip = address();
    await allow(ip);
    await allow(ip);
    expect(await allow(ip)).toBe(false);

    // Backdated rather than slept: the window is a minute, and a test that waits
    // one out is a test nobody runs.
    await pool.query("update mint_attempt set at = at - interval '2 minutes' where key = $1", [ip]);
    expect(await allow(ip)).toBe(true);
  });

  it('counts per address, so one caller cannot lock everyone out', async () => {
    const allow = createRateLimiter(pool, 1);
    const [a, b] = [address(), address()];
    expect(await allow(a)).toBe(true);
    expect(await allow(a)).toBe(false);
    expect(await allow(b)).toBe(true);
  });

  it('does not let a refusal extend its own lockout', async () => {
    // Refused attempts are deliberately not recorded, matching the in-memory
    // version. Recording them would mean a client hammering the endpoint keeps
    // itself blocked indefinitely rather than for the window.
    const allow = createRateLimiter(pool, 1);
    const ip = address();
    expect(await allow(ip)).toBe(true);
    for (let i = 0; i < 5; i++) expect(await allow(ip)).toBe(false);

    const { rows } = await pool.query<{ n: string }>(
      'select count(*) as n from mint_attempt where key = $1',
      [ip],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('holds one limit across two separate pools, which is the whole point', async () => {
    // Two pools stand in for two replicas. With the in-memory Map this passed
    // twice the limit and looked healthy — the counters simply never met.
    const second = createPool(
      process.env['GATEWAY_DATABASE_URL'] ??
        'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
    );
    try {
      const replicaA = createRateLimiter(pool, 2);
      const replicaB = createRateLimiter(second, 2);
      const ip = address();

      expect(await replicaA(ip)).toBe(true);
      expect(await replicaB(ip)).toBe(true);
      // The third is refused whichever replica it lands on.
      expect(await replicaB(ip)).toBe(false);
      expect(await replicaA(ip)).toBe(false);
    } finally {
      await second.end();
    }
  });

  it('keeps the table bounded without a sweeper', async () => {
    // Every call deletes past the window across every agent, which is what makes it safe
    // to have no owner for this table. Left to grow it would be an unbounded
    // write log on an unauthenticated endpoint.
    const allow = createRateLimiter(pool, 100);
    await allow(address());
    await pool.query("update mint_attempt set at = at - interval '5 minutes'");
    await allow(address());

    const { rows } = await pool.query<{ n: string }>('select count(*) as n from mint_attempt');
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/**
 * Minting and revoking were both self-service and enumeration was not, so an
 * agent whose name you had forgotten could never be revoked — the lost-laptop
 * case revocation exists for. It came up for real closing SYNC-5: the leaked
 * Plane token could be probed and confirmed dead, and the leaked agent tokens
 * could not be listed at all.
 */
describe('listing your own agents', () => {
  const owner = identity();
  const other = identity();

  it('shows yours and nobody else\'s', async () => {
    await issueToken(pool, {
      name: `t-${owner.id.slice(0, 8)}/worker`,
      principal: 'human:a',
      planeUserId: owner.id,
    });
    await issueToken(pool, {
      name: `t-${other.id.slice(0, 8)}/worker`,
      principal: 'human:b',
      planeUserId: other.id,
    });

    const mine = await listOwnedAgents(pool, owner.id);
    expect(mine.map((a) => a.name)).toEqual([`t-${owner.id.slice(0, 8)}/worker`]);
  });

  it('never returns the token or its hash', async () => {
    // The token is shown once at issue time and is unrecoverable by design. An
    // endpoint that could hand it back would quietly undo that.
    const [agent] = await listOwnedAgents(pool, owner.id);
    const keys = Object.keys(agent ?? {});
    expect(keys).not.toContain('token');
    expect(keys.some((k) => k.includes('sha') || k.includes('enc'))).toBe(false);
  });

  it('keeps showing an agent after it is revoked', async () => {
    // "Did my revoke work?" is the first question after revoking, and an answer
    // by omission cannot be told apart from a lost row.
    const name = `t-${owner.id.slice(0, 8)}/worker`;
    expect(await revokeOwnedAgent(pool, name, owner.id)).toBe(true);

    const after = await listOwnedAgents(pool, owner.id);
    expect(after.find((a) => a.name === name)?.active).toBe(false);
  });

  it('says whether an agent writes to Plane as itself', async () => {
    // Storing a Plane token means encrypting it, which needs the key the gateway
    // would have in production.
    process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
    const withToken = identity();
    await issueToken(pool, {
      name: `t-${withToken.id.slice(0, 8)}/worker`,
      principal: 'human:c',
      planeUserId: withToken.id,
      planeToken: 'plane_api_whatever',
    });
    const [agent] = await listOwnedAgents(pool, withToken.id);
    expect(agent?.writesAsItself).toBe(true);
  });

  it('returns nothing for a user who owns no agents', async () => {
    expect(await listOwnedAgents(pool, randomUUID())).toEqual([]);
  });

  it('cannot see agents with no recorded owner', async () => {
    // CLI-issued agents without --plane-token have a null plane_user_id. They
    // belong to whoever has a shell, and `cli.js list-tokens` shows them. Making
    // them visible here would mean showing one person another person's agents.
    await issueToken(pool, { name: 't-orphan/worker', principal: 'human:operator' });
    const all = await Promise.all(
      [owner.id, other.id, randomUUID()].map((id) => listOwnedAgents(pool, id)),
    );
    expect(all.flat().map((a) => a.name)).not.toContain('t-orphan/worker');
  });
});
