-- Mint attempts, so the rate limit means one thing however many replicas run.
--
-- The limiter was an in-memory Map per process. That was the last thing in the
-- gateway assuming a single process — mirror ordering lost the same assumption
-- in SYNC-6 — and it failed in the worst direction: two replicas meant twenty
-- mints a minute from one address, three meant thirty. The limit exists because
-- self-service minting spends a Plane API call per request and a stranger could
-- burn the workspace's rate-limit budget, so it scaled the exact exposure it was
-- there to bound, precisely when you added replicas for resilience.
--
-- One row per ALLOWED attempt. Refusals are not recorded, which keeps the
-- semantics the in-memory version had: a client hammering the endpoint does not
-- extend its own lockout past the window.
--
-- The table stays tiny without a sweeper. Every call deletes everything older
-- than the window before counting, so it holds at most one minute of mints
-- across the whole fleet — a full-table delete on a few hundred rows, which is
-- cheaper than the Plane request this endpoint is already about to make.
create table if not exists mint_attempt (
  -- The source address, as the route sees it. Not indexed separately: the table
  -- is bounded to a minute of traffic, so a scan is the cheaper plan.
  key text        not null,
  at  timestamptz not null default now()
);

create index if not exists mint_attempt_at on mint_attempt (at);
