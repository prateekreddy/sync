-- ---------------------------------------------------------------------------
-- The Plane write a lease still owes, and enough of it to try again.
--
-- `mirrored = false` already meant "Plane has not been told about this yet". It
-- was documented as a retry queue and was never one, because it recorded only
-- *that* a write was owed and never *what* -- so nothing could replay it, and
-- nothing ever did. A completion whose mirror failed left the board showing "In
-- Progress" for finished work, permanently, and the only cure was a human
-- noticing and fixing it by hand.
--
-- The worst case was quieter still: `closeWatch` marked the flag and had no
-- follow-up at all, not even a failing one. Every session that ended holding
-- work left that work assigned and in progress on the board forever.
--
-- `pending_mirror` carries the intent -- what kind of write, and the arguments
-- that cannot be recovered from the row (the outcome text, whether the item
-- closes, which labels to apply, who it was for). Written before the attempt and
-- cleared after it succeeds, which is the ordinary outbox shape: at-least-once
-- delivery, where a crash between the write and the clear costs a repeat rather
-- than a loss. The mirror writes are idempotent, so a repeat is harmless.
--
-- `mirrored` is deliberately left alone. It answers a different question that is
-- still asked elsewhere -- whether Plane has heard about a *live* claim, which is
-- what stops reconciliation revoking a lease for the crime of being new.
-- ---------------------------------------------------------------------------

alter table lease
  add column if not exists pending_mirror  jsonb,
  -- Bounded retries. A write Plane refuses on its merits -- a deleted item, a
  -- state that no longer exists -- would otherwise be retried every thirty
  -- seconds until the end of time, and the log would say so every time.
  add column if not exists mirror_attempts integer not null default 0,
  -- When to try next. Backoff is per row rather than global so one poisonous
  -- item cannot delay everything else in the queue.
  add column if not exists mirror_after    timestamptz;

-- The drain's only query. Partial, because rows owing nothing are the common
-- case and the queue is expected to be empty.
create index if not exists lease_pending_mirror_idx
  on lease (mirror_after) where pending_mirror is not null;

comment on column lease.pending_mirror is
  'The Plane write this lease still owes, as {kind, ...args}. Null when nothing is outstanding. Written before the attempt, cleared after it succeeds.';
