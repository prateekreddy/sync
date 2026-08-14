# Running your own sync

Everything the gateway needs to run: standing the stack up, putting it behind a
proxy you already own, and the operational detail that only matters once it is
serving traffic. If you just want to *use* a sync somebody else runs, you want
the [top-level README](../README.md) instead — none of this applies to you.

Everything is one Docker Compose stack in `deploy/`. Whether it also deploys Plane is
decided by one line in `.env`.

## Deploy Plane too (default)

```bash
cd deploy
./gen-env.sh --domain your-host --port 80   # writes .env with real secrets
docker compose up -d                        # first boot pulls ~2GB
./provision.sh                              # admin, workspace, gateway
```

`provision.sh` prints the Plane sign-in. That is the whole server install.

It creates **no project and no agents**. Make projects in Plane however you like,
then run it again — with no flags — so the gateway can read them:

```bash
./provision.sh                              # picks up every project, incl. new ones
./provision.sh --identifier SYNC --project "Sync Platform"   # or make one here
```

That second run is not optional for a project you want the gateway to serve, and it
is not about creating anything — see **What provisioning does** below for why the
gateway needs its own membership. Agents work the same way: people mint their own by
signing in through the browser, so an account exists because somebody asked for one.
Pass `--agents worker-1,worker-2` to have them up front instead.

Do not skip `gen-env.sh`. Plane's published compose file ships *working defaults* for
`SECRET_KEY`, the MinIO credentials and the RabbitMQ password — they are in a public
repository, so a stack brought up with them has a session-signing key and object
storage anyone can guess. It boots fine, which is exactly why it is easy to miss.

## Deploy behind a reverse proxy you already run

On a host where Caddy, nginx or Traefik already owns 80 and 443:

```bash
cd deploy
./gen-env.sh --behind-proxy \
  --domain plane.example.dev --gateway-domain mcp.example.dev
docker compose up -d
./provision.sh
```

This binds the whole stack to **loopback only** — Plane on `127.0.0.1:8090`, the
gateway on `127.0.0.1:8787` — and leaves TLS to the proxy in front. It also writes
`deploy/Caddyfile.sync`, two blocks to import from your existing Caddyfile:

```caddy
plane.example.dev  { reverse_proxy 127.0.0.1:8090 }
mcp.example.dev    { reverse_proxy 127.0.0.1:8787 { flush_interval -1 } }
```

Three things this mode gets right that setting the ports by hand does not:

- **`GATEWAY_PUBLIC_URL` is written.** It is the OAuth issuer and the base of every
  endpoint the gateway advertises. Behind a proxy the request arrives on plain HTTP
  at a loopback port, so anything inferred from it advertises an address no client
  can reach, and sign-in fails in a way that looks like a client bug.
- **`WEB_URL` and `CORS_ALLOWED_ORIGINS` become `https://`.** Plane builds sign-in
  redirects from `WEB_URL`; an `http://` value behind an `https://` front end drops
  users out of the secure origin mid-login.
- **`SITE_ADDRESS` stays `:80`.** Plane's bundled proxy never asks for a
  certificate. Two proxies answering ACME challenges for one name fail every
  challenge and can burn the CA's rate limit for the domain.

Plane's bundled proxy still runs, and should: it does Plane's internal path routing
(`/god-mode/`, `/spaces/`, `/api/`, `/auth/`, `/live/`, uploads). That routing is
upstream's and changes between releases, so pointing your proxy at the individual
containers instead would break on the next version bump. It binds nothing public in
this mode.

**Is your proxy itself a container?** Check with `docker ps --filter publish=443`. If
it is, the block above cannot work: `127.0.0.1` inside a container is *that
container's* loopback, and nothing is listening on it. The symptom is a 502 with a
perfectly valid certificate, which points at nothing. Join the proxy to this stack's
network and address the services by name:

```yaml
# in your proxy's own compose file
services:
  caddy:
    networks: [default, sync_plane]      # PLANE_NETWORK from deploy/.env
networks:
  sync_plane:
    external: true
```

```caddy
plane.example.dev  { reverse_proxy proxy:80 }
mcp.example.dev    { reverse_proxy gateway:8787 { flush_interval -1 } }
```

Traffic then stays on the Docker network, so the published loopback ports are not
needed at all — drop them with a `docker-compose.override.yml` if you prefer no host
bindings whatsoever:

```yaml
services:
  proxy:
    ports: !override []
  gateway:                  # agent tokens are bearer credentials; keep it unpublished
    ports: !override []
```

`provision.sh` needs no host port either way — it asks Docker where each service is.
Two overrides exist for what it cannot infer, neither normally needed:

| Variable | Use when |
|---|---|
| `PROVISION_BASE_URL` | Plane is reachable somewhere Docker cannot report |
| `PROVISION_GATEWAY_URL` | same, for the gateway's `/healthz` poll |

Nothing in the stack can know your proxy's public hostname, so the summary prints
`<gateway-url>` for you to substitute. Set `SYNC_GATEWAY_URL` in `.env` to have it
printed for real.

## Attach to a Plane you already run

```bash
cd deploy
./gen-env.sh --plane-url http://proxy --plane-network plane-app_default
# then fill in the three values .env asks for at the top, and:
docker compose up -d                                 # bootstraps the gateway's database
COMPOSE_PROFILES=gateway docker compose up -d
```

This turns off the bundled Plane services and points the gateway at yours. Fill in
the three values `.env` asks for at the top: the Postgres superuser credentials (to
create the gateway's own database once), a Plane API token, and the workspace slug.

`provision.sh` does not run in this mode — it executes inside the `api` container,
which belongs to your stack. Do the same four things in Plane's UI instead: sign
up, create the workspace, create the project, create an API token, then put the
token in `deploy/.env` as `PLANE_API_KEY`.

Also turn **Modules** on in the project's settings. Plane gates them per project,
and provisioning normally does it for you; without it every module call fails,
and the 404 reads like a wrong URL rather than a disabled feature.

And add the user that owns that API token to the project as a Member. The gateway
reads with it, not with the caller's token, so without the membership `find`,
`board`, `why`, `next` and `claim` all answer `Plane 403 on GET
/projects/<id>/states/` while writes and comments keep working. Provisioning does
this for you; in this mode nobody does.

## What provisioning does

`provision.sh` creates the admin account and the workspace. It marks the instance set
up and restarts the `api` container on the run that does so, because that container
caches the flag.

**Every run gives the gateway's own account access to every project in the
workspace.** No flag asks for it. That matters more than it sounds: the gateway
reads with `PLANE_API_KEY` rather than with the caller's token, so `find`, `board`,
`why`, `next` and the `claim` precheck all run as that account. Without the
membership every one of them answers `Plane 403 on GET /projects/<id>/…` while
comments and issue reads keep working — a gateway that looks half-broken rather
than one missing a permission.

Re-run it after making a project, in the UI or anywhere else: Plane offers no hook
that says one appeared, so a re-run is how the gateway picks it up.

This one step goes through Plane's ORM (`grant_access.py`) rather than its public
API, which is the only part of provisioning that does. The API cannot do it, twice
over: `GET /projects/` shows you only the projects you are already in plus the
public ones, so a private project you were never added to is invisible; and
`POST /projects/<id>/members/` requires you to be a project **admin of that
project** already, so an account outside it cannot let itself in. A loop over the
public API therefore skips exactly the projects that need fixing and reports
success — which is what happened, twice, before this existed.

Authorisation is unaffected: it stays the caller's, checked per request against
their own Plane project list before the service client is used at all
(`server/src/access.ts`; `server/test/serviceaccess.test.ts` fails if a route
forgets). The service account's breadth is what makes those reads possible, not
what decides who may have them.

With `--identifier` it also creates a project with Plane's default workflow states —
or **adopts an existing one** with that identifier. Nothing is created twice, so
re-running against an existing project only repairs it. You need this only to have
provisioning make a project, or to put `--agents` on one.

With `--agents` it creates one Plane user per agent, an API token for each, and the
gateway tokens. Without it, none — see **Adding an agent** in
[`docs/onboarding.md`](../docs/onboarding.md) for the self-service path.

It is idempotent — re-run it to pick up new projects, add agents, or repair a
half-finished setup.

If a Plane upgrade breaks it, do the same four things in the UI (sign up, workspace,
project, API token) and put the token in `deploy/.env`.


## Operating notes

**Taking work back from an agent.** Do it in Plane, the way you would with a
person: unassign them, or close the item. Within about thirty seconds the lease is
revoked, the agent is told in plain words on its next check, and its next attempt
to write anything against that item is refused — with advice not to re-claim it,
because you decided it was not theirs.

Nothing is written back to Plane when this happens. The revocation exists
*because* of what Plane says, so mirroring would be the gateway arguing with your
edit.

Only those two acts count. Retitling, reprioritising or relabelling an item does
not take it away from anyone, and neither does an unreachable Plane — a revocation
stops an agent mid-task, so it needs an act that can only mean one thing.

**Which build is running.** `curl <gateway>/healthz` — no token needed, because the
question comes up before you have one:

```json
{"ok":true,
 "build":{"sha":"082ba9e…","builtAt":"2026-08-04T06:55:00Z"},
 "schema":{"level":"006_relation_retraction","count":6,"appliedAt":"…"}}
```

`build.sha` is a Docker build arg stamped in by `provision.sh` from the checkout it
deployed; compare it with `git rev-parse HEAD`. `schema.level` is the highest
migration *that host's database* has had, which is the other half — a current image
against a database that never got its migration fails only on the feature that needed
it. `null` means the value is unknown; a reply with no `build` key at all is a gateway
older than this feature. `provision.sh` compares the two after deploying and warns
when the container answering is not the one it just built.

**Lease TTL.** Default 600s. This is not a deadline for the work: the plugin's
monitor keeps a lease alive for as long as the agent is running, so TTL is the
window between an agent *dying* and its item returning to the pool. Too short and a
brief stall costs an agent its work; too long and a dead agent's item sits idle.
Clients without the plugin extend it themselves over `POST /v1/heartbeat`.

**Repeated expiry is a signal.** After 3 expiries the sweeper flags the item for human
attention — a task that keeps killing its agent is usually underspecified.

**Plane's rate limit is per token**, default 60/minute, which is sized for a human
clicking around. One claim costs four API calls, so that caps an agent at roughly a
dozen claims a minute and returns 429 under any burst. `gen-env.sh` sets
`API_KEY_RATE_LIMIT=300/minute`. Each agent writes with its own Plane token, so the
budget scales with the number of agents.

**Plane lags by a second or so.** `complete` ends the lease immediately and writes
Plane in the background, so an agent never fails because Plane was slow. A dependent
item can stay blocked briefly after its blocker finishes.

**Key rotation.** Rotating `GATEWAY_TOKEN_KEY` invalidates every stored Plane token —
re-issue each agent's. Not fatal: the gateway falls back to the service account, so
you get degraded attribution rather than an outage.

**Backup.** One PGDATA backup covers Plane and the gateway at a consistent restore
point; they share an instance but are separate databases.

**The network outlives the stack.** `docker compose down` leaves it. Remove it with
`docker network rm sync_plane`.

**Running two gateway replicas** is safe. Plane writes are ordered per work item
across processes by a Postgres advisory lock, so a completion cannot land before
the claim that preceded it, and `MINT_RATE_LIMIT` is counted in Postgres so it
means the same thing at one replica and at three.

## Checking completions against GitHub

`complete` takes an agent's word for it. If the gateway knows where the code
lives, it checks that word *while the agent is still on the call* — no webhook,
no polling, no background loop. `complete` **is** the notification.

Set either of these in `deploy/.env` and restart:

```bash
GITHUB_REPO=owner/name     # where bare commit shas are looked up
GITHUB_TOKEN=ghp_...       # read-only. Required for private repositories
```

Every citation in the outcome comes back with a verdict:

| Status | Meaning |
|---|---|
| `landed` | Merged, or an ancestor of the default branch |
| `pending` | Real, not merged yet. An open pull request at completion time is normal |
| `absent` | GitHub says there is no such thing |
| `unchecked` | Not askable — no token, no repo, not a GitHub link, or GitHub was unreachable |

Two labels, deliberately distinct. `unverified` means the completion cited
**nothing**; `evidence-missing` means **nothing it cited could be found**. The
first is an agent being terse, the second is an agent being wrong.

`evidence-missing` is deliberately not "something did not resolve". A truncated
md5 and a short sha are the same characters, so an outcome that quotes a checksum
as evidence hands the scanner a hex word that will never resolve — and the old
rule flagged a completion backed by three real commits for doing careful work.
The detection cannot be sharpened, so the consequence is what changed: one
citation that exists makes the claim evidenced, and a stray checksum beside it
proves nothing either way. Unresolved citations are still reported on the
completion, because they are usually a typo worth fixing; they are simply not a
flag on the board.

**It never blocks on GitHub.** Anything that fails — no token, a timeout, a 5xx,
a rate limit — becomes `unchecked`, which is a stated absence of information
rather than an accusation. A lease must not fail to end because a third party
was slow.

**Without a token it will not accuse.** A private repository answers 404 to a
stranger exactly as a nonexistent one does, so an unauthenticated 404 is reported
`unchecked`, never `absent`.

`REQUIRE_EVIDENCE=refuse` rejects a `complete` whose citations **all** failed to
resolve — the same rule as the label — checked *before* the lease ends, so a
refused agent still holds its work.

What this deliberately does **not** do is watch for the pull request to merge
later. That would need a receiver or a poller, and the failure worth catching is
the citation that resolves to nothing, which is visible immediately.


## Troubleshooting a deployment

| Symptom | Fix |
|---|---|
| **502 from your reverse proxy, with a valid certificate** | The proxy answered and could not reach the stack. If that proxy is itself a container, `127.0.0.1` is *its* loopback, not the host's — join it to the stack's network and use `reverse_proxy proxy:80` and `gateway:8787`. See the two variants in `deploy/Caddyfile.sync` |
| Sign-in opens the wrong host, or hangs | Set `GATEWAY_PUBLIC_URL` in `deploy/.env` and restart the gateway |
| One client exhausts the mint limit for everybody | `TRUST_PROXY` is unset behind a proxy, so every request arrives from the proxy and shares one bucket. Set it to the number of proxies in front — `1` for a single one. `gen-env.sh --behind-proxy` writes it |
| Gateway boots with `TRUST_PROXY=true would trust any X-Forwarded-For` | Deliberate. `true` lets a client name its own address and bypass the limit entirely; give a hop count or a subnet instead |
| **Migrator loops on `password authentication failed for user "plane"`** | The `pgdata` volume predates the current `.env`: Postgres sets `POSTGRES_PASSWORD` only when it first initialises. Realign the database over its unix socket, which trusts local connections even when the TCP password is wrong — see below |
| Agent has no tools, but the client says **connected** | The gateway is up and authenticating, and cannot reach Plane to build the catalogue. Check `docker compose logs gateway` |
| Plane shows "In Progress" for finished work | Mirror write failed. `docker compose logs gateway \| grep 'plane mirror failed'` |
| Gateway crash-loops on `PLANE_API_KEY is not set` | `.env` was read before provisioning filled it in. Re-run `docker compose up -d gateway` |
| 403 on every Plane write | The agent's Plane user is not a project member |
| Every citation comes back `unchecked` | Neither `GITHUB_TOKEN` nor `GITHUB_REPO` is set, so checking is off |
| A real commit is reported `absent` | `GITHUB_REPO` points at the wrong repository, or the sha is on a fork the token cannot see |
| A private repo's citations are `unchecked` | Set `GITHUB_TOKEN`. Without it a private 404 is indistinguishable from a missing one, and the gateway will not guess |

Realigning a Postgres whose volume kept an older password, without losing data:

```bash
cd deploy
PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T plane-db psql -U plane -d postgres -h /var/run/postgresql \
  -v pw="$PW" <<<"ALTER USER plane WITH PASSWORD :'pw';"
docker compose up -d
```

`-h /var/run/postgresql` is required: `PGHOST` is set inside the container, so psql
would otherwise dial TCP and hit the very authentication it is repairing. The
statement goes on stdin because psql does not interpolate `-v` variables inside
`-c`, and passing the password as a psql variable rather than splicing it into the
SQL keeps it correct for a password containing a quote.

If Plane holds nothing worth keeping, `docker compose down && docker volume rm
<project>_pgdata && docker compose up -d` is simpler.
