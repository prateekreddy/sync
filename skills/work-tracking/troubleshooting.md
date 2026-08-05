# When sync refuses, or comes back empty

## Contents
- `NO_WORK`, and why an empty result is usually correct
- What the gateway refuses to do, and the reason for each
- Reading a failure: the error code and its recovery line

Every refusal here is deliberate and carries a recovery line. Follow it rather
than working around it. The loop is in [SKILL.md](SKILL.md).

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
