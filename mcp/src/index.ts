#!/usr/bin/env node
/**
 * sync-mcp — thin stdio MCP client for the agent gateway.
 *
 * Deliberately contains NO coordination logic. Every tool is a straight HTTP call
 * to the gateway, which is the only place mutual exclusion is decided.
 *
 * That is the whole point: a client that could decide anything could also decide
 * wrongly, and an agent fleet is exactly the setting where one non-compliant or
 * out-of-date participant breaks the invariant for everyone. Here the worst a
 * broken client can do is make a bad request and get a 4xx.
 *
 * Install (Claude Code):
 *   claude mcp add sync -- node /path/to/mcp/dist/index.js \
 *     -e SYNC_GATEWAY_URL=... -e SYNC_AGENT_TOKEN=... -e SYNC_PROJECT_ID=...
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GATEWAY = process.env.SYNC_GATEWAY_URL ?? 'http://localhost:8787';
const TOKEN = process.env.SYNC_AGENT_TOKEN;
const PROJECT = process.env.SYNC_PROJECT_ID;

if (!TOKEN) {
  console.error('sync-mcp: SYNC_AGENT_TOKEN is not set. Ask your operator to run:');
  console.error('  node server/dist/cli.js issue-token --name <agent> --principal human:<you>');
  process.exit(1);
}

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (data: unknown): Result => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/**
 * Surface the gateway's error code AND its recovery guidance verbatim. The agent
 * needs to know the difference between "retry later" and "discard your work and
 * stop" — inferring that from prose is exactly where models go wrong.
 */
const fail = (body: { error?: string; message?: string; recovery?: string }): Result => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: [
        `${body.error ?? 'ERROR'}: ${body.message ?? 'request failed'}`,
        body.recovery ? `\nWhat to do: ${body.recovery}` : '',
      ].join(''),
    },
  ],
});

async function call(method: string, path: string, body?: unknown): Promise<Result> {
  try {
    const res = await fetch(GATEWAY.replace(/\/$/, '') + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return res.ok ? ok(json) : fail(json);
  } catch (err) {
    return fail({
      error: 'GATEWAY_UNREACHABLE',
      message: String(err),
      recovery: 'The gateway is down or unreachable. Do not fall back to editing Plane directly — that cannot claim work safely. Retry with backoff.',
    });
  }
}

const projectArg = PROJECT
  ? z.string().uuid().optional().describe('Project id. Defaults to this agent’s configured project.')
  : z.string().uuid().describe('Project id.');

const proj = (given?: string): string => {
  const p = given ?? PROJECT;
  if (!p) throw new Error('No projectId given and SYNC_PROJECT_ID is not set');
  return p;
};

const server = new McpServer({ name: 'sync', version: '0.1.0' });

// ── capture ────────────────────────────────────────────────────────────────
server.registerTool(
  'capture',
  {
    title: 'Write down a task',
    description:
      'Record a task, bug, or idea in the tracker. Use this the MOMENT you notice ' +
      'something worth doing — before deciding whether to do it now. Safe to call ' +
      'freely: near-duplicates are merged into the existing item rather than ' +
      'creating a second one, and passing the same idempotencyKey twice returns the ' +
      'original instead of duplicating. If you noticed this while working another ' +
      'item, pass that item as discoveredFrom so the provenance is preserved.',
    inputSchema: {
      title: z.string().min(3).max(255).describe('One line. What needs doing.'),
      body: z
        .string()
        .min(1)
        .describe(
          'Enough for another agent to act without you: what, where, and how anyone would know it is done.',
        ),
      priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
      labels: z.array(z.string()).optional(),
      discoveredFrom: z
        .string()
        .uuid()
        .optional()
        .describe('Work item you were on when you noticed this.'),
      idempotencyKey: z.string().max(200).optional().describe('Pass a stable key if you may retry.'),
      projectId: projectArg,
    },
  },
  async (a) => call('POST', '/v1/capture', { ...a, projectId: proj(a.projectId) }),
);

// ── next ───────────────────────────────────────────────────────────────────
server.registerTool(
  'next',
  {
    title: 'See available work',
    description:
      'List work that is ready and not held by another agent. Read-only — it does ' +
      'NOT reserve anything, so two agents calling this will see the same items. ' +
      'To actually take work, call claim. Items missing a description or blocked by ' +
      'unfinished work are withheld on purpose.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10),
      projectId: projectArg,
    },
  },
  async (a) => call('GET', `/v1/next?projectId=${proj(a.projectId)}&limit=${a.limit ?? 10}`),
);

// ── claim ──────────────────────────────────────────────────────────────────
server.registerTool(
  'claim',
  {
    title: 'Take exclusive ownership of work',
    description:
      'Atomically take a work item. Omit workItemId to be given the highest-priority ' +
      'ready item — prefer that over next-then-claim, which can race. ' +
      'Returns an epoch you MUST pass to heartbeat, release and complete. ' +
      'The lease expires: call heartbeat before ttlSeconds elapses or the item is ' +
      'returned to the pool and given to someone else. Never start work you have not claimed.',
    inputSchema: {
      workItemId: z.string().uuid().optional().describe('Omit to be assigned the best ready item.'),
      ttlSeconds: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .default(600)
        .describe('How long before the lease lapses without a heartbeat.'),
      projectId: projectArg,
    },
  },
  async (a) =>
    call('POST', '/v1/claim', {
      projectId: proj(a.projectId),
      ...(a.workItemId ? { workItemId: a.workItemId } : {}),
      ttlSeconds: a.ttlSeconds ?? 600,
    }),
);

// ── heartbeat ──────────────────────────────────────────────────────────────
server.registerTool(
  'heartbeat',
  {
    title: 'Keep your claim alive',
    description:
      'Extend your lease on an item you hold. Call this periodically during long ' +
      'work. If it fails with LEASE_EXPIRED or STALE_EPOCH, someone else now owns ' +
      'the item — stop immediately and discard what you were doing.',
    inputSchema: {
      workItemId: z.string().uuid(),
      epoch: z.number().int().positive().describe('The epoch returned by claim.'),
      ttlSeconds: z.number().int().min(30).max(3600).default(600),
    },
  },
  async (a) => call('POST', '/v1/heartbeat', a),
);

// ── release ────────────────────────────────────────────────────────────────
server.registerTool(
  'release',
  {
    title: 'Hand work back',
    description:
      'Give up an item you hold so another agent can take it, with a reason. Use ' +
      'this when you are blocked or wrong about being able to do it — it is always ' +
      'better than going quiet and letting the lease lapse.',
    inputSchema: {
      workItemId: z.string().uuid(),
      epoch: z.number().int().positive(),
      reason: z.string().max(500).describe('Why you are handing it back.'),
    },
  },
  async (a) => call('POST', '/v1/release', a),
);

// ── complete ───────────────────────────────────────────────────────────────
server.registerTool(
  'complete',
  {
    title: 'Finish work',
    description:
      'Mark an item you hold as done, recording what you actually did. Include ' +
      'concrete evidence — PR, commit, test output — because a human will audit ' +
      'this later. Set close:false if it needs review before closing.',
    inputSchema: {
      workItemId: z.string().uuid(),
      epoch: z.number().int().positive(),
      outcome: z.string().min(1).max(2000).describe('What you did, with evidence.'),
      close: z.boolean().default(true),
    },
  },
  async (a) => call('POST', '/v1/complete', a),
);

// ── link ───────────────────────────────────────────────────────────────────
server.registerTool(
  'link',
  {
    title: 'Relate two work items',
    description:
      'Record a typed relationship between items. Use blocked_by when something ' +
      'else must land first — blocked items are automatically withheld from agents, ' +
      'so this actively prevents wasted work.',
    inputSchema: {
      workItemId: z.string().uuid(),
      relation: z.enum(['blocking', 'blocked_by', 'duplicate', 'relates_to']),
      targets: z.array(z.string().uuid()).min(1).max(20),
      projectId: projectArg,
    },
  },
  async (a) => call('POST', '/v1/link', { ...a, projectId: proj(a.projectId) }),
);

// ── held ───────────────────────────────────────────────────────────────────
server.registerTool(
  'held',
  {
    title: 'What am I holding?',
    description:
      'List items you currently hold, with their epochs. Call this after a restart ' +
      'to recover the epochs you need for heartbeat and complete.',
    inputSchema: {},
  },
  async () => call('GET', '/v1/held'),
);

await server.connect(new StdioServerTransport());
