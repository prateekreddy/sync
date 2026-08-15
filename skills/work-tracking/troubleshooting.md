# When sync refuses, or comes back empty

## Contents
- No sync tools at all — installed, but not connected
- `NO_WORK`, and why an empty result is usually correct
- What the gateway refuses to do, and the reason for each
- Reading a failure: the error code and its recovery line

Every refusal here is deliberate and carries a recovery line. Follow it rather
than working around it. The loop is in [SKILL.md](SKILL.md).

## No sync tools at all

You have this playbook and no `capture`, `claim` or `complete` to use it with. That is not a
half-broken install: the plugin ships the rules, the hooks and the liveness monitor from disk, while
every tool comes from the gateway over an authenticated connection. Installing the plugin does not
make that connection. Sign-in is a browser flow, so a box nobody has signed in on has all of the
former and none of the latter.

**This is the one sync failure that does not refuse you**, and it is worth being clear about why
that matters. Every other failure here hands back a code and a recovery line. This one hands back
nothing, because there is no tool to call — so an agent that does not check simply works without a
lease, which is the state the gateway exists to abolish. The most dangerous-looking symptom is the
quietest.

**Check `SYNC_MCP_URL` first**, because it is the one cause that is not about signing in. The plugin
ships no gateway address — sync is self-hosted, and a bundled URL would point every install at
whoever published it — so with that variable unset there is no server to authenticate against and
the symptom is identical to nobody having signed in. It is set in `settings.json` under `env`.

Do not carry on unclaimed, and do not look for another way to record the work. Say plainly that sync
is installed but not connected, and offer the ways out:

- **someone is at this machine** — ask them to run `/mcp`, pick `sync`, and sign in. One browser
  page, then restart the session.
- **nobody is** (a container, a CI runner, a provisioned box) — run
  `${CLAUDE_PLUGIN_ROOT}/bin/sync-connect --help`. It exchanges a Plane personal token for an agent
  token and writes the server entry itself, with no browser anywhere in it. Restart afterwards.

Both end in a restart, because a client picks its MCP servers up at startup. Until then, treat every
item as unclaimed by you.

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

A short `next` is a page, not a verdict — see **Looking around** in [SKILL.md](SKILL.md) for the
tool that answers each of those without guessing.

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

Every refusal carries a code and a recovery line. This is all of them — if you meet a code that is
not here, the gateway is newer than this file and its own recovery line is the authority:

| Code | What it means | Do |
|---|---|---|
| `NO_WORK` | nothing ready matched | call `why` on an item you expected, then back off — not an error |
| `NOT_CLAIMABLE` | someone holds it, or it is not ready | if somebody holds it the message names **who and until when** — wait and retry when that is soon, otherwise take something else. Otherwise it lists what is not ready; `why` gives the fuller picture |
| `NEEDS_APPROVAL` | it is assigned to a person, and nobody has said you may take it | ask the person you are working with, naming who holds it, and wait for an answer. You cannot clear this yourself — that is the point. If they agree, `claim` it again by id and the gateway puts the question to them. See **Work with someone's name on it** in [SKILL.md](SKILL.md) |
| `NOT_HOLDER` | you do not hold this lease | stop working the item; retrying cannot help |
| `STALE_EPOCH` | **your lease lapsed and someone else reclaimed it** | **discard the work — do not submit it** — and claim fresh |
| `LEASE_EXPIRED` | lapsed, nobody took it | claim it again before continuing |
| `REVOKED` | **a person took this item back in Plane while you held it** — they unassigned it or closed it | **stop, discard what you did, and do NOT claim it again.** Read this against `LEASE_EXPIRED` above, which looks similar and means the opposite: nothing lapsed here, somebody decided this is not your work, and re-claiming would undo their decision. Pick something else; if you think it was a mistake, say so rather than working around it |
| `LEASE_ENDED` | already completed or released | terminal; do not re-submit, claim something else |
| `NOT_FOUND` | no such item in this project | check the id — a uuid from another project lands here too. `search` resolves a title, `plane_issues` (`get_by_identifier`) resolves a `SYNC-42` |
| `INVALID` | a field did not match the schema | read the lines under the message — each names the field, the limit, and what you sent. `outcome` is capped at 2000 characters, which is the one most people meet — do not shorten it by cutting what you verified; post the full record as a comment with `plane_comments add`, which has no cap, and complete with a summary plus the commit link |
| `IDEMPOTENCY_MISMATCH` | that key was used with a different body | your bug — use a new key, do not retry the old one |
| `FORBIDDEN` | your token lacks the capability | do not retry; ask the operator |
| `UNAUTHENTICATED` | token missing, revoked, or replaced | stop — no tool will work; ask for a new token |
| `UPSTREAM` | Plane was unreachable or errored | retry with backoff; nothing you did is wrong |

**Three of these mean your work is already lost, and they are easy to confuse.** `STALE_EPOCH` and
`REVOKED` both mean stop and discard — the first because another agent now holds the item, the
second because a person took it back. Only `LEASE_EXPIRED` is recoverable by claiming again. Reading
`REVOKED` as `LEASE_EXPIRED` is the expensive mistake: it looks like a retry and is actually
overruling somebody.

`STALE_EPOCH` is the one worth reading twice: whatever you computed rests on state another agent has
since changed. Writing it anyway is exactly the silent-wrong-result failure everything else here
exists to prevent.
