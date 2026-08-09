import Fastify from 'fastify';
import { createPool } from './db.js';
import { setLogger } from './log.js';
import { sweepExpired } from './lease.js';
import { drainMirrors } from './drain.js';
import { reconcileLeases } from './revoke.js';
import { mirrorReturn } from './mirror.js';
import { PlaneClient } from './plane.js';
import { PlaneMcp } from './planemcp.js';
import type { EvidencePolicy } from './evidence.js';
import { configFromEnv } from './ghcheck.js';
import { registerRoutes } from './routes.js';
import { DEFAULT_THRESHOLDS, reviewAll } from './review.js';

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

/**
 * How to ask GitHub whether a cited artefact exists.
 *
 * Read at startup so a malformed GITHUB_REPO fails the boot rather than every
 * completion. Null when nothing is configured — checking is then off, and each
 * citation is reported `unchecked` instead of being quietly treated as fine.
 */
const github = configFromEnv(process.env);

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
  // How to ask GitHub whether a cited artefact exists. Null when nothing is
  // configured, and every citation is then reported as `unchecked` rather than
  // quietly treated as fine.
  github,
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

  // Separate try: a board that will not answer must not stop expired leases from
  // being reclaimed, and the two failures have nothing to do with each other.
  try {
    // Nothing is mirrored back to Plane here, deliberately. This runs *because*
    // of what Plane already says — the item is closed, or the agent is off it —
    // so writing to Plane would be the gateway arguing with a human's edit. The
    // agent learns through its monitor, and its next call refuses with REVOKED.
    await reconcileLeases(plane, pool);
  } catch (err) {
    app.log.error({ err }, 'reconcile failed');
  }

  try {
    // The queue `mirrored = false` always claimed to be. Runs last, so a write
    // this sweep just queued gets its first retry on the next pass rather than
    // immediately after failing.
    const drained = await drainMirrors(plane, pool);
    if (drained.attempted) app.log.info(drained, 'drained queued plane writes');
  } catch (err) {
    app.log.error({ err }, 'mirror drain failed');
  }
}

const timer = setInterval(() => void sweep(), SWEEP_MS);

/**
 * The structural review, on its own clock.
 *
 * Deliberately not folded into the 30-second lease sweep. Board shape changes
 * over days, so checking it every half minute would cost a full item listing per
 * project per sweep and tell nobody anything new. Six hours is slow enough to be
 * free and fast enough that drift is caught in the same working day.
 *
 * Set REVIEW=off to disable it. On by default, because a review that has to be
 * switched on is one more thing nobody does — which is the exact failure this
 * addresses.
 */
const REVIEW_MS = Number(process.env.REVIEW_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const REVIEW_ON = (process.env.REVIEW ?? 'on') !== 'off';
const REVIEW_THRESHOLDS = {
  maxRootless: Number(process.env.REVIEW_MAX_ROOTLESS ?? DEFAULT_THRESHOLDS.maxRootless),
  minContainers: Number(process.env.REVIEW_MIN_CONTAINERS ?? DEFAULT_THRESHOLDS.minContainers),
  minOpen: Number(process.env.REVIEW_MIN_OPEN ?? DEFAULT_THRESHOLDS.minOpen),
};

async function review(): Promise<void> {
  try {
    for (const r of await reviewAll(plane, REVIEW_THRESHOLDS)) {
      // Logged on every pass, including the quiet ones. These numbers are the
      // only evidence the thresholds were ever chosen well, and they were picked
      // as starting points rather than measured.
      app.log.info(
        {
          projectId: r.projectId,
          openItems: r.assessment.openItems,
          rootless: r.assessment.rootless.length,
          containers: r.assessment.containers,
          ratio: Number(r.assessment.ratio.toFixed(2)),
          raised: r.raised,
          ...(r.repaired ? { repaired: r.repaired } : {}),
          ...(r.skipped ? { skipped: r.skipped } : {}),
        },
        r.raised
          ? 'top level is not readable, review raised'
          : `structural review: ${r.assessment.reason}`,
      );
    }
  } catch (err) {
    app.log.error({ err }, 'structural review failed');
  }
}

// Runs on the interval only, never at boot: a gateway that restarts often would
// otherwise review on every start, and the first pass would land before anyone
// had a chance to set the thresholds for their own board.
const reviewTimer = REVIEW_ON ? setInterval(() => void review(), REVIEW_MS) : null;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  clearInterval(timer);
  if (reviewTimer) clearInterval(reviewTimer);
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
