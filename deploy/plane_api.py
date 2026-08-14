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


def call(method, path, body=None, root=ROOT):
    req = urllib.request.Request(
        root + path,
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

# Modules are the epic layer, and Plane gates them per project behind
# `module_view`. Without it every module call fails -- creating one returns
# "Modules are not enabled for this project" and module-issues answers 404, which
# reads like a wrong URL rather than a disabled feature. Set at creation, and
# repaired on re-runs so projects made before this still get it.
FEATURES = {"module_view": True}

match = [p for p in existing.get("results", []) if p.get("identifier") == IDENT]
if match:
    project = match[0]
    print(f"project {IDENT} already exists ({project['id']})", file=sys.stderr)
    missing = {k: v for k, v in FEATURES.items() if project.get(k) != v}
    if missing:
        status, body = call("PATCH", f"/projects/{project['id']}/", missing)
        if status >= 400:
            die("enable project features", status, body)
        print(f"enabled {', '.join(missing)} on {IDENT}", file=sys.stderr)
else:
    status, project = call("POST", "/projects/", {"name": NAME, "identifier": IDENT, **FEATURES})
    if status >= 400:
        die("create project", status, project)
    print(f"created project {IDENT} ({project['id']})", file=sys.stderr)

pid = project["id"]

# ── the gateway's own account ────────────────────────────────────────────────
# This token becomes PLANE_API_KEY, and the gateway reads with it rather than
# with the caller's: `find`, `board`, `why`, `next` and the `claim` precheck all
# go through the service client. So it needs project membership like any agent —
# and it has been getting it by accident, because Plane makes the creator of a
# project a member and this script creates the project.
#
# That accident does not survive contact with a project made any other way. A
# project created in the web UI, or by a different user, leaves the gateway able
# to write through the caller's token and unable to read its own workflow states:
# every readiness call answers `Plane 403 on GET /projects/<id>/states/` while
# comments and issue reads keep working, so it looks like a half-broken gateway
# rather than a missing membership. Observed 2026-08-14 on exactly that shape.
#
# Asking who this token belongs to is one request and makes the invariant
# explicit rather than incidental.
status, me = call("GET", "/users/me/", root=f"{BASE.rstrip('/')}/api/v1")
if status >= 400:
    die("identify the provisioning token", status, me)
service_account = str(me.get("id", ""))
if not service_account:
    die("identify the provisioning token", status, {"missing": "id"})

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

# The service account first, then the agents. Order matters only for the message
# a failure produces: without the gateway's own membership nothing else it does
# on this project works, so it is the one worth naming first.
for uid in [service_account, *MEMBER_IDS]:
    if uid in present:
        continue
    status, body = call("POST", f"/projects/{pid}/members/", {"member": uid, "role": 15})
    if status >= 400:
        die(f"add project member {uid}", status, body)
    who = "gateway service account" if uid == service_account else "agent"
    print(f"added project member {uid} ({who})", file=sys.stderr)

print(pid)
