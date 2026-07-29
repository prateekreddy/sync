"""
End-to-end proof against a live gateway + live Plane.

Exercises the full agent loop and, critically, re-runs the same concurrent-claim
scenario that the client-side protocol failed (see docs/race.py) -- this time
through the gateway.

  GATEWAY=http://localhost:8787 PROJECT=<uuid> T1=.. T2=.. T3=.. python3 e2e.py
"""
import json, os, sys, threading, time, urllib.error, urllib.request, uuid

GW = os.environ["GATEWAY"]
PROJECT = os.environ["PROJECT"]
TOKENS = [os.environ["T1"], os.environ["T2"], os.environ["T3"]]

# Titles must be unique per run: capture dedups on normalized title, so reusing a
# fixed title would silently make the second run test replay instead of creation.
RUN = uuid.uuid4().hex[:8]
TITLE = f"Add retry budget to the Plane client {RUN}"
KEY = f"e2e-key-{RUN}"

ok = True


def call(token, method, path, body=None):
    req = urllib.request.Request(
        GW + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}",
                 **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(label, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"  {'PASS' if cond else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


print("\n1. capture — the write-first primitive")
st, a = call(TOKENS[0], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": TITLE,
    "body": "Cap total retries per request so a rate-limit storm cannot stall the fleet.",
    "priority": "high",
    "idempotencyKey": KEY,
})
check("capture creates a work item", st == 200 and not a.get("deduped"), a.get("readableId", str(a)))

st, replay = call(TOKENS[0], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": TITLE,
    "body": "Cap total retries per request so a rate-limit storm cannot stall the fleet.",
    "priority": "high",
    "idempotencyKey": KEY,
})
check("same idempotency key replays, does not duplicate",
      replay.get("replayed") and replay.get("workItemId") == a.get("workItemId"))

st, mismatch = call(TOKENS[0], "POST", "/v1/capture", {
    "projectId": PROJECT, "title": f"Totally different thing {RUN}", "body": "x",
    "idempotencyKey": KEY,
})
check("same key + different body is rejected", st == 422, mismatch.get("error", ""))

st, dupe = call(TOKENS[1], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": TITLE.lower() + "!!",   # same modulo case/punct
    "body": "noticed again by a different agent",
})
check("near-duplicate title dedupes to the existing item",
      dupe.get("deduped") and dupe.get("workItemId") == a.get("workItemId"))

print("\n2. readiness gate")
st, nxt = call(TOKENS[0], "GET", f"/v1/next?projectId={PROJECT}&limit=50")
ids = [c["workItemId"] for c in nxt.get("candidates", [])]
check("captured item is ready", a["workItemId"] in ids, f"{len(ids)} ready")

# Blocked work must not be claimable. `next` intentionally still lists it -- the
# blocker check costs one API call per item, so it runs at claim time where
# correctness matters rather than on every browse.
st, blocker = call(TOKENS[0], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": f"Blocker that must land first {RUN}",
    "body": "Nothing downstream can proceed until this is done.",
})
st, blocked = call(TOKENS[0], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": f"Depends on the blocker {RUN}",
    "body": "Should be refused at claim time while its blocker is open.",
})
call(TOKENS[0], "POST", "/v1/link", {
    "projectId": PROJECT,
    "workItemId": blocked["workItemId"],
    "relation": "blocked_by",
    "targets": [blocker["workItemId"]],
})
st, refused = call(TOKENS[1], "POST", "/v1/claim",
                   {"projectId": PROJECT, "workItemId": blocked["workItemId"], "ttlSeconds": 120})
check("claiming blocked work is refused", st == 409 and refused.get("error") == "NOT_CLAIMABLE",
      "; ".join(refused.get("blockers", [])) or refused.get("message", ""))

# Finishing the blocker must release the dependent item. Plane's relations payload
# carries no state, so a naive implementation treats every blocked_by as open
# forever and strands the work permanently.
st, bl = call(TOKENS[0], "POST", "/v1/claim",
              {"projectId": PROJECT, "workItemId": blocker["workItemId"], "ttlSeconds": 120})
call(TOKENS[0], "POST", "/v1/complete", {
    "workItemId": blocker["workItemId"], "epoch": bl["lease"]["epoch"],
    "outcome": "Blocker done.", "close": True})

# Poll rather than assert immediately. `complete` ends the lease synchronously but
# writes Plane's state asynchronously, on purpose: the lease is the source of
# truth and Plane is a mirror, so an agent's completion must not fail because
# Plane was slow. The blocker check reads that mirror, so a dependent item can
# stay blocked for a beat afterwards. Asserting with no wait tests the scheduler,
# not the behaviour.
for delay in (0, 0.5, 1, 2, 4):
    time.sleep(delay)
    st, freed = call(TOKENS[1], "POST", "/v1/claim",
                     {"projectId": PROJECT, "workItemId": blocked["workItemId"], "ttlSeconds": 120})
    if st == 200:
        break
check("completing the blocker unblocks the dependent item", st == 200,
      freed.get("error", "claimable"))

# A malformed request must be a 400 naming the offending field, not an opaque 500 —
# an agent can only self-correct if it is told what was wrong.
st, bad = call(TOKENS[0], "POST", "/v1/claim", {"ttlSeconds": 120})
check("malformed requests get a field-level 400", st == 400 and bad.get("fields"),
      str(bad.get("fields", bad.get("error"))))

print("\n3. concurrent claim — the scenario client-side logic failed")
results = {}
barrier = threading.Barrier(3)


def race(i):
    barrier.wait()
    results[i] = call(TOKENS[i], "POST", "/v1/claim",
                      {"projectId": PROJECT, "workItemId": a["workItemId"], "ttlSeconds": 300})


ts = [threading.Thread(target=race, args=(i,)) for i in range(3)]
[t.start() for t in ts]
[t.join() for t in ts]

winners = [i for i, (st, _) in results.items() if st == 200]
losers = [i for i, (st, _) in results.items() if st != 200]
for i, (st, b) in sorted(results.items()):
    who = f"worker-{i+1}"
    print(f"        {who}: {st} {b.get('error', 'CLAIMED epoch=' + str(b.get('lease', {}).get('epoch')))}")
check("exactly one agent claims", len(winners) == 1, f"winner=worker-{winners[0]+1}" if winners else "none")
check("losers get an actionable error",
      all(results[i][1].get("error") == "NOT_CLAIMABLE" and results[i][1].get("recovery") for i in losers))

win = winners[0]
lease = results[win][1]["lease"]
epoch = lease["epoch"]

print("\n4. fencing")
st, stale = call(TOKENS[losers[0]], "POST", "/v1/complete", {
    "workItemId": a["workItemId"], "epoch": epoch, "outcome": "I also did this"})
check("a non-holder cannot complete the item", st in (403, 409), stale.get("error", ""))

print("\n5. heartbeat and complete")
st, hb = call(TOKENS[win], "POST", "/v1/heartbeat",
              {"workItemId": a["workItemId"], "epoch": epoch, "ttlSeconds": 600})
check("holder can extend its lease", st == 200)

st, done = call(TOKENS[win], "POST", "/v1/complete", {
    "workItemId": a["workItemId"], "epoch": epoch,
    "outcome": "Implemented retry budget; PR #12 merged.", "close": True})
check("holder completes and closes", st == 200 and done.get("closed"))

st, again = call(TOKENS[win], "POST", "/v1/complete", {
    "workItemId": a["workItemId"], "epoch": epoch, "outcome": "again"})
check("completing twice is refused", st != 200, again.get("error", ""))

print("\n6. link — provenance")
st, spawn = call(TOKENS[win], "POST", "/v1/capture", {
    "projectId": PROJECT,
    "title": f"Retry budget needs a metric {RUN}",
    "body": "Found while implementing the retry budget.",
    "discoveredFrom": a["workItemId"],
})
check("agent captures discovered work with provenance", st == 200 and spawn.get("workItemId"))

print(f"\n{'ALL PASS' if ok else 'FAILURES PRESENT'}")
sys.exit(0 if ok else 1)
