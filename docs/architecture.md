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
  humans   ──▶ Plane Web UI ─┤──▶  PLANE  ◀── REST ──┐
                             │       │               │
  agents  ──── MCP ──▶  GATEWAY ─────┘               │
                             │                       │
                             ├──▶ agent.lease ───────┘
                             │    (Plane's Postgres,
                             │     separate schema + role)
                             │
                             └──▶ GitHub API   (on `complete`: does the
                                                cited artefact exist?)
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

### Labels are ids on the wire, names in the gate

Plane returns label **uuids** on a work item, never names, while everything that
reads a label's meaning — the blocking labels above, capability routing — is
written in human words. Resolving one to the other is therefore not a detail; skip
it and both features fail *silently and in opposite directions*: the blocking gate
matches nothing and lets flagged work through, while capability routing matches
nothing and starves a specialised agent of every item. That was the state of the
code until 2026-07-30, undetected because the gate's unit tests called the pure
predicate with a hand-built id→name map and never exercised the wiring that builds
one. The lesson generalises: a pure function tested in isolation says nothing about
the code that feeds it, and a filter that fails open and a filter that fails closed
look identical from the inside.

`readyCandidates` now resolves ids once per browse from a per-project cache, and
both consumers go through a single helper so they cannot drift apart again.

### A cost split is not a definition

The gate has two halves. `screen()` is everything one list call can decide.
`blocked_by` needs a request per item, because Plane's relations live behind their
own endpoint and carry ids without state.

That split was a cost decision, and it silently became a definition. The browse
path called `screen()` alone and reported the result as "what claim will accept",
so `find(ready: true)` listed items `claim` refused and `board` counted them ready
— on the reporting project, the items it failed open on were the irreversible
mainnet seeding steps (SYNC-65). Three callers remembered to add the second half;
the two that forgot were the two humans read.

The fix was not to add the missing call at those two sites. It was to notice the
cost argument had been wrong: *O(backlog)* assumed every item needs a lookup, when
an item the screen already withholds stays withheld whatever its relations say,
and a finished item is nobody's candidate. The bill is the size of the **ready
set** — precisely the set `claim` would have verified one at a time anyway. On a
34-item board that is around a dozen requests, run six at a time, and the answer
is then correct for every caller rather than three of them.

So `resolve` runs the blocker pass itself and exposes only the total. `screen()`
is documented as callable from nowhere else. `verifyClaimable` survives — `claim`
must re-read, since a browse may be minutes stale and it is the only check whose
being wrong costs an agent run — but it now calls the same `openBlockers` rather
than restating the rule.

Two smaller things worth keeping:

- **Agreement tests do not catch shared defects.** A suite existed specifically to
  assert `find`, `next`, `why` and `tree` agree about readiness. It passed
  throughout, because every fake Plane stubbed `relations` to return nothing: with
  no item ever blocked, the half and the whole are the same function. `board`'s
  count also matched `find`'s list — both were wrong by the same amount. Only
  comparing against the *authoritative* gate finds this, which is what
  `blockers.test.ts` does.
- **The cap is reported.** Beyond `BROWSE_BUDGET` ready items, `find` and `board`
  return `blockersUnchecked`. A cap that quietly stopped checking would read
  exactly like a clean pass — the same failure in a subtler form.

### A relation you cannot delete

`blocked_by` makes an item unclaimable, so a wrong one gates real work forever.
Plane offers no way to remove it. Measured at v1.3.1, the version we run, and
still true on `preview`:

```python
"workspaces/<slug>/projects/<project_id>/work-items/<issue_id>/relations/",
IssueRelationListCreateAPIEndpoint.as_view(http_method_names=["get", "post"])
```

Nor does re-linking the pair replace anything. Plane stores relations as
`(issue, related_issue, relation_type)` rows and bulk-creates with
`ignore_conflicts=True`, so a second type is a second **row** and the first keeps
gating. That made the reported failure worse than a missing feature: `link`
returned `ok: true`, and an agent correcting a mistake had every reason to believe
it had (SYNC-66).

The other two routes out are both closed. Plane's UI works, but an agent does not
have one — and "ask a human to click something" is the coordination problem this
gateway exists to remove. Plane's database would work, and reaching into it would
dissolve the boundary that currently makes it *impossible* for the gateway to read
Plane's tables even by accident.

So the gateway **retracts** rather than deletes. This is not a workaround for
lacking authority: the readiness gate is the gateway's own rule, the same one by
which a lease or a `needs-human` label withholds an item. Plane holds the
relation; the gateway decides what it means.

The honest cost is a divergence — Plane's UI still draws an edge that is no longer
enforced. Left implicit that is another silent failure, so it is made loud in
three places: `unlink` comments on the work item, the row records who decided and
why (`reason` is required, and deliberately not defaulted), and retractions are
reversible with `reinstate` while the row survives, because "who decided this
dependency was not real" is exactly what gets asked after work ships that should
have waited.

`link` was also made to stop lying. Its reply now separates `created`,
`alreadyLinked` and `conflicts`, and says plainly that a conflicting relation is
still in force and that `unlink` is what removes it.

## Agent surface (16 tools)

| Tool | Why it exists |
|---|---|
| `capture` | 2 required fields, idempotency key, dedups on write. The write-first primitive — if capture isn't trivial, the discipline dies. |
| `decompose` | N children in one call. A parent becomes claimable-as-a-plan at its *first* child, so a decomposition written one capture at a time is open to another agent while still half-specified. |
| `next` | Ready + unleased, capability-filtered. Read-only. |
| `find` | Filter within a project — label, priority, state group, module, parent, holder. Plane's list tools cannot filter at all, and `holder` is not Plane's to know. |
| `search` | Titles across every project the caller can see. The only tool that crosses project boundaries, so "is this already written down?" has an answer before a duplicate capture. |
| `board` | Per-module progress plus live leases, and `structure`: filed, parented, containers, depth, unplaced. Answers "does this board have any shape" — the question a flat inbox never prompts anyone to ask. |
| `claim` | Atomic. Takes a filter *or* an id — `next`-then-`claim` is a TOCTOU race, so claim-by-filter must be one call. |
| `heartbeat` | Extends TTL. Requires epoch. |
| `release` | Back to the pool, with a reason. Requires epoch. |
| `complete` | Terminal, with outcome + refs. Requires epoch. |
| `link` | Typed edge over Plane's own vocabulary — `blocking`, `blocked_by`, `duplicate`, `relates_to`. Plane accepts anything else and silently ignores it, so the set is fixed here rather than passed through. |
| `unlink` | Takes a `blocked_by` back. Plane's API cannot delete a relation at any version, so this retracts: the gate stops honouring the edge, Plane keeps drawing it, and a comment on the item says so. See "A relation you cannot delete". |
| `held` | What am I holding? The first call after a restart, so a resumed agent does not re-claim. |
| `why` | The gate's own reasons for withholding an item. The reasons were always computed and thrown away, which made "`next` returned nothing" unanswerable. |
| `tree` | The sub-tree with lease state. Plane holds the parent links and the gateway holds the leases, so only here can "what is left" mean "not done *and* not already being worked". |
| `history` | Claims, lapses, and how the last attempt ended. An item three agents timed out on is underspecified, and that is invisible on the item itself. |

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

### Print provenance only where Plane's byline runs out

Mirrored comments used to end with `for human:<email>` unconditionally. Once
self-service minting arrived that became noise on the majority of writes: an agent
minted through OAuth carries its *owner's* Plane token, so Plane's byline already
names the very person the line named again, two lines apart.

The rule is now that the note says only what Plane cannot: nothing when the author
Plane shows *is* the principal; `for <human>` when a provisioned agent account
writes on someone's behalf; `by <agent> — for <human>` when the write lands as the
shared service account and Plane's byline identifies neither.

Deciding this needs the email behind the agent's token, so it costs one
`/users/me/` call, cached per agent for the process — it cannot change without the
token being re-minted. When that lookup fails the note is printed: redundant
provenance is noise, but missing provenance destroys the only record of who a
machine write was made for, and only one of those is recoverable afterwards.

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
tools.

This section used to say that tool descriptions were too late for that, because
they are "read while choosing among tools". That was wrong, and worth correcting
rather than quietly rewriting: it confused when a model *attends* to a
description with when the description was *delivered*. Descriptions arrive as a
set, from `tools/list`, and a model cannot call a tool without having been told
it exists — so every description is in context before any choice is made. The
evidence is in this repo's own history. `capture`'s description told agents to
break work up one child at a time long after `decompose` existed, and that is
the form agents used. A channel that can push the fleet toward the wrong
behaviour is not one that arrives too late to push it toward the right one.

### What survives 2026-07-28

MCP revision `2026-07-28` removes the `initialize` handshake. `instructions`
survives on `DiscoverResult`, but `server/discover` is **optional** for clients
to call — so the channel this section was built on becomes best-effort. That is
a good reason to be precise about which channels are actually unconditional:

| Channel | Delivered when | Guaranteed? |
|---|---|---|
| Tool descriptions | with `tools/list`, before any call | **yes** — a tool that was never listed cannot be called |
| A refusal's message | at the moment the rule is violated | **yes**, and impossible to skip |
| A call's own result | after the call that created the obligation | **yes**, for the agent that made it |
| `instructions` | `initialize` today, `server/discover` after | no — the client chooses |
| `CLAUDE.md` / `AGENTS.md` | every request, in repos that adopt it | yes, but per-repo and not shippable by the gateway |
| A skill | when the model judges it relevant | no |

**So the rule lives on the call that creates the obligation.** Not as prose
somewhere central, but attached to the surface an agent is already looking at
when the rule applies:

| Rule | Carried by |
|---|---|
| write it down first | `capture` |
| claim before you work | `claim` |
| the lease expires; keep it alive | `claim`, `release` |
| finish explicitly | `heartbeat`, `complete` |
| resume before you re-claim | `held` |
| you cannot take work by writing `assignees` | the `NOT_HOLDER` refusal, which names `claim` as the fix |

This is why the surface survives a channel going optional: every load-bearing
rule was already on a channel that cannot be skipped, and `instructions` had
become a summary of rules stated properly elsewhere. Making that deliberate
rather than lucky is the decision — **nothing load-bearing may live only in
`instructions`**, which `server/test/docs.test.ts` now checks.

`instructions` stays. It is still delivered to clients that ask, it costs
nothing, and it is the one place that can say something belonging to no single
tool. It is orientation, never the sole carrier.

The two channels that remain, then:

1. **Tool descriptions**, shipped by the gateway, reaching every agent
   unconditionally, and versioned with the code they describe.
2. **A few lines in `CLAUDE.md` / `AGENTS.md`.** Per-repo and human-installed,
   so not a substitute — but for a repo that adopts it, the one channel that
   fires even before the agent has listed a single tool.

**The rules are not a skill.** Skills load on demand, when the model judges them
relevant — right for occasional procedural work, wrong for rules that always apply.
A skill holding "claim before you work" would be strictly worse than the same words
in `AGENTS.md`, with an extra failure mode where it is never loaded.

**A skill, for the surface the rules deliberately omit.** That argument bounds what
a skill must not hold; it does not leave nothing behind. Three rules fit in an
always-on channel precisely because they say nothing about the forty-seven Plane
tools behind them — when a cycle is the right container, what `transfer_cycle_issues`
is for, why a deduped capture can leave a decomposition one child short. That
material is large, wanted occasionally, and useless until an agent is already holding
an item, which is the exact shape a skill fits. `skills/work-tracking/` holds it,
derived from `toolspec.ts`, `errors.ts`, `readiness.ts` and `toolpolicy.ts` so it
moves when they do.

The division is the whole point: a channel that always fires carries only what must
always fire, and everything else is one load away. Putting the surface in
`AGENTS.md` would cost every request; putting the rules in the skill would cost the
requests that matter.

## Considered and rejected: moving to OpenProject

The lease exists because Plane has no atomic test-and-set. OpenProject does — it
enforces optimistic locking via `lockVersion`, and this was measured rather than
read: booting `openproject/openproject:16` and racing five concurrent PATCHes
carrying the same `lockVersion`, three rounds running, gave **exactly one 200 and
four 409 `UpdateConflict`** every time. It also filters properly (`assignee is
empty` returns just the unassigned items — literally the claim-loop query, where
Plane ignores the filter and returns everything) and supports field selection that
cut a listing 111x against our post-hoc 2.8x.

On OpenProject the lease would stop being load-bearing for mutual exclusion. What
would remain is smaller but real: TTL and expiry for agents that die mid-task,
since `lockVersion` gives conflict detection and not liveness, plus fencing, the
tool policy and attribution.

**Staying on Plane anyway, for now.** It is a migration of the system of record;
the Plane client, the mirror and the readiness gate are all written to Plane's
shapes; and OpenProject's UI is heavier and more waterfall-flavoured, which is
worse for the non-dev intake case Plane handles well. The lease works and is
tested. Revisit if concurrency, filtering or payload size start costing more than
the migration would.

Others surveyed July 2026 and why they lost: *It's a Plan* (AGPL, agent-native,
MCP built in — conceptually this project, but v0.1 and one developer); *Huly*
(no public REST API, a Node SDK over WebSocket); *Vikunja* (community MCP servers
only, no concurrency story); *GitLab* (official MCP, but gated behind Duo);
*Taiga, Redmine, Tuleap* (community MCP only, no locking).

## Evidence: asked at the moment it is claimed

`complete` takes free text, extracts citations from it, and used to throw them
away. So an agent could say "merged in #42" and close the item whether or not #42
existed. The whole coordination loop rests on completions being true, which made
this the largest functional gap in the system.

The first design was a GitHub webhook: receive `pull_request` events, match them
against stored claims, reconcile. It worked, and it was thrown away, because
`complete` **is** the notification. The agent is telling us, at that exact
moment, that the work is done and here is the artefact — so the gateway asks
GitHub then and there and answers in the response.

That deletion removed almost everything the feature had accumulated:

- **No inbound endpoint.** The receiver was the only unauthenticated write path
  in the system and the only thing that could transition an item with no agent
  involved. Its whole defence was one HMAC.
- **No normalisation.** A `match_key` existed solely so an agent's `3f7a891`
  could later meet GitHub's 40-character sha. With one source there is nothing to
  match, so there is nothing to normalise and nothing to get subtly wrong.
- **No free-text parsing.** Push hands you a pull request title and body you did
  not ask for, which is where `#42` (a GitHub issue, not ours), `UTF-8` (shaped
  exactly like a reference), and closed-without-merging all became hazards to
  design around. Asking a direct question raises none of them.
- **No sweep, no timers, no per-repository setup.**

### What is actually being asked

Not "was it merged eventually" — a pull request is usually still open when the
agent that opened it finishes, and whether a human merges it later is not the
agent's to control. That is reported `pending` and is not a failure.

The sharp question is **does the cited artefact exist at all**. A fabricated sha,
a pull request number never opened, a link to nothing: those make a completion
actively misleading, and every one of them is visible immediately.

### Never an accusation on thin evidence

Anything that could not be established is `unchecked`, never `absent`. A timeout,
a 5xx, a rate limit, an unconfigured gateway — and, importantly, a 404 without a
token, because a private repository answers a stranger exactly as a nonexistent
one does. Claiming an agent made something up because the gateway lacked
credentials would be a false accusation on real work.

For the same reason the check never throws: a lease must not fail to end because
a third party was slow.

### Two failures, deliberately kept apart

- `unverified` — the completion cited **nothing** checkable.
- `evidence-missing` — it cited something specific that GitHub says does not
  exist. Evidence of absence, not absence of evidence.

Collapsing them would lose the distinction that matters: the first is an agent
being terse, the second is an agent being wrong.

### What was given up

A merged pull request can no longer close an item nobody claimed. That case was
the webhook's strongest argument, and it sits in tension with this system's own
discipline — claim, then complete — so losing it costs less than the machinery it
required.

## Structure has to be a default, not a discipline

Measured on the production board, 2026-07-30: **35 work items, zero with a parent**,
25 of 35 in no module. Not "little structure" — none.

Nothing was missing. `capture` took `parentId`, `moduleId` and `discoveredFrom`;
`decompose` and `link` existed; `complete` did not check children, so decomposing
mid-work stranded nobody; `parent` was never lease-gated, so reparenting was
always allowed; and the work-tracking skill had a section instructing agents to do
all of it. Capability, tooling and instruction were all present and the result was
still zero.

The cause is that a flat item was free and every form of structure cost an extra
argument the agent had to remember while its context was full of the actual work.
An instruction that the author of the instruction does not follow is not an
instruction problem. **Defaults beat prose**, and anything that depends on an
agent choosing to be tidy will read as absent at scale.

So placement is derived rather than requested:

- **Provenance comes from the lease.** The gateway already knows what an agent
  holds; asking it to repeat that in `discoveredFrom` meant provenance was
  recorded only when someone remembered. Now a capture made while holding exactly
  one item links itself back to it.
- **References in a completion become edges.** "Superseded by SYNC-32" was already
  being parsed out of the outcome text by `findEvidence` and discarded one line
  later. The information was never missing, only unreachable.
- **The module is inherited** from the parent, or failing that from the discovery
  source. This reverses an earlier decision, and the reversal is the point: the
  original argument was that a rollup which quietly includes things is worse than
  one that visibly misses them, and six days later "visibly misses" meant 25 of 35
  items in no module at all. The caution bought nothing and cost the rollup.

Both refuse to guess rather than guessing well. Holding two items infers no
provenance; a bare `#42` is never read as a work item. A wrong edge is permanent
and, to anyone reading the graph later, indistinguishable from a real one — which
makes it strictly worse than a missing one. The rule that falls out: **cheap
detection may guess, durable structure may not.** `evidence.ts` reads `#42` as a
citation because a false positive there costs nothing; `references.ts` refuses to,
because the board already contains "Merge PR #1 (work-tracking skill)", where `#1`
is a GitHub pull request and SYNC-1 is an unrelated redeploy.

### The cost of a lookup Plane does not offer

A work item payload carries no module field, and `?expand=modules` is ignored —
membership is readable only from the module side. So "which module is this item
in" costs one request per module, cached per project.

That cache is the whole design. Two things it has to get right, both found by
measurement rather than reasoning:

- **A successful write patches it.** Without that the common chain breaks: capture
  A into a module, then capture B while holding A, and B fails to inherit because
  the map predates A. Shortening the TTL would narrow that window, not close it.
- **A failed build is cached too**, briefly. A `decompose` of ten children against
  an unreachable module endpoint otherwise retries the full backoff ladder ten
  times. Caught when the test suite went from 8 seconds to 24.

And the lookup is bounded by a deadline at the *caller*, not inside itself,
because the latency budget belongs to `capture` — which must stay trivial or the
write-first discipline dies — rather than to the lookup.

### What Plane cannot express

Its relation vocabulary is `blocking`, `blocked_by`, `duplicate`, `relates_to` and
four scheduling types. There is no *supersedes* and no *caused by*, so "X replaced
Y" flattens to "X relates to Y". The edge keeps the pair navigable and the
completion text beside it keeps the meaning; the causality is not queryable. And
modules do not nest — `parent` is silently dropped — so the epic layer is exactly
one level deep, with the work-item parent chain below it.

## Settled

- **Agents close their own work**, humans audit afterwards (`ALLOW_AGENT_CLOSE`).
- **Expiry always comments** on the item, and after 3 expiries flags it for human
  attention — an item that repeatedly kills its agent is a signal, not noise.

## Still open

- No decay or curation of stale captures; dedup-on-write is the only hedge.
- The gateway serves work but does not dispatch it.
