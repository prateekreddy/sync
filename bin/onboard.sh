#!/usr/bin/env bash
#
# Point an agent at a sync gateway.
#
#   bin/onboard.sh                        # asks for what it needs
#   bin/onboard.sh --url … --token … -y   # non-interactive, for automation
#
# Nothing is hardcoded. Every value comes from a flag, then the environment, then
# a prompt — in that order — so the same script works for a person setting up a
# laptop and for a provisioning system creating a project.
#
#   --url URL          gateway base URL          (env: SYNC_GATEWAY_URL)
#   --token TOKEN      agent token               (env: SYNC_AGENT_TOKEN)
#   --project UUID     override the project the token is bound to
#                                                (env: SYNC_PROJECT_ID)
#   --client claude|codex                        (env: SYNC_CLIENT; default: detected)
#   --scope local|user|project                   (default: local)
#   --name NAME        MCP server name           (default: sync)
#   -y, --yes          never prompt; fail if something is missing
set -euo pipefail

URL="${SYNC_GATEWAY_URL:-}"
TOKEN="${SYNC_AGENT_TOKEN:-}"
PROJECT="${SYNC_PROJECT_ID:-}"
CLIENT="${SYNC_CLIENT:-}"
SCOPE=local
NAME=sync
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)     URL="$2"; shift 2 ;;
    --token)   TOKEN="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --client)  CLIENT="$2"; shift 2 ;;
    --scope)   SCOPE="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    -y|--yes)  ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

ask() { # ask <prompt> <current> [silent]
  local prompt="$1" current="$2" silent="${3:-}" answer
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  [ "$ASSUME_YES" -eq 1 ] && die "$prompt is required (running with --yes)"
  [ -t 0 ] || die "$prompt is required and there is no terminal to ask on"
  if [ -n "$silent" ]; then read -rsp "$prompt: " answer </dev/tty; echo >&2
  else read -rp "$prompt: " answer </dev/tty; fi
  printf '%s' "$answer"
}

URL=$(ask "Gateway URL (e.g. https://mcp.example.dev)" "$URL")
[ -n "$URL" ] || die "no gateway URL"
URL="${URL%/}"
case "$URL" in http://*|https://*) ;; *) die "URL must start with http:// or https://" ;; esac

# Refuse to send a bearer token over plaintext to anything but the local machine.
# An agent token is a credential; over the open internet in the clear it is a
# credential anyone on the path can copy and use.
case "$URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*|http://host.docker.internal*|http://[::1]*) ;;
  *) die "refusing to send an agent token unencrypted to $URL — use https, or a local address" ;;
esac

TOKEN=$(ask "Agent token (sync_agent_…)" "$TOKEN" silent)
[ -n "$TOKEN" ] || die "no agent token"

# ── verify before registering ────────────────────────────────────────────────
# Registering first and discovering the problem later means debugging inside an
# agent session, where the only symptom is a tool that is not there.
echo "checking ${URL}/mcp …"
probe=$(curl -sS -m 20 -X POST "${URL}/mcp" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"onboard","version":"1"}}}' \
  2>&1) || die "could not reach ${URL}/mcp — $probe"

case "$probe" in
  *'"serverInfo"'*) ;;
  *UNAUTHENTICATED*) die "the gateway rejected that token. Ask your operator to issue a new one." ;;
  # Easy mistake: Plane and the gateway usually live on sibling hostnames, and
  # pointing at Plane returns its web app. Say that, rather than printing a page
  # of HTML at someone who is only trying to set up a tool.
  *'<html'*|*'<!DOCTYPE'*|*'<!doctype'*)
    die "$URL served a web page, not a gateway. This wants the gateway host (often mcp.<your-plane-host>), not Plane itself." ;;
  *) die "unexpected reply from ${URL}/mcp: $(printf '%s' "$probe" | tr -d '\n' | head -c 200)" ;;
esac

tools=$(curl -sS -m 20 -X POST "${URL}/mcp" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 2>/dev/null \
  | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin)["result"]["tools"]))
except Exception: print("?")' 2>/dev/null || echo '?')
echo "  ok — ${tools} tools available"

# ── which client ─────────────────────────────────────────────────────────────
if [ -z "$CLIENT" ]; then
  if command -v claude >/dev/null 2>&1; then CLIENT=claude
  elif command -v codex >/dev/null 2>&1; then CLIENT=codex
  else CLIENT=$(ask "Client (claude or codex)" "" ); fi
fi

case "$CLIENT" in
  claude)
    command -v claude >/dev/null 2>&1 || die "the claude CLI is not on PATH"
    claude mcp remove "$NAME" >/dev/null 2>&1 || true
    if [ "$SCOPE" = project ]; then
      # A project-scoped server lives in .mcp.json, which is committed — so the
      # token must be a reference, never a literal. It also needs a one-time
      # approval the first time someone opens the repo.
      python3 - "$NAME" "$URL" <<'PY'
import json, os, pathlib, sys
name, url = sys.argv[1], sys.argv[2]
p = pathlib.Path('.mcp.json')
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg.setdefault('mcpServers', {})[name] = {
    'type': 'http',
    'url': '${SYNC_GATEWAY_URL:-' + url + '}/mcp',
    'headers': {'Authorization': 'Bearer ${SYNC_AGENT_TOKEN}'},
}
p.write_text(json.dumps(cfg, indent=2) + '\n')
print(f'wrote .mcp.json (server "{name}")')
PY
      cat <<EOF

  .mcp.json holds no secret: it reads SYNC_AGENT_TOKEN from the environment, so
  each agent supplies its own. Export it where your agents run:

    export SYNC_AGENT_TOKEN=<that agent's token>

  Project-scoped servers need approving once per machine — Claude Code will ask
  the first time, or pre-approve by adding "$NAME" to enabledMcpjsonServers for
  this project in ~/.claude.json.
EOF
    else
      claude mcp add --transport http --scope "$SCOPE" "$NAME" "${URL}/mcp" \
        --header "Authorization: Bearer ${TOKEN}" >/dev/null
      echo "registered \"$NAME\" with Claude Code (scope: $SCOPE)"
      claude mcp list 2>/dev/null | grep -E "^${NAME}:" || true
    fi
    ;;

  codex)
    # Codex's config is TOML and may already have hand-written entries, so print
    # rather than rewrite it. Losing someone's config to a careless edit is worse
    # than asking them to paste four lines.
    cat <<EOF

Add this to ~/.codex/config.toml:

  [mcp_servers.${NAME}]
  url = "${URL}/mcp"
  http_headers = { Authorization = "Bearer ${TOKEN}" }

If your Codex build does not accept an HTTP MCP server, use the stdio bridge
instead (build it once with: cd mcp && npm ci && npm run build):

  [mcp_servers.${NAME}]
  command = "node"
  args = ["$(cd "$(dirname "$0")/../mcp" 2>/dev/null && pwd || echo /path/to)/dist/index.js"]
  env = { SYNC_GATEWAY_URL = "${URL}", SYNC_AGENT_TOKEN = "${TOKEN}" }
EOF
    ;;
  *) die "unknown client: $CLIENT (expected claude or codex)" ;;
esac

# ── project ──────────────────────────────────────────────────────────────────
if [ -n "$PROJECT" ]; then
  cat <<EOF

Project override: ${PROJECT}
  The token already carries a default project, so this is only needed to point
  this box at a different one. Set it where your agent runs:

    export SYNC_PROJECT_ID=${PROJECT}
EOF
fi

cat <<'EOF'

Done. Two things worth doing next, neither automatic:

  * Add the discipline to the repo's CLAUDE.md / AGENTS.md. The server tells the
    model the rules on connect, but not every client surfaces that, and a repo
    file is the one place guaranteed to be in context. See docs/onboarding.md.

  * Check what you are holding before starting work: ask the agent to call
    `held`. After a crash or a restart that is the only way it finds out what it
    had already claimed.
EOF
