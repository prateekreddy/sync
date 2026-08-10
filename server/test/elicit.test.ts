import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { PlaneClient, type State, type WorkItem } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { NO_RELATIONS } from './relations.js';

/**
 * Can this gateway actually ask a person a question?
 *
 * Every other test of approval injects `askHuman` and checks what the decision
 * layer does with the answer. All of them passed, and all of them were right —
 * and for as long as they existed, no human was ever asked anything. `gather`
 * and the takeover in `claim` both shipped, deployed, and were inert, because
 * the part nothing covered was the part that produces the answer: a real client,
 * over real HTTP, through the real transport.
 *
 * Measured 2026-08-10 against the deployed gateway: `gather` from an interactive
 * Claude Code session with the plugin installed returned NEEDS_APPROVAL and no
 * prompt appeared. Three independent faults, each on its own sufficient:
 *
 *   1. A `Server` was built per request, so `initialize` populated the client
 *      capabilities of an object that was thrown away before any tool ran.
 *      `elicitInput` refuses when it cannot see `elicitation.form`.
 *   2. The elicitation carried no `relatedRequestId`, so the transport routed it
 *      to the standalone GET stream — which, absent, is a silent `return`.
 *   3. `enableJsonResponse: true` skips the SSE write entirely, and the client's
 *      answer arrives as a *separate POST* that a stateless server has no
 *      pending request to match it to.
 *
 * Nothing about (2) or (3) raises: they hang or they drop. So this test drives
 * the whole path rather than any predicate inside it — the only shape that could
 * have caught this, and the shape AGENTS.md asks for after being bitten twice.
 */

const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const CONTAINER = randomUUID();
const LOOSE = randomUUID();

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];

const wi = (id: string, name: string): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name,
  description_html: '<p>enough to act on</p>',
  state: 'backlog',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const updates: Array<{ id: string; body: Record<string, unknown> }> = [];

function fakePlane(): PlaneClient {
  const items = [wi(CONTAINER, 'A container'), wi(LOOSE, 'Something loose')];
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'P', name: 'Project' }],
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id),
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[0],
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      updates.push({ id, body });
      return items.find((i) => i.id === id)!;
    },
    comment: async () => ({}),
    createWorkItem: async (_p: string, body: Record<string, unknown>) =>
      wi(randomUUID(), String(body['name'])),
    search: async () => [],
  }) as unknown as PlaneClient;
  return plane;
}

/** A real listening gateway, because the defect lives in the HTTP layer. */
async function gateway(): Promise<{ app: FastifyInstance; url: URL; token: string }> {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(),
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: null,
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });

  process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
  const { token } = await issueToken(pool, {
    name: `t-eli-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: randomUUID(),
    defaultProjectId: PROJECT,
  });

  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, url: new URL(`http://127.0.0.1:${port}/mcp`), token };
}

/**
 * A client that answers, or one that cannot be asked at all.
 *
 * `answer: null` declares no elicitation capability, which is the headless case
 * and the one that must stay fast: it has to come back refused-with-a-reason
 * rather than holding the call open waiting for a person who is not there.
 */
async function connect(
  url: URL,
  token: string,
  answer: boolean | null,
): Promise<{
  client: Client;
  asked: string[];
  schemas: unknown[];
  transport: StreamableHTTPClientTransport;
}> {
  const asked: string[] = [];
  const schemas: unknown[] = [];
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: answer === null ? {} : { elicitation: { form: {} } } },
  );
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      schemas.push(req.params.requestedSchema);
      // The action alone, with no content — which is all a confirmation has to
      // send, and what a client that renders no fields can produce.
      return { action: answer ? 'accept' : 'decline' };
    });
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, asked, schemas, transport };
}

/** A tools/list POST made by hand, for the session cases no client will produce. */
const post = (url: URL, token: string, extra: Record<string, string>): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const ARGS = { projectId: PROJECT, workItemIds: [LOOSE], containerId: CONTAINER };

const textOf = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');

afterAll(async () => {
  await pool.end();
});

describe('asking a human over the MCP transport', () => {
  it('puts the question to the client and files the items on yes', async () => {
    const { app, url, token } = await gateway();
    const { client, asked } = await connect(url, token, true);

    const result = await client.callTool({ name: 'gather', arguments: ARGS });

    // The whole point: somebody was actually asked, in words about their work.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Something loose');
    expect(textOf(result)).toContain('"complete": true');
    expect(updates).toContainEqual({ id: LOOSE, body: { parent: CONTAINER } });

    await client.close();
    await app.close();
  }, 30_000);

  it('asks for no fields, because the answer is the action', async () => {
    // Measured 2026-08-10, the first time anyone was ever shown one of these:
    // the question also required a boolean called `approve`, Claude Code rendered
    // a form whose field could not be set, and a person who wanted to say yes had
    // no way to. A required field is a second question, and one the client may
    // not be able to put. `accept` is the yes.
    const { app, url, token } = await gateway();
    const { client, schemas } = await connect(url, token, true);

    await client.callTool({ name: 'gather', arguments: ARGS });

    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({ properties: {} });
    expect(schemas[0]).not.toHaveProperty('required');

    await client.close();
    await app.close();
  }, 30_000);

  it('changes nothing when they say no', async () => {
    const { app, url, token } = await gateway();
    const before = updates.length;
    const { client, asked } = await connect(url, token, false);

    const result = await client.callTool({ name: 'gather', arguments: ARGS });

    expect(asked).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('said no');
    expect(updates).toHaveLength(before);

    await client.close();
    await app.close();
  }, 30_000);

  it('comes back promptly when there is nobody to ask', async () => {
    // A client with no elicitation capability must get the original refusal and
    // its recovery line. Hanging until a timeout would be the same bug wearing a
    // different face — the agent waits, then reports something that never
    // happened.
    const { app, url, token } = await gateway();
    const before = updates.length;
    const { client } = await connect(url, token, null);

    const result = await client.callTool({ name: 'gather', arguments: ARGS });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('NEEDS_APPROVAL');
    expect(updates).toHaveLength(before);

    await client.close();
    await app.close();
  }, 30_000);
});

/**
 * What sessions cost, checked rather than assumed.
 *
 * Asking a person anything requires the server to still be there when they
 * answer, and that is a session. Everything below is a failure mode that did not
 * exist while this was stateless, so each one is pinned here — including the
 * ordinary case, because the change moved *every* tool call from a JSON body to
 * an SSE stream and a break there would take the whole surface with it.
 */
describe('the session the conversation runs in', () => {
  it('serves ordinary tools, and serves several calls from one session', async () => {
    const { app, url, token } = await gateway();
    const { client } = await connect(url, token, null);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('gather');

    // Two calls on one connection: the second reuses the session the first
    // opened, which is the path a real conversation spends all its time on.
    const first = await client.callTool({ name: 'find', arguments: { projectId: PROJECT } });
    const second = await client.callTool({ name: 'find', arguments: { projectId: PROJECT } });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();

    await client.close();
    await app.close();
  }, 30_000);

  it('records which window a claim came from', async () => {
    /**
     * Every lease claimed over MCP was written with a null session, and the
     * cause was not the one the item recorded. The plugin's
     * `X-Sync-Session: ${CLAUDE_CODE_SESSION_ID:-}` does expand to empty — that
     * variable is set for processes Claude Code spawns, not in its own
     * environment, which is what an MCP config expands against — but the header
     * would not have arrived even if it were set, because callTool rebuilds the
     * request and forwarded only the authorization.
     *
     * So the transport's own session id is used instead: minted per initialize,
     * sent on every request, one per connection, and needing nothing configured
     * anywhere. This checks it reaches the lease row, which is the only place
     * the answer matters.
     */
    const { app, url, token } = await gateway();
    const { client, transport } = await connect(url, token, null);

    const claimed = await client.callTool({
      name: 'claim',
      arguments: { projectId: PROJECT, workItemId: LOOSE },
    });
    expect(claimed.isError).toBeFalsy();

    const { rows } = await pool.query<{ session_id: string | null }>(
      'select session_id from lease where work_item_id = $1',
      [LOOSE],
    );
    expect(rows[0]?.session_id).toBe(transport.sessionId);

    await client.close();
    await app.close();
  }, 30_000);

  it('still serves a client whose session this process never had', async () => {
    // What a deploy looks like from the client side. The spec says answer 404 and
    // let the client initialize again, and the client SDK does not implement that
    // — it throws, and the conversation is over. So a session the gateway has
    // never heard of is served the old sessionless way instead. A restart costs
    // the ability to be *asked* something until the client reconnects; it does
    // not cost every tool call.
    const { app, url, token } = await gateway();
    const res = await post(url, token, { 'mcp-session-id': randomUUID() });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('gather');
    await app.close();
  }, 30_000);

  it('will not serve one agent a session opened by another', async () => {
    // A session carries an identity, and every write it makes is attributed to
    // that identity. Serving a second bearer token from it would file one
    // agent's work under the other's name — so it does not match, and gets a
    // sessionless answer of its own.
    const { app, url, token } = await gateway();
    const { client, transport } = await connect(url, token, null);

    // The gateway minted this at initialize and the client kept it, which is
    // itself the evidence that sessions are on.
    const opened = transport.sessionId;
    expect(opened).toBeTruthy();

    process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
    const other = await issueToken(pool, {
      name: `t-eli-${randomUUID().slice(0, 8)}/intruder`,
      principal: 'human:someone-else@example.com',
      planeToken: 'plane_pat_test',
      planeUserId: randomUUID(),
      defaultProjectId: PROJECT,
    });

    const res = await post(url, other.token, { 'mcp-session-id': opened! });

    // Served, but not from the borrowed session: a sessioned reply names the
    // session it came from, and this one has no session to name.
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();

    // And the borrowed session is untouched — still the first agent's, still
    // usable by the client that opened it.
    const after = await client.callTool({ name: 'find', arguments: { projectId: PROJECT } });
    expect(after.isError).toBeFalsy();
    expect(transport.sessionId).toBe(opened);

    await client.close();
    await app.close();
  }, 30_000);
});
