import type { Pool } from './db.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { screen } from './readiness.js';

/**
 * Filtered queries over a project's work.
 *
 * Scoped to the Plane we run — v1.3.1. Its list endpoints ignore filters outright:
 * measured on a 34-item board, `?priority=urgent`, `?labels=<uuid>` and
 * `?state_group=backlog` each returned all 34, and there is no views endpoint. So
 * filtering happens here or nowhere.
 *
 * Two caveats worth carrying, both learned from the docs rather than from probing.
 * `fields` IS honoured and cuts the same payload 7.8x, so field selection can be
 * pushed down even though filtering cannot (see SYNC-26). And newer Plane exposes
 * filtering on `list_work_items` through its own MCP server — if the instance is
 * ever upgraded, check whether this tool still earns its place before extending it.
 *
 * The agent equivalent of a view is not a saved layout, it is a query that returns
 * few rows. One filter has no equivalent in any Plane view at all: `holder` comes
 * from the lease table, so "what is agent X working on" is answerable only here.
 *
 * `ready` reuses the gate's own `screen` rather than restating it, so `find` and
 * `claim` cannot disagree about what ready means.
 */

export interface FindQuery {
  projectId: string;
  labels?: string[] | undefined;
  priority?: WorkItem['priority'] | undefined;
  stateGroup?: State['group'] | undefined;
  moduleId?: string | undefined;
  /** An agent name, or 'any' / 'none' to filter on whether anyone holds it. */
  holder?: string | undefined;
  parentId?: string | undefined;
  ready?: boolean | undefined;
  limit?: number | undefined;
}

export interface FoundItem {
  workItemId: string;
  readableId: string;
  title: string;
  priority: WorkItem['priority'];
  state: string;
  labels: string[];
  holder?: string;
}

export interface FindResult {
  items: FoundItem[];
  /** Matches before `limit` was applied, so a truncated answer is visibly truncated. */
  matched: number;
}

export async function find(
  plane: PlaneClient,
  pool: Pool,
  q: FindQuery,
): Promise<FindResult> {
  const limit = q.limit ?? 25;

  const [items, states, labelNames, leases, moduleMembers] = await Promise.all([
    plane.listWorkItems(q.projectId),
    plane.states(q.projectId),
    plane.labelNames(q.projectId),
    pool
      .query<{ work_item_id: string; holder: string }>(
        `select work_item_id, holder from lease where state = 'held' and expires_at > now()`,
      )
      .then((r) => new Map(r.rows.map((x) => [x.work_item_id, x.holder]))),
    q.moduleId ? plane.moduleIssueIds(q.projectId, q.moduleId) : Promise.resolve(null),
  ]);

  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const nameOf = new Map(states.map((s) => [s.id, s.name]));
  const wantedLabels = (q.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);

  // Only needed for `ready`, and it is derived from the list we already have.
  const openChildren = new Map<string, number>();
  if (q.ready) {
    for (const i of items) {
      if (!i.parent) continue;
      const g = groupOf.get(i.state);
      if (g === 'completed' || g === 'cancelled') continue;
      openChildren.set(i.parent, (openChildren.get(i.parent) ?? 0) + 1);
    }
  }

  const labelsOf = (i: WorkItem) => i.labels.map((id) => (labelNames.get(id) ?? id).toLowerCase());

  const matches = items.filter((i) => {
    if (q.priority && i.priority !== q.priority) return false;
    if (q.stateGroup && groupOf.get(i.state) !== q.stateGroup) return false;
    if (q.parentId && i.parent !== q.parentId) return false;
    if (moduleMembers && !moduleMembers.has(i.id)) return false;

    if (wantedLabels.length) {
      // Every named label must be present: narrowing is the point, and "any of"
      // would make a second label widen the result set rather than narrow it.
      const has = labelsOf(i);
      if (!wantedLabels.every((w) => has.includes(w))) return false;
    }

    if (q.holder) {
      const held = leases.get(i.id);
      if (q.holder === 'none' && held) return false;
      if (q.holder === 'any' && !held) return false;
      if (q.holder !== 'none' && q.holder !== 'any' && held !== q.holder) return false;
    }

    if (q.ready) {
      if (leases.has(i.id)) return false;
      if (screen(i, groupOf.get(i.state), labelNames, openChildren.get(i.id) ?? 0).length) {
        return false;
      }
    }
    return true;
  });

  return {
    matched: matches.length,
    items: matches.slice(0, limit).map((i) => {
      const held = leases.get(i.id);
      return {
        workItemId: i.id,
        readableId: `#${i.sequence_id}`,
        title: i.name,
        priority: i.priority,
        state: nameOf.get(i.state) ?? 'unknown',
        labels: i.labels.map((id) => labelNames.get(id) ?? id),
        ...(held ? { holder: held } : {}),
      };
    }),
  };
}
