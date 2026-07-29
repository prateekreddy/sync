"""
The staggered case, which is the one that actually threatens the client-side protocol.

Agents arrive at different times rather than simultaneously. Each one:
    1. PATCH assignees=[me]
    2. settle
    3. GET back
    4. tie-break: the EARLIEST assignee wins.

Plane's IssueAssignee Meta declares ordering = ("-created_at",), i.e. newest first,
so the earliest assignee should be the LAST element of the returned list.
That is the only ordering signal the API exposes -- there are no per-assignee
timestamps in the payload.
"""
import json, sys, threading, time, urllib.request

BASE = "http://localhost:8080/api/v1/workspaces/sync"
TOKEN, PROJECT, ITEM = sys.argv[1], sys.argv[2], sys.argv[4]
AGENTS = sys.argv[3].split(",")
STAGGER = float(sys.argv[5]) if len(sys.argv) > 5 else 0.3
SETTLE = float(sys.argv[6]) if len(sys.argv) > 6 else 0.2


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"X-API-Key": TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")


results = {}
t0 = time.time()


def attempt(agent, delay):
    path = f"/projects/{PROJECT}/issues/{ITEM}/"
    time.sleep(delay)
    wrote = time.time() - t0
    call("PATCH", path, {"assignees": [agent]})
    time.sleep(SETTLE)
    holders = call("GET", path).get("assignees", [])
    # earliest assignee wins; Meta ordering is newest-first so earliest is last
    winner = holders[-1] if holders else None
    results[agent] = {"wrote_at": wrote, "sees": holders, "proceeds": winner == agent}


threads = [threading.Thread(target=attempt, args=(a, i * STAGGER)) for i, a in enumerate(AGENTS)]
for t in threads:
    t.start()
for t in threads:
    t.join()

short = {a: f"agent{i+1}" for i, a in enumerate(AGENTS)}
final = call("GET", f"/projects/{PROJECT}/issues/{ITEM}/").get("assignees", [])

print(f"\n  stagger={STAGGER}s settle={SETTLE}s")
for a in AGENTS:
    r = results[a]
    sees = [short.get(x, x[:6]) for x in r["sees"]]
    print(f"  {short[a]:7} wrote t+{r['wrote_at']:.2f}s  read back {str(sees):30} -> "
          f"{'PROCEEDS' if r['proceeds'] else 'backs off'}")

winners = [short[a] for a in AGENTS if results[a]["proceeds"]]
print(f"  final: {[short.get(x, x[:6]) for x in final]}   proceeded: {winners}")
print(f"  {'PASS' if len(winners) == 1 else 'FAIL'} - {len(winners)} agent(s) proceeded")
