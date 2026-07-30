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

## Why provisioning touches Plane's ORM at all

Plane has no supported way to create the first user, the first workspace, or an API
token without a browser session — an API token is the only credential `/api/v1/`
accepts, and minting one needs a session you cannot get headlessly. So
`provision.py` uses Plane's ORM for exactly those things and stops there. The
project is created through the public API instead, because that endpoint also
creates Plane's default workflow states, and the readiness gate reads state
*groups* to decide what is claimable.

It also marks the instance set up. Plane pins every route to its setup wizard until
`Instance.is_setup_done` is true, and that wizard exists to create the first
instance admin — which provisioning has just created. Registering the admin without
flipping the flag yields an instance that is fully provisioned and impossible to
sign into: the only reachable page is a wizard that can no longer complete. The api
caches the flag, so `provision.sh` restarts that container on the run which flips it.

`provision.sh` resolves service addresses from Docker rather than assuming
`http://localhost:$LISTEN_HTTP_PORT`. That variable says what Compose was *asked* to
publish, which is not what is reachable — and behind an external reverse proxy the
right deployment gives Plane's own proxy no host binding at all. Assuming the port
there means `:80` is the *other* proxy: if it 404s the readiness poll burns ten
minutes and blames Plane, and if it answers 200 on `/api/instances/` provisioning
proceeds against a server that is not this one.

## Who issues agent tokens

Tokens were originally issued only by a CLI inside the gateway container. That
makes onboarding an admin bottleneck: one person with a shell has to run a command
for every agent anyone wants to run, and people without server access cannot
onboard at all. It also blocks automated project creation, which has to mint over
the network.

So the authority is Plane's, not the gateway's. `POST /v1/agent-tokens` takes the
caller's own **Plane personal token** and returns an agent token scoped to them.

**Why no admin gate.** Plane's token endpoint (`plane/app/views/api.py`) carries
no permission class and sets `user=request.user`, so any member at any role can
create a personal token from the UI, reaching exactly what its owner reaches. The
exchange then only ever *reduces* privilege:

| | Presented Plane token | Returned agent token |
|---|---|---|
| Reach in Plane | everything that role allows | same, minus the below |
| Set `assignees` / `state` | yes | only while holding that item's lease |
| Delete states, labels, cycles | yes | needs the `destructive` capability |
| Call Plane directly | yes | no — not a Plane credential |

Nobody gains anything by calling the endpoint that they could not already do by
hand with the token they presented. An admin-only gate would have added a
bottleneck without adding safety — and it would have been wrong on its own terms,
since an admin cannot sensibly mint on behalf of every user.

**Why names are namespaced by owner.** `issueToken` upserts on `name`, which is
right for an operator at a shell and wrong once anyone can mint: asking for a name
someone else already uses would rotate their token, logging their agent out and
taking its identity in Plane's activity log. Storing `owner/agent` makes the
collision impossible rather than merely detected. A second guard applies the
ownership check inside the `ON CONFLICT DO UPDATE` predicate rather than as a
prior `SELECT`, so two concurrent mints cannot both pass and then race.

**Rate limiting.** The endpoint takes no gateway credential and calls Plane twice
per request, so it is limited per source address (`MINT_RATE_LIMIT`, default
10/min): unthrottled, a stranger could burn the workspace's rate-limit budget and
take the whole fleet down. The limiter is in-memory and therefore per-process —
with more than one replica the effective limit multiplies, the same caveat mirror
ordering carries.

`MINT_TOKENS=off` disables the endpoint and returns issuance to the CLI alone.

### Why the gateway is also an OAuth authorization server

`POST /v1/agent-tokens` still puts a bearer token on a command line, where it
lands in shell history and in `~/.claude.json` in plaintext. Claude Code supports
OAuth for HTTP MCP servers, which removes that entirely: the credential goes to
the OS keychain and the install command carries no secret.

The gateway has to be the authorization server itself. Plane is an OAuth *client*
for social sign-in and exposes no authorize or token endpoint, so there is nothing
to delegate to.

Shape:

- **Discovery** — RFC 9728 `/.well-known/oauth-protected-resource` and RFC 8414
  `/.well-known/oauth-authorization-server`. A `WWW-Authenticate` header on every
  401 names the first, which is what makes an unauthenticated `claude mcp add`
  turn into an offer to sign in rather than a failure to diagnose.
- **Registration** — RFC 7591, open. A `client_id` is not a credential and grants
  nothing on its own; every code still requires a human to complete the browser
  flow and prove they hold a Plane token.
- **Public clients with PKCE S256 only.** `plain` is not offered: it protects
  nothing against an attacker who can see the authorization request.
- **The access token is an ordinary agent token**, so `authenticate`, the tool
  policy and revocation are unchanged and there is no second credential type.
- **No refresh token and no expiry**, because agent tokens live until revoked. An
  `expires_in` would promise a rotation that does not happen.

The consent screen asks for a Plane personal token rather than a Plane password.
Handling passwords would put the gateway in the credential-interception business
for no gain, and the token path is the one the CLI and the mint endpoint already
use.

Codes are single-use, live 60 seconds, and are held in memory rather than
Postgres — a restart inside that window costs one retry of a flow the user is
watching, and a leaked backup then contains no live codes. Registered clients
*are* persisted: Claude Code stores its `client_id` and reuses it, so a gateway
that forgot would reject a client that can never re-register under that id.

`GATEWAY_PUBLIC_URL` exists because the issuer must be stable and must match what
the client was told. Behind a proxy that rewrites Host it cannot be inferred, and
the scheme falls back to the one the request arrived on rather than to `https` —
advertising `https` to a gateway reached over HTTP sends the client to a port
nothing is listening on.

### Revocation has to be self-service too

Self-service minting with CLI-only revocation is asymmetric in the dangerous
direction: anyone can create an agent and nobody can retire one without a shell
on the gateway host — so the person best placed to notice a leaked token is the
one who cannot act on it.

Two paths, because they answer different questions:

- **`DELETE /v1/agent-tokens/<agent>`**, authenticated by the owner's Plane token.
  Works from anywhere, for tokens issued by either route, and covers the case the
  client cannot: a machine you no longer have.
- **`POST /oauth/revoke`** (RFC 7009), authenticated by presenting the token
  itself. Advertised in the metadata so a client that revokes on logout makes
  "Clear authentication" mean the token stops working everywhere rather than
  merely disappearing from one keychain.

Presenting a credential is sufficient authorisation to retire it: whoever holds
it can already use it, so revoking removes capability rather than granting any.
Revocation by *name* needs the ownership predicate for the opposite reason —
without it, anyone could disable anyone else's agents, a denial of service that
requires no credential of the victim's.

The by-name path tries the caller-qualified form first and then the bare one, so
CLI-issued tokens — which are not namespaced — remain revocable. Both attempts
are ownership-checked, so the fallback widens what you can *name*, never whose
agents you can touch.

`revoke` answers 200 for an unknown token, as the RFC requires: an endpoint that
distinguished them would be an oracle for testing whether a stolen token is live.

Headless runs cannot complete a browser flow, so the `Authorization` header path
remains supported rather than deprecated. Claude Code treats a configured header
as authoritative and will not fall back to OAuth if it is rejected, so the two are
alternatives rather than a chain.

## Onboarding channels: MCP, repo file, or skill

The discipline that matters most — *write it down the moment you notice it,
claim before you work* — has to fire when the agent was **not** thinking about
tools. Tool descriptions are read while choosing among tools, which is too late:
by then the model has already decided what it is doing.

So it ships on two always-on channels, because neither is sufficient alone:

1. **The MCP server's `instructions`**, sent in the handshake. Costs nothing to
   maintain and reaches every agent from the gateway. Surfacing it is the client's
   choice, and not every client does.
2. **A few lines in `CLAUDE.md` / `AGENTS.md`.** The only channel guaranteed to be
   in context.

**Not a skill.** Skills load on demand, when the model judges them relevant — right
for occasional procedural work, wrong for rules that always apply. A skill holding
"claim before you work" would be strictly worse than the same words in `AGENTS.md`,
with an extra failure mode where it is never loaded. The one thing that fits the
skill shape is a session-start routine (`held` → `next` → claim), which is three
tool calls a human can just ask for.

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
