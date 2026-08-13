# Onboarding an agent

## The short way

```bash
claude mcp add --transport http sync https://<gateway-host>/mcp
claude mcp login sync
```

No token on the command line. `login` opens a browser, you paste a Plane personal
token once, pick the agent name and project, and Claude Code stores the result in
your system keychain. `/mcp` inside a session does the same thing.

You need a Plane personal token to complete the sign-in: **Plane → your avatar →
Settings → Personal access tokens → Add token.** Any role works.

If you skip `login`, Claude Code shows the server as `! Needs authentication` and
offers the flow when you next open `/mcp`.

**Headless agents cannot do this.** `claude -p` and Agent SDK runs have no browser,
so either run `claude mcp login` once on that machine first, or use the token flow
below.

### Or install the plugin

```
/plugin marketplace add prateekreddy/sync
/plugin install sync@sync
```

Same server, plus the working rules, the session hooks and the liveness monitor.
Sign-in is the same browser flow, offered on the first tool call.

**The plugin ships no gateway address**, so Claude Code asks for one as it enables
the plugin. sync is self-hosted and this repo is public, so a URL baked into the
plugin would point every installation at whichever deployment happened to publish
it. Give it the host, `https://<gateway-host>`, and leave off the `/mcp` — the
server entry adds that, and an address carrying it already resolves to `/mcp/mcp`.
Unconfigured, the server cannot connect and the symptom is the one described next:
tools missing, rather than an error naming what is wrong.

**Installing is not connecting**, and this is the one failure mode worth learning
before you hand the plugin to anyone. The rules, hooks and monitor come from disk;
every *tool* comes from the gateway over an authenticated connection. On a box
where nobody has signed in you get all of the former and none of the latter — and
because there is no `claim` tool to call, nothing refuses, so an agent works with
no lease at all. Every other fault in this document announces itself. This one is
an absence.

Two things bound it. The plugin says so once, on the first session on a machine
that has never held a claim, and stops once a claim succeeds; and the playbook
tells the agent to check for `claim` before it starts and to stop if it is not
there. On a box with nobody to run `/mcp`, connect it without a browser:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/sync-connect --url https://<gateway-host> --agent worker-1
```

That is the same script as `bin/onboard.sh` below, shipped inside the plugin
because a box that installed the plugin has no clone of this repository.

## The token way

Use this for headless boxes, CI, and provisioning scripts.

### 1. Get the project uuid

Open (or create) the project in Plane. The uuid is in the URL:

```
https://<plane-host>/<workspace>/projects/<project-uuid>/issues
```

### 2. Create a personal token in Plane

Your avatar → **Settings** → **Personal access tokens** → **Add token**.

Copy the `plane_api_…` value — Plane shows it once.

### 3. Exchange it for an agent token

```bash
curl -sS -X POST https://<gateway-host>/v1/agent-tokens \
  -H "Authorization: Bearer plane_api_..." \
  -H 'Content-Type: application/json' \
  -d '{"agent":"worker-1","projectId":"<project-uuid>"}'
```

You get back a `sync_agent_…` token and the exact command for step 4.

Options in the body:

| Field | |
|---|---|
| `agent` | required. What to call this agent. Namespaced to you, so `worker-1` is yours alone |
| `projectId` | the project the agent works in by default. Omit it and the agent must name a project on every call |
| `capabilities` | optional list of labels this agent may pick up. Empty means anything ready |

### 4. Register it with your agent

```bash
claude mcp add --transport http sync https://<gateway-host>/mcp \
  --header "Authorization: Bearer sync_agent_..."
```

Nothing to install or build, and no project id on the agent box. New tools and
Plane upgrades arrive on the next gateway deploy without touching this machine.

### Or run one script for steps 3 and 4

```bash
bin/onboard.sh                                          # asks for what it needs
bin/onboard.sh --url … --plane-token … --agent worker-1 --project … -y
```

It checks the gateway answers before registering anything, so a wrong URL or a
rejected token fails here rather than inside an agent session. Every value comes
from a flag, then an environment variable, then a prompt. `--client codex` prints
Codex config instead of registering.

The script itself lives at `plugin/bin/sync-connect` and `bin/onboard.sh` forwards
to it, so a machine with only the plugin installed can run the same flow:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/sync-connect --help
```

One copy rather than two, because two onboarding scripts drift and the drift shows
up as a box that will not connect.

## Listing the agents you own

```bash
curl -sS https://<gateway-host>/v1/agent-tokens \
  -H "Authorization: Bearer plane_api_..."
```

Names, capabilities, project binding, whether each still writes to Plane as
itself, and when it was last seen. **Revoked agents stay in the list, marked
inactive** — "did my revoke work?" is the first question after revoking, and an
answer by omission cannot be told apart from a lost row.

The token is never returned. It is shown once at issue time and stored only as a
hash, so an endpoint that could hand it back would quietly undo that; to recover
a lost token, mint the same name again.

Scoped to *your* Plane user, which means agents issued from the CLI without
`--plane-token` have no recorded owner and appear here for nobody. That is not a
gap to route around: they belong to whoever has a shell on the gateway host, and
`node dist/cli.js list-tokens` shows an operator all of them. Widening this
endpoint would mean showing one person another person's agents. The reply says so
in a `note` rather than leaving an empty list to be read as "you own nothing".

## Revoking an agent

```bash
curl -sS -X DELETE https://<gateway-host>/v1/agent-tokens/worker-1 \
  -H "Authorization: Bearer plane_api_..."
```

The token stops working immediately; an agent still using it gets
`UNAUTHENTICATED` on its next call. You can only revoke agents you own. Give the
bare name (`worker-1`) or the full one (`you/worker-1`) — both work.

To bring the agent back, mint the same name again. It gets a fresh token and
keeps its project binding.

**`claude mcp logout sync` and "Clear authentication" in `/mcp` are not this.**
They delete the stored credential from that machine only; the token stays valid
everywhere else. Use them to sign out, and the call above when a token may have
leaked or a machine is gone.

A client that supports OAuth revocation can do both at once — the gateway
advertises `revocation_endpoint` (RFC 7009), and a token presented there is
retired server-side:

```bash
curl -sS -X POST https://<gateway-host>/oauth/revoke \
  -H 'Content-Type: application/json' -d '{"token":"sync_agent_..."}'
```

That endpoint always answers 200, including for a token that never existed, so it
cannot be used to test whether one is live. Whether `claude mcp logout` calls it
is up to the client and is not verified here — use the `DELETE` above when you
need to be certain.

`MINT_TOKENS=off` turns off the whole self-service surface — `GET`, `POST` and
`DELETE` together, since an operator who disables minting expects the endpoint
gone rather than two thirds of it. `issue-token`, `list-tokens` and
`revoke-token` stay on the CLI.

## Rules

- **Give the agent only the `sync_agent_…` token.** Never give it your Plane
  token. A Plane token can set `assignees` directly, which bypasses the lease and
  puts two agents on one item.
- **Re-running step 3 with the same agent name replaces that agent's token.** The
  old one stops working immediately.
- **Use a long-lived Plane token.** If it expires or you revoke it, the agent
  keeps working but its Plane writes stop being attributed to you.
- The mint endpoint allows 10 requests a minute per source address.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `served a web page, not a gateway` | Pointed at Plane, not the gateway | Use the gateway host, usually `mcp.<your-plane-host>` |
| `! Needs authentication` | Registered without a token and not signed in yet | `claude mcp login sync`, or open `/mcp` in a session |
| Sign-in opens a URL on the wrong host, or hangs | The gateway does not know its public address | Set `GATEWAY_PUBLIC_URL` in `deploy/.env` to the URL agents use, and restart the gateway |
| `stdin isn't a terminal, so authentication can't be completed` | Ran `claude mcp login` non-interactively | Run it in a real terminal, or use the token flow |
| `Incompatible auth server: does not support dynamic client registration` | Reached something that is not this gateway | Check the URL; `curl <gateway>/.well-known/oauth-authorization-server` should return JSON |
| Sign-in succeeds, connection still fails | An `Authorization` header is also configured, and it wins over OAuth | `claude mcp remove sync` and re-add without `--header` |
| `Plane rejected that personal token` | Sent a `sync_agent_…` token, or the Plane token expired | Create a fresh token under Plane profile → Personal access tokens |
| `You are not a member of project …` | You cannot see that project | Add yourself to it in Plane, then retry. The reply lists the projects you can see |
| `already belongs to a different Plane user` | Someone else has that agent name | Pick another name |
| You cannot remember what an agent was called, so you cannot revoke it | Nothing wrong — names are yours to choose and easy to lose | `GET /v1/agent-tokens` with your Plane token lists every agent you own, active or not |
| HTTP 429 | 10 mints/minute per address | Wait a minute |
| `refusing to send a token unencrypted` | Gateway URL is `http://` on a remote host | Use `https://`, or a localhost address |
| `claude mcp list` shows `✘ Failed to connect` | Wrong URL, or the gateway is down | `curl https://<gateway-host>/healthz` should return `{"ok":true,…}` |
| A tool is missing, or behaves like an older version | The host is running an older build than you think | `curl https://<gateway-host>/healthz` reports `build.sha` — compare it with `git rev-parse HEAD`. `schema.level` is the highest migration that host's database has had |
| **No `capture`/`claim` tools, and no error anywhere** | The plugin is installed and nobody has signed in. Nothing refuses in this state, so an agent will work with no lease unless it checks | `/mcp` in the session, or `${CLAUDE_PLUGIN_ROOT}/bin/sync-connect` where there is no browser. Restart either way |
| Connects, but the agent has no `capture`/`claim` tools | Registered against the wrong server name, or an old stdio config is shadowing it | `claude mcp remove sync` then re-add |
| `UNAUTHENTICATED` on every tool call | Token revoked, or replaced by a later mint with the same agent name | Mint again and re-run `claude mcp add` |
| `next` returns nothing | Nothing is ready | Call `why` on the item you expected to see. It answers with the reasons the gate itself used, rather than leaving you to guess |
| Tools work but Plane writes 403 | The Plane user is not a member of that project | Add them to the project in Plane |
| Plane's activity log says "service account" | The Plane token you minted with expired or was revoked | Mint again with a current token |
| `Pending approval` after `--scope project` | Project-scoped servers need a one-time approval | Approve the prompt in Claude Code, or use `--scope local` |

## What the agent token can and cannot do

It is your access, reduced:

| | Your Plane token | The agent token |
|---|---|---|
| Reach in Plane | everything your role allows | same, minus the below |
| Set `assignees` / `state` | yes | only while holding that item's lease |
| Delete states, labels, cycles | yes | no |
| Call Plane directly | yes | no — it only works against the gateway |

## Add the rules to CLAUDE.md / AGENTS.md

The gateway sends the working rules to the agent when it connects, but not every
client surfaces that. Put this in the repo so it is always in context:

```markdown
## Work tracking

Work lives in Plane, reached through the `sync` MCP server. Three rules:

1. **Write it down first.** The moment you notice anything worth doing — a bug, a
   missing test, a refactor, a question — call `capture` before deciding whether
   to do it now. It deduplicates and is safe to call freely. This applies to a
   bug someone just pointed out to you: being discussed is not being tracked.
2. **Claim before you work.** Never start non-trivial work on an item you have not
   claimed with `claim`. Assigning yourself in Plane reserves nothing: two agents
   doing it both believe they own the item. Only `claim` is atomic.
3. **Finish explicitly.** End with `complete` (include evidence — a PR link, a
   commit, what you verified) or `release`. Going silent means the lease expires
   and someone redoes your work. An item stays yours while you work, however
   long that takes — there is nothing to call to keep it.

After a restart, call `held` first to see what you were in the middle of.
Never edit assignees or state in Plane directly to take work.
```

Keep it short — it is in context for every request.

**No skill for the rules.** They apply to every request, and a skill loads only
when the model decides it is relevant — which, for "claim before you work", is
after the decision it was meant to change.

## Add the skill for everything else

The rules are three lines because they have to be. What they leave out is the rest
of the surface: sixty-two tools, and which one answers which question. That does
belong in a skill — it is reference, wanted occasionally, and far too long to sit
in context for every request.

```bash
mkdir -p ~/.claude/skills                       # or <project>/.claude/skills
cp -r skills/work-tracking ~/.claude/skills/
```

`skills/work-tracking/SKILL.md` covers the claim loop and its failure modes, what
the readiness gate withholds, which of `next` / `find` / `search` / `board`
answers which question, how capture's dedup interacts with decomposition, and what
cycles, modules, labels, worklogs and comments are for once an agent holds an
item. Codex has no skill mechanism — the file is plain Markdown, so point
it at the path instead.

## Issuing a token from the server

For provisioning scripts that already have a shell on the gateway host:

```bash
docker compose exec gateway node dist/cli.js issue-token \
  --name worker-1 --principal human:you \
  --project <plane-project-uuid> \
  --plane-token <that agent's Plane API token>
```

This does not namespace the name and will rotate any existing agent with that
name. Set `MINT_TOKENS=off` in the gateway's environment to make this the only
way tokens are issued.

## Wiring this into project creation

All three steps are HTTP, so this runs from anywhere:

1. **Create the project** — `POST /api/v1/workspaces/<slug>/projects/`, or
   `deploy/plane_api.py`. Use the API, not the ORM: it also creates the default
   workflow states the readiness gate needs.
2. **Mint a token bound to it** — `POST /v1/agent-tokens` with the user's own
   Plane token. One token per agent identity, not one per project.
3. **Register the server** — `bin/onboard.sh --url … --plane-token … -y`.

Mint with the user's own Plane token so their agents appear in Plane's activity
log as theirs rather than as a shared robot.

For a per-repo mapping, `--scope project` writes `.mcp.json`, which is committed —
so the token must be a reference, never a literal:

```json
{
  "mcpServers": {
    "sync": {
      "type": "http",
      "url": "${SYNC_GATEWAY_URL:-https://your-gateway/mcp}",
      "headers": { "Authorization": "Bearer ${SYNC_AGENT_TOKEN}" }
    }
  }
}
```

Each agent supplies its own `SYNC_AGENT_TOKEN` from the environment.

Project-scoped servers need approving once per machine, and the approval state
lives in `~/.claude.json` under `projects.<path>.enabledMcpjsonServers`. Setting
it non-interactively did not take effect in testing, so use `--scope local` or
`user` unless you are prepared to approve the prompt by hand.

## Codex

`bin/onboard.sh --client codex` prints the config rather than editing your TOML.

Codex's HTTP MCP support is untested here. The script prints the HTTP form first;
if your build rejects it, use the stdio bridge in `mcp/`, which is tested.

## Verifying it worked

```bash
claude mcp list           # sync: … (HTTP) - ✔ Connected
```

Then ask the agent to call `next`. If it returns candidates without you supplying
a project id, the token binding is working.
