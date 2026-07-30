# Onboarding an agent

## The whole thing

```bash
claude mcp add --transport http sync https://<gateway-host>/mcp \
  --header "Authorization: Bearer sync_agent_..."
```

Nothing installed, nothing built, no project id, no Node version to match. The
token carries the project, and the gateway serves the tool catalogue — so this is
the last time you touch the agent box. New tools, reworded descriptions and Plane
upgrades all arrive on the next gateway deploy.

Two values are needed and neither is baked into anything:

| | Where it comes from |
|---|---|
| **Gateway URL** | your deployment. `https://mcp.<your-plane-host>/mcp` if you followed the naming, but it is only ever a flag or an env var |
| **Agent token** | `provision.sh` prints one per agent, or `issue-token` makes more |

`bin/onboard.sh` does the same thing with the endpoint checked first, which is
worth it: registering a broken server means debugging it from inside an agent
session, where the only symptom is a tool that isn't there.

```bash
bin/onboard.sh                                   # asks for what it needs
bin/onboard.sh --url … --token … -y              # non-interactive
```

Order of precedence for every value is flag → environment → prompt, so the same
script serves a person setting up a laptop and a provisioning system creating a
project.

## Issuing a token

```bash
docker compose exec gateway node dist/cli.js issue-token \
  --name worker-1 --principal human:you \
  --project <plane-project-uuid> \
  --plane-token <that agent's Plane API token>
```

`--project` binds the default project to the token. That is what removes project
configuration from the agent box, and it means re-pointing an agent at a different
project is a server-side change rather than a visit to every machine. An agent can
still name any project explicitly on any call; this is a default, not a fence.

`--plane-token` is what makes Plane's activity log say *worker-1 moved this to In
Progress* instead of attributing the whole fleet to one service account. Give the
agent **only** the `sync_agent_…` token that comes back — never the Plane token
behind it. A Plane Member key sets `assignees` directly, which bypasses the lease.

## Is the MCP server enough on its own?

For *capability*, yes. For *discipline*, no — and the distinction is the whole
reason this section exists.

Tool descriptions are read when the model is choosing among tools. That is the
wrong moment for the rule that matters most here:

> when you find anything you want to do now or later, write it to the platform
> first, then pick it

The point of that rule is to fire when the agent was **not** thinking about tools
at all — mid-way through editing a file, when it notices something unrelated. A
description sitting on the `capture` tool cannot reach that moment. Same for
"claim before you start": by the time the model is choosing a tool, it has usually
already decided what it is doing.

So the discipline needs a channel that is always in context. There are two, and
they are worth using together because neither is sufficient alone:

**1. The server's `instructions` (already shipped).** Sent in the MCP handshake,
so it costs nothing to maintain and reaches every agent from the gateway. Verified
present in the initialize response. The caveat is that surfacing it is up to the
client, and not every client does.

**2. A few lines in `CLAUDE.md` / `AGENTS.md` (you have to add).** Guaranteed in
context, per repo. This is the belt to the server's braces.

Keep it short. This file is in context for every request, so it is the most
expensive text in the project — it should carry rules, not documentation.

```markdown
## Work tracking

Work lives in Plane, reached through the `sync` MCP server. Three rules:

1. **Write it down first.** The moment you notice anything worth doing — a bug, a
   missing test, a refactor, a question — call `capture` before deciding whether
   to do it now. It deduplicates and is safe to call freely.
2. **Claim before you work.** Never start non-trivial work on an item you have not
   claimed with `claim`. Assigning yourself in Plane reserves nothing: two agents
   doing it both believe they own the item. Only `claim` is atomic.
3. **Finish explicitly.** End with `complete` (include evidence — a PR link, a
   commit, what you verified) or `release`. Going silent means the lease expires
   and someone redoes your work. `heartbeat` on long tasks.

After a restart, call `held` first to see what you were in the middle of.
Never edit assignees or state in Plane directly to take work.
```

## Does it need a skill?

No, and it is worth being clear about why, because a skill is the tempting answer.

Skills load on demand, when the model judges them relevant. That makes them right
for *occasional and procedural* work and wrong for *always-applicable rules*. A
skill holding "claim before you work" would be a rule that applies constantly but
is only read sometimes — strictly worse than the same words in `CLAUDE.md`, and
with an extra failure mode where the model doesn't think to load it.

The one thing that genuinely fits the skill shape is a **session-start routine**:
check `held`, then `next`, then claim and set up. That is procedural and happens
once per session. It is also three tool calls a human can just ask for, so it is a
convenience rather than a gap — worth adding when the routine grows, not before.

## Wiring this into project creation

For automating onboarding as part of creating a project, the pieces are:

1. **Create the Plane project** — `POST /api/v1/workspaces/<slug>/projects/`, or
   `deploy/plane_api.py`. Use the API rather than the ORM: it also creates the
   default workflow states the readiness gate depends on.
2. **Issue a token bound to it** — `issue-token --project <uuid>`. One token per
   agent identity, not one per project; re-issuing rebinds the default and keeps
   the Plane mapping.
3. **Register the server** — `bin/onboard.sh --url … --token … -y`, or write the
   config directly.

For a per-repo mapping, `--scope project` writes `.mcp.json`, which is committed —
so the token must be a **reference**, never a literal:

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

Each agent then supplies its own `SYNC_AGENT_TOKEN` from the environment, and the
repo commits the wiring without committing a credential.

Two honest caveats on that path, both verified by trying:

- Project-scoped servers need approving once per machine. The state lives in
  `~/.claude.json` under `projects.<path>.enabledMcpjsonServers`, not in
  `.claude/settings.json`.
- I could not get that pre-approval to take effect non-interactively —
  `claude mcp list` still reported *Pending approval*. So treat the automated
  project-scope path as unproven and use `--scope local` or `user` until someone
  confirms it. Local scope is verified working.

## Codex

`bin/onboard.sh --client codex` prints the config rather than editing your TOML,
because clobbering a hand-written config is worse than asking for a paste.

I could not verify Codex's HTTP MCP support from here — Codex isn't installed on
this machine. The script prints the HTTP form first and the stdio bridge second;
if your build rejects the HTTP form, the bridge in `mcp/` is the fallback and is
tested.

## Verifying it worked

```bash
claude mcp list           # sync: … (HTTP) - ✔ Connected
```

Then ask the agent to call `next`. If it returns candidates without you supplying
a project id, the token binding is working and onboarding is complete.
