#!/usr/bin/env bash
#
# Turn a running-but-empty Plane into a working agent fleet.
#
#   ./provision.sh [--agents worker-1,worker-2,worker-3] [--project "Sync Platform"]
#
# Creates: an admin you can sign in as, a workspace, a project with Plane's
# default workflow states, one Plane user per agent, and the gateway tokens the
# agents authenticate with. Then starts the gateway.
#
# Idempotent — safe to re-run to add agents or repair a half-finished setup. It
# never prints a token it did not just create, because only hashes are kept.
set -euo pipefail

cd "$(dirname "$0")"

AGENTS="worker-1,worker-2,worker-3"
PROJECT_NAME="Sync Platform"
PROJECT_ID_PREFIX="SYNC"
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
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "deploy/.env is missing — run ./gen-env.sh first" >&2; exit 1; }
set -a; . ./.env; set +a

PORT="${LISTEN_HTTP_PORT:-80}"
BASE="http://localhost:${PORT}"
dc() { docker compose "$@"; }

# ── 1. wait for Plane ────────────────────────────────────────────────────────
# First boot runs Django migrations against an empty database, which takes a
# while. Poll the API rather than the container: "running" is not "ready".
printf 'waiting for Plane to answer on %s ' "$BASE"
for i in $(seq 1 120); do
  if curl -fsS -o /dev/null "${BASE}/api/instances/" 2>/dev/null; then ok=1; break; fi
  printf '.'; sleep 5
done
echo
[ "${ok:-0}" = 1 ] || { echo "Plane did not become ready. Try: docker compose logs api" >&2; exit 1; }

# ── 2. users, workspace, tokens ──────────────────────────────────────────────
echo "provisioning workspace '${WS_SLUG}' and agents: ${AGENTS}"
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

# ── 3. project and project members, through the public API ───────────────────
# Agents must be project members or every write comes back 403 — which is a
# baffling way to find out that provisioning half-failed, so plane_api.py treats
# any failure here as fatal rather than pressing on.
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

echo "starting the gateway"
dc up -d --build gateway

for i in $(seq 1 60); do
  curl -fsS -o /dev/null "http://localhost:${GATEWAY_LISTEN_PORT:-8787}/healthz" 2>/dev/null && break
  sleep 2
done

# ── 5. agent credentials ─────────────────────────────────────────────────────
# The agent gets ONLY the gateway token below. It must never receive the Plane
# token that sits behind it: a Plane Member key lets an agent set `assignees`
# directly, which silently bypasses the lease and puts two agents on one item.
echo
echo "───────────────────────────────────────────────────────────────────────"
echo " Agent credentials — shown once. Only hashes are stored."
echo "───────────────────────────────────────────────────────────────────────"
for name in $(printf '%s' "$AGENTS" | tr ',' ' '); do
  uid=$(jq_ "['agents']['${name}']['user_id']")
  ptok=$(jq_ "['agents']['${name}']['token']")
  gtok=$(dc exec -T gateway node dist/cli.js issue-token \
      --name "$name" --principal "human:$(whoami)" \
      --plane-user "$uid" --plane-token "$ptok" \
      --project "$PROJECT_ID" \
    | grep -oE 'sync_agent_[a-f0-9]+' | head -1)
  printf '  %-12s %s\n' "$name" "$gtok"
done

cat <<EOF

───────────────────────────────────────────────────────────────────────
 Plane      ${WEB_URL:-http://localhost:${PORT}}
 sign in    ${ADMIN_EMAIL}
 password   ${ADMIN_PASSWORD}
 project    ${PROJECT_ID}

 Point each agent at it, with that agent's token from above:

   claude mcp add --transport http sync <gateway-url>/mcp \\
     --header "Authorization: Bearer <token>"

 Nothing to install on the agent box, and no project to configure — the
 token carries it. Use bin/onboard.sh to have the endpoint checked first,
 or for Codex config. See docs/onboarding.md.

 Anyone else can onboard themselves without this script and without a
 shell here: they create a personal token in Plane's UI and POST it to
 <gateway-url>/v1/agent-tokens. Set MINT_TOKENS=off to disable that.

 <gateway-url> is however this gateway is reachable from the agent, e.g.
 https://mcp.your-host, or http://<this-host>:${GATEWAY_LISTEN_PORT:-8787}
 on a trusted network. Send tokens over TLS: they are bearer credentials.
───────────────────────────────────────────────────────────────────────
EOF

[ "$WS_CREATED" = "True" ] || echo "note: workspace already existed; nothing was overwritten."
