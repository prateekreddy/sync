"""
End-to-end proof that the proxied Plane tool surface cannot walk around the lease.

Adding Plane's own MCP gives agents `update_issue`, which sets `assignees` and
`state` — the two fields that *are* the lease as far as Plane's UI is concerned.
If that call is not gated, the whole gateway is decorative: an agent would simply
assign itself and proceed, which is the failure measured in docs/race2.py.

  GATEWAY=http://localhost:8788 PROJECT=<uuid> T1=.. T2=.. python3 proxy_e2e.py
"""
import json, os, sys, time, urllib.error, urllib.request, uuid

GW = os.environ["GATEWAY"]
PROJECT = os.environ["PROJECT"]
T1, T2 = os.environ["T1"], os.environ["T2"]

RUN = uuid.uuid4().hex[:8]
ok = True


def http(token, method, path, body=None):
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


def tool(token, name, **args):
    """Invoke through the MCP surface, exactly as an agent would."""
    st, body = http(token, "POST", "/v1/tools/call", {"name": name, "arguments": args})
    if st >= 400:
        return st, body
    # Native tools return their JSON payload as text content.
    try:
        return st, json.loads(body["content"][0]["text"])
    except (KeyError, ValueError, IndexError):
        return st, body


def check(label, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"  {'PASS' if cond else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


print("\n1. one surface, two halves")
st, cat = http(T1, "GET", "/v1/tools")
names = {t["name"]: t["source"] for t in cat["tools"]}
check("gateway tools present", {"capture", "claim", "complete"} <= names.keys())
check("plane tools present", {"create_cycle", "update_issue", "list_states"} <= names.keys(),
      f"{sum(1 for s in names.values() if s == 'plane')} proxied")
check("gateway tools are not shadowed", names.get("claim") == "gateway")

print("\n2. native tools work through the tool surface")
st, item = tool(T1, "capture", projectId=PROJECT,
                title=f"Proxy surface check {RUN}",
                body="Created through /v1/tools/call rather than the REST route.")
check("capture via tools/call creates an item", bool(item.get("workItemId")), item.get("readableId", str(item)))
ITEM = item["workItemId"]

print("\n3. sub-items")
st, child = tool(T1, "capture", projectId=PROJECT,
                 title=f"Child of the proxy check {RUN}",
                 body="A real decomposition, so the parent becomes a container.",
                 parentId=ITEM)
check("capture accepts parentId", child.get("parentId") == ITEM, str(child.get("parentId")))

st, refused = http(T2, "POST", "/v1/claim", {"projectId": PROJECT, "workItemId": ITEM})
check("a parent with an open sub-item is not claimable",
      st == 409 and refused.get("error") == "NOT_CLAIMABLE",
      "; ".join(refused.get("blockers", [])) or refused.get("message", ""))

st, c = http(T1, "POST", "/v1/claim", {"projectId": PROJECT, "workItemId": child["workItemId"]})
check("the child itself is claimable", st == 200, c.get("error", "claimed"))
http(T1, "POST", "/v1/complete", {"workItemId": child["workItemId"],
                                  "epoch": c["lease"]["epoch"], "outcome": "Child done.", "close": True})

# Poll: `complete` ends the lease synchronously but mirrors the state into Plane
# asynchronously, and "is this child finished?" is answered from Plane. The lag is
# in the safe direction — the parent stays withheld a moment longer — so the
# guarantee under test is "becomes claimable", not "is claimable instantly".
for delay in (0, 0.5, 1, 2, 4):
    time.sleep(delay)
    st, freed = http(T2, "POST", "/v1/claim", {"projectId": PROJECT, "workItemId": ITEM})
    if st == 200:
        break
check("finishing the last sub-item frees the parent", st == 200, freed.get("error", "claimable"))

print("\n4. the proxied surface cannot bypass the lease")
# T2 holds ITEM from the step above. T1 does not — and must not be able to take it
# by writing Plane directly.
st, bypass = http(T1, "POST", "/v1/tools/call", {
    "name": "update_issue",
    "arguments": {"project_id": PROJECT, "issue_id": ITEM,
                  "issue_data": {"assignees": []}}})
check("a non-holder cannot set assignees via update_issue",
      st == 403 and bypass.get("error") == "NOT_HOLDER", bypass.get("error", ""))

st, bypass2 = http(T1, "POST", "/v1/tools/call", {
    "name": "update_issue",
    "arguments": {"project_id": PROJECT, "issue_id": ITEM,
                  "issue_data": {"state": str(uuid.uuid4())}}})
check("a non-holder cannot move state via update_issue",
      st == 403 and bypass2.get("error") == "NOT_HOLDER", bypass2.get("error", ""))

st, allowed = http(T1, "POST", "/v1/tools/call", {
    "name": "update_issue",
    "arguments": {"project_id": PROJECT, "issue_id": ITEM,
                  "issue_data": {"name": f"Proxy surface check {RUN} (renamed)"}}})
check("harmless edits are left alone", st == 200, allowed.get("error", "allowed"))

st, holder_ok = http(T2, "POST", "/v1/tools/call", {
    "name": "update_issue",
    "arguments": {"project_id": PROJECT, "issue_id": ITEM,
                  "issue_data": {"priority": "high"}}})
check("the holder can still work its item", st == 200, holder_ok.get("error", "allowed"))

print("\n5. destructive tools need an explicit capability")
st, denied = http(T1, "POST", "/v1/tools/call", {
    "name": "delete_state", "arguments": {"project_id": PROJECT, "state_id": str(uuid.uuid4())}})
check("delete_state is withheld by default", st == 403 and denied.get("error") == "FORBIDDEN",
      denied.get("error", ""))

print("\n6. attribution survives the proxy")
st, who = http(T1, "POST", "/v1/tools/call", {"name": "get_user", "arguments": {}})
body = who.get("content", [{}])[0].get("text", "{}") if "content" in who else "{}"
try:
    email = json.loads(body).get("email", "")
except ValueError:
    email = ""
check("proxied calls run as the agent's own Plane user, not the service account",
      email and email != "gateway@sync.local", email or str(who)[:120])

print(f"\n{'ALL PASS' if ok else 'FAILURES PRESENT'}")
sys.exit(0 if ok else 1)
