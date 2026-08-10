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
): Promise<{ client: Client; asked: string[]; transport: StreamableHTTPClientTransport }> {
  const asked: string[] = [];
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: answer === null ? {} : { elicitation: { form: {} } } },
  );
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return answer ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, asked, transport };
}

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

  it('tells a client whose session this process never had to initialize again', async () => {
    // What a deploy looks like from the client side. 404 is the spec's cue to
    // initialize again, so a restart costs a round trip instead of the
    // conversation — the property statelessness used to give for free.
    const { app, url, token } = await gateway();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': randomUUID(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    await app.close();
  }, 30_000);

  it('will not serve one agent a session opened by another', async () => {
    // A session carries an identity, and every write it makes is attributed to
    // that identity. Serving a second bearer token from it would file one
    // agent's work under the other's name.
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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${other.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': opened!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);

    await client.close();
    await app.close();
  }, 30_000);
});
