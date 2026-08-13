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

### Deploy behind a reverse proxy you already run

On a host where Caddy, nginx or Traefik already owns 80 and 443:

```bash
cd deploy
./gen-env.sh --behind-proxy \
  --domain plane.example.dev --gateway-domain mcp.example.dev
docker compose up -d
./provision.sh
```

This binds the whole stack to **loopback only** — Plane on `127.0.0.1:8090`, the
gateway on `127.0.0.1:8787` — and leaves TLS to the proxy in front. It also writes
`deploy/Caddyfile.sync`, two blocks to import from your existing Caddyfile:

```caddy
plane.example.dev  { reverse_proxy 127.0.0.1:8090 }
mcp.example.dev    { reverse_proxy 127.0.0.1:8787 { flush_interval -1 } }
```

Three things this mode gets right that setting the ports by hand does not:

- **`GATEWAY_PUBLIC_URL` is written.** It is the OAuth issuer and the base of every
  endpoint the gateway advertises. Behind a proxy the request arrives on plain HTTP
  at a loopback port, so anything inferred from it advertises an address no client
  can reach, and sign-in fails in a way that looks like a client bug.
- **`WEB_URL` and `CORS_ALLOWED_ORIGINS` become `https://`.** Plane builds sign-in
  redirects from `WEB_URL`; an `http://` value behind an `https://` front end drops
  users out of the secure origin mid-login.
- **`SITE_ADDRESS` stays `:80`.** Plane's bundled proxy never asks for a
  certificate. Two proxies answering ACME challenges for one name fail every
  challenge and can burn the CA's rate limit for the domain.

Plane's bundled proxy still runs, and should: it does Plane's internal path routing
(`/god-mode/`, `/spaces/`, `/api/`, `/auth/`, `/live/`, uploads). That routing is
upstream's and changes between releases, so pointing your proxy at the individual
containers instead would break on the next version bump. It binds nothing public in
this mode.

**Is your proxy itself a container?** Check with `docker ps --filter publish=443`. If
it is, the block above cannot work: `127.0.0.1` inside a container is *that
container's* loopback, and nothing is listening on it. The symptom is a 502 with a
perfectly valid certificate, which points at nothing. Join the proxy to this stack's
network and address the services by name:

```yaml
# in your proxy's own compose file
services:
  caddy:
    networks: [default, sync_plane]      # PLANE_NETWORK from deploy/.env
networks:
  sync_plane:
    external: true
```

```caddy
plane.example.dev  { reverse_proxy proxy:80 }
mcp.example.dev    { reverse_proxy gateway:8787 { flush_interval -1 } }
```

Traffic then stays on the Docker network, so the published loopback ports are not
needed at all — drop them with a `docker-compose.override.yml` if you prefer no host
bindings whatsoever:

```yaml
services:
  proxy:
    ports: !override []
  gateway:                  # agent tokens are bearer credentials; keep it unpublished
    ports: !override []
```

`provision.sh` needs no host port either way — it asks Docker where each service is.
Two overrides exist for what it cannot infer, neither normally needed:

| Variable | Use when |
|---|---|
| `PROVISION_BASE_URL` | Plane is reachable somewhere Docker cannot report |
| `PROVISION_GATEWAY_URL` | same, for the gateway's `/healthz` poll |

Nothing in the stack can know your proxy's public hostname, so the summary prints
`<gateway-url>` for you to substitute. Set `SYNC_GATEWAY_URL` in `.env` to have it
printed for real.

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

Also turn **Modules** on in the project's settings. Plane gates them per project,
and provisioning normally does it for you; without it every module call fails,
and the 404 reads like a wrong URL rather than a disabled feature.

### What provisioning does

`provision.sh` creates the admin account, the workspace, one Plane user per agent,
an API token for each, the project with Plane's default workflow states, and the
gateway tokens. It marks the instance set up and restarts the `api` container on the
run that does so, because that container caches the flag.

It is idempotent — re-run it to add agents or repair a half-finished setup.

If a Plane upgrade breaks it, do the same four things in the UI (sign up, workspace,
project, API token) and put the token in `deploy/.env`.

### Connect Claude Code

You do not need server access or an administrator role.

1. Add the Sync gateway.

   ```bash
   claude mcp add --transport http sync https://<gateway-host>/mcp
   ```

2. Start the sign-in flow.

   ```bash
   claude mcp login sync
   ```

3. In the browser, paste a Plane personal token.
4. Select the agent name and project.
5. Make sure that Claude Code can connect.

   ```bash
   claude mcp list
   ```

Create the Plane token under **Avatar → Settings → Personal access tokens**. Any
Plane role can create this token. Claude Code stores the agent token in the system
keychain. It does not write the token to a configuration file or shell history.

You can also open `/mcp` in a Claude Code session. This command shows the server
status and starts sign-in when authentication is necessary.

### Connect Codex

You do not need server access or an administrator role.

1. Add the Sync gateway.

   ```bash
   codex mcp add sync --url https://<gateway-host>/mcp
   ```

2. Start the sign-in flow.

   ```bash
   codex mcp login sync
   ```

3. In the browser, paste a Plane personal token.
4. Select the agent name and project.
5. Make sure that Codex can connect.

   ```bash
   codex mcp list
   ```

Create the Plane token under **Avatar → Settings → Personal access tokens**. Any
Plane role can create this token. Codex stores the OAuth credential for later
sessions.

You can also open `/mcp` in a Codex session to see the server status.

**For headless agents** — `claude -p`, the Agent SDK, CI, a container, any box
nobody is sitting at — there is no browser, so the sign-in above cannot finish.
Exchange the Plane token for an agent token and pass it as a header instead:

```bash
curl -sS -X POST https://<gateway-host>/v1/agent-tokens \
  -H "Authorization: Bearer plane_api_..." -H 'Content-Type: application/json' \
  -d '{"agent":"worker-1","projectId":"<project-uuid>"}'

claude mcp add --transport http sync https://<gateway-host>/mcp \
  --header "Authorization: Bearer sync_agent_..."
```

The two routes are alternatives, not layers: **Claude Code disables OAuth fallback
as soon as `headers.Authorization` is set on a server**, so an entry with a header
never offers to sign in, and an entry that offers to sign in cannot carry a token.
Pick per box.

Either way: nothing built, nothing cloned, no project id on the agent box. New
tools and Plane upgrades arrive on the next gateway deploy without touching this
machine.

`sync-connect` does that whole flow with the gateway checked first, and verifies
the token before registering it — so a bad value fails at a shell prompt rather
than as a missing tool inside an agent session. It takes every value as a flag,
then an environment variable, then a prompt, so it suits both a person and a
provisioning script. `--client codex` prints Codex config.

```bash
bin/onboard.sh --help                             # from a clone of this repo
${CLAUDE_PLUGIN_ROOT}/bin/sync-connect --help     # from an installed plugin
```

The second is the one that matters on a provisioned box: the plugin is the only
thing installed there, so the connect script has to ship inside it.

Set `GATEWAY_PUBLIC_URL` in `deploy/.env` to the URL agents use. Sign-in builds
every address from it, and behind a proxy that does not forward the original host
it cannot be inferred.

To see the agents you own — names, project binding, and whether each is still
active:

```bash
curl -sS https://<gateway-host>/v1/agent-tokens \
  -H "Authorization: Bearer plane_api_..."
```

Revoked agents stay in the list, marked inactive, so "did my revoke work?" has an
answer. Agents issued from the CLI without `--plane-token` have no recorded Plane
owner and appear for nobody; an operator sees every agent with
`node dist/cli.js list-tokens`.

To retire an agent — you can only revoke your own:

```bash
curl -sS -X DELETE https://<gateway-host>/v1/agent-tokens/worker-1 \
  -H "Authorization: Bearer plane_api_..."
```

`claude mcp logout` only clears the local copy. Use the call above when a token
may have leaked or a machine is gone.

The stdio bridge in `mcp/` is there for clients that cannot speak HTTP transport.
Both doors lead to the same catalogue and the same policy.

[`docs/onboarding.md`](docs/onboarding.md) has the full walkthrough, troubleshooting,
what belongs in `CLAUDE.md`/`AGENTS.md`, and how to wire this into project creation.

Three rules belong in context for every request; Plane's forty-seven tools do not.
[`skills/work-tracking/`](skills/work-tracking/) is the playbook for those — the claim
loop and its failure modes, what the readiness gate withholds, and what cycles, modules,
labels and worklogs are each good for. Copy it to `~/.claude/skills/` and it loads only
when an agent is actually working an item.

> **Give the agent only the `sync_agent_…` token**, never a Plane token. A Plane
> token can set `assignee` directly, which bypasses the lease and puts two agents
> on one item.

## The tool surface

One MCP server, 62 tools, two halves.

**Ours — coordination.** Plane has no equivalent for any of these.

```
capture   → write it down the moment you notice it (dedups, idempotent)
next      → see what's ready        (read-only, reserves nothing)
why       → why can't I have that?  (the gate's own reasons)
tree      → what's under this item? (sub-items, state, who holds them)
find      → filtered query           (labels, priority, module, holder, ready)
search    → find work anywhere        (across projects, scoped to your access)
board     → where does this stand?   (progress per module, live leases)
decompose → break an item up         (one call, not N)
claim     → take it atomically      (returns an epoch — keep it)
heartbeat → keep the claim alive    (or it returns to the pool)
complete  → finish, with evidence   (epoch required)
release   → hand it back
constrain → a requirement on work that already exists (not a new task)
link      → blocked_by / duplicate / relates_to
unlink    → that dependency is not real (retracts; Plane cannot delete)
held      → what am I holding? (call after a restart)
history   → has this been attempted? (claims, expiries, how it ended)
```

**Plane's — everything else.** The gateway runs Plane's official
`@makeplane/plane-mcp-server` and re-exports its 47 tools as **10**, grouped by the
thing they act on: `plane_cycles`, `plane_modules`, `plane_labels`, `plane_states`, `plane_issue_types`,
`plane_worklogs`, `plane_comments`, `plane_issues`, `plane_projects`, `plane_people`. Each takes an `action`.

One tool per REST endpoint is the right shape for an API and the wrong one for a
tool list: the list is what the model reads to work out what it can do, and 47
near-identical CRUD entries crowd out the few that matter. Grouping is presentation
only — each call resolves to exactly one upstream tool and is forwarded unchanged,
the raw names stay callable though unlisted, and anything upstream serves that no
group claims is still listed on its own.

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

**Taking work back from an agent.** Do it in Plane, the way you would with a
person: unassign them, or close the item. Within about thirty seconds the lease is
revoked, the agent is told in plain words on its next check, and its next attempt
to write anything against that item is refused — with advice not to re-claim it,
because you decided it was not theirs.

Nothing is written back to Plane when this happens. The revocation exists
*because* of what Plane says, so mirroring would be the gateway arguing with your
edit.

Only those two acts count. Retitling, reprioritising or relabelling an item does
not take it away from anyone, and neither does an unreachable Plane — a revocation
stops an agent mid-task, so it needs an act that can only mean one thing.

**Which build is running.** `curl <gateway>/healthz` — no token needed, because the
question comes up before you have one:

```json
{"ok":true,
 "build":{"sha":"082ba9e…","builtAt":"2026-08-04T06:55:00Z"},
 "schema":{"level":"006_relation_retraction","count":6,"appliedAt":"…"}}
```

`build.sha` is a Docker build arg stamped in by `provision.sh` from the checkout it
deployed; compare it with `git rev-parse HEAD`. `schema.level` is the highest
migration *that host's database* has had, which is the other half — a current image
against a database that never got its migration fails only on the feature that needed
it. `null` means the value is unknown; a reply with no `build` key at all is a gateway
older than this feature. `provision.sh` compares the two after deploying and warns
when the container answering is not the one it just built.

**Lease TTL.** Default 600s. Set it to your slowest realistic task, and have agents
heartbeat at roughly TTL/3. Too short and healthy agents lose work mid-task; too long
and a dead agent's item sits idle.

**Repeated expiry is a signal.** After 3 expiries the sweeper flags the item for human
attention — a task that keeps killing its agent is usually underspecified.

**Plane's rate limit is per token**, default 60/minute, which is sized for a human
clicking around. One claim costs four API calls, so that caps an agent at roughly a
dozen claims a minute and returns 429 under any burst. `gen-env.sh` sets
`API_KEY_RATE_LIMIT=300/minute`. Each agent writes with its own Plane token, so the
budget scales with the number of agents.

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

**Running two gateway replicas** is safe. Plane writes are ordered per work item
across processes by a Postgres advisory lock, so a completion cannot land before
the claim that preceded it, and `MINT_RATE_LIMIT` is counted in Postgres so it
means the same thing at one replica and at three.

## Checking completions against GitHub

`complete` takes an agent's word for it. If the gateway knows where the code
lives, it checks that word *while the agent is still on the call* — no webhook,
no polling, no background loop. `complete` **is** the notification.

Set either of these in `deploy/.env` and restart:

```bash
GITHUB_REPO=owner/name     # where bare commit shas are looked up
GITHUB_TOKEN=ghp_...       # read-only. Required for private repositories
```

Every citation in the outcome comes back with a verdict:

| Status | Meaning |
|---|---|
| `landed` | Merged, or an ancestor of the default branch |
| `pending` | Real, not merged yet. An open pull request at completion time is normal |
| `absent` | GitHub says there is no such thing |
| `unchecked` | Not askable — no token, no repo, not a GitHub link, or GitHub was unreachable |

Two labels, deliberately distinct. `unverified` means the completion cited
**nothing**; `evidence-missing` means **nothing it cited could be found**. The
first is an agent being terse, the second is an agent being wrong.

`evidence-missing` is deliberately not "something did not resolve". A truncated
md5 and a short sha are the same characters, so an outcome that quotes a checksum
as evidence hands the scanner a hex word that will never resolve — and the old
rule flagged a completion backed by three real commits for doing careful work.
The detection cannot be sharpened, so the consequence is what changed: one
citation that exists makes the claim evidenced, and a stray checksum beside it
proves nothing either way. Unresolved citations are still reported on the
completion, because they are usually a typo worth fixing; they are simply not a
flag on the board.

**It never blocks on GitHub.** Anything that fails — no token, a timeout, a 5xx,
a rate limit — becomes `unchecked`, which is a stated absence of information
rather than an accusation. A lease must not fail to end because a third party
was slow.

**Without a token it will not accuse.** A private repository answers 404 to a
stranger exactly as a nonexistent one does, so an unauthenticated 404 is reported
`unchecked`, never `absent`.

`REQUIRE_EVIDENCE=refuse` rejects a `complete` whose citations **all** failed to
resolve — the same rule as the label — checked *before* the lease ends, so a
refused agent still holds its work.

What this deliberately does **not** do is watch for the pull request to merge
later. That would need a receiver or a poller, and the failure worth catching is
the citation that resolves to nothing, which is visible immediately.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `served a web page, not a gateway` | You pointed at Plane. Use the gateway host, usually `mcp.<your-plane-host>` |
| `! Needs authentication` | Not signed in yet. `claude mcp login sync`, or open `/mcp` in a session |
| Sign-in opens the wrong host, or hangs | Set `GATEWAY_PUBLIC_URL` in `deploy/.env` and restart the gateway |
| `Plane rejected that personal token` | Wrong token type or expired. Create a new one under your Plane profile → Personal access tokens |
| `You are not a member of project …` | Add yourself to that project in Plane, then retry |
| `already belongs to a different Plane user` | Someone else has that agent name. Pick another |
| HTTP 429 from `/v1/agent-tokens` | Mint limit is 10/min per address. Wait a minute |
| `UNAUTHENTICATED` from a tool call | The agent token is wrong or was replaced. Mint a new one and re-run `claude mcp add` |
| **Agent has no sync tools at all, and nothing errored** | Installed but never signed in — the tools come from the gateway, the rules and hooks come from disk. A person runs `/mcp`; a box with no browser runs `sync-connect`. Restart either way. Nothing refuses in this state, so an agent will work with no lease unless it checks |
| Agent has no tools, but `claude mcp list` says **connected** | A different fault from the row above: the gateway is up and authenticating you, and cannot reach Plane to build the catalogue. Check `docker compose logs gateway` |
| **502 from your reverse proxy, with a valid certificate** | The proxy answered and could not reach the stack. If that proxy is itself a container, `127.0.0.1` is *its* loopback, not the host's — join it to the stack's network and use `reverse_proxy proxy:80` and `gateway:8787`. See the two variants in `deploy/Caddyfile.sync` |
| **Migrator loops on `password authentication failed for user "plane"`** | The `pgdata` volume predates the current `.env`: Postgres sets `POSTGRES_PASSWORD` only when it first initialises. Realign the database over its unix socket, which trusts local connections even when the TCP password is wrong — see below |

Realigning a Postgres whose volume kept an older password, without losing data:

```bash
cd deploy
PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T plane-db psql -U plane -d postgres -h /var/run/postgresql \
  -v pw="$PW" <<<"ALTER USER plane WITH PASSWORD :'pw';"
docker compose up -d
```

`-h /var/run/postgresql` is required: `PGHOST` is set inside the container, so psql
would otherwise dial TCP and hit the very authentication it is repairing. The
statement goes on stdin because psql does not interpolate `-v` variables inside
`-c`, and passing the password as a psql variable rather than splicing it into the
SQL keeps it correct for a password containing a quote.

If Plane holds nothing worth keeping, `docker compose down && docker volume rm
<project>_pgdata && docker compose up -d` is simpler.

| 403 on every Plane write | The agent's Plane user is not a project member |
| `next` returns nothing | Call `why` on the item you expected. It reports the gate's own reasons — no description, blocked, leased, unfinished children, label, capability mismatch |
| Plane shows "In Progress" for finished work | Mirror write failed. `docker compose logs gateway \| grep 'plane mirror failed'` |
| Gateway crash-loops on `PLANE_API_KEY is not set` | `.env` was read before provisioning filled it in. Re-run `docker compose up -d gateway` |
| Every citation comes back `unchecked` | Neither `GITHUB_TOKEN` nor `GITHUB_REPO` is set, so checking is off |
| A real commit is reported `absent` | `GITHUB_REPO` points at the wrong repository, or the sha is on a fork the token cannot see |
| A private repo's citations are `unchecked` | Set `GITHUB_TOKEN`. Without it a private 404 is indistinguishable from a missing one, and the gateway will not guess |

## Tests

```bash
cd server && npm test          # 439 unit tests: lease semantics (20-way contention),
                               # readiness screening, sub-item counting, tool policy,
                               # token ownership, evidence checking, reference linking,
                               # and that the skill still names every tool that exists

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

Without a stack — a fresh checkout, or a box where Plane is not running — one
container is enough:

```bash
docker run -d --name sync-test-db -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=plane -e POSTGRES_PASSWORD=plane -e POSTGRES_DB=plane \
  postgres:15.7-alpine
docker cp server/migrations sync-test-db:/migrations
docker exec -e PGPASSWORD=plane sync-test-db \
  psql -h /var/run/postgresql -U plane -d postgres -f /migrations/000_bootstrap.sql
for f in server/migrations/0*.sql; do
  b=$(basename "$f" .sql); [ "$b" = 000_bootstrap ] && continue
  docker exec -e PGPASSWORD=agent_gw_dev sync-test-db \
    psql -h /var/run/postgresql -U agent_gw -d gateway -v ON_ERROR_STOP=1 -f "/migrations/$b.sql"
done
```

The loop globs rather than listing the files: the list here was hardcoded and had
already gone stale by two migrations, which fails as a missing table three
commands later rather than as a missing file.

`POSTGRES_DB=plane` is not decoration: `000_bootstrap.sql` revokes `CONNECT` on
Plane's own database, and fails if there is no such database to revoke it on.
`psql` inside the container needs `-h /var/run/postgresql` — the image's default
host is a TCP loopback that is not listening.

## Known gaps

- No decay or curation of stale captures. Write-first plus agents produces volume;
  dedup-on-write is the only hedge in place so far.
- The gateway serves work but does not dispatch it — agents poll, nothing launches them.
