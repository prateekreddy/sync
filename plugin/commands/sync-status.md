---
description: Is sync connected, which gateway, and what am I holding?
allowed-tools: ["Bash", "mcp__plugin_sync_sync__held", "mcp__plugin_sync_sync__board"]
---

# Is sync actually working?

Answer in this order and stop at the first thing that is wrong. The order matters:
each step is only meaningful if the one before it passed.

## 1. Is there an address at all?

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sync-url" --show
```

The address is a plugin option, not an environment variable, so read it through
this rather than echoing a variable — a check that looks in the wrong place
reports "not configured" on a machine that is working.

A non-zero exit is the whole answer — nothing else can work, and no tool call
will explain it, because with no server there are no tools to refuse you. Say so
and offer `/sync-setup`. Do not continue to step 2.

## 2. Does that gateway answer?

```bash
curl -sS -m 20 "$("${CLAUDE_PLUGIN_ROOT}/bin/sync-url" --show)/healthz"
```

Report:

- **no answer** — the gateway is down or the URL is wrong. This is theirs to
  fix, or their operator's; nothing local will help.
- **`schema.level`** present means it reached its database. A reply without it is
  a gateway that cannot see Postgres.
- **`build.sha`** is which commit it runs. `null` means it was built without the
  stamp, so it cannot say — report that as unknown rather than as current, and
  do not guess from the deploy date.

## 3. Do I have the tools?

Check whether `held` is callable. This is the distinction that matters most and
the one people get wrong:

- **tools present** — signed in, everything works.
- **tools absent, gateway healthy** — installed but not connected. Nothing will
  refuse you here, so an agent that does not check will work with no lease at
  all. Tell them to run `/mcp` and sign in, or `sync-connect` on a box with no
  browser, and to restart.

## 4. What am I holding?

Only if the tools are there. Call `held`. Report each item, how long it has been
held, and when the lease expires. If they hold nothing, say so plainly — an empty
answer here is a real answer, not a failure.

Offer `board` for where the project stands, but do not call it unless they ask:
it is a much larger reply and this command is meant to be quick.

## Reporting

Lead with the verdict in one line — connected, or the first thing that is broken.
Detail after. Someone runs this because something feels wrong, so burying the
answer under four headings is the wrong shape.
