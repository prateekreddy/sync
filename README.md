# sync

A work tracker your team and your agents share, built by **not** building a tracker.

- **[Plane](https://plane.so) (self-hosted)** is the system of record — boards, intake
  for non-devs, comments, permissions, search, the whole UI. Unmodified.
- **The gateway** adds the one thing Plane cannot do: atomic claim, so two agents
  never work the same item. It also hosts Plane's own MCP server, so agents get
  Plane's full tool surface without ever holding a Plane credential.
- **Onboarding is one command.** The gateway speaks MCP over HTTPS, so pointing an
  agent at it needs no local install and no configuration beyond a URL and a token.

See [`docs/architecture.md`](docs/architecture.md) for why it is shaped this way,
including the measured evidence that client-side claim protocols cannot work here.

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
agent. That is the whole server install.

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

This turns off the bundled Plane services and points the gateway at yours. Fill in
the three values `.env` asks for at the top: the Postgres superuser credentials (to
create the gateway's own database once), a Plane API token, and the workspace slug.

`provision.sh` does not run in this mode — it executes inside the `api` container,
which belongs to your stack. Do the same four things in Plane's UI instead: sign
up, create the workspace, create the project, create an API token, then put the
token in `deploy/.env` as `PLANE_API_KEY`.

### Behind a reverse proxy you already run

If something else already owns `:80`/`:443` on the host — Caddy, nginx, Traefik —
give this stack no host bindings at all and let that proxy reach it over the Docker
network. In a `docker-compose.override.yml`:

```yaml
services:
  proxy:                    # would otherwise collide on 80/443 and fail to bind
    ports: !override []
  gateway:                  # agent tokens are bearer credentials; keep it unpublished
    ports: !override []
```

Then point your proxy at `proxy:80` and `gateway:8787`, attach it to the network
named by `PLANE_NETWORK`, and in `.env` set `WEB_URL` and `CORS_ALLOWED_ORIGINS` to
the `https://` address users actually visit — Plane builds absolute URLs and
sign-in redirects from them, so leaving them `http://` breaks the login round trip.
Leave `SITE_ADDRESS=:80`: TLS is the outer proxy's job and Plane's own proxy should
not try to get a certificate.

`provision.sh` needs no host port for this — it asks Docker where each service is.
Two overrides exist for what it cannot infer, neither normally needed:

| Variable | Use when |
|---|---|
| `PROVISION_BASE_URL` | Plane is reachable somewhere Docker cannot report |
| `PROVISION_GATEWAY_URL` | same, for the gateway's `/healthz` poll |

Nothing in the stack can know your proxy's public hostname, so the summary prints
`<gateway-url>` for you to substitute. Set `SYNC_GATEWAY_URL` in `.env` to have it
printed for real.

### What provisioning does

`provision.sh` creates the admin account, the workspace, one Plane user per agent,
an API token for each, the project with Plane's default workflow states, and the
gateway tokens. It marks the instance set up and restarts the `api` container on the
run that does so, because that container caches the flag.

It is idempotent — re-run it to add agents or repair a half-finished setup.

If a Plane upgrade breaks it, do the same four things in the UI (sign up, workspace,
project, API token) and put the token in `deploy/.env`.

### Point an agent at it

No server access and no admin role needed. Create a personal token in Plane's UI
(your avatar → Settings → Personal access tokens), exchange it for an agent token,
and register that:

```bash
curl -sS -X POST https://<gateway-host>/v1/agent-tokens \
  -H "Authorization: Bearer plane_api_..." -H 'Content-Type: application/json' \
  -d '{"agent":"worker-1","projectId":"<project-uuid>"}'

claude mcp add --transport http sync https://<gateway-host>/mcp \
  --header "Authorization: Bearer sync_agent_..."
```

Nothing built, nothing cloned, no project id on the agent box. New tools and Plane
upgrades arrive on the next gateway deploy without touching this machine.

`bin/onboard.sh` does both steps and checks the gateway answers first. It takes
every value as a flag, then an environment variable, then a prompt, so it suits
both a person and a provisioning script. `--client codex` prints Codex config.

The stdio bridge in `mcp/` is there for clients that cannot speak HTTP transport.
Both doors lead to the same catalogue and the same policy.

[`docs/onboarding.md`](docs/onboarding.md) has the full walkthrough, troubleshooting,
what belongs in `CLAUDE.md`/`AGENTS.md`, and how to wire this into project creation.

> **Give the agent only the `sync_agent_…` token**, never a Plane token. A Plane
> token can set `assignee` directly, which bypasses the lease and puts two agents
> on one item.

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

It runs gateway-side, one child process per agent identity, so Plane's activity log
attributes work natively.

Every proxied call passes a policy check, which refuses two things:

- **`assignees` and `state` on an existing item**, unless you hold that item's lease.
- **Schema-shaped destruction** (`delete_state`, `update_state`, `delete_label`, …),
  unless the token carries the `destructive` capability. Agents do not get it by
  default; deleting a state strands every item that referenced it.

Everything else — titles, descriptions, priorities, labels, cycles, comments — goes
straight through to Plane, which has its own permission model.

## Sub-items

`capture(parentId: …)` creates a sub-item — Plane models it as a `parent` uuid.

A parent with unfinished children is **not claimable**: the work lives in the
children. Use `parentId` for real decomposition, and `discoveredFrom` for "I noticed
this while working on that", which constrains nothing.

## Operating notes

**Lease TTL.** Default 600s. Set it to your slowest realistic task, and have agents
heartbeat at roughly TTL/3. Too short and healthy agents lose work mid-task; too long
and a dead agent's item sits idle.

**Repeated expiry is a signal.** After 3 expiries the sweeper flags the item for human
attention — a task that keeps killing its agent is usually underspecified.

**Plane's rate limit is per token**, default 60/minute, which is sized for a human
clicking around. One claim costs four API calls, so that caps an agent at roughly a
dozen claims a minute and returns 429 under any burst. `gen-env.sh` sets
`API_KEY_RATE_LIMIT=300/minute`. Each agent writes with its own Plane token, so the
budget scales with fleet size.

**Plane lags by a second or so.** `complete` ends the lease immediately and writes
Plane in the background, so an agent never fails because Plane was slow. A dependent
item can stay blocked briefly after its blocker finishes.

**Key rotation.** Rotating `GATEWAY_TOKEN_KEY` invalidates every stored Plane token —
re-issue each agent's. Not fatal: the gateway falls back to the service account, so
you get degraded attribution rather than an outage.

**Backup.** One PGDATA backup covers Plane and the gateway at a consistent restore
point; they share an instance but are separate databases.

**The network outlives the stack.** `docker compose down` leaves it. Remove it with
`docker network rm sync_plane`.

**Running two gateway replicas** reopens an out-of-order display bug in the Plane
mirror — finished work can show as "In Progress". The lease stays correct either way.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `served a web page, not a gateway` | You pointed at Plane. Use the gateway host, usually `mcp.<your-plane-host>` |
| `Plane rejected that personal token` | Wrong token type or expired. Create a new one under your Plane profile → Personal access tokens |
| `You are not a member of project …` | Add yourself to that project in Plane, then retry |
| `already belongs to a different Plane user` | Someone else has that agent name. Pick another |
| HTTP 429 from `/v1/agent-tokens` | Mint limit is 10/min per address. Wait a minute |
| `UNAUTHENTICATED` from a tool call | The agent token is wrong or was replaced. Mint a new one and re-run `claude mcp add` |
| Agent connects but has no tools | Gateway is up but Plane is unreachable from it. Check `docker compose logs gateway` |
| 403 on every Plane write | The agent's Plane user is not a project member |
| `next` returns nothing | Nothing is ready: items may be blocked, already leased, or parents with unfinished children |
| Plane shows "In Progress" for finished work | Mirror write failed. `docker compose logs gateway \| grep 'plane mirror failed'` |
| Gateway crash-loops on `PLANE_API_KEY is not set` | `.env` was read before provisioning filled it in. Re-run `docker compose up -d gateway` |

## Tests

```bash
cd server && npm test          # 44 unit tests: lease semantics (20-way contention),
                               # readiness screening, sub-item counting, tool policy,
                               # token ownership

# against a running stack
export GATEWAY=http://localhost:8787 PROJECT=<uuid> T1=… T2=… T3=…
python3 server/test/e2e.py         # the agent loop, end to end
python3 server/test/proxy_e2e.py   # the proxied surface cannot bypass the lease
```

Run `proxy_e2e.py` after any change to the tool surface: it checks that a non-holder
cannot set `assignees` or `state` through Plane's own `update_issue`, that harmless
edits still work, and that attribution survives the proxy.

The unit tests need Postgres. `deploy/docker-compose.yml` provides it; point
`GATEWAY_DATABASE_URL` at it if it is not on `localhost:15432`.

## Known gaps

- No GitHub webhook yet, so `complete` records evidence but nothing verifies it.
  Machine-checked closing (PR merged → close) is the natural next step.
- No decay or curation of stale captures. Write-first plus agents produces volume;
  dedup-on-write is the only hedge in place so far.
- The gateway serves work but does not dispatch it — agents poll, nothing launches them.
- Mirror-write ordering is per-process, so running two gateway replicas would reopen
  the out-of-order display bug. The lease stays correct either way.
