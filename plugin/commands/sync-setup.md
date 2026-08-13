---
description: Point this machine at a sync gateway and check it answers
allowed-tools: ["Bash", "AskUserQuestion"]
---

# Connect this machine to a sync gateway

The plugin ships no gateway address on purpose, so each installation names its
own. This sets `SYNC_MCP_URL`, which is where the plugin's server entry reads it.

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

Add `--project` if they want it for this repository only rather than the whole
machine. The script checks the address answers like a gateway before writing
anything, and merges into `settings.json` rather than replacing it.

If it reports the host answered "but not like a sync gateway", they have given
you Plane's own address. The gateway is a separate hostname.

If it says neither jq nor python3 is installed, it will have printed the two
lines to add by hand — pass those on rather than editing the file yourself.

### 3. Tell them to restart

Say this plainly, because it is the step people skip: **MCP servers are read once
at startup, so the tools will not appear in this session.** After restarting,
sign-in is offered on the first tool call.

Do not claim sync is working until they have restarted and can see the tools. If
they ask you to verify now, run `/sync-status` after the restart, not before.
