#!/usr/bin/env bash
#
# Write deploy/.env with real, random secrets.
#
#   ./gen-env.sh [--domain localhost] [--port 80]
#   ./gen-env.sh --behind-proxy --domain plane.example.dev --gateway-domain mcp.example.dev
#
# Use --behind-proxy on a host that already runs a reverse proxy (Caddy, nginx,
# Traefik) owning 80 and 443. It binds this stack to loopback on high ports,
# leaves TLS and certificates to that proxy, and writes a matching Caddyfile
# next to .env. Without it, the bundled proxy is the edge and takes 80/443
# itself, which on such a host simply fails to bind.
#
# This exists because Plane's published compose file ships *working defaults* for
# SECRET_KEY, the MinIO credentials and the RabbitMQ password. They are in the
# public repository, so a stack brought up with them has a signing key and object
# storage that anyone can guess. Copying that file and filling nothing in gives
# you something that boots, which is exactly why it is easy to miss.
set -euo pipefail

cd "$(dirname "$0")"

DOMAIN=localhost
PORT=80
HTTPS_PORT=
BEHIND_PROXY=0
GATEWAY_DOMAIN=
FORCE=0
PLANE_URL=
PLANE_NET=
PLANE_DB=

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --port)       PORT="$2";   shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    # Sit behind a reverse proxy that already terminates TLS on this host.
    --behind-proxy) BEHIND_PROXY=1; shift ;;
    # The hostname agents dial for the gateway. Behind a proxy this becomes
    # GATEWAY_PUBLIC_URL, which is the OAuth issuer and every advertised
    # endpoint — a wrong or missing value sends clients somewhere nothing is
    # listening, and it cannot be inferred from the request behind a proxy.
    --gateway-domain) GATEWAY_DOMAIN="$2"; shift 2 ;;
    # Attach to a Plane you already run instead of deploying one.
    --plane-url)  PLANE_URL="$2"; shift 2 ;;
    --plane-network) PLANE_NET="$2"; shift 2 ;;
    --plane-db)   PLANE_DB="$2"; shift 2 ;;
    --force)      FORCE=1;     shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -e .env ] && [ "$FORCE" -eq 0 ]; then
  cat >&2 <<'MSG'
deploy/.env already exists — refusing to overwrite.

Regenerating is not a harmless retry. Rotating SECRET_KEY signs every existing
session out of Plane; rotating GATEWAY_TOKEN_KEY makes every stored agent Plane
token permanently undecryptable, and they cannot be recovered from a backup taken
after the change. Rotating POSTGRES_PASSWORD leaves the running database on the
old one.

If you really mean it, move the file aside first, or pass --force.
MSG
  exit 1
fi

# `openssl rand` rather than $RANDOM: this needs a CSPRNG, and $RANDOM is a
# 15-bit LCG that would make every one of these guessable.
rand() { openssl rand -hex "$1"; }
randb64() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c "1-$2"; }

# Where this stack listens on the host, and what URL the outside world uses for
# it. Behind a reverse proxy those are two different things, which is the whole
# reason this mode exists: Plane and the gateway both build absolute URLs — login
# redirects, CORS origins, the OAuth issuer — and every one of them must be the
# PUBLIC https address, not the loopback port the proxy happens to forward from.
if [ "$BEHIND_PROXY" -eq 1 ]; then
  [ -n "$GATEWAY_DOMAIN" ] || {
    echo "--behind-proxy also needs --gateway-domain (the hostname agents dial, e.g. mcp.example.dev)" >&2
    exit 2
  }
  [ "$DOMAIN" != "localhost" ] || {
    echo "--behind-proxy also needs --domain (the public hostname for Plane, e.g. plane.example.dev)" >&2
    exit 2
  }

  # Loopback only. The proxy in front is the single way in, so anything bound to
  # a public interface here is a second route that bypasses its TLS.
  BIND=127.0.0.1
  : "${PORT:=80}"
  [ "$PORT" = "80" ] && PORT=8090
  : "${HTTPS_PORT:=$((PORT + 1))}"
  GATEWAY_PORT=8787

  # https, because that is what the front end serves even though this stack
  # speaks plain HTTP behind it. Getting this wrong is not cosmetic: Plane builds
  # sign-in redirects from WEB_URL, so an http:// value sends users out of the
  # secure origin and the login round trip fails.
  WEB_URL="https://${DOMAIN}"
  GATEWAY_URL="https://${GATEWAY_DOMAIN}"
  # No port: the public address is 443 via the front end.
  HOST_PORT="${DOMAIN}"
else
  BIND=0.0.0.0
  GATEWAY_PORT=8787
  GATEWAY_URL=""
  if [ "$PORT" = "80" ]; then
    WEB_URL="http://${DOMAIN}"
    HOST_PORT="${DOMAIN}"
    : "${HTTPS_PORT:=443}"
  else
    WEB_URL="http://${DOMAIN}:${PORT}"
    HOST_PORT="${DOMAIN}:${PORT}"
    # Someone who moved HTTP off 80 is running beside something else, and Plane's
    # proxy binds both ports whether or not TLS is configured. Defaulting HTTPS to
    # 443 there is a near-certain collision, so derive it instead.
    : "${HTTPS_PORT:=$((PORT + 1))}"
  fi
fi

# One stack, two modes. Deploying Plane is the default; giving --plane-url turns
# the Plane services off and points the gateway at an existing instance.
if [ -n "$PLANE_URL" ]; then
  [ -n "$PLANE_NET" ] || { echo "--plane-url also needs --plane-network (the docker network Plane is on; see: docker network ls)" >&2; exit 2; }
  PLANE_DB="${PLANE_DB:-plane-db}"
  MODE_COMMENT="# Attaching to an existing Plane: the bundled Plane services are off, because
# COMPOSE_PROFILES below does not list \`plane\`.
#
# THREE THINGS STILL NEED YOUR INPUT before \`docker compose up -d\`:
#
#   1. POSTGRES_USER / POSTGRES_PASSWORD must be your existing Plane's Postgres
#      superuser. The gateway does not touch Plane's data, but it does need to
#      create its own role and database once, on that same instance.
#   2. PLANE_API_KEY — a token for an Admin or Member user of the workspace,
#      from Plane's Settings. provision.sh cannot mint it here, because it works
#      by running inside the api container, which belongs to your stack.
#   3. PLANE_WORKSPACE_SLUG — the workspace the agents work in.
#
# The Plane-side secrets further down (SECRET_KEY, RabbitMQ, MinIO) are generated
# but unused in this mode. They are written anyway because Compose interpolates
# the whole file regardless of which profiles are active."
  PROFILES=""
  # Must match the existing instance — generating one would be wrong by
  # construction, so leave it obviously blank rather than plausibly wrong.
  PG_USER=plane
  PG_DB=plane
  PG_PASS=""
else
  PLANE_DB="${PLANE_DB:-plane-db}"
  MODE_COMMENT="# Deploying Plane as part of this stack (the \`plane\` profile below). To attach to
# a Plane you already run, set PLANE_BASE_URL and PLANE_NETWORK and drop \`plane\`
# from COMPOSE_PROFILES."
  PROFILES="plane"
  PG_USER=plane
  PG_DB=plane
  PG_PASS="$(randb64 32 24)"
fi

umask 077
cat > .env <<EOF
# Generated by gen-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Secrets — never commit.
#
# PLANE_API_KEY and PLANE_WORKSPACE_SLUG are filled in by ./provision.sh, which
# cannot run until Plane is up: an API token needs a user, and a user needs a
# running instance.
#
${MODE_COMMENT}

# ── which half of the stack runs ─────────────────────────────────────────────
# Compose reads this file, so this switch alone decides what \`docker compose up\`
# brings up. provision.sh appends \`gateway\` once Plane has something to talk to.
COMPOSE_PROFILES=${PROFILES}
# Where the gateway finds Plane. Empty means "the one this stack deploys".
PLANE_BASE_URL=${PLANE_URL}
# The docker network Plane is on. Defaults to this project's own.
PLANE_NETWORK=${PLANE_NET:-sync_plane}
# Host of the Postgres the gateway keeps its lease table in — Plane's, so the two
# ride in one backup, but a separate DATABASE it has no access outside of.
PLANE_DB_HOST=${PLANE_DB}

# ── where it listens ─────────────────────────────────────────────────────────
# Carries the port: Plane builds absolute URLs from this, and dropping it sends
# users to port 80 on a host that is not serving there.
APP_DOMAIN=${HOST_PORT}
LISTEN_HTTP_PORT=${PORT}
LISTEN_HTTPS_PORT=${HTTPS_PORT}
# Which host interface the published ports bind to. 127.0.0.1 when something
# else on this host terminates TLS: that front end is then the only way in, and
# anything bound to a public interface would be a second route that bypasses it.
PROXY_BIND=${BIND}
GATEWAY_BIND=${BIND}
# Plain HTTP. Plane does not require TLS — this tells its proxy to serve :80 and
# never ask for a certificate. For real TLS set this to your domain and fill in
# CERT_EMAIL, and the proxy will provision one over ACME.
#
# Leave it at :80 behind an external reverse proxy. That proxy holds the
# certificate; a second Caddy also trying to answer ACME challenges for the same
# name would fail every one of them and can burn the CA's rate limit for the
# domain.
SITE_ADDRESS=:80
CERT_EMAIL=
CERT_ACME_CA=https://acme-v02.api.letsencrypt.org/directory
# The PUBLIC address, which behind a reverse proxy is not where this stack
# listens. Plane builds sign-in redirects from it, so http:// here when the front
# end serves https sends users out of the secure origin mid-login. Must carry the
# port when there is one.
WEB_URL=${WEB_URL}
CORS_ALLOWED_ORIGINS=${WEB_URL}
GATEWAY_LISTEN_PORT=8787
# How agents reach the gateway from outside. This is the OAuth issuer and the
# base of every endpoint the gateway advertises, so behind a proxy it must be set
# explicitly: the request the gateway sees arrives on plain HTTP at a loopback
# port, and anything derived from it would advertise an address no client can
# reach. Empty is correct only when the gateway is itself the edge.
GATEWAY_PUBLIC_URL=${GATEWAY_URL}

# ── Plane ────────────────────────────────────────────────────────────────────
APP_RELEASE=v1.3.1
# Per API token. Plane defaults to 60/minute, which is sized for a human in a
# browser rather than a fleet of agents making several calls per claim.
API_KEY_RATE_LIMIT=300/minute
SECRET_KEY=$(randb64 64 50)
LIVE_SERVER_SECRET_KEY=$(randb64 48 32)
POSTGRES_USER=${PG_USER}
POSTGRES_DB=${PG_DB}
POSTGRES_PASSWORD=${PG_PASS}
RABBITMQ_USER=plane
RABBITMQ_VHOST=plane
RABBITMQ_PASSWORD=$(randb64 32 24)
AWS_ACCESS_KEY_ID=$(randb64 24 20)
AWS_SECRET_ACCESS_KEY=$(randb64 48 40)
AWS_S3_BUCKET_NAME=uploads

# ── gateway ──────────────────────────────────────────────────────────────────
GATEWAY_DB_PASSWORD=$(randb64 32 24)
# AES-256-GCM key for stored per-agent Plane tokens. Exactly 64 hex characters.
# It stays in this file and never goes into a database: the gateway and Plane
# share a Postgres instance and therefore a backup, so a key sitting beside its
# own ciphertext would protect nothing.
GATEWAY_TOKEN_KEY=$(rand 32)
ALLOW_AGENT_CLOSE=true
PLANE_MCP=on
# Where the code lives, and a read-only token for it. Set both to have `complete`
# check that a cited commit or pull request actually exists, at the moment it is
# cited. Left blank, checking is off and citations are reported "unchecked".
# The token is also what lets the gateway distinguish "no such commit" from "a
# repository I cannot see" — without it, it will never call a citation absent.
GITHUB_REPO=
GITHUB_TOKEN=

# ── filled in by provision.sh ────────────────────────────────────────────────
PLANE_API_KEY=
PLANE_WORKSPACE_SLUG=
PLANE_PROJECT_ID=
EOF

chmod 600 .env
echo "wrote $(pwd)/.env (0600)"

# Compose treats the network as external so that attaching to an existing Plane
# works with the same file. When we are the ones deploying Plane, that means
# creating it here.
if [ -z "$PLANE_URL" ]; then
  if docker network inspect "${PLANE_NET:-sync_plane}" >/dev/null 2>&1; then
    echo "network ${PLANE_NET:-sync_plane} already exists"
  else
    docker network create "${PLANE_NET:-sync_plane}" >/dev/null
    echo "created network ${PLANE_NET:-sync_plane}"
  fi
fi

echo
echo "next:"
if [ -n "$PLANE_URL" ]; then
  echo "  1. edit .env — the three values it asks for at the top"
  echo "  2. docker compose up -d          # bootstraps the gateway's database"
  echo "  3. COMPOSE_PROFILES=gateway docker compose up -d"
  echo "  4. docker compose exec gateway node dist/cli.js issue-token \\"
  echo "       --name worker-1 --principal human:\$(whoami) --plane-token <that agent's Plane token>"
else
  echo "  docker compose up -d      # Plane; first boot pulls ~2GB and takes a few minutes"
  echo "  ./provision.sh            # workspace, project, agent tokens, then the gateway"
fi

# ── the reverse proxy in front, when there is one ────────────────────────────
#
# Written as a file rather than printed once, because the ports here are derived
# and a snippet quoted from memory later will not match what .env actually says.
if [ "$BEHIND_PROXY" -eq 1 ]; then
  cat > Caddyfile.sync <<CADDY
# Generated by gen-env.sh. Add to the Caddy already running on this host.
#
# TWO VARIANTS BELOW. Which one is right depends on whether that Caddy runs on
# the host or in a container, and getting it wrong produces a 502 with a
# perfectly valid certificate — Caddy answers, TLS completes, and only the
# upstream fails, so nothing about the symptom points at the cause.
#
# Check with:  docker ps --filter publish=443
# If a container is listed, Caddy is containerised: use variant B.

# ── A. Caddy runs on the host (systemctl status caddy) ───────────────────────
#
#   import $(pwd)/Caddyfile.sync
#
# 127.0.0.1 here is the host's loopback, which is where this stack publishes.
#
# ${DOMAIN} {
#     reverse_proxy 127.0.0.1:${PORT}
# }
#
# ${GATEWAY_DOMAIN} {
#     reverse_proxy 127.0.0.1:${GATEWAY_PORT} {
#         flush_interval -1
#     }
# }

# ── B. Caddy runs in a container (the common case) ───────────────────────────
#
# 127.0.0.1 inside a container is THAT CONTAINER'S loopback, not the host's, so
# variant A cannot work here — nothing is listening on it. Join Caddy to this
# stack's network and address the services by name instead. In Caddy's own
# compose file:
#
#   services:
#     caddy:
#       networks: [default, ${PLANE_NET:-sync_plane}]
#   networks:
#     ${PLANE_NET:-sync_plane}:
#       external: true
#
# Then \`docker compose up -d caddy\` to attach it, and use the blocks below.
# Traffic stays on the docker network, so the published loopback ports are not
# needed at all in this variant.

${DOMAIN} {
    # Plane's own proxy, which does its internal path routing (/, /god-mode/,
    # /spaces/, /api/, /auth/, /live/ and uploads). Point at it rather than at
    # the individual containers: that routing is upstream's and changes between
    # Plane releases, so reproducing it here would break on the next bump.
    reverse_proxy proxy:80
}

${GATEWAY_DOMAIN} {
    # The agent gateway. Agent tokens are bearer credentials; this hop stays on
    # the docker network.
    reverse_proxy gateway:8787 {
        # MCP streams over Server-Sent Events. Without this Caddy may buffer the
        # response, and a streamed tool result arrives only when the call ends —
        # which for a long call looks exactly like a hung agent.
        flush_interval -1
    }
}
CADDY
  echo "wrote Caddyfile.sync (two variants — read the header, host vs containerised Caddy)"
fi
