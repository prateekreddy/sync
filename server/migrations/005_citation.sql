-- ---------------------------------------------------------------------------
-- What a completion cited, and what GitHub said about it.
--
-- Replaces `attestation` from 004, which existed for about an hour and never
-- carried data anywhere. That table held claims from two sources — the agent and
-- a GitHub webhook — so that a later delivery could be matched against an earlier
-- claim, which is why it needed a normalised `match_key`, a `source` column and a
-- sweep to notice claims nothing ever corroborated.
--
-- All of that was scaffolding around a question that can simply be *asked*.
-- `complete` is the notification: the agent is telling us, at that moment, that
-- the work is done and here is the artefact. So the gateway asks GitHub then and
-- there. With one source there is nothing to match, nothing to reconcile later,
-- and no background loop — the row below is a record of an answer already known,
-- not a claim waiting to be settled.
--
-- Dropped rather than migrated: 004 shipped minutes earlier, and inventing a data
-- migration for rows that do not exist would be pure ceremony.
-- ---------------------------------------------------------------------------

drop table if exists attestation;

create table if not exists citation (
  id           uuid        primary key default gen_random_uuid(),
  -- Plane work item id. No foreign key, for the same reason `lease` has none.
  work_item_id uuid        not null,
  project_id   uuid,
  -- 'commit' | 'url' | 'file' | 'workItem' — every kind a completion can cite,
  -- including the ones GitHub is not the authority on. Those are recorded with
  -- status 'unchecked', which is the honest answer rather than a silent omission.
  kind         text        not null,
  value        text        not null,
  -- landed | pending | absent | unchecked. See server/src/ghcheck.ts.
  status       text        not null,
  -- Why, in the words shown to whoever reads the board.
  detail       text        not null default '',
  actor        text,
  checked_at   timestamptz not null default now()
);

create index if not exists citation_item_idx on citation (work_item_id, checked_at desc);

-- "Which completions cited something that does not exist" — the query a human
-- audits with, and the only one that needs to scan.
create index if not exists citation_absent_idx on citation (checked_at) where status = 'absent';

comment on table citation is
  'What each completion cited and what GitHub said about it, answered at completion time. One source, so no reconciliation.';
comment on column citation.status is
  'landed (merged, or on the default branch) | pending (exists, not merged) | absent (GitHub says no such thing) | unchecked (no token, no repo, not GitHub, or unreachable).';
