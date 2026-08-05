import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from './auth.js';
import { GatewayError, RECOVERY } from './errors.js';
import { callTool, listTools, type ToolDeps } from './tools.js';

/**
 * MCP straight over HTTPS, so onboarding an agent is one command with nothing
 * installed locally:
 *
 *   claude mcp add --transport http sync https://mcp.example.dev/mcp \
 *     --header "Authorization: Bearer sync_agent_..."
 *
 * The stdio client in mcp/ still exists for clients that cannot speak HTTP
 * transport, and both go through the same catalogue and the same policy — this
 * is a second door into one room, not a second room.
 *
 * Stateless: a Server and transport are built per request. MCP sessions exist to
 * carry server-side state across calls, and there is none here worth carrying —
 * every request authenticates from its own bearer token, and the tool catalogue
 * is cached in the gateway rather than per connection. Statelessness is also what
 * makes this survive a gateway restart mid-conversation, which a long-lived agent
 * session will eventually meet.
 */

/**
 * What the model is told about this server before it calls anything.
 *
 * This is the only always-on channel that ships from the server, so it carries
 * the *discipline* — the rules an agent has to follow before it reaches for a
 * tool. Tool descriptions cannot do this job: they are read while choosing among
 * tools, which is too late for a rule like "claim before you start", whose whole
 * point is to fire when the agent was not otherwise thinking about tools at all.
 */
export const INSTRUCTIONS = `This workspace tracks work in Plane, and this server is how you interact with it.

Three rules, in order of how easy they are to get wrong:

1. WRITE IT DOWN FIRST. The moment you notice anything worth doing — a bug, a
   missing test, a refactor, a question for a human — call capture BEFORE you
   decide whether to do it now. Capture is cheap, deduplicates, and is safe to
   call repeatedly. An unwritten intention is lost the moment your context is.

2. CLAIM BEFORE YOU WORK. Never start non-trivial work on an item you have not
   claimed. Assigning yourself in Plane reserves nothing: two agents doing it
   both believe they own the item and both proceed. Only claim is atomic. If
   claim refuses, read the error's recovery line and follow it rather than
   working around it.

3. FINISH EXPLICITLY. End with complete (include the evidence — a PR link, a
   commit, what you verified) or release. Going silent means the lease expires
   and someone else redoes your work.

An item you claim stays yours for as long as you are working on it, however long
that takes. If it is ever taken from you, you will be told so in plain words —
stop then, and discard that work rather than submitting it.

After a restart, call held first to find out what you were in the middle of.

To break a large item up, call decompose once with every child, rather than
capture per child. A parent with unfinished children is deliberately unclaimable,
so the plan becomes visible and claimable the moment its first child lands:
written one call at a time, another agent can start work under a decomposition
you have not finished writing.

Plane's own tools are here too, for everything else — cycles, modules, labels,
comments, worklogs. Two things are restricted: you cannot set assignees or state
on an item you do not hold (that would bypass the lease), and deleting states or
labels needs a capability you probably do not have.`;

function build(deps: ToolDeps, actor: Actor, authorization: string): Server {
  const server = new Server(
    { name: 'sync', version: '0.3.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listTools(deps);
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Tool['inputSchema'],
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      // Cast because the SDK's result union also covers long-running "task"
      // results, which nothing here produces.
      return (await callTool(
        deps,
        actor,
        authorization,
        name,
        args as Record<string, unknown>,
      )) as CallToolResult;
    } catch (err) {
      // A refusal is a result, not a protocol error: the model needs to read the
      // recovery line and act on it, and a JSON-RPC error would surface as a
      // transport failure it cannot reason about.
      if (err instanceof GatewayError) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${err.code}: ${err.message}\n\nWhat to do: ${RECOVERY[err.code]}` }],
        } as CallToolResult;
      }
      throw err;
    }
  });

  return server;
}

export async function handleMcpHttp(
  deps: ToolDeps,
  actor: Actor,
  authorization: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const server = build(deps, actor, authorization);
  const transport = new StreamableHTTPServerTransport({
    // Stateless — see the note above. The key is omitted rather than set to
    // undefined: with exactOptionalPropertyTypes those are different types, and
    // absent is what the transport actually checks for.
    // Plain JSON responses rather than an SSE stream. Nothing here streams, and a
    // single response body is far less to go wrong across a reverse proxy that
    // may buffer or time out idle connections.
    enableJsonResponse: true,
  });

  // Fastify must not also try to reply: the transport writes to the raw socket.
  reply.hijack();
  reply.raw.on('close', () => {
    void transport.close();
    void server.close();
  });

  // The SDK's own Transport interface declares optional callbacks as required-
  // but-possibly-undefined, which exactOptionalPropertyTypes rejects. The cast is
  // confined to this one call rather than loosening the setting for the project.
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(request.raw, reply.raw, request.body);
}
