import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { claim } from '../src/lease.js';
import { classify, leasesOf } from '../src/reconcile.js';
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
