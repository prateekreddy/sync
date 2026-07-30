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
 * What these pin is mostly the *refusals*. An inferred edge that is wrong is
 * worse than none, because a human reading the graph cannot tell a guess from a
 * fact — so every case where the answer is ambiguous must produce no edge at all.
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

describe('when it refuses to guess', () => {
  it('infers nothing while the agent holds two items in the project', async () => {
    // Nothing distinguishes which one was being looked at, and a confidently
    // wrong edge is worse than an absent one.
    await hold(randomUUID());
    await hold(randomUUID());

    const plane = fakePlane();
    const out = await write(plane);

    expect(out.discoveredFrom).toBeUndefined();
    expect(plane.rec.related).toEqual([]);
  });

  it('infers nothing when the agent holds nothing', async () => {
    // Capture is deliberately callable with no lease at all.
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

  it('ignores a lapsed lease', async () => {
    const working = randomUUID();
    await hold(working);
    await pool.query("update lease set expires_at = now() - interval '1 minute'");

    const plane = fakePlane();
    expect((await write(plane)).discoveredFrom).toBeUndefined();
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
