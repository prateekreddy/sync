import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from './db.js';
import { authenticate, chainFor, issueToken, type Actor } from './auth.js';
import { agentName, createRateLimiter, identify, visibleProjects } from './mint.js';
import { capture } from './capture.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import * as lease from './lease.js';
import { mirrorClaim, mirrorComplete, mirrorReturn } from './mirror.js';
import type { PlaneClient } from './plane.js';
import type { PlaneMcp } from './planemcp.js';
import { readyCandidates, verifyClaimable } from './readiness.js';
import { handleMcpHttp } from './mcphttp.js';
import { callTool, listTools } from './tools.js';
import {
  CaptureBody,
  ClaimBody,
  CompleteBody,
  HeartbeatBody,
  LinkBody,
  NextQuery,
  ReleaseBody,
} from './toolspec.js';

export interface Deps {
  pool: Pool;
  plane: PlaneClient;
  /** Agents may close their own work; humans audit afterwards. */
  allowAgentClose: boolean;
  /**
   * Plane's own MCP server, hosted here. Null disables the proxied half of the
   * tool surface; the coordination half keeps working.
   */
  planeMcp?: PlaneMcp | null;
  /** Where Plane lives, for the self-service mint endpoint's identity check. */
  planeBaseUrl: string;
  workspaceSlug: string;
  /** Whether agents can be onboarded without a shell on this host. */
  allowMinting: boolean;
  mintRatePerMinute: number;
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

  // ── self-service onboarding ──────────────────────────────────────────────
  //
  // Exchange a Plane personal token for an agent token. This is the only
  // endpoint that does not take a gateway token, because it is where gateway
  // tokens come from — and requiring one to get one is the bootstrap problem
  // that previously forced every onboarding through an operator with a shell.
  //
  // Safe to expose because the exchange only ever reduces privilege: see the
  // header comment in mint.ts. It is *not* an admin endpoint — deliberately, per
  // "admin can't do this for every user": each person mints their own agents
  // with their own credential, and gets exactly their own reach.
  const mintAllowed = createRateLimiter(deps.mintRatePerMinute);

  app.post('/v1/agent-tokens', async (req, reply) => {
    if (!deps.allowMinting) {
      throw new GatewayError(
        'FORBIDDEN',
        'Self-service tokens are disabled on this gateway (MINT_TOKENS=off). Ask your operator to issue one with the CLI.',
      );
    }
    if (!mintAllowed(req.ip, Date.now())) {
      return reply.status(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many token requests from this address.',
        recovery: 'Wait a minute and try again.',
      });
    }

    const body = z
      .object({
        // What to call this agent. Namespaced by owner before it is stored, so
        // two people can both have a "worker-1" without colliding.
        agent: z.string().min(1).max(40),
        projectId: z.string().uuid().optional(),
        capabilities: z.array(z.string()).default([]),
      })
      .parse(req.body);

    const planeToken = (req.headers['authorization'] as string | undefined)
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    if (!planeToken) {
      throw new GatewayError(
        'UNAUTHENTICATED',
        'Send your Plane personal token as Authorization: Bearer <token>. Create one in Plane under your profile settings.',
      );
    }

    const identity = await identify(deps.planeBaseUrl, planeToken);

    if (body.projectId) {
      const visible = await visibleProjects(deps.planeBaseUrl, deps.workspaceSlug, planeToken);
      if (!visible.has(body.projectId)) {
        throw new GatewayError(
          'FORBIDDEN',
          `You are not a member of project ${body.projectId}, so an agent bound to it could not write. Add yourself to it in Plane first.`,
          { visibleProjects: [...visible] },
        );
      }
    }

    const name = agentName(identity, body.agent);
    const { token } = await issueToken(pool, {
      name,
      principal: `human:${identity.email || identity.displayName}`,
      capabilities: body.capabilities,
      planeUserId: identity.id,
      // The caller's own token, so Plane's activity log attributes the agent's
      // writes to them rather than to a shared service account.
      planeToken,
      ...(body.projectId ? { defaultProjectId: body.projectId } : {}),
      onlyIfOwnedBy: identity.id,
    });

    // Minting is a credential-issuing event: it belongs in the log whether or not
    // anyone is watching, because afterwards it is unreconstructable — only the
    // hash is kept.
    app.log.info(
      { agent: name, planeUser: identity.id, email: identity.email, project: body.projectId },
      'issued agent token (self-service)',
    );

    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const base = `${proto}://${req.headers['host'] ?? 'your-gateway'}`;
    return {
      token,
      agent: name,
      planeUser: { id: identity.id, email: identity.email },
      defaultProjectId: body.projectId ?? null,
      // Handing back the exact next command removes the step where someone
      // assembles it by hand from three places and gets the URL wrong.
      install: `claude mcp add --transport http sync ${base}/mcp --header "Authorization: Bearer ${token}"`,
      note: 'Shown once — only a hash is stored. Give this to the agent; never give it your Plane token.',
    };
  });

  // ── capture ──────────────────────────────────────────────────────────────
  app.post('/v1/capture', async (req) => {
    const actor = await actorOf(req);
    const input = CaptureBody.parse(req.body);
    // Created as the agent, so Plane's own activity log names the real author.
    return capture(plane.as(actor.planeToken), pool, actor, input);
  });

  // ── next (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/next', async (req) => {
    const actor = await actorOf(req);
    const q = NextQuery.parse(req.query);

    const candidates = await readyCandidates(plane, pool, {
      projectId: q.projectId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: q.limit,
    });
    return { candidates };
  });

  // ── claim ────────────────────────────────────────────────────────────────
  // Claim a specific item, or let the gateway pick. Picking must be one call:
  // `next` followed by `claim` is a TOCTOU race by construction.
  app.post('/v1/claim', async (req) => {
    const actor = await actorOf(req);
    const b = ClaimBody.parse(req.body);
    const chain = chainFor(actor, b.spawnedBy);

    if (b.workItemId) {
      const blockers = await verifyClaimable(plane, b.projectId, b.workItemId, {
        checkChildren: true,
      });
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
  app.post('/v1/heartbeat', async (req) => {
    const actor = await actorOf(req);
    const b = HeartbeatBody.parse(req.body);

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
    const b = ReleaseBody.parse(req.body);

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
    const b = CompleteBody.parse(req.body);

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
    const b = LinkBody.parse(req.body);

    await plane.as(actor.planeToken).relate(b.projectId, b.workItemId, b.relation, b.targets);
    return { ok: true };
  });

  // ── what am I holding? (agents restart) ──────────────────────────────────
  app.get('/v1/held', async (req) => {
    const actor = await actorOf(req);
    return { leases: await lease.heldBy(pool, actor.holder) };
  });

  // ── the MCP tool surface ─────────────────────────────────────────────────
  //
  // Agents install one stdio MCP server that knows nothing and forwards
  // everything here. That keeps the entire agent-facing surface — ours and
  // Plane's — deployable from the server, with no agent box to update.
  const toolDeps = { app, pool, plane: deps.planeMcp ?? null };

  app.get('/v1/tools', async (req) => {
    await actorOf(req); // authenticated: the catalogue names internal tooling
    return { tools: await listTools(toolDeps) };
  });

  // MCP over HTTPS. This is the onboarding path: an agent needs a URL and a
  // bearer token and nothing installed locally.
  //
  // The transport owns the response, so these handlers return nothing — see
  // reply.hijack() in handleMcpHttp.
  app.post('/mcp', async (req, reply) => {
    const actor = await actorOf(req);
    await handleMcpHttp(toolDeps, actor, req.headers['authorization'] as string, req, reply);
  });

  // The spec lets a client open a GET stream or DELETE a session. We run
  // stateless, so both are answered by the transport rather than 404ing — a
  // client that probes them should get a protocol-level answer, not an HTML page.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (req, reply) => {
        const actor = await actorOf(req);
        await handleMcpHttp(toolDeps, actor, req.headers['authorization'] as string, req, reply);
      },
    });
  }

  app.post('/v1/tools/call', async (req) => {
    const actor = await actorOf(req);
    const b = z
      .object({
        name: z.string().min(1),
        arguments: z.record(z.unknown()).default({}),
      })
      .parse(req.body);

    return callTool(
      toolDeps,
      actor,
      req.headers['authorization'] as string,
      b.name,
      b.arguments,
    );
  });
}
