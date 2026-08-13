---
description: Point this machine at a sync gateway and check it answers
argument-hint: "<gateway-url>"
allowed-tools: ["Bash", "AskUserQuestion"]
---

# Connect this machine to a sync gateway

The plugin ships no gateway address on purpose, so each installation names its
own. Claude Code normally asks for it when the plugin is enabled and stores it as
a plugin option. This command sets the same option without the dialog — for
changing the address later, for repairing a wrong one, and for a machine being
provisioned by a script.

## Steps

### 1. Get the URL

If the user supplied one as an argument, use it. Otherwise ask them for it with
AskUserQuestion — it looks like `https://mcp.example.dev`, and is usually
`mcp.` in front of their Plane host. Someone on their team who already uses sync
has it; it is not a secret.

Do not guess a URL, and do not offer one you have seen in a transcript or another
repository. Pointing somebody at a stranger's gateway sends their work to a
tracker they do not own.

### 2. Write it

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sync-url" <url>
```

The script checks the address answers like a gateway before writing anything, and
merges into `settings.json` rather than replacing it. It stores the host and
strips a trailing `/mcp`, because the server entry adds `/mcp` itself — so a
pasted endpoint is normalised rather than turned into `/mcp/mcp`.

If it reports the host answered "but not like a sync gateway", they have given
you Plane's own address. The gateway is a separate hostname.

If it says neither jq nor python3 is installed, it will have printed the line to
add by hand — pass it on rather than editing the file yourself.

There is no per-repository scope. Claude Code ignores plugin options set in a
repository's settings, so writing one there would look like it worked and would
not; the script refuses `--project` rather than doing that quietly.

### 3. Tell them to restart

Say this plainly, because it is the step people skip: **MCP servers are read once
at startup, so the tools will not appear in this session.** After restarting,
sign-in is offered on the first tool call.

Do not claim sync is working until they have restarted and can see the tools. If
they ask you to verify now, run `/sync-status` after the restart, not before.
