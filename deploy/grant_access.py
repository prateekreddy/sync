"""
Give the gateway's own account access to every project in the workspace.

Run by provision.sh inside the `api` container, before the project step:
    docker compose exec -T api python manage.py shell < grant_access.py

The gateway reads with PLANE_API_KEY rather than with the caller's token —
`find`, `board`, `why`, `next` and the `claim` precheck all go through that
service client — so a project it is not a member of answers 403 on every one of
them while comments and issue reads, which use the caller's token, keep working.
That looks like a half-broken gateway rather than a missing membership.

WHY THE ORM, when the rest of provisioning deliberately uses the public API:
because the public API cannot do this, in two independent ways.

  1. It cannot SEE the projects. `GET /api/v1/workspaces/<slug>/projects/`
     filters to `Q(project_projectmember__member=request.user, is_active=True)
     | Q(network=2)` — you are shown the projects you are already in, plus the
     public ones. A private project the service account has never been added to
     is simply absent from the list, so a loop over that list skips exactly the
     projects that need fixing and reports success. Silent, and it cost a day:
     provisioning was re-run twice against a workspace whose PLANE project kept
     answering 403.

  2. It cannot ADD itself. `POST /projects/<id>/members/` is guarded by
     ProjectAdminPermission, which requires an active ProjectMember with role
     ADMIN *on that project*. Workspace admin does not satisfy it. So even
     handed the id, the account cannot join. `GET /projects/<id>/members/` needs
     membership too, so it cannot even look first.

Membership has been arriving by accident until now: Plane makes the creator of a
project a member, and provisioning created the project. That accident does not
survive a project made in the web UI, or by another user, or before this gateway
existed.

ADMIN rather than MEMBER, which is more than reading needs: adopting an existing
project also means PATCHing its features and adding agents to it, and both of
those go through the API, which demands project admin. It is also the role Plane
would itself have given this account had it created the project — so this makes
explicit the state the rest of provisioning already assumes, rather than adding
privilege it did not have. Nothing an agent holds is affected: agents never get
this token (see provision.sh), and authorisation stays the CALLER's, checked
per-request against their own Plane project list before the service client is
touched at all (server/src/access.ts, and server/test/serviceaccess.test.ts,
which fails if a route forgets).
"""
import json
import os

from plane.db.models import Project, ProjectMember, User, Workspace, WorkspaceMember

SERVICE_EMAIL = os.environ["SERVICE_EMAIL"]
WS_SLUG = os.environ["WS_SLUG"]
ROLE_ADMIN = 20

out = {"granted": [], "repaired": [], "already": 0, "total": 0}


def fail(message):
    print("GRANT_JSON:" + json.dumps({"error": message}))
    raise SystemExit(1)


workspace = Workspace.objects.filter(slug=WS_SLUG).first()
if workspace is None:
    fail(f"no workspace with slug {WS_SLUG!r}")

service = User.objects.filter(email=SERVICE_EMAIL).first()
if service is None:
    fail(f"no user with email {SERVICE_EMAIL!r}")

# Plane's own member serializer refuses a project member who is not in the
# workspace, and a ProjectMember row without one is a state the UI cannot show.
# provision.py creates this membership; check rather than assume, because
# creating it here would paper over a half-finished bootstrap.
if not WorkspaceMember.objects.filter(workspace=workspace, member=service, is_active=True).exists():
    fail(f"{SERVICE_EMAIL} is not an active member of workspace {WS_SLUG}")

# A project created later in this same run does not need to be here: Plane makes
# the creator a member, and the creator is this account. Everything that already
# existed does.
for project in Project.objects.filter(workspace=workspace):
    out["total"] += 1
    name = project.identifier or str(project.id)

    # `.first()` rather than get_or_create: a member who was removed leaves an
    # is_active=False row behind, and get_or_create would find it, change
    # nothing, and report the account a member of a project it still cannot
    # read.
    member = ProjectMember.objects.filter(project=project, member=service).first()
    if member is None:
        # ProjectMember.save() fills in `workspace` from the project and creates
        # the ProjectUserProperty row that Plane expects alongside it, so this is
        # the same code path the API would have taken.
        ProjectMember.objects.create(project=project, member=service, role=ROLE_ADMIN)
        out["granted"].append(name)
    elif not member.is_active or member.role != ROLE_ADMIN:
        member.is_active = True
        member.role = ROLE_ADMIN
        member.save()
        out["repaired"].append(name)
    else:
        out["already"] += 1

print("GRANT_JSON:" + json.dumps(out))
