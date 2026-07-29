"""
Provision a fresh Plane instance so agents can start working immediately.

Run by provision.sh inside the `api` container:
    docker compose exec -T api python manage.py shell < provision.py

Everything here is idempotent, so a re-run repairs a partial provision rather
than creating a second of anything.

This is the one place we touch Plane's internals rather than its public API, and
that is a deliberate, bounded choice. Plane has no supported way to create the
first user, the first workspace, or an API token without a browser session — an
API token is the only credential `/api/v1/` accepts, and minting one requires a
session you cannot get without a browser. So the bootstrap uses the ORM, and
stops there: the project itself is created through the public API by
provision.sh, because `POST /api/v1/.../projects/` also creates the default
workflow states, and reproducing that here would mean copying a list that Plane
is free to change.

If a Plane upgrade breaks this file, nothing is lost — do the same four things in
the web UI (sign up, create a workspace, create a project, create an API token
under Settings) and put the token in deploy/.env by hand.
"""
import json
import os

from plane.db.models import APIToken, Profile, User, Workspace, WorkspaceMember
from plane.license.models import Instance, InstanceAdmin

ADMIN_EMAIL = os.environ["ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
WS_SLUG = os.environ["WS_SLUG"]
WS_NAME = os.environ["WS_NAME"]
AGENTS = [a for a in os.environ.get("AGENTS", "").split(",") if a]

ROLE_ADMIN, ROLE_MEMBER = 20, 15
out = {"agents": {}, "admin_password_set": False}


def ensure_user(email, display, password=None, role_admin=False):
    user, created = User.objects.get_or_create(
        email=email,
        defaults={"username": email, "display_name": display, "is_password_autoset": True},
    )
    if created and password:
        user.set_password(password)
        user.is_password_autoset = False
        # Recorded so a re-run does not print a freshly generated password that
        # was never actually set — telling someone the wrong sign-in credential
        # is worse than telling them nothing.
        out["admin_password_set"] = True
    # Both flags exist to gate the sign-up flow. A provisioned user has no inbox
    # to verify and no onboarding wizard to walk, so skipping them is the point.
    user.is_email_verified = True
    if role_admin:
        user.is_superuser = user.is_staff = False  # instance admin is separate
    user.save()

    profile, _ = Profile.objects.get_or_create(user=user)
    if not profile.is_onboarded:
        profile.is_onboarded = True
        profile.save()
    return user


def ensure_token(user, workspace, label):
    """One live token per label, so re-running does not litter the account."""
    existing = APIToken.objects.filter(user=user, workspace=workspace, label=label, is_active=True).first()
    if existing:
        return existing.token, False
    return APIToken.objects.create(user=user, workspace=workspace, label=label).token, True


admin = ensure_user(ADMIN_EMAIL, ADMIN_EMAIL.split("@")[0], ADMIN_PASSWORD, role_admin=True)

# Instance admin unlocks Plane's God-mode console at /god-mode/. Instance is
# created by the api container at startup; if it is missing the instance simply
# has no admin yet, which is recoverable and not worth failing the whole run for.
instance = Instance.objects.last()
if instance:
    InstanceAdmin.objects.get_or_create(user=admin, instance=instance, defaults={"role": ROLE_ADMIN})

workspace, ws_created = Workspace.objects.get_or_create(
    slug=WS_SLUG, defaults={"name": WS_NAME, "owner": admin, "organization_size": "1-10"}
)
WorkspaceMember.objects.get_or_create(
    workspace=workspace, member=admin, defaults={"role": ROLE_ADMIN}
)

profile = Profile.objects.get(user=admin)
if profile.last_workspace_id != workspace.id:
    profile.last_workspace_id = workspace.id
    profile.save()

admin_token, _ = ensure_token(admin, workspace, "gateway-service")

# One Plane user per agent. This is what makes attribution real: the gateway
# writes with the agent's own token, so Plane's activity log says "agent-2 moved
# this to In Progress" rather than attributing the whole fleet to one robot.
#
# They are Members, not Guests, because Guests cannot write. The obvious hazard —
# a Member token can set `assignees` directly and so bypass the lease — is why
# these tokens go to the gateway and never to the agent.
for name in AGENTS:
    email = f"{name}@{WS_SLUG}.local"
    u = ensure_user(email, name)
    WorkspaceMember.objects.get_or_create(
        workspace=workspace, member=u, defaults={"role": ROLE_MEMBER}
    )
    token, _ = ensure_token(u, workspace, f"agent-{name}")
    out["agents"][name] = {"user_id": str(u.id), "token": token}

out["workspace_id"] = str(workspace.id)
out["workspace_slug"] = workspace.slug
out["workspace_created"] = ws_created
out["admin_user_id"] = str(admin.id)
out["admin_token"] = admin_token

print("PROVISION_JSON:" + json.dumps(out))
