import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustProxyFromEnv } from '../src/trustproxy.js';

/**
 * The mint limiter counts per `req.ip`, so what `req.ip` means IS the limit.
 *
 * Both directions matter and they fail in opposite ways, which is why neither is
 * checked alone here:
 *
 *   too little trust  every request behind a proxy shares one bucket, and one
 *                     client can lock everyone else out of sign-in.
 *   too much trust    a client sets its own address, rotates it, and the limit
 *                     stops existing while still appearing to run.
 *
 * The second is the reason these are integration tests against a real Fastify
 * instance rather than assertions about the parsed value. `trustProxy: 1` being
 * passed correctly says nothing about which entry of X-Forwarded-For wins, and
 * that is the whole question.
 */

/** A server that answers with whatever it believes the client's address is. */
const appWith = (trustProxy: ReturnType<typeof trustProxyFromEnv>) => {
  const app = Fastify({ trustProxy });
  app.get('/whoami', async (req) => ({ ip: req.ip }));
  return app;
};

const ipSeenBy = async (
  trustProxy: ReturnType<typeof trustProxyFromEnv>,
  headers: Record<string, string>,
  remoteAddress = '10.1.1.9',
): Promise<string> => {
  const app = appWith(trustProxy);
  const res = await app.inject({ method: 'GET', url: '/whoami', headers, remoteAddress });
  await app.close();
  return JSON.parse(res.body).ip;
};

describe('reading TRUST_PROXY', () => {
  it('trusts nobody by default, which is right when the gateway is the edge', () => {
    expect(trustProxyFromEnv({})).toBe(false);
    expect(trustProxyFromEnv({ TRUST_PROXY: '' })).toBe(false);
  });

  it.each(['off', 'false', 'no', '0', 'none', 'OFF'])('reads %s as off', (v) => {
    expect(trustProxyFromEnv({ TRUST_PROXY: v })).toBe(false);
  });

  it('reads a hop count', () => {
    expect(trustProxyFromEnv({ TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxyFromEnv({ TRUST_PROXY: '2' })).toBe(2);
  });

  it('passes an address or subnet through for proxy-addr to parse', () => {
    expect(trustProxyFromEnv({ TRUST_PROXY: '10.0.0.0/8' })).toBe('10.0.0.0/8');
    expect(trustProxyFromEnv({ TRUST_PROXY: '127.0.0.1, 10.0.0.5' })).toBe('127.0.0.1, 10.0.0.5');
  });

  /**
   * The specific footgun. `trustProxy: true` is the obvious-looking fix and the
   * one that removes the limit altogether, so it fails at boot — loudly, once —
   * rather than being accepted and quietly counting spoofable addresses.
   */
  it.each(['true', 'on', 'all', '*', 'yes'])('refuses %s, which would trust anyone', (v) => {
    expect(() => trustProxyFromEnv({ TRUST_PROXY: v })).toThrow(/bypass the mint rate limit/);
  });

  it('names the safe alternative in the refusal, so the next step is obvious', () => {
    expect(() => trustProxyFromEnv({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=1/);
  });
});

describe('who the gateway believes the client is', () => {
  const FORWARDED = { 'x-forwarded-for': '203.0.113.7' };

  it('ignores a forwarded address when nothing is trusted', async () => {
    // Direct exposure: a client's own header must not move it to another bucket.
    expect(await ipSeenBy(false, FORWARDED)).toBe('10.1.1.9');
  });

  it('takes the forwarded address through one trusted proxy', async () => {
    // The production topology. Without this every client shares the proxy's
    // address and therefore one rate-limit bucket.
    expect(await ipSeenBy(1, FORWARDED)).toBe('203.0.113.7');
  });

  /**
   * The attack the hop count exists to stop, and the reason `true` is refused.
   *
   * A proxy APPENDS the address it observed, so a client that sends a forged
   * X-Forwarded-For produces `<forged>, <real>`. Trusting one hop reads from the
   * right and lands on what the proxy saw; trusting everything would read the
   * left-hand entry, which the client chose — and could change per request.
   */
  it('counts a client under what the proxy saw, not what the client claimed', async () => {
    const spoofed = { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' };
    expect(await ipSeenBy(1, spoofed)).toBe('203.0.113.7');
    expect(await ipSeenBy(1, spoofed)).not.toBe('1.2.3.4');
  });

  it('does not let a rotating forged prefix produce a new bucket each time', async () => {
    // Same real client, three different invented prefixes: one bucket, not three.
    const seen = await Promise.all(
      ['9.9.9.9', '8.8.8.8', '7.7.7.7'].map((forged) =>
        ipSeenBy(1, { 'x-forwarded-for': `${forged}, 203.0.113.7` }),
      ),
    );
    expect(new Set(seen)).toEqual(new Set(['203.0.113.7']));
  });

  it('trusts a proxy given by subnet', async () => {
    expect(await ipSeenBy('10.0.0.0/8', FORWARDED)).toBe('203.0.113.7');
  });

  it('does not trust a peer outside the configured subnet', async () => {
    // The subnet form is only worth having if it can say no.
    expect(await ipSeenBy('192.168.0.0/16', FORWARDED)).toBe('10.1.1.9');
  });
});
