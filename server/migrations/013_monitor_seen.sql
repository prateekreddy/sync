-- When this agent's liveness MONITOR was last heard from.
--
-- The gateway warns an agent whose monitor is not running, because a claim that
-- nothing is keeping alive will lapse while the agent works and be handed to
-- somebody else -- the collision this whole design exists to prevent. That
-- warning was inferred rather than recorded, and the inference was wrong in both
-- directions.
--
-- It read `heartbeat_at > claimed_at` over the lease table. Two faults:
--
--   1. `lease` holds one row per work item and `claim` upserts it, resetting
--      claimed_at and heartbeat_at. So poll evidence was a snapshot of the
--      current claim, never history, and claiming an item ERASED the evidence
--      for the item most likely to have it -- the one held longest. The claim
--      destroyed the record and then asked whether the record existed.
--
--   2. Any poll moves heartbeat_at, and the push fence and the resume report
--      poll too. So it detected "something polled", not "the monitor is
--      running" -- and a session whose monitor was dead but whose hooks were
--      firing looked perfectly healthy. Measured on 2026-08-10: exactly that
--      session existed, with the monitor latched in a 900s backoff.
--
-- On agent_token rather than on lease, which is the whole point: nothing a claim
-- does can overwrite it, and it needs no reconciliation with re-claims, epochs
-- or takeovers. The monitor belongs to the agent, not to any one item.
--
-- Null means never heard from, which is the honest starting state and reads
-- correctly for an agent that has never claimed anything.

alter table agent_token
  add column if not exists monitor_seen_at timestamptz;

comment on column agent_token.monitor_seen_at is
  'When this agent''s liveness monitor last polled a watch credential. Set only by a poll that identified itself as the monitor -- the push fence and the resume report poll the same endpoint and must not be mistaken for it. Null means never seen.';
