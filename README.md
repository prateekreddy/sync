# sync

A work tracker your team and your agents share, built by **not** building a tracker.

- **[Plane](https://plane.so) (self-hosted)** is the system of record — boards, intake
  for non-devs, comments, permissions, search, the whole UI. Unmodified.
- **The gateway** adds the one thing Plane cannot do: atomic claim, so two agents
  never work the same item. It also hosts Plane's own MCP server, so agents get
  Plane's full tool surface without ever holding a Plane credential.
- **Onboarding is one command.** The gateway speaks MCP over HTTPS, so pointing an
  agent at it needs no local install and no configuration beyond a URL and a token.

This page is for **using** a sync that already exists. To stand one up, see
[`deploy/README.md`](deploy/README.md). For why it is shaped this way — including the
measured evidence that client-side claim protocols cannot work here — see
[`docs/architecture.md`](docs/architecture.md).

You will need two things from whoever runs it: the **gateway URL** (something like
`https://mcp.example.dev/mcp`) and a **Plane account** on that instance.

## Install the plugin

The plugin brings the tools, the working rules, the session hooks and the liveness
monitor.

```
/plugin marketplace add prateekreddy/sync
/plugin install sync@sync
```

Claude Code asks for your gateway address as it enables the plugin — the plugin
ships none, because a bundled URL would point every installation at whoever
published it. Give it the host, `https://<gateway-host>`, and leave off the `/mcp`;
that is added for you. Then **restart**: MCP servers are read once at startup.
`/sync-status` answers whether it worked.

To change the address later, or to set it from a provisioning script instead of a
dialog, run `/sync-setup https://<gateway-host>`. That also checks the host answers
like a gateway before writing anything, which catches the usual mistake of giving
it Plane's address instead.

Sign-in is a browser flow, offered on the first tool call. **Installing is not
connecting**: until somebody signs in you have the rules and hooks from disk and no
tools at all, and because there is no `claim` to call, nothing refuses — see
[`plugin/README.md`](plugin/README.md).

## Connect without the plugin

The server on its own — tools, no rules, hooks or monitor.

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

If sign-in opens the wrong host or hangs, that is the deployment's
`GATEWAY_PUBLIC_URL`, not anything on your machine — tell whoever runs it, or see
[`deploy/README.md`](deploy/README.md).

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

One MCP server, 27 tools, two halves.

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
gather    → file loose items under one parent (the inverse of decompose)
claim     → take it atomically      (returns an epoch — keep it)
complete  → finish, with evidence   (epoch required)
release   → hand it back
constrain → a requirement on work that already exists (not a new task)
link      → blocked_by / duplicate / relates_to
unlink    → that dependency is not real (retracts; Plane cannot delete)
held      → what am I holding? (call after a restart)
history   → has this been attempted? (claims, expiries, how it ended)
```

There is no `heartbeat`. An item stays yours for as long as you are working on it:
the plugin's monitor holds the lease while your session lives, and if the item is
taken from you, you are told so in plain words. Clients running without the plugin
extend a lease over `POST /v1/heartbeat` instead.

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

## When a call refuses

Every refusal carries a code and a recovery line — follow it rather than working
around it. [`skills/work-tracking/troubleshooting.md`](skills/work-tracking/troubleshooting.md)
documents all fourteen. The ones people meet first:

| Symptom | Fix |
|---|---|
| `served a web page, not a gateway` | You pointed at Plane. Use the gateway host, usually `mcp.<your-plane-host>` |
| `! Needs authentication` | Not signed in yet. `claude mcp login sync`, or open `/mcp` in a session |
| `Plane rejected that personal token` | Wrong token type or expired. Create a new one under your Plane profile → Personal access tokens |
| `You are not a member of project …` | Add yourself to that project in Plane, then retry |
| `already belongs to a different Plane user` | Someone else has that agent name. Pick another |
| HTTP 429 from `/v1/agent-tokens` | Mint limit, by default 10/min per address. Wait a minute |
| `UNAUTHENTICATED` from a tool call | The agent token is wrong or was replaced. Mint a new one and re-run `claude mcp add` |
| **No sync tools at all, and nothing errored** | Installed but not connected — tools come from the gateway, rules and hooks from disk. Check the gateway address with `/sync-status`, then sign in with `/mcp`, or run `sync-connect` on a box with no browser. Restart either way. Nothing refuses in this state, so an agent will work with no lease unless it checks |
| `next` returns nothing | Call `why` on the item you expected. It reports the gate's own reasons — no description, blocked, leased, unfinished children, label, capability mismatch |

Anything that looks like the deployment itself is wrong — 502s, sign-in opening the
wrong host, a stale build — is in [`deploy/README.md`](deploy/README.md).

## Development

```bash
cd server && npm test          # lease semantics (20-way contention), readiness
                               # screening, tool policy, token ownership, evidence
                               # checking, and that the docs still name every tool
                               # that exists

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
