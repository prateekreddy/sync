-- ---------------------------------------------------------------------------
-- Which session holds a lease, and what may ask about it.
--
-- Two changes, and they belong together because they answer the same question
-- from opposite ends: who is actually working this item right now.
--
-- `session_id` exists because agents now authenticate as the human who runs
-- them. Every Claude Code window that person opens presents the same token and
-- resolves to the same `holder` string, so without this the gateway cannot tell
-- two concurrent sessions apart. That is not academic: activity in one window
-- would refresh a lease held by another, so a session that has gone to sleep
-- looks alive as long as any other window is busy -- which is the failure this
-- whole redesign exists to remove, reintroduced by the identity simplification.
-- It also makes a retry safe to distinguish from a second claimant, which
-- matters more now that the 2026-07-28 MCP revision removed stream resumability
-- and requires clients to re-issue interrupted requests.
--
-- `watch_sha256` is the credential the background monitor polls with. The
-- monitor is a separate OS process: it cannot reach the OAuth token Claude Code
-- holds, so `claim` hands back a capability URL and a hook stores it. Possession
-- is authorisation, which is safe here only because of how little it can do --
-- extend this session's leases and report them. It cannot claim, complete,
-- capture, or read a work item.
--
-- Only the hash is stored. The URL is shown once, at mint, and on every rotation;
-- a leaked database cannot be replayed against the gateway, and the raw value
-- must never be logged, since the URL *is* the password.
--
-- It lives on the lease rather than in a session table on purpose. The credential
-- exists exactly as long as there is something to protect: minted by the first
-- claim, gone when the last lease ends. A session holding nothing has no
-- credential and no row, which is the correct answer rather than an edge case.
-- ---------------------------------------------------------------------------

alter table lease
  -- Null for leases taken before this migration, and for any client that does
  -- not report one. Those fall back to holder-level behaviour, which is exactly
  -- today's semantics -- degraded, never wrong.
  add column if not exists session_id       text,
  add column if not exists watch_sha256     text,
  -- Absolute cap, independent of rotation. A credential that renews on every
  -- poll would otherwise live as long as the process does.
  add column if not exists watch_expires_at timestamptz;

-- The monitor's lookup, on every poll from every session. Partial because rows
-- without a credential are the common case and should not be indexed.
--
-- Deliberately NOT unique. One credential covers every lease a session holds,
-- because the session is the unit of liveness: an agent that claims a second
-- item must not end up with two credentials, of which the monitor can only ever
-- poll the last one it was handed -- the first item would then stop being
-- heartbeated and lapse while the agent was actively working it, which is the
-- exact failure this design exists to remove.
create index if not exists lease_watch_idx
  on lease (watch_sha256) where watch_sha256 is not null;

-- "What does this session hold" -- asked by the watch endpoint, by the resume
-- report, and by session close.
create index if not exists lease_session_idx
  on lease (session_id) where session_id is not null;

comment on column lease.session_id is
  'The client session holding this lease. Agents share their human''s identity, so `holder` alone cannot tell two concurrent windows apart.';
comment on column lease.watch_sha256 is
  'SHA-256 of the capability URL the background monitor polls with. Only the hash is stored; the raw value is shown at mint and on each rotation, and must never be logged.';
