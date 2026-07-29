"""
The half of provisioning that belongs on Plane's public API.

Creating the project through `POST /api/v1/.../projects/` rather than the ORM is
deliberate: that endpoint also creates Plane's default workflow states, and the
readiness gate decides what is claimable by reading state *groups*. A project
built without them would accept work that could never be picked up.

Run by provision.sh:
    python3 plane_api.py <base_url> <token> <slug> <project_name> <identifier> <user_id>...
Prints the project id on stdout.
"""
import json
import sys
import urllib.error
import urllib.request

BASE, TOKEN, SLUG, NAME, IDENT, *MEMBER_IDS = sys.argv[1:]
ROOT = f"{BASE.rstrip('/')}/api/v1/workspaces/{SLUG}"


def call(method, path, body=None):
    req = urllib.request.Request(
        ROOT + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": TOKEN, **({"Content-Type": "application/json"} if body else {})},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")[:300]}


def die(what, status, body):
    print(f"provisioning failed: {what} -> HTTP {status} {body}", file=sys.stderr)
    sys.exit(1)


# ── project ──────────────────────────────────────────────────────────────────
status, existing = call("GET", "/projects/")
if status >= 400:
    die("list projects", status, existing)

match = [p for p in existing.get("results", []) if p.get("identifier") == IDENT]
if match:
    project = match[0]
    print(f"project {IDENT} already exists ({project['id']})", file=sys.stderr)
else:
    status, project = call("POST", "/projects/", {"name": NAME, "identifier": IDENT})
    if status >= 400:
        die("create project", status, project)
    print(f"created project {IDENT} ({project['id']})", file=sys.stderr)

pid = project["id"]

# ── members ──────────────────────────────────────────────────────────────────
# Read first, then add only what is missing. Re-adding an existing member returns
# a bare 400 "The payload is not valid", indistinguishable from a genuinely
# malformed request — so tolerating 400 here would silently hide the real thing.
# An agent that is not a project member gets 403 on every write, which is a
# confusing way to discover a provisioning bug.
status, current = call("GET", f"/projects/{pid}/members/")
if status >= 400:
    die("list project members", status, current)

# Plane paginates project *lists* but returns members as a bare array, so accept
# either shape rather than assuming the one this version happens to send.
rows = current if isinstance(current, list) else current.get("results", [])
present = {str(m.get("member") or m.get("member_id") or m.get("id")) for m in rows}

for uid in MEMBER_IDS:
    if uid in present:
        continue
    status, body = call("POST", f"/projects/{pid}/members/", {"member": uid, "role": 15})
    if status >= 400:
        die(f"add project member {uid}", status, body)
    print(f"added project member {uid}", file=sys.stderr)

print(pid)
