/**
 * OAuth 2.1 authorization server, so onboarding is one `claude mcp add` with no
 * credential on the command line.
 *
 * The gateway is both the resource server and the authorization server. Plane
 * cannot be the latter: it is an OAuth *client* for social sign-in, and exposes
 * no authorize/token endpoints of its own.
 *
 * Public clients with PKCE only — Claude Code registers itself via RFC 7591 and
 * holds no secret. The access token handed back is an ordinary agent token, so
 * everything downstream (authenticate, the tool policy, revocation) is unchanged
 * and there is no second credential type to reason about.
 *
 * See "Who issues agent tokens" in docs/architecture.md.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Where this gateway is reachable from outside. Every advertised URL is built
 * from this, and the issuer must be stable across requests.
 *
 * `requestProto` is the scheme the request actually arrived on, and it is the
 * fallback rather than a hardcoded `https`: a gateway reached directly over HTTP
 * that advertised `https://` would send the client to a port nothing is
 * listening on, breaking the flow entirely on any non-TLS deployment.
 */
export function publicBase(
  configured: string | undefined,
  headers: Record<string, unknown>,
  requestProto = 'http',
): string {
  if (configured) return configured.replace(/\/$/, '');
  // A proxy chain appends, so the client-facing scheme is the first entry.
  const forwarded = (headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const host = (headers['x-forwarded-host'] as string | undefined) ??
    (headers['host'] as string | undefined) ?? 'localhost';
  return `${forwarded || requestProto}://${host}`;
}

/** RFC 9728. The first thing Claude Code fetches after a 401. */
export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/docs`,
  };
}

/** RFC 8414. */
export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    // RFC 7009. Advertised so a client that revokes on logout can make "Clear
    // authentication" mean the token stops working everywhere, rather than only
    // disappearing from this machine's keychain.
    revocation_endpoint: `${base}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    // PKCE is mandatory, and only S256 — `plain` offers no protection against an
    // attacker who can see the authorization request.
    code_challenge_methods_supported: ['S256'],
    // Public clients: there is no secret to present.
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['agent'],
  };
}

/**
 * Where to send the browser once the human has authorized.
 *
 * A function rather than three `searchParams.set` calls in the route because of
 * `iss` (RFC 9207): its whole purpose is to match the `issuer` the client
 * recorded from `authServerMetadata`, and a client that validates it — which the
 * 2026-07-28 revision makes mandatory — fails the flow outright if the two
 * disagree. Two call sites deriving the same value independently is exactly the
 * shape that drifts, so both now take it from `base`, and a test pins that they
 * agree.
 *
 * `iss` closes the mix-up attack that `state` and PKCE do not: both are
 * per-flow, so neither notices a code from one authorization server being
 * redeemed at another's token endpoint.
 */
export function authorizeRedirect(args: {
  redirectUri: string;
  code: string;
  issuer: string;
  state?: string | undefined;
}): string {
  const to = new URL(args.redirectUri);
  to.searchParams.set('code', args.code);
  // Only when the client sent one. RFC 6749 §4.1.2 requires it back exactly if
  // it was present, and an empty `state=` is not the same as absent to a client
  // comparing it against what it stored.
  if (args.state) to.searchParams.set('state', args.state);
  to.searchParams.set('iss', args.issuer);
  return to.toString();
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Open registration is the norm for MCP and is what lets `claude mcp add` work
 * with nothing pre-arranged. It grants nothing on its own: a client_id is not a
 * credential, and every code still requires a human to complete the browser flow
 * and prove they hold a Plane token.
 */
export async function registerClient(
  pool: Pool,
  body: { redirect_uris?: unknown; client_name?: unknown },
): Promise<RegisteredClient & { client_name: string }> {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (uris.length === 0) {
    throw new GatewayError('INVALID', 'redirect_uris is required');
  }
  for (const uri of uris) assertSafeRedirect(uri);

  const clientId = `sync_client_${randomBytes(16).toString('hex')}`;
  const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : '';
  await pool.query(
    'insert into oauth_client (client_id, client_name, redirect_uris) values ($1, $2, $3)',
    [clientId, name, uris],
  );
  return { clientId, redirectUris: uris, client_name: name };
}

/**
 * A redirect target must be a loopback address or https.
 *
 * The authorization code is delivered to this URI. Allowing an arbitrary http
 * host would let anyone who learns a client_id have codes delivered somewhere
 * they control, and allowing plaintext would put it on the wire in the clear.
 * Claude Code uses http://localhost:PORT/callback, which is why loopback is
 * carved out rather than banned.
 */
export function assertSafeRedirect(uri: string): void {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new GatewayError('INVALID', `redirect_uri is not a URL: ${uri}`);
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && loopback) return;
  throw new GatewayError('INVALID', `redirect_uri must be https or loopback: ${uri}`);
}

export async function findClient(pool: Pool, clientId: string): Promise<RegisteredClient | null> {
  const { rows } = await pool.query<{ client_id: string; redirect_uris: string[] }>(
    'update oauth_client set last_used_at = now() where client_id = $1 returning client_id, redirect_uris',
    [clientId],
  );
  const row = rows[0];
  return row ? { clientId: row.client_id, redirectUris: row.redirect_uris } : null;
}

/**
 * Authorization codes, in memory.
 *
 * They live 60 seconds and are single-use, so a restart inside that window costs
 * one retry of a flow the user is watching. Not worth a table — and keeping them
 * out of Postgres means a leaked backup contains no live codes.
 */
interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The agent token this code will exchange for. Already issued and revocable. */
  accessToken: string;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();
const CODE_TTL_MS = 60_000;

export function issueCode(args: Omit<PendingCode, 'expiresAt'>, now: number): string {
  // Sweep on write: without an eviction path an abandoned flow leaks an entry
  // that holds a live token reference forever.
  for (const [k, v] of codes) if (v.expiresAt <= now) codes.delete(k);

  const code = randomBytes(32).toString('base64url');
  codes.set(sha256(code), { ...args, expiresAt: now + CODE_TTL_MS });
  return code;
}

/**
 * RFC 7636 §4.6. Redeeming a code proves possession of the verifier whose hash
 * was committed to when the flow started, which is what stops an intercepted
 * code from being usable by whoever intercepted it.
 */
export function redeemCode(
  code: string,
  args: { clientId: string; redirectUri: string; codeVerifier: string },
  now: number,
): string {
  const key = sha256(code);
  const pending = codes.get(key);
  // Single use: delete before any check can fail, so a wrong verifier cannot be
  // retried against the same code.
  codes.delete(key);

  if (!pending || pending.expiresAt <= now) {
    throw new GatewayError('UNAUTHENTICATED', 'authorization code is unknown or expired');
  }
  if (pending.clientId !== args.clientId || pending.redirectUri !== args.redirectUri) {
    throw new GatewayError('UNAUTHENTICATED', 'authorization code was issued to a different client');
  }

  const expected = createHash('sha256').update(args.codeVerifier).digest();
  const given = Buffer.from(pending.codeChallenge, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new GatewayError('UNAUTHENTICATED', 'PKCE verification failed');
  }
  return pending.accessToken;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/**
 * The consent screen.
 *
 * It asks for a Plane personal token rather than a Plane password: the gateway
 * should not be in a position to see anyone's password, and the token path is the
 * same one the CLI and the mint endpoint already use.
 */
export function consentPage(args: {
  action: string;
  hidden: Record<string, string>;
  projects?: { id: string; name: string }[];
  error?: string;
  planeUrl?: string;
}): string {
  const hidden = Object.entries(args.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');

  const projectField = args.projects?.length
    ? `<label>Project
         <select name="projectId">
           ${args.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
         </select>
       </label>`
    : `<label>Project id <small>the uuid in the project's URL in Plane</small>
         <input name="projectId" placeholder="optional — leave blank to choose per call">
       </label>`;

  const tokenHelp = args.planeUrl
    ? `<a href="${esc(args.planeUrl)}/profile/api-tokens" target="_blank" rel="noreferrer">Create one in Plane</a>`
    : 'Plane → your avatar → Settings → Personal access tokens';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an agent</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem}
 h1{font-size:1.35rem;margin:0 0 .25rem}
 p.sub{margin:0 0 1.75rem;opacity:.7}
 label{display:block;margin:0 0 1.1rem;font-weight:600}
 small{display:block;font-weight:400;opacity:.7;margin:.15rem 0 .35rem}
 input,select{width:100%;padding:.6rem;font:inherit;border:1px solid #8886;border-radius:.4rem;background:transparent;color:inherit}
 button{padding:.65rem 1.2rem;font:inherit;font-weight:600;border:0;border-radius:.4rem;background:#2563eb;color:#fff;cursor:pointer}
 .err{padding:.7rem .9rem;border-radius:.4rem;background:#dc26261a;border:1px solid #dc262655;margin-bottom:1.25rem}
 .note{margin-top:2rem;font-size:.875rem;opacity:.7;border-top:1px solid #8883;padding-top:1rem}
</style></head><body>
<h1>Connect an agent</h1>
<p class="sub">Your agent gets an access token scoped to you. It cannot take work
without a lease, and it never receives your Plane token.</p>
${args.error ? `<div class="err">${esc(args.error)}</div>` : ''}
<form method="post" action="${esc(args.action)}">
  ${hidden}
  <label>Plane personal token <small>${tokenHelp}</small>
    <input name="planeToken" type="password" placeholder="plane_api_…" required autofocus>
  </label>
  <label>Agent name <small>namespaced to you, so this is yours alone</small>
    <input name="agent" value="worker-1" required>
  </label>
  ${projectField}
  <button type="submit">Authorize</button>
</form>
<p class="note">Authorizing issues a token to the application that sent you here.
Only do this if you started this from your own terminal.</p>
</body></html>`;
}
