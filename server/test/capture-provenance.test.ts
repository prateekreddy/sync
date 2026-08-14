import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/auth.js';
import { capture } from '../src/capture.js';
import { createPool } from '../src/db.js';
import * as lease from '../src/lease.js';
import { PlaneClient } from '../src/plane.js';

/**
 * The gateway already knows what an agent is working on — that is the whole
 * content of the lease table — so asking it to repeat that in `discoveredFrom`
 * meant provenance was recorded only when someone remembered, under context
 * pressure, mid-task. Measured on the real board: 36 items, two links, both added
 * by hand on one day.
 *
 * The first version answered only when the agent held exactly one lease, which
 * was right about ambiguity and wrong about frequency: work here is mostly
 * noticed in sessions holding nothing, so the link was almost never made. It now
 * asks what this agent was *doing* — the lease rows outlive the lease — and these
 * pin both halves: that recency inside a session is used, and that a guess with
 * nothing behind it is still refused.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();

const actor: Actor = {
  name: 'prov',
  holder: 'agent:prov',
  capabilities: [],
  planeUserId: null,
  defaultProjectId: null,
  principal: 'human:t@example.com',
  planeToken: null,
};

interface Recorder {
  related: Array<{ from: string; to: string[] }>;
  comments: string[];
}

let seq = 500;

function fakePlane(): PlaneClient & { rec: Recorder } {
  const rec: Recorder = { related: [], comments: [] };
  return Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    rec,
    // No dedup hits: every capture here is a fresh item.
    search: async () => [],
    labels: async () => [],
    createWorkItem: async (_p: string, body: Record<string, unknown>) => ({
      id: randomUUID(),
      sequence_id: ++seq,
      name: body['name'] as string,
      state: 's',
      priority: 'none',
      labels: [],
      parent: (body['parent'] as string | undefined) ?? null,
      is_draft: false,
      assignees: [],
      created_at: '',
      updated_at: '',
    }),
    getWorkItem: async () => null,
    relate: async (_p: string, from: string, _t: string, to: string[]) => {
      rec.related.push({ from, to });
      return {};
    },
    comment: async (_p: string, _i: string, html: string) => {
      rec.comments.push(html);
      return {};
    },
    // Stubbed, or the real lookup dials http://plane.invalid and every test pays
    // PlaneClient's retry ladder. That is exactly the cost the deadline in
    // inheritModule exists to bound.
    moduleOf: async () => undefined,
    addToModule: async () => ({}),
  }) as PlaneClient & { rec: Recorder };
}

const hold = (workItemId: string, projectId = PROJECT) =>
  lease.claim(pool, { workItemId, projectId, holder: actor.holder, ttlSeconds: 600 });

const write = (plane: PlaneClient, over: Record<string, unknown> = {}) =>
  capture(plane, pool, actor, {
    projectId: PROJECT,
    title: `noticed something ${randomUUID()}`,
    body: 'enough for someone else to act',
    ...over,
  });

beforeEach(async () => {
  await pool.query('truncate lease');
});
afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

describe('provenance derived from the lease', () => {
  it('links a capture back to the item the agent is holding', async () => {
    const working = randomUUID();
    await hold(working);

    const plane = fakePlane();
    const out = await write(plane);

    expect(out.discoveredFrom).toBe(working);
    expect(out.discoveredFromInferred).toBe(true);
    expect(plane.rec.related).toEqual([{ from: out.workItemId, to: [working] }]);
  });

  it('says the link was inferred rather than stated', async () => {
    // A reader deciding what to trust needs to know which this was. Stated
    // provenance is a claim by an agent; inferred provenance is the gateway
    // noticing, and the two are not equally strong.
    await hold(randomUUID());
    const plane = fakePlane();
    await write(plane);
    expect(plane.rec.comments[0]).toContain('inferred from the lease');
  });

  it('lets an explicit source win, and does not call it inferred', async () => {
    const working = randomUUID();
    const stated = randomUUID();
    await hold(working);

    const plane = fakePlane();
    const out = await write(plane, { discoveredFrom: stated });

    expect(out.discoveredFrom).toBe(stated);
    expect(out.discoveredFromInferred).toBeUndefined();
    expect(plane.rec.related[0]?.to).toEqual([stated]);
    expect(plane.rec.comments[0]).not.toContain('inferred');
  });
});

describe('when the agent is not holding one tidy lease', () => {
  it('takes the most recent of several, rather than declining', async () => {
    // Declining here was the old rule, and it was right about the ambiguity and
    // wrong about the cost: an absent edge is not neutral, it is the reason the
    // board has nothing to group by. Recency is what a session actually means.
    const older = randomUUID();
    const newer = randomUUID();
    await hold(older);
    await pool.query("update lease set heartbeat_at = now() - interval '10 minutes'");
    await hold(newer);

    const plane = fakePlane();
    const out = await write(plane);

    expect(out.discoveredFrom).toBe(newer);
    expect(out.discoveredFromBasis).toBe('held');
  });

  it('remembers what it just finished, which is how most work is noticed here', async () => {
    // The case the old rule could never answer: a session that completed its item
    // and then wrote down the three things it noticed on the way.
    const done = randomUUID();
    await hold(done);
    await lease.complete(pool, { workItemId: done, epoch: 1, holder: actor.holder });

    const plane = fakePlane();
    const out = await write(plane);

    expect(out.discoveredFrom).toBe(done);
    expect(out.discoveredFromBasis).toBe('recent');
    expect(plane.rec.comments[0]).toContain('shortly after it finished');
  });

  it('prefers a live lease over something finished earlier', async () => {
    const finished = randomUUID();
    await hold(finished);
    await lease.complete(pool, { workItemId: finished, epoch: 1, holder: actor.holder });
    const current = randomUUID();
    await hold(current);

    expect((await write(fakePlane())).discoveredFrom).toBe(current);
  });

  it('does not attribute a note in this window to work happening in another one', async () => {
    // Agents authenticate as the human running them, so two windows open at once
    // share a holder. Without the session the newer lease would win and one
    // conversation's note would be filed against the other's work.
    const elsewhere = randomUUID();
    const here = randomUUID();
    await lease.claim(pool, {
      workItemId: here,
      projectId: PROJECT,
      holder: actor.holder,
      ttlSeconds: 600,
      sessionId: 'this-window',
    });
    await pool.query("update lease set heartbeat_at = now() - interval '20 minutes'");
    await lease.claim(pool, {
      workItemId: elsewhere,
      projectId: PROJECT,
      holder: actor.holder,
      ttlSeconds: 600,
      sessionId: 'other-window',
    });

    const out = await write(fakePlane(), { sessionId: 'this-window' });
    expect(out.discoveredFrom).toBe(here);
  });

  it('does not file a note under a parent belonging to another session', async () => {
    // PLANE-8, and the expensive half. The lease table keys on agent IDENTITY,
    // so two agents authenticating as agent:dev2/worker-1 are one row set. On
    // 2026-08-03 agent B claimed a flaky-test item at 07:41:27 and agent A's
    // unrelated capture a minute later became its sibling, under a container
    // neither had touched — and a parent with unfinished children is withheld by
    // design, so unrelated work made an epic unclaimable.
    const theirs = randomUUID();
    await lease.claim(pool, {
      workItemId: theirs,
      projectId: PROJECT,
      holder: actor.holder,
      ttlSeconds: 600,
      sessionId: 'their-window',
    });

    const plane = fakePlane();
    // Their item has a parent, so there is something to inherit wrongly.
    Object.assign(plane, {
      getWorkItem: async () => ({ id: theirs, parent: randomUUID() }),
    });

    const out = await write(plane, { sessionId: 'my-window' });

    expect(out.parentId).toBeUndefined();
    expect(out.parentInherited).toBeUndefined();
    // The cheap half is still offered — a wrong relates_to edge costs noise, not
    // a frozen container — but it is labelled, so a reader can discount it.
    expect(out.discoveredFrom).toBe(theirs);
    expect(out.discoveredFromBasis).toBe('other-session');
  });

  it('still inherits a parent from the session that took the lease', async () => {
    // The other direction, so the guard cannot pass by never inheriting at all.
    const mine = randomUUID();
    const container = randomUUID();
    await lease.claim(pool, {
      workItemId: mine,
      projectId: PROJECT,
      holder: actor.holder,
      ttlSeconds: 600,
      sessionId: 'my-window',
    });

    const plane = fakePlane();
    Object.assign(plane, { getWorkItem: async () => ({ id: mine, parent: container }) });

    const out = await write(plane, { sessionId: 'my-window' });

    expect(out.parentId).toBe(container);
    expect(out.parentInherited).toBe(true);
    expect(out.discoveredFromBasis).toBe('held');
  });

  it('does not reach back past the window', async () => {
    // Yesterday's work is not where today's note came from.
    const stale = randomUUID();
    await hold(stale);
    await pool.query(
      "update lease set state = 'completed', ended_at = now() - interval '9 hours', heartbeat_at = now() - interval '9 hours'",
    );
    expect((await write(fakePlane())).discoveredFrom).toBeUndefined();
  });

  it('does not hang a note off work somebody took back', async () => {
    // A revoked lease is a person saying that was not this agent's work.
    // Attaching fresh notes to it argues with them.
    const taken = randomUUID();
    await hold(taken);
    await pool.query("update lease set state = 'revoked', ended_at = now()");
    expect((await write(fakePlane())).discoveredFrom).toBeUndefined();
  });
});

describe('when it refuses to guess', () => {
  it('infers nothing when the agent has done nothing here', async () => {
    // Capture is deliberately callable with no lease at all, and a cold start
    // has nothing behind a guess.
    const plane = fakePlane();
    const out = await write(plane);
    expect(out.discoveredFrom).toBeUndefined();
    expect(plane.rec.related).toEqual([]);
  });

  it('ignores a lease held in a different project', async () => {
    await hold(randomUUID(), OTHER_PROJECT);
    const plane = fakePlane();
    const out = await write(plane);
    expect(out.discoveredFrom).toBeUndefined();
  });

  it('adds no provenance edge when a parent was given', async () => {
    // A parent already places the item, and says something stronger. A
    // relates_to edge to the same work would be noise on both.
    await hold(randomUUID());
    const plane = fakePlane();
    const out = await write(plane, { parentId: randomUUID() });

    expect(out.discoveredFrom).toBeUndefined();
    expect(plane.rec.related).toEqual([]);
  });

  it('still uses a lease that lapsed a minute ago, but does not call it live', async () => {
    // A lapsed lease means the agent stopped heartbeating, not that it stopped
    // working — and it certainly does not mean the work never happened. The edge
    // is worth making; calling it `held` would not be true.
    const working = randomUUID();
    await hold(working);
    await pool.query("update lease set expires_at = now() - interval '1 minute'");

    const out = await write(fakePlane());
    expect(out.discoveredFrom).toBe(working);
    expect(out.discoveredFromBasis).toBe('recent');
  });

  it('never turns any of this into a parent', async () => {
    // The line the whole design rests on. Provenance costs nothing if it is
    // wrong; a wrong parent hides work under a heading nobody drilling down will
    // look at, which is worse than leaving it visible at the top level.
    const done = randomUUID();
    await hold(done);
    await lease.complete(pool, { workItemId: done, epoch: 1, holder: actor.holder });

    const out = await write(fakePlane());
    expect(out.discoveredFrom).toBe(done);
    expect(out.parentId).toBeUndefined();
  });
});

describe('idempotency is unaffected by inference', () => {
  it('replays the original answer even from a different lease', async () => {
    // The fingerprint is taken from what the caller sent, before inference. Two
    // identical calls made while holding different items are the same request,
    // and letting the lease into the hash would defeat the key.
    const key = `prov-${randomUUID()}`;
    const title = `same thing ${randomUUID()}`;

    await hold(randomUUID());
    const first = await write(fakePlane(), { title, idempotencyKey: key });

    await pool.query('truncate lease');
    await hold(randomUUID());
    const second = await write(fakePlane(), { title, idempotencyKey: key });

    expect(second.replayed).toBe(true);
    expect(second.workItemId).toBe(first.workItemId);
    await pool.query('delete from idempotency where key = $1', [key]);
  });
});

/**
 * 25 of 35 items sat in no module, so the rollup described under a third of the
 * work. The original argument — a rollup that quietly includes things is worse
 * than one that visibly misses them — lost to the measurement: "visibly misses"
 * meant "misses almost everything".
 *
 * Plane has no way to ask an item which module it is in (verified: no module
 * field on the payload, `?expand=modules` ignored), so this costs a request per
 * module on a cold cache and must never fail a capture.
 */
describe('module inheritance', () => {
  const MODULE = randomUUID();

  const planeWithModules = (opts: { members?: string[]; modulesFail?: boolean } = {}) => {
    const added: Array<{ moduleId: string; issues: string[] }> = [];
    const base = fakePlane();
    return Object.assign(base, {
      added,
      moduleOf: async (_p: string, itemId: string) => {
        if (opts.modulesFail) throw new Error('modules disabled');
        return (opts.members ?? []).includes(itemId) ? MODULE : undefined;
      },
      addToModule: async (_p: string, moduleId: string, issues: string[]) => {
        added.push({ moduleId, issues });
        return {};
      },
    });
  };

  it('takes the module of the item being held', async () => {
    const working = randomUUID();
    await hold(working);
    const plane = planeWithModules({ members: [working] });

    const out = await write(plane);
    expect(out.moduleId).toBe(MODULE);
    expect(out.moduleInherited).toBe(true);
    expect(plane.added[0]?.moduleId).toBe(MODULE);
  });

  it('prefers the parent over the held item', async () => {
    // A sub-item belongs to its feature more definitely than a note belongs to
    // whatever its author happened to be holding.
    const working = randomUUID();
    const parent = randomUUID();
    await hold(working);
    const plane = planeWithModules({ members: [parent] });

    const out = await write(plane, { parentId: parent });
    expect(out.moduleId).toBe(MODULE);
    expect(out.moduleInherited).toBe(true);
  });

  it('does not call an explicit module inherited', async () => {
    const explicit = randomUUID();
    await hold(randomUUID());
    const plane = planeWithModules({ members: [] });

    const out = await write(plane, { moduleId: explicit });
    expect(out.moduleId).toBe(explicit);
    expect(out.moduleInherited).toBeUndefined();
  });

  it('files nothing when the source is in no module', async () => {
    await hold(randomUUID());
    const plane = planeWithModules({ members: [] });

    const out = await write(plane);
    expect(out.moduleId).toBeUndefined();
    expect(plane.added).toEqual([]);
  });

  it('still captures when modules are disabled on the project', async () => {
    // The write-first primitive outranks the convenience. A capture that failed
    // because modules were off would be the worst possible trade.
    await hold(randomUUID());
    const plane = planeWithModules({ members: [], modulesFail: true });

    const out = await write(plane);
    expect(out.workItemId).toBeTruthy();
    expect(out.moduleId).toBeUndefined();
    expect(out.moduleError).toBeUndefined();
  });

  it('asks nothing of Plane when there is no parent and no lease', async () => {
    let asked = 0;
    const plane = Object.assign(fakePlane(), {
      moduleOf: async () => {
        asked++;
        return undefined;
      },
    });
    await write(plane);
    expect(asked).toBe(0);
  });
});
