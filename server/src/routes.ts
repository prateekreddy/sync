import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from './db.js';
import { authenticate, chainFor, type Actor } from './auth.js';
import { capture } from './capture.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import * as lease from './lease.js';
import { mirrorClaim, mirrorComplete, mirrorReturn } from './mirror.js';
import type { PlaneClient } from './plane.js';
import { readyCandidates, verifyClaimable } from './readiness.js';

const uuid = z.string().uuid();

/** Defaults chosen so a stalled agent frees its work within a few minutes. */
const DEFAULT_TTL = 600;
const MAX_TTL = 3600;

export interface Deps {
  pool: Pool;
  plane: PlaneClient;
  /** Agents may close their own work; humans audit afterwards. */
  allowAgentClose: boolean;
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, plane } = deps;

  const actorOf = (req: { headers: Record<string, unknown> }): Promise<Actor> =>
    authenticate(pool, req.headers['authorization'] as string | undefined);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof GatewayError) {
      // Every failure carries what to do about it, so the agent does not have to
      // infer recovery from prose.
      return reply.status(HTTP_STATUS[err.code]).send({
        error: err.code,
        message: err.message,
        recovery: RECOVERY[err.code],
        ...err.detail,
      });
    }
    // Zod throws ZodError, which has no Fastify `validation` property — without
    // this branch every malformed agent request returned an opaque 500 and the
    // agent had no way to work out which field was wrong.
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'INVALID',
        message: 'Request validation failed',
        recovery: RECOVERY.INVALID,
        fields: err.issues.map((i) => ({
          field: i.path.join('.') || '(body)',
          problem: i.message,
        })),
      });
    }
    if (err instanceof Error && 'validation' in err) {
      return reply.status(400).send({ error: 'INVALID', message: err.message });
    }
    app.log.error({ err }, 'unhandled');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // ── capture ──────────────────────────────────────────────────────────────
  const CaptureBody = z.object({
    projectId: uuid,
    title: z.string().min(3).max(255),
    body: z.string().min(1),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    labels: z.array(z.string()).optional(),
    discoveredFrom: uuid.optional(),
    idempotencyKey: z.string().max(200).optional(),
  });

  app.post('/v1/capture', async (req) => {
    const actor = await actorOf(req);
    const input = CaptureBody.parse(req.body);
    // Created as the agent, so Plane's own activity log names the real author.
    return capture(plane.as(actor.planeToken), pool, actor, input);
  });

  // ── next (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/next', async (req) => {
    const actor = await actorOf(req);
    const q = z
      .object({
        projectId: uuid,
        limit: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(req.query);

    const candidates = await readyCandidates(plane, pool, {
      projectId: q.projectId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: q.limit,
    });
    return { candidates };
  });

  // ── claim ────────────────────────────────────────────────────────────────
  const ClaimBody = z.object({
    projectId: uuid,
    // Claim a specific item, or let the gateway pick. Picking must be one call:
    // `next` followed by `claim` is a TOCTOU race by construction.
    workItemId: uuid.optional(),
    ttlSeconds: z.number().int().min(30).max(MAX_TTL).default(DEFAULT_TTL),
    spawnedBy: z.array(z.string()).optional(),
  });

  app.post('/v1/claim', async (req) => {
    const actor = await actorOf(req);
    const b = ClaimBody.parse(req.body);
    const chain = chainFor(actor, b.spawnedBy);

    if (b.workItemId) {
      const blockers = await verifyClaimable(plane, b.projectId, b.workItemId);
      if (blockers.length) {
        throw new GatewayError('NOT_CLAIMABLE', `Not ready: ${blockers.join('; ')}`, {
          workItemId: b.workItemId,
          blockers,
        });
      }
      const l = await lease.claim(pool, {
        workItemId: b.workItemId,
        projectId: b.projectId,
        holder: actor.holder,
        holderChain: chain,
        ttlSeconds: b.ttlSeconds,
      });
      if (!l) {
        throw new GatewayError('NOT_CLAIMABLE', 'Another agent holds this item', {
          workItemId: b.workItemId,
        });
      }
      void mirrorClaim(plane.as(actor.planeToken), pool, {
        projectId: b.projectId,
        workItemId: l.workItemId,
        actor,
        epoch: l.epoch,
        expiresAt: l.expiresAt,
      });
      return { lease: l };
    }

    // Pick-and-claim. Blocker verification happens per candidate, so an item that
    // looks ready in the list but is actually blocked costs one attempt, not a
    // wasted agent run.
    const candidates = await readyCandidates(plane, pool, {
      projectId: b.projectId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: 10,
    });

    for (const c of candidates) {
      if ((await verifyClaimable(plane, b.projectId, c.workItemId)).length) continue;
      const l = await lease.claim(pool, {
        workItemId: c.workItemId,
        projectId: c.projectId,
        holder: actor.holder,
        holderChain: chain,
        ttlSeconds: b.ttlSeconds,
      });
      if (!l) continue; // lost the race; try the next one
      void mirrorClaim(plane.as(actor.planeToken), pool, {
        projectId: b.projectId,
        workItemId: l.workItemId,
        actor,
        epoch: l.epoch,
        expiresAt: l.expiresAt,
      });
      return { lease: l, item: c };
    }

    throw new GatewayError('NO_WORK', 'No ready, unclaimed work matched', {
      projectId: b.projectId,
      screened: candidates.length,
    });
  });

  // ── heartbeat / release / complete ───────────────────────────────────────
  const Held = z.object({
    workItemId: uuid,
    epoch: z.number().int().positive(),
  });

  app.post('/v1/heartbeat', async (req) => {
    const actor = await actorOf(req);
    const b = Held.extend({
      ttlSeconds: z.number().int().min(30).max(MAX_TTL).default(DEFAULT_TTL),
    }).parse(req.body);

    return {
      lease: await lease.heartbeat(pool, {
        workItemId: b.workItemId,
        holder: actor.holder,
        epoch: b.epoch,
        ttlSeconds: b.ttlSeconds,
      }),
    };
  });

  app.post('/v1/release', async (req) => {
    const actor = await actorOf(req);
    const b = Held.extend({ reason: z.string().max(500).default('released by agent') }).parse(
      req.body,
    );

    const l = await lease.release(pool, {
      workItemId: b.workItemId,
      holder: actor.holder,
      epoch: b.epoch,
      reason: b.reason,
    });
    void mirrorReturn(plane.as(actor.planeToken), pool, {
      projectId: l.projectId,
      workItemId: l.workItemId,
      reason: b.reason,
      holder: actor.holder,
    });
    return { lease: l };
  });

  app.post('/v1/complete', async (req) => {
    const actor = await actorOf(req);
    const b = Held.extend({
      outcome: z.string().min(1).max(2000),
      close: z.boolean().default(true),
    }).parse(req.body);

    const l = await lease.complete(pool, {
      workItemId: b.workItemId,
      holder: actor.holder,
      epoch: b.epoch,
      reason: b.outcome,
    });
    void mirrorComplete(plane.as(actor.planeToken), pool, {
      projectId: l.projectId,
      workItemId: l.workItemId,
      actor,
      outcome: b.outcome,
      close: b.close && deps.allowAgentClose,
    });
    return { lease: l, closed: b.close && deps.allowAgentClose };
  });

  // ── link ─────────────────────────────────────────────────────────────────
  app.post('/v1/link', async (req) => {
    const actor = await actorOf(req);
    const b = z
      .object({
        projectId: uuid,
        workItemId: uuid,
        // Plane's own vocabulary — 'blocking', not 'blocks'. Using anything else
        // is silently accepted by the serializer and then ignored.
        relation: z.enum(['blocking', 'blocked_by', 'duplicate', 'relates_to']),
        targets: z.array(uuid).min(1).max(20),
      })
      .parse(req.body);

    await plane.as(actor.planeToken).relate(b.projectId, b.workItemId, b.relation, b.targets);
    return { ok: true };
  });

  // ── what am I holding? (agents restart) ──────────────────────────────────
  app.get('/v1/held', async (req) => {
    const actor = await actorOf(req);
    return { leases: await lease.heldBy(pool, actor.holder) };
  });
}
