import { describe, expect, it } from 'vitest';
import { PlaneClient, type State, type WorkItem } from '../src/plane.js';
import { rolledGroup, rollUp } from '../src/rollup.js';

/**
 * The rule and the walk are tested apart on purpose. `rolledGroup` is where every
 * judgement lives and it is a pure function of two arguments, so the interesting
 * cases cost nothing to state; `rollUp` only has to be shown to feed it the right
 * children, ascend, and stop.
 */

const STATES: State[] = [
  { id: 's-backlog', name: 'Backlog', group: 'backlog', default: true } as State,
  { id: 's-todo', name: 'Todo', group: 'unstarted', default: true } as State,
  { id: 's-doing', name: 'In Progress', group: 'started', default: true } as State,
  { id: 's-done', name: 'Done', group: 'completed', default: true } as State,
  { id: 's-cancelled', name: 'Cancelled', group: 'cancelled', default: true } as State,
];

const item = (id: string, state: string, parent: string | null = null): WorkItem =>
  ({
    id,
    sequence_id: Number(id.replace(/\D/g, '')) || 1,
    name: id,
    state,
    priority: 'none',
    labels: [],
    parent,
    is_draft: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }) as WorkItem;

interface Written {
  id: string;
  state: string;
}

/**
 * A PlaneClient over a fixed item list. `updateWorkItem` records the write and
 * applies it to the list, so a test can assert on what was written *and* on the
 * walk continuing from the value just written rather than the one it read.
 */
const planeOver = (items: WorkItem[], writes: Written[], fail?: string): PlaneClient => {
  const client = Object.assign(new PlaneClient('http://plane.invalid', 'svc', 'ws'), {
    getWorkItem: async (_p: string, id: string) => {
      const found = items.find((i) => i.id === id);
      if (!found) throw new Error('no such item');
      return found;
    },
    listWorkItems: async () => items,
    states: async () => STATES,
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      if (id === fail) throw new Error('plane said no');
      writes.push({ id, state: String(body['state']) });
      const found = items.find((i) => i.id === id);
      if (found) found.state = String(body['state']);
      return found as WorkItem;
    },
  });
  return client as PlaneClient;
};

describe('what a container’s state should be', () => {
  it('leaves a leaf alone — an item with no children owns its own state', () => {
    expect(rolledGroup('unstarted', [])).toBeNull();
  });

  it('completes a container once every child is finished', () => {
    expect(rolledGroup('started', ['completed', 'completed'])).toBe('completed');
  });

  it('counts a cancelled child as finished rather than outstanding', () => {
    expect(rolledGroup('started', ['completed', 'cancelled'])).toBe('completed');
  });

  it('cancels rather than completes when every child was abandoned', () => {
    // "Done" for work nobody did is the same class of lie as a stale status.
    expect(rolledGroup('started', ['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('starts a container as soon as any child is underway', () => {
    expect(rolledGroup('unstarted', ['started', 'backlog'])).toBe('started');
  });

  it('writes nothing when the container already says the right thing', () => {
    expect(rolledGroup('started', ['started', 'backlog'])).toBeNull();
    expect(rolledGroup('completed', ['completed'])).toBeNull();
  });

  it('never reopens a container a human closed', () => {
    // The one asymmetry. A child reopened under a closed parent leaves a stale
    // row, which is cheaper than overturning somebody's decision.
    expect(rolledGroup('completed', ['started', 'completed'])).toBeNull();
    expect(rolledGroup('cancelled', ['started'])).toBeNull();
  });

  it('does not un-start a container when its only live child is handed back', () => {
    // Release moves a child to `unstarted`. Work on the container has begun and
    // saying otherwise would erase that.
    expect(rolledGroup('started', ['unstarted', 'backlog'])).toBeNull();
  });
});

describe('walking up from a child that just moved', () => {
  it('does nothing at all for an item with no parent', async () => {
    const writes: Written[] = [];
    await rollUp(planeOver([item('a', 's-done')], writes), 'p', 'a');
    expect(writes).toEqual([]);
  });

  it('closes the container when the last child lands', async () => {
    const writes: Written[] = [];
    const items = [
      item('parent', 's-doing'),
      item('c1', 's-done', 'parent'),
      item('c2', 's-done', 'parent'),
    ];
    await rollUp(planeOver(items, writes), 'p', 'c2');
    expect(writes).toEqual([{ id: 'parent', state: 's-done' }]);
  });

  it('leaves the container open while a sibling is still outstanding', async () => {
    const writes: Written[] = [];
    const items = [
      item('parent', 's-doing'),
      item('c1', 's-done', 'parent'),
      item('c2', 's-todo', 'parent'),
    ];
    await rollUp(planeOver(items, writes), 'p', 'c1');
    expect(writes).toEqual([]);
  });

  it('carries a completion up two levels in one pass', async () => {
    // The grandparent is decided from the parent's NEW state, not the one the
    // listing was fetched with — which is the whole reason the walk tracks what
    // it has written.
    const writes: Written[] = [];
    const items = [
      item('top', 's-todo'),
      item('mid', 's-doing', 'top'),
      item('leaf', 's-done', 'mid'),
    ];
    await rollUp(planeOver(items, writes), 'p', 'leaf');
    expect(writes).toEqual([
      { id: 'mid', state: 's-done' },
      { id: 'top', state: 's-done' },
    ]);
  });

  it('keeps climbing past an ancestor that needed no change', async () => {
    // Self-healing: `top` is inconsistent because an earlier write was lost, and
    // nothing about `mid` changes on this pass. Stopping at the first no-op
    // would leave it wrong forever.
    const writes: Written[] = [];
    const items = [
      item('top', 's-todo'),
      item('mid', 's-doing', 'top'),
      item('leaf', 's-doing', 'mid'),
    ];
    await rollUp(planeOver(items, writes), 'p', 'leaf');
    expect(writes).toEqual([{ id: 'top', state: 's-doing' }]);
  });

  it('stops rather than deciding the next level from a write that failed', async () => {
    const writes: Written[] = [];
    const items = [
      item('top', 's-todo'),
      item('mid', 's-doing', 'top'),
      item('leaf', 's-done', 'mid'),
    ];
    await rollUp(planeOver(items, writes, 'mid'), 'p', 'leaf');
    expect(writes).toEqual([]);
  });

  it('survives a parent cycle instead of looping forever', async () => {
    // `update_issue` can set any parent and Plane does not stop it, so this is
    // reachable by mistake rather than hypothetical.
    const writes: Written[] = [];
    const items = [item('a', 's-done', 'b'), item('b', 's-doing', 'a')];
    await rollUp(planeOver(items, writes), 'p', 'a');
    expect(writes.length).toBeLessThanOrEqual(1);
  });
});
