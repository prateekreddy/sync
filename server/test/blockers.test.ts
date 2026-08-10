import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { board } from '../src/board.js';
import { find } from '../src/find.js';
import { PlaneClient } from '../src/plane.js';
import type { Relations, State, WorkItem } from '../src/plane.js';
import { explain, readyCandidates, verifyClaimable } from '../src/readiness.js';
import { NO_RELATIONS, relationsWith } from './relations.js';
import { createPool } from '../src/db.js';

/**
 * SYNC-65: `find(ready: true)` listed items that `claim` then refused.
 *
 * The gate has two halves — a screen over the item listing, and a `blocked_by`
 * lookup costing a request per item. `claim` and `why` ran both. `find` and
 * `board` ran the first and reported it as the whole gate. Nothing errored; the
 * browse path simply computed a subset of the rule and gave it the rule's name.
 *
 * It survived a suite that exists specifically to assert these tools agree,
 * because every fake Plane stubbed `relations` to return nothing. With no item
 * ever blocked, the half and the whole are the same function, and the tests
 * compared two things that could not differ. So the fixture here is the one the
 * old doubles could not express: a board with a real, unfinished blocker on it.
 *
 * Every test drives the real entry points and asserts they AGREE. A future
 * regression that reintroduces a second definition of readiness fails here even
 * if that second definition is internally consistent.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();

const ids = new Map<string, string>();
const id = (k: string): string => {
  const hit = ids.get(k);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(k, made);
  return made;
};

beforeEach(async () => {
  await pool.query('truncate lease');
});
afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

const STATES: State[] = [
  { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

let seq = 0;
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: id(key),
  sequence_id: ++seq,
  project: PROJECT,
  name: key,
  description_html: '<p>spec</p>',
  state: 'backlog',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

/**
 * The board under test.
 *
 * `gated` is the item at the centre of the bug: perfectly well-formed, so the
 * screen passes it, and blocked by unfinished work, so `claim` refuses it.
 */
const BOARD = [
  wi('gated'),
  wi('open-blocker'),
  wi('freed'),
  wi('finished-blocker', { state: 'done' }),
  wi('clean'),
  wi('no-spec', { description_html: '' }),
];

const EDGES: Record<string, Partial<Relations>> = {
  gated: { blocked_by: [{ project_id: PROJECT, issue_id: id('open-blocker') }] },
  freed: { blocked_by: [{ project_id: PROJECT, issue_id: id('finished-blocker') }] },
};

interface FakeOpts {
  edges?: Record<string, Partial<Relations>>;
  items?: WorkItem[];
  /** Ids whose relations lookup fails, standing in for a Plane that is unwell. */
  unreadable?: string[];
  /** Work items that cannot be fetched — a blocker in a project we cannot see. */
  missing?: string[];
}

let relationCalls: string[] = [];
let itemFetches: string[] = [];

const fakePlane = (opts: FakeOpts = {}): PlaneClient => {
  const items = opts.items ?? BOARD;
  const edges = opts.edges ?? EDGES;
  const byKey = new Map(Object.entries(edges).map(([k, v]) => [id(k), v]));
  return Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    states: async () => STATES,
    labels: async () => [],
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async (_p: string, itemId: string) => {
      relationCalls.push(itemId);
      if (opts.unreadable?.some((k) => id(k) === itemId)) throw new Error('relations unavailable');
      const hit = byKey.get(itemId);
      return hit ? relationsWith(hit) : NO_RELATIONS;
    },
    getWorkItem: async (_p: string, i: string) => {
      itemFetches.push(i);
      const hit = items.find((x) => x.id === i);
      if (!hit) throw new Error('no such work item');
      return hit;
    },
  });
};

beforeEach(() => {
  relationCalls = [];
  itemFetches = [];
});

const titles = (xs: Array<{ title: string }>) => xs.map((x) => x.title).sort();

describe('the browse path applies the blocker gate', () => {
  it('withholds an item whose blocker is unfinished — the reported defect', async () => {
    const got = await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(titles(got.items)).not.toContain('gated');
  });

  it('and claim refuses exactly the same item, which is the whole point', async () => {
    const plane = fakePlane();
    const listed = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    for (const item of listed.items) {
      // Anything a browse called ready must survive the gate that hands it out.
      // Before this change `gated` appeared above and failed here.
      expect(await verifyClaimable(plane, PROJECT, item.workItemId, { pool })).toEqual([]);
    }
    expect(await verifyClaimable(plane, PROJECT, id('gated'), { pool })).toEqual([
      `blocked by #${BOARD[1]!.sequence_id}`,
    ]);
  });

  it('next and find(ready) still agree, now that both know about blockers', async () => {
    const plane = fakePlane();
    const fromNext = await readyCandidates(plane, pool, { projectId: PROJECT, limit: 50 });
    const fromFind = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(titles(fromFind.items)).toEqual(titles(fromNext));
    expect(titles(fromNext)).not.toContain('gated');
  });

  it('why gives the same reason the gate acted on, not a restatement of it', async () => {
    const plane = fakePlane();
    const got = await explain(plane, pool, { projectId: PROJECT, workItemId: id('gated') });
    expect(got.claimable).toBe(false);
    expect(got.reasons).toEqual(await verifyClaimable(plane, PROJECT, id('gated'), { pool }));
  });

  it('names the blocker only once, rather than twice for the two halves', async () => {
    // `explain` used to add verifyClaimable on top of the predicate. Now the
    // predicate resolves blockers itself, so doing both would print the reason
    // twice — a duplicate that reads like two separate blockers.
    const got = await explain(fakePlane(), pool, { projectId: PROJECT, workItemId: id('gated') });
    expect(got.reasons.filter((r) => r.startsWith('blocked by')).length).toBe(1);
  });

  it('releases an item once its blocker is finished', async () => {
    // The other direction matters as much: treating any relation as blocking
    // would strand an item permanently the moment anyone linked anything.
    const got = await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(titles(got.items)).toContain('freed');
  });
});

describe('board counts blockers the same way', () => {
  it('puts a blocked item in `blocked`, not `ready`', async () => {
    const got = await board(fakePlane(), pool, { projectId: PROJECT });
    // clean, freed and open-blocker are ready; gated and no-spec are not;
    // finished-blocker is done.
    expect(got.project.ready).toBe(3);
    expect(got.project.blocked).toBe(2);
    expect(got.project.done).toBe(1);
  });

  it('and its ready count equals what find(ready) actually lists', async () => {
    // The reported symptom was these two disagreeing: a human reading `board`
    // believed a dependency gate was looser than the one being enforced.
    const plane = fakePlane();
    const b = await board(plane, pool, { projectId: PROJECT });
    const f = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(f.items.length).toBe(b.project.ready);
  });

  it('still buckets every item exactly once', async () => {
    const p = (await board(fakePlane(), pool, { projectId: PROJECT })).project;
    expect(p.done + p.held + p.ready + p.blocked).toBe(p.total);
  });
});

describe('what a blocker lookup costs', () => {
  it('pays nothing for items the screen already withholds', async () => {
    // The cost argument for skipping blockers on browse was O(backlog). It is
    // not: an item withheld for another reason stays withheld whatever its
    // relations say, and a finished item is nobody's candidate. So the bill is
    // the size of the ready set — the same set claim would have verified anyway.
    await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(relationCalls).not.toContain(id('no-spec'));
    expect(relationCalls).not.toContain(id('finished-blocker'));
  });

  it('costs one lookup, not the project, when asking about one item', async () => {
    await explain(fakePlane(), pool, { projectId: PROJECT, workItemId: id('gated') });
    expect(relationCalls).toEqual([id('gated')]);
  });

  it('reads a blocker state from the listing rather than fetching it again', async () => {
    // Plane's relations payload has ids but no state, so every blocker's state
    // has to come from somewhere. Taking it from the listing already in hand
    // removes a fetch per blocker on the commonest case by far.
    await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(itemFetches).toEqual([]);
  });

  it('does fetch a blocker that is not in the listing', async () => {
    const plane = fakePlane({
      edges: { gated: { blocked_by: [{ project_id: OTHER_PROJECT, issue_id: id('elsewhere') }] } },
    });
    // Not in BOARD, so the fetch fails and the blocker counts as open.
    expect(
      await verifyClaimable(plane, PROJECT, id('gated'), { pool, viewer: null }),
    ).toEqual(['blocked by an unreadable item']);
    // Blocker fetches only. The item under test is fetched too since SYNC-70, to
    // read its assignees, and counting that here would hide the thing this
    // measures — how many *blockers* had to be resolved.
    expect(itemFetches.filter((f) => f !== id('gated'))).toEqual([id('elsewhere')]);
  });
});

describe('when Plane is unwell', () => {
  it('treats an unreadable blocker as open, refusing rather than dispatching', async () => {
    // Refusing work that might be blocked costs a pause. Dispatching an agent at
    // work that cannot succeed costs a run and something a human has to review.
    const plane = fakePlane({ missing: ['open-blocker'] });
    const got = await verifyClaimable(plane, PROJECT, id('gated'), { pool });
    expect(got.length).toBe(1);
  });

  it('does not fail a whole browse because one item\'s relations are unreadable', async () => {
    const got = await find(fakePlane({ unreadable: ['gated'] }), pool, {
      projectId: PROJECT,
      ready: true,
      limit: 50,
    });
    // The rest of the board is still answerable, and claim stays strict about
    // the one item this could not judge.
    expect(titles(got.items)).toContain('clean');
  });

  it('tolerates a relations payload with buckets missing entirely', async () => {
    // Plane is not obliged to send a bucket it has nothing to put in. This was
    // unreachable while the lookup only ran for items someone had linked; it
    // runs across whole boards now, so an empty project must not throw.
    const plane = Object.assign(fakePlane(), {
      relations: async () => ({}) as Relations,
    });
    const got = await find(plane, pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(got.items.length).toBeGreaterThan(0);
  });
});

describe('the budget', () => {
  it('reports what it did not check instead of counting it ready', async () => {
    // A cap that silently stopped checking would read exactly like a clean pass,
    // which is the failure this module exists to remove — in a subtler form.
    const many = Array.from({ length: 5 }, (_, i) => wi(`bulk-${i}`));
    const { resolve } = await import('../src/query.js');
    const got = await resolve(fakePlane({ items: many }), pool, {
      projectId: PROJECT,
      ready: true,
      blockerBudget: 2,
    });
    expect(got.blockersUnchecked).toBe(3);
    expect(relationCalls.length).toBe(2);
  });

  it('checks everything on an ordinary board, so the number is zero', async () => {
    const { resolve } = await import('../src/query.js');
    const got = await resolve(fakePlane(), pool, { projectId: PROJECT, ready: true });
    expect(got.blockersUnchecked).toBe(0);
  });
});
