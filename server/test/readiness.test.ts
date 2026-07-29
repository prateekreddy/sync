import { describe, expect, it } from 'vitest';
import { screen } from '../src/readiness.js';
import type { WorkItem } from '../src/plane.js';

/**
 * The cheap half of the readiness gate is a pure function, so it belongs in a unit
 * test rather than being inferred from counts in an end-to-end run.
 *
 * What it protects: an agent that claims an underspecified item burns tokens and
 * produces plausible garbage a human then has to review — worse than the item
 * sitting untouched.
 */
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'i',
  sequence_id: 1,
  project: 'p',
  name: 'Do the thing',
  description_html: '<p>Clear enough to act on.</p>',
  state: 's',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const labels = new Map<string, string>();

describe('readiness screen', () => {
  it('passes a well-formed unstarted item', () => {
    expect(screen(item(), 'unstarted', labels)).toEqual([]);
    expect(screen(item(), 'backlog', labels)).toEqual([]);
  });

  it('withholds items with no description', () => {
    expect(screen(item({ description_html: '' }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('no description'),
    );
  });

  it('treats markup-only descriptions as empty', () => {
    // An empty rich-text field round-trips as '<p></p>', which is not a spec.
    expect(screen(item({ description_html: '<p></p>' }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('no description'),
    );
  });

  it('withholds drafts', () => {
    expect(screen(item({ is_draft: true }), 'unstarted', labels)).toContainEqual(
      expect.stringContaining('draft'),
    );
  });

  it('withholds work already started, finished or cancelled', () => {
    for (const g of ['started', 'completed', 'cancelled']) {
      expect(screen(item(), g, labels).length).toBeGreaterThan(0);
    }
  });

  it('withholds items a human has flagged', () => {
    const m = new Map([['l1', 'needs-human']]);
    expect(screen(item({ labels: ['l1'] }), 'unstarted', m)).toContainEqual(
      expect.stringContaining('needs-human'),
    );
  });

  it('reports every reason, not just the first', () => {
    // The item surfaces in Plane with all of its problems, so a human can fix them
    // in one pass rather than discovering them one at a time.
    const m = new Map([['l1', 'blocked']]);
    const reasons = screen(
      item({ description_html: '', is_draft: true, labels: ['l1'] }),
      'completed',
      m,
    );
    expect(reasons.length).toBe(4);
  });
});
