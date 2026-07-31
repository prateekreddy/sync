---
name: work-tracking
description: The playbook for tracking work in Plane through the `sync` MCP server — capture/claim/heartbeat/complete, plus Plane's own surface (cycles, modules, labels, states, comments, worklogs, sub-items, relations). Use when starting, resuming, organising or finishing tracked work; when deciding what to do next; when you notice something worth doing; or when a `sync` tool refuses a call.
user-invocable: true
---

# Working through the tracker

Two halves live on one MCP server. Do not confuse them:

- **Coordination tools** — 15 of them — exist because Plane has no equivalent. They are the only
  safe way to take work.

  | | Answers |
  |---|---|
  | `capture` `decompose` | write it down; break it up in one call |
  | `next` `find` `search` `board` | what is there — ready, filtered, workspace-wide, rolled up |
  | `why` `tree` `history` | why not this one; what is under it; has it been tried before |
  | `claim` `heartbeat` `complete` `release` | the loop |
  | `link` `held` | typed edges; what am I holding |

- **Plane's own tools** — currently 47 — are a faithful wrapper over Plane's API and have **no
  notion of a lease**. Everything below the coordination loop is theirs.

Both halves are served *by the gateway*, not by anything installed here, so the catalogue grows on a
gateway deploy with nothing to reinstall. Treat the tool list you were handed as authoritative rather
than this document: if a name here is missing, it moved upstream. Where the two halves collide on a
name, the coordination tool wins and Plane's is dropped — nothing can shadow `claim`.

You almost never need to pass a project id: the gateway fills `projectId` / `project_id` from your
token's binding. Pass one explicitly only when working outside your default project.

## The loop

```
held  →  claim  →  …work…  →  heartbeat every ~TTL/3  →  complete
                 ↑
        why(id) — when claim refuses or `next` looks empty
```

1. **`held`** — call it first after any restart, compaction, or when you are unsure. It tells you
   what you are already holding. Resuming beats re-claiming.
2. **`claim`** — omit `workItemId` and let the gateway pick. Calling `next` and then claiming that id
   is a race; `next` is read-only and reserves nothing, so use it to *look*, not to choose. "Best"
   is not a mystery: highest priority first, oldest first within a priority, blockers verified per
   candidate so a blocked item costs one attempt rather than a wasted run. `claim` returns a
   **lease: a work item id and an `epoch`.** Keep both — every later call needs them, and the epoch
   is what proves the lease is still yours. `ttlSeconds` defaults to 600 (min 30, max 3600). Size it
   to the slowest realistic run. If you were dispatched by another agent, pass `spawnedBy` so the
   attribution chain resolves back to a person.

   **Read the `briefing` that comes back with the lease.** It carries the item's full text, its
   parent, and every item linked to it — open ones first, and those arrive *with their text*, because
   an open linked item is often a requirement on the work you just took rather than separate work.
   This is the half of "write it down first" that used to be missing: a finding can be noticed,
   captured and correctly placed and still never reach you, because placement puts it near the work
   and only delivery puts it in front of the person doing it. Expect the constraint to contradict the
   obvious implementation — that is usually why someone bothered to write it down.
3. **`history`** — before working anything that reads harder than it looks. How many times the item
   has been claimed, how many of those lapsed rather than finished, who last held it and how that
   attempt ended (`null` if nobody ever has). Two agents having already timed out is context the
   description does not carry, and repeating their run is the most expensive way to discover it —
   so if the count is high, `release` with that as the reason and label it `needs-refinement`
   rather than becoming the third. Check it before claiming when you are naming an id, and right
   after when you let the gateway pick. It is a running total, not a timeline: counts, not attempts.
4. **`heartbeat`** — roughly every TTL/3 during long work. A lapsed lease returns the item to the
   pool and another agent may take it while you are still typing. Expiry always comments on the item,
   and **after three expiries it is flagged for a human** — an item that repeatedly kills its agent
   is underspecified, and the fix is refinement, not another attempt.
5. **`complete`** — `outcome` is not a formality: it is the evidence. What you did, the PR link or
   commit, and what you actually verified. `close` defaults to true; pass `close: false` to end the
   lease and record the outcome while leaving the item open for someone else's half. Use **`release`**
   with a reason when you are handing work back unfinished — silence is the one unacceptable ending.

   **Name the work items you touched.** `Supersedes SYNC-32`, `follow-up captured as SYNC-40`,
   `caused by SYNC-12` — a qualified reference in the outcome becomes a real relation in Plane, so
   the reasoning survives as something navigable rather than prose. Use the `SYNC-NN` form; a bare
   `#1` is left alone on purpose, because it usually means a GitHub pull request. A reference to an
   item that does not exist is reported back to you rather than dropped.

   **Harvest the rest from your commits.** Your commit messages already cross-reference more than
   your outcome will — you are in the repository and the gateway is not, so gather them yourself
   before completing:

   ```bash
   git log <base>..HEAD --format='%s%n%b' | grep -oE '\bSYNC-[0-9]+\b' | sort -u
   ```

   Use your own project's identifier in that pattern, not a generic one: matching any
   `WORD-123` shape also catches `UTF-8` and `SHA-256`, which the gateway then rejects one by one
   and reports back at you.

   Pass what it finds as `refs: ["SYNC-32", ...]` rather than pasting them into `outcome`. Same
   result — real relations — but the prose stays the part a human wants to read. A ref naming
   nothing is reported back; refs and prose are merged, so naming an item in both is harmless.

   This links everything your commits *mention*, which is usually right. Drop any item you only
   named as an example — the relation is symmetric and shows up on that item too.

   A cited commit or pull request is **checked against GitHub before the call returns**, so the
   response tells you what it found: `landed`, `pending` (real, not merged yet — normal for a PR you
   just opened), `absent`, or `unchecked`. Cite nothing and the item is labelled `unverified`; cite
   something that does not exist and it is labelled `evidence-missing`. Both are visible on the
   board, so a vague "done" or a half-remembered sha is not a way to move faster — it is a way to be
   marked in public. Push your commit *before* you complete, and paste the sha you actually pushed.

## Looking around

Four tools answer four different questions, and reaching for the wrong one is how a project full of
work looks empty:

- **`next`** — what could I claim right now. Read-only, capability-filtered, at most `limit` items
  (default 10, max 50), so a short list is a page rather than a verdict.
- **`find`** — filter *this* project by label, priority, state group, module, parent, or holder, and
  combine them. Plane's own list tools cannot filter at all, so use this instead of listing
  everything and sifting it yourself. `holder` is the one Plane could never offer, because it comes
  from the lease table: `any` shows what the fleet is working on, `none` shows what is free.
  `ready: true` applies the same gate `claim` uses. The reply carries `matched` — the number of hits
  *before* `limit` — so you can tell a complete answer from a first page.
- **`search`** — text, across **titles and descriptions**, in your own project by default. That
  second half matters: titles lead with behaviour, so the file names, error strings and env vars
  you would actually type live in the body. A body hit says `where: "body"` and carries the
  surrounding text, so you can tell a real match from a passing mention without opening it; title
  hits sort first. Use it before capturing, to find out whether something is already written down,
  and to resolve an item a human named rather than numbered. Pass `workspace: true` to cross project
  boundaries — descriptions included there too, by sweeping each project you can see. Above 25
  projects it falls back to Plane's title-only endpoint and says so in the reply, rather than reading
  an arbitrary first 25 and silently skipping the one you wanted; a project it could not read is
  named in `unreadableProjects`, because "no results" and "could not look" are different answers.
  Results are pointers, so follow up with `find`, `tree` or `why` inside that project. Scoped to your
  own Plane access either way.
- **`board`** — where the whole project stands: per module, the total, done, held, ready and blocked
  counts, which add up because an item is in exactly one bucket, plus every live lease. `ready` is
  the number Plane cannot produce on its own — it needs the readiness gate *and* the lease table.
  Read it before starting something new: finishing what is nearly done usually beats it.

**`board` also answers whether the project has any shape at all.** Its `structure` block reports how
many items are filed in a module, how many have a parent, how many are containers, how deep the
hierarchy actually goes, and how many are unplaced. A `depth` of 1 with a high `unplacedOpen` is a
flat inbox with a tracker's name on it, not a plan — and the fix is decomposition and modules, not
more captures. Check it before adding to the pile.

## Capture: write it down before you decide

Call `capture` the moment you notice something, not when you get round to it. It is idempotent
(pass `idempotencyKey` if you might retry) and near-duplicate titles merge into the existing item,
so calling it freely is the intended usage.

**First decide whether it is a task at all.** "I discovered something" is not the same as "there is
new work", and most discoveries are not: they are *constraints on work that already has an item*.
Filed as a task, a constraint ends up sitting **next to** the work instead of **in** it, and the
agent who claims that work never sees it. It then completes honestly, and the constraint stays open
beside something that is already wrong. Re-parenting does not save you here — a sibling is exactly
as unreachable as an orphan.

So before you call `capture`, ask what the finding constrains. If it names existing items, split it:

1. **The requirement goes into those items** as explicit acceptance criteria — specific enough that
   it cannot be paraphrased into vagueness. Name the exact values, addresses or inputs to test
   against, not the shape of the concern.
2. **Only the independently verifiable residue stays a task**, and write it as a *proof* rather than
   a statement: `Prove the rate limit binds on inbound credit, not outbound send` rather than
   `Apply the rate limit to _credit, not _debit`. Give it `blocked_by` the items it verifies, so it
   cannot be picked up before there is something to check.

**Does the wrong version look right?** That is the test for whether step 2 earns a separate item. A
rate limit on the wrong path compiles and passes a naive test; an address copied across chains
produces config that reads as symmetric and never fails at deploy. Neither is caught by implementing
carefully — only by deliberately feeding the guard bad input, which is real work and deserves its
own item. When the wrong version *does* look wrong, the acceptance criterion alone is enough and a
second item is landfill.

**Read what it returns.** `deduped: true` means you did not create anything — your text was dropped
and an existing item was handed back, so if your body carried something the original lacks, add it
as a comment. `replayed: true` means the same `idempotencyKey` returned a stored answer. A
`parentId` that is not the one you passed means the item you deduped into already lived under a
different parent, and was **not** re-parented — the fleet is not rearranged behind your back, so
your decomposition is one child short and you have to notice.

**Check `priority` and `labels` in the reply against what you sent.** They are echoed for exactly
that purpose. On a dedup, `notApplied` names the parts of your request that did not happen — an
existing item is handed back untouched, so a priority or a label you asked for was ignored, and
`deduped: true` on its own does not tell you that. This is worth the two seconds: six captures in a
row once landed with the wrong priority and no labels at all, and every reply looked fine, because
the reply carried nothing to compare against the request.

A capture is only useful if an agent can later pick it up. The readiness gate **withholds** an item
from `claim` when it:

- has **no description** — an agent cannot infer acceptance criteria from a title;
- is in a state group other than `backlog` / `unstarted`;
- is a **draft**;
- has **unfinished sub-items** (the work is in the children — claim those);
- carries a blocking label: `needs-human`, `needs-refinement`, `blocked`, `wontfix`;
- is blocked by unfinished work (checked at claim time, not while browsing).

So: always give `body` enough for someone else to act without you — what, where, and how anyone
would know it is done. Set `priority` honestly.

**Title it in product terms.** Lead with the capability someone gains or the behaviour that is
wrong, not with the code you expect to touch. `Tell an agent why it cannot claim an item`, not
`why(workItemId): return the gate reasons` — the second names a function and a payload, and never
says what is wrong or what anyone gets. The pull is toward it, because the code is what is in your
head at the moment you write it.

An identifier is welcome where it is the most precise short way to say what you mean:
`GITHUB_WEBHOOK_SECRET is unset in production` beats any paraphrase. What to avoid is the
*volatile* kind — a function, parameter or internal helper that will be renamed long before the
item is read, leaving a title describing something that no longer exists. Stable and meaningful
outside this repo: keep. Internal and short-lived: put it in the body, where being wrong is cheap.

The test: would someone who has never read this repo know what changes for them?

**The module is automatic. The parent is not — and that asymmetry is on you until it is fixed.**
Whatever you capture lands in the module of its `parentId`, or failing that of the item you are
holding, and the reply says `moduleInherited: true`. Pass `moduleId` only to put work somewhere
neither would have chosen. If the source is in no module, nothing is invented.

`parentId` has no such inheritance: omit it and the item is created at the root, filed in a module
and hanging off nothing. Because the module is filled in for you, the board still *reports* as
placed — so this decays silently, and measurably does. Measured 2026-07-31 on a board built by one
planning session and then worked normally: every item from the planning session parented, every item
captured afterwards an orphan. The planning session used `decompose`, which always sets a parent;
ordinary work used `capture`, which never does.

Until the gateway inherits it, **pass `parentId` yourself** whenever the work belongs under something
— and check what you have written: `board` reports `parented` against `items`, and a gap between
them is the shape of this problem.

**Provenance is automatic too.** If you hold exactly one item in the project, whatever you capture
is linked back to it and the reply says `discoveredFromInferred: true`. You do not have to remember
`discoveredFrom`, and you should not pass it just to be safe. Pass it only when the gateway cannot
know: you noticed this while working something you have since released, or you are holding several
items and only one is the real source. Holding two, it refuses to guess — a confidently wrong
provenance edge is worse than none, because nobody reading the graph later can tell a guess from a
fact.

**Deliberately unclaimable is a feature.** Label a capture `needs-human` when it needs a decision
you should not make alone — that is how you ask a question the fleet will not accidentally answer.

**Capture before you fix, however small — and whoever found it.** The rule is easiest to skip on
a bug a human just pointed at, because it feels already tracked: you both saw it, you are both
looking at it, writing it down reads as ceremony. It is not. The conversation ends and the board
is what remains, so a fix that was never captured leaves a commit nobody can account for. If you
notice the omission only after finishing, still capture it, close it with the evidence, and say
plainly that it was logged retroactively.

**What does not belong on the board.** The project tracks the product. Improvements to how *you*
work — capture discipline, harness settings, prompt or tooling habits — are not project work, and
filing them turns your own slip into someone else's backlog item. They belong in this skill, in
`CLAUDE.md` / `AGENTS.md`, or in agent memory. The test: would this task still exist if a human
were doing the work by hand? If not, it is not a project task.

## Decomposition and relations

**The levels you actually have** (measured against Plane 1.3.1, not assumed):

| Level | Nests? | Use it for |
|---|---|---|
| Module | **no** — one flat layer | the epic: a feature or workstream |
| Work item → sub-item | **yes, arbitrarily deep** | decomposition; verified three levels, a child can itself be a parent |
| Label | n/a — many per item | cross-cutting dimensions: area, capability, risk |

Modules are the epic layer. They do not nest — `parent` on a module is accepted and silently
dropped, so code written against "sub-modules" looks like it worked and did nothing. Depth below the
epic comes from sub-items, which do nest and which the readiness gate understands transitively.

**A module has to earn its existence.** One per feature or workstream, never one per task. The
threshold: would a human ask "how far along is *that*?" as a question in its own right, over weeks
rather than hours? If not, it is a parent work item with sub-items, or just a label. Forty modules
is not an epic layer — it is a second copy of the backlog with worse tooling, and it makes the
progress rollup that justifies modules meaningless. Check `list_modules` before creating one; a
near-duplicate module is worse than none.

**Modules and labels are orthogonal, and that is the point.** An item sits in exactly one module and
one parent chain, but carries as many labels as apply. So "which feature is this part of" is a
module, "what kind of work is it" is a label. Reaching for a module because you want two groupings
at once is the mistake — that is what labels are for.

- **`tree(workItemId)`** shows what is already under an item — every sub-item with its state and,
  if someone is working it, the holder and lease expiry. Call it *before* decomposing: it is the
  only way to see whether the work was already broken up, and "unfinished" without a holder is a
  different thing from "unfinished and already being worked".
- **`decompose`** writes every child in one call, and is the right tool for breaking work up.
  `capture(parentId: …)` makes a single sub-item and is for adding one child to a plan that already
  exists. The difference matters because a parent with unfinished children stops being claimable —
  which is what you want, it is a container rather than a task, and it composes up the tree so a
  grandparent stays unclaimable while any leaf under it is open. But it also means the plan goes
  live at its *first* child: written one capture at a time, another agent can claim child 1 and
  start work while children 2–5 are still in your head. `decompose` is not a transaction — if some
  children fail the rest still land — so read `complete` in the reply, and `failed`, which names
  exactly which children did not.
- **`discoveredFrom`** is provenance, not structure — usually derived from your lease rather than
  passed. If you pass it where you meant `parentId`, the fleet will happily claim the parent as
  well as the child. Giving `parentId` suppresses the provenance edge, because a parent already
  places the item and says something stronger.
- **`link`** records `blocking`, `blocked_by`, `duplicate`, `relates_to`. Plane's vocabulary is
  `blocking`, not "blocks" — anything else is accepted and then silently ignored. Link a blocker the
  moment you find one; the readiness gate reads it and will stop another agent burning a run on it.

## Use the rest of Plane

Keeping the board true is part of the work, not overhead. Once you hold an item:

**Comments — `add_issue_comment`, `get_issue_comments`.** Put the reasoning where the work is. A
decision, a dead end, a measurement, a question for the human: comment on the item rather than
letting it evaporate with your context. Read the comments before starting — someone may have already
tried your first idea.

**Cycles (sprints) — `list_cycles`, `get_cycle`, `create_cycle`, `update_cycle`, `list_cycle_issues`,
`add_cycle_issues`, `delete_cycle_issue`, `transfer_cycle_issues`.** There is no "current cycle"
tool: list them and pick by date. Add what you claim to the active cycle so the humans' board shows
reality, and use `transfer_cycle_issues` to move unfinished work forward rather than leaving it
stranded in a closed cycle.

**Modules (features / epics) — `list_modules`, `get_module`, `create_module`, `update_module`,
`list_module_issues`, `add_module_issues`, `delete_module_issue`.** Group a body of related work
under a module before you fan it out into sub-items; it is how anyone later answers "how far along
is this feature?".

**Labels — `list_labels`, `get_label`, `create_label`, `update_label`.** Labels are routing, and the
most under-used surface here. Reuse what exists (`list_labels` first — a near-duplicate label is
worse than none). Four are load-bearing: `needs-human`, `needs-refinement`, `blocked`, `wontfix`
make an item unclaimable. A token's `capabilities` are matched against label names too, so labels
are how work reaches the agent equipped for it.

`capture(labels: ["backend"])` takes names and creates the label if the project lacks it, so
labelling costs nothing. A name one character from a load-bearing label (`needs-humans`, `blockd`)
is refused rather than created — that failure would be silent, withholding nothing while looking
right. Plane's own tools still take uuids; only `capture` resolves names.

**States — `list_states`, `get_state`.** Read them to understand a project's workflow. Creating,
updating or deleting a state needs the `destructive` capability you almost certainly do not have,
and for good reason: the readiness gate reads state *groups*, so removing one strands every item
that referenced it.

**Work item types — `list_issue_types`, `get_issue_type`, `create_issue_type`, `update_issue_type`.**
Use the project's own taxonomy (bug / task / spike) rather than encoding it in the title.

**Worklogs — `create_worklog`, `get_issue_worklogs`, `get_total_worklogs`, `update_worklog`.** Log
the real effort when you complete. It is the only way anyone ever learns what this class of work
actually costs, and estimates without it are folklore.

**Lookup and people — `get_issue_using_readable_identifier`** (resolve a human's "PROJ-142" to the
real item — do this instead of guessing from a title), **`list_project_issues`**, `create_issue`,
`update_issue`, `get_projects`, `create_project`, `get_user`, `get_workspace_members`.

A good claimed-work rhythm: claim → comment what you intend → add to the current cycle/module →
work, heartbeating → comment anything a human would want to know → `complete` with evidence →
worklog. And `capture` everything you noticed on the way.

## The board lags, and that is deliberate

The lease is the truth; Plane is a mirror written in the background. `complete` ends your lease the
moment it returns and updates Plane afterwards, so you never fail because Plane was slow.

Two consequences worth knowing before you act on what you see:

- **A blocker you just finished can still block its dependant** for a second or so, because the
  readiness gate asks Plane. Wait and retry rather than concluding the link is wrong.
- **A board still showing "In Progress" for finished work** means a mirror write failed, not that
  the lease is confused. Say so; do not reach for `update_issue` to "fix" the state, which is exactly
  the write the gateway refuses on an item you no longer hold.

## When `next` or `claim` comes back empty

`NO_WORK` is not a fault. **Call `why` on an item you expected to be offered** — it answers with
the reasons the gate itself used, including the two you cannot see from the item: a live lease, and
a capability mismatch. Guess only if that is somehow unavailable, in this order:

1. Everything ready is **already leased** by another agent.
2. Items exist but **fail the readiness gate** — most often no description, or a parent whose
   children are the real work.
3. **Your token carries capabilities**, which double as label routing: you are shown only items
   labelled with one of them. A capability list you did not expect is the usual reason a project
   full of work looks empty to exactly one agent.

A short `next` is a page, not a verdict — see **Looking around** above for the tool that answers
each of those without guessing.

## What the gateway refuses, and why

- **`assignees` or `state` via `update_issue` on an item you do not hold.** Those two fields *are*
  the lease as Plane displays it; writing them directly is how two agents end up on one item.
  `claim` sets them for you. Everything else on `update_issue` — title, description, priority,
  labels, dates — goes straight through.
- **Schema-shaped destruction** (`delete_state`, `update_state`, `create_state`, `delete_label`,
  `delete_cycle`, `delete_module`, `delete_issue_type`, `delete_worklog`, `delete_cycle_issue`,
  `delete_module_issue`) without the `destructive` capability.

Both refusals are permanent for your token. Do not retry, and do not look for another route to the
same effect — the route not taken is the invariant.

## When a call fails

Every refusal carries a code and a recovery line. The ones that change what you do next:

| Code | What it means | Do |
|---|---|---|
| `NO_WORK` | nothing ready matched | call `why` on an item you expected, then back off — not an error |
| `NOT_CLAIMABLE` | someone holds it, or it is not ready | call `why` to find out which, then pick another item |
| `NOT_HOLDER` | you do not hold this lease | stop working the item; retrying cannot help |
| `STALE_EPOCH` | **your lease lapsed and someone else reclaimed it** | **discard the work — do not submit it** — and claim fresh |
| `LEASE_EXPIRED` | lapsed, nobody took it | claim it again before continuing |
| `LEASE_ENDED` | already completed or released | terminal; do not re-submit, claim something else |
| `INVALID` | a field did not match the schema | read the lines under the message — each names the field, the limit, and what you sent. `outcome` is capped at 2000 characters, which is the one most people meet |
| `IDEMPOTENCY_MISMATCH` | that key was used with a different body | your bug — use a new key, do not retry the old one |
| `FORBIDDEN` | your token lacks the capability | do not retry; ask the operator |
| `UNAUTHENTICATED` | token missing, revoked, or replaced | stop — no tool will work; ask for a new token |
| `UPSTREAM` | Plane was unreachable or errored | retry with backoff; nothing you did is wrong |

`STALE_EPOCH` is the one worth reading twice: whatever you computed rests on state another agent has
since changed. Writing it anyway is exactly the silent-wrong-result failure everything else here
exists to prevent.
