import type { FastifyInstance } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { GatewayError, HTTP_STATUS, RECOVERY } from './errors.js';
import type { PlaneMcp, ToolSpec } from './planemcp.js';
import {
  GROUPED_UPSTREAM,
  PLANE_GROUPS,
  groupDescription,
  groupSchema,
  resolveGroup,
  type PlaneGroup,
} from './planegroups.js';
import { projectToolResult } from './projection.js';
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

/**
 * Advertise the projection escape hatch on every proxied tool.
 *
 * Built as a new object rather than mutated: the upstream catalogue is cached for
 * an hour and shared by every caller, so writing into it would accumulate.
 */
function withVerbose(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const s = schema as { properties?: Record<string, unknown>; [k: string]: unknown };
  if (!s.properties || 'verbose' in s.properties) return schema;
  return {
    ...s,
    properties: {
      ...s.properties,
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Return exactly these keys per row, e.g. ["id","name"]. Cheaper than verbose when you ' +
          'know what you want. This can only NARROW what the tool already returns; if you name ' +
          'a key it does not send, the response says so rather than coming back quietly short. ' +
          'For a field a listing omits entirely (descriptions, for instance) fetch the single ' +
          'item instead.',
      },
      verbose: {
        type: 'boolean',
        description:
          "Return the tool's full response untrimmed. Off by default: audit metadata " +
          '(created_at, updated_at, created_by, workspace, sort_order and similar) is removed, ' +
          'and descriptions are removed from lists. Prefer `fields` when you know what you ' +
          'want; reach for this when exploring what a tool returns at all.',
      },
    },
  };
}

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
  const byName = new Map(upstream.map((t) => [t.name, t.inputSchema]));

  // Plane's tools are advertised grouped by the thing they act on. One tool per
  // REST endpoint is right for an API and wrong for a tool list: the list is what
  // the model reads to work out what it can do, and 47 near-identical CRUD entries
  // crowd out the few that matter. The raw names stay callable, just unlisted.
  const proxied: ToolCatalogue[] = [];
  for (const group of PLANE_GROUPS) {
    if (taken.has(group.name)) {
      deps.app.log.warn({ tool: group.name }, 'plane group shadows a gateway tool; not exposed');
      continue;
    }
    // Only advertise what this Plane actually serves. The upstream surface is a
    // moving target across versions, and a group offering an action that 404s is
    // worse than one that never mentions it.
    const present = Object.entries(group.actions).filter(([, t]) => byName.has(t));
    if (present.length === 0) continue;
    const live: PlaneGroup = { ...group, actions: Object.fromEntries(present) };

    proxied.push({
      name: live.name,
      description: groupDescription(live, byName),
      inputSchema: withVerbose(groupSchema(live, byName)),
      source: 'plane',
    });
  }

  // Anything upstream serves that no group covers stays listed on its own, so a
  // new Plane tool is reachable the day it appears rather than the day someone
  // remembers to add it here.
  const covered = new Set(GROUPED_UPSTREAM);
  for (const t of upstream) {
    if (covered.has(t.name) || taken.has(t.name)) continue;
    proxied.push({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: withVerbose(t.inputSchema),
      source: 'plane',
    });
  }
  // Ours first, then Plane's in the order its server registered them — stable
  // across restarts, because `NATIVE_TOOLS` is a literal array and the child
  // registers through a fixed sequence the SDK keeps in insertion order.
  // Measured, not assumed: two cold starts of plane-mcp-server 0.1.5 returned
  // the same 47 names in the same order.
  //
  // Deterministic order is a SHOULD in MCP 2026-07-28, and the reason is prompt
  // caching: a list that reshuffles costs nothing visible and invalidates the
  // cache for every agent on its next call. Deliberately not sorted — that would
  // also be deterministic, and would bury `claim` between `add_cycle_issues` and
  // `create_label`. Position in this list is attention. Pinned in
  // test/catalogue.test.ts.
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

/**
 * A refusal, as the model will read it.
 *
 * `fields` matters as much as `message` and used to be dropped here: the REST
 * layer computes exactly which field failed and why, and this function forwarded
 * only the code, the message and the recovery line — so `complete` with an
 * over-long `outcome` arrived as "Request validation failed / Request was
 * malformed", and the only way to learn it was a 2000-character cap on `outcome`
 * was to go and read `toolspec.ts`.
 *
 * The cost of that is not one confused call. An agent that cannot see which
 * field was wrong has two plausible next moves, retry the same body or give up,
 * and giving up on `complete` means going silent — the one unacceptable ending.
 */
const errorResult = (
  code: string,
  message: string,
  recovery?: string,
  fields?: Array<{ field: string; problem: string }>,
): ToolResult => {
  const detail = fields?.length
    ? `\n\n${fields.map((f) => `  ${f.field}: ${f.problem}`).join('\n')}`
    : '';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${code}: ${message}${detail}${recovery ? `\n\nWhat to do: ${recovery}` : ''}`,
      },
    ],
  };
};

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
  const native = NATIVE_TOOLS.find((t) => t.name === name);

  if (native) {
    const spec = (await listTools(deps)).find((t) => t.name === name);
    const args = withDefaultProject(spec, rawArgs, actor.defaultProjectId);
    const { path, body } = native.request(args);
    const res = await deps.app.inject({
      method: native.method,
      url: path,
      headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { payload: body as object } : {}),
    });
    const parsed: unknown = res.body ? JSON.parse(res.body) : {};
    if (res.statusCode >= 400) {
      const e = parsed as {
        error?: string;
        message?: string;
        recovery?: string;
        fields?: Array<{ field: string; problem: string }>;
      };
      return errorResult(e.error ?? 'ERROR', e.message ?? 'request failed', e.recovery, e.fields);
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

  // `verbose` and `fields` are ours, not Plane's. Strip them before forwarding or
  // the upstream schema rejects the call for an unknown property.
  const { verbose, fields, ...rest } = rawArgs;

  // A grouped name resolves to exactly one upstream tool. Deliberately before the
  // policy check below: resolving first means a guarded operation is guarded
  // however it was asked for, rather than only under the name the guard knows.
  const resolved = resolveGroup(name, rest);
  if (resolved && 'error' in resolved) {
    return errorResult('INVALID', resolved.error, RECOVERY.INVALID);
  }
  const upstreamName = resolved ? resolved.tool : name;
  const upstreamArgs = resolved ? resolved.args : rest;

  // Defaulting reads the schema of the tool actually being called, not the group's
  // — a group's schema is the union of its actions, so an action that takes no
  // project would otherwise be handed one and rejected upstream for a field it
  // never asked for.
  let forwarded = upstreamArgs;
  try {
    const specs = await deps.plane.tools();
    forwarded = withDefaultProject(
      specs.find((t) => t.name === upstreamName),
      upstreamArgs,
      actor.defaultProjectId,
    );
  } catch {
    // Catalogue unavailable: forward what the caller sent. Losing the default is
    // a worse error message, not a wrong call.
  }

  const checked = await checkToolCall({ pool: deps.pool, actor }, upstreamName, forwarded);
  const out = await deps.plane.call(actor.planeToken, upstreamName, checked);
  // An explicit field list wins over verbose: a caller who named fields has said
  // precisely what they want, and honouring the broader flag instead would ignore
  // the more specific request.
  const wanted = Array.isArray(fields) ? (fields as string[]).filter((f) => typeof f === 'string') : [];
  if (wanted.length) return projectToolResult(out, wanted) as ToolResult;
  return (verbose === true ? out : projectToolResult(out)) as ToolResult;
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
