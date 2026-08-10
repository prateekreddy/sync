-- The credential a poll just retired, kept briefly.
--
-- Every poll of /v1/watch rotates: the gateway retires the URL that was used and
-- returns its successor. Until now nothing remembered what had just been
-- retired, so a caller still holding the old URL was indistinguishable from a
-- caller holding a credential that had been cleared because ANOTHER SESSION took
-- the item. Both matched no row, and both were answered 410 — which the push
-- fence treats as a definitive verdict.
--
-- Measured live 2026-08-10: a hook polled, dropped the rotation, and from then on
-- the agent was refused every push with "this work is no longer yours", told to
-- discard correct work, and had its lease quietly stop being extended. Nobody had
-- touched the item. The check manufactured the evidence it then acted on.
--
-- Persisting the rotation in the plugin (a7bb997) stops the common cause. This
-- closes the hole underneath it: a crash between the GET and the write, or two
-- hooks polling at the same instant, can still leave a caller one rotation
-- behind, and being one rotation behind must never read as theft.
--
-- The window is deliberately short. This is a bearer credential, and accepting a
-- retired one widens how long a leaked URL keeps working — bounded here to a few
-- minutes, and only ever for the two things a watch credential can do at all:
-- extend this session's leases and report on them.
--
-- Safety rests on both columns being cleared together everywhere the current one
-- is cleared. `claim` clears them when another session takes the item, which is
-- what keeps a genuine theft answering 410 rather than being served from the
-- previous value.

alter table lease
  add column if not exists watch_prev_sha256 text,
  -- When the rotation happened, so the grace period can be enforced in the
  -- query rather than trusted to a caller.
  add column if not exists watch_prev_at     timestamptz;

-- Partial, like the index on the current credential: only rows mid-rotation
-- carry one, and a poll looks the value up by hash.
create index if not exists lease_watch_prev_idx
  on lease (watch_prev_sha256) where watch_prev_sha256 is not null;

comment on column lease.watch_prev_sha256 is
  'sha256 of the credential the last poll retired. Accepted for a short grace period so a caller that lost the rotation is not mistaken for one whose work was taken.';
comment on column lease.watch_prev_at is
  'When the previous credential was retired. The grace period is measured from here.';
