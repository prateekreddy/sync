import type { Pool } from './db.js';

/**
 * Blocker edges the readiness gate is told to disregard.
 *
 * `blocked_by` makes an item unclaimable, and Plane's public API cannot delete a
 * relation — `["get", "post"]` on the relations endpoint at v1.3.1 and still on
 * `preview`, so upgrading does not help. Re-linking the pair with another type
 * does not help either: Plane bulk-creates (issue, related_issue, relation_type)
 * rows with `ignore_conflicts`, so a second type is a second row and the first
 * one keeps gating. A wrong edge therefore blocks real work permanently, and the
 * only ways out were Plane's UI, which an agent does not have, or reaching into
 * Plane's database, which would dissolve the boundary that keeps this gateway
 * unable to read Plane's tables at all.
 *
 * So the gateway stops honouring the edge rather than removing it. That is not a
 * workaround for lacking authority — the readiness gate is the gateway's rule,
 * the same authority by which a lease or a `needs-human` label withholds an item.
 * Plane holds the relation; the gateway decides what it means.
 *
 * The cost is a divergence: Plane's UI still draws the edge. Left implicit that
 * would be its own silent failure, so it is made loud in three places — `why`
 * reports a retracted blocker instead of falling silent, `unlink` comments on the
 * work item so a human reading Plane sees the same decision, and the row records
 * who made it.
 */

export interface Retraction {
  projectId: string;
  workItemId: string;
  blockerId: string;
  relation: string;
  reason: string;
  actor: string | null;
  createdAt: Date;
}

interface Row {
  project_id: string;
  work_item_id: string;
  blocker_id: string;
  relation: string;
  reason: string;
  actor: string | null;
  created_at: Date;
}

const toRetraction = (r: Row): Retraction => ({
  projectId: r.project_id,
  workItemId: r.work_item_id,
  blockerId: r.blocker_id,
  relation: r.relation,
  reason: r.reason,
  actor: r.actor,
  createdAt: r.created_at,
});

const RETURNING = 'project_id, work_item_id, blocker_id, relation, reason, actor, created_at';

export interface RetractOpts {
  projectId: string;
  workItemId: string;
  blockerId: string;
  relation?: string;
  reason: string;
  actor?: string | null;
}

/**
 * Stop the gate honouring one edge.
 *
 * Upserts, so retracting twice is the same as retracting once — an agent
 * correcting a mistake should not have to find out whether it already corrected
 * it. Reinstating and re-retracting reuses the row and moves `created_at`
 * forward, because the live decision is the one being asked about.
 */
export async function retract(pool: Pool, o: RetractOpts): Promise<Retraction> {
  const { rows } = await pool.query<Row>(
    `insert into relation_retraction
       (project_id, work_item_id, blocker_id, relation, reason, actor)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (work_item_id, blocker_id, relation) do update
       set active = true,
           reason = excluded.reason,
           actor = excluded.actor,
           created_at = now(),
           updated_at = now()
     returning ${RETURNING}`,
    [o.projectId, o.workItemId, o.blockerId, o.relation ?? 'blocked_by', o.reason, o.actor ?? null],
  );
  return toRetraction(rows[0]!);
}

/** Put an edge back under the gate. The row survives, so the history does. */
export async function reinstate(
  pool: Pool,
  o: { workItemId: string; blockerId: string; relation?: string },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update relation_retraction
       set active = false, updated_at = now()
     where work_item_id = $1 and blocker_id = $2 and relation = $3 and active`,
    [o.workItemId, o.blockerId, o.relation ?? 'blocked_by'],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Every live retraction in a project, as a set of `item|blocker` keys.
 *
 * One query per browse rather than one per item, for the same reason the blocker
 * pass is budgeted: this sits in the path of every `find`, `next` and `board`.
 *
 * Scoped to one relation kind — `blocked_by` unless asked otherwise — because
 * this feeds the readiness gate, and `blocked_by` is the only kind that gates.
 * See `retractedEdges` for the other shape and why there are two.
 */
export async function retractedIn(
  pool: Pool,
  projectId: string,
  relation = 'blocked_by',
): Promise<Set<string>> {
  const { rows } = await pool.query<{ work_item_id: string; blocker_id: string }>(
    `select work_item_id, blocker_id
       from relation_retraction
      where project_id = $1 and relation = $2 and active`,
    [projectId, relation],
  );
  return new Set(rows.map((r) => `${r.work_item_id}|${r.blocker_id}`));
}

/**
 * Every live retraction on ONE item, as a set of `blocker|relation` keys.
 *
 * A second key shape, deliberately, and the difference is worth stating because
 * mixing them up would silently disregard the wrong edges. `retractedIn` answers
 * "across this project, which items have a retracted blocker" — one relation
 * kind, many items. This answers "on this one item, which edges of ANY kind are
 * retracted" — one item, every kind. The gate needs the first and cannot use the
 * second; a briefing needs the second and cannot use the first.
 *
 * Retraction started life as a gate concept, so `blocked_by` was the only kind
 * that could be retracted at all. Once `unlink` took a relation, the other kinds
 * needed somewhere to be honoured, and a briefing is that place: it is where a
 * `relates_to` is actually read (PLANE-15).
 */
export async function retractedEdges(pool: Pool, workItemId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ blocker_id: string; relation: string }>(
    `select blocker_id, relation
       from relation_retraction
      where work_item_id = $1 and active`,
    [workItemId],
  );
  return new Set(rows.map((r) => `${r.blocker_id}|${r.relation}`));
}

/** Live retractions on one item, for `why` to explain itself with. */
export async function retractionsFor(
  pool: Pool,
  workItemId: string,
): Promise<Retraction[]> {
  const { rows } = await pool.query<Row>(
    `select ${RETURNING} from relation_retraction
      where work_item_id = $1 and active
      order by created_at desc`,
    [workItemId],
  );
  return rows.map(toRetraction);
}
