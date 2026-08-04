import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { constrain, CRITERIA_HEADING } from '../src/constrain.js';
import { createPool } from '../src/db.js';
import { PlaneClient } from '../src/plane.js';
import type { WorkItem } from '../src/plane.js';
import * as lease from '../src/lease.js';
import type { Actor } from '../src/auth.js';

/**
 * SYNC-57: "I treated 'I discovered something' as 'there is a new task.' It
 * usually isn't."
 *
 * `capture` offers one shape, so a requirement on existing work gets filed as a
 * sibling of the thing it constrains. The constraint then lives NEXT TO the work
 * rather than IN it, and whoever claims the work never sees it — which is how two
 * orphans appeared on one board in a day.
 *
 * The assertions below are about *where the requirement ends up*, because that is
 * the whole difference between this and `capture`. An implementation that created
 * a beautifully-related new item would pass a laxer test and reproduce the bug.
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

const ACTOR: Actor = {
  holder: 'agent:tester',
  holderChain: ['human:t@example.com', 'agent:tester'],
  capabilities: [],
  planeToken: null,
} as unknown as Actor;

beforeEach(async () => {
  await pool.query('truncate lease');
});
afterAll(async () => {
  await pool.query('truncate lease');
  await pool.end();
});

let seq = 0;
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: id(key),
  sequence_id: ++seq,
  project: PROJECT,
  name: key,
  description_html: '<p>the original spec</p>',
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

interface Sent {
  updates: Array<{ id: string; html: string }>;
  created: Array<Record<string, unknown>>;
  related: Array<{ from: string; relation: string; targets: string[] }>;
  comments: Array<{ id: string; html: string }>;
}

function fake(items: WorkItem[]): { plane: PlaneClient; sent: Sent } {
  const sent: Sent = { updates: [], created: [], related: [], comments: [] };
  const store = new Map(items.map((i) => [i.id, { ...i }]));
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    search: async () => [],
    labels: async () => [],
    labelNames: async () => new Map(),
    getWorkItem: async (_p: string, i: string) => store.get(i) ?? null,
    updateWorkItem: async (_p: string, i: string, body: Record<string, unknown>) => {
      const html = body['description_html'] as string;
      sent.updates.push({ id: i, html });
      // Writes back, so a second append sees the first — the read-modify-write is
      // the risky part and a store that forgot would hide it.
      const cur = store.get(i)!;
      store.set(i, { ...cur, description_html: html });
      return cur;
    },
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      sent.created.push(body);
      return { ...wi(body['name'] as string), name: body['name'] as string };
    },
    relate: async (_p: string, from: string, relation: string, targets: string[]) => {
      sent.related.push({ from, relation, targets });
      return {};
    },
    comment: async (_p: string, i: string, html: string) => {
      sent.comments.push({ id: i, html });
      return {};
    },
    moduleOf: async () => undefined,
    addToModule: async () => ({}),
  }) as unknown as PlaneClient;
  return { plane, sent };
}

const REQ = 'reject a DVN address copied from the other chain, using 0xdead as the input';

describe('the requirement goes into the work, not beside it', () => {
  it('appends an acceptance criterion to every named item', async () => {
    const { plane, sent } = fake([wi('impl-a'), wi('impl-b')]);
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a'), id('impl-b')],
      requirement: REQ,
    });

    expect(got.complete).toBe(true);
    expect(sent.updates.length).toBe(2);
    for (const u of sent.updates) {
      expect(u.html).toContain(CRITERIA_HEADING);
      expect(u.html).toContain('0xdead');
      // The original spec survives — this appends, it does not replace.
      expect(u.html).toContain('the original spec');
    }
  });

  it('creates no new item when no proof was asked for', async () => {
    // The failure being fixed is "everything becomes a new task". A constrain
    // that quietly filed one anyway would be capture with extra steps.
    const { plane, sent } = fake([wi('impl-a')]);
    await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
    });
    expect(sent.created).toEqual([]);
  });

  it('extends the existing criteria list rather than starting a second heading', async () => {
    const { plane, sent } = fake([wi('impl-a')]);
    const call = (requirement: string) =>
      constrain(plane, pool, ACTOR, {
        projectId: PROJECT,
        workItemIds: [id('impl-a')],
        requirement,
      });

    await call(REQ);
    await call('also reject the zero address');

    const last = sent.updates.at(-1)!.html;
    // One heading, both criteria. Two headings would split one item's criteria
    // into two places, which is the same "next to, not in" failure one level down.
    expect(last.match(new RegExp(CRITERIA_HEADING, 'g'))?.length).toBe(1);
    expect(last).toContain('0xdead');
    expect(last).toContain('zero address');
  });

  it('does not write the same requirement twice', async () => {
    const { plane, sent } = fake([wi('impl-a')]);
    const args = { projectId: PROJECT, workItemIds: [id('impl-a')], requirement: REQ };
    await constrain(plane, pool, ACTOR, args);
    await constrain(plane, pool, ACTOR, args);
    expect(sent.updates.length).toBe(1);
  });

  it('escapes the requirement, which is prose someone typed', async () => {
    const { plane, sent } = fake([wi('impl-a')]);
    await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: 'reject <script>alert(1)</script> as input',
    });
    expect(sent.updates[0]?.html).not.toContain('<script>');
    expect(sent.updates[0]?.html).toContain('&lt;script&gt;');
  });

  it('reports an item it could not update instead of failing the rest', async () => {
    const { plane, sent } = fake([wi('impl-a')]);
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a'), id('does-not-exist')],
      requirement: REQ,
    });
    expect(got.constrained.map((c) => c.title)).toEqual(['impl-a']);
    expect(got.failed.length).toBe(1);
    expect(got.complete).toBe(false);
    expect(sent.updates.length).toBe(1);
  });
});

describe('the proof, when the residue is real work', () => {
  const proof = { title: 'Prove config tooling rejects a cross-chain DVN copy', body: 'x' };

  it('opens it blocked by everything it verifies', async () => {
    // A proof claimable before the work exists gets picked up and passes against
    // nothing, which is worse than not having written it.
    const { plane, sent } = fake([wi('impl-a'), wi('impl-b')]);
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a'), id('impl-b')],
      requirement: REQ,
      proof,
    });

    expect(got.proof).toBeDefined();
    expect(sent.related.length).toBe(1);
    expect(sent.related[0]?.relation).toBe('blocked_by');
    expect(sent.related[0]?.targets.sort()).toEqual([id('impl-a'), id('impl-b')].sort());
  });

  it('still writes the criteria — the proof is additional, not instead', async () => {
    const { plane, sent } = fake([wi('impl-a')]);
    await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
      proof,
    });
    expect(sent.updates.length).toBe(1);
    expect(sent.updates[0]?.html).toContain('0xdead');
  });

  it('does not block the proof on an item it failed to constrain', async () => {
    // Gating the proof on work nobody was asked to do would strand it.
    const { plane, sent } = fake([wi('impl-a')]);
    await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a'), id('missing')],
      requirement: REQ,
      proof,
    });
    expect(sent.related[0]?.targets).toEqual([id('impl-a')]);
  });

  it('reports a proof left unblocked rather than returning success', async () => {
    const { plane } = fake([wi('impl-a')]);
    Object.assign(plane, {
      relate: async () => {
        throw new Error('plane said no');
      },
    });
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
      proof,
    });
    expect(got.proofUnblocked).toEqual([id('impl-a')]);
    expect(got.complete).toBe(false);
  });
});

describe('an item someone is holding', () => {
  it('tells the holder, who already has the old description in context', async () => {
    // This is the case that matters most and is easiest to miss: the claimer was
    // handed the description at claim time and will not re-read it. A comment is
    // the only thing Plane surfaces to them mid-run.
    await lease.claim(pool, {
      workItemId: id('impl-a'),
      projectId: PROJECT,
      holder: 'agent:someone-else',
      ttlSeconds: 600,
    });
    const { plane, sent } = fake([wi('impl-a')]);
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
    });

    expect(got.constrained[0]?.heldBy).toBe('agent:someone-else');
    expect(sent.comments.length).toBe(1);
    expect(sent.comments[0]?.html).toContain('0xdead');
    expect(sent.comments[0]?.html).toContain('while you hold this item');
  });

  it('stays quiet when the holder is the caller', async () => {
    // Telling yourself something you just did is noise on the item's timeline.
    await lease.claim(pool, {
      workItemId: id('impl-a'),
      projectId: PROJECT,
      holder: ACTOR.holder,
      ttlSeconds: 600,
    });
    const { plane, sent } = fake([wi('impl-a')]);
    const got = await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
    });
    expect(got.constrained[0]?.heldBy).toBeUndefined();
    expect(sent.comments).toEqual([]);
  });

  it('does not treat a lapsed lease as a holder', async () => {
    await lease.claim(pool, {
      workItemId: id('impl-a'),
      projectId: PROJECT,
      holder: 'agent:gone',
      ttlSeconds: 30,
    });
    await pool.query("update lease set expires_at = now() - interval '1 second'");
    const { plane, sent } = fake([wi('impl-a')]);
    await constrain(plane, pool, ACTOR, {
      projectId: PROJECT,
      workItemIds: [id('impl-a')],
      requirement: REQ,
    });
    expect(sent.comments).toEqual([]);
  });
});
