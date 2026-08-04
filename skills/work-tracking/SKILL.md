---
name: work-tracking
description: The playbook for tracking work in Plane through the `sync` MCP server — capture/claim/heartbeat/complete, plus Plane's own surface (cycles, modules, labels, states, comments, worklogs, sub-items, relations). Use when starting, resuming, organising or finishing tracked work; when deciding what to do next; when you notice something worth doing; or when a `sync` tool refuses a call.
user-invocable: true
---

# Working through the tracker

Two halves live on one MCP server. Do not confuse them:

- **Coordination tools** — 18 of them — exist because Plane has no equivalent. They are the only
  safe way to take work.

  | | Answers |
  |---|---|
  | `capture` `decompose` | write it down; break it up in one call |
  | `next` `find` `search` `board` | what is there — ready, filtered, workspace-wide, rolled up |
  | `why` `tree` `history` | why not this one; what is under it; has it been tried before |
  | `claim` `heartbeat` `complete` `release` | the loop |
  | `link` `unlink` `constrain` | typed edges; take a blocker back; a requirement on existing work |
  | `held` | what am I holding |

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

## Work with someone's name on it is not yours to take

**If an item is assigned to someone else, do not work it without explicit approval from the person
you are working with.** Ask, and wait for the answer. Not a note in your summary afterwards — a
go-ahead before you start. A name on an item is usually the visible end of a conversation you were
not part of, and the cost of asking is one message where the cost of guessing is duplicated work and
a handover nobody knows was dropped.

The gate enforces this, so you will meet it as a refusal rather than as a rule to remember:
`find(ready: true)` omits assigned work, `board` stops counting it, `next` will not offer it, and
`claim` refuses it and names the person. `why` says the same thing. Browsing without `ready` still
shows it, on purpose — you may want to link it as a blocker.

**A name that is your own is a work order, not a barrier.** Assigning an item to the Plane user your
token authenticates as hands it to you; the gate reads that as "take this" and lets you claim it.
That is deliberate, and it has a consequence worth knowing: an agent minted from a personal token
authenticates *as its owner*, so if you and your human share a Plane account, work they assign to
themselves reads as assigned to you. On that setup a human cannot fend you off by assigning
something to themselves — they have to say so.

**Once they agree, `claim` with `takeover: true`.** It has to name a `workItemId`: they approved
taking a specific piece of work off someone, not whatever the gateway picks next. One call does the
lot — records the approval against the item, moves it to the human who authorised it, takes the
lease, and comments on the item so the original assignee learns what happened and who decided. The
approval is stored, not remembered, so a later claim of the same item does not ask again and a
compaction cannot lose it.

Never pass `takeover` on your own initiative. The gateway cannot tell your word from your human's:
that argument **is** the trust.

**Three things a name can mean**, and the gate already tells them apart, so read a refusal literally
rather than second-guessing it:

- **A person assigned it.** Withheld. Ask.
- **An agent is holding it right now.** A live lease, and `why` reports the lease rather than the
  assignee. Nothing to ask about — wait or take something else.
- **A name the gateway itself wrote, whose lease has ended.** Residue from a mirror write that
  failed, so it is *not* treated as an assignment and the item stays claimable. You will not see it
  as a refusal at all; it is here so that a name in Plane on work nobody is doing does not read to
  you as a contradiction.

**Who created an item never withholds it.** Only assignment does. Items an agent captured carry
`external_source` naming that agent — `created_by` cannot tell you, because a self-minted agent
writes as its human. Treat it as a reading instruction, not a permission: a human's wording is meant
literally, where another agent's is often shorthand for something it had in context and you do not.

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
hierarchy actually goes, and how many are unplaced.

**Read `rootlessOpen`, not `unplacedOpen`, to judge the tree.** `unplaced` counts only items that
are in no module *and* have no parent, so a board where everything was filed in a module and nothing
had a parent reported `unplaced: 0` and read as fully structured while being completely flat — 63
items, 14 of them hanging off nothing. Filed and placed are two different properties.
`rootlessOpen` is open leaf work sitting at top level whether it is filed or not; containers are
excluded, because a root is where a container belongs.

A `depth` of 1, or a `rootlessOpen` close to the open item count, is a flat inbox with a tracker's
name on it, not a plan — and the fix is decomposition and modules, not more captures. Check it
before adding to the pile.

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

**`constrain` does both halves in one call**, and is what to reach for once you have triaged this
way. Give it the items the requirement applies to and the requirement itself; add `proof` only when
the looks-right test says the residue is separate work, and it is opened `blocked_by` everything it
verifies. One call because the requirement and its proof drifting apart is what produced the orphans
— written separately, the proof lands and the criterion does not.

It writes into items other agents may be holding, and says so: `heldBy` in the reply names anyone
mid-run, and they get a comment, because the description they were handed at claim time is already
stale in their context and they will not re-read it.

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
- is blocked by an unfinished `blocked_by` item;
- is **assigned to somebody other than you** — see the section above.

Browsing and claiming apply all of these. Until 2026-08-03 the last one was checked only at claim
time, so `find(ready: true)` listed work that `claim` then refused and `board` counted it ready —
if you are talking to a gateway older than that, treat a `ready` row as a candidate rather than a
promise, and believe `why` over any listing.

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

**Placement is automatic — both halves of it.** Whatever you capture lands in the module of its
`parentId`, or failing that of the item you are holding, and the reply says `moduleInherited: true`.
Pass `moduleId` only to put work somewhere neither would have chosen. If the source is in no module,
nothing is invented.

The parent is inherited too, and the shape matters: your capture becomes a **sibling** of the item
you are holding — it takes that item's parent — and the reply says `parentInherited: true`. It never
becomes a *child* of what you hold, because a parent with unfinished children stops being claimable,
so that would block your own completion on a note you just wrote. If the item you hold has no parent
there is nothing to be a sibling of, and nothing is invented.

This was the asymmetry that used to make boards go flat: the module was filled in and the parent was
not, so items *reported* as placed while hanging off nothing. Measured on a board built by one
planning session and then worked normally — every item from the session parented, every item
captured afterwards an orphan, because the session used `decompose` (which always sets a parent) and
ordinary work used `capture` (which did not).

Placement is not delivery. A sibling is no more visible to whoever claims the item next than an
orphan was — that is what the `briefing` on `claim` is for. Filing something correctly does not mean
anyone will read it.

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
- **`unlink`** is how you take a `blocked_by` back. Read the reply to `link`: Plane keeps *every*
  relation on a pair rather than replacing one, so re-linking the same pair as `relates_to` adds an
  edge and leaves the `blocked_by` gating. `link` names those under `conflicts` — before this it
  returned `ok` and an agent correcting a mistake believed it had.

  What `unlink` does **not** do is delete the edge, because Plane's API has no way to: the relations
  endpoint is get and post only, at every version. It stops the readiness gate honouring it, writes
  a comment on the item saying so, and records who decided and why — `reason` is required. Plane's
  UI will still draw the edge until a human deletes it there. Retract when a dependency stops being
  true, not to hurry past one you find inconvenient; `reinstate: true` puts it back.

### What you can see

Your token is scoped to the projects **your own Plane user** is a member of. `find`, `next`,
`board`, `tree`, `why`, `history`, `search` and `claim` all refuse a project you are not in, and the
refusal names the projects you *can* see — so if you get a `FORBIDDEN`, read the list rather than
guessing at ids. Before 2026-08-03 most of these read any project in the workspace; if a gateway
still does, it predates that.

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
