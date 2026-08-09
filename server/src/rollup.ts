import { log } from './log.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { serial } from './serial.js';

/**
 * A container's state, derived from its children.
 *
 * Plane does not roll a parent's state up from its sub-items, and until now
 * neither did the gateway — so a container showed whatever was typed the moment
 * it was created and was never touched again. That is tolerable while a board is
 * a flat list, because nothing is a container. It stops being tolerable the
 * moment a human reads the top level, because the top level is *entirely*
 * containers: every row's status column is then wrong, and a list that is
 * confidently wrong is worse than no list at all.
 *
 * This has to be a write into Plane rather than something derived at read time.
 * Deriving it would fix `tree` and `board` and leave Plane's own UI — the thing
 * a person actually opens — still lying.
 *
 * One rule, in `rolledGroup`, and one deliberate asymmetry: a container is never
 * dragged back *out* of a done group. Closing a container is a human decision,
 * and reopening it under them is worse than a stale row.
 */

type Group = State['group'];

const DONE = new Set<Group>(['completed', 'cancelled']);

/**
 * What a container's state group should be, or null to leave it alone.
 *
 * Null rather than "the current group" so the caller can tell "already right"
 * from "must change", and skip the write. Most nudges land here: a child moving
 * within a group its siblings already cover changes nothing.
 */
export function rolledGroup(current: Group | undefined, children: Group[]): Group | null {
  // Not a container. An item with no sub-items owns its own state.
  if (!children.length) return null;

  // The asymmetry. Also what stops a reopened child from silently reopening a
  // whole chain of containers a human closed on purpose.
  if (current && DONE.has(current)) return null;

  if (children.every((g) => DONE.has(g))) {
    // Every child cancelled is not the same event as every child finished, and
    // a container that reads "Done" for work that was abandoned is the same
    // class of lie this whole file exists to remove.
    const want: Group = children.every((g) => g === 'cancelled') ? 'cancelled' : 'completed';
    return want === current ? null : want;
  }

  // Any child underway means the container is underway. Deliberately one-way:
  // a child released back to the pool does not un-start its parent, because the
  // work on it has in fact begun.
  if (children.some((g) => g === 'started')) return current === 'started' ? null : 'started';

  return null;
}

/**
 * Walk up from a child whose state just changed, fixing every container above it.
 *
 * Called past the commit point of a mirror write and never awaited by the request
 * that caused it — a claim must not get slower because the item happened to have
 * a parent. Best-effort throughout: a rollup that fails leaves a stale row, which
 * is exactly the state everything was in before this existed.
 *
 * Cost: one cheap read to learn whether there is a parent at all, and only then
 * the project listing that finding siblings requires. Most items have no parent,
 * so most calls stop at the first line.
 *
 * The walk continues past an ancestor that needed no change rather than stopping
 * there. It costs nothing — everything above is decided in memory — and it means
 * a chain left inconsistent by an earlier dropped write is repaired the next time
 * anything beneath it moves.
 */
export async function rollUp(
  plane: PlaneClient,
  projectId: string,
  childId: string,
): Promise<void> {
  const child = await plane.getWorkItem(projectId, childId).catch(() => null);
  if (!child?.parent) return;

  const [items, states] = await Promise.all([
    plane.listWorkItems(projectId),
    plane.states(projectId),
  ]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const groupOfState = new Map(states.map((s) => [s.id, s.group]));
  const childrenOf = new Map<string, WorkItem[]>();
  for (const i of items) {
    if (!i.parent) continue;
    const kids = childrenOf.get(i.parent);
    if (kids) kids.push(i);
    else childrenOf.set(i.parent, [i]);
  }

  // Current group per item, and then what we have just written — so an ancestor
  // two levels up is decided from the parent's new state rather than the one the
  // listing was fetched with.
  const group = new Map<string, Group | undefined>(
    items.map((i) => [i.id, groupOfState.get(i.state)]),
  );

  // `update_issue` can set any parent and Plane does not stop it, so a cycle is
  // reachable by mistake. Looping forever on someone's typo is a worse failure
  // than repairing the part of the chain we could safely walk.
  const seen = new Set<string>([childId]);
  let cursor: string | null = child.parent;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent: WorkItem | undefined = byId.get(cursor);
    if (!parent) return;

    const kids = childrenOf.get(cursor) ?? [];
    const want = rolledGroup(
      group.get(cursor),
      kids.map((k) => group.get(k.id)).filter((g): g is Group => g !== undefined),
    );

    if (want) {
      const target = await plane.stateByGroup(projectId, want);
      // A project with no state in that group is a project we cannot express the
      // answer in. Nothing to do, and nothing above can be decided either.
      if (!target) return;
      const id = cursor;
      try {
        // Through the shared chain, keyed on the container, so this queues behind
        // that container's own claim or completion instead of racing it — and so
        // two children finishing at once produce two ordered writes rather than
        // two concurrent ones.
        await serial(id, async () => {
          // No comment accompanies it. This is a derived fact rather than an
          // event, and a container would otherwise collect one note per child.
          await plane.updateWorkItem(projectId, id, { state: target.id });
        });
      } catch (err) {
        log.warn({ err, workItemId: id, op: 'rollup' }, 'container state rollup failed');
        return;
      }
      group.set(id, want);
      log.info({ workItemId: id, group: want }, 'container state rolled up');
    }

    cursor = parent.parent;
  }
}
