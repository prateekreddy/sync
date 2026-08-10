import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from './auth.js';
import { GatewayError, RECOVERY } from './errors.js';
import { callTool, listTools, type AskHuman, type ToolDeps } from './tools.js';

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
 * Sessioned, and it did not used to be. A Server and transport were built per
 * request, on the reasoning that nothing here streams and there was no state
 * worth carrying — which was true of everything the gateway *answers* and false
 * of the one thing it *asks*. A server-to-client request has no home in that
 * design: the question goes out on the stream opened for the call, and the
 * answer arrives as a separate POST that only a server still holding the pending
 * request can match it to. Statelessness and asking a person anything are
 * mutually exclusive, and for as long as this was stateless both features that
 * ask were inert. See test/elicit.test.ts for the measurement.
 *
 * What statelessness bought was surviving a gateway restart mid-conversation.
 * That is now paid for by the spec instead: a session this process has never
 * heard of gets a 404, which is the client's cue to initialize again. The cost
 * is one extra round trip after a deploy rather than a broken conversation.
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

/**
 * How long a question may stay unanswered before the agent is told nobody
 * answered it.
 *
 * The tool call is held open for this whole time, which is the point: the agent
 * must not proceed while a person is still deciding. Ten minutes is long enough
 * to read what is being proposed and short enough that a question asked into an
 * abandoned terminal does not pin a connection for the rest of the day. The SSE
 * keep-alive frames are what let it be this long at all — an idle POST would be
 * cut by a reverse proxy well before this.
 */
const ASK_TIMEOUT_MS = 10 * 60_000;

/**
 * Put a yes/no question to the person at the other end of the client.
 *
 * This is the whole of the transport-specific part of human approval, and it is
 * deliberately this small. Under 2025-11-25 the server sends `elicitation/create`
 * as a request of its own; under 2026-07-28 the same question travels as an
 * `InputRequiredResult` the client answers by retrying the call. Same question,
 * same verdict, different envelope — so when the SDK ships MRTR this function
 * changes and nothing that decides anything does.
 *
 * Three outcomes, not two. "Nobody could be asked" is not "somebody said no":
 * a headless run has no human at the other end, and telling the agent it was
 * refused would be a lie about a conversation that never happened.
 *
 * Measured, and the reason this cannot be decided from capabilities alone:
 * `claude -p` declares `elicitation` at initialize and then answers "Client does
 * not support form elicitation" when actually asked. The declaration is a
 * promise the headless client does not keep, so the only reliable test is to ask
 * and handle the refusal.
 *
 * `relatedRequestId` is load-bearing rather than housekeeping. Without it the
 * transport treats the question as unsolicited and routes it to the standalone
 * GET stream, and a client that never opened one leaves the send a silent
 * `return` — the question is not sent, no error is raised, and the call waits
 * for an answer to something nobody was asked. Tying it to the tool call puts it
 * on that call's own stream, where the client is already listening.
 */
function asker(server: Server, relatedRequestId: RequestId): AskHuman {
  return async (message) => {
    let answer;
    try {
      answer = await server.elicitInput(
        {
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve',
                // Neutral, because two different calls ask through here — taking
                // an item off its assignee, and regrouping a pile of them. What is
                // at stake is in the message; repeating a guess about it here
                // could contradict the question actually being asked.
                description: 'Yes goes ahead with what the message describes. No changes nothing.',
              },
            },
            required: ['approve'],
          },
        },
        { relatedRequestId, timeout: ASK_TIMEOUT_MS },
      );
    } catch {
      // A client that declares no elicitation capability, one that declares it
      // and refuses, or nobody answering inside ASK_TIMEOUT_MS. None of those is
      // a person saying no.
      return 'unavailable';
    }
    return answer.action === 'accept' && answer.content?.['approve'] === true
      ? 'approved'
      : 'refused';
  };
}

/**
 * Who this session belongs to, re-read on every request rather than captured.
 *
 * A session outlives the request that opened it, so the bearer token that opened
 * it must not be the one its tool calls run under: a rotated or refreshed token
 * would leave the session writing to Plane with a credential the client has
 * already replaced. Each request re-authenticates and updates this, and a
 * request whose holder does not match the one the session was opened for is
 * refused rather than served.
 */
interface Context {
  actor: Actor;
  authorization: string;
}

function build(deps: ToolDeps, ctx: Context): Server {
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

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;

    // Only this path can ask a person anything. The REST surface has no channel
    // to one, which is correct rather than a gap: an approval must come from a
    // human who was actually asked, and every other door into this gateway is
    // one an agent can open by itself.
    //
    // Built per call rather than per connection because the question has to
    // travel on this call's stream — see asker().
    const withHuman: ToolDeps = { ...deps, askHuman: asker(server, extra.requestId) };

    try {
      // Cast because the SDK's result union also covers long-running "task"
      // results, which nothing here produces.
      return (await callTool(
        withHuman,
        ctx.actor,
        ctx.authorization,
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

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** The holder this session was opened for. Constant for its lifetime. */
  holder: string;
  ctx: Context;
  lastSeen: number;
}

/**
 * Live conversations, keyed by the session id the transport minted.
 *
 * Process-local by design: this holds an open socket and a pending question, and
 * neither is portable to another process. A gateway behind more than one replica
 * needs sticky routing on `mcp-session-id`, or clients will be told to
 * re-initialize whenever they land somewhere new.
 */
const sessions = new Map<string, Session>();

/** Idle sessions are dropped. A conversation nobody has spoken to in this long is over. */
const SESSION_IDLE_MS = 60 * 60_000;

/**
 * A ceiling, so a client that initializes in a loop cannot grow this without
 * bound. The oldest go first, and a client whose session is dropped is told to
 * initialize again — the same thing a restart tells it.
 */
const MAX_SESSIONS = 1000;

function drop(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  void session.transport.close();
  void session.server.close();
}

function sweep(): void {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) drop(id);

  if (sessions.size <= MAX_SESSIONS) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [id] of oldest.slice(0, sessions.size - MAX_SESSIONS)) drop(id);
}

/** A JSON-RPC error the client can read, for the cases that never reach a transport. */
function refuse(reply: FastifyReply, status: number, code: number, message: string): void {
  void reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export async function handleMcpHttp(
  deps: ToolDeps,
  actor: Actor,
  authorization: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  sweep();

  const header = request.headers['mcp-session-id'];
  const sessionId = Array.isArray(header) ? header[0] : header;
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !existing) {
    // The gateway restarted, or the session went idle. 404 is what the spec
    // tells the client to answer by initializing again, so this is a round trip
    // rather than a broken conversation — the property statelessness used to
    // provide, obtained from the protocol instead of from the architecture.
    refuse(reply, 404, -32001, 'Session not found. Initialize again.');
    return;
  }

  if (existing && existing.holder !== actor.holder) {
    // Bearer tokens are per agent, and a session is a conversation with one of
    // them. Serving a second holder from it would run their calls under the
    // first one's identity — every write attributed to the wrong agent.
    refuse(reply, 403, -32001, 'This session belongs to another agent.');
    return;
  }

  let session = existing;
  if (session) {
    // Re-authenticated above by the route, so this is the current credential
    // rather than whichever one opened the conversation.
    session.ctx.authorization = authorization;
    session.ctx.actor = actor;
    session.lastSeen = Date.now();
  } else {
    const ctx: Context = { actor, authorization };
    const server = build(deps, ctx);
    const transport = new StreamableHTTPServerTransport({
      // Sessioned, and SSE rather than a plain JSON body: both are what give a
      // server-initiated question somewhere to go and somewhere to come back to.
      // See the note at the top of this file.
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, holder: actor.holder, ctx, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });

    // The SDK's own Transport interface declares optional callbacks as required-
    // but-possibly-undefined, which exactOptionalPropertyTypes rejects. The cast
    // is confined to this one call rather than loosening the setting for the
    // project.
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    session = { server, transport, holder: actor.holder, ctx, lastSeen: Date.now() };

    // A request that never initializes a session — a malformed body, or a probe —
    // leaves this transport unreachable, so release it with the response rather
    // than leaving its keep-alive timer running for nothing.
    reply.raw.on('close', () => {
      const id = transport.sessionId;
      if (id && sessions.get(id)?.transport === transport) return;
      void transport.close();
      void server.close();
    });
  }

  // Fastify must not also try to reply: the transport writes to the raw socket.
  reply.hijack();
  await session.transport.handleRequest(request.raw, reply.raw, request.body);
}
