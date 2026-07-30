-- ---------------------------------------------------------------------------
-- Attestation: someone said a work item is connected to an artefact.
--
-- `complete` takes free text and extracts citations from it, and until now threw
-- them away. So an agent could say "merged in #42" and close the item whether or
-- not #42 existed, and nothing downstream could ever ask the question again.
--
-- The fix is not a webhook. The fix is that a citation is a *claim by someone*,
-- and claims from different sources carry different weight:
--
--   agent  — free text, self-reported at completion, unverified by construction.
--   github — HMAC-signed, describing something that actually happened.
--
-- Once both live in the same table, verification stops being a mechanism and
-- becomes a query: does a github row exist with the same match_key as the agent
-- row? That also makes the two orderings identical. If the PR merges first, the
-- agent's later `complete` is corroborated the moment it lands; if the agent
-- completes first, the merge corroborates it afterwards. Neither path is special.
-- ---------------------------------------------------------------------------

create table if not exists attestation (
  id           uuid        primary key default gen_random_uuid(),
  -- Plane work item id. No foreign key, for the same reason `lease` has none.
  work_item_id uuid        not null,
  project_id   uuid,
  source       text        not null check (source in ('agent', 'github')),
  -- What sort of artefact: 'commit' or 'url'. Deliberately narrow — a cited file
  -- path is evidence a human can read but not a thing GitHub attests to, so it
  -- never becomes a claim that could sit here permanently uncorroborated.
  kind         text        not null,
  -- As written, for display.
  value        text        not null,
  -- The artefact's identity, computed by one function for both sources so that
  -- corroboration is exact equality and never a fuzzy match. A 7-character
  -- abbreviation and a 40-character sha reduce to the same key; a pull request
  -- URL and an `owner/repo#42` mention do too.
  match_key    text        not null,
  -- Agent holder, or the GitHub login that merged.
  actor        text,
  detail       jsonb       not null default '{}',
  observed_at  timestamptz not null default now(),
  -- Set when this claim has been reported as never having landed, so the sweeper
  -- says it once rather than on every pass.
  flagged_at   timestamptz
);

-- GitHub retries deliveries, and an agent may complete the same item twice across
-- a re-claim. Both must be idempotent.
create unique index if not exists attestation_identity_idx
  on attestation (work_item_id, source, match_key);

create index if not exists attestation_item_idx on attestation (work_item_id);

-- Drives the "cited a PR that never merged" sweep.
create index if not exists attestation_unflagged_idx
  on attestation (observed_at) where source = 'agent' and flagged_at is null;

comment on table attestation is
  'Claims that a work item is connected to an artefact. An agent claim corroborated by a github claim with the same match_key is verified evidence; one without is an assertion.';
comment on column attestation.match_key is
  'Artefact identity, normalised so agent and github rows for the same artefact compare equal. Never compare `value`.';
comment on column attestation.flagged_at is
  'When this agent claim was reported as never corroborated. Null means not yet reported.';
