import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { resolve } from './query.js';
import { readableId, viewOf, type WorkItemView } from './view.js';

/**
 * The sub-tree under a work item, with lease state.
 *
 * Nothing else answers "what is under this, and what is left?". An agent had to
 * list the whole project — 29 fields per item — and reassemble the parent chain
 * itself, which costs the context the work needs.
 *
 * It has to be server-side for a reason beyond convenience: Plane knows the parent
 * links, but only the gateway knows who holds what. "What is left" without lease
 * state is actively misleading — an item can be unfinished *and* already being
 * worked, and an agent that cannot tell those apart duplicates someone's run.
 */

/**
 * A node is the shared work item view plus the two things only a tree has.
 * Composing rather than redeclaring is what stops `tree` drifting from `find`
 * about what a field like `labels` contains.
 */
export type TreeNode = WorkItemView & {
  children?: TreeNode[];
  /** Set when `depth` stopped the walk, so a truncated tree is never mistaken for a complete one. */
  truncated?: true;
};

export interface Tree {
  /** Root first, ending at the requested item's parent. Empty when it is a root. */
  path: Array<{ workItemId: string; readableId: string; title: string }>;
  /**
   * The addressed item. Present when `workItemId` was given, absent otherwise —
   * exactly one of this and `roots` is ever set.
   */
  node?: TreeNode;
  /**
   * Every item with no parent, when no item was addressed.
   *
   * This is the question a person opens a tracker with — "what are the top-level
   * things here" — and until now nothing could answer it. `tree` could only drill
   * down from an id you already had, which assumes you know what you are looking
   * for; `board` counts modules, which is a different cut and says nothing about
   * what any item is part of.
   */
  roots?: TreeNode[];
  /**
   * Unfinished work below the top of whatever was asked for. Descendants of the
   * addressed item, or — since the implicit parent of a forest is the project —
   * every unfinished item in the project when none was addressed.
   */
  openDescendants: number;
}

const DONE = new Set<State['group']>(['completed', 'cancelled']);

export async function tree(
  plane: PlaneClient,
  pool: Pool,
  opts: {
    projectId: string;
    /** The caller's Plane user id; see `Predicate.viewer`. */
    viewer: string | null;
    /** Omit for the forest of top-level items. */
    workItemId?: string | undefined;
    depth?: number | undefined;
    fields?: string[] | undefined;
    /** Show only what could be claimed — and the containers holding it. */
    ready?: boolean | undefined;
    capabilities?: string[] | undefined;
  },
): Promise<Tree> {
  // Two defaults because they answer different questions. Drilling into an item
  // you named, five levels is generous and cheap. Opening a whole project, the
  // point is a screen a person can read, and a forest expanded five deep is the
  // project listing again — which is what `tree` exists to avoid handing anyone.
  const depth = opts.depth ?? (opts.workItemId ? 5 : 2);

  // `all` rather than the matched set: a tree needs every item to resolve parent
  // links, even the ones a `ready` filter would exclude from its own nodes.
  const { all: items, ctx, groupOf, reasons } = await resolve(plane, pool, {
    projectId: opts.projectId,
    viewer: opts.viewer,
    ...(opts.fields ? { fields: opts.fields } : {}),
    ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
  });

  const byId = new Map(items.map((i) => [i.id, i]));
  const root = opts.workItemId ? byId.get(opts.workItemId) : undefined;
  if (opts.workItemId && !root) {
    throw new GatewayError('NOT_FOUND', 'No such work item in this project', {
      workItemId: opts.workItemId,
    });
  }

  const childrenOf = new Map<string, WorkItem[]>();
  for (const i of items) {
    if (!i.parent) continue;
    const kids = childrenOf.get(i.parent);
    if (kids) kids.push(i);
    else childrenOf.set(i.parent, [i]);
  }

  let open = 0;

  /**
   * Under `ready`, a container is kept when something claimable sits beneath it.
   * Dropping it would hide its children — a parent is unclaimable *because* the
   * work is in the children, so pruning it prunes the answer.
   */
  const hasOpenDescendant = (item: WorkItem): boolean =>
    (childrenOf.get(item.id) ?? []).some(
      (k) => reasons(k).length === 0 || hasOpenDescendant(k),
    );

  const build = (item: WorkItem, left: number, seen: Set<string>): TreeNode => {
    const node: TreeNode = viewOf(item, ctx);

    // A cycle cannot be produced through `capture`, but `update_issue` can set any
    // parent and Plane does not stop it. Recursing forever on someone's mistake is
    // a worse failure than reporting the tree we could safely walk.
    const kids = (childrenOf.get(item.id) ?? []).filter((k) => !seen.has(k.id));
    if (!kids.length) return node;
    if (left <= 0) return { ...node, truncated: true };

    node.children = kids
      .sort((a, b) => a.sequence_id - b.sequence_id)
      .filter((k) => !opts.ready || reasons(k).length === 0 || hasOpenDescendant(k))
      .map((k) => {
        if (!DONE.has(groupOf.get(k.state) as State['group'])) open++;
        return build(k, left - 1, new Set([...seen, k.id]));
      });
    return node;
  };

  if (!root) {
    // An item whose parent is not in this project's listing counts as a root
    // rather than being dropped. Plane allows the parent to be deleted from
    // under it, and an item that appears in no tree at all is work nobody can
    // find — the failure this view exists to end, arriving by another door.
    const roots = items
      .filter((i) => !i.parent || !byId.has(i.parent))
      .sort((a, b) => a.sequence_id - b.sequence_id)
      .filter((i) => !opts.ready || reasons(i).length === 0 || hasOpenDescendant(i))
      .map((i) => {
        // Counted here, unlike the addressed case, because the implicit parent of
        // a forest is the project: a top-level item IS a descendant of what was
        // asked about. Leaving them out would report `openDescendants: 0` for a
        // board of nothing but unparented open work, which is the exact shape
        // this whole change exists to make visible.
        if (!DONE.has(groupOf.get(i.state) as State['group'])) open++;
        // One level shallower: the roots themselves occupy the first level of the
        // requested depth.
        return build(i, depth - 1, new Set([i.id]));
      });
    return { path: [], roots, openDescendants: open };
  }

  const node = build(root, depth, new Set([root.id]));

  // Upwards: what this item sits inside. An agent handed a leaf otherwise has no
  // way to see the work it is part of without listing the project.
  const path: Tree['path'] = [];
  const identifier = ctx.identifier;
  const climbed = new Set<string>([root.id]);
  let cursor = root.parent ? byId.get(root.parent) : undefined;
  while (cursor && !climbed.has(cursor.id)) {
    climbed.add(cursor.id);
    path.unshift({
      workItemId: cursor.id,
      readableId: readableId(cursor.sequence_id, identifier),
      title: cursor.name,
    });
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }

  return { path, node, openDescendants: open };
}
