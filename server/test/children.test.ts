import { describe, expect, it } from 'vitest';
import { countOpenChildren } from '../src/readiness.js';
import type { State, WorkItem } from '../src/plane.js';

/**
 * Sub-items come free: every work item in a list response carries its own
 * `parent`, so the whole hierarchy is derivable from the one call the browse path
 * already makes. This is the arithmetic that makes the parent check cost nothing.
 */
const item = (id: string, parent: string | null, state: string): WorkItem => ({
  id,
  sequence_id: 1,
  project: 'p',
  name: id,
  description_html: '<p>x</p>',
  state,
  priority: 'none',
  assignees: [],
  labels: [],
  parent,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const groups = new Map<string, State['group']>([
  ['todo', 'unstarted'],
  ['doing', 'started'],
  ['done', 'completed'],
  ['dropped', 'cancelled'],
]);

describe('countOpenChildren', () => {
  it('counts only unfinished children', () => {
    const open = countOpenChildren(
      [
        item('parent', null, 'todo'),
        item('a', 'parent', 'todo'),
        item('b', 'parent', 'doing'),
        item('c', 'parent', 'done'),
      ],
      groups,
    );
    expect(open.get('parent')).toBe(2);
  });

  it('treats cancelled children as finished', () => {
    // A cancelled child is a decision, not outstanding work — the parent should
    // not stay stuck behind it forever.
    const open = countOpenChildren(
      [item('a', 'parent', 'dropped'), item('b', 'parent', 'done')],
      groups,
    );
    expect(open.get('parent')).toBeUndefined();
  });

  it('ignores items with no parent', () => {
    expect(countOpenChildren([item('x', null, 'todo')], groups).size).toBe(0);
  });

  it('handles several parents at once', () => {
    const open = countOpenChildren(
      [item('a', 'p1', 'todo'), item('b', 'p2', 'todo'), item('c', 'p2', 'todo')],
      groups,
    );
    expect([open.get('p1'), open.get('p2')]).toEqual([1, 2]);
  });

  it('counts a child in an unrecognised state as open', () => {
    // Fail safe: an unknown state group must not be read as "finished", or a
    // parent could be handed out while its children are still being worked.
    expect(countOpenChildren([item('a', 'p', 'mystery')], groups).get('p')).toBe(1);
  });
});
