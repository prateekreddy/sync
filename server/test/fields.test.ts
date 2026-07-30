import { describe, expect, it } from 'vitest';
import { PlaneClient } from '../src/plane.js';
import type { WorkItem } from '../src/plane.js';
import { screen } from '../src/readiness.js';

/**
 * `listWorkItems` asks Plane for only the fields we read. That saving is real —
 * 29 fields down to 13 — but the list is load-bearing and fails *silently* when
 * wrong: the readiness gate screens on `is_draft`, `state`, `parent`, `labels` and
 * `description_html`, so dropping one raises nothing at all. It simply stops
 * withholding work, and an agent picks up a draft or a flagged item.
 *
 * So these tests do not check the list against itself. They take a full Plane
 * response, cut it down to exactly what `fields=` would return, and then run the
 * gate over the result — the same failure the label bug had, caught this time by
 * exercising the wiring rather than the predicate.
 */

/** A work item with every field Plane actually sends, including the ones we drop. */
const full = (): Record<string, unknown> => ({
  id: 'i1',
  sequence_id: 42,
  project: 'p1',
  name: 'Do the thing',
  description_html: '<p>Clear enough to act on.</p>',
  state: 's-backlog',
  priority: 'high',
  assignees: [],
  labels: ['l1'],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  // Everything below is dropped by `fields=` and must not be needed.
  deleted_at: null,
  created_by: 'u1',
  updated_by: 'u1',
  archived_at: null,
  workspace: 'w1',
  sort_order: 65535,
  external_id: null,
  external_source: null,
  description_binary: null,
  description_text: null,
  completed_at: null,
  start_date: null,
  target_date: null,
  point: null,
  estimate_point: null,
  type_id: null,
});

/** What Plane returns once `fields=` is applied. */
const asPlaneWouldSend = (item: Record<string, unknown>): WorkItem => {
  const out: Record<string, unknown> = {};
  for (const f of PlaneClient.LIST_FIELDS) out[f] = item[f];
  return out as unknown as WorkItem;
};

describe('the fields we ask Plane for', () => {
  it('carries everything the readiness gate screens on', () => {
    // Each of these must flip the gate. If a field stops being requested, the
    // corresponding case silently returns [] and this fails.
    const cases: Array<[string, Partial<WorkItem>, string]> = [
      ['description_html', { description_html: '' }, 'no description'],
      ['is_draft', { is_draft: true }, 'draft'],
      ['labels', { labels: ['l1'] }, 'needs-human'],
    ];
    const names = new Map([['l1', 'needs-human']]);

    for (const [field, override, expected] of cases) {
      const item = asPlaneWouldSend({ ...full(), ...override });
      expect(
        screen(item, 'backlog', field === 'labels' ? names : new Map()).join(' '),
        `${field} is not being requested from Plane, so the gate stopped seeing it`,
      ).toContain(expected);
    }
  });

  it('still passes a genuinely ready item', () => {
    expect(screen(asPlaneWouldSend(full()), 'backlog', new Map())).toEqual([]);
  });

  it('leaves no consumer field undefined', () => {
    // Every property WorkItem declares must survive the trim, or the runtime
    // object disagrees with its own type and TypeScript cannot warn anyone.
    const item = asPlaneWouldSend(full());
    for (const key of [
      'id',
      'sequence_id',
      'name',
      'description_html',
      'state',
      'priority',
      'labels',
      'is_draft',
      'created_at',
      'updated_at',
    ] as const) {
      expect(item[key], `${key} is declared on WorkItem but not requested`).toBeDefined();
    }
    expect('parent' in item).toBe(true); // nullable, so presence is the check

    // `project` and `assignees` are deliberately NOT requested — nothing reads
    // them off a list, and both are optional on WorkItem so the type stays honest.
    expect(item.project).toBeUndefined();
    expect(item.assignees).toBeUndefined();
  });

  it('actually drops the bulk of the payload', () => {
    const before = JSON.stringify(full()).length;
    const after = JSON.stringify(asPlaneWouldSend(full())).length;
    expect(after).toBeLessThan(before * 0.7);
  });
});
