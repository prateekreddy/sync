import { createHash, randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import {
  assertSafeRedirect,
  authServerMetadata,
  authorizeRedirect,
  findClient,
  issueCode,
  protectedResourceMetadata,
  publicBase,
  redeemCode,
  registerClient,
} from '../src/oauth.js';

/**
 * The authorization code flow is the one place where a stranger can reach code
 * that ends in a live credential being handed out. These tests cover the checks
 * that stand between the two: PKCE, single use, and the redirect allowlist.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

afterAll(async () => {
  await pool.query("delete from oauth_client where client_name = 'test-client'");
  await pool.end();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const CB = 'http://localhost:8123/callback';

describe('metadata', () => {
  it('advertises PKCE-only, public clients, and a matching issuer', () => {
    const m = authServerMetadata('https://mcp.example.dev');
    expect(m.issuer).toBe('https://mcp.example.dev');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m.authorization_endpoint).toBe('https://mcp.example.dev/oauth/authorize');
  });

  /**
   * RFC 9207, which MCP 2026-07-28 turns from an option into something clients
   * MUST validate. The failure this guards is not a missing parameter — it is a
   * present one that disagrees with the advertised issuer, which breaks the flow
   * for exactly the clients that do the checking and for nobody else. So the
   * assertion is that the two derive from one value, not that `iss` is there.
   */
  it('returns an `iss` the client can match against the advertised issuer', () => {
    const headers = { host: 'mcp.example.dev', 'x-forwarded-proto': 'https' };
    const base = publicBase(undefined, headers);

    const to = new URL(
      authorizeRedirect({ redirectUri: CB, code: 'abc', issuer: base, state: 's-1' }),
    );

    expect(to.searchParams.get('iss')).toBe(authServerMetadata(base).issuer);
    expect(to.searchParams.get('code')).toBe('abc');
    expect(to.searchParams.get('state')).toBe('s-1');
  });

  it('omits `state` entirely when the client sent none', () => {
    // Absent and empty are different to a client comparing against what it
    // stored, and RFC 6749 §4.1.2 only requires it back if it was sent.
    const to = new URL(authorizeRedirect({ redirectUri: CB, code: 'abc', issuer: 'https://x.dev' }));
    expect(to.searchParams.has('state')).toBe(false);
  });

  it('keeps query already present on the registered redirect_uri', () => {
    // Claude Code's callback is a bare loopback path today, but a redirect_uri
    // carrying its own query is legal and dropping it would break that client
    // silently — the flow completes and the client cannot correlate it.
    const to = new URL(
      authorizeRedirect({
        redirectUri: 'https://app.example/cb?tenant=acme',
        code: 'abc',
        issuer: 'https://x.dev',
      }),
    );
    expect(to.searchParams.get('tenant')).toBe('acme');
    expect(to.searchParams.get('code')).toBe('abc');
  });

  it('names the MCP endpoint as the protected resource', () => {
    expect(protectedResourceMetadata('https://x.dev').resource).toBe('https://x.dev/mcp');
  });

  it('prefers the configured public URL over proxy headers', () => {
    const headers = { host: 'internal:8787', 'x-forwarded-proto': 'http' };
    expect(publicBase('https://mcp.example.dev/', headers)).toBe('https://mcp.example.dev');
    expect(publicBase(undefined, headers)).toBe('http://internal:8787');
  });

  it('advertises the scheme the request arrived on, not a hardcoded https', () => {
    // Advertising https for a gateway reached over http sends the client to a
    // port nothing is listening on, which breaks every non-TLS deployment.
    expect(publicBase(undefined, { host: 'localhost:8787' }, 'http')).toBe('http://localhost:8787');
    expect(publicBase(undefined, { host: 'mcp.example.dev' }, 'https')).toBe('https://mcp.example.dev');
  });

  it('takes the client-facing scheme from the front of a proxy chain', () => {
    expect(publicBase(undefined, { host: 'x.dev', 'x-forwarded-proto': 'https,http' }, 'http')).toBe(
      'https://x.dev',
    );
  });
});

describe('redirect_uri', () => {
  it('allows loopback over http, because that is where the CLI listens', () => {
    for (const u of [CB, 'http://127.0.0.1:9/callback', 'https://app.example.dev/cb']) {
      expect(() => assertSafeRedirect(u)).not.toThrow();
    }
  });

  it('refuses plaintext to a remote host, which would leak the code in transit', () => {
    expect(() => assertSafeRedirect('http://evil.example.com/cb')).toThrow(GatewayError);
  });

  it('refuses non-http schemes', () => {
    expect(() => assertSafeRedirect('javascript:alert(1)')).toThrow(GatewayError);
    expect(() => assertSafeRedirect('not a url')).toThrow(GatewayError);
  });
});

describe('client registration', () => {
  it('round-trips a registered client', async () => {
    const c = await registerClient(pool, { redirect_uris: [CB], client_name: 'test-client' });
    expect(c.clientId).toMatch(/^sync_client_[a-f0-9]{32}$/);
    const found = await findClient(pool, c.clientId);
    expect(found?.redirectUris).toEqual([CB]);
  });

  it('requires at least one redirect_uri', async () => {
    await expect(registerClient(pool, { client_name: 'test-client' })).rejects.toThrow(GatewayError);
  });

  it('rejects an unsafe redirect at registration, not just at authorize', async () => {
    await expect(
      registerClient(pool, { redirect_uris: ['http://evil.example.com/cb'], client_name: 'test-client' }),
    ).rejects.toThrow(GatewayError);
  });

  it('returns null for an id it never issued', async () => {
    expect(await findClient(pool, 'sync_client_nope')).toBeNull();
  });
});

describe('authorization code', () => {
  const now = 1_000_000;
  const grant = (challenge: string) =>
    issueCode({ clientId: 'c1', redirectUri: CB, codeChallenge: challenge, accessToken: 'sync_agent_x' }, now);

  it('exchanges for the token when the verifier matches', () => {
    const { verifier, challenge } = pkce();
    const code = grant(challenge);
    expect(redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: verifier }, now)).toBe(
      'sync_agent_x',
    );
  });

  it('is single use — a replayed code yields nothing', () => {
    const { verifier, challenge } = pkce();
    const code = grant(challenge);
    redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: verifier }, now);
    expect(() =>
      redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: verifier }, now),
    ).toThrow(GatewayError);
  });

  it('rejects a wrong verifier, and burns the code doing so', () => {
    const { challenge } = pkce();
    const code = grant(challenge);
    expect(() =>
      redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: pkce().verifier }, now),
    ).toThrow(/PKCE/);
    // The interceptor must not get a second attempt with the real verifier.
    expect(() =>
      redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: 'anything-at-all-long' }, now),
    ).toThrow(/unknown or expired/);
  });

  it('rejects redemption by a different client', () => {
    const { verifier, challenge } = pkce();
    const code = grant(challenge);
    expect(() =>
      redeemCode(code, { clientId: 'c2', redirectUri: CB, codeVerifier: verifier }, now),
    ).toThrow(/different client/);
  });

  it('rejects a redirect_uri that differs from the one it was issued for', () => {
    const { verifier, challenge } = pkce();
    const code = grant(challenge);
    expect(() =>
      redeemCode(
        code,
        { clientId: 'c1', redirectUri: 'http://localhost:9999/callback', codeVerifier: verifier },
        now,
      ),
    ).toThrow(/different client/);
  });

  it('expires after 60 seconds', () => {
    const { verifier, challenge } = pkce();
    const code = grant(challenge);
    expect(() =>
      redeemCode(code, { clientId: 'c1', redirectUri: CB, codeVerifier: verifier }, now + 60_001),
    ).toThrow(/unknown or expired/);
  });

  it('does not confuse two codes issued in the same instant', () => {
    const a = pkce();
    const b = pkce();
    const ca = issueCode(
      { clientId: 'c1', redirectUri: CB, codeChallenge: a.challenge, accessToken: 'token-a' },
      now,
    );
    const cb = issueCode(
      { clientId: 'c1', redirectUri: CB, codeChallenge: b.challenge, accessToken: 'token-b' },
      now,
    );
    expect(ca).not.toBe(cb);
    expect(redeemCode(cb, { clientId: 'c1', redirectUri: CB, codeVerifier: b.verifier }, now)).toBe('token-b');
    expect(redeemCode(ca, { clientId: 'c1', redirectUri: CB, codeVerifier: a.verifier }, now)).toBe('token-a');
  });
});
