import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import type { PlaneClient, State, WorkItem } from './plane.js';

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

export interface TreeNode {
  workItemId: string;
  readableId: string;
  title: string;
  state: string;
  priority: WorkItem['priority'];
  /** Present only while someone holds it. */
  holder?: string;
  expiresAt?: string;
  children?: TreeNode[];
  /** Set when `depth` stopped the walk, so a truncated tree is never mistaken for a complete one. */
  truncated?: true;
}

export interface Tree {
  /** Root first, ending at the requested item's parent. Empty when it is a root. */
  path: Array<{ workItemId: string; readableId: string; title: string }>;
  node: TreeNode;
  /** Unfinished descendants, at any depth. What "how much is left" means. */
  openDescendants: number;
}

const DONE = new Set<State['group']>(['completed', 'cancelled']);

export async function tree(
  plane: PlaneClient,
  pool: Pool,
  opts: { projectId: string; workItemId: string; depth?: number },
): Promise<Tree> {
  const depth = opts.depth ?? 5;

  const [items, states, leases] = await Promise.all([
    plane.listWorkItems(opts.projectId),
    plane.states(opts.projectId),
    pool
      .query<{ work_item_id: string; holder: string; expires_at: Date }>(
        `select work_item_id, holder, expires_at from lease
          where state = 'held' and expires_at > now()`,
      )
      .then((r) => new Map(r.rows.map((x) => [x.work_item_id, x]))),
  ]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const root = byId.get(opts.workItemId);
  if (!root) {
    throw new GatewayError('NOT_FOUND', 'No such work item in this project', {
      workItemId: opts.workItemId,
    });
  }

  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const childrenOf = new Map<string, WorkItem[]>();
  for (const i of items) {
    if (!i.parent) continue;
    const kids = childrenOf.get(i.parent);
    if (kids) kids.push(i);
    else childrenOf.set(i.parent, [i]);
  }

  let open = 0;

  const build = (item: WorkItem, left: number, seen: Set<string>): TreeNode => {
    const held = leases.get(item.id);
    const node: TreeNode = {
      workItemId: item.id,
      readableId: `#${item.sequence_id}`,
      title: item.name,
      state: states.find((s) => s.id === item.state)?.name ?? 'unknown',
      priority: item.priority,
      ...(held ? { holder: held.holder, expiresAt: held.expires_at.toISOString() } : {}),
    };

    // A cycle cannot be produced through `capture`, but `update_issue` can set any
    // parent and Plane does not stop it. Recursing forever on someone's mistake is
    // a worse failure than reporting the tree we could safely walk.
    const kids = (childrenOf.get(item.id) ?? []).filter((k) => !seen.has(k.id));
    if (!kids.length) return node;
    if (left <= 0) return { ...node, truncated: true };

    node.children = kids
      .sort((a, b) => a.sequence_id - b.sequence_id)
      .map((k) => {
        if (!DONE.has(groupOf.get(k.state) as State['group'])) open++;
        return build(k, left - 1, new Set([...seen, k.id]));
      });
    return node;
  };

  const node = build(root, depth, new Set([root.id]));

  // Upwards: what this item sits inside. An agent handed a leaf otherwise has no
  // way to see the work it is part of without listing the project.
  const path: Tree['path'] = [];
  const climbed = new Set<string>([root.id]);
  let cursor = root.parent ? byId.get(root.parent) : undefined;
  while (cursor && !climbed.has(cursor.id)) {
    climbed.add(cursor.id);
    path.unshift({
      workItemId: cursor.id,
      readableId: `#${cursor.sequence_id}`,
      title: cursor.name,
    });
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }

  return { path, node, openDescendants: open };
}
