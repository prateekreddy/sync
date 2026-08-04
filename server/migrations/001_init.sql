-- Runs as agent_gw against the `gateway` database (see 000_bootstrap.sql).
--
-- This database holds exactly one thing Plane cannot express: who currently holds
-- a work item, and until when. Plane remains the system of record for everything
-- else. Losing this database costs active leases -- which expire on their own
-- anyway -- and never task data.

-- ---------------------------------------------------------------------------
-- Which migrations this database has had.
--
-- Lives here, in the first migration, rather than in a later one of its own: the
-- runner records each file as it applies it, so the ledger has to exist before
-- the first row is written. Every migration re-runs on every deploy, so this is
-- created idempotently like the rest.
--
-- Read by /healthz, which reports the highest filename. That is the answer to
-- "does this host have 006 yet, or will `unlink` fail on it" -- a question that
-- previously needed psql on the box, and so was usually answered by guessing.
--
-- Deliberately not a gate: nothing refuses to start because the ledger is behind.
-- It records what happened; it does not enforce.
-- ---------------------------------------------------------------------------

create table if not exists schema_migration (
  -- Basename without .sql, e.g. '006_relation_retraction'. The zero-padded
  -- prefix means max(filename) is the newest, with no version column to keep
  -- in sync with the filename it would duplicate.
  filename   text        primary key,
  applied_at timestamptz not null default now()
);

comment on table schema_migration is
  'Migrations applied to this database, recorded by the runner in deploy/gateway.yml. Reported by /healthz so a deployment can be checked without shell access.';

-- ---------------------------------------------------------------------------
-- Lease: the primitive Plane lacks.
--
-- Plane's API has no optimistic concurrency -- no If-Match, no ETag, no version
-- precondition -- and its work-item update is read-modify-write. Two agents
-- polling the same backlog therefore both "claim" the same item: measured, they
-- either all back off (livelock) or all proceed while Plane records only the last
-- writer, leaving the collision invisible. See docs/race.py and docs/race2.py.
-- ---------------------------------------------------------------------------

do $$ begin
  create type lease_state as enum ('held', 'released', 'expired', 'completed');
exception when duplicate_object then null;
end $$;

create table if not exists lease (
  -- Plane work item id. No foreign key exists or could exist: Plane lives in a
  -- different database. That is the point.
  work_item_id uuid        primary key,
  project_id   uuid        not null,
  holder       text        not null,          -- 'agent:sync-worker-3'
  -- Attribution is a chain, not a field. When most writes are machine-generated,
  -- "who decided this?" still has to resolve back to a human.
  holder_chain text[]      not null default '{}',
  -- Fencing token. Monotonic per work item, never reused, survives release and
  -- expiry. An agent that wakes after losing its lease presents a stale epoch and
  -- is rejected, rather than silently overwriting the new holder's work.
  epoch        bigint      not null,
  state        lease_state not null,
  claimed_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  ended_at     timestamptz,
  end_reason   text,
  -- How many times this item has expired out from under an agent. An item that
  -- repeatedly kills its worker is a signal, not noise.
  expiry_count int         not null default 0,
  -- Has the Plane-side mirror (assignee + state) been written? The lease row is
  -- the commit point; mirroring is best-effort and retried by the sweeper.
  mirrored     boolean     not null default false
);

-- Drives the sweeper.
create index if not exists lease_expiry_idx on lease (expires_at) where state = 'held';

-- Retry queue for failed Plane mirrors.
create index if not exists lease_mirror_idx on lease (work_item_id) where not mirrored;

-- "What am I holding?" -- used by agents resuming after a restart.
create index if not exists lease_holder_idx on lease (holder) where state = 'held';

-- ---------------------------------------------------------------------------
-- Idempotency for capture. Agents retry; retries must not create duplicates.
-- ---------------------------------------------------------------------------

create table if not exists idempotency (
  key          text        primary key,
  actor        text        not null,
  -- Replaying a stored response for a *different* body is worse than failing, so
  -- the body is fingerprinted and a mismatch is rejected.
  request_hash text        not null,
  response     jsonb       not null,
  created_at   timestamptz not null default now()
);

create index if not exists idempotency_gc_idx on idempotency (created_at);

-- ---------------------------------------------------------------------------
-- Agent identity, and Plane attribution pass-through.
--
-- Plane exposes no impersonation header, so the only way to make its activity log
-- say "agent-3 did this" is to send the write with agent-3's own Plane token.
--
-- The agent must NOT hold that token itself: a Plane Member token lets it set
-- `assignee` directly, which is the bypass that breaks mutual exclusion. Identity
-- passes through; possession does not. The gateway stores the Plane token; the
-- agent only ever holds a gateway token.
-- ---------------------------------------------------------------------------

create table if not exists agent_token (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null unique,       -- 'sync-worker-3'
  -- Only the hash is stored; the token is shown once at issue time and is
  -- unrecoverable afterwards. A leaked database should not yield live agent
  -- credentials.
  token_sha256 text        not null unique,
  -- Which labels this agent may pick up. Empty means "anything ready".
  capabilities text[]      not null default '{}',
  -- Informational: the Plane user this agent writes as. Authority comes from
  -- plane_token_enc, not from this column.
  plane_user_id uuid,
  -- AES-256-GCM ciphertext of this agent's Plane API token, keyed by
  -- GATEWAY_TOKEN_KEY, which lives in the environment and never in a database.
  --
  -- Honest scope: this database and Plane's share a Postgres instance and a single
  -- `setup.sh backup`, and anyone holding the host already has the workspace data
  -- these tokens reach. This protects leaked backup files, not host compromise.
  -- Keeping the key out of the database is the part that matters.
  plane_token_enc text,
  -- Who this agent ultimately acts for. Prepended to holder_chain on every claim.
  principal    text        not null default 'unknown',
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create index if not exists agent_token_lookup_idx on agent_token (token_sha256) where active;

-- Visible to anyone inspecting the live database with \d+, which is where an
-- operator looks first and where a file comment cannot reach them.
comment on column lease.epoch is
  'Fencing token. Monotonic, never reused. Rejects a late-waking agent whose lease was stolen.';
comment on column lease.holder_chain is
  'Attribution chain back to a human, e.g. {human:prateek, agent:lead, agent:worker-3}.';
comment on column lease.expiry_count is
  'Times this item expired out from under an agent. >=3 is flagged for human attention.';
comment on column agent_token.token_sha256 is
  'SHA-256 of the gateway token. The token itself is shown once and never stored.';
comment on column agent_token.plane_user_id is
  'Plane user this agent writes as. Informational — authority comes from plane_token_enc.';
comment on column agent_token.plane_token_enc is
  'AES-256-GCM ciphertext of this agent''s Plane API token, keyed by GATEWAY_TOKEN_KEY. Never returned by the API, never given to the agent.';
