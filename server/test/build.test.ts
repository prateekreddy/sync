import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { buildIdentity, resetSchemaCache, schemaLevel } from '../src/build.js';
import { createPool } from '../src/db.js';
import { PlaneClient } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';

/**
 * SYNC-68: no way to ask a running gateway which build it is.
 *
 * `/healthz` returned `{"ok":true}` and nothing else, so two deployments three
 * commits apart answered identically. Every check that existed was indirect:
 * probe a behaviour known to have changed (needs a token, needs to already know
 * a difference, and produced a confidently wrong answer on 2026-08-03), read the
 * MCP tool list (only distinguishes builds that added a tool), or get a shell.
 *
 * The tests that matter here are the boring ones — that the field is present,
 * unauthenticated, and honest about not knowing — because the failure this fixes
 * was never a wrong value. It was an absent one.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

/** A pool that answers however the test says, and counts how often it is asked. */
function fakePool(answer: () => Promise<{ rows: unknown[] }>): Pool & { calls: number } {
  const p = { calls: 0, query: async () => ((p.calls++), await answer()) };
  return p as unknown as Pool & { calls: number };
}

async function harness() {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: new PlaneClient('http://plane.invalid', 'k', 'ws'),
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: null,
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  resetSchemaCache();
  delete process.env['GIT_SHA'];
  delete process.env['BUILD_TIME'];
});

afterAll(async () => {
  await pool.end();
});

describe('buildIdentity', () => {
  it('reports the sha and build time baked into the image', () => {
    expect(buildIdentity({ GIT_SHA: 'abc123', BUILD_TIME: '2026-08-04T06:00:00Z' })).toEqual({
      sha: 'abc123',
      builtAt: '2026-08-04T06:00:00Z',
    });
  });

  it('reports null rather than an empty string when the build arg was not passed', () => {
    // Compose interpolates an unset variable to '', so the image really does get
    // GIT_SHA= rather than no variable at all. Reporting "" would look like a
    // sha that failed to render; null says we were not told.
    expect(buildIdentity({ GIT_SHA: '', BUILD_TIME: '' })).toEqual({ sha: null, builtAt: null });
  });

  it('reports null when the variables are absent entirely', () => {
    expect(buildIdentity({})).toEqual({ sha: null, builtAt: null });
  });

  it('trims, so a trailing newline from $(git rev-parse) never reaches the wire', () => {
    expect(buildIdentity({ GIT_SHA: 'abc123\n' }).sha).toBe('abc123');
  });
});

describe('schemaLevel', () => {
  it('reports the highest migration the database has had', async () => {
    await pool.query('truncate schema_migration');
    await pool.query(
      `insert into schema_migration (filename) values ('001_init'), ('006_relation_retraction')`,
    );
    const level = await schemaLevel(pool);
    expect(level?.level).toBe('006_relation_retraction');
    expect(level?.count).toBe(2);
    expect(level?.appliedAt).toMatch(/^\d{4}-/);
  });

  it('reports null when the ledger does not exist, rather than throwing', async () => {
    // A database migrated before the ledger was added. "We do not know" is the
    // honest answer, and it must not take the health check down with it.
    const p = fakePool(async () => {
      throw new Error('relation "schema_migration" does not exist');
    });
    await expect(schemaLevel(p)).resolves.toBeNull();
  });

  it('reports null when the database is unreachable', async () => {
    const p = fakePool(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    await expect(schemaLevel(p)).resolves.toBeNull();
  });

  it('caches, so an unauthenticated endpoint cannot be turned into database load', async () => {
    const p = fakePool(async () => ({ rows: [{ level: '006_x', count: '6', applied_at: null }] }));
    await schemaLevel(p);
    await schemaLevel(p);
    await schemaLevel(p);
    expect(p.calls).toBe(1);
  });

  it('caches the failure too, so a database that is down is not hammered', async () => {
    const p = fakePool(async () => {
      throw new Error('down');
    });
    await schemaLevel(p);
    await schemaLevel(p);
    expect(p.calls).toBe(1);
  });

  it('reports an empty ledger as level null, not as an error', async () => {
    // max() over no rows returns a row of nulls, not an empty result set.
    const p = fakePool(async () => ({ rows: [{ level: null, count: '0', applied_at: null }] }));
    expect(await schemaLevel(p)).toEqual({ level: null, count: 0, appliedAt: null });
  });
});

describe('GET /healthz', () => {
  it('answers without a token', async () => {
    // The whole point: this is checked *before* deciding to trust a host with a
    // credential. bin/onboard.sh calls it exactly that way.
    const app = await harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still carries ok, which bin/onboard.sh substring-matches before sending a token', async () => {
    const app = await harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().ok).toBe(true);
    expect(res.body).toContain('"ok"');
    await app.close();
  });

  it('reports the build identity', async () => {
    process.env['GIT_SHA'] = 'deadbeefcafe';
    process.env['BUILD_TIME'] = '2026-08-04T06:00:00Z';
    const app = await harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().build).toEqual({ sha: 'deadbeefcafe', builtAt: '2026-08-04T06:00:00Z' });
    await app.close();
  });

  it('sends build as a key with null inside, never as a missing key', async () => {
    // A gateway older than this change has no `build` key; one built without the
    // arg has `build.sha: null`. provision.sh tells the two apart to say which
    // went wrong, so the shapes have to stay distinguishable.
    const app = await harness();
    const body = await app.inject({ method: 'GET', url: '/healthz' }).then((r) => r.json());
    expect(Object.keys(body)).toContain('build');
    expect(body.build).toEqual({ sha: null, builtAt: null });
    await app.close();
  });

  it('reports the schema level alongside the build', async () => {
    await pool.query('truncate schema_migration');
    await pool.query(`insert into schema_migration (filename) values ('006_relation_retraction')`);
    const app = await harness();
    const body = await app.inject({ method: 'GET', url: '/healthz' }).then((r) => r.json());
    expect(body.schema.level).toBe('006_relation_retraction');
    await app.close();
  });
});
