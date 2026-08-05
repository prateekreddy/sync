# Organising work: decomposition, relations, and the rest of Plane

## Contents
- The levels you actually have — modules, sub-items, labels
- Decomposing an item into children
- Typed relations between items
- Plane's own surface: cycles, modules, labels, states, comments, worklogs

Read this when you are structuring work rather than taking it. The loop itself —
`held` → `claim` → `complete` — is in [SKILL.md](SKILL.md).

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
progress rollup that justifies modules meaningless. Check `plane_modules` (`list`) before creating one; a
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

Each of these takes an `action`. The tool's own description lists every action it has and the
arguments each one needs, so read that rather than guessing — what follows is when to reach for
them, not their signatures.

**`plane_comments`** — `list`, `add`. Put the reasoning where the work is. A decision, a dead end, a
measurement, a question for the human: comment on the item rather than letting it evaporate with
your context. Read the comments before starting — someone may have already tried your first idea.

**`plane_cycles`** (sprints) — `list`, `get`, `create`, `update`, `delete`, `list_issues`, `add_issues`,
`remove_issue`, `transfer_issues`. There is no "current cycle" action: `list` them and pick by date.
Add what you claim to the active cycle so the humans' board shows reality, and use
`transfer_issues` to move unfinished work forward rather than leaving it stranded in a closed cycle.

**`plane_modules`** (features / epics) — same actions as cycles, minus the transfer. Group a body of
related work under a module before you fan it out into sub-items; it is how anyone later answers
"how far along is this feature?".

**`plane_labels`** — `list`, `get`, `create`, `update`, `delete`. Labels are routing, and the most
under-used surface here. Reuse what exists (`list` first — a near-duplicate label is worse than
none). Four are load-bearing: `needs-human`, `needs-refinement`, `blocked`, `wontfix` make an item
unclaimable. A token's `capabilities` are matched against label names too, so labels are how work
reaches the agent equipped for it.

`capture(labels: ["backend"])` takes names and creates the label if the project lacks it, so
labelling costs nothing. A name one character from a load-bearing label (`needs-humans`, `blockd`)
is refused rather than created — that failure would be silent, withholding nothing while looking
right. `capture` is the only tool that *creates* a missing label; elsewhere a name that does not
exist is refused, with the existing names listed.

**Names, not ids.** `state`, `labels`, `assignees` and `parent` come back as names on every tool
here — `"In Progress"`, `"backend"`, a person's name, `"SYNC-12"` — and are accepted the same way
when you write them. So there is no need to list states or labels first just to translate an id, and
what you read is what you can write back. Ids still work everywhere they always did. If a name does
not exist the call is refused and the alternatives are named; two people sharing a display name are
refused rather than guessed at, so use the email. Pass `verbose: true` if you ever need the raw ids.

Every work item also carries `readableId` — `SYNC-42`, the id Plane's own UI shows. Use it when you
write for a human: a uuid in a PR description or a commit message is unusable to them. `id` stays
the uuid because it is the handle everything is keyed on, but anywhere a work item is *taken* —
`claim`, `complete`, `parentId`, `issue_id` — either form works.

**`plane_states`** — `list`, `get` freely. Read them to understand a project's workflow. `create`,
`update` and `delete` need the `destructive` capability you almost certainly do not have, and for
good reason: the readiness gate reads state *groups*, so removing one strands every item that
referenced it.

**`plane_issue_types`** — `list`, `get`, `create`, `update`, `delete`. Use the project's own taxonomy
(bug / task / spike) rather than encoding it in the title.

**`plane_worklogs`** — `list`, `total`, `create`, `update`, `delete`. Log the real effort when you
complete. It is the only way anyone ever learns what this class of work actually costs, and
estimates without it are folklore.

**`plane_issues`** — `get_by_identifier` resolves a human's "PROJ-142" to the real item; do that instead
of guessing from a title. Also `list`, `create`, `update`. For *taking* work use `claim` and for
writing something down use `capture` — both do more than these, and neither can be replaced by
them. `update` cannot set `assignees` or `state` on an item you do not hold; that would bypass the
lease.

**`plane_projects`** — `list`, `create`. **`plane_people`** — `me`, `members`.

A good claimed-work rhythm: claim → comment what you intend → add to the current cycle/module →
work → comment anything a human would want to know → `complete` with evidence → worklog. And
`capture` everything you noticed on the way.
