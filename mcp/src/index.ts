#!/usr/bin/env node
/**
 * sync-mcp — the agent's only MCP server.
 *
 * It defines no tools. It fetches the catalogue from the gateway and forwards
 * every call there, which means the agent-facing surface — our coordination
 * tools and Plane's own ~46 — is deployed from the server. A new tool, a
 * reworded description, a Plane upgrade: none of it requires touching a single
 * agent box.
 *
 * Containing no logic is the security property, not an accident. Mutual exclusion
 * is decided in exactly one place, and this process holds no Plane credential —
 * only a gateway token. A Plane token here would let the agent set `assignees`
 * directly and bypass the lease, which is the failure measured in docs/race2.py.
 * The worst a tampered client can do is send a bad request and get a 4xx.
 *
 * Install (Claude Code):
 *   claude mcp add sync \
 *     -e SYNC_GATEWAY_URL=http://gateway:8787 \
 *     -e SYNC_AGENT_TOKEN=sync_agent_... \
 *     -e SYNC_PROJECT_ID=<uuid> \
 *     -- node /path/to/mcp/dist/index.js
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const GATEWAY = (process.env['SYNC_GATEWAY_URL'] ?? 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env['SYNC_AGENT_TOKEN'];
const PROJECT = process.env['SYNC_PROJECT_ID'];

if (!TOKEN) {
  console.error('sync-mcp: SYNC_AGENT_TOKEN is not set. Ask your operator to run:');
  console.error('  docker compose exec gateway node dist/cli.js issue-token \\');
  console.error('    --name <agent> --principal human:<you> --plane-token <their plane token>');
  process.exit(1);
}

/**
 * Errors the agent sees when the gateway itself is unreachable.
 *
 * The recovery line matters more than the message. An agent that cannot reach the
 * gateway must not "fall back" to editing Plane directly — that is precisely the
 * uncoordinated path this system exists to prevent — so it is told so explicitly
 * rather than left to improvise.
 */
const unreachable = (err: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text:
        `GATEWAY_UNREACHABLE: ${String(err)}\n\n` +
        `What to do: the gateway is down or unreachable. Do NOT fall back to editing Plane ` +
        `directly — that cannot claim work safely and risks two agents on the same item. ` +
        `Retry with backoff.`,
    },
  ],
});

async function gateway(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(GATEWAY + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json as { error?: string; message?: string; recovery?: string };
    throw new Error(
      `${e.error ?? `HTTP ${res.status}`}: ${e.message ?? 'request failed'}` +
        (e.recovery ? `\n\nWhat to do: ${e.recovery}` : ''),
    );
  }
  return json;
}

interface Catalogue {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

/**
 * Cached briefly so a chatty agent does not re-fetch per turn, but short enough
 * that a gateway deploy is picked up without restarting the agent.
 */
let cache: { at: number; tools: Tool[] } | null = null;
const TTL_MS = 60_000;

async function tools(): Promise<Tool[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tools;
  const { tools: list } = (await gateway('GET', '/v1/tools')) as Catalogue;
  const mapped: Tool[] = list.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema'],
  }));
  cache = { at: Date.now(), tools: mapped };
  return mapped;
}

/**
 * Fill in the agent's project when a tool wants one and the model did not supply
 * it. This is a configuration default, not a decision — the gateway validates the
 * value either way — and it saves every agent from carrying a UUID around. Both
 * spellings are handled because our tools use `projectId` and Plane's use
 * `project_id`.
 */
function withProject(tool: Tool | undefined, args: Record<string, unknown>): Record<string, unknown> {
  if (!PROJECT || !tool) return args;
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const out = { ...args };
  for (const key of ['projectId', 'project_id']) {
    if (key in props && out[key] === undefined) out[key] = PROJECT;
  }
  return out;
}

const server = new Server(
  { name: 'sync', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Work tracker. Write down anything worth doing the moment you notice it (capture), then ' +
      'take work with claim — never by assigning yourself in Plane, which reserves nothing. ' +
      'Hold a lease while you work, heartbeat it on long tasks, and end with complete or release.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return { tools: await tools() };
  } catch (err) {
    // An empty catalogue is the honest answer when the gateway is unreachable:
    // advertising tools that cannot run would make the model retry blindly.
    console.error(`sync-mcp: could not fetch tools: ${String(err)}`);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const known = (await tools().catch(() => [])).find((t) => t.name === name);
    return (await gateway('POST', '/v1/tools/call', {
      name,
      arguments: withProject(known, args as Record<string, unknown>),
    })) as CallToolResult;
  } catch (err) {
    if (err instanceof Error && err.message.includes(':')) {
      // A structured refusal from the gateway, already carrying its recovery line.
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    return unreachable(err);
  }
});

await server.connect(new StdioServerTransport());
console.error(`sync-mcp: proxying ${GATEWAY}`);
