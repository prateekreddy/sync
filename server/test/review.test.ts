import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PlaneClient, type Relations, type State, type WorkItem } from '../src/plane.js';
import {
  assess,
  groupings,
  PAST_TITLES,
  REVIEW_TITLE,
  reviewProject,
  type Grouping,
} from '../src/review.js';

/**
 * The review's job is not to notice that a board is flat — a human noticing was
 * never the bottleneck. It is to hand somebody a decision small enough to make:
 * here are four items that were all discovered while working SYNC-40, do they
 * belong under it. Naming a problem people already know about does not move it.
 */

const PROJECT = randomUUID();

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'doing', name: 'In Progress', group: 'started', default: true },
  { id: 'done', name: 'Done', group: 'completed', default: true },
];
const groupOf = new Map(STATES.map((s) => [s.id, s.group]));

let seq = 0;
const wi = (id: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id,
    sequence_id: ++seq,
    name: id,
    state: 'backlog',
    priority: 'none',
    labels: [],
    parent: null,
    is_draft: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as WorkItem;

/** N loose open items, which is the shape every one of these tests is about. */
const loose = (n: number, from = 'x') =>
  Array.from({ length: n }, (_, i) => wi(`${from}${i}`));

describe('when a top level has stopped being readable', () => {
  it('leaves a short list alone — that is a top level, not a backlog', () => {
    expect(assess(loose(6), groupOf).unreadable).toBe(false);
  });

  it('trips once there is more at the top than anyone can take in', () => {
    const a = assess(loose(10), groupOf);
    expect(a.unreadable).toBe(true);
    expect(a.reason).toContain('10 open items sit at the top level');
  });

  it('counts finished work as neither a problem nor a container', () => {
    // Placing something that is already done changes nothing for anyone.
    expect(assess(loose(20).map((i) => ({ ...i, state: 'done' })), groupOf).unreadable).toBe(false);
  });

  it('catches a board with no spine even when little sits at the top', () => {
    // Twenty items all filed under one parent: nothing is rootless, so the first
    // rule sees a tidy board. One container for twenty items is not a plan.
    const parent = wi('one-container');
    const kids = Array.from({ length: 20 }, (_, i) => wi(`k${i}`, { parent: parent.id }));
    const a = assess([parent, ...kids], groupOf);
    expect(a.unreadable).toBe(true);
    expect(a.reason).toContain('only 1 containers');
  });

  it('does not call a young project unreadable for having no containers yet', () => {
    // Structure that has not been needed yet is not decay.
    expect(assess(loose(5), groupOf).unreadable).toBe(false);
  });
});

describe('finding the groups already implicit in a pile', () => {
  const byIdOf = (items: WorkItem[]) => new Map(items.map((i) => [i.id, i]));

  it('groups items discovered while working the same thing, under that thing', () => {
    const source = wi('source', { parent: 'somewhere' });
    const a = wi('a');
    const b = wi('b');
    const got = groupings(
      [a, b],
      new Map([
        [a.id, [source.id]],
        [b.id, [source.id]],
      ]),
      byIdOf([source, a, b]),
      new Map(),
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('provenance');
    expect(got[0]?.container?.id).toBe(source.id);
    expect(got[0]?.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('does not call a single item with a source a group', () => {
    const source = wi('s2');
    const a = wi('a2');
    expect(groupings([a], new Map([[a.id, [source.id]]]), byIdOf([source, a]), new Map())).toEqual(
      [],
    );
  });

  it('picks no direction between two items that merely point at each other', () => {
    // Each would be a group of one, which is under the minimum. That is what
    // stops an arbitrary direction being chosen, and it falls out of the size
    // rule rather than needing a rule of its own.
    const a = wi('a3');
    const b = wi('b3');
    const got = groupings(
      [a, b],
      new Map([
        [a.id, [b.id]],
        [b.id, [a.id]],
      ]),
      byIdOf([a, b]),
      new Map(),
    );
    expect(got).toEqual([]);
  });

  it('will use a top-level item as the container when the work points at it', () => {
    // The best possible outcome: filing three items under a fourth takes four
    // rows off the top level, not three. A source needs to be a real item, not a
    // parented one.
    const source = wi('hub');
    const kids = [wi('k1'), wi('k2'), wi('k3')];
    const got = groupings(
      [source, ...kids],
      new Map(kids.map((k) => [k.id, [source.id]])),
      byIdOf([source, ...kids]),
      new Map(),
    );
    expect(got[0]?.container?.id).toBe('hub');
    expect(got[0]?.members).toHaveLength(3);
  });

  it('does not offer a container that is already promised to another group', () => {
    // Filing under it now could close a loop, which gather refuses at the point
    // somebody runs it. Better not to propose what cannot be done.
    const top = wi('top');
    const mid = wi('mid');
    const leaves = [wi('lf1'), wi('lf2')];
    const got = groupings(
      [mid, ...leaves],
      new Map([
        [mid.id, [top.id]],
        [leaves[0]!.id, [top.id, mid.id]],
        [leaves[1]!.id, [top.id, mid.id]],
      ]),
      byIdOf([top, mid, ...leaves]),
      new Map(),
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.container?.id).toBe('top');
  });

  it('offers a shared label as a group, without inventing a name for it', () => {
    // A label is a category; a container wants an outcome. Proposing the label as
    // a title would propose exactly the kind of container that never finishes.
    const items = [wi('l1', { labels: ['x'] }), wi('l2', { labels: ['x'] }), wi('l3', { labels: ['x'] })];
    const got = groupings(items, new Map(), byIdOf(items), new Map([['x', 'search']]));
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('label');
    expect(got[0]?.label).toBe('search');
  });

  it('will not build a workstream out of a label that describes a state', () => {
    // A container called "blocked" is a queue, and a queue never finishes.
    const items = [
      wi('s1', { labels: ['b'] }),
      wi('s2', { labels: ['b'] }),
      wi('s3', { labels: ['b'] }),
    ];
    expect(groupings(items, new Map(), byIdOf(items), new Map([['b', 'blocked']]))).toEqual([]);
  });

  it('proposes each item once, and prefers the provenance answer', () => {
    // An item in two proposals is two contradictory suggestions about one thing.
    const source = wi('src');
    const shared = [wi('p1', { labels: ['x'] }), wi('p2', { labels: ['x'] })];
    const other = wi('p3', { labels: ['x'] });
    const got = groupings(
      [...shared, other],
      new Map(shared.map((s) => [s.id, [source.id]])),
      byIdOf([source, ...shared, other]),
      new Map([['x', 'backend']]),
    );
    const seen = got.flatMap((g: Grouping) => g.members.map((m) => m.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(got[0]?.kind).toBe('provenance');
    // p3 alone is under the label minimum, so nothing else is proposed.
    expect(got).toHaveLength(1);
  });
});

interface Seen {
  created: Array<Record<string, unknown>>;
  patched: Array<{ id: string; state: string }>;
}

const fakePlane = (items: WorkItem[], s: Seen, relations: Map<string, string[]> = new Map()) =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labelNames: async () => new Map([['x', 'search']]),
    labels: async () => [{ id: 'nh', name: 'needs-human', color: '#fff' }],
    stateByGroup: async (_p: string, group: string) => STATES.find((st) => st.group === group),
    relations: async (_p: string, id: string): Promise<Relations> =>
      ({
        blocking: [],
        blocked_by: [],
        duplicate: [],
        relates_to: (relations.get(id) ?? []).map((r) => ({ project_id: PROJECT, issue_id: r })),
        start_after: [],
        start_before: [],
        finish_after: [],
        finish_before: [],
      }) as Relations,
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      s.patched.push({ id, state: String(body['state']) });
      const found = items.find((i) => i.id === id);
      if (found) found.state = String(body['state']);
      return found as WorkItem;
    },
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      s.created.push(body);
      return wi(randomUUID(), { name: String(body['name']) });
    },
  }) as PlaneClient;

const seen = (): Seen => ({ created: [], patched: [] });

describe('what a review pass actually does', () => {
  it('raises one item, with the groups it found in it', async () => {
    const s = seen();
    const source = wi('the-source', { name: 'Make claiming atomic' });
    const items = [source, ...loose(12, 'r')];
    const related = new Map(items.slice(1, 4).map((i) => [i.id, [source.id]]));

    const out = await reviewProject(fakePlane(items, s, related), PROJECT);

    expect(out.raised).toBe(true);
    const html = String(s.created[0]?.['description_html']);
    expect(html).toContain('gather(containerId:');
    expect(html).toContain('Make claiming atomic');
    expect(s.created[0]?.['name']).toBe(REVIEW_TITLE);
  });

  it('does not raise a second one while the first is open', async () => {
    const s = seen();
    const out = await reviewProject(
      fakePlane([wi('open-review', { name: REVIEW_TITLE }), ...loose(12, 'q')], s),
      PROJECT,
    );
    expect(out.raised).toBe(false);
    expect(out.skipped).toContain('already open');
  });

  it('recognises a review raised under the old title, instead of filing a twin', async () => {
    // Renaming this review would otherwise orphan whatever is currently open and
    // leave a human holding two items about one problem.
    const s = seen();
    const out = await reviewProject(
      fakePlane([wi('old', { name: PAST_TITLES[0] as string }), ...loose(12, 'o')], s),
      PROJECT,
    );
    expect(out.raised).toBe(false);
    expect(s.created).toEqual([]);
  });

  it('repairs container states on the same pass, readable or not', async () => {
    // The nudge on claim and complete is fired and not awaited, so an outage
    // loses one silently. A status that is wrong forever is what this whole
    // mechanism exists to prevent, so something has to recompute from scratch.
    const s = seen();
    const parent = wi('stale-parent');
    const child = wi('finished-child', { parent: parent.id, state: 'done' });
    const out = await reviewProject(fakePlane([parent, child], s), PROJECT);

    expect(out.repaired).toBe(1);
    expect(s.patched).toEqual([{ id: parent.id, state: 'done' }]);
    // And it did not raise anything: two items is not an unreadable board.
    expect(out.raised).toBe(false);
  });
});
