import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken, authenticate } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { PlaneClient } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { callTool } from '../src/tools.js';

/**
 * What `capture` was *told*, versus what reached Plane.
 *
 * `priority` and `labels` were accepted, validated, and silently discarded:
 * SYNC-54 through SYNC-59 were all captured with a priority and two labels and
 * every one of them landed `priority: none`, `labels: []`. Neither label was
 * created in the project, so they never reached `resolveLabels` at all.
 *
 * Nothing in the existing suite could see it, for two reasons worth keeping in
 * mind when reading the rest of this file:
 *
 * 1. `labels.test.ts` exercises `resolveLabels` directly, so it proves names map
 *    to uuids and says nothing about whether anyone calls it. Same shape as the
 *    label-uuid bug, where `screen()` passed a hand-built map in every test and
 *    the caller shipped an empty one.
 * 2. The `createWorkItem` double in `capture-provenance.test.ts` returns a
 *    hardcoded `priority: 'none'` and `labels: []` regardless of the body it is
 *    handed — a fake that answers the question under test with a constant.
 *
 * So these assert on the body Plane was *sent*, and drive it through the real
 * MCP entry point, the real router and the real `CaptureBody` — every layer that
 * could drop a field is in the path.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const LABEL_ALPHA = randomUUID();

interface Sent {
  created: Array<Record<string, unknown>>;
  labelsCreated: string[];
}

function recordingPlane(): { plane: PlaneClient; sent: Sent } {
  const sent: Sent = { created: [], labelsCreated: [] };
  let seq = 900;
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    search: async () => [],
    labels: async () => [{ id: LABEL_ALPHA, name: 'alpha' }],
    labelNames: async () => new Map([[LABEL_ALPHA, 'alpha']]),
    createLabel: async (_p: string, name: string) => {
      sent.labelsCreated.push(name);
      return { id: randomUUID(), name };
    },
    createWorkItem: async (_p: string, body: Record<string, unknown>) => {
      sent.created.push(body);
      // Echoes the body rather than inventing an answer: a double that returns a
      // constant here is what let the original defect through.
      return {
        id: randomUUID(),
        sequence_id: ++seq,
        name: body['name'] as string,
        state: 's',
        priority: (body['priority'] as string) ?? 'none',
        labels: (body['labels'] as string[]) ?? [],
        parent: (body['parent'] as string | undefined) ?? null,
        is_draft: false,
        assignees: [],
        created_at: '',
        updated_at: '',
      };
    },
    getWorkItem: async () => null,
    relate: async () => ({}),
    comment: async () => ({}),
    moduleOf: async () => undefined,
    addToModule: async () => ({}),
  }) as unknown as PlaneClient;
  return { plane, sent };
}

async function harness() {
  const { plane, sent } = recordingPlane();
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane,
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: null,
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.ready();

  const name = `t-cap-${randomUUID().slice(0, 8)}/worker`;
  const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
  const actor = await authenticate(pool, `Bearer ${token}`);

  const call = (args: Record<string, unknown>) =>
    callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, 'capture', args);

  return { call, sent, app };
}

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-cap-%/worker'");
  await pool.end();
});

describe('capture carries what the caller sent through to Plane', () => {
  it('applies a priority the caller named', async () => {
    const { call, sent, app } = await harness();
    const res = await call({
      projectId: PROJECT,
      title: `priority reaches plane ${randomUUID()}`,
      body: 'x',
      priority: 'urgent',
    });

    expect(res.isError).toBeFalsy();
    expect(sent.created[0]?.['priority']).toBe('urgent');
    await app.close();
  });

  it('resolves label names to ids and sends them', async () => {
    const { call, sent, app } = await harness();
    await call({
      projectId: PROJECT,
      title: `labels reach plane ${randomUUID()}`,
      body: 'x',
      labels: ['alpha'],
    });

    // The id, not the word: Plane's API takes uuids and silently ignores names,
    // which is the failure this whole file exists for.
    expect(sent.created[0]?.['labels']).toEqual([LABEL_ALPHA]);
    await app.close();
  });

  it('creates a label that does not exist yet rather than dropping it', async () => {
    const { call, sent, app } = await harness();
    await call({
      projectId: PROJECT,
      title: `new label ${randomUUID()}`,
      body: 'x',
      labels: ['brand-new'],
    });

    expect(sent.labelsCreated).toContain('brand-new');
    expect((sent.created[0]?.['labels'] as string[])?.length).toBe(1);
    await app.close();
  });

  it('carries priority, labels and parent together on one call', async () => {
    // The original report noted parentId surviving while priority and labels did
    // not, so the interesting case is all three at once rather than each alone.
    const { call, sent, app } = await harness();
    const parent = randomUUID();
    await call({
      projectId: PROJECT,
      title: `all three ${randomUUID()}`,
      body: 'x',
      priority: 'high',
      labels: ['alpha'],
      parentId: parent,
    });

    const created = sent.created[0];
    expect(created?.['priority']).toBe('high');
    expect(created?.['labels']).toEqual([LABEL_ALPHA]);
    expect(created?.['parent']).toBe(parent);
    await app.close();
  });

  it('defaults priority to none when the caller names none', async () => {
    const { call, sent, app } = await harness();
    await call({ projectId: PROJECT, title: `no priority ${randomUUID()}`, body: 'x' });
    expect(sent.created[0]?.['priority']).toBe('none');
    await app.close();
  });
});

/**
 * Where a capture lands when nobody says.
 *
 * The module was made to inherit and the parent was not, and the asymmetry hid
 * because it fails flatteringly: the module IS filled in, so the board reports
 * the item as placed while it hangs off nothing.
 *
 * The rule is SIBLING, not child. A child would make the item the agent is
 * holding unclaimable and uncompletable until the note it just wrote is done.
 */
describe('parent inheritance', () => {
  const parse = (res: { content: Array<{ text: string }> }) =>
    JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;

  async function withSource(source: { id: string; parent: string | null }) {
    const { plane, sent } = recordingPlane();
    Object.assign(plane, {
      getWorkItem: async (_p: string, id: string) =>
        id === source.id
          ? { id: source.id, sequence_id: 1, name: 'held', state: 's', priority: 'none', labels: [], parent: source.parent, is_draft: false, assignees: [], created_at: '', updated_at: '' }
          : null,
    });

    const app = Fastify();
    registerRoutes(app, {
      pool,
      plane,
      allowAgentClose: true,
      evidencePolicy: 'warn',
      planeMcp: null,
      planeBaseUrl: 'http://plane.invalid',
      workspaceSlug: 'ws',
      github: null,
      allowMinting: false,
      mintRatePerMinute: 10,
    });
    await app.ready();

    const name = `t-cap-${randomUUID().slice(0, 8)}/worker`;
    const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
    const actor = await authenticate(pool, `Bearer ${token}`);

    // A live lease is what makes the source discoverable without the caller
    // naming it — the same mechanism provenance already rides on.
    await pool.query(
      `insert into lease (work_item_id, project_id, holder, holder_chain, state, epoch, claimed_at, expires_at, heartbeat_at)
       values ($1, $2, $3, $4, 'held', 1, now(), now() + interval '10 minutes', now())
       on conflict (work_item_id) do update set state = 'held', holder = excluded.holder,
         expires_at = excluded.expires_at`,
      [source.id, PROJECT, actor.holder, [actor.holder]],
    );

    return {
      sent,
      app,
      cleanup: async () => {
        await pool.query('delete from lease where work_item_id = $1', [source.id]);
        await app.close();
      },
      call: (args: Record<string, unknown>) =>
        callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, 'capture', args),
    };
  }

  it('files the capture as a sibling of the item being held', async () => {
    const grandparent = randomUUID();
    const h = await withSource({ id: randomUUID(), parent: grandparent });

    const out = parse(
      await h.call({ projectId: PROJECT, title: `sibling ${randomUUID()}`, body: 'x' }),
    );

    // The source's PARENT, never the source itself.
    expect(h.sent.created[0]?.['parent']).toBe(grandparent);
    expect(out['parentInherited']).toBe(true);
    await h.cleanup();
  });

  it('never makes the capture a child of the item being held', async () => {
    // The failure this design exists to prevent: a child would make the held
    // item unclaimable and uncompletable until this note is done.
    const held = randomUUID();
    const h = await withSource({ id: held, parent: randomUUID() });

    await h.call({ projectId: PROJECT, title: `not a child ${randomUUID()}`, body: 'x' });

    expect(h.sent.created[0]?.['parent']).not.toBe(held);
    await h.cleanup();
  });

  it('invents nothing when the held item has no parent of its own', async () => {
    // Nothing to be a sibling of. Attaching to the held item here would convert a
    // claimable leaf into a container as a side effect of writing a note.
    const h = await withSource({ id: randomUUID(), parent: null });

    const out = parse(
      await h.call({ projectId: PROJECT, title: `rootless ${randomUUID()}`, body: 'x' }),
    );

    expect(h.sent.created[0]?.['parent']).toBeUndefined();
    expect(out['parentInherited']).toBeUndefined();
    await h.cleanup();
  });

  it('an explicit parentId still wins and is not reported as inherited', async () => {
    const chosen = randomUUID();
    const h = await withSource({ id: randomUUID(), parent: randomUUID() });

    const out = parse(
      await h.call({
        projectId: PROJECT,
        title: `explicit ${randomUUID()}`,
        body: 'x',
        parentId: chosen,
      }),
    );

    expect(h.sent.created[0]?.['parent']).toBe(chosen);
    expect(out['parentInherited']).toBeUndefined();
    await h.cleanup();
  });

  it('infers nothing when the caller holds no lease at all', async () => {
    const { call, sent, app } = await harness();
    await call({ projectId: PROJECT, title: `no lease ${randomUUID()}`, body: 'x' });
    expect(sent.created[0]?.['parent']).toBeUndefined();
    await app.close();
  });
});

/**
 * The reply has to be checkable against the request.
 *
 * Six captures in a row landed with the wrong priority and no labels because a
 * malformed client-side call truncated its own trailing arguments. Nothing in
 * the gateway was wrong, and nothing in any reply made it visible either — which
 * is what let it run six times.
 */
describe('capture reports what it applied', () => {
  const parse = (res: { content: Array<{ text: string }> }) =>
    JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;

  it('echoes the priority and labels it applied', async () => {
    const { call, app } = await harness();
    const out = parse(
      await call({
        projectId: PROJECT,
        title: `echo ${randomUUID()}`,
        body: 'x',
        priority: 'urgent',
        labels: ['alpha'],
      }),
    );

    expect(out['priority']).toBe('urgent');
    expect(out['labels']).toEqual(['alpha']);
    await app.close();
  });

  it('echoes none when no priority was asked for, rather than staying silent', async () => {
    const { call, app } = await harness();
    const out = parse(await call({ projectId: PROJECT, title: `echo none ${randomUUID()}`, body: 'x' }));
    expect(out['priority']).toBe('none');
    await app.close();
  });

  it('names what a dedup ignored instead of leaving the caller to infer it', async () => {
    // The dedup path returns somebody else's item untouched, so a priority and
    // labels the caller asked for simply did not happen. `deduped: true` says a
    // different item came back; it does not say a priority was dropped.
    const { plane, sent } = recordingPlane();
    const existing = randomUUID();
    Object.assign(plane, {
      search: async () => [
        { id: existing, name: 'already written down', sequence_id: 7, project__identifier: 'SYNC' },
      ],
    });

    const app = Fastify();
    registerRoutes(app, {
      pool,
      plane,
      allowAgentClose: true,
      evidencePolicy: 'warn',
      planeMcp: null,
      planeBaseUrl: 'http://plane.invalid',
      workspaceSlug: 'ws',
      github: null,
      allowMinting: false,
      mintRatePerMinute: 10,
    });
    await app.ready();

    const name = `t-cap-${randomUUID().slice(0, 8)}/worker`;
    const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
    const actor = await authenticate(pool, `Bearer ${token}`);

    const out = parse(
      await callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, 'capture', {
        projectId: PROJECT,
        title: 'already written down',
        body: 'x',
        priority: 'urgent',
        labels: ['alpha'],
      }),
    );

    expect(out['deduped']).toBe(true);
    expect(out['notApplied']).toEqual(['priority', 'labels']);
    // And nothing was created, so there is no applied priority to report.
    expect(sent.created).toHaveLength(0);
    await app.close();
  });

  it('says nothing was ignored when the dedup had nothing to ignore', async () => {
    const { plane } = recordingPlane();
    const existing = randomUUID();
    Object.assign(plane, {
      search: async () => [
        { id: existing, name: 'plain dupe', sequence_id: 8, project__identifier: 'SYNC' },
      ],
    });

    const app = Fastify();
    registerRoutes(app, {
      pool,
      plane,
      allowAgentClose: true,
      evidencePolicy: 'warn',
      planeMcp: null,
      planeBaseUrl: 'http://plane.invalid',
      workspaceSlug: 'ws',
      github: null,
      allowMinting: false,
      mintRatePerMinute: 10,
    });
    await app.ready();

    const name = `t-cap-${randomUUID().slice(0, 8)}/worker`;
    const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
    const actor = await authenticate(pool, `Bearer ${token}`);

    const out = parse(
      await callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, 'capture', {
        projectId: PROJECT,
        title: 'plain dupe',
        body: 'x',
      }),
    );

    expect(out['deduped']).toBe(true);
    expect(out['notApplied']).toBeUndefined();
    await app.close();
  });
});
