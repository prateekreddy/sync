import type { FastifyInstance } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import type { PlaneMcp, ToolSpec } from './planemcp.js';
import { checkToolCall } from './toolpolicy.js';
import { NATIVE_TOOLS } from './toolspec.js';

/**
 * The single agent-facing tool surface: our coordination tools plus Plane's own.
 *
 * Agents install one MCP server, which knows nothing and merely forwards. Both
 * halves of the catalogue are served from here, which means a new tool — ours or
 * one that arrives in a Plane upgrade — reaches every agent on the next gateway
 * deploy with nothing to reinstall on any agent box.
 *
 * The two halves are not equivalent, and the difference is worth being explicit
 * about. Plane's tools are a faithful wrapper over its REST API: powerful, and
 * with no notion of a lease. Ours are the coordination primitives Plane has no
 * equivalent for. Every Plane tool call therefore passes through checkToolCall()
 * before it is forwarded, so the broad surface cannot be used to walk around the
 * narrow one.
 */

export interface ToolCatalogue {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Which half of the surface this came from — shown to operators, not agents. */
  source: 'gateway' | 'plane';
}

export interface ToolDeps {
  app: FastifyInstance;
  pool: Pool;
  plane: PlaneMcp | null;
}

const nativeCatalogue = (): ToolCatalogue[] =>
  NATIVE_TOOLS.map((t) => ({
    name: t.name,
    description: `${t.title}. ${t.description}`,
    inputSchema: zodToJsonSchema(t.schema, { $refStrategy: 'none' }),
    source: 'gateway' as const,
  }));

export async function listTools(deps: ToolDeps): Promise<ToolCatalogue[]> {
  const native = nativeCatalogue();
  if (!deps.plane) return native;

  let upstream: ToolSpec[] = [];
  try {
    upstream = await deps.plane.tools();
  } catch (err) {
    // Plane's tools are additive. If its server will not start, agents should
    // still get the coordination surface rather than nothing at all.
    deps.app.log.error({ err }, 'plane mcp catalogue unavailable; serving gateway tools only');
    return native;
  }

  const taken = new Set(native.map((t) => t.name));
  const proxied: ToolCatalogue[] = [];
  for (const t of upstream) {
    // Ours win. A Plane tool that ever takes one of our names would shadow the
    // only safe way to claim work, so it is dropped loudly instead.
    if (taken.has(t.name)) {
      deps.app.log.warn({ tool: t.name }, 'plane mcp tool shadows a gateway tool; not exposed');
      continue;
    }
    proxied.push({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema,
      source: 'plane',
    });
  }
  return [...native, ...proxied];
}

/**
 * Fill in the agent's project when a tool wants one and the model did not supply
 * it.
 *
 * Server-side deliberately. Over HTTP there is no client-side config to read, and
 * putting it here means an agent's install is a URL and a token with nothing else
 * to get wrong. Both spellings are handled because our tools take `projectId` and
 * Plane's take `project_id`.
 */
function withDefaultProject(
  tool: { inputSchema?: unknown } | undefined,
  args: Record<string, unknown>,
  defaultProjectId: string | null,
): Record<string, unknown> {
  if (!defaultProjectId || !tool) return args;
  const props =
    (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const out = { ...args };
  for (const key of ['projectId', 'project_id']) {
    if (key in props && out[key] === undefined) out[key] = defaultProjectId;
  }
  return out;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (body: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }],
});

const errorResult = (code: string, message: string, recovery?: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}${recovery ? `\n\nWhat to do: ${recovery}` : ''}` }],
});

/**
 * Invoke a tool by name.
 *
 * Native tools are dispatched back through the gateway's own router with
 * `app.inject`, deliberately: the REST endpoint is the implementation, and going
 * through it means the tool and the endpoint cannot drift apart in validation,
 * error mapping, or behaviour. The cost is re-authenticating the bearer token,
 * which is one indexed lookup.
 */
export async function callTool(
  deps: ToolDeps,
  actor: Actor,
  authorization: string,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<ToolResult> {
  const spec = (await listTools(deps)).find((t) => t.name === name);
  const args = withDefaultProject(spec, rawArgs, actor.defaultProjectId);

  const native = NATIVE_TOOLS.find((t) => t.name === name);

  if (native) {
    const { path, body } = native.request(args);
    const res = await deps.app.inject({
      method: native.method,
      url: path,
      headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { payload: body as object } : {}),
    });
    const parsed: unknown = res.body ? JSON.parse(res.body) : {};
    if (res.statusCode >= 400) {
      const e = parsed as { error?: string; message?: string; recovery?: string };
      return errorResult(e.error ?? 'ERROR', e.message ?? 'request failed', e.recovery);
    }
    return text(parsed);
  }

  if (!deps.plane) {
    throw new GatewayError('NOT_FOUND', `No such tool: ${name}`, { tool: name });
  }

  // Plane's own surface. Attribution is native — the child process for this agent
  // authenticates with the agent's own Plane token — so Plane's activity log names
  // the real author without any impersonation shim.
  if (!actor.planeToken) {
    throw new GatewayError(
      'FORBIDDEN',
      `"${name}" is a Plane tool and needs this agent to have its own Plane identity. ` +
        `Ask your operator to re-issue the token with --plane-token.`,
      { tool: name },
    );
  }

  const checked = await checkToolCall({ pool: deps.pool, actor }, name, args);
  const out = await deps.plane.call(actor.planeToken, name, checked);
  return out as ToolResult;
}

/** Shared shape for the HTTP error body, so tool errors read like every other one. */
export const toolErrorBody = (err: GatewayError) => ({
  status: HTTP_STATUS[err.code],
  body: {
    error: err.code,
    message: err.message,
    recovery: RECOVERY[err.code],
    ...err.detail,
  },
});
