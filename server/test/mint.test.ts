import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { issueToken, authenticate } from '../src/auth.js';
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
  await pool.end();
});

const identity = (over: Partial<{ id: string; email: string; displayName: string }> = {}) => ({
  id: randomUUID(),
  email: 'prateek@example.com',
  displayName: 'prateek',
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

describe('mint rate limiter', () => {
  it('allows up to the limit, then refuses, then recovers after the window', () => {
    const allow = createRateLimiter(3);
    const t0 = 1_000_000;
    expect([allow('ip', t0), allow('ip', t0), allow('ip', t0)]).toEqual([true, true, true]);
    expect(allow('ip', t0)).toBe(false);
    expect(allow('ip', t0 + 60_001)).toBe(true);
  });

  it('counts per address, so one caller cannot lock everyone out', () => {
    const allow = createRateLimiter(1);
    const t0 = 1_000_000;
    expect(allow('a', t0)).toBe(true);
    expect(allow('a', t0)).toBe(false);
    expect(allow('b', t0)).toBe(true);
  });
});
