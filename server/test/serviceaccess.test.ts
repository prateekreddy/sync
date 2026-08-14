import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The gateway reads Plane with two different credentials, and only one of them
 * is the caller's.
 *
 * Anything needing the workspace-wide view — the readiness gate has to see
 * blockers in projects the caller cannot read, or an unreadable blocker looks
 * like no blocker — goes through the SERVICE client, authenticated with
 * PLANE_API_KEY. That account is deliberately a member of every project, so on
 * its own it can fetch anything in the workspace.
 *
 * What stops that being a way around Plane's own permissions is `canRead`, which
 * lists the projects the CALLER's Plane user can see (through `plane.as(their
 * token)`) and refuses before the service client is used at all. Authorisation
 * stays the user's; the service account's breadth only makes the read possible.
 *
 * That invariant lives in a convention — "remember to call canRead" — and a
 * convention is one forgotten line away from a project-wide read anyone can
 * reach. This is the line that would be forgotten, so this is the check.
 *
 * Everything else runs as `plane.as(actor.planeToken)`, where Plane enforces
 * directly and no gateway-side check is needed.
 */
const routes = readFileSync(fileURLToPath(new URL('../src/routes.ts', import.meta.url)), 'utf8');

/** The body of one `app.get('/v1/x', …)` or `app.post(…)` handler. */
const handlers = (): Map<string, string> => {
  const found = new Map<string, string>();
  const re = /app\.(?:get|post)(?:<[^>]*>)?\(\s*'(\/v1\/[^']+)'/g;
  const starts: { path: string; at: number }[] = [];
  for (const m of routes.matchAll(re)) starts.push({ path: m[1]!, at: m.index! });
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : routes.length;
    found.set(s.path, routes.slice(s.at, end));
  });
  return found;
};

describe('a route that reads with the service account', () => {
  /**
   * Keyed on what the handler DOES, not on a list of route names kept by hand: a
   * new route added next year is caught because it uses the service client, not
   * because somebody remembered to add it here.
   *
   * `plane` alone as an argument is the service client. `plane.as(...)` is the
   * caller's, and is excluded by requiring a character that cannot be a `.`.
   */
  const usesServiceClient = (body: string): boolean => /\(\s*plane\s*[,)]/.test(body);

  it('checks the caller can see the project first', () => {
    const offenders = [...handlers()]
      .filter(([path]) => path !== '/v1/watch/:capability' && path !== '/v1/agent-tokens')
      .filter(([, body]) => usesServiceClient(body))
      .filter(([, body]) => !body.includes('canRead(actor'))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('finds the routes it claims to be checking', () => {
    // The other direction. A regex that matched nothing would make the test
    // above pass for every future route by accident, which is the failure mode
    // of every check written against source text.
    const checked = [...handlers()].filter(([, b]) => usesServiceClient(b) && b.includes('canRead(actor'));
    expect(checked.length).toBeGreaterThanOrEqual(6);
    expect(checked.map(([p]) => p)).toContain('/v1/find');
    expect(checked.map(([p]) => p)).toContain('/v1/claim');
  });

  it('refuses rather than falling back to the service account when the caller cannot be checked', () => {
    // access.ts deliberately does not catch the failure of the caller's own
    // project listing. An access check that fails open is an access check that
    // does nothing on the day it matters.
    const access = readFileSync(fileURLToPath(new URL('../src/access.ts', import.meta.url)), 'utf8');
    expect(access).toMatch(/plane\.as\(actor\.planeToken\)\.listProjects\(\)/);
    expect(access).not.toMatch(/catch\s*\{[^}]*return\s+\[\]/);
  });
});
