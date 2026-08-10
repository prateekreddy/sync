import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { claim } from '../src/lease.js';
import { classify, leasesOf, reconcile } from '../src/reconcile.js';
import type { WorkItem } from '../src/plane.js';

/**
 * Does Plane still agree with the lease table?
 *
 * The gateway is authoritative for who holds what and Plane is a mirror, and
 * nothing ever compared the two. Drift was permanent and silent, and the way it
 * got found was a human noticing something odd — which is how the 2026-08-04
 * collision surfaced.
 *
 * SYNC-72 retries writes that FAILED. These are the cases where nothing was ever
 * owed: a person edited Plane, two replicas raced, a landed write was later
 * overwritten. No retry can reach any of them.
 *
 * The hard requirement, and the reason this cannot be "make Plane match the
 * table": a person putting their name on an item an agent holds is the SYNC-71
 * revoke signal — the supported way to take work back. Repairing that would undo
 * a human's decision using machinery built to protect it.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const AGENT_USER = randomUUID();
const HUMAN_USER = randomUUID();

const STATES = new Map([
  ['backlog', 'backlog'],
  ['doing', 'started'],
  ['done', 'completed'],
]);
const groupOf = (id: string) => STATES.get(id);

/** A Plane that answers with exactly the items a test names. */
const fakePlane = (items: WorkItem[]) =>
  ({
    listWorkItems: async () => items,
    states: async () => [
      { id: 'backlog', name: 'Backlog', group: 'backlog', default: true },
      { id: 'doing', name: 'In Progress', group: 'started', default: false },
      { id: 'done', name: 'Done', group: 'completed', default: false },
    ],
    stateByGroup: async () => ({ id: 'doing' }),
    updateWorkItem: async () => ({}),
    comment: async () => ({}),
  }) as never;

const item = (over: Partial<WorkItem> & { id: string }): WorkItem =>
  ({
    sequence_id: 1,
    project: PROJECT,
    name: 'an item',
    description_html: '<p>x</p>',
    state: 'doing',
    priority: 'medium',
    assignees: [],
    labels: [],
    parent: null,
    is_draft: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as WorkItem;

let agent = '';

beforeEach(async () => {
  await pool.query('truncate lease');
  agent = `t-rec-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `insert into agent_token (name, token_sha256, plane_user_id) values ($1, $2, $3)
     on conflict (name) do update set plane_user_id = excluded.plane_user_id`,
    [agent, randomUUID(), AGENT_USER],
  );
});

afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

/** A live lease held by our agent. */
const held = async (workItemId: string) => {
  await claim(pool, { workItemId, projectId: PROJECT, holder: `agent:${agent}`, ttlSeconds: 600 });
  // Nothing owed: the gateway believes it finished writing, which is what makes
  // a disagreement drift rather than a queued write.
  await pool.query('update lease set mirrored = true where work_item_id = $1', [workItemId]);
};

const kinds = async (items: WorkItem[]) =>
  classify(items, await leasesOf(pool, PROJECT), groupOf).map((d) => d.kind);

describe('comparing the board with the lease table', () => {
  it('says nothing when the two agree', async () => {
    const id = randomUUID();
    await held(id);
    expect(await kinds([item({ id, assignees: [AGENT_USER], state: 'doing' })])).toEqual([]);
  });

  it('spots a claim Plane never kept', async () => {
    // The dangerous one: the lease says taken, the board says free, so the item
    // reads as available to every human and every agent looking at Plane.
    const id = randomUUID();
    await held(id);
    expect(await kinds([item({ id, assignees: [], state: 'backlog' })])).toEqual(['claimLost']);
  });

  it('spots our name left on an item after the lease ended', async () => {
    const id = randomUUID();
    await held(id);
    await pool.query(
      `update lease set state = 'released', ended_at = now(), expires_at = now()
        where work_item_id = $1`,
      [id],
    );
    expect(await kinds([item({ id, assignees: [AGENT_USER], state: 'doing' })])).toEqual([
      'staleAssignee',
    ]);
  });

  it('says nothing about a finished item that still names who did it', async () => {
    // The one that nearly did real damage. Measured on the first live pass this
    // reported 65 items, all of them finished: `mirrorComplete` sets the done
    // state and the name stays as the record of who did the work, so "ended
    // lease, name still there" describes the normal end of every task.
    //
    // And the repair for this class returns the item to the pool -- unstarted,
    // unassigned, with a comment -- so without the state condition the pass
    // would have reopened 65 completed items.
    const id = randomUUID();
    await held(id);
    await pool.query(
      `update lease set state = 'completed', ended_at = now(), expires_at = now()
        where work_item_id = $1`,
      [id],
    );
    expect(await kinds([item({ id, assignees: [AGENT_USER], state: 'done' })])).toEqual([]);
  });

  it('never calls a human taking the work back a fault to be fixed', async () => {
    // SYNC-71: assigning the item to yourself is how a person revokes it. This
    // must be reported and never repaired, or the gateway silently undoes a
    // decision using the machinery built to respect it.
    const id = randomUUID();
    await held(id);
    expect(await kinds([item({ id, assignees: [HUMAN_USER], state: 'doing' })])).toEqual([
      'humanIntervened',
    ]);
  });

  it('reports work in progress that no lease covers', async () => {
    expect(await kinds([item({ id: randomUUID(), assignees: [HUMAN_USER], state: 'doing' })])).toEqual(
      ['untracked'],
    );
  });

  it('leaves an owed write to the drain', async () => {
    // Not drift: the gateway knows it has a write outstanding and the outbox is
    // already retrying it. Reporting this would be reporting SYNC-72 working,
    // and repairing it would race the drain into a double write.
    const id = randomUUID();
    await held(id);
    await pool.query('update lease set mirrored = false where work_item_id = $1', [id]);
    expect(await kinds([item({ id, assignees: [], state: 'backlog' })])).toEqual([]);
  });

  it('says nothing about an item whose assignees were not fetched', async () => {
    // `undefined` is not `[]`. Treating a field the listing omitted as empty is
    // how a check fires on every item in the project at once.
    const id = randomUUID();
    await held(id);
    const bare = item({ id, state: 'doing' });
    delete (bare as { assignees?: unknown }).assignees;
    expect(await kinds([bare])).toEqual([]);
  });

  it('notices an item that disappeared from under a live lease', async () => {
    const id = randomUUID();
    await held(id);
    expect(await kinds([])).toEqual(['untracked']);
  });

  it('does not chase an ended lease whose item is gone', async () => {
    // Finished work whose item was deleted afterwards is not a problem anyone
    // needs told about.
    const id = randomUUID();
    await held(id);
    await pool.query(
      `update lease set state = 'completed', ended_at = now(), expires_at = now()
        where work_item_id = $1`,
      [id],
    );
    expect(await kinds([])).toEqual([]);
  });
});

/**
 * How much one pass is allowed to break.
 *
 * A classification rule is a predicate over a whole board, so being wrong about
 * it is never wrong about ONE item — it is wrong about every item of that shape
 * at once, unattended, every fifteen minutes. On 2026-08-10 a missing state
 * condition matched 65 finished items and the repair for that class returns an
 * item to the pool; it was caught by a human reading the output before the timer
 * fired, which is luck rather than design.
 *
 * So a large repair set is treated as evidence against the RULE rather than
 * against the board.
 */
describe('refusing to act on an implausible amount of drift', () => {
  const claimLostFor = async (n: number) => {
    const items: WorkItem[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await held(id);
      items.push(item({ id, assignees: [], state: 'backlog' }));
    }
    return items;
  };

  /** Ended leases whose name is still on an in-progress item: the repairable class. */
  const staleFor = async (n: number) => {
    const items: WorkItem[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await held(id);
      await pool.query(
        `update lease set state = 'released', ended_at = now(), expires_at = now()
          where work_item_id = $1`,
        [id],
      );
      items.push(item({ id, assignees: [AGENT_USER], state: 'doing' }));
    }
    return items;
  };

  it('reports a lost claim without ever putting it back', async () => {
    // Driven end to end on 2026-08-10 and removed from REPAIRABLE as a result.
    // A human moving a held item to Backlog produces exactly this state, and
    // revoke.ts reads the same observation as a takeback — correctly. Repairing
    // it re-assigns the item and re-starts it, undoing the person.
    const items = await claimLostFor(3);
    const r = await reconcile(fakePlane(items), pool, { projectId: PROJECT, repair: true });
    expect(r.counts.claimLost).toBe(3);
    expect(r.repaired).toBe(0);
    expect(r.refused).toBeUndefined();
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from lease where pending_mirror is not null and project_id = $1",
      [PROJECT],
    );
    expect(rows[0]!.n).toBe('0');
  }, 30_000);

  it('repairs a handful of stale assignees, which is what real drift looks like', async () => {
    const items: WorkItem[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await held(id);
      await pool.query(
        `update lease set state = 'released', ended_at = now(), expires_at = now()
          where work_item_id = $1`,
        [id],
      );
      items.push(item({ id, assignees: [AGENT_USER], state: 'doing' }));
    }
    const r = await reconcile(fakePlane(items), pool, { projectId: PROJECT, repair: true });
    expect(r.counts.staleAssignee).toBe(3);
    expect(r.repaired).toBe(3);
  }, 30_000);

  it('repairs nothing at all once the set is implausibly large', async () => {
    const items = await staleFor(4);
    const r = await reconcile(fakePlane(items), pool, {
      projectId: PROJECT,
      repair: true,
      ceiling: 3,
    });
    expect(r.refused).toBe(4);
    expect(r.repaired).toBe(0);
    // Refused before anything was attempted, not part-way through: a pass that
    // repaired three and stopped would leave a state nobody chose.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from lease where pending_mirror is not null and project_id = $1",
      [PROJECT],
    );
    expect(rows[0]!.n).toBe('0');
  }, 30_000);

  it('still reports every one of them', async () => {
    // Refusal stops the writing, not the looking. The count is the thing a
    // person needs in order to decide.
    const items = await staleFor(4);
    const r = await reconcile(fakePlane(items), pool, {
      projectId: PROJECT,
      repair: true,
      ceiling: 3,
    });
    expect(r.drift).toHaveLength(4);
    expect(r.counts.staleAssignee).toBe(4);
  }, 30_000);

  it('never repairs the two classes that are somebody else’s business', async () => {
    // humanIntervened is a person taking work back; untracked is work nobody
    // told the gateway about. Neither is ours to rewrite, and neither counts
    // toward the ceiling either.
    const mine = randomUUID();
    await held(mine);
    const items = [
      item({ id: mine, assignees: [HUMAN_USER], state: 'doing' }),
      item({ id: randomUUID(), assignees: [HUMAN_USER], state: 'doing' }),
    ];
    const r = await reconcile(fakePlane(items), pool, { projectId: PROJECT, repair: true });
    expect(r.counts.humanIntervened).toBe(1);
    expect(r.counts.untracked).toBe(1);
    expect(r.repaired).toBe(0);
    expect(r.refused).toBeUndefined();
  }, 30_000);
});
