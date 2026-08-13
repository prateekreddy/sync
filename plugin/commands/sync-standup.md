---
description: What is in flight, what landed, what is stuck
argument-hint: "[project] [since, e.g. yesterday or 3d]"
allowed-tools: ["mcp__plugin_sync_sync__find", "mcp__plugin_sync_sync__board", "mcp__plugin_sync_sync__why"]
---

# Standup

Where the work stands, in the shape a person wants it at the start of a day. The
model could assemble this from `find` and `board` unprompted; the point of the
command is that it comes out the same shape every time, so a change between two
mornings means the work changed rather than the summary did.

Default to the last 24 hours. If they gave a period, use it. If they named a
project, scope to it; otherwise use the default project.

## Gather

Four calls, in parallel — none depends on another:

1. **In flight** — `find(holder: "any")`. Who is holding what, and `expiresAt`.
2. **Landed** — `find(stateGroup: "completed")`, then keep rows whose `updatedAt`
   falls in the period.
3. **Stuck** — `find(labels: ["blocked"])` and `find(labels: ["needs-human"])`.
   The second is applied by the gateway itself, on structural review and after
   repeated expiry, so it is work that has already been escalated to a person.
4. **The rollup** — `board`, for totals per module and whether the project has
   any shape.

## The caveat that must not be dropped

`updatedAt` is **last modified, not finished**. An old item that was retitled this
morning looks like it landed this morning. So say "updated in the last day" rather
than "completed yesterday", and never present the landed list as a precise record
of what finished in the period. If someone needs that exactly, `history` on a
specific item is the truthful answer.

Do not fabricate a completion time to make the list read better.

## Report

Lead with the one sentence a standup exists to produce: what is in flight and
whether anything is stuck. Then:

- **In flight** — item, holder, how long held. Flag any lease expiring within the
  hour, and anything held far longer than its siblings: a task that keeps killing
  its agent is usually underspecified, and the gateway flags it after three
  expiries.
- **Landed** — readable id and title, one line each.
- **Stuck** — separate the two kinds, because they need different people.
  `blocked` is waiting on other work; `needs-human` is waiting on *them*. For
  anything that looks wrongly stuck, `why` gives the gate's own reasons rather
  than a guess.
- **Nothing to report** is a real answer. An empty standup means an empty day, not
  a broken command — say so in a line rather than padding it.

Keep it short enough to read standing up.
