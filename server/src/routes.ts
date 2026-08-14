import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pool } from './db.js';
import {
  authenticate,
  chainFor,
  issueToken,
  listOwnedAgents,
  revokeByToken,
  revokeOwnedAgent,
  type Actor,
} from './auth.js';
import {
  agentName,
  createRateLimiter,
  identify,
  resolveProject,
  visibleProjects,
} from './mint.js';
import {
  assertSafeRedirect,
  authServerMetadata,
  authorizeRedirect,
  consentPage,
  defaultAgentLabel,
  findClient,
  issueCode,
  protectedResourceMetadata,
  publicBase,
  redeemCode,
  registerClient,
} from './oauth.js';
import { assertCanRead } from './access.js';
import { closeWatch, mintWatch, pollWatch, watchExpired } from './watch.js';
import { approvalNeeded, takeoverApproval } from './assignment.js';
import { board } from './board.js';
import { buildIdentity, schemaLevel } from './build.js';
import { capture } from './capture.js';
import { constrain } from './constrain.js';
import { citationsFor, recordCitations } from './citation.js';
import { linkReferences } from './references.js';
import {
  evidenceWarning,
  findEvidence,
  UNVERIFIED_LABEL,
  type EvidencePolicy,
} from './evidence.js';
import {
  ABSENT_LABEL,
  absent,
  checkEvidence,
  unproven,
  type GitHubConfig,
} from './ghcheck.js';
import { gather } from './gather.js';
import { decompose } from './decompose.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import * as lease from './lease.js';
import { escapeHtml } from './html.js';
import { reinstate, retract } from './retraction.js';
import { mirrorClaim, mirrorComplete, mirrorReturn } from './mirror.js';
import type { PlaneClient } from './plane.js';
import type { PlaneMcp } from './planemcp.js';
import { explain, readyCandidates, verifyClaimable } from './readiness.js';
import { briefingFor } from './briefing.js';
import { find } from './find.js';
import { tree } from './tree.js';
import { parseFields } from './view.js';
import { handleMcpHttp } from './mcphttp.js';
import { rankAcross, searchItems } from './textsearch.js';
import { callTool, listTools } from './tools.js';
import {
  BoardQuery,
  CaptureBody,
  ClaimBody,
  DecomposeBody,
  GatherBody,
  CompleteBody,
  HeartbeatBody,
  HistoryQuery,
  ConstrainBody,
  LinkBody,
  UnlinkBody,
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

/**
 * " — you sent 2160" for a length that overran, and nothing otherwise.
 *
 * Zod names the limit but never the value, so a caller over a cap has to guess
 * how much to cut. On `complete` that guess costs a round trip per attempt, and
 * the field it bites is `outcome`, where the caller is usually an agent that
 * cannot see the schema.
 *
 * Exported for its own test: the interesting cases are the ones where it must
 * stay silent rather than the one where it speaks, because a wrong number here
 * is worse than none.
 */
export function sizeSuffix(
  issue: z.ZodIssue,
  req: { body?: unknown; query?: unknown },
): string {
  if (issue.code !== 'too_big' && issue.code !== 'too_small') return '';

  // The body first, then the query: a GET validates its query string, and the
  // same field name can exist in both on a route that takes each.
  let node: unknown = (req.body as Record<string, unknown> | undefined) ?? undefined;
  for (const key of issue.path) node = (node as Record<string, unknown> | undefined)?.[key as never];
  if (node === undefined) {
    node = req.query;
    for (const key of issue.path) node = (node as Record<string, unknown> | undefined)?.[key as never];
  }

  if (typeof node === 'string') return ` — you sent ${node.length}`;
  if (Array.isArray(node)) return ` — you sent ${node.length}`;
  // Numbers are their own message ("must be less than or equal to 3600"), and
  // echoing the value back adds nothing. Anything else, stay quiet.
  return '';
}

/**
 * How many projects a workspace-wide search will read in full.
 *
 * The sweep is one request per project, spent from the *caller's* Plane budget
 * rather than a shared one, and `workspace: true` is a flag someone set on
 * purpose — so the bound exists to stop a pathological workspace, not to ration
 * an ordinary one. Past it the search falls back to titles and says so.
 */
const WORKSPACE_SWEEP_LIMIT = 25;

/**
 * Which client session this request belongs to.
 *
 * Carried by a header the plugin sets from `${CLAUDE_CODE_SESSION_ID}`. The intent
 * is that the model is never asked for it, never sees it, and cannot forget or
 * invent it — a body field the model has to populate would be exactly the kind of
 * promise-for-later this design exists to stop relying on.
 *
 * Measured on the first real plugin install, 2026-08-09: Claude Code sets
 * CLAUDE_CODE_SESSION_ID in the environment of processes it SPAWNS — hooks and
 * Bash see it — but NOT in its own, which is what an MCP server config is
 * expanded against. So no `${...}` form of it can ever resolve there, and for a
 * while every lease was recorded with a null session while the gateway quietly
 * degraded to holder-level behaviour.
 *
 * Fixed and verified live 2026-08-10 (SYNC-87): the config defaults the variable
 * to empty so the server loads at all, and `sessionKey` falls back to the MCP
 * session id, which is what now populates `lease.session_id`. The fallbacks
 * below still matter for clients that are not the plugin.
 *
 * The header therefore wins over the body. The body remains as a fallback for
 * clients that are not the plugin, and it is the less trustworthy of the two:
 * anything the model types is a guess about its own identity.
 *
 * An unsubstituted `${...}` is treated as absent rather than as a session id. A
 * client that failed to expand it would otherwise send one identical literal from
 * every window on every machine -- collapsing every agent everywhere into a single
 * session, which is worse than having no session at all: retries would match
 * across unrelated agents and hand one the other's lease.
 */
/**
 * Said on a claim when this agent's liveness monitor has never been seen.
 *
 * The monitor is what keeps a claim alive, and its entire chain — hook matcher,
 * credential harvest, watch file, poll — was broken for weeks with every part
 * reporting success. Nothing on the agent's machine could notice, because each
 * link's failure looks exactly like "nothing to do". The gateway is the one
 * participant that can see the absence, so it is the one that has to say it.
 *
 * On `claim` because that is the call every agent makes and the moment the
 * protection is supposed to start. Absent from the reply when the monitor is
 * working or when there is no evidence either way — a field that appears only
 * when something is wrong is one nobody learns to ignore.
 */
async function livenessNote(
  pool: Pool,
  holder: string,
): Promise<{ warning?: string }> {
  const seen = await lease.monitorSeen(pool, holder);
  if (!seen.known || seen.polled) return {};
  return {
    warning:
      'Your liveness monitor is not running: no claim of yours has ever been polled, so ' +
      'this lease will lapse on its timer and another agent may take the item. Tell the ' +
      'person you are working with — the sync plugin may need updating or reinstalling.',
  };
}

/**
 * Said on a claim that displaced a holder which was demonstrably still working.
 *
 * The other half of SYNC-86. `lease.claim` detects it — the previous holder
 * called the gateway after its own lease had expired — and this is where the
 * agent that just took the work is told, because it is the only party in a
 * position to stop before the two of them duplicate each other.
 *
 * Deliberately not a refusal. The gateway cannot know which of them should have
 * the item, and refusing would deadlock the board whenever an agent's monitor is
 * broken: the item would be unclaimable until a lease nobody is extending
 * finally aged out of the window. Saying it plainly is what "not silently
 * recycled" asks for, and the displaced agent learns independently — its next
 * poll answers 410.
 */
function takeoverNote(l: lease.Lease): {
  contested?: { previousHolder: string; lastSeenAt: string; warning: string };
} {
  if (!l.tookOverFrom) return {};
  return {
    contested: {
      previousHolder: l.tookOverFrom.holder,
      lastSeenAt: l.tookOverFrom.lastSeenAt,
      warning:
        `This item's lease had lapsed, but ${l.tookOverFrom.holder} was still calling the gateway ` +
        `at ${l.tookOverFrom.lastSeenAt} — after that lease had already expired. That is an agent ` +
        'whose liveness monitor is not running, not one that stopped working, so it may still be ' +
        'working this item and about to duplicate whatever you do. Check with a human before ' +
        'starting, and say so if you proceed.',
    },
  };
}

export function sessionOf(
  req: Pick<FastifyRequest, 'headers'>,
  body?: { sessionId?: string | undefined },
): string | null {
  const raw = req.headers['x-sync-session'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const usable =
    header && header.trim() && !header.includes('${') ? header.trim().slice(0, 200) : null;
  return usable ?? body?.sessionId ?? null;
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

  /**
   * Refuse a project this caller's own Plane user cannot see (SYNC-64).
   *
   * At the door, and deliberately not by swapping the service account out of the
   * tools themselves: the readiness gate needs the workspace-wide view to see
   * blockers in projects the caller cannot read, and scoping it would make an
   * unreadable blocker look like no blocker. Past this check the caller is
   * entitled to the project's contents, so which client fetches them stops
   * mattering. See access.ts.
   */
  const canRead = (actor: Actor, projectId: string): Promise<void> =>
    assertCanRead(plane, actor, projectId);

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
          // Zod says "String must contain at most 2000 character(s)" but never
          // what was sent, which leaves a caller trimming blind — and blind
          // trimming of a completion outcome costs a round trip each attempt.
          problem: i.message + sizeSuffix(i, req),
        })),
      });
    }
    if (err instanceof Error && 'validation' in err) {
      return reply.status(400).send({ error: 'INVALID', message: err.message });
    }
    app.log.error({ err }, 'unhandled');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  // Unauthenticated, and says which build it is. See build.ts for why that is
  // worth the sha being public. `ok` stays first and stays a boolean: the
  // Docker HEALTHCHECK reads the status code, and bin/onboard.sh substring-
  // matches on `"ok"` before it will send a token anywhere.
  const build = buildIdentity();
  app.get('/healthz', async () => ({
    ok: true,
    build,
    schema: await schemaLevel(deps.pool),
  }));

  // ── watch (the monitor's channel) ────────────────────────────────────────
  //
  // No Authorization header: the URL *is* the credential. That is not a shortcut
  // — the background monitor is a separate OS process and cannot reach the OAuth
  // token Claude Code holds, so possession has to be the proof. It is safe only
  // because of how little this can do: extend this session's leases and report
  // them. It cannot claim, complete, capture, or read a work item.
  //
  // `logLevel: 'silent'` is load-bearing. Fastify logs request URLs by default,
  // and the URL here is the password — logging it would put a live credential in
  // every log aggregator this gateway ships to.
  const watchOpts = { logLevel: 'silent' as const };

  app.get<{ Params: { capability: string } }>('/v1/watch/:capability', watchOpts, async (req, reply) => {
    const base = publicBase(deps.publicUrl, req.headers, req.protocol);
    // Which of the three callers this is. The monitor, the push fence and the
    // resume report all poll here, and only the monitor says anything about
    // liveness — so the gateway used to read "something polled" as "the monitor
    // is running" and go quiet on sessions whose monitor was dead but whose
    // hooks were firing.
    //
    // A User-Agent rather than a query parameter, because the credential is in
    // the path and query strings are the part of a URL most likely to be logged,
    // copied or trimmed by something in the middle. An older plugin sends
    // nothing recognisable and is simply never counted as a monitor, which
    // errs toward warning rather than toward false silence.
    const ua = req.headers['user-agent'];
    const fromMonitor = typeof ua === 'string' && ua.startsWith('sync-monitor');
    const state = await pollWatch(pool, req.params.capability, base, fromMonitor);
    if (!state) {
      // Two very different things arrive here, and until 2026-08-10 they shared
      // a status code and therefore a meaning.
      //
      // 401: the credential aged out. Nobody touched the work. This is ignorance
      // about who holds the item now, not a verdict on it, so the fence must NOT
      // refuse a push on it and nobody may be told to discard anything. A plugin
      // too old to know this code falls into its `*` branch, which allows the
      // push and stays quiet — the safe direction by construction.
      if (await watchExpired(pool, req.params.capability)) {
        return reply.status(401).send({
          error: 'EXPIRED',
          message:
            "This session's credential expired after a long gap, so the lease is no longer being kept alive. " +
            'Nobody has taken your work. Call `held` to see where you stand and re-claim the item if it is free.',
        });
      }

      // 410: gone, not unauthorized, and the distinction is the whole point. The
      // capability was cleared because another session claimed the item, so this
      // work is definitively not yours any more. A network failure means the
      // client could not ask at all. The push fence must refuse on this and
      // allow on the other, so they cannot share a code.
      return reply.status(410).send({ error: 'GONE', message: 'This lease is no longer yours.' });
    }
    return state;
  });

  app.delete<{ Params: { capability: string } }>('/v1/watch/:capability', watchOpts, async (req) => {
    // Driven by the SessionEnd hook. Best-effort by construction — it does not
    // run when a process is killed — so it makes the common case immediate rather
    // than being the guarantee. The lease TTL remains the thing that cannot be
    // skipped.
    const released = await closeWatch(pool, req.params.capability);
    return { released };
  });

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
  const mintAllowed = createRateLimiter(pool, deps.mintRatePerMinute);

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

    // Resolved, not merely checked: the caller may have picked from a dropdown,
    // pasted a uuid, or typed the project's name, and all three should work.
    let projectId = args.projectId;
    if (projectId) {
      const visible = await visibleProjects(deps.planeBaseUrl, deps.workspaceSlug, args.planeToken);
      const match = resolveProject(visible, projectId);
      if (!match) {
        throw new GatewayError(
          'FORBIDDEN',
          `No project "${projectId}" that you can see, so an agent bound to it could not write. ` +
            `Pick one of: ${visible.map((p) => p.name).join(', ') || '(none — you are not a member of any project)'}`,
          { visibleProjects: visible },
        );
      }
      projectId = match.id;
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
      ...(projectId ? { defaultProjectId: projectId } : {}),
      onlyIfOwnedBy: identity.id,
    });

    // Minting is a credential-issuing event: it belongs in the log whether or not
    // anyone is watching, because afterwards it is unreconstructable — only the
    // hash is kept.
    app.log.info(
      { agent: name, planeUser: identity.id, email: identity.email, project: projectId },
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
    if (!(await mintAllowed(req.ip))) {
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
    const client = await checkAuthorize(q);
    return reply.type('text/html').header('X-Frame-Options', 'DENY').send(
      consentPage({
        action: '/oauth/authorize',
        hidden: {
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          code_challenge: q.code_challenge,
          ...(q.state ? { state: q.state } : {}),
        },
        agentDefault: defaultAgentLabel(client),
        ...(deps.planeWebUrl ? { planeUrl: deps.planeWebUrl } : {}),
      }),
    );
  });

  /**
   * The projects this Plane token can see, for the consent screen's dropdown.
   *
   * Exists because the consent page is rendered before anyone has typed a token,
   * so the server cannot know the list at render time. Takes no gateway
   * credential, for the same reason the mint endpoint does not: the caller is
   * proving who they are with the Plane token in the body, and this returns
   * strictly less than that token already grants them.
   *
   * Rate limited on the same per-address budget as minting. It calls Plane once
   * per request, so an unthrottled one lets a stranger burn the workspace's
   * rate-limit budget with someone else's stolen token.
   */
  app.post('/oauth/projects', async (req, reply) => {
    if (!(await mintAllowed(req.ip))) {
      return reply.status(429).send({ error: 'RATE_LIMITED' });
    }
    const b = z.object({ planeToken: z.string().min(1) }).parse(req.body);
    // A bad token returns an empty list rather than an error: this endpoint is a
    // convenience behind a field the user is still filling in, and the real
    // verdict on the token belongs to the authorize step, which says so properly.
    const projects = await visibleProjects(
      deps.planeBaseUrl,
      deps.workspaceSlug,
      b.planeToken,
    ).catch(() => []);
    return reply.send(projects);
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const form = z
      .object({
        client_id: z.string().min(1),
        redirect_uri: z.string().min(1),
        code_challenge: z.string().min(20),
        state: z.string().optional(),
        planeToken: z.string().min(1),
        // Optional now. The consent page prefills it from the client
        // registration, and a caller that clears the field gets the same value
        // rather than a refusal — see defaultAgentLabel for why the name is not
        // a thing a person should have to invent.
        agent: z.string().max(40).optional(),
        projectId: z.string().optional(),
      })
      .parse(req.body);

    if (!(await mintAllowed(req.ip))) {
      return reply.status(429).type('text/html').send(
        consentPage({
          action: '/oauth/authorize',
          hidden: form as unknown as Record<string, string>,
          error: 'Too many attempts from this address. Wait a minute and try again.',
        }),
      );
    }

    const client = await checkAuthorize({
      ...form,
      response_type: 'code',
      code_challenge_method: 'S256',
    });
    // Falls back rather than refusing: a blank field means "you pick", and the
    // value it picks is stable per installation, so signing in again from this
    // client re-authenticates the same agent instead of minting one beside it.
    const agent = form.agent?.trim() || defaultAgentLabel(client);

    let minted: { token: string; name: string };
    try {
      minted = await mintFor({
        planeToken: form.planeToken,
        agent,
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
          // The name they actually used, not a fresh default: a retry after a
          // bad Plane token should not silently rename the agent they chose.
          agentDefault: agent,
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

    // `base(req)` is the same value `/.well-known/oauth-authorization-server`
    // advertises as `issuer`, which is what makes the `iss` parameter checkable.
    return reply.redirect(
      authorizeRedirect({
        redirectUri: form.redirect_uri,
        code,
        issuer: base(req),
        state: form.state,
      }),
      302,
    );
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
  // ── list your own agents ─────────────────────────────────────────────────
  //
  // The third side of the self-service triangle. Minting and revoking were both
  // possible without an operator and enumeration was not, so an agent whose name
  // you had forgotten could never be revoked — which is the situation revocation
  // exists for. Gated with the other two: an operator who turns self-service off
  // expects the whole surface gone, not two thirds of it.
  app.get('/v1/agent-tokens', async (req, reply) => {
    if (!deps.allowMinting) {
      throw new GatewayError(
        'FORBIDDEN',
        'Self-service token management is disabled on this gateway (MINT_TOKENS=off). Ask your operator to list them with the CLI.',
      );
    }
    if (!(await mintAllowed(req.ip))) {
      return reply.status(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many requests from this address.',
        recovery: 'Wait a minute and try again.',
      });
    }

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
    const agents = await listOwnedAgents(pool, identity.id);
    return {
      agents,
      // Said rather than left to be inferred from an empty list: agents issued
      // from the CLI without --plane-token have no recorded owner and cannot
      // appear here for anyone.
      note:
        'Agents issued from the CLI without --plane-token have no recorded Plane owner and are not listed here. An operator can see every agent with `cli.js list-tokens`.',
    };
  });

  app.delete('/v1/agent-tokens/*', async (req, reply) => {
    if (!deps.allowMinting) {
      throw new GatewayError(
        'FORBIDDEN',
        'Self-service token management is disabled on this gateway (MINT_TOKENS=off). Ask your operator to revoke it with the CLI.',
      );
    }
    if (!(await mintAllowed(req.ip))) {
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
    if (!(await mintAllowed(req.ip))) {
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
    // The session comes off the header rather than the body: it decides only
    // which of this holder's items the provenance points at, and it is not
    // something the model should be asked to supply.
    return capture(plane.as(actor.planeToken), pool, actor, {
      ...input,
      sessionId: sessionOf(req),
    });
  });

  // ── decompose ────────────────────────────────────────────────────────────
  app.post('/v1/decompose', async (req) => {
    const actor = await actorOf(req);
    const b = DecomposeBody.parse(req.body);
    return decompose(plane.as(actor.planeToken), pool, actor, b);
  });

  // ── gather ───────────────────────────────────────────────────────────────
  app.post('/v1/gather', async (req) => {
    const actor = await actorOf(req);
    const b = GatherBody.parse(req.body);
    await canRead(actor, b.projectId);
    return gather(plane.as(actor.planeToken), actor, b);
  });

  // ── next (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/next', async (req) => {
    const actor = await actorOf(req);
    const q = NextQuery.parse(req.query);
    await canRead(actor, q.projectId);

    const candidates = await readyCandidates(plane, pool, {
      projectId: q.projectId,
      viewer: actor.planeUserId,
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
    await canRead(actor, q.projectId);
    return explain(plane, pool, {
      projectId: q.projectId,
      viewer: actor.planeUserId,
      workItemId: q.workItemId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
    });
  });

  // ── tree (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/tree', async (req) => {
    const query = TreeQuery.parse(req.query);
    const actor = await actorOf(req);
    await canRead(actor, query.projectId);
    const { fields: rawFields, ...rest } = query;
    return tree(plane, pool, {
      ...rest,
      viewer: actor.planeUserId,
      ...(parseFields(rawFields) ? { fields: parseFields(rawFields) } : {}),
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
    });
  });

  // ── board (read-only) ────────────────────────────────────────────────────
  app.get('/v1/board', async (req) => {
    const actor = await actorOf(req);
    const b = BoardQuery.parse(req.query);
    await canRead(actor, b.projectId);
    return board(plane, pool, {
      projectId: b.projectId,
      viewer: actor.planeUserId,
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

    // Crossing project boundaries is the only part that needs the agent's own
    // Plane identity — inside its own project the token's binding already grants
    // the access.
    const needsOwnIdentity = s.workspace || (s.projectId && s.projectId !== actor.defaultProjectId);
    if (needsOwnIdentity && !actor.planeToken) {
      throw new GatewayError(
        'FORBIDDEN',
        'Searching outside your own project reaches work Plane decides you can see, so it ' +
          'needs this agent to have its own Plane identity. Ask your operator to re-issue the ' +
          'token with --plane-token, or search your own project instead.',
      );
    }

    const scoped = plane.as(actor.planeToken);

    if (s.workspace) {
      const projects = await scoped.listProjects();

      // Above the cap, fall back rather than sweep. Reading the first N projects
      // would silently skip the one the caller wanted, and a search that quietly
      // omits where the answer was is worse than one that says what it could not
      // reach.
      if (projects.length > WORKSPACE_SWEEP_LIMIT) {
        const hits = await scoped.search(s.query);
        return {
          query: s.query,
          scope: 'workspace',
          matchedOn: `titles only — ${projects.length} projects is past the ${WORKSPACE_SWEEP_LIMIT} this will read for descriptions. Name a projectId to search its descriptions too`,
          projectsSearched: projects.length,
          // Pointers, not items. A hit may be in a project whose states and
          // labels we have not loaded, and inventing a partial view of it would
          // be worse than saying plainly "here is where it lives, look there".
          results: hits.slice(0, s.limit).map((h) => ({
            workItemId: h.id,
            readableId: `${h.project__identifier}-${h.sequence_id}`,
            title: h.name,
            projectId: h.project_id,
            where: 'title' as const,
          })),
          matched: hits.length,
        };
      }

      // Concurrently: the sweep is one request per project, and doing them in
      // series would make the wall-clock the sum rather than the slowest.
      const perProject = await Promise.all(
        projects.map(async (p) => {
          const items = await scoped.listWorkItems(p.id).catch(() => null);
          // A project that errors is reported, not silently treated as empty —
          // "no results" and "could not look" are different answers.
          if (!items) return { unreadable: p.identifier || p.id, hits: [] };
          return {
            hits: searchItems(items, s.query, { projectId: p.id, projectIdentifier: p.identifier }),
          };
        }),
      );

      // Title hits from every project before any body hit from any of them, or
      // the order projects happened to be listed in decides the answer.
      const results = rankAcross(perProject.map((r) => r.hits), s.limit);
      const unreadable = perProject.flatMap((r) => ('unreadable' in r ? [r.unreadable] : []));

      return {
        query: s.query,
        scope: 'workspace',
        matchedOn: 'titles and descriptions',
        projectsSearched: projects.length - unreadable.length,
        ...(unreadable.length ? { unreadableProjects: unreadable } : {}),
        results,
        matched: results.length,
      };
    }

    const projectId = s.projectId ?? actor.defaultProjectId;
    if (!projectId) {
      throw new GatewayError(
        'INVALID',
        'No project to search: this token is not bound to one. Pass projectId, or workspace: ' +
          'true to search titles across every project you can see.',
      );
    }

    const items = await scoped.listWorkItems(projectId);
    const results = searchItems(items, s.query, { projectId, limit: s.limit });
    return {
      query: s.query,
      scope: 'project',
      projectId,
      matchedOn: 'titles and descriptions',
      results,
      matched: results.length,
    };
  });

  // ── find (read-only) ─────────────────────────────────────────────────────
  app.get('/v1/find', async (req) => {
    const actor = await actorOf(req);
    const f = FindQuerySchema.parse(req.query);
    await canRead(actor, f.projectId);
    return find(plane, pool, {
      projectId: f.projectId,
      viewer: actor.planeUserId,
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
    const actor = await actorOf(req);
    const q = HistoryQuery.parse(req.query);
    // `projectId` was required by the schema and then used for nothing, so an
    // agent could read any item's claim history and citations by id alone. The
    // parameter was already there; only the check was missing.
    await canRead(actor, q.projectId);
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
    // Checked here too, though claim is a write: the lease is gateway-side, so
    // without this an agent knowing an id could take work in a project it cannot
    // see and block whoever can.
    await canRead(actor, b.projectId);
    const chain = chainFor(actor, b.spawnedBy);

    if (b.workItemId) {
      // An approval already on record is an input to the gate rather than an
      // override of it: `verifyClaimable` reads the table and stops reporting the
      // assignee once permission is there. Recording it outlives this call, so a
      // compaction between the human's yes and the claim cannot lose it.
      const approval = await takeoverApproval(pool, b.workItemId);

      const blockers = await verifyClaimable(plane, b.projectId, b.workItemId, {
        checkChildren: true,
        pool,
        viewer: actor.planeUserId,
      });
      if (blockers.length) {
        // A name on the item is the one refusal an agent cannot clear by itself,
        // and the one a human can clear in seconds. Reported as its own code with
        // the assignee attached, so the MCP layer can put the question to a person
        // rather than the agent having to parse a sentence to find out what to ask.
        const needs = await approvalNeeded(plane, pool, {
          projectId: b.projectId,
          workItemId: b.workItemId,
          viewer: actor.planeUserId,
        });
        if (needs && blockers.length === 1) {
          throw new GatewayError(
            'NEEDS_APPROVAL',
            `${needs.readableId} is assigned to ${needs.names}. Taking it needs their agreement.`,
            {
              workItemId: b.workItemId,
              projectId: b.projectId,
              readableId: needs.readableId,
              assignedTo: needs.names,
              takenFrom: needs.assignees[0] ?? null,
            },
          );
        }
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
        sessionId: sessionOf(req, b),
      });
      if (!l) {
        // Who, and until when — carried by the refusal rather than left for a
        // second call (SYNC-118).
        //
        // The gateway had both facts in hand at the moment it refused and said
        // neither, while `why` on the same item one call later answered "held by
        // agent:…/worker-10 until 12:33:40Z". Three costs, and the third is the
        // one that decided it: every refused agent paid a round trip; "pick a
        // different one" is wrong advice for a lease lapsing in ninety seconds
        // and right for one with forty minutes left, and the agent could not
        // tell those apart; and a refusal that names nobody is equally
        // consistent with exclusion keyed on the shared human root, which made a
        // real cross-agent test inconclusive until `why` supplied the holder.
        //
        // The asymmetry is what makes it a defect rather than a terseness: an
        // agent that distrusts the error and calls `why` gets a good answer, and
        // one that believes it and moves on gets a worse outcome. An error that
        // rewards ignoring it is training every reader the wrong lesson.
        //
        // Read after the failure, not before it: claim stays one atomic
        // statement, and this costs a query only on the path that already lost.
        // If the lease ended in between, `holder` is absent and the message says
        // less rather than something untrue.
        const holder = (await lease.liveHolders(pool, [b.workItemId])).get(b.workItemId);
        const detail = holder
          ? { heldBy: holder.holder, heldUntil: holder.expiresAt.toISOString() }
          : {};
        let message = 'Another agent holds this item';
        if (holder) {
          const left = holder.expiresAt.getTime() - Date.now();
          const mins = Math.max(0, Math.round(left / 60_000));
          message =
            `${holder.holder} holds this item until ${holder.expiresAt.toISOString()}` +
            // The steer the static recovery line cannot give, because it does not
            // know the expiry. Both halves are advice an agent can act on now.
            (left <= 2 * 60_000
              ? ' — under two minutes left, so waiting and retrying may beat switching.'
              : ` (about ${mins} minutes) — pick a different item rather than waiting.`);
        }
        throw new GatewayError('NOT_CLAIMABLE', message, {
          workItemId: b.workItemId,
          ...detail,
        });
      }
      // Awaited, not fired and forgotten. A lease Plane never heard about is one
      // no human can see, so the board keeps offering the item and a second agent
      // takes it. Better to hand it back and say so than to hold work invisibly.
      try {
        await mirrorClaim(plane.as(actor.planeToken), pool, {
          projectId: b.projectId,
          workItemId: l.workItemId,
          actor,
          epoch: l.epoch,
          expiresAt: l.expiresAt,
          ...(approval ? { takeover: { takenFrom: approval.takenFrom } } : {}),
        });
      } catch (err) {
        // Not on a retry: that lease was granted and mirrored by the original
        // request, and this copy failing must not retract it.
        if (!l.retried) {
          await lease.rollbackClaim(pool, {
            workItemId: l.workItemId,
            holder: actor.holder,
            epoch: l.epoch,
          });
        }
        throw err;
      }
      // Handed over WITH the lease rather than left for the agent to go and ask
      // for. An agent that must remember to call tree, history and get_issue
      // after every claim will not, under context pressure — the same argument
      // that put module inheritance and lease-derived provenance in `capture`.
      // Handed back with the lease so the plugin's hook can store it without the
      // model doing anything. `claim` is the one call an agent must make, which
      // makes it the only place a credential can be issued without inventing a
      // new obligation for something that forgets.
      const watch = await mintWatch(pool, {
        sessionId: sessionOf(req, b),
        workItemId: l.workItemId,
      });
      return {
        lease: l,
        watchUrl: `${publicBase(deps.publicUrl, req.headers, req.protocol)}/v1/watch/${watch}`,
        ...(await livenessNote(pool, actor.holder)),
        ...takeoverNote(l),
        // Spread, so `briefingError` travels with `briefing: null` rather than
        // the absence being left to speak for itself — it cannot (SYNC-67).
        ...(await briefingFor(
          plane.as(actor.planeToken),
          { projectId: b.projectId, workItemId: l.workItemId },
          (err) => req.log.warn({ err, workItemId: l.workItemId }, 'briefing failed'),
        )),
      };
    }

    // Pick-and-claim. Blocker verification happens per candidate, so an item that
    // looks ready in the list but is actually blocked costs one attempt, not a
    // wasted agent run.
    const candidates = await readyCandidates(plane, pool, {
      projectId: b.projectId,
      viewer: actor.planeUserId,
      ...(actor.capabilities.length ? { capabilities: actor.capabilities } : {}),
      limit: 10,
    });

    for (const c of candidates) {
      if (
        (await verifyClaimable(plane, b.projectId, c.workItemId, { pool, viewer: actor.planeUserId }))
          .length
      )
        continue;
      const l = await lease.claim(pool, {
        workItemId: c.workItemId,
        // The candidate came from a project-scoped query, so the project is the
        // one asked for. Repeating it on every row was the redundancy the shared
        // view exists to remove.
        projectId: b.projectId,
        holder: actor.holder,
        holderChain: chain,
        ttlSeconds: b.ttlSeconds,
        sessionId: sessionOf(req, b),
      });
      if (!l) continue; // lost the race; try the next one
      // Same rule as the explicit claim above, and the failure is not retried
      // against the next candidate: if Plane will not take a write it will not
      // take the next one either, and trying would spend the caller's Plane
      // budget on a queue of identical failures before answering.
      try {
        await mirrorClaim(plane.as(actor.planeToken), pool, {
          projectId: b.projectId,
          workItemId: l.workItemId,
          actor,
          epoch: l.epoch,
          expiresAt: l.expiresAt,
        });
      } catch (err) {
        await lease.rollbackClaim(pool, {
          workItemId: l.workItemId,
          holder: actor.holder,
          epoch: l.epoch,
        });
        throw err;
      }
      // Everything the named path hands back, because this path is the one the
      // tool description actively recommends -- "omit workItemId ... calling
      // next and then claim is a race" -- and it was returning no credential at
      // all. The harvest hook then found nothing to store, the monitor had
      // nothing to poll, and the lease lapsed while the agent worked: the
      // collision this design exists to prevent, down the path we tell agents to
      // take. The two paths were written at different times and the credential
      // was added to one. See SYNC-105.
      const watch = await mintWatch(pool, {
        sessionId: sessionOf(req, b),
        workItemId: l.workItemId,
      });
      return {
        lease: l,
        item: c,
        watchUrl: `${publicBase(deps.publicUrl, req.headers, req.protocol)}/v1/watch/${watch}`,
        ...(await livenessNote(pool, actor.holder)),
        ...takeoverNote(l),
        // Spread, so `briefingError` travels with `briefing: null` rather than
        // the absence being left to speak for itself — it cannot (SYNC-67).
        ...(await briefingFor(
          plane.as(actor.planeToken),
          { projectId: b.projectId, workItemId: l.workItemId },
          (err) => req.log.warn({ err, workItemId: l.workItemId }, 'briefing failed'),
        )),
      };
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
    // The label and the refusal turn on "nothing was found", not "something was
    // not found" — see unproven() for why the detection cannot be sharpened and
    // the consequence has to change instead. `fabricated` is still what gets
    // NAMED, because an agent fixing a citation needs to know which one.
    const backedByNothing = unproven(checks);

    // Refuse *before* ending the lease, or the agent is left holding nothing
    // while the item stays open — the one outcome worse than an unverified
    // completion. Off by default; see evidence.ts for why warn is the default.
    if (warning && deps.evidencePolicy === 'refuse') {
      throw new GatewayError('INVALID', warning, { workItemId: b.workItemId });
    }
    if (backedByNothing && deps.evidencePolicy === 'refuse') {
      throw new GatewayError(
        'INVALID',
        `Nothing this completion cites could be found: ${fabricated
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
        ...(backedByNothing ? [ABSENT_LABEL] : []),
      ],
    });

    // One field, because an agent reading two warnings has to work out which
    // matters. They are mutually exclusive anyway — a completion that cited
    // nothing has nothing to be wrong about.
    //
    // Split from the label deliberately. A citation that resolved to nothing is
    // worth saying either way — it is usually a typo the agent can fix, or a
    // checksum the scanner mistook for a sha — but only "nothing was found at
    // all" is worth flagging to a human on the board. Saying nothing about the
    // stray ones would trade one silent failure for another.
    const notice = backedByNothing
      ? `Recorded, and labelled "${ABSENT_LABEL}": ${fabricated.map((c) => c.detail).join('; ')}.`
      : fabricated.length > 0
        ? `Recorded. ${fabricated.length} citation${fabricated.length > 1 ? 's' : ''} could not ` +
          `be found (${fabricated.map((c) => c.value).join(', ')}), but others did, so this is ` +
          'not flagged. Check them if they were meant to be real.'
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
  // `ok: true` used to mean "the POST did not throw", which is not what anyone
  // read it as. Plane stores relations as (issue, related_issue, relation_type)
  // rows and bulk-creates with ignore_conflicts, so re-linking a pair with a
  // different type ADDS a row and leaves the first one in force. An agent
  // correcting a wrong `blocked_by` by re-linking as `relates_to` got `ok: true`
  // and a still-blocked item (SYNC-66).
  //
  // So the reply now says what is actually true of each pair. The four types are
  // mutually exclusive readings of the same pair, so an existing different type
  // is reported as a conflict rather than quietly stacked.
  app.post('/v1/link', async (req) => {
    const actor = await actorOf(req);
    const b = LinkBody.parse(req.body);
    const as = plane.as(actor.planeToken);

    const before = await as.relations(b.projectId, b.workItemId).catch(() => null);
    const existing = new Map<string, string>();
    if (before) {
      for (const kind of ['blocking', 'blocked_by', 'duplicate', 'relates_to'] as const) {
        for (const ref of before[kind] ?? []) existing.set(ref.issue_id, kind);
      }
    }

    await as.relate(b.projectId, b.workItemId, b.relation, b.targets);

    const already: string[] = [];
    const conflicts: Array<{ target: string; existing: string }> = [];
    for (const t of b.targets) {
      const had = existing.get(t);
      if (!had) continue;
      if (had === b.relation) already.push(t);
      else conflicts.push({ target: t, existing: had });
    }

    return {
      ok: true,
      relation: b.relation,
      created: b.targets.filter((t) => !existing.has(t)),
      ...(already.length ? { alreadyLinked: already } : {}),
      // Named loudly because this is the case that used to look like success.
      // Plane keeps both edges; if the old one is `blocked_by` it is still
      // gating, and `unlink` is how it stops.
      ...(conflicts.length
        ? {
            conflicts,
            warning:
              `Plane keeps both relations for a pair rather than replacing one. ` +
              `${conflicts.length} target(s) already had a different relation, which is still in ` +
              `force — call unlink to stop a stale blocked_by gating the item.`,
          }
        : {}),
      // Honest about a degraded answer rather than reporting a clean create.
      ...(before ? {} : { warning: 'Could not read existing relations, so this reply cannot say which targets were already linked.' }),
    };
  });

  // ── constrain ────────────────────────────────────────────────────────────
  //
  // The write-first discipline had exactly one shape — "there is a new item" — so
  // a requirement on existing work became a sibling of the thing it constrains,
  // and the claimer never saw it. This puts it in the item instead. See
  // constrain.ts for why it is not a relation.
  app.post('/v1/constrain', async (req) => {
    const actor = await actorOf(req);
    const b = ConstrainBody.parse(req.body);
    return constrain(plane.as(actor.planeToken), pool, actor, b);
  });

  // ── unlink ───────────────────────────────────────────────────────────────
  //
  // Plane's public API cannot delete a relation: the relations endpoint is
  // `["get", "post"]` at v1.3.1, the version we run, and still on `preview`. The
  // remaining ways to remove the row are Plane's own UI, which an agent does not
  // have, and Plane's database, which this gateway deliberately cannot reach.
  //
  // So this retracts rather than deletes — the readiness gate is the gateway's
  // rule, and it stops honouring the edge. The edge stays visible in Plane, so
  // the decision is written there as a comment too; a divergence nobody can see
  // would be its own silent failure.
  app.post('/v1/unlink', async (req) => {
    const actor = await actorOf(req);
    const b = UnlinkBody.parse(req.body);
    const as = plane.as(actor.planeToken);

    const rel = await as.relations(b.projectId, b.workItemId).catch(() => null);
    const present = new Set((rel?.blocked_by ?? []).map((r) => r.issue_id));

    const results = await Promise.all(
      b.targets.map(async (target) => {
        if (b.reinstate) {
          const undone = await reinstate(pool, { workItemId: b.workItemId, blockerId: target });
          return { target, reinstated: undone };
        }
        await retract(pool, {
          projectId: b.projectId,
          workItemId: b.workItemId,
          blockerId: target,
          reason: b.reason,
          actor: actor.holder,
        });
        return { target, retracted: true, presentInPlane: present.has(target) };
      }),
    );

    // Written to Plane so a human reading the item sees why an edge Plane still
    // draws is not being enforced. Fire-and-forget for the same reason the claim
    // mirror is: the decision is recorded in the gateway, which is what the gate
    // reads, and Plane being unreachable must not fail the call.
    if (!b.reinstate) {
      void as
        .comment(
          b.projectId,
          b.workItemId,
          `<p>${escapeHtml(actor.holder)} retracted ${b.targets.length} <code>blocked_by</code> ` +
            `relation(s) as not real dependencies: ${escapeHtml(b.reason)}</p>` +
            `<p>Plane cannot delete a relation through its API, so the edge is still drawn here. ` +
            `The gateway's readiness gate no longer honours it. Delete it in Plane's UI to make ` +
            `the two agree.</p>`,
        )
        .catch(() => {});
    }

    return { ok: true, results };
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
  // `rest` is the REST client, and it is here only so proxied responses can say
  // "In Progress" where Plane says a uuid — the same names the gateway's own
  // tools have always returned.
  const toolDeps = { app, pool, plane: deps.planeMcp ?? null, rest: plane };

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

  // The spec lets a client open a GET stream or DELETE a session, and both are
  // real here: GET is the standalone notification stream, DELETE ends the
  // conversation and releases the session rather than waiting for it to go idle.
  // Both go through the same handler so session lookup and the holder check
  // happen once, in one place.
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
