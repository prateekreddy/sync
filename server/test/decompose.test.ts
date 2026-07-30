import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decompose } from '../src/decompose.js';
import { PlaneClient } from '../src/plane.js';
import type { WorkItem } from '../src/plane.js';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import type { Actor } from '../src/auth.js';

/**
 * A parent stops being claimable the moment its FIRST child appears. Building a
 * decomposition one `capture` at a time therefore publishes a tree that looks
 * finished while it is still half written, and another agent can start work under
 * a plan that is not all there. Doing it in one call shrinks that window from
 * however long an agent takes between tool calls to a few hundred milliseconds.
 *
 * It is explicitly not a transaction — Plane has no multi-item write — so the
 * tests below pin the honest-failure behaviour, which is the part that makes it
 * safe to rely on.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

afterAll(async () => {
  await pool.query("delete from idempotency where key like 'dt-%'");
  await pool.end();
});

const PROJECT = randomUUID();
const PARENT = randomUUID();

const actor: Actor = {
  name: 'tester',
  holder: 'agent:tester',
  capabilities: [],
  planeUserId: null,
  defaultProjectId: null,
  principal: 'human:t@example.com',
  planeToken: null,
};

let seq = 100;
const made: Array<Record<string, unknown>> = [];

/**
 * A PlaneClient whose writes are recorded. `failOn` makes one title blow up the
 * way Plane would — a validation error on a single child, not a transport fault.
 */
const moduled: string[] = [];

const fakePlane = (
  opts: { failOn?: string; missingParent?: boolean; moduleMissing?: boolean } = {},
): PlaneClient =>
  Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    getWorkItem: async (_p: string, id: string) => {
      if (opts.missingParent) throw new GatewayError('NOT_FOUND', 'nope');
      return { id, sequence_id: 1, name: 'parent', parent: null } as unknown as WorkItem;
    },
    search: async () => [],
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      if (opts.failOn && body['name'] === opts.failOn) {
        throw new GatewayError('INVALID', 'Plane 400: something is wrong with this one');
      }
      const item = { id: randomUUID(), sequence_id: ++seq, ...body };
      made.push(item);
      return item as unknown as WorkItem;
    },
    labels: async () => [],
    comment: async () => ({}),
    relate: async () => ({}),
    addToModule: async (_p: string, m: string, issues: string[]) => {
      if (opts.moduleMissing) throw new GatewayError('NOT_FOUND', 'no such module');
      moduled.push(...issues.map((i) => `${m}:${i}`));
      return {};
    },
  });

const kids = (...titles: string[]) =>
  titles.map((title) => ({ title, body: `spec for ${title}` }));

describe('decompose', () => {
  it('creates every child under the parent in one call', async () => {
    const got = await decompose(fakePlane(), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children: kids('alpha', 'beta', 'gamma'),
    });
    expect(got.created.map((c) => c.title)).toEqual(['alpha', 'beta', 'gamma']);
    expect(got.complete).toBe(true);
    expect(got.failed).toEqual([]);
  });

  it('parents every child, or the tree it reports is not the tree it built', async () => {
    made.length = 0;
    await decompose(fakePlane(), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children: kids('a', 'b'),
    });
    expect(made.every((m) => m['parent'] === PARENT)).toBe(true);
  });

  it('keeps going after one child fails, and names the one that did', async () => {
    // Aborting would leave the tree half built *and* hide which children landed,
    // which is strictly worse than finishing and saying what did not.
    const got = await decompose(fakePlane({ failOn: 'bad' }), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children: kids('good-one', 'bad', 'good-two'),
    });
    expect(got.created.map((c) => c.title)).toEqual(['good-one', 'good-two']);
    expect(got.failed).toEqual([
      { title: 'bad', error: 'INVALID: Plane 400: something is wrong with this one' },
    ]);
    expect(got.complete).toBe(false);
  });

  it('refuses a parent that does not exist, rather than orphaning every child', async () => {
    // Plane would accept each child with a dangling parent, leaving items nobody
    // is looking for and a decomposition that silently went nowhere.
    await expect(
      decompose(fakePlane({ missingParent: true }), pool, actor, {
        projectId: PROJECT,
        parentId: randomUUID(),
        children: kids('a'),
      }),
    ).rejects.toThrow(GatewayError);
  });

  it('puts every child in the module, so a rollup is not silently short', async () => {
    moduled.length = 0;
    const moduleId = randomUUID();
    const got = await decompose(fakePlane(), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children: kids('m1', 'm2'),
      moduleId,
    });
    expect(got.created.every((c) => c.moduleId === moduleId)).toBe(true);
    expect(moduled.filter((m) => m.startsWith(moduleId)).length).toBe(2);
  });

  it('still creates the children when the module does not exist', async () => {
    // The item existing matters more than the edge. Failing the capture would
    // report a lost intention that was not lost.
    const got = await decompose(fakePlane({ moduleMissing: true }), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children: kids('m3'),
      moduleId: randomUUID(),
    });
    expect(got.complete).toBe(true);
    expect(got.created[0]?.moduleId).toBeUndefined();
    expect(got.created[0]?.moduleError).toContain('not in a module');
  });

  it('replays on the same idempotency keys instead of duplicating', async () => {
    const children = [
      { title: 'retry-me', body: 'spec', idempotencyKey: `dt-${randomUUID()}` },
      { title: 'retry-me-too', body: 'spec', idempotencyKey: `dt-${randomUUID()}` },
    ];
    const first = await decompose(fakePlane(), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children,
    });
    const second = await decompose(fakePlane(), pool, actor, {
      projectId: PROJECT,
      parentId: PARENT,
      children,
    });
    expect(second.created.map((c) => c.workItemId)).toEqual(
      first.created.map((c) => c.workItemId),
    );
    expect(second.created.every((c) => c.replayed)).toBe(true);
  });
});
