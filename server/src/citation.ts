import type { Pool } from './db.js';
import type { Check } from './ghcheck.js';

/**
 * Keeping what a completion cited, and what the check said about it.
 *
 * Small on purpose. The answer is already known by the time anything is written
 * here — `complete` asks GitHub while the agent is still on the call — so this is
 * a record, not a queue. Nothing re-reads it to decide anything; it exists so
 * that "what did this agent actually point at, and did it exist?" survives the
 * conversation that produced it.
 */

export interface StoredCitation {
  kind: string;
  value: string;
  status: Check['status'];
  detail: string;
  actor: string | null;
  checkedAt: string;
}

export async function recordCitations(
  pool: Pool,
  args: { workItemId: string; projectId?: string | undefined; actor: string; checks: Check[] },
): Promise<void> {
  if (args.checks.length === 0) return;

  // One statement. A completion cites one or two things, and a loop of inserts
  // would put an agent's `complete` behind a round trip per citation.
  await pool.query(
    `insert into citation (work_item_id, project_id, kind, value, status, detail, actor)
     select $1, $2, c.kind, c.value, c.status, c.detail, $3
       from jsonb_to_recordset($4::jsonb)
            as c(kind text, value text, status text, detail text)`,
    [args.workItemId, args.projectId ?? null, args.actor, JSON.stringify(args.checks)],
  );
}

export async function citationsFor(pool: Pool, workItemId: string): Promise<StoredCitation[]> {
  const { rows } = await pool.query<{
    kind: string;
    value: string;
    status: Check['status'];
    detail: string;
    actor: string | null;
    checked_at: Date;
  }>(
    `select kind, value, status, detail, actor, checked_at
       from citation where work_item_id = $1 order by checked_at`,
    [workItemId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    value: r.value,
    status: r.status,
    detail: r.detail,
    actor: r.actor,
    checkedAt: r.checked_at.toISOString(),
  }));
}
