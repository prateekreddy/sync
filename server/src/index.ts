import Fastify from 'fastify';
import { createPool } from './db.js';
import { setLogger } from './log.js';
import { sweepExpired } from './lease.js';
import { mirrorReturn } from './mirror.js';
import { PlaneClient } from './plane.js';
import { PlaneMcp } from './planemcp.js';
import type { EvidencePolicy } from './evidence.js';
import { registerRoutes } from './routes.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const pool = createPool();
const plane = new PlaneClient(
  required('PLANE_BASE_URL'),
  required('PLANE_API_KEY'),
  required('PLANE_WORKSPACE_SLUG'),
);

/**
 * Plane's own MCP server, hosted here rather than on the agent boxes.
 *
 * Set PLANE_MCP=off to serve only the coordination tools — useful if you want to
 * pin exactly what agents can reach, at the cost of cycles, modules, labels,
 * worklogs and the rest of Plane's surface.
 */
const planeMcp =
  (process.env['PLANE_MCP'] ?? 'on') === 'off'
    ? null
    : new PlaneMcp({
        baseUrl: required('PLANE_BASE_URL'),
        workspaceSlug: required('PLANE_WORKSPACE_SLUG'),
        serviceToken: required('PLANE_API_KEY'),
        idleMs: Number(process.env['PLANE_MCP_IDLE_MS'] ?? 600_000),
        maxSessions: Number(process.env['PLANE_MCP_MAX_SESSIONS'] ?? 24),
      });

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Agents retry; a request that hangs is worse than one that fails fast.
  requestTimeout: 30_000,
});

// Background work (the Plane mirror) reports through this rather than vanishing.
setLogger(app.log);

registerRoutes(app, {
  pool,
  plane,
  planeMcp,
  planeBaseUrl: required('PLANE_BASE_URL'),
  workspaceSlug: required('PLANE_WORKSPACE_SLUG'),
  // Self-service minting is what makes onboarding possible without a shell on
  // this host. Set MINT_TOKENS=off to keep issuing exclusively from the CLI.
  allowMinting: (process.env['MINT_TOKENS'] ?? 'on') !== 'off',
  mintRatePerMinute: Number(process.env['MINT_RATE_LIMIT'] ?? 10),
  // The OAuth issuer must match what the client was told and must not change, so
  // behind a proxy that rewrites Host it has to be set rather than inferred.
  publicUrl: process.env['GATEWAY_PUBLIC_URL'],
  planeWebUrl: process.env['WEB_URL'],
  // Agents close their own work and humans audit afterwards. Flip this to run a
  // stricter policy without touching the lease logic.
  evidencePolicy: (process.env['REQUIRE_EVIDENCE'] as EvidencePolicy | undefined) ?? 'warn',
  allowAgentClose: (process.env.ALLOW_AGENT_CLOSE ?? 'true') === 'true',
});

/**
 * Reclaim abandoned work in Plane's UI.
 *
 * Correctness does not depend on this loop: `claim` already treats a lapsed lease
 * as available. Its only job is to stop a dead agent's item from sitting in
 * "In Progress" forever with an assignee that is never coming back.
 */
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);

async function sweep(): Promise<void> {
  try {
    const expired = await sweepExpired(pool);
    for (const l of expired) {
      app.log.warn(
        { workItemId: l.workItemId, holder: l.holder, epoch: l.epoch },
        'lease expired, returning to pool',
      );
      const { rows } = await pool.query<{ expiry_count: number }>(
        'select expiry_count from lease where work_item_id = $1',
        [l.workItemId],
      );
      await mirrorReturn(plane, pool, {
        projectId: l.projectId,
        workItemId: l.workItemId,
        reason: 'lease expired — the agent stopped sending heartbeats',
        holder: l.holder,
        ...(rows[0] ? { expiryCount: rows[0].expiry_count } : {}),
      });
    }
  } catch (err) {
    app.log.error({ err }, 'sweep failed');
  }
}

const timer = setInterval(() => void sweep(), SWEEP_MS);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  clearInterval(timer);
  await app.close();
  // Child MCP processes are ours to clean up; leaving them would strand one node
  // process per agent identity after every restart.
  await planeMcp?.shutdown();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info({ port }, 'agent gateway listening'))
  .catch((err) => {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  });
