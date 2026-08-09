---
name: work-tracking
description: The playbook for tracking work in Plane through the `sync` MCP server — capture/claim/complete, plus Plane's own surface (cycles, modules, labels, states, comments, worklogs, sub-items, relations). Use when starting, resuming, organising or finishing tracked work; when deciding what to do next; when you notice something worth doing; or when a `sync` tool refuses a call.
user-invocable: true
---

# Working through the tracker

Two halves live on one MCP server. Do not confuse them:

- **Coordination tools** — 18 of them — exist because Plane has no equivalent. They are the only
  safe way to take work.

  | | Answers |
  |---|---|
  | `capture` `decompose` `gather` | write it down; break it up in one call; file loose items under one container |
  | `next` `find` `search` `board` | what is there — ready, filtered, workspace-wide, rolled up |
  | `why` `tree` `history` | why not this one; what is under it — or, with no item, the top level; has it been tried before |
  | `claim` `complete` `release` | the loop |
  | `link` `unlink` `constrain` | typed edges; take a blocker back; a requirement on existing work |
  | `held` | what am I holding |

- **Plane's own surface** — 10 tools, grouped by the thing they act on: `plane_cycles`, `plane_modules`,
  `plane_labels`, `plane_states`, `plane_issue_types`, `plane_worklogs`, `plane_comments`, `plane_issues`, `plane_projects`, `plane_people`. Each
  takes an `action` (`list`, `get`, `create`, `update`, `delete`, and a few of its own); the tool's
  description lists every action with the arguments it needs. They have **no notion of a lease**.

Both halves are served *by the gateway*, not by anything installed here, so the catalogue grows on a
gateway deploy with nothing to reinstall. Treat the tool list you were handed as authoritative rather
than this document: if a name here is missing, it moved upstream. Where the two halves collide on a
name, the coordination tool wins and Plane's is dropped — nothing can shadow `claim`.

You almost never need to pass a project id: the gateway fills `projectId` / `project_id` from your
token's binding. Pass one explicitly only when working outside your default project.

## The loop

```
held  →  claim  →  …work…  →  complete
                 ↑
        why(id) — when claim refuses or `next` looks empty
```

**A claimed item stays yours for as long as you work on it**, however long that takes. If it is
ever taken from you, you will be told so in plain words — stop there and discard that work rather
than submitting it.

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
4. **`complete`** — `outcome` is not a formality: it is the evidence. What you did, the PR link or
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

**Once they agree, just `claim` it again, naming the `workItemId`.** The gateway puts the question
to your human itself — a prompt they answer in the client, not something you assert on their behalf.
Say who has it before you do, so they know what they are agreeing to.

If they say yes, one call does the lot: records the approval against the item, moves it to the human
who authorised it, takes the lease, and comments on the item so the original assignee learns what
happened and who decided. The approval is stored rather than remembered, so a later claim of the
same item does not ask again and a compaction cannot lose it. If they say no, the item is not yours
— do not ask again for it in this session.

There is no argument that grants this, deliberately. There used to be, and it was one boolean
between you and somebody else's work. If nobody can be asked — a headless run has no human at the
other end — the claim stays refused, and the way through is for a person to unassign the item in
Plane, which works whether or not anyone is watching a terminal.

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

## The board lags, and that is deliberate

The lease is the truth; Plane is a mirror written in the background. `complete` ends your lease the
moment it returns and updates Plane afterwards, so you never fail because Plane was slow.

Two consequences worth knowing before you act on what you see:

- **A blocker you just finished can still block its dependant** for a second or so, because the
  readiness gate asks Plane. Wait and retry rather than concluding the link is wrong.
- **A board still showing "In Progress" for finished work** means a mirror write failed, not that
  the lease is confused. It is queued and retried automatically, so give it a minute rather than
  reaching for `plane_issues` to "fix" the state — that is exactly the write the gateway refuses on
  an item you no longer hold. If it is still wrong well after that, say so; the gateway gives up
  after several attempts and logs that it did.

## Going further

Everything above is the loop and the rules that have to fire before you reach for a tool.
The rest is reference, and is read only when you need it:

- **Structuring work** — decomposing an item, typed relations, and Plane's own surface
  (cycles, modules, labels, states, comments, worklogs): see [organising.md](organising.md)
- **A refusal, or an empty result** — what each error means and what to do about it:
  see [troubleshooting.md](troubleshooting.md)
