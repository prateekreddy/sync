"""
Tests the client-side claim protocol under concurrency:

    1. PATCH assignees=[me]
    2. wait for writes to settle
    3. GET the item back
    4. if I am the sole assignee -> proceed, else back off

If more than one agent "proceeds" for the same work item, mutual exclusion failed.
"""
import json, sys, threading, time, urllib.request

BASE = "http://localhost:8080/api/v1/workspaces/sync"
TOKEN = sys.argv[1]
PROJECT = sys.argv[2]
AGENTS = sys.argv[3].split(",")
ITEM = sys.argv[4]
SETTLE = float(sys.argv[5]) if len(sys.argv) > 5 else 0.5


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"X-API-Key": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")


results = {}
barrier = threading.Barrier(len(AGENTS))


def attempt(agent):
    path = f"/projects/{PROJECT}/issues/{ITEM}/"
    barrier.wait()                                   # start together
    call("PATCH", path, {"assignees": [agent]})      # 1. claim
    time.sleep(SETTLE)                               # 2. let writes settle
    got = call("GET", path)                          # 3. read back
    holders = got.get("assignees", [])
    proceeds = holders == [agent]                    # 4. am I sole assignee?
    results[agent] = {"sees": holders, "proceeds": proceeds}


threads = [threading.Thread(target=attempt, args=(a,)) for a in AGENTS]
for t in threads:
    t.start()
for t in threads:
    t.join()

final = call("GET", f"/projects/{PROJECT}/issues/{ITEM}/").get("assignees", [])
short = {a: f"agent{i+1}" for i, a in enumerate(AGENTS)}

print(f"\n  settle window: {SETTLE}s")
for a in AGENTS:
    r = results[a]
    sees = [short.get(x, x[:8]) for x in r["sees"]]
    print(f"  {short[a]:8} read back {str(sees):26} -> {'PROCEEDS' if r['proceeds'] else 'backs off'}")

winners = [short[a] for a in AGENTS if results[a]["proceeds"]]
print(f"\n  final assignees in Plane: {[short.get(x, x[:8]) for x in final]}")
print(f"  agents that proceeded:    {winners}")
print(f"\n  RESULT: {'PASS - exactly one' if len(winners) == 1 else 'FAIL - ' + str(len(winners)) + ' agents proceeded on the same item'}")
