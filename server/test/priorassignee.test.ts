import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { claim, release } from '../src/lease.js';
import { mirrorClaim, mirrorComplete, mirrorReturn } from '../src/mirror.js';
import { PlaneClient } from '../src/plane.js';
import type { Actor } from '../src/auth.js';
import type { State, WorkItem } from '../src/plane.js';

/**
 * Releasing a lease used to un-assign the item.
 *
 * `mirrorClaim` puts a name on the item and `mirrorReturn` wrote `assignees: []`
 * — so the natural hygiene sequence, claim then set fields then release the lease
 * you are not using, ended with the item unassigned. Nothing in the reply said
 * so; the release response reports only the lease transition. Reported against
 * PRAGMA-17 on 2026-08-03, and it took a step-by-step teardown to find, because
 * the obvious conclusion is "the agent forgot to assign it".
 *
 * What made it a real bug rather than a quirk: Plane assignment needs no lease
 * and predates this gateway, so a name a human put there to mean "this is in
 * dev6's queue" was state the gateway discarded without ever having created it.
 * The only workaround was to NOT release and let the lease lapse — keeping a
 * stale lease on the board to preserve an assignment, which is the opposite of
 * what leases are for.
 *
 * Simply not clearing is not available, and that is the part worth remembering.
 * The readiness gate tells its own writes from a human's by asking the lease
 * (rule 4 in assignment.ts): held, unmirrored, or still owing a write is ours,
 * anything else is intent. A released and mirrored lease is none of those, so a
 * name left behind after a release reads as a person's and withholds the item
 * from every other agent. Clearing was the safe direction; recording what was
 * there before the claim is what makes restoring safe.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const HOLDER = 'agent:t-prior';
const AGENT_USER = randomUUID();
/** A person, who assigned the item in Plane's UI with no lease involved. */
const DANA = randomUUID();

const STATES: State[] = [
  { id: 'todo', name: 'Todo', group: 'unstarted', default: true },
  { id: 'started', name: 'In Progress', group: 'started', default: false },
  { id: 'done', name: 'Done', group: 'completed', default: false },
];

const actor = {
  holder: HOLDER,
  principal: 'human:me@example.com',
  planeUserId: AGENT_USER,
  capabilities: [],
} as unknown as Actor;

let updates: Array<{ id: string; body: Record<string, unknown> }> = [];
/** Set per test: what Plane reports the item's assignees as before the claim. */
let assigneesBefore: string[] = [];
let readFails = false;

function fakePlane(): PlaneClient {
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    states: async () => STATES,
    stateByGroup: async (_p: string, group: string) => STATES.find((s) => s.group === group),
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      updates.push({ id, body });
      return { id } as WorkItem;
    },
    comment: async () => ({}),
    getWorkItem: async (_p: string, id: string) => {
      if (readFails) throw new Error('plane 503');
      return { id, labels: [], assignees: assigneesBefore } as unknown as WorkItem;
    },
    labels: async () => [],
    members: async () => [],
    me: async () => ({ email: 'me@example.com' }),
  }) as unknown as PlaneClient;
  return plane;
}

/** Claim an item and mirror it, so the pre-claim assignees are on the record. */
async function claimed(): Promise<string> {
  const workItemId = randomUUID();
  const lease = await claim(pool, {
    workItemId,
    projectId: PROJECT,
    holder: HOLDER,
    ttlSeconds: 600,
    sessionId: 's-1',
  });
  await mirrorClaim(fakePlane(), pool, {
    projectId: PROJECT,
    workItemId,
    actor,
    epoch: lease!.epoch,
    expiresAt: lease!.expiresAt,
  });
  return workItemId;
}

const lastWrite = (id: string) => [...updates].reverse().find((u) => u.id === id)!.body;

beforeEach(() => {
  updates = [];
  assigneesBefore = [];
  readFails = false;
});

afterAll(async () => {
  await pool.query('delete from lease where holder = $1', [HOLDER]);
  await pool.end();
});

describe('releasing an item puts it back as it was found', () => {
  it('restores a name a person put there', async () => {
    assigneesBefore = [DANA];
    const id = await claimed();
    // The claim took it, as documented — claim() sets these for you.
    expect(lastWrite(id)['assignees']).toEqual([AGENT_USER]);

    updates = [];
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      reason: 'released by agent',
      holder: HOLDER,
    });

    expect(lastWrite(id)['assignees']).toEqual([DANA]);
  });

  it('leaves an item that started unassigned unassigned', async () => {
    // The old behaviour, which was right for this case and only this case.
    assigneesBefore = [];
    const id = await claimed();

    updates = [];
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      reason: 'released by agent',
      holder: HOLDER,
    });

    expect(lastWrite(id)['assignees']).toEqual([]);
  });

  it('clears rather than guesses when it could not read what was there', async () => {
    // Null means "we do not know", and it must not collapse to "leave it alone":
    // a name we cannot account for reads as a person's intent under rule 4 and
    // would withhold the item from everyone. Losing an assignment is recoverable;
    // freezing an item for every agent is the failure worth avoiding.
    readFails = true;
    const id = await claimed();

    updates = [];
    readFails = false;
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      reason: 'released by agent',
      holder: HOLDER,
    });

    expect(lastWrite(id)['assignees']).toEqual([]);
  });

  it('does not restore a value left over from an earlier claim of the same item', async () => {
    // The lease row is reused across claims, so a recorded value that outlived
    // its claim would be written back later as if it were current.
    assigneesBefore = [DANA];
    const id = await claimed();

    // Someone removes Dana, and the item is claimed again.
    await release(pool, { workItemId: id, holder: HOLDER, epoch: 1, reason: 'done for now' });
    assigneesBefore = [];
    const lease = await claim(pool, {
      workItemId: id,
      projectId: PROJECT,
      holder: HOLDER,
      ttlSeconds: 600,
      sessionId: 's-2',
    });
    await mirrorClaim(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      actor,
      epoch: lease!.epoch,
      expiresAt: lease!.expiresAt,
    });

    updates = [];
    await mirrorReturn(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      reason: 'released by agent',
      holder: HOLDER,
    });

    expect(lastWrite(id)['assignees']).toEqual([]);
  });

  it('applies the same rule to a completion that does not close the item', async () => {
    // `complete(close: false)` leaves the item open and claimable, so it is the
    // same situation as a release and gets the same answer. A completion that
    // DOES close keeps the name instead — see assignment.test.ts.
    assigneesBefore = [DANA];
    const id = await claimed();

    updates = [];
    await mirrorComplete(fakePlane(), pool, {
      projectId: PROJECT,
      workItemId: id,
      actor,
      outcome: 'partly done',
      close: false,
    });

    expect(lastWrite(id)['assignees']).toEqual([DANA]);
  });
});
