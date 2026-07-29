# Architecture

## Principle

Plane is the product. We build the smallest possible thing that Plane cannot do,
and nothing else. Every component below has to justify why it isn't a Plane feature.

## What Plane already gives us (do not rebuild)

| Need | Plane feature |
|---|---|
| Non-devs report things | **Intake** — built-in triage inbox with its own API |
| Boards, backlog, filters, search | Work items + views |
| Hierarchy, blockers, duplicates | Work item relations |
| Who is who, permissions | Workspace members + roles |
| Status model | States (backlog/unstarted/started/completed/cancelled) |
| Discussion, history, audit | Comments + activity log |
| Push notification of change | Webhooks |
| Storage, backup | Its own Postgres + `setup.sh backup` |

## The one thing Plane cannot do

**Atomic claim.** Verified against the running v1.3.1 source:

- No `If-Match`, ETag, or version precondition anywhere in the public API layer.
- `select_for_update` appears once in the whole codebase, in an unrelated view.
- `IssueAssignee.unique_together = [issue, assignee, deleted_at]` stops the *same*
  assignee being added twice; it does not stop two *different* agents both being
  assigned.

### Why client-side claim cannot work (measured, not argued)

The obvious way to avoid building anything: have each agent assign itself, read the
item back, and proceed only if it is the sole assignee — with a tie-break when it
isn't. We tested it against the running instance (`docs/race.py`, `docs/race2.py`).
It fails, and *how* it fails depends on timing:

| Arrival | Mechanism | Outcome |
|---|---|---|
| Simultaneous (inside the transaction window) | Soft-delete + `bulk_create` under READ COMMITTED write-skew: the writes **merge** | Every agent sees every other and backs off. **Livelock — nobody works.** |
| Staggered (the realistic case) | Each PATCH's `delete()` **wipes** the previous assignee | Every agent reads back `[me]` and proceeds. **All of them work the same item.** Plane records only the last writer, so the collision is invisible. |

The decisive property: **the read-back carries no information.** Observing `[me]`
is equally consistent with "I am the only claimant" and "I just erased two agents who
are already working." Nothing the client can compute distinguishes those.

A tie-break cannot repair it either — in the staggered case there is nothing to
tie-break against, because each agent legitimately sees only itself. And the runs
that appear to pass do so by accident: the winner is whoever clobbered *last*, so
the protocol rewards the latest writer rather than the first.

Mutual exclusion therefore has to be enforced somewhere with an atomic
test-and-set. That is one SQL statement in a database we control.

## Components

```
  non-devs ──▶ Plane Intake ─┐
  humans   ──▶ Plane Web UI ─┤
                             ├──▶  PLANE  ◀── REST ──┐
  GitHub ──webhook──▶ Gateway┘        │              │
                             ▲        │ webhook      │
  agents  ──── MCP ──▶  GATEWAY ◀─────┘              │
                             │                       │
                             └──▶ agent.lease ───────┘
                                  (Plane's Postgres,
                                   separate schema + role)
```

**Plane** — unchanged, self-hosted. System of record for everything.

**Gateway** — one small service, two jobs:
1. Mutual exclusion (claim / heartbeat / release / complete).
2. An agent-shaped surface: ~7 MCP tools instead of Plane's 30+, so an agent can
   decide in one turn without burning context on API shape.

**Storage** — Plane's existing Postgres. One extra schema (`agent`), owned by a
role granted only on that schema. No second database: two databases means two
backups that must restore to a consistent point, and Plane's own backup already
snapshots the whole pgdata directory, so our table rides along for free.

## The lease, in full

Not an engine. One table and one statement.

```sql
create schema agent;

create table agent.lease (
  work_item_id uuid primary key,     -- Plane work item id; no FK, we don't couple to their schema
  holder       text        not null, -- 'agent:sync-worker-3'
  holder_chain text[]      not null, -- ['human:prateek','agent:lead','agent:worker-3']
  epoch        bigint      not null, -- fencing token, monotonic, never reused
  expires_at   timestamptz not null,
  claimed_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
```

Claim is a single atomic statement — no transaction, no lock manager:

```sql
insert into agent.lease as l (work_item_id, holder, holder_chain, epoch, expires_at)
values ($1, $2, $3, 1, now() + $4)
on conflict (work_item_id) do update
   set holder = excluded.holder,
       holder_chain = excluded.holder_chain,
       epoch = l.epoch + 1,          -- monotonic across steals; never resets
       expires_at = excluded.expires_at,
       claimed_at = now(),
       heartbeat_at = now()
 where l.expires_at < now()          -- steal only if the previous holder went dark
returning epoch, expires_at;
```

Zero rows returned means someone live holds it. One row means the caller owns it.
Expiry is evaluated in the predicate, so **claimability never depends on a sweeper
having run** — the sweeper exists only to tidy Plane's UI, not for correctness.

### Why `epoch`

The failure naive locks miss: agent A's lease expires while it is paused or
partitioned, agent B reclaims and starts work, then A wakes up and writes its
results — overwriting B with output derived from stale context.

Every claim bumps `epoch`. Every later call (`heartbeat`, `release`, `complete`)
must present the epoch it was given. A stale epoch is rejected outright rather than
silently applied. It is one column and it closes the one failure mode that would be
genuinely expensive to debug in production.

## What we deliberately do NOT store

No projection of Plane work items in v1. `next` queries Plane's API directly for
ready candidates and attempts claims in priority order until one succeeds. Adding a
cache is the fix *if* rate limits bite — not before. Verified knob:
`API_KEY_RATE_LIMIT`, default `60/minute`, already raised to `600/minute` in our env.

## Readiness gate

Only *ready* items are claimable. An agent that claims an underspecified task burns
tokens and produces plausible garbage a human then reviews — so readiness is a gate,
not a hint. v1 evaluates it at query time from data Plane already has:

- state group is `unstarted` or `backlog`
- has a description (non-empty)
- no open `blocked_by` relation
- no `needs-human` / `needs-refinement` label
- no live lease

Refinement is itself a task type, so an agent can be pointed at making things ready.

## Agent surface (7 tools)

| Tool | Why it exists |
|---|---|
| `capture` | 2 required fields, idempotency key, dedups on write. The write-first primitive — if capture isn't trivial, the discipline dies. |
| `next` | Ready + unleased, capability-filtered. Read-only. |
| `claim` | Atomic. Takes a filter *or* an id — `next`-then-`claim` is a TOCTOU race, so claim-by-filter must be one call. |
| `heartbeat` | Extends TTL. Requires epoch. |
| `release` | Back to the pool, with a reason. Requires epoch. |
| `complete` | Terminal, with outcome + refs. Requires epoch. |
| `link` | Typed edge — `discovered_from`, `blocks`, `duplicate_of`. Maps to Plane relations. |

`link` is what makes this a memory substrate rather than a list: agent working A
finds problem B, `capture` + `link(discovered_from)` keeps the provenance that makes
B's context reconstructable later.

## Attribution: pass-through, not a parallel identity layer

Plane exposes no impersonation header (verified: nothing matching
`impersonat|on_behalf|act_as|sudo` anywhere in the API or auth layers), and
`APIKeyAuthentication` resolves the acting user directly from the token. So the
only way to make Plane's own activity log say "agent-3 did this" is to send the
write with agent-3's own Plane token.

Measured, end to end:

```
created   -> agent1's Plane user
state     -> agent1's Plane user      (claim)
state     -> agent1's Plane user      (complete)
created_by: agent1's Plane user
```

This reuses Plane's existing concepts — users, roles, activity log — rather than
building a second attribution system beside them.

### The constraint that shapes it

Pass-through needs the agent's Plane user to hold **Member** role, because Guest
cannot write. But an agent *holding* a Member token can set `assignee` directly
through Plane's MCP, which is precisely the bypass measured above: three agents,
one item, no trace.

So identity and possession are separated:

| | Holds | Can |
|---|---|---|
| **Gateway** | each agent's Plane Member token (encrypted) | write to Plane *as* that agent |
| **Agent** | a gateway token + a shared Guest Plane token | read anything, write only through the gateway |

The agent never receives its own Plane write credential. Attribution is native;
bypass remains impossible.

### A side benefit

Plane's rate limit is **per token** (`APIToken.allowed_rate_limit`). Under a single
service account the whole fleet shared one budget — the main operational risk in
this design. With pass-through, each agent carries its own, so budget scales with
fleet size.

### The cost, stated plainly

The gateway becomes a credential store. Agent tokens are stored as one-way hashes;
Plane tokens must be reversible to be replayed, so they are AES-256-GCM encrypted
with `GATEWAY_TOKEN_KEY`, which lives in the environment and never in a database.

The honest scope of that: the gateway and Plane databases share a Postgres instance
and are captured by a single `setup.sh backup`, and anyone holding the host already
has the workspace data those tokens grant. Encryption here protects **leaked backup
files**, not host compromise. Keeping the key out of the database is the part that
actually matters — which is also why the key must not be stored in Plane's own
database, tempting as the proximity makes it.

Do not reuse Plane's `SECRET_KEY` as this key: rotating Plane's secret would
silently render every stored agent token undecryptable.

Decryption failure degrades to the service account rather than taking the agent
offline — work continues, attributed less precisely.

## Settled

- **Agents close their own work**, humans audit afterwards (`ALLOW_AGENT_CLOSE`).
- **Expiry always comments** on the item, and after 3 expiries flags it for human
  attention — an item that repeatedly kills its agent is a signal, not noise.

## Still open

- No GitHub webhook, so `complete` records evidence but nothing verifies it.
  Machine-checked closing is what would make agent self-closing safe rather than
  trusted.
- No decay or curation of stale captures; dedup-on-write is the only hedge.
- The gateway serves work but does not dispatch it.
