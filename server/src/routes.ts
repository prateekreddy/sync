import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from './db.js';
import { authenticate, chainFor, issueToken, type Actor } from './auth.js';
import { agentName, createRateLimiter, identify, visibleProjects } from './mint.js';
import {
  assertSafeRedirect,
  authServerMetadata,
  consentPage,
  findClient,
  issueCode,
  protectedResourceMetadata,
  publicBase,
  redeemCode,
  registerClient,
} from './oauth.js';
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
  /**
   * How this gateway is reached from outside, e.g. https://mcp.example.dev.
   * The OAuth issuer must be stable and must match what the client was told, so
   * behind a proxy that rewrites Host this has to be configured rather than
   * inferred.
   */
  publicUrl?: string | undefined;
  /** Plane's own address, used only to link to its token page from the consent screen. */
  planeWebUrl?: string | undefined;
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, plane } = deps;

  // OAuth speaks form encoding, not JSON — both the consent form and RFC 6749's
  // token endpoint. Fastify parses only JSON out of the box, so without this the
  // token exchange fails at the content type before any of our code runs.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const actorOf = (req: { headers: Record<string, unknown> }): Promise<Actor> =>
    authenticate(pool, req.headers['authorization'] as string | undefined);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof GatewayError) {
      // RFC 9728 §5.1. This header is what turns a 401 into an offer to sign in:
      // Claude Code reads it, fetches the metadata it names, registers itself and
      // runs the browser flow. Without it, a token-less connection is just a
      // failure the user has to diagnose.
      if (err.code === 'UNAUTHENTICATED') {
        const meta = `${publicBase(deps.publicUrl, req.headers, req.protocol)}/.well-known/oauth-protected-resource`;
        reply.header(
          'WWW-Authenticate',
          `Bearer realm="sync", resource_metadata="${meta}"`,
        );
      }
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

  /**
   * Shared by the JSON endpoint and the OAuth consent form, so the two doors
   * cannot drift on who is allowed to mint what.
   */
  async function mintFor(args: {
    planeToken: string;
    agent: string;
    projectId?: string | undefined;
    capabilities?: string[];
  }): Promise<{ token: string; name: string; email: string }> {
    const identity = await identify(deps.planeBaseUrl, args.planeToken);

    if (args.projectId) {
      const visible = await visibleProjects(deps.planeBaseUrl, deps.workspaceSlug, args.planeToken);
      if (!visible.has(args.projectId)) {
        throw new GatewayError(
          'FORBIDDEN',
          `You are not a member of project ${args.projectId}, so an agent bound to it could not write. Add yourself to it in Plane first.`,
          { visibleProjects: [...visible] },
        );
      }
    }

    const name = agentName(identity, args.agent);
    const { token } = await issueToken(pool, {
      name,
      principal: `human:${identity.email || identity.displayName}`,
      capabilities: args.capabilities ?? [],
      planeUserId: identity.id,
      // The caller's own token, so Plane's activity log attributes the agent's
      // writes to them rather than to a shared service account.
      planeToken: args.planeToken,
      ...(args.projectId ? { defaultProjectId: args.projectId } : {}),
      onlyIfOwnedBy: identity.id,
    });

    // Minting is a credential-issuing event: it belongs in the log whether or not
    // anyone is watching, because afterwards it is unreconstructable — only the
    // hash is kept.
    app.log.info(
      { agent: name, planeUser: identity.id, email: identity.email, project: args.projectId },
      'issued agent token',
    );
    return { token, name, email: identity.email };
  }

  // ── OAuth ────────────────────────────────────────────────────────────────
  //
  // So `claude mcp add --transport http sync <url>/mcp` is the entire command,
  // with no credential on it: the client discovers these endpoints from the 401
  // below, registers itself, and runs the browser flow. The token it receives is
  // an ordinary agent token, and it lands in the OS keychain rather than in a
  // config file or shell history.
  //
  // Headless runs (`claude -p`, the Agent SDK) cannot open a browser, so the
  // Authorization header path stays supported for them.
  const base = (req: { headers: Record<string, unknown>; protocol: string }) =>
    publicBase(deps.publicUrl, req.headers, req.protocol);

  app.get('/.well-known/oauth-protected-resource', async (req) =>
    protectedResourceMetadata(base(req)),
  );
  // Some clients probe the resource-suffixed form of the same document.
  app.get('/.well-known/oauth-protected-resource/mcp', async (req) =>
    protectedResourceMetadata(base(req)),
  );
  app.get('/.well-known/oauth-authorization-server', async (req) => authServerMetadata(base(req)));

  app.post('/oauth/register', async (req, reply) => {
    if (!deps.allowMinting) {
      throw new GatewayError('FORBIDDEN', 'Self-service tokens are disabled on this gateway.');
    }
    if (!mintAllowed(req.ip, Date.now())) {
      return reply.status(429).send({ error: 'too_many_requests' });
    }
    const c = await registerClient(pool, (req.body ?? {}) as Record<string, unknown>);
    return reply.status(201).send({
      client_id: c.clientId,
      client_name: c.client_name,
      redirect_uris: c.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  const AuthorizeQuery = z.object({
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    response_type: z.literal('code'),
    code_challenge: z.string().min(20),
    code_challenge_method: z.literal('S256'),
    state: z.string().optional(),
    scope: z.string().optional(),
  });

  /**
   * Validated before anything is rendered, and errors are shown rather than
   * redirected: until the redirect_uri is confirmed to belong to the client, it
   * is attacker-controlled and must not be used as a sink.
   */
  async function checkAuthorize(q: z.infer<typeof AuthorizeQuery>) {
    const client = await findClient(pool, q.client_id);
    if (!client) throw new GatewayError('INVALID', 'unknown client_id — register first');
    assertSafeRedirect(q.redirect_uri);
    if (!client.redirectUris.includes(q.redirect_uri)) {
      throw new GatewayError('INVALID', 'redirect_uri is not registered for this client');
    }
    return client;
  }

  app.get('/oauth/authorize', async (req, reply) => {
    const q = AuthorizeQuery.parse(req.query);
    await checkAuthorize(q);
    return reply.type('text/html').header('X-Frame-Options', 'DENY').send(
      consentPage({
        action: '/oauth/authorize',
        hidden: {
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          code_challenge: q.code_challenge,
          ...(q.state ? { state: q.state } : {}),
        },
        ...(deps.planeWebUrl ? { planeUrl: deps.planeWebUrl } : {}),
      }),
    );
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const form = z
      .object({
        client_id: z.string().min(1),
        redirect_uri: z.string().min(1),
        code_challenge: z.string().min(20),
        state: z.string().optional(),
        planeToken: z.string().min(1),
        agent: z.string().min(1).max(40),
        projectId: z.string().optional(),
      })
      .parse(req.body);

    if (!mintAllowed(req.ip, Date.now())) {
      return reply.status(429).type('text/html').send(
        consentPage({
          action: '/oauth/authorize',
          hidden: form as unknown as Record<string, string>,
          error: 'Too many attempts from this address. Wait a minute and try again.',
        }),
      );
    }

    await checkAuthorize({ ...form, response_type: 'code', code_challenge_method: 'S256' });

    let minted: { token: string; name: string };
    try {
      minted = await mintFor({
        planeToken: form.planeToken,
        agent: form.agent,
        ...(form.projectId ? { projectId: form.projectId } : {}),
      });
    } catch (err) {
      // Re-render with the reason instead of redirecting: a bad token or an
      // unreachable project is the user's to fix, here, not the client's.
      return reply.status(400).type('text/html').send(
        consentPage({
          action: '/oauth/authorize',
          hidden: {
            client_id: form.client_id,
            redirect_uri: form.redirect_uri,
            code_challenge: form.code_challenge,
            ...(form.state ? { state: form.state } : {}),
          },
          error: err instanceof GatewayError ? err.message : 'Could not issue a token.',
          ...(deps.planeWebUrl ? { planeUrl: deps.planeWebUrl } : {}),
        }),
      );
    }

    const code = issueCode(
      {
        clientId: form.client_id,
        redirectUri: form.redirect_uri,
        codeChallenge: form.code_challenge,
        accessToken: minted.token,
      },
      Date.now(),
    );

    const to = new URL(form.redirect_uri);
    to.searchParams.set('code', code);
    if (form.state) to.searchParams.set('state', form.state);
    return reply.redirect(to.toString(), 302);
  });

  app.post('/oauth/token', async (req, reply) => {
    const form = z
      .object({
        grant_type: z.literal('authorization_code'),
        code: z.string().min(1),
        redirect_uri: z.string().min(1),
        client_id: z.string().min(1),
        code_verifier: z.string().min(20),
      })
      .parse(req.body);

    let accessToken: string;
    try {
      accessToken = redeemCode(
        form.code,
        {
          clientId: form.client_id,
          redirectUri: form.redirect_uri,
          codeVerifier: form.code_verifier,
        },
        Date.now(),
      );
    } catch (err) {
      // The token endpoint speaks RFC 6749 error codes, not ours.
      return reply.status(400).send({
        error: 'invalid_grant',
        error_description: err instanceof Error ? err.message : 'code could not be redeemed',
      });
    }

    // No expiry and no refresh token: agent tokens live until revoked, so an
    // expiry here would promise a rotation that does not happen.
    return reply
      .header('Cache-Control', 'no-store')
      .send({ access_token: accessToken, token_type: 'Bearer', scope: 'agent' });
  });

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

    const minted = await mintFor({
      planeToken,
      agent: body.agent,
      capabilities: body.capabilities,
      ...(body.projectId ? { projectId: body.projectId } : {}),
    });

    return {
      token: minted.token,
      agent: minted.name,
      planeUser: { email: minted.email },
      defaultProjectId: body.projectId ?? null,
      // Handing back the exact next command removes the step where someone
      // assembles it by hand from three places and gets the URL wrong.
      install: `claude mcp add --transport http sync ${base(req)}/mcp --header "Authorization: Bearer ${minted.token}"`,
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
