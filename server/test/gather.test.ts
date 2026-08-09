import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/auth.js';
import { GatewayError } from '../src/errors.js';
import { gather } from '../src/gather.js';
import { PlaneClient, type WorkItem } from '../src/plane.js';

/**
 * The bottom-up inverse of `decompose`. A board goes flat because captures land
 * where they fall, and until now the only way to group items that already existed
 * was to edit each one by hand — which is exactly what the structural review asks
 * a human to do, and exactly why it goes unactioned.
 *
 * Every test here is really about one of two things: that a person is asked
 * before anything moves, and that a regrouping cannot quietly overrule a
 * placement somebody already made.
 */

const PROJECT = randomUUID();

const ids = new Map<string, string>();
const id = (key: string): string => {
  const hit = ids.get(key);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(key, made);
  return made;
};

let seq = 0;
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: id(key),
    sequence_id: ++seq,
    name: key,
    state: 'backlog',
    priority: 'none',
    labels: [],
    parent: null,
    is_draft: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
    ...(over.parent ? { parent: id(over.parent) } : {}),
  }) as WorkItem;

const actor: Actor = {
  name: 'y.pra.reddy/sync-master',
  holder: 'agent:y.pra.reddy/sync-master',
  capabilities: [],
  planeUserId: null,
  defaultProjectId: null,
  principal: 'human:y.pra.reddy@gmail.com',
  planeToken: null,
};

interface Seen {
  patched: Array<{ id: string; parent: string }>;
  created: Array<Record<string, unknown>>;
  comments: string[];
}

const fakePlane = (items: WorkItem[], seen: Seen, fail?: string): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, wid: string) => {
      const found = items.find((i) => i.id === wid);
      if (!found) throw new Error('no such item');
      return found;
    },
    states: async () => [],
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      seen.created.push(body);
      const made = wi(String(body['name']));
      items.push(made);
      return made;
    },
    updateWorkItem: async (_p: string, wid: string, body: Record<string, unknown>) => {
      if (wid === fail) throw new GatewayError('UPSTREAM', 'Plane said no');
      seen.patched.push({ id: wid, parent: String(body['parent']) });
      return items.find((i) => i.id === wid) as WorkItem;
    },
    comment: async (_p: string, _w: string, html: string) => {
      seen.comments.push(html);
      return {};
    },
  }) as PlaneClient;

const seen = (): Seen => ({ patched: [], created: [], comments: [] });

const APPROVED = 'human:y.pra.reddy@gmail.com';

describe('asking before anything moves', () => {
  it('refuses without an approval, and names what it would have done', async () => {
    const s = seen();
    const err = await gather(fakePlane([wi('c'), wi('a'), wi('b')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('a'), id('b')],
      containerId: id('c'),
    }).catch((e: unknown) => e as GatewayError);

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe('NEEDS_APPROVAL');
    // The question is composed here because this is the layer holding the items.
    expect(String((err as GatewayError).detail['question'])).toContain('a');
    expect((err as GatewayError).detail['grant']).toBe('approvedBy');
    expect((err as GatewayError).detail['moves']).toHaveLength(2);
    // Nothing written on the way to asking.
    expect(s.patched).toEqual([]);
  });

  it('creates nothing while it is still only a proposal', async () => {
    // Validation runs before the ask and the ask runs before any write, so a
    // declined proposal cannot leave an empty container behind.
    const s = seen();
    await gather(fakePlane([wi('x')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('x')],
      title: 'A group nobody agreed to',
    }).catch(() => {});
    expect(s.created).toEqual([]);
  });

  it('files them once somebody has agreed', async () => {
    const s = seen();
    const got = await gather(fakePlane([wi('c2'), wi('a2'), wi('b2')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('a2'), id('b2')],
      containerId: id('c2'),
      approvedBy: APPROVED,
    });
    expect(got.moved.map((m) => m.title)).toEqual(['a2', 'b2']);
    expect(got.complete).toBe(true);
    expect(s.patched).toEqual([
      { id: id('a2'), parent: id('c2') },
      { id: id('b2'), parent: id('c2') },
    ]);
  });

  it('writes who agreed onto the container, where anyone drilling down will meet it', async () => {
    // The parent links are visible afterwards; the fact that a person chose them
    // is not, unless it is said.
    const s = seen();
    await gather(fakePlane([wi('c3'), wi('a3')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('a3')],
      containerId: id('c3'),
      approvedBy: APPROVED,
    });
    expect(s.comments[0]).toContain(APPROVED);
    expect(s.comments[0]).toContain('a3');
  });
});

describe('not overruling a placement somebody made', () => {
  it('refuses an item that already hangs off something else', async () => {
    const s = seen();
    const err = await gather(
      fakePlane([wi('epic'), wi('spoken-for', { parent: 'epic' }), wi('newc')], s),
      actor,
      {
        projectId: PROJECT,
        workItemIds: [id('spoken-for')],
        containerId: id('newc'),
        approvedBy: APPROVED,
      },
    ).catch((e: unknown) => e as GatewayError);

    expect((err as GatewayError).code).toBe('INVALID');
    expect((err as GatewayError).detail['alreadyPlaced']).toHaveLength(1);
    expect(s.patched).toEqual([]);
  });

  it('moves it when the caller says that is what they meant', async () => {
    const s = seen();
    const got = await gather(
      fakePlane([wi('epic2'), wi('taken', { parent: 'epic2' }), wi('newc2')], s),
      actor,
      {
        projectId: PROJECT,
        workItemIds: [id('taken')],
        containerId: id('newc2'),
        reparent: true,
        approvedBy: APPROVED,
      },
    );
    // Where it came from is recorded, so an unwanted regrouping can be undone.
    expect(got.moved[0]?.from).toBe(id('epic2'));
  });

  it('is happy to re-file an item that is already in this container', async () => {
    // Not a reparent: it is already there, so nothing is being overruled.
    const s = seen();
    const got = await gather(
      fakePlane([wi('epic3'), wi('already', { parent: 'epic3' })], s),
      actor,
      {
        projectId: PROJECT,
        workItemIds: [id('already')],
        containerId: id('epic3'),
        approvedBy: APPROVED,
      },
    );
    expect(got.complete).toBe(true);
  });
});

describe('refusing what Plane would accept and then be unable to render', () => {
  it('will not file an item under itself', async () => {
    const err = await gather(fakePlane([wi('self')], seen()), actor, {
      projectId: PROJECT,
      workItemIds: [id('self')],
      containerId: id('self'),
      approvedBy: APPROVED,
    }).catch((e: unknown) => e as GatewayError);
    expect((err as GatewayError).code).toBe('INVALID');
  });

  it('will not file a parent under its own descendant', async () => {
    const s = seen();
    const err = await gather(
      fakePlane([wi('top'), wi('middle', { parent: 'top' }), wi('deep', { parent: 'middle' })], s),
      actor,
      {
        projectId: PROJECT,
        workItemIds: [id('top')],
        containerId: id('deep'),
        approvedBy: APPROVED,
      },
    ).catch((e: unknown) => e as GatewayError);
    expect((err as GatewayError).code).toBe('INVALID');
    expect(s.patched).toEqual([]);
  });
});

describe('the ordinary shape of the call', () => {
  it('makes the container when given a title instead of an id', async () => {
    const s = seen();
    const got = await gather(fakePlane([wi('l1'), wi('l2')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('l1'), id('l2')],
      title: 'Agents can find work without being told where it is',
      approvedBy: APPROVED,
    });
    expect(got.created).toBe(true);
    expect(s.created[0]?.['name']).toBe('Agents can find work without being told where it is');
    expect(got.moved).toHaveLength(2);
  });

  it('refuses a call that names both a container and a title, or neither', async () => {
    const both = gather(fakePlane([], seen()), actor, {
      projectId: PROJECT,
      workItemIds: [id('l1')],
      containerId: id('l2'),
      title: 'ambiguous',
      approvedBy: APPROVED,
    });
    await expect(both).rejects.toThrow(GatewayError);

    const neither = gather(fakePlane([], seen()), actor, {
      projectId: PROJECT,
      workItemIds: [id('l1')],
      approvedBy: APPROVED,
    });
    await expect(neither).rejects.toThrow(GatewayError);
  });

  it('refuses items that are not in this project rather than filing the rest', async () => {
    // Half a regrouping against a list the caller got wrong is worse than none:
    // they would have to work out which half.
    const err = await gather(fakePlane([wi('here'), wi('c4')], seen()), actor, {
      projectId: PROJECT,
      workItemIds: [id('here'), id('elsewhere')],
      containerId: id('c4'),
      approvedBy: APPROVED,
    }).catch((e: unknown) => e as GatewayError);
    expect((err as GatewayError).code).toBe('NOT_FOUND');
  });

  it('finishes the rest and names what Plane would not take', async () => {
    const s = seen();
    const got = await gather(
      fakePlane([wi('c5'), wi('ok1'), wi('bad'), wi('ok2')], s, id('bad')),
      actor,
      {
        projectId: PROJECT,
        workItemIds: [id('ok1'), id('bad'), id('ok2')],
        containerId: id('c5'),
        approvedBy: APPROVED,
      },
    );
    expect(got.moved.map((m) => m.title)).toEqual(['ok1', 'ok2']);
    expect(got.failed).toHaveLength(1);
    expect(got.failed[0]?.error).toContain('UPSTREAM');
    expect(got.complete).toBe(false);
  });

  it('does not move the same item twice when it is listed twice', async () => {
    const s = seen();
    const got = await gather(fakePlane([wi('c6'), wi('dup')], s), actor, {
      projectId: PROJECT,
      workItemIds: [id('dup'), id('dup')],
      containerId: id('c6'),
      approvedBy: APPROVED,
    });
    expect(got.moved).toHaveLength(1);
    expect(s.patched).toHaveLength(1);
  });
});
