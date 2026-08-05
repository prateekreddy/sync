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
import { approveTakeover } from './assignment.js';
import { NameBook, isUuid, nameHint, resolveIds, resolveNames } from './names.js';
import type { PlaneClient } from './plane.js';
import { mapTextBlocks, projectToolResult } from './projection.js';
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
  /**
   * Plane's REST API, used only to turn uuids into names and back.
   *
   * Optional, and absent means ids pass through in both directions — the
   * behaviour every caller had before names.ts existed. Nothing here depends on
   * resolution succeeding.
   */
  rest?: PlaneClient | null;
  /**
   * How to put a yes/no question to the person at the other end of the client.
   *
   * Absent on every path an agent can reach without a human — the REST surface,
   * a cron, a headless client that declines. Absent means the question does not
   * get asked and the refusal stands, which is the safe direction: work assigned
   * to a person stays theirs.
   */
  askHuman?: AskHuman | undefined;
}

/**
 * The verdict on a question put to a human.
 *
 * `unavailable` is separate from `refused` on purpose. Nobody said no — there
 * was nobody to ask — and collapsing the two would report a conversation that
 * never happened, which is exactly the failure this whole change is removing
 * from the other direction.
 */
export type AskHuman = (message: string) => Promise<'approved' | 'refused' | 'unavailable'>;

const nativeCatalogue = (): ToolCatalogue[] =>
  NATIVE_TOOLS.map((t) => ({
    name: t.name,
    description: `${t.title}. ${t.description}`,
    inputSchema: zodToJsonSchema(t.schema, { $refStrategy: 'none' }),
    source: 'gateway' as const,
  }));

/**
 * Say on each field that it takes a name.
 *
 * Recursive, because the fields that most need this are nested: `update_issue`
 * carries `state`, `labels` and `assignees` under `issue_data`, and an
 * annotation that only reached the top level would miss the single most common
 * write. Bounded depth, since a schema can reference itself.
 */
function withNameHints(schema: unknown, depth = 0): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema) || depth > 3) {
    return schema;
  }
  const s = schema as { properties?: Record<string, unknown>; [k: string]: unknown };
  if (!s.properties) return schema;

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.properties)) {
    const inner = withNameHints(value, depth + 1);
    const hint = nameHint(key);
    if (!hint || typeof inner !== 'object' || inner === null) {
      properties[key] = inner;
      continue;
    }
    const prop = inner as { description?: unknown };
    properties[key] = {
      ...prop,
      description: prop.description ? `${String(prop.description)} ${hint}` : hint,
    };
  }
  return { ...s, properties };
}

/**
 * Advertise the projection escape hatch on every proxied tool.
 *
 * Built as a new object rather than mutated: the upstream catalogue is cached for
 * an hour and shared by every caller, so writing into it would accumulate.
 */
function withVerbose(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const s = withNameHints(schema) as { properties?: Record<string, unknown>; [k: string]: unknown };
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
          "Return the tool's full response exactly as Plane sent it. Off by default: audit " +
          'metadata (created_at, updated_at, created_by, workspace, sort_order and similar) is ' +
          'removed, descriptions are removed from lists, and state, labels, assignees and parent ' +
          'come back as names rather than ids. Turning this on gives you the raw ids too — which ' +
          'you rarely need, since every field that takes an id also takes the name. Prefer ' +
          '`fields` when you know what you want.',
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

/**
 * Which project a call is about, for scoping the name lookups.
 *
 * States and labels are per project and two projects may each have a "Done", so
 * resolving without knowing which one would be a coin toss. Both spellings are
 * read for the same reason `withDefaultProject` writes both.
 */
function projectArg(args: Record<string, unknown>): string | null {
  for (const key of ['project_id', 'projectId']) {
    const v = args[key];
    if (typeof v === 'string' && isUuid(v)) return v;
  }
  return null;
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

/** What the claim endpoint tells us about a refusal a person could lift. */
interface ApprovalDetail {
  workItemId?: string;
  projectId?: string;
  /** Already formatted by the endpoint that had the item — see approvalNeeded. */
  readableId?: string;
  assignedTo?: string;
  takenFrom?: string | null;
}

/**
 * Put the takeover to a human, and record their answer if they say yes.
 *
 * This replaces `takeover: true`, an argument the model set on its own to assert
 * that somebody had agreed. The gateway could not tell the model's word from a
 * person's, so the argument *was* the trust — and an agent that wanted the item
 * had only to pass it. Nothing about that was a hypothetical failure mode: it is
 * one boolean between an agent and somebody else's work.
 *
 * Now the question is asked by the server, over a channel the model does not
 * author, and the answer is written down before the claim is retried. What the
 * elicitation proves is that *a* human at this client answered; it does not
 * authenticate which one, so the approval is attributed to the principal the
 * agent acts for. That is the same attribution as before, but it now records
 * something that happened rather than something claimed.
 *
 * The approval outlives the conversation deliberately. A compaction between the
 * yes and the claim would otherwise lose it, and the person would be asked again
 * about a decision they had already made — which is how approval prompts become
 * something people click through.
 */
async function requestApproval(
  deps: ToolDeps,
  actor: Actor,
  detail: ApprovalDetail,
): Promise<'approved' | 'refused' | 'unavailable'> {
  if (!deps.askHuman || !detail.workItemId) return 'unavailable';

  // The readable id arrives already formatted, from the layer that was holding
  // the item. Looking it up here would put a board listing on the path of asking
  // a person a question.
  const outcome = await deps.askHuman(
    `${detail.readableId ?? detail.workItemId} is assigned to ${detail.assignedTo ?? 'someone else'}. ` +
      `May ${actor.holder} take it over?`,
  );
  if (outcome !== 'approved') return outcome;

  await approveTakeover(deps.pool, {
    workItemId: detail.workItemId,
    approvedBy: actor.principal,
    takenFrom: detail.takenFrom ?? null,
    reason: `approved in conversation for ${actor.holder}`,
  });
  return 'approved';
}

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
    const withProject = withDefaultProject(spec, rawArgs, actor.defaultProjectId);
    // Our own tools take readable ids too, so an id read from a Plane tool can be
    // handed straight to claim without a translation step the agent has to know
    // about. Costs nothing when the value is already a uuid — the lookup is not
    // even consulted.
    const args = deps.rest
      ? await resolveIds(
          new NameBook(deps.rest),
          withProject,
          projectArg(withProject) ?? actor.defaultProjectId,
        )
      : withProject;
    const { path, body } = native.request(args);
    const send = () =>
      deps.app.inject({
        method: native.method,
        url: path,
        headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { payload: body as object } : {}),
      });

    let res = await send();
    let parsed: unknown = res.body ? JSON.parse(res.body) : {};

    // The one refusal a person can lift in the moment. Asked here rather than
    // inside the endpoint because this is the only layer with a channel to a
    // human; the endpoint stays the single implementation and is simply called
    // again once permission exists.
    if (res.statusCode >= 400 && (parsed as { error?: string }).error === 'NEEDS_APPROVAL') {
      const outcome = await requestApproval(deps, actor, parsed as ApprovalDetail);
      if (outcome === 'refused') {
        return errorResult(
          'NEEDS_APPROVAL',
          'The person you are working with said no. This item is not yours to take.',
          'Do not ask again for this item in this session, and do not work it. Pick different work.',
        );
      }
      if (outcome === 'approved') {
        res = await send();
        parsed = res.body ? JSON.parse(res.body) : {};
      }
      // 'unavailable' falls through to the original refusal, whose recovery line
      // already explains the two ways a human can clear it.
    }

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

  // One book serves both directions of this call, so a payload that mentions the
  // same project on every row builds each lookup table once.
  const book = deps.rest ? new NameBook(deps.rest) : null;
  const projectId = projectArg(forwarded) ?? actor.defaultProjectId;

  // Names to ids on the way in, before the policy check — so what the guard
  // inspects is exactly what Plane will receive, and a lease field written by
  // name is guarded the same as one written by id.
  const named = book ? await resolveIds(book, forwarded, projectId) : forwarded;

  const checked = await checkToolCall({ pool: deps.pool, actor }, upstreamName, named);
  const raw = await deps.plane.call(actor.planeToken, upstreamName, checked);

  // Ids to names on the way out. Before projection, deliberately: resolution
  // changes values rather than adding keys, so a caller that narrowed with
  // `fields` still gets the resolved value of the field it named.
  const out =
    book && verbose !== true
      ? await mapTextBlocks(raw, (payload) => resolveNames(book, payload, projectId))
      : raw;

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
