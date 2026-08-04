import type { Pool } from './db.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { resolve } from './query.js';
import { viewOf, type WorkItemView } from './view.js';

/**
 * Filtered queries over a project's work.
 *
 * Scoped to the Plane we run — v1.3.1. Its list endpoints ignore filters
 * outright: measured on a 34-item board, `?priority=urgent`, `?labels=<uuid>` and
 * `?state_group=backlog` each returned all 34, and there is no views endpoint. So
 * filtering happens in the gateway or nowhere.
 *
 * Two caveats worth carrying, both learned from the docs rather than from
 * probing. `fields` IS honoured and cuts the same payload, so field selection can
 * be pushed down even though filtering cannot (see SYNC-26). And newer Plane
 * exposes filtering on `list_work_items` through its own MCP server — if the
 * instance is ever upgraded, check whether this tool still earns its place.
 *
 * `holder` has no equivalent in any Plane view at any version: it comes from the
 * lease table, so "what is agent X working on" is answerable only here.
 *
 * This file deliberately contains no filtering logic. It resolves module
 * membership, which needs an API call, and hands everything else to the shared
 * predicate — so `find(ready:true)` and `next` cannot disagree about what ready
 * means, which they did until SYNC-32.
 */

export interface FindQuery {
  projectId: string;
  /** The caller's Plane user id; see `Predicate.viewer`. */
  viewer: string | null;
  labels?: string[] | undefined;
  priority?: WorkItem['priority'] | undefined;
  stateGroup?: State['group'] | undefined;
  moduleId?: string | undefined;
  /** An agent name, or 'any' / 'none' to filter on whether anyone holds it. */
  holder?: string | undefined;
  parentId?: string | undefined;
  ready?: boolean | undefined;
  /** The token's capabilities. Applied only when `ready` is asked for. */
  capabilities?: string[] | undefined;
  limit?: number | undefined;
  fields?: string[] | undefined;
}

export interface FindResult {
  items: WorkItemView[];
  /** Matches before `limit` was applied, so a truncated answer is visibly truncated. */
  matched: number;
  /**
   * Present only when the blocker budget ran out mid-answer, which takes an
   * extraordinary number of simultaneously-ready items. It means `ready` here is
   * an upper bound: some of these may still be blocked, and `claim` will say so.
   *
   * Reported rather than absorbed for the same reason `matched` is: a caller who
   * cannot tell a complete answer from a truncated one will treat the truncated
   * one as complete, and that specific mistake is what SYNC-65 was.
   */
  blockersUnchecked?: number;
}

export async function find(plane: PlaneClient, pool: Pool, q: FindQuery): Promise<FindResult> {
  // The one predicate input this tool has to fetch for itself: module membership
  // lives behind its own endpoint rather than on the work item.
  const moduleMembers = q.moduleId
    ? await plane.moduleIssueIds(q.projectId, q.moduleId)
    : undefined;

  const { items, matched, ctx, blockersUnchecked } = await resolve(plane, pool, {
    projectId: q.projectId,
    viewer: q.viewer,
    ...(q.labels ? { labels: q.labels } : {}),
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.stateGroup ? { stateGroup: q.stateGroup } : {}),
    ...(moduleMembers ? { moduleMembers } : {}),
    ...(q.holder ? { holder: q.holder } : {}),
    ...(q.parentId ? { parentId: q.parentId } : {}),
    ...(q.ready ? { ready: q.ready } : {}),
    ...(q.capabilities?.length ? { capabilities: q.capabilities } : {}),
    limit: q.limit ?? 25,
    ...(q.fields ? { fields: q.fields } : {}),
  });

  return {
    matched,
    items: items.map((i) => viewOf(i, ctx)),
    ...(blockersUnchecked ? { blockersUnchecked } : {}),
  };
}
