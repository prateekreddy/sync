# sync

Track work in Plane with an atomic claim, so two agents never take the same task.

```
/plugin marketplace add <your-org>/sync
/plugin install sync
```

Sign-in happens in the browser on first use. Nothing secret lives in this plugin.

## Requirements

**`jq`.** Used by the hooks to read JSON.

```
brew install jq          # macOS
apt-get install -y jq    # Debian/Ubuntu
```

`node` or `python3` will do instead if either is already present — but do not rely
on that. If none of the three exists, the push fence and session tracking are
**off**, and the plugin says so once per session rather than pretending to work.
That is the whole reason the check exists: a guard nobody knows is disabled is
worse than no guard, because you push stale work believing something checked it.

## Pointing it at your own gateway

sync is self-hosted, so the bundled URL is a default rather than an address you
are stuck with. Set `SYNC_MCP_URL`:

```jsonc
// ~/.claude/settings.json — or .claude/settings.json to scope it to one repo
{ "env": { "SYNC_MCP_URL": "https://sync.your-company.internal/mcp" } }
```

That is enough on its own; the variable is read where the plugin's `.mcp.json`
declares the server, so there is nothing to edit inside the plugin and nothing to
re-do when it updates. Exporting it in your shell works too, but only for windows
launched from that shell, which is a confusing way to lose half your sessions.

## What it installs

| | |
|---|---|
| `.mcp.json` | the gateway — coordination tools plus Plane's own surface |
| `monitors/` | keeps your claim alive while you work, and tells you if it is taken away |
| `hooks/` | harvest the lease credential, report on resume, hand work back on exit, fence `git push` |
| `skills/` | the working rules |

## Why a monitor rather than a heartbeat

Keeping a claim alive used to be the agent's job: call `heartbeat` periodically or
lose it. That failed the way you would expect — an agent worked for an hour without
calling it, the lease lapsed, another agent took the item, and the two collided. An
obligation that comes due *later* is one a model eventually drops: it has no clock,
and it forgets its own history at every compaction.

So liveness is a process now, not a promise. It starts with your session and dies
with it, and it cannot be talked out of running.

It also covers the case no hook can see. Closing a laptop fires no event — the
session suspends rather than ending — so the monitor suspends and resumes with it,
and its first poll after a gap is what tells the gateway you are back. You get
either *"lease restored"* or *"someone else took this, stop"* — before you do more
work, rather than at the end of it.
