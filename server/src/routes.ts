import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from './db.js';
import {
  authenticate,
  chainFor,
  issueToken,
  revokeByToken,
  revokeOwnedAgent,
  type Actor,
} from './auth.js';
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
import { board } from './board.js';
import { capture } from './capture.js';
import { citationsFor, recordCitations } from './citation.js';
import { linkReferences } from './references.js';
import {
  evidenceWarning,
  findEvidence,
  UNVERIFIED_LABEL,
  type EvidencePolicy,
} from './evidence.js';
import { ABSENT_LABEL, absent, checkEvidence, type GitHubConfig } from './ghcheck.js';
import { decompose } from './decompose.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import * as lease from './lease.js';
import { mirrorClaim, mirrorComplete, mirrorReturn } from './mirror.js';
import type { PlaneClient } from './plane.js';
import type { PlaneMcp } from './planemcp.js';
import { explain, readyCandidates, verifyClaimable } from './readiness.js';
import { find } from './find.js';
import { tree } from './tree.js';
import { parseFields } from './view.js';
import { handleMcpHttp } from './mcphttp.js';
import { callTool, listTools } from './tools.js';
import {
  BoardQuery,
  CaptureBody,
  ClaimBody,
  DecomposeBody,
  CompleteBody,
  HeartbeatBody,
  HistoryQuery,
  LinkBody,
  FindQuerySchema,
  NextQuery,
  TreeQuery,
  WhyQuery,
  ReleaseBody,
  SearchQuery,
} from './toolspec.js';

export interface Deps {
  pool: Pool;
  plane: PlaneClient;
  /** Agents may close their own work; humans audit afterwards. */
  allowAgentClose: boolean;
  /**
   * What to do about a completion citing nothing checkable.
   * 'warn' records it and labels the item; 'refuse' rejects the call.
   */
  evidencePolicy: EvidencePolicy;
  /**
   * Plane's own MCP server, hosted here. Null disables the proxied half of the
   * tool surface; the coordination half keeps working.
   */
  planeMcp?: PlaneMcp | null;
  /** Where Plane lives, for the self-service mint endpoint's identity check. */
  planeBaseUrl: string;
  workspaceSlug: string;
  /**
   * How to ask GitHub whether a cited artefact exists. Null disables checking,
   * and every citation is then honestly reported as `unchecked`.
   */
  github: GitHubConfig | null;
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

  /**
   * RFC 7009. Present the token to retire it.
   *
   * Always answers 200, including for a token that was never valid: the spec
   * requires an unknown token to be indistinguishable from a revoked one, so
   * this cannot be used to probe whether a token is live.
   */
  app.post('/oauth/revoke', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: unknown };
    if (typeof body.token === 'string' && body.token) {
      await revokeByToken(pool, body.token);
      app.log.info('agent token revoked via the revocation endpoint');
    }
    return reply.status(200).header('Cache-Control', 'no-store').send({});
  });

  /**
   * Retire one of your own agents, by name.
   *
   * `claude mcp logout` and "Clear authentication" only drop the local copy of a
   * credential, which does nothing about a token that has already been copied or
   * a machine you no longer have. This is the out-of-band path: it works from
   * anywhere, for tokens issued either way, and needs no shell on this host.
   *
   * The name may be given bare ("worker-1") or fully qualified ("you/worker-1");
   * a bare one is namespaced to the caller, so it can only ever address their own.
   */
  app.delete('/v1/agent-tokens/*', async (req, reply) => {
    if (!deps.allowMinting) {
      throw new GatewayError(
        'FORBIDDEN',
        'Self-service token management is disabled on this gateway (MINT_TOKENS=off). Ask your operator to revoke it with the CLI.',
      );
    }
    if (!mintAllowed(req.ip, Date.now())) {
      return reply.status(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many requests from this address.',
        recovery: 'Wait a minute and try again.',
      });
    }

    const raw = decodeURIComponent((req.params as Record<string, string>)['*'] ?? '');
    if (!raw) throw new GatewayError('INVALID', 'name the agent to revoke: DELETE /v1/agent-tokens/<agent>');

    const planeToken = (req.headers['authorization'] as string | undefined)
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    if (!planeToken) {
      throw new GatewayError(
        'UNAUTHENTICATED',
        'Send your Plane personal token as Authorization: Bearer <token>.',
      );
    }

    const identity = await identify(deps.planeBaseUrl, planeToken);
    // Try the qualified form first, then the bare one. Tokens issued by the CLI
    // are not namespaced, so without the second attempt this endpoint could not
    // retire them at all — and those are exactly the ones an operator is least
    // likely to be able to revoke by other means. Both are ownership-checked, so
    // the fallback widens what you can name, never whose agents you can touch.
    const candidates = raw.includes('/') ? [raw] : [agentName(identity, raw), raw];
    let name = candidates[0] as string;
    let revoked = false;
    for (const candidate of candidates) {
      if (await revokeOwnedAgent(pool, candidate, identity.id)) {
        name = candidate;
        revoked = true;
        break;
      }
    }

    if (!revoked) {
      // One message for "no such agent" and "not yours": the distinction would
      // only tell a caller which names exist, and the fix is the same either way.
      throw new GatewayError(
        'NOT_FOUND',
        `No active agent named "${name}" that you own. Check the name, or list your agents in the reply from a mint call.`,
      );
    }

    app.log.info({ agent: name, planeUser: identity.id }, 'agent token revoked');
    return {
      revoked: name,
      note: 'That token stops working immediately. Any agent still using it will get UNAUTHENTICATED on its next call.',
    };
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

  // ── decompose ────────────────────────────────────────────────────────────
  app.post('/v1/decompose', async (req) => {
    const actor = await actorOf(req);
    const b = DecomposeBody.parse(req.body);
    return decompose(plane.as(actor.planeToken), pool, actor, b);
  });

  // ── next (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/next', async (req) => {
    const actor = await actorOf(req);
    const q = NextQuery.parse(req.query);

    const candidates = await readyCandidates(plane, pool, {
      projectId: q.projectId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: q.limit,
      ...(parseFields(q.fields) ? { fields: parseFields(q.fields) } : {}),
    });
    // The project belongs on the envelope, not repeated on every row.
    return { projectId: q.projectId, candidates };
  });

  // ── why (read-only diagnostic) ───────────────────────────────────────────
  app.get('/v1/why', async (req) => {
    const actor = await actorOf(req);
    const q = WhyQuery.parse(req.query);
    return explain(plane, pool, {
      projectId: q.projectId,
      workItemId: q.workItemId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
    });
  });

  // ── tree (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/tree', async (req) => {
    const query = TreeQuery.parse(req.query);
    const actor = await actorOf(req);
    const { fields: rawFields, ...rest } = query;
    return tree(plane, pool, {
      ...rest,
      ...(parseFields(rawFields) ? { fields: parseFields(rawFields) } : {}),
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
    });
  });

  // ── board (read-only) ────────────────────────────────────────────────────
  app.get('/v1/board', async (req) => {
    const actor = await actorOf(req);
    const b = BoardQuery.parse(req.query);
    return board(plane, pool, {
      projectId: b.projectId,
      ...(b.moduleId ? { moduleId: b.moduleId } : {}),
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
    });
  });

  // ── search (read-only, workspace-wide) ───────────────────────────────────
  //
  // The only tool that crosses project boundaries, which makes scoping the whole
  // design question. It runs with the AGENT's Plane token, never the service
  // account: the service account can see every project, so falling back to it
  // would quietly turn a search box into a way to read projects the caller has no
  // access to. An agent without its own Plane identity is refused rather than
  // downgraded.
  app.get('/v1/search', async (req) => {
    const actor = await actorOf(req);
    const s = SearchQuery.parse(req.query);

    if (!actor.planeToken) {
      throw new GatewayError(
        'FORBIDDEN',
        'search reaches every project you can see, so it needs this agent to have its own ' +
          'Plane identity. Ask your operator to re-issue the token with --plane-token.',
      );
    }

    const hits = await plane.as(actor.planeToken).search(s.query);
    return {
      query: s.query,
      // Pointers, not items. A hit may be in a project whose states and labels we
      // have not loaded, and inventing a partial view of it would be worse than
      // saying plainly "here is where it lives, look there".
      results: hits.slice(0, s.limit).map((h) => ({
        workItemId: h.id,
        readableId: `${h.project__identifier}-${h.sequence_id}`,
        title: h.name,
        projectId: h.project_id,
      })),
      matched: hits.length,
    };
  });

  // ── find (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/find', async (req) => {
    const actor = await actorOf(req);
    const f = FindQuerySchema.parse(req.query);
    return find(plane, pool, {
      projectId: f.projectId,
      ...(f.labels ? { labels: f.labels.split(',') } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
      ...(f.stateGroup ? { stateGroup: f.stateGroup } : {}),
      ...(f.moduleId ? { moduleId: f.moduleId } : {}),
      ...(f.holder ? { holder: f.holder } : {}),
      ...(f.parentId ? { parentId: f.parentId } : {}),
      ...(f.ready ? { ready: f.ready } : {}),
      // The token's scope reaches the predicate from every entry point, so
      // find(ready:true) and next return the same set. They did not before.
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: f.limit,
      ...(parseFields(f.fields) ? { fields: parseFields(f.fields) } : {}),
    });
  });

  // ── history (read-only) ──────────────────────────────────────────────────
  app.get('/v1/history', async (req) => {
    await actorOf(req);
    const q = HistoryQuery.parse(req.query);
    const [leaseRecord, evidence] = await Promise.all([
      lease.record(pool, q.workItemId),
      citationsFor(pool, q.workItemId),
    ]);
    // A null record is the honest answer for an item nobody has ever claimed,
    // and materially different from one claimed and released. `evidence` answers
    // the other half — what each completion pointed at, and what GitHub said
    // about it when asked.
    return { workItemId: q.workItemId, record: leaseRecord, evidence };
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
        // The candidate came from a project-scoped query, so the project is the
        // one asked for. Repeating it on every row was the redundancy the shared
        // view exists to remove.
        projectId: b.projectId,
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

    const evidence = findEvidence(b.outcome);
    const warning = deps.evidencePolicy === 'off' ? null : evidenceWarning(b.outcome);

    // This call is the notification, so this is the moment to check. Not a
    // background sweep and not a webhook: the agent is on the line right now, and
    // an answer it receives while it can still act on it is worth more than one
    // discovered an hour later by something else.
    //
    // Before the lease ends, so `refuse` can still reject without leaving the
    // agent holding nothing. Failures inside are already `unchecked`, never
    // thrown — a lease must not fail to end because GitHub was slow.
    const checks = deps.evidencePolicy === 'off' ? [] : await checkEvidence(deps.github, evidence);
    const fabricated = absent(checks);

    // Refuse *before* ending the lease, or the agent is left holding nothing
    // while the item stays open — the one outcome worse than an unverified
    // completion. Off by default; see evidence.ts for why warn is the default.
    if (warning && deps.evidencePolicy === 'refuse') {
      throw new GatewayError('INVALID', warning, { workItemId: b.workItemId });
    }
    if (fabricated.length && deps.evidencePolicy === 'refuse') {
      throw new GatewayError(
        'INVALID',
        `This completion cites something that does not exist: ${fabricated
          .map((c) => c.detail)
          .join('; ')}. Fix the reference, or say plainly what was done instead.`,
        { workItemId: b.workItemId, evidence: checks },
      );
    }

    const l = await lease.complete(pool, {
      workItemId: b.workItemId,
      holder: actor.holder,
      epoch: b.epoch,
      reason: b.outcome,
    });

    // Work items the outcome names become edges. "Superseded by SYNC-32" was
    // already being parsed out of this text and thrown away; the relationship is
    // the whole reason the sentence was written.
    //
    // After the lease ends and best-effort, like the audit trail below: the lease
    // row is the commit point, and Plane being slow must not cost a completion.
    const references = await linkReferences(plane.as(actor.planeToken), {
      projectId: l.projectId,
      fromId: b.workItemId,
      text: b.outcome,
      ...(b.refs?.length ? { refs: b.refs } : {}),
    }).catch((err: unknown) => {
      req.log.warn({ err, workItemId: b.workItemId }, 'linking references failed');
      return [];
    });

    // After the lease ends, deliberately: the lease row is the commit point, and
    // a failure to write the audit trail must not cost an agent its completion.
    await recordCitations(pool, {
      workItemId: b.workItemId,
      projectId: l.projectId,
      actor: actor.holder,
      checks,
    }).catch((err: unknown) => {
      req.log.warn({ err, workItemId: b.workItemId }, 'recording citations failed');
    });

    void mirrorComplete(plane.as(actor.planeToken), pool, {
      projectId: l.projectId,
      workItemId: l.workItemId,
      actor,
      outcome: b.outcome,
      close: b.close && deps.allowAgentClose,
      // Two different failures, two different labels. `unverified` is an agent
      // being terse; `evidence-missing` is an agent being wrong, and it is now
      // evidence of absence rather than absence of evidence — GitHub was asked.
      labels: [
        ...(warning ? [UNVERIFIED_LABEL] : []),
        ...(fabricated.length ? [ABSENT_LABEL] : []),
      ],
    });

    // One field, because an agent reading two warnings has to work out which
    // matters. They are mutually exclusive anyway — a completion that cited
    // nothing has nothing to be wrong about.
    const notice =
      fabricated.length > 0
        ? `Recorded, and labelled "${ABSENT_LABEL}": ${fabricated.map((c) => c.detail).join('; ')}.`
        : warning;

    return {
      lease: l,
      closed: b.close && deps.allowAgentClose,
      evidence: checks.length ? checks : evidence,
      verified: checks.some((c) => c.status === 'landed'),
      // Only when the outcome named something. Reported rather than silent
      // because a reference that resolved to nothing is exactly the kind of
      // mistake this feature exists to stop being invisible.
      ...(references.length ? { references } : {}),
      ...(notice ? { warning: notice } : {}),
    };
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
