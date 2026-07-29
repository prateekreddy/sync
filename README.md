# sync

A work tracker your team and your agents share, built by **not** building a tracker.

- **[Plane](https://plane.so) (self-hosted)** is the system of record — boards, intake
  for non-devs, comments, permissions, search, the whole UI. Unmodified.
- **The gateway** adds the one thing Plane cannot do: atomic claim, so two agents
  never work the same item.
- **`sync-mcp`** is a thin stdio MCP client installed into Claude Code / Codex. It
  contains no logic — every tool is an HTTP call to the gateway.

Read [`docs/architecture.md`](docs/architecture.md) for why it is shaped this way,
including the measured evidence that client-side claim protocols cannot work here.

## Why the gateway exists

Plane's API has no optimistic concurrency — no `If-Match`, no ETag, no version
precondition. We measured what happens when agents coordinate through `assignee`
alone (`docs/race.py`, `docs/race2.py`):

| Agents arrive | Result |
|---|---|
| Simultaneously | Writes merge, everyone backs off. **Livelock — nobody works.** |
| Staggered (the normal case) | Each write erases the previous assignee. **All three agents proceed** on the same item, and Plane records only the last one — the collision is invisible. |

The gateway replaces that with one atomic SQL statement. Under the same test, exactly
one agent wins and the losers get an actionable error.

## Setup

### 1. Plane

```bash
cd deploy/plane
curl -fsSL -o setup.sh https://github.com/makeplane/plane/releases/latest/download/setup.sh
chmod +x setup.sh && ./setup.sh install
```

Edit `plane-app/plane.env` before starting:

```ini
APP_DOMAIN=your-host:8080
LISTEN_HTTP_PORT=8080
API_KEY_RATE_LIMIT=600/minute   # the gateway is ONE client fronting the whole fleet
WEBHOOK_ALLOWED_HOSTS=gateway   # Plane blocks webhooks to private IPs otherwise
```

```bash
./setup.sh start
```

Then create your workspace and project in the UI, and mint an API token
(Settings → API tokens) for a **Member or Admin** user. Note the workspace slug and
project id.

### 2. Gateway database

Once, as the Plane database owner:

```bash
docker exec -i -e PGPASSWORD=<plane-pw> plane-app-plane-db-1 \
  psql -h 127.0.0.1 -U plane -d postgres < server/migrations/000_bootstrap.sql
```

This creates a separate `gateway` **database** on Plane's existing Postgres, owned by
a scoped `agent_gw` role, and removes that role's access to `plane` entirely. Verify:

```bash
# must fail with: permission denied for database "plane"
docker exec -e PGPASSWORD=<gw-pw> plane-app-plane-db-1 \
  psql -h 127.0.0.1 -U agent_gw -d plane -c 'select 1'
```

Same Postgres instance means Plane's `setup.sh backup` (which copies the whole
PGDATA directory) covers the gateway too, at a consistent restore point.

### 3. Gateway

```bash
cp deploy/gateway.env.example deploy/gateway.env   # fill in the values
docker compose -f deploy/docker-compose.gateway.yml --env-file deploy/gateway.env up -d
curl http://localhost:8787/healthz
```

### 4. Agent tokens

Each agent gets a Plane **Member** user, and the gateway writes to Plane *as* that
user — so Plane's own activity log attributes work natively, with no parallel
attribution layer.

First generate the encryption key for stored Plane tokens and put it in
`deploy/gateway.env`:

```bash
node -e "console.log('GATEWAY_TOKEN_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

Then, per agent: create a Member user in Plane, mint their API token, and register it:

```bash
docker compose -f deploy/docker-compose.gateway.yml exec gateway \
  node dist/cli.js issue-token --name worker-1 --principal human:prateek \
                               --plane-token plane_api_xxxxxxxx
```

> **Give the agent only the `sync_agent_…` token it prints.** It must never receive
> its own Plane token — a Plane Member token lets it set `assignee` directly and
> bypass the lease, which silently breaks mutual exclusion. The gateway holds the
> Plane credential so that identity passes through without possession doing so.

Omit `--plane-token` and the agent still works; its Plane writes are just
attributed to the service account instead.

### 5. Install the MCP client

```bash
cd mcp && npm ci && npm run build
```

**Claude Code:**

```bash
claude mcp add sync \
  --env SYNC_GATEWAY_URL=http://your-host:8787 \
  --env SYNC_AGENT_TOKEN=sync_agent_... \
  --env SYNC_PROJECT_ID=<project-uuid> \
  -- node /abs/path/to/mcp/dist/index.js
```

**Codex** — in `~/.codex/config.toml`:

```toml
[mcp_servers.sync]
command = "node"
args = ["/abs/path/to/mcp/dist/index.js"]
env = { SYNC_GATEWAY_URL = "http://your-host:8787", SYNC_AGENT_TOKEN = "sync_agent_...", SYNC_PROJECT_ID = "<project-uuid>" }
```

### 6. Add Plane's own MCP, read-only

Agents should get Plane's full read surface too — search, comments, cycles, docs.
Give it a **Guest-role** token. Plane's `ProjectEntityPermission` restricts writes to
Admin and Member, so a Guest token is read-only *by enforcement*, not convention:

```
GET  work-items    200
POST work-items    403
PATCH assignees    403   ← the lease bypass, blocked at source
```

Create a Guest member in Plane, mint their API token, and register Plane's MCP server
with it. Agents then read through Plane's MCP and write through `sync`, and cannot
claim work by setting `assignee` directly even if they try.

## The agent loop

```
capture   → write it down the moment you notice it (dedups, idempotent)
next      → see what's ready        (read-only, reserves nothing)
claim     → take it atomically      (returns an epoch — keep it)
heartbeat → keep the claim alive    (or it returns to the pool)
complete  → finish, with evidence   (epoch required)
```

`link` records `blocked_by` / `duplicate` / `relates_to`. Blocked items are withheld
from `claim` automatically.

## Operating notes

**Lease TTL.** Default 600s. Too short and healthy agents lose work mid-task; too long
and a dead agent's item sits idle. Tune to your slowest realistic task, and have agents
heartbeat at roughly TTL/3.

**Repeated expiry is a signal.** After 3 expiries the sweeper flags the item for human
attention — a task that keeps killing its agent is usually underspecified rather than
unlucky.

**Rate limit.** Plane's limit is *per token* (`APIToken.allowed_rate_limit`). Because
each agent writes with its own Plane token, the fleet's budget scales with agent
count rather than sharing one. Only reads and sweeper writes use the service
account's budget — raise `API_KEY_RATE_LIMIT` if that becomes the bottleneck.

**Key rotation.** Rotating `GATEWAY_TOKEN_KEY` invalidates every stored Plane token;
re-run `issue-token --plane-token` for each agent. Decryption failure is not fatal —
the gateway falls back to the service account, so you get degraded attribution
rather than an outage.

**Backup.** `deploy/plane/setup.sh backup` covers Plane and the gateway together.

## Tests

```bash
cd server && npm test                       # lease semantics, incl. 20-way contention
GATEWAY=... PROJECT=... T1=.. T2=.. T3=.. python3 server/test/e2e.py
cd mcp && node test/smoke.mjs               # the MCP stdio path
```

## Known gaps

- No GitHub webhook yet, so `complete` records evidence but nothing verifies it.
  Machine-checked closing (PR merged → close) is the natural next step.
- No decay or curation of stale captures. Write-first plus agents produces volume;
  dedup-on-write is the only hedge in place so far.
- The gateway serves work but does not dispatch it — agents poll, nothing launches them.
