#!/usr/bin/env bash
#
# Turn a running-but-empty Plane into a tracker your agents can use.
#
#   ./provision.sh
#   ./provision.sh --identifier SYNC --project "Sync Platform"
#   ./provision.sh --identifier PLANE          # adopt a project made in the UI
#
# Creates: an admin you can sign in as, a workspace, and the gateway. That is all
# it creates on its own.
#
# --identifier makes a project with Plane's default workflow states, or adopts an
# existing one with that identifier — which is how you grant the gateway's own
# account the project membership every one of its reads depends on. Run it again
# for each project the gateway should serve.
#
# --agents mints Plane users and gateway tokens up front. Without it none are
# created, because people mint their own through the browser sign-in or
# /v1/agent-tokens, and an unused agent is a real Plane account with real access.
#
# Idempotent — safe to re-run to add agents or repair a half-finished setup. It
# never prints a token it did not just create, because only hashes are kept.
set -euo pipefail

cd "$(dirname "$0")"

# Deliberately empty. This used to default to three workers, so every deployment
# got three Plane users and three gateway tokens whether anyone had asked for one
# or not — accounts nobody signs into, each a real project member. Minting is
# self-service (the browser sign-in, or POST /v1/agent-tokens), so provisioning
# does not need to guess; --agents is still here for the case where a script
# genuinely wants them up front.
AGENTS=""
# Also empty, for the same reason as AGENTS. This used to create a project called
# "Sync Platform" on every run whether the deployment wanted one or not, so an
# install whose work lives in projects made elsewhere got a permanently empty
# SYNC board beside them.
#
# Naming one is how you ask for it, and it is also the repair path for a project
# made in Plane's UI: pass an identifier that already exists and provisioning
# adopts it rather than creating a second, which is what grants the gateway's own
# account the membership its reads depend on.
PROJECT_NAME=""
PROJECT_ID_PREFIX=""
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@sync.local}"
WS_SLUG="${WS_SLUG:-sync}"
WS_NAME="${WS_NAME:-Sync}"

while [ $# -gt 0 ]; do
  case "$1" in
    --agents)     AGENTS="$2"; shift 2 ;;
    --project)    PROJECT_NAME="$2"; shift 2 ;;
    --identifier) PROJECT_ID_PREFIX="$2"; shift 2 ;;
    --email)      ADMIN_EMAIL="$2"; shift 2 ;;
    --workspace)  WS_SLUG="$2"; shift 2 ;;
    -h|--help)    sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "deploy/.env is missing — run ./gen-env.sh first" >&2; exit 1; }
set -a; . ./.env; set +a

PORT="${LISTEN_HTTP_PORT:-80}"
dc() { docker compose "$@"; }

# ── how this script reaches the services ─────────────────────────────────────
#
# Not via http://localhost:$LISTEN_HTTP_PORT. That variable says what Compose was
# *asked* to publish, which is not the same as what is reachable — and when Plane
# runs behind an external reverse proxy the right deployment gives its proxy no
# host binding at all and reaches it container-to-container.
#
# Assuming the port silently does the wrong thing in exactly that setup: :80 is
# then the *other* reverse proxy. If it 404s, the readiness poll below burns its
# full ten minutes and blames Plane; if it happens to answer 200 on
# /api/instances/, provisioning proceeds against a server that is not this one.
#
# So ask Docker where the service actually is, in decreasing order of authority:
#
#   1. An explicit override from the caller (PROVISION_BASE_URL /
#      PROVISION_GATEWAY_URL) — the escape hatch for anything unguessable.
#   2. Whatever Compose actually published, if it published anything.
#   3. The container's own address on the Plane network, which the host can reach
#      directly under the bridge driver — so no host port needs to exist at all.
#
# `docker compose port` prints "invalid IP:0" rather than an empty string for a
# service with no published port, so this matches a real host:port shape instead
# of testing for emptiness.
service_base() {
  local svc=$1 cport=$2 mapped hp pp cid cip

  mapped=$(dc port "$svc" "$cport" 2>/dev/null | tail -1)
  case "$mapped" in
    *:[1-9]*)
      hp=${mapped%:*}; pp=${mapped##*:}
      # A wildcard bind is not an address to connect to.
      case "$hp" in 0.0.0.0 | '[::]' | '::' | '') hp=127.0.0.1 ;; esac
      printf 'http://%s:%s' "$hp" "$pp"; return 0 ;;
  esac

  cid=$(dc ps -q "$svc" 2>/dev/null | head -1)
  [ -n "$cid" ] || return 1
  cip=$(docker inspect \
    -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$cid" \
    2>/dev/null | awk '{print $1}')
  [ -n "$cip" ] || return 1
  printf 'http://%s:%s' "$cip" "$cport"
}

# ── 1. wait for Plane ────────────────────────────────────────────────────────
# First boot runs Django migrations against an empty database, which takes a
# while. Poll the API rather than the container: "running" is not "ready".
#
# Resolution is retried inside the loop, not done once up front: on a cold
# `up -d` the proxy container may not exist yet when this line is reached, and
# failing then would be a race rather than a real error.
BASE="${PROVISION_BASE_URL:-}"; BASE="${BASE%/}"
printf 'waiting for Plane '
for i in $(seq 1 120); do
  [ -n "$BASE" ] || BASE=$(service_base proxy 80 || true)
  if [ -n "$BASE" ] && curl -fsS -o /dev/null "${BASE}/api/instances/" 2>/dev/null; then
    ok=1; break
  fi
  printf '.'; sleep 5
done
echo
[ "${ok:-0}" = 1 ] || {
  echo "Plane did not become ready${BASE:+ at $BASE}." >&2
  echo "Try: docker compose logs api" >&2
  echo "If Plane is reachable somewhere this could not infer, set PROVISION_BASE_URL." >&2
  exit 1
}
echo "reaching Plane at ${BASE}"

# ── 2. users, workspace, tokens ──────────────────────────────────────────────
echo "provisioning workspace '${WS_SLUG}'${AGENTS:+ and agents: ${AGENTS}}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '\n=+/' | cut -c1-16)}"

RAW=$(dc exec -T \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e WS_SLUG="$WS_SLUG" \
  -e WS_NAME="$WS_NAME" \
  -e AGENTS="$AGENTS" \
  api python manage.py shell < provision.py)

JSON=$(printf '%s' "$RAW" | sed -n 's/^PROVISION_JSON://p' | tail -1)
[ -n "$JSON" ] && [ "${JSON#\{}" != "$JSON" ] || {
  echo "provisioning failed; Plane said:" >&2
  printf '%s\n' "$RAW" | tail -20 >&2
  exit 1
}

jq_() { printf '%s' "$JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
ADMIN_TOKEN=$(jq_ "['admin_token']")
WS_CREATED=$(jq_ "['workspace_created']")
# The password is only set when the account is created. On a re-run the freshly
# generated one above was never applied, so it must not be shown as if it were.
if [ "$(jq_ "['admin_password_set']")" != "True" ]; then
  ADMIN_PASSWORD="(unchanged — set when the account was created)"
fi

# provision.py marked the instance set up, which the api caches — so until it is
# restarted it keeps serving is_setup_done=false and the whole UI stays pinned to
# the setup wizard, which cannot complete now that an instance admin exists. The
# database is right and the browser is stuck: the confusing failure this avoids.
# Only on the run that actually flipped it, so re-runs cost nothing.
if [ "$(jq_ "['setup_done_flipped']")" = "True" ]; then
  echo "instance marked set up; restarting api to drop its cached config"
  dc restart api >/dev/null 2>&1 || true
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "${BASE}/api/instances/" 2>/dev/null && break
    sleep 5
  done
fi

# ── 3. project access, through the public API ────────────────────────────────
# Runs every time, project or no project. Two different things happen here and
# only one of them is optional:
#
#   The gateway's own account is made a member of EVERY project, always. It reads
#   with PLANE_API_KEY rather than with the caller's token, so without that it
#   can serve nothing — and re-running is what picks up a project created since,
#   because Plane offers no hook that says one appeared.
#
#   A project is created or adopted only when --identifier or --project asked for
#   one, and only that project gets the agents added to it. Agents must be
#   members or every write comes back 403, which is a baffling way to find out
#   that provisioning half-failed — so plane_api.py treats any failure here as
#   fatal rather than pressing on.
if [ -n "$PROJECT_ID_PREFIX" ] || [ -n "$PROJECT_NAME" ]; then
  # Either flag alone is enough to mean "yes, a project". The identifier is the
  # part Plane matches on, so it is the one derived when only a name was given.
  if [ -z "$PROJECT_ID_PREFIX" ]; then
    PROJECT_ID_PREFIX=$(printf '%s' "$PROJECT_NAME" | tr -cd '[:alnum:]' | tr '[:lower:]' '[:upper:]' | cut -c1-5)
    [ -n "$PROJECT_ID_PREFIX" ] || { echo "--project '${PROJECT_NAME}' has no letters or digits to build an identifier from; pass --identifier" >&2; exit 2; }
  fi
  [ -n "$PROJECT_NAME" ] || PROJECT_NAME="$PROJECT_ID_PREFIX"
fi

MEMBER_IDS=""
for name in $(printf '%s' "$AGENTS" | tr ',' ' '); do
  MEMBER_IDS="$MEMBER_IDS $(jq_ "['agents']['${name}']['user_id']")"
done

# shellcheck disable=SC2086
PROJECT_ID=$(python3 plane_api.py "$BASE" "$ADMIN_TOKEN" "$WS_SLUG" \
  "$PROJECT_NAME" "$PROJECT_ID_PREFIX" $MEMBER_IDS)

# ── 4. record what the gateway needs, then start it ──────────────────────────
python3 - "$JSON" "$PROJECT_ID" "$WS_SLUG" <<'PY'
import json, re, sys
data, project_id, slug = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
env = open('.env').read()

def put(key, value):
    global env
    line = f'{key}={value}'
    env = (re.sub(rf'^{key}=.*$', line, env, flags=re.M)
           if re.search(rf'^{key}=', env, flags=re.M) else env.rstrip() + '\n' + line + '\n')

put('PLANE_API_KEY', data['admin_token'])
put('PLANE_WORKSPACE_SLUG', slug)
# Only when a project was provisioned. Writing an empty value would look like a
# configured default that resolves to nothing.
if project_id:
    put('PLANE_PROJECT_ID', project_id)

# Compose reads COMPOSE_PROFILES from this file, so from here on a plain
# `docker compose up -d` brings the gateway up with everything else. Append
# rather than replace: overwriting would switch off the `plane` profile and take
# the whole instance down on the next `up`.
m = re.search(r'^COMPOSE_PROFILES=(.*)$', env, flags=re.M)
active = [p for p in (m.group(1).split(',') if m else []) if p]
if 'gateway' not in active:
    active.append('gateway')
put('COMPOSE_PROFILES', ','.join(active))
open('.env', 'w').write(env)
PY

# Re-read BEFORE calling Compose, not after. This script exported the old values
# at the top, and Compose gives the shell environment precedence over the .env
# file — so without this the gateway would start with the empty PLANE_API_KEY
# that was exported before provisioning filled it in, and crash-loop.
set -a; . ./.env; set +a

# ── stamp the image with the commit it is built from ─────────────────────────
#
# So `curl <gateway>/healthz` answers "did my deploy take?" directly. Without
# this the only checks available were probing a behaviour known to have changed,
# or a shell on the host — and the first one produced a wrong answer, confidently
# reported, on 2026-08-03.
#
# Not fatal when there is no repo (a tarball deploy, or .git excluded): the sha
# is reported as null, which is at least true. Exported because Compose reads
# build args from the shell environment.
export GIT_SHA BUILD_TIME
GIT_SHA=$(git -C .. rev-parse HEAD 2>/dev/null || echo "")
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -n "$GIT_SHA" ] && [ -n "$(git -C .. status --porcelain 2>/dev/null)" ]; then
  # Said out loud rather than encoded in the sha, because a "-dirty" suffix does
  # not compare equal to anything and the check below would report a mismatch
  # for a deploy that is working exactly as asked.
  echo "note: the working tree has uncommitted changes, so the image will not match $GIT_SHA exactly" >&2
fi

echo "starting the gateway${GIT_SHA:+ at ${GIT_SHA:0:7}}"
dc up -d --build gateway

# Same reasoning as the Plane poll above: GATEWAY_LISTEN_PORT is what Compose was
# asked to publish, and behind a reverse proxy the gateway deliberately publishes
# nothing — it is reached only through that proxy, because agent tokens are bearer
# credentials and should not be answering on a public port.
GW="${PROVISION_GATEWAY_URL:-}"; GW="${GW%/}"
gw_ok=0
health=""
for i in $(seq 1 60); do
  [ -n "$GW" ] || GW=$(service_base gateway 8787 || true)
  if [ -n "$GW" ] && health=$(curl -fsS "${GW}/healthz" 2>/dev/null); then
    gw_ok=1; break
  fi
  sleep 2
done

# ── did the deploy take? ─────────────────────────────────────────────────────
#
# The whole point of stamping the image: compare what we just built against what
# is now answering, without inferring it from behaviour. A container that failed
# to replace its predecessor keeps serving, and every other signal here — the
# health poll, `docker compose ps` — reports success while the old code runs.
if [ "$gw_ok" = 1 ] && [ -n "$GIT_SHA" ]; then
  live=$(printf '%s' "$health" | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p')
  if [ "$live" = "$GIT_SHA" ]; then
    echo "gateway is live at ${GIT_SHA:0:7}"
  elif [ -z "$live" ]; then
    # Two causes, and they are worth telling apart: a gateway older than this
    # feature has no build key at all, whereas a current one built without the
    # arg reports it as null.
    case "$health" in
      *'"build"'*) echo "warning: gateway reports no commit sha — built without GIT_SHA" >&2 ;;
      *) echo "warning: gateway does not report a build identity, so it predates this deploy script" >&2 ;;
    esac
  else
    echo "warning: gateway is serving ${live:0:7}, not the ${GIT_SHA:0:7} just built — the old container may still be up" >&2
  fi
fi
# Not fatal — token issuance below goes through `docker compose exec`, not HTTP,
# so it can still succeed. But say so, because the previous version of this loop
# fell through silently and left a dead gateway looking like a clean install.
[ "$gw_ok" = 1 ] || echo "warning: gateway did not answer /healthz${GW:+ at $GW}; check: docker compose logs gateway" >&2

# ── 5. agent credentials ─────────────────────────────────────────────────────
# Only when asked for. See the note on AGENTS: minting is self-service, so the
# ordinary run creates none and this section says nothing.
#
# The agent gets ONLY the gateway token below. It must never receive the Plane
# token that sits behind it: a Plane Member key lets an agent set `assignees`
# directly, which silently bypasses the lease and puts two agents on one item.
if [ -n "$AGENTS" ]; then
  echo
  echo "───────────────────────────────────────────────────────────────────────"
  echo " Agent credentials — shown once. Only hashes are stored."
  echo "───────────────────────────────────────────────────────────────────────"
  for name in $(printf '%s' "$AGENTS" | tr ',' ' '); do
    uid=$(jq_ "['agents']['${name}']['user_id']")
    ptok=$(jq_ "['agents']['${name}']['token']")
    # The principal is the human the agent acts for, and it ends up in
    # `holderChain` and on every Plane comment the agent writes. It used to be
    # `$(whoami)` — the shell account running this script, so a deployment
    # provisioned as root attributed all its agents to `human:root`, which is
    # not a person and cannot be looked up. The admin is the identity this
    # install actually has.
    # Bound to a project only if there is one. An agent with no default names a
    # project on every call, which is the documented behaviour — passing an
    # empty --project instead would bind it to nothing and fail later.
    gtok=$(dc exec -T gateway node dist/cli.js issue-token \
        --name "$name" --principal "human:${ADMIN_EMAIL}" \
        --plane-user "$uid" --plane-token "$ptok" \
        ${PROJECT_ID:+--project "$PROJECT_ID"} \
      | grep -oE 'sync_agent_[a-f0-9]+' | head -1)
    printf '  %-12s %s\n' "$name" "$gtok"
  done
fi

cat <<EOF

───────────────────────────────────────────────────────────────────────
 Plane      ${WEB_URL:-http://localhost:${PORT}}
 sign in    ${ADMIN_EMAIL}
 password   ${ADMIN_PASSWORD}
 project    ${PROJECT_ID:-none — make one in Plane, then re-run with --identifier <ID> so the gateway can read it}

 Point each agent at it, with that agent's token from above:

   claude mcp add --transport http sync <gateway-url>/mcp \\
     --header "Authorization: Bearer <token>"

 Nothing to install on the agent box, and no project to configure — the
 token carries it. Use bin/onboard.sh to have the endpoint checked first,
 or for Codex config. See docs/onboarding.md.

 Anyone else can onboard themselves, without this script and without a
 shell here, using no token on the command line at all:

   claude mcp add --transport http sync <gateway-url>/mcp
   claude mcp login sync

 They sign in with their own Plane personal token and get an agent scoped
 to them. Set GATEWAY_PUBLIC_URL in .env so sign-in advertises the right
 address; MINT_TOKENS=off disables self-service entirely.

 <gateway-url> is however this gateway is reachable from the agent, e.g.
 https://mcp.your-host, or http://<this-host>:${GATEWAY_LISTEN_PORT:-8787}
 on a trusted network. Send tokens over TLS: they are bearer credentials.
───────────────────────────────────────────────────────────────────────
EOF

[ "$WS_CREATED" = "True" ] || echo "note: workspace already existed; nothing was overwritten."
