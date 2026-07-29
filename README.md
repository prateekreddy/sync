# sync

A work tracker your team and your agents share, built by **not** building a tracker.

- **[Plane](https://plane.so) (self-hosted)** is the system of record — boards, intake
  for non-devs, comments, permissions, search, the whole UI. Unmodified.
- **The gateway** adds the one thing Plane cannot do: atomic claim, so two agents
  never work the same item. It also hosts Plane's own MCP server, so agents get
  Plane's full tool surface without ever holding a Plane credential.
- **`sync-mcp`** is a stdio MCP server installed into Claude Code / Codex. It defines
  no tools at all — it fetches the catalogue from the gateway and forwards calls.

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

Everything is one Docker Compose stack in `deploy/`. Whether it also deploys Plane is
decided by one line in `.env`.

### Deploy Plane too (default)

```bash
cd deploy
./gen-env.sh --domain your-host --port 80   # writes .env with real secrets
docker compose up -d                        # first boot pulls ~2GB
./provision.sh                              # workspace, project, agents, gateway
```

`provision.sh` prints the Plane sign-in, the project id, and one gateway token per
agent. That is the whole install.

Do not skip `gen-env.sh`. Plane's published compose file ships *working defaults* for
`SECRET_KEY`, the MinIO credentials and the RabbitMQ password — they are in a public
repository, so a stack brought up with them has a session-signing key and object
storage anyone can guess. It boots fine, which is exactly why it is easy to miss.

### Attach to a Plane you already run

```bash
cd deploy
./gen-env.sh --plane-url http://proxy --plane-network plane-app_default
# then fill in the three values .env asks for at the top, and:
docker compose up -d                                 # bootstraps the gateway's database
COMPOSE_PROFILES=gateway docker compose up -d
```

This turns off the bundled Plane services and points the gateway at yours. It needs
three things you have to supply, because they belong to your instance: the Postgres
superuser credentials (to create the gateway's own database once), a Plane API token,
and the workspace slug. `provision.sh` does not run in this mode — it works by
executing inside the `api` container, which belongs to your stack, not this one.

### What provisioning actually does

Plane has no supported way to create the first user, the first workspace, or an API
token without a browser session — an API token is the only credential `/api/v1/`
accepts, and minting one needs a session you cannot get headlessly. So `provision.py`
uses Plane's ORM for exactly those three things and stops there. The project is
created through the public API instead, because that endpoint also creates Plane's
default workflow states, and the readiness gate reads state *groups* to decide what is
claimable.

If a Plane upgrade ever breaks that script, nothing is lost: do the same four things
in the UI (sign up, workspace, project, API token) and put the token in `deploy/.env`.

### Install the MCP server on each agent box

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

That is the only thing agents install, and it is the last time you touch an agent box:
the tool catalogue is served by the gateway, so new tools — ours or Plane's — arrive on
the next gateway deploy.

> **Give the agent only the `sync_agent_…` token.** It must never receive a Plane
> token: a Plane Member key lets it set `assignee` directly and bypass the lease,
> which silently breaks mutual exclusion. The gateway holds the Plane credential so
> that identity passes through without possession doing so.

## The tool surface

One MCP server, 55 tools, two halves.

**Ours — coordination.** Plane has no equivalent for any of these.

```
capture   → write it down the moment you notice it (dedups, idempotent)
next      → see what's ready        (read-only, reserves nothing)
claim     → take it atomically      (returns an epoch — keep it)
heartbeat → keep the claim alive    (or it returns to the pool)
complete  → finish, with evidence   (epoch required)
release   → hand it back
link      → blocked_by / duplicate / relates_to
held      → what am I holding? (call after a restart)
```

**Plane's — everything else.** The gateway runs Plane's official
`@makeplane/plane-mcp-server` and re-exports its 47 tools: cycles, modules, labels,
states, work item types, worklogs, comments, members, projects.

It runs *gateway-side* because it authenticates from `PLANE_API_KEY` in its
environment — putting it on the agent box means handing the agent a Plane write
credential. One child process per agent identity, so Plane's activity log attributes
work natively.

Every proxied call passes a policy check first, and it guards exactly one thing:

- **`assignees` and `state` on an existing item** require actually holding the lease.
  These two fields *are* the lease as far as Plane's UI is concerned; without this,
  the wide surface would walk straight around the narrow one.
- **Schema-shaped destruction** (`delete_state`, `update_state`, `delete_label`, …)
  needs the `destructive` capability, which agents do not get by default. Deleting a
  state strands every item that referenced it.

Everything else — titles, descriptions, priorities, labels, cycles, comments — is
Plane's business, and Plane already has a permission model. A policy that tried to
guard everything would become a second, worse copy of Plane's roles.

## Sub-items

Plane models a sub-item as a `parent` uuid on the work item, so `capture(parentId: …)`
is all decomposition needs. The readiness gate then treats a parent with unfinished
children as a *container*, not as claimable work — the work lives in the children, and
handing the parent to a second agent duplicates effort that no lease can detect,
because the two agents hold different items.

Use `parentId` for real decomposition and `discoveredFrom` for "I noticed this while
working on that". The second constrains nothing; the first changes what the fleet is
allowed to pick up.

## Operating notes

**Lease TTL.** Default 600s. Too short and healthy agents lose work mid-task; too long
and a dead agent's item sits idle. Tune to your slowest realistic task, and have agents
heartbeat at roughly TTL/3.

**Repeated expiry is a signal.** After 3 expiries the sweeper flags the item for human
attention — a task that keeps killing its agent is usually underspecified rather than
unlucky.

**Rate limit.** Plane's limit is *per token*, and its default of 60/minute is sized for
a human clicking around. One claim costs a work item list, a relations read, a state
write and a comment, so 60/minute caps an agent at roughly a dozen claims a minute and
starts returning 429 under any burst. `gen-env.sh` sets `API_KEY_RATE_LIMIT=300/minute`.
Because each agent writes with its own Plane token, the fleet's budget scales with
agent count rather than sharing one.

**Plane is a mirror, not the source of truth.** `complete` ends the lease synchronously
and writes Plane asynchronously, so an agent never fails because Plane was slow. The
cost is that a dependent item can stay blocked for a second or so after its blocker
finishes. That lag is in the safe direction. Mirror writes for a given item are
serialised, because without that a fast claim-then-complete can land the two writes out
of order and leave Plane permanently showing "In Progress" for finished work.

**Key rotation.** Rotating `GATEWAY_TOKEN_KEY` invalidates every stored Plane token;
re-run `issue-token --plane-token` for each agent. Decryption failure is not fatal —
the gateway falls back to the service account, so you get degraded attribution rather
than an outage.

**Backup.** Plane and the gateway share a Postgres instance, so one PGDATA backup
covers both at a consistent restore point. They are separate *databases*: Postgres has
no cross-database queries, and `agent_gw` has no `CONNECT` on `plane` at all.

**The network outlives the stack.** It is declared external so one compose file can
either deploy Plane or attach to yours. `docker compose down` leaves it; remove it with
`docker network rm sync_plane`.

## Tests

```bash
cd server && npm test          # 35 unit tests: lease semantics (20-way contention),
                               # readiness screening, sub-item counting, tool policy

# against a running stack
export GATEWAY=http://localhost:8787 PROJECT=<uuid> T1=… T2=… T3=…
python3 server/test/e2e.py         # the agent loop, end to end
python3 server/test/proxy_e2e.py   # the proxied surface cannot bypass the lease
```

`proxy_e2e.py` is the one that matters most when changing the tool surface: it proves
a non-holder cannot set `assignees` or `state` through Plane's own `update_issue`,
that harmless edits still work, and that attribution survives the proxy.

## Known gaps

- No GitHub webhook yet, so `complete` records evidence but nothing verifies it.
  Machine-checked closing (PR merged → close) is the natural next step.
- No decay or curation of stale captures. Write-first plus agents produces volume;
  dedup-on-write is the only hedge in place so far.
- The gateway serves work but does not dispatch it — agents poll, nothing launches them.
- Mirror-write ordering is per-process, so running two gateway replicas would reopen
  the out-of-order display bug. The lease stays correct either way.
