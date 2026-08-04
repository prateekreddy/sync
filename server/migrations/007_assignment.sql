-- ---------------------------------------------------------------------------
-- Who put a name on a work item: a human, or us.
--
-- Plane's `assignees` has two authors. A human writes it to say who should do
-- something. The gateway also writes it -- `mirrorClaim` sets the holder's Plane
-- user on every claim, and clears it again on release or expiry. One field,
-- carrying two meanings that have to be told apart before either can be acted on:
--
--   * assigned by a person, to someone else  -> withhold, and ask before taking
--   * assigned by us, because someone claimed -> the lease already says that
--   * assigned by us, but the lease has ended -> residue from a failed mirror
--     write; nobody is working it, and withholding it would freeze real work
--     with no symptom other than silence
--
-- Nothing in Plane distinguishes those. This table does, by recording the writes
-- we make ourselves; anything we did not write is a human's intent.
--
-- This is sharper than it sounds here, because agents minted from a personal
-- token authenticate AS that human -- measured 2026-08-04: `get_user` through
-- sync-master's token returns the owner's account, and items it captures record
-- that human as `created_by`. So for the agent in daily use, "assigned to me" and
-- "assigned to my human" are the same row in Plane, and this table is the only
-- thing that can say which of them put it there.
-- ---------------------------------------------------------------------------

create table if not exists assignment_write (
  -- Plane work item id. No foreign key; Plane's rows live in a database this one
  -- cannot see, for the same reason `lease` has none.
  work_item_id  uuid        primary key,
  -- The Plane user we assigned it to.
  plane_user_id uuid        not null,
  -- The lease that caused the write. Kept so a write can be matched to the claim
  -- it belonged to rather than merely to the item.
  epoch         integer     not null,
  written_at    timestamptz not null default now()
);

comment on table assignment_write is
  'Assignees the gateway set itself, so a human assignment can be told from a claim. A row whose lease has ended is residue from a failed mirror write, not intent.';

-- ---------------------------------------------------------------------------
-- Permission to take work that belongs to someone else.
--
-- The gate refuses an item assigned to another person. A human can override that
-- per item, and the override is recorded HERE rather than held in an agent's
-- context, because context is exactly what does not survive: a compaction, a
-- restart or a different agent picking the work up would otherwise lose it and
-- ask again -- or worse, proceed without asking because the transcript still says
-- someone once approved something.
--
-- Per item and per approver, never blanket. `work_item_id` alone is the key: a
-- second approver adding their own row would imply approvals accumulate, and they
-- do not -- the question "may this be taken from its assignee" has one answer.
-- ---------------------------------------------------------------------------

create table if not exists takeover_approval (
  work_item_id  uuid        primary key,
  -- The principal who approved it, e.g. 'human:someone@example.com'. Not the
  -- agent: an agent cannot authorise its own takeover, which is the whole point.
  approved_by   text        not null,
  -- The Plane user it was taken from, so the record survives the reassignment
  -- that immediately follows and overwrites `assignees`.
  taken_from    uuid,
  reason        text        not null default '',
  created_at    timestamptz not null default now()
);

comment on table takeover_approval is
  'Per-item human approval to claim work assigned to someone else. Recorded rather than remembered, so it survives compaction, restarts and a different agent.';
