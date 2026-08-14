"""
The half of provisioning that belongs on Plane's public API.

Creating the project through `POST /api/v1/.../projects/` rather than the ORM is
deliberate: that endpoint also creates Plane's default workflow states, and the
readiness gate decides what is claimable by reading state *groups*. A project
built without them would accept work that could never be picked up.

Everything here assumes grant_access.py has already run, which is what makes the
projects below visible and writable to this token at all — see the long note
there. Without it, adopting a project made in the web UI is impossible rather
than merely awkward: Plane does not list a project you are not in, so the
identifier looks free and this script tries to create a second one.

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


def list_projects():
    """Every project, not merely the first page.

    Plane paginates this endpoint, so reading `results` once covers 100 projects
    and then stops — and stopping early here does not fail, it just means an
    identifier that already exists looks free and gets created a second time.
    """
    out, path = [], "/projects/"
    while True:
        status, page = call("GET", path)
        if status >= 400:
            die("list projects", status, page)
        out.extend(page.get("results", []))
        if not page.get("next_page_results") or not page.get("next_cursor"):
            return out
        path = f"/projects/?cursor={page['next_cursor']}"


# ── project ──────────────────────────────────────────────────────────────────
existing = list_projects()

# Modules are the epic layer, and Plane gates them per project behind
# `module_view`. Without it every module call fails -- creating one returns
# "Modules are not enabled for this project" and module-issues answers 404, which
# reads like a wrong URL rather than a disabled feature. Set at creation, and
# repaired on re-runs so projects made before this still get it.
FEATURES = {"module_view": True}

project = None
match = [p for p in existing if IDENT and p.get("identifier") == IDENT]
if not IDENT:
    print("no project requested", file=sys.stderr)
    print("")
    sys.exit(0)
elif match:
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

# ── agents on this project ───────────────────────────────────────────────────
# Read first, then add only what is missing. Re-adding an existing member returns
# a bare 400 "The payload is not valid", indistinguishable from a genuinely
# malformed request — so tolerating 400 here would silently hide the real thing.
# An agent that is not a project member gets 403 on every write, which is a
# confusing way to discover a provisioning bug.
#
# Only the project this run asked for, and only the agents it was asked to make.
# The gateway's own account is not handled here: it needs EVERY project, which
# this API cannot deliver at all — see grant_access.py.
if MEMBER_IDS:
    status, current = call("GET", f"/projects/{pid}/members/")
    if status >= 400:
        die(f"list members of {IDENT}", status, current)

    # Plane paginates project *lists* but returns members as a bare array, so
    # accept either shape rather than assuming the one this version happens to
    # send.
    rows = current if isinstance(current, list) else current.get("results", [])
    present = {str(m.get("member") or m.get("member_id") or m.get("id")) for m in rows}

    for uid in MEMBER_IDS:
        if not uid or uid in present:
            continue
        status, body = call("POST", f"/projects/{pid}/members/", {"member": uid, "role": 15})
        if status >= 400:
            die(f"add agent {uid} to {IDENT}", status, body)
        print(f"added agent {uid} to {IDENT}", file=sys.stderr)

print(pid)
