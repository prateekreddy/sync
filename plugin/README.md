# sync

Track work in Plane with an atomic claim, so two agents never take the same task.

```
/plugin marketplace add prateekreddy/sync
/plugin install sync@sync
```

`sync@sync` is `<plugin>@<marketplace>`; both are called sync because the repo is
its own single-plugin marketplace. To pick up a new version later:

```
/plugin marketplace update sync
```

Sign-in happens in the browser on first use. Nothing secret lives in this plugin.

**Installing is not connecting.** Until somebody signs in, this box has the rules,
the hooks and the monitor — and no tools. See **On a box with no browser** below;
it is the one failure that does not announce itself.

**Already added the gateway by hand?** If you ran `claude mcp add --transport http sync …`
at some point, that entry wins and the plugin's is skipped with a note saying so —
you keep the tools, but not the OAuth sign-in. Remove it with `claude mcp remove sync`
and restart, or keep it and accept a long-lived token sitting in your config.

## On a box with no browser

A container, a CI runner, a machine someone else provisioned: there is no browser
to open, so the sign-in below cannot finish and the session comes up with no sync
tools at all.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/sync-connect --url https://<gateway-host> --agent worker-1
```

It asks for a Plane personal token, exchanges it for an agent token, writes the
server entry, and verifies it before it says it worked. `--help` lists every flag;
each one also reads from an environment variable, so a provisioning script can run
it with `-y` and no terminal. Restart the session afterwards — a client reads its
MCP servers at startup.

That entry replaces the plugin's rather than adding a header to it, and it has to:
**Claude Code turns OAuth fallback off the moment `headers.Authorization` is set**,
even when the value is empty. So a single server entry cannot offer both a token
and a browser sign-in, and the plugin's stays browser-only so that the common case
keeps working with nothing to configure.

**What it looks like when this has not been done**, because it does not look like
an error. Every other sync failure hands back a refusal with a recovery line. This
one hands back nothing — there is no `claim` to call, so nothing refuses, and an
agent that does not check works with no lease at all. On the first session on a
machine that has never held a claim, the plugin says so once, and stops saying it
the moment a claim succeeds.

## Signing in

There is no token to paste into any config. The first tool call gets a 401 whose
`WWW-Authenticate` header names the gateway's metadata; Claude Code reads it,
registers itself as a public OAuth client, and opens a browser.

The page it opens is served by the gateway itself, and asks for three things:

| | |
|---|---|
| **Plane personal token** | from Plane → your profile → Personal access tokens |
| **Agent name** | namespaced to you, so the name is yours alone |
| **Project** | a dropdown, filled from what that token can see — or blank to choose per call |

The token you hand over is what the gateway writes to Plane *as you*, so your
name appears on the board rather than a shared service account. What comes back
to Claude Code is a gateway token, not your Plane one, and it can be revoked on
its own without touching Plane.

## Requirements

**`jq`.** Used by the hooks and by `sync-connect` to read JSON.

```
brew install jq          # macOS
apt-get install -y jq    # Debian/Ubuntu
```

`node` or `python3` will do instead if either is already present — but do not rely
on that. If none of the three exists, the push fence and session tracking are
**off**, and the plugin says so once per session rather than pretending to work.
That is the whole reason the check exists: a guard nobody knows is disabled is
worse than no guard, because you push stale work believing something checked it.

Any *one* of the three is enough for everything here, and that is tested per
parser with the other two removed from `PATH` — a machine with jq and no python3
is an ordinary macOS box without the Xcode command line tools, not a corner case.
The single exception is `sync-connect --scope project` merging into a `.mcp.json`
that already exists, which asks for jq specifically and prints what to paste when
it is missing, rather than rewriting a committed file with `sed`.

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
| `bin/sync-connect` | connects a box that has no browser to sign in with |
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
