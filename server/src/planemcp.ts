import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { GatewayError } from './errors.js';

/**
 * Plane's own MCP server, hosted by the gateway.
 *
 * Plane ships `@makeplane/plane-mcp-server` (MIT), ~46 tools over the same public
 * `/api/v1/` we already use: cycles, modules, labels, states, work item types,
 * worklogs, comments, members. Re-implementing that surface would be exactly the
 * reinvention we set out to avoid, so we don't — we run it and re-export it.
 *
 * It runs HERE rather than on the agent box for one reason: it authenticates from
 * `process.env.PLANE_API_KEY`, so putting it next to the agent means handing the
 * agent a Plane write credential. A Plane Member token can set `assignees` and
 * `state` directly, which is precisely how an agent bypasses the lease — the
 * failure we measured in docs/race2.py, where three agents each read back their
 * own name and all worked the same item. Running it gateway-side keeps the token
 * on this side of the boundary and lets every call be checked before it lands.
 *
 * One child process per Plane identity, because the token is read from the
 * environment at call time: a single shared process could only ever write as one
 * user, and attribution in Plane's activity log would collapse to the service
 * account.
 */

const require = createRequire(import.meta.url);

/** Resolved from node_modules so the version is whatever package.json pinned. */
function serverEntrypoint(): string {
  try {
    return require.resolve('@makeplane/plane-mcp-server/build/index.js');
  } catch {
    throw new GatewayError(
      'UPSTREAM',
      '@makeplane/plane-mcp-server is not installed; Plane tool proxying is unavailable',
    );
  }
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  lastUsed: number;
  closing?: boolean;
}

export interface PlaneMcpOpts {
  /** Base URL of Plane. The upstream server appends `api/v1/` itself. */
  baseUrl: string;
  workspaceSlug: string;
  /** Gateway service token — used only to read the tool catalogue. */
  serviceToken: string;
  /** Reap a child process after this long without a call. */
  idleMs?: number;
  /** Hard cap on concurrent child processes. */
  maxSessions?: number;
}

export class PlaneMcp {
  private sessions = new Map<string, Session>();
  private catalogue: ToolSpec[] | null = null;
  private catalogueAt = 0;
  private reaper: NodeJS.Timeout;

  constructor(private readonly opts: PlaneMcpOpts) {
    const idle = opts.idleMs ?? 10 * 60_000;
    this.reaper = setInterval(() => void this.reap(idle), 60_000);
    this.reaper.unref?.();
  }

  private key(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  private async open(token: string): Promise<Session> {
    const k = this.key(token);
    const hit = this.sessions.get(k);
    if (hit && !hit.closing) {
      hit.lastUsed = Date.now();
      return hit;
    }

    // Bound the process count. Evicting the least recently used is safe: sessions
    // are stateless, so the next call for that identity just respawns.
    const max = this.opts.maxSessions ?? 24;
    while (this.sessions.size >= max) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      await this.close(oldest[0]);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntrypoint()],
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        // Trailing slash matters: the upstream helper only adds one if missing,
        // then concatenates `api/v1/`.
        PLANE_API_HOST_URL: this.opts.baseUrl.replace(/\/$/, '') + '/',
        PLANE_API_KEY: token,
        PLANE_WORKSPACE_SLUG: this.opts.workspaceSlug,
        // Opt out of the upstream dependency's install-time analytics ping.
        SCARF_ANALYTICS: 'false',
      },
      stderr: 'ignore',
    });

    const client = new Client({ name: 'sync-gateway', version: '0.1.0' });
    await client.connect(transport);

    const session: Session = { client, transport, lastUsed: Date.now() };
    this.sessions.set(k, session);
    return session;
  }

  private async close(k: string): Promise<void> {
    const s = this.sessions.get(k);
    if (!s) return;
    s.closing = true;
    this.sessions.delete(k);
    await s.client.close().catch(() => {});
  }

  private async reap(idleMs: number): Promise<void> {
    const cutoff = Date.now() - idleMs;
    for (const [k, s] of this.sessions) {
      if (s.lastUsed < cutoff) await this.close(k);
    }
  }

  /**
   * The tool catalogue.
   *
   * Schemas are a property of the server, not of the caller, so this is read once
   * with the service token and shared. Refreshed hourly so a version bump of the
   * upstream package is picked up without a gateway restart.
   */
  async tools(ttlMs = 3_600_000): Promise<ToolSpec[]> {
    if (this.catalogue && Date.now() - this.catalogueAt < ttlMs) return this.catalogue;

    const s = await this.open(this.opts.serviceToken);
    const { tools } = await s.client.listTools();
    this.catalogue = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));
    this.catalogueAt = Date.now();
    return this.catalogue;
  }

  /** Invoke an upstream tool as the given Plane identity. */
  async call(token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const s = await this.open(token);
    s.lastUsed = Date.now();
    try {
      return await s.client.callTool({ name, arguments: args });
    } catch (err) {
      // A child that has died leaves a transport that will never recover; drop it
      // so the next call gets a fresh process instead of failing forever.
      await this.close(this.key(token));
      throw new GatewayError('UPSTREAM', `Plane MCP tool "${name}" failed: ${String(err)}`, {
        tool: name,
      });
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((k) => this.close(k)));
  }
}
