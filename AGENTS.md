# Agent instructions

Also read as `CLAUDE.md` by Claude Code. Kept deliberately short: this file is in
context for every request, so it carries rules, not documentation.

## Work tracking

Work lives in Plane, reached through the `sync` MCP server. Three rules:

1. **Write it down first.** The moment you notice anything worth doing — a bug, a
   missing test, a refactor, a question for a human — call `capture` *before*
   deciding whether to do it now. It deduplicates and is safe to call freely. An
   unwritten intention is lost the moment your context is.
2. **Claim before you work.** Never start non-trivial work on an item you have not
   claimed with `claim`. Assigning yourself in Plane reserves nothing: two agents
   doing it both believe they own the item and both proceed. Only `claim` is
   atomic. If it refuses, follow the error's recovery line rather than working
   around it.
3. **Finish explicitly.** End with `complete` — include the evidence, a PR link or
   commit and what you verified — or `release`. Going silent means the lease
   expires and someone redoes your work. Call `heartbeat` on long tasks.

After a restart, call `held` first to find out what you were in the middle of.

Never take work by editing assignees or state in Plane directly. The gateway
refuses it, and the reason it refuses is in `docs/architecture.md`.

To break a large item up, call `capture` once per child with `parentId` set to the
large item. A parent with unfinished children is deliberately unclaimable.

## How to build here

**Design from primitives.** A feature is a composition of primitives. Before
implementing, name the primitive: does it exist, is this a composition of ones
that do, or does a new one belong? Then build the primitive and let the feature
fall out of it.

**When the same decision is made in more than one place, a primitive is missing.**
A boolean flag, a duplicated response shape, a mapping repeated at three call
sites — each is the shadow of something that should exist once. Every design
defect found in this repo so far has been that: `verbose: boolean` where a
projection belonged, five read tools hand-building five shapes for one work item,
a label gate matching names against uuids because resolution lived nowhere.

**Prefer the shape that makes the bug impossible over the patch that fixes this
instance.** Resolving labels in one place beats remembering to resolve them in
five.

**Assume failures here are silent.** A gate that stops gating, a filter that
fails open, a projection that drops a field the caller needed — none of these
raise anything. Test the wiring, not just the predicate: this codebase has been
bitten twice by a pure function that was correct and a caller that starved it.

**Measure rather than assert**, and quote the number you can actually ship, not
the best case you probed. Then say where it was measured.

## Working on this repo

- `server/` is the gateway, `mcp/` the stdio bridge, `deploy/` the stack.
- `cd server && npm test` before proposing changes. The lease tests need Postgres;
  `deploy/docker-compose.yml` provides it.
- Changes to the tool surface must keep `server/test/proxy_e2e.py` passing. It is
  the check that Plane's own tools cannot be used to bypass the lease, which is
  the one invariant this project exists to hold.
- Plane is the system of record and is not modified. If something looks like it
  wants a new feature here, first ask whether Plane already does it.
