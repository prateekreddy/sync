import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { find } from '../src/find.js';
import { PlaneClient } from '../src/plane.js';
import type { Relations, State, WorkItem } from '../src/plane.js';
import { explain, verifyClaimable } from '../src/readiness.js';
import { reinstate, retract, retractedIn, retractionsFor } from '../src/retraction.js';
import { relationsWith, NO_RELATIONS } from './relations.js';
import { createPool } from '../src/db.js';

/**
 * SYNC-66: a wrong `blocked_by` gates real work forever.
 *
 * Plane's public API cannot delete a relation. Measured, not assumed — at v1.3.1,
 * the version we run, and still on `preview`:
 *
 *   work-items/<issue_id>/relations/
 *   IssueRelationListCreateAPIEndpoint.as_view(http_method_names=["get", "post"])
 *
 * Re-linking the pair with another type does not replace it either: Plane
 * bulk-creates (issue, related_issue, relation_type) rows with ignore_conflicts,
 * so a second type is a second row and the first keeps gating. That is what made
 * the reported behaviour so treacherous — `link` returned ok and the item stayed
 * blocked.
 *
 * So the gateway retracts rather than deletes. The gate is the gateway's rule,
 * and the tests below pin both halves of that: it must stop honouring the edge,
 * and it must not pretend the edge is gone.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();

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
  await pool.query('delete from relation_retraction where project_id = $1', [PROJECT]);
});
afterAll(async () => {
  await pool.query('truncate lease');
  await pool.query('delete from relation_retraction where project_id = $1', [PROJECT]);
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
  assignees: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const BOARD = [wi('gated'), wi('blocker'), wi('other')];

const EDGES: Record<string, Partial<Relations>> = {
  gated: { blocked_by: [{ project_id: PROJECT, issue_id: id('blocker') }] },
};

const fakePlane = (): PlaneClient => {
  const byKey = new Map(Object.entries(EDGES).map(([k, v]) => [id(k), v]));
  return Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => BOARD,
    states: async () => STATES,
    labels: async () => [],
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async (_p: string, itemId: string) => {
      const hit = byKey.get(itemId);
      return hit ? relationsWith(hit) : NO_RELATIONS;
    },
    getWorkItem: async (_p: string, i: string) => BOARD.find((x) => x.id === i)!,
  });
};

const retractBlocker = (reason = 'scope changed; not a real dependency') =>
  retract(pool, {
    projectId: PROJECT,
    workItemId: id('gated'),
    blockerId: id('blocker'),
    reason,
    actor: 'agent:tester',
  });

describe('retracting a blocker ungates the work', () => {
  it('claim refuses the item while the edge stands', async () => {
    const got = await verifyClaimable(fakePlane(), PROJECT, id('gated'), { pool });
    expect(got).toEqual([`blocked by #${BOARD[1]!.sequence_id}`]);
  });

  it('and accepts it once the dependency is retracted', async () => {
    await retractBlocker();
    expect(await verifyClaimable(fakePlane(), PROJECT, id('gated'), { pool })).toEqual([]);
  });

  it('the browse path agrees, rather than claim and find disagreeing again', async () => {
    // A retraction honoured by only one of them would be SYNC-65 in a new place,
    // and this time refusing work the board calls ready.
    const before = await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(before.items.map((i) => i.title)).not.toContain('gated');

    await retractBlocker();
    const after = await find(fakePlane(), pool, { projectId: PROJECT, ready: true, limit: 50 });
    expect(after.items.map((i) => i.title)).toContain('gated');
  });

  it('why stops naming a retracted blocker as a reason', async () => {
    await retractBlocker();
    const got = await explain(fakePlane(), pool, { projectId: PROJECT, workItemId: id('gated') });
    expect(got.claimable).toBe(true);
    expect(got.reasons).toEqual([]);
  });

  it('retracts only the named edge, not every blocker on the item', async () => {
    await retract(pool, {
      projectId: PROJECT,
      workItemId: id('gated'),
      blockerId: id('other'),
      reason: 'unrelated edge',
    });
    // `other` was retracted; `blocker` was not, and still gates.
    expect(await verifyClaimable(fakePlane(), PROJECT, id('gated'), { pool })).toEqual([
      `blocked by #${BOARD[1]!.sequence_id}`,
    ]);
  });

  it('does not leak across items — a retraction is about one pair', async () => {
    await retractBlocker();
    const keys = await retractedIn(pool, PROJECT);
    expect(keys.has(`${id('gated')}|${id('blocker')}`)).toBe(true);
    expect(keys.has(`${id('other')}|${id('blocker')}`)).toBe(false);
  });
});

describe('the decision is recorded, not just applied', () => {
  it('keeps who retracted it and why', async () => {
    await retractBlocker('the scope changed and this stopped being true');
    const [row] = await retractionsFor(pool, id('gated'));
    expect(row?.actor).toBe('agent:tester');
    expect(row?.reason).toBe('the scope changed and this stopped being true');
    expect(row?.blockerId).toBe(id('blocker'));
  });

  it('is idempotent, so correcting a mistake twice is not an error', async () => {
    await retractBlocker();
    await retractBlocker('said again');
    expect((await retractionsFor(pool, id('gated'))).length).toBe(1);
  });

  it('can be reinstated, and the gate blocks again', async () => {
    await retractBlocker();
    expect(await reinstate(pool, { workItemId: id('gated'), blockerId: id('blocker') })).toBe(true);
    expect(await verifyClaimable(fakePlane(), PROJECT, id('gated'), { pool })).toEqual([
      `blocked by #${BOARD[1]!.sequence_id}`,
    ]);
  });

  it('reports nothing to reinstate rather than claiming success', async () => {
    expect(await reinstate(pool, { workItemId: id('gated'), blockerId: id('blocker') })).toBe(false);
  });

  it('keeps the row after reinstatement, so the history survives', async () => {
    await retractBlocker();
    await reinstate(pool, { workItemId: id('gated'), blockerId: id('blocker') });
    const { rows } = await pool.query(
      'select active from relation_retraction where work_item_id = $1 and blocker_id = $2',
      [id('gated'), id('blocker')],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ active: false });
    // And it is not counted while inactive.
    expect((await retractedIn(pool, PROJECT)).size).toBe(0);
  });
});

describe('cost', () => {
  it('reads the project\'s retractions once, not once per item', async () => {
    let queries = 0;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(pool)), pool, {
      query: (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('relation_retraction')) queries++;
        return (pool.query as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    await find(fakePlane(), counting as typeof pool, {
      projectId: PROJECT,
      ready: true,
      limit: 50,
    });
    expect(queries).toBe(1);
  });

  it('a retracted edge costs no blocker fetch at all', async () => {
    // Retractions are applied before anything is looked up, so disregarding an
    // edge is cheaper than honouring it rather than more expensive.
    await retractBlocker();
    let fetched = 0;
    const plane = Object.assign(fakePlane(), {
      getWorkItem: async (_p: string, i: string) => {
        fetched++;
        return BOARD.find((x) => x.id === i)!;
      },
    });
    await verifyClaimable(plane, PROJECT, id('gated'), { pool, viewer: null });
    // One read, and it is not a blocker read: since SYNC-70 the claim path fetches
    // the item under consideration to see who it is assigned to. The point of this
    // test is that the retracted edge itself costs nothing, so the blocker is what
    // is counted — anything beyond the item under test would mean the retraction
    // was looked up rather than honoured from the table.
    expect(fetched).toBe(1);
  });
});
