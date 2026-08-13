/**
 * Self-service agent tokens: exchange a Plane personal token for a gateway one.
 *
 * The authority is Plane's, not the gateway's — prove to Plane who you are, and
 * you get back an agent scoped to you. There is deliberately no admin gate,
 * because the exchange only ever reduces privilege: the returned token cannot
 * talk to Plane at all, and the tool policy refuses the lease-critical fields
 * (`assignees`, `state`) and destructive schema edits that the presented Plane
 * token could do freely.
 *
 * See "Who issues agent tokens" in docs/architecture.md.
 */
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';

export interface PlaneIdentity {
  id: string;
  email: string;
  displayName: string;
}

const timeout = () => AbortSignal.timeout(15_000);

async function planeGet<T>(url: string, planeToken: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'X-API-Key': planeToken }, signal: timeout() });
  } catch (err) {
    throw new GatewayError('UPSTREAM', `Could not reach Plane to ${what}: ${String(err)}`);
  }
  // A rejected token is the overwhelmingly common failure here, and it is the
  // caller's to fix — so say so plainly rather than surfacing it as an upstream
  // fault they would reasonably retry.
  if (res.status === 401 || res.status === 403) {
    throw new GatewayError(
      'UNAUTHENTICATED',
      'Plane rejected that personal token. Create one in Plane under your profile settings → Personal access tokens, and send it as Authorization: Bearer <token>.',
    );
  }
  if (!res.ok) {
    throw new GatewayError('UPSTREAM', `Plane ${res.status} while trying to ${what}`);
  }
  return (await res.json()) as T;
}

/** Who the presenter of this Plane token is. Doubles as the authentication check. */
export async function identify(baseUrl: string, planeToken: string): Promise<PlaneIdentity> {
  const me = await planeGet<{ id: string; email?: string; display_name?: string }>(
    `${baseUrl.replace(/\/$/, '')}/api/v1/users/me/`,
    planeToken,
    'identify you',
  );
  if (!me.id) throw new GatewayError('UPSTREAM', 'Plane returned no user id for that token');
  return {
    id: me.id,
    email: me.email ?? '',
    displayName: me.display_name || me.email || me.id,
  };
}

/**
 * Projects this token can actually see.
 *
 * Binding an agent to a project its owner has no access to would produce a token
 * that authenticates fine and then 403s on the first write — a failure that
 * surfaces inside an agent session, hours later, as a tool that mysteriously does
 * not work. Cheaper to refuse it here.
 */
export interface VisibleProject {
  id: string;
  name: string;
}

/**
 * Returns the NAMES as well as the ids, which it used to throw away.
 *
 * That discard is why the consent screen asked people to paste a uuid out of a
 * URL: the one call that knew what a project was called reduced its answer to a
 * set of ids before anything could render them, so the `<select>` branch of the
 * consent page could never be reached and sat there as dead code. Keeping the
 * name costs nothing — Plane sends it in the same response.
 */
export async function visibleProjects(
  baseUrl: string,
  workspaceSlug: string,
  planeToken: string,
): Promise<VisibleProject[]> {
  const body = await planeGet<
    { results?: VisibleProject[] } | VisibleProject[]
  >(
    `${baseUrl.replace(/\/$/, '')}/api/v1/workspaces/${workspaceSlug}/projects/?per_page=100`,
    planeToken,
    'list your projects',
  );
  const rows = Array.isArray(body) ? body : (body.results ?? []);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Resolve what someone typed or picked to a project id.
 *
 * Accepts the id, or the project's name case-insensitively. The name is there so
 * the no-JavaScript path is usable: without it the fallback is "find the uuid in
 * a URL", which is the thing being fixed. Returns null when nothing matches, so
 * the caller can say which projects the token CAN see rather than only that this
 * one failed.
 */
export function resolveProject(
  projects: VisibleProject[],
  wanted: string,
): VisibleProject | null {
  const w = wanted.trim().toLowerCase();
  return (
    projects.find((p) => p.id.toLowerCase() === w) ??
    projects.find((p) => p.name.trim().toLowerCase() === w) ??
    null
  );
}

/**
 * Agent names are namespaced by their owner.
 *
 * Without this, self-service minting is a takeover primitive: `issueToken` upserts
 * on `name`, so anyone asking for a name someone else already used would rotate
 * that agent's token out from under them. Prefixing with the owner makes the
 * collision impossible rather than merely detected, and it makes the holder string
 * in Plane's activity log say whose agent did the work.
 */
export function agentName(identity: PlaneIdentity, label: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

  const owner = clean(identity.email.split('@')[0] ?? '') || clean(identity.displayName) ||
    identity.id.slice(0, 8);
  const agent = clean(label);
  if (!agent) throw new GatewayError('INVALID', 'agent name must contain a letter or digit');
  return `${owner}/${agent}`;
}

/**
 * Per-address limiter for the mint endpoint, counted in Postgres.
 *
 * It is reachable without any gateway credential and calls Plane twice per
 * request, so an unthrottled one lets a stranger burn the workspace's rate-limit
 * budget — which would take every agent down, not just this endpoint.
 *
 * It was an in-memory Map, and that was the last thing in the gateway assuming a
 * single process once mirror ordering stopped (SYNC-6, SYNC-122). It failed in
 * the worst direction: two replicas meant twenty a minute from one address,
 * three meant thirty. So the limit scaled the exposure it existed to bound, and
 * did it precisely when replicas were added for resilience.
 *
 * One statement, and a sliding window rather than a fixed one — a per-minute
 * bucket would let twice the limit through either side of a boundary, which on
 * this endpoint is the whole quantity being defended.
 *
 * The three parts, in the order they matter:
 *
 *   delete   everything past the window, across every agent, on every call. That is what
 *            keeps the table to at most one minute of mints with no sweeper to
 *            own; a full-table delete over a few hundred rows costs far less
 *            than the Plane request this call is about to make.
 *   count    this address inside the window.
 *   insert   only when the count is under the limit. Refusals are deliberately
 *            not recorded, matching the in-memory version: a client hammering
 *            the endpoint must not extend its own lockout past the window.
 *
 * `gone`, `recent` and `ins` share one snapshot, so `recent` cannot see its own
 * insert and the count is the state before this attempt — which is exactly what
 * the comparison wants.
 *
 * No fallback when the database is unreachable, and none is needed: issuing a
 * token writes to the same database, so a failure here fails the mint anyway.
 */
export function createRateLimiter(pool: Pool, perMinute: number) {
  return async function allow(key: string): Promise<boolean> {
    const { rows } = await pool.query<{ n: number }>(
      `with gone as (
         delete from mint_attempt where at <= now() - interval '1 minute'
       ), recent as (
         select count(*)::int as n
           from mint_attempt
          where key = $1 and at > now() - interval '1 minute'
       ), ins as (
         insert into mint_attempt (key, at)
         select $1, now() from recent where recent.n < $2
       )
       select n from recent`,
      [key, perMinute],
    );
    return (rows[0]?.n ?? 0) < perMinute;
  };
}
