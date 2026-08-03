-- ---------------------------------------------------------------------------
-- Blocker edges the gate is told to disregard.
--
-- `blocked_by` is load-bearing: it makes an item unclaimable. A wrong one gates
-- real work forever, and Plane's public API cannot remove it. That is measured,
-- not assumed — at v1.3.1, the version we run, and still on `preview`:
--
--   work-items/<issue_id>/relations/
--   IssueRelationListCreateAPIEndpoint.as_view(http_method_names=["get", "post"])
--
-- No delete, at any version. Upgrading does not fix it. Nor does re-linking the
-- pair with a different type: Plane stores relations as (issue, related_issue,
-- relation_type) rows and bulk-creates with ignore_conflicts, so a second type
-- for the same pair ADDS a row and leaves the first one enforcing.
--
-- The two remaining ways to remove the row are Plane's own UI, which an agent
-- does not have, and reaching into Plane's database, which would dissolve the
-- boundary that keeps the gateway unable to read Plane's tables at all.
--
-- So the gateway retracts instead of deleting. This is not a workaround for
-- lacking authority; the readiness gate is the gateway's rule, not Plane's — the
-- same authority by which a lease or a `needs-human` label withholds an item. A
-- retraction says the edge is not a real dependency, and the gate stops honouring
-- it. The edge itself stays in Plane, visible, which is why `why` reports a
-- retracted blocker rather than falling silent about it, and why `unlink` writes
-- a comment on the work item so a human reading Plane sees the same thing.
--
-- Rows are kept after a retraction is reversed rather than deleted: "who decided
-- this dependency was not real, and when" is exactly the question someone asks
-- after work goes out that should have waited.
-- ---------------------------------------------------------------------------

create table if not exists relation_retraction (
  id            uuid        primary key default gen_random_uuid(),
  project_id    uuid        not null,
  -- The item that is blocked. Plane work item ids; no foreign key, for the same
  -- reason `lease` has none — Plane's rows live in a database this one cannot see.
  work_item_id  uuid        not null,
  -- The item named as its blocker.
  blocker_id    uuid        not null,
  -- Stored even though `blocked_by` is the only kind that gates anything today.
  -- The column costs nothing now and means a second load-bearing relation type
  -- does not need a migration and a second table to say the same thing.
  relation      text        not null default 'blocked_by',
  -- False once someone reinstates the dependency. The row survives so the
  -- history of the decision does.
  active        boolean     not null default true,
  reason        text        not null default '',
  actor         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One live decision per edge. `unlink` upserts on this, so retracting an edge
-- twice is idempotent rather than leaving two rows that could disagree.
create unique index if not exists relation_retraction_edge_idx
  on relation_retraction (work_item_id, blocker_id, relation);

-- The gate's read: "which of this project's edges are retracted", answered once
-- per browse rather than per item.
create index if not exists relation_retraction_project_idx
  on relation_retraction (project_id) where active;

comment on table relation_retraction is
  'blocked_by edges the readiness gate disregards. Plane''s API cannot delete a relation (get/post only, v1.3.1 through preview), so the gateway stops honouring it instead. The edge remains visible in Plane.';
comment on column relation_retraction.active is
  'False once the dependency is reinstated. Rows are never deleted: who decided an edge was not real, and when, is the question asked after work ships that should have waited.';
