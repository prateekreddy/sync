import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken, authenticate } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { PlaneClient } from '../src/plane.js';
import type { Relations } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { callTool } from '../src/tools.js';
import { relationsWith } from './relations.js';

/**
 * SYNC-66, second half: `link` reported success for a call that changed nothing
 * anyone wanted changed.
 *
 * Plane stores relations as (issue, related_issue, relation_type) rows and
 * bulk-creates them with `ignore_conflicts`, so re-linking a pair with a
 * *different* type adds a row and leaves the first in force. An agent correcting
 * a wrong `blocked_by` by re-linking the pair as `relates_to` got `{ok: true}`
 * and a still-blocked item — the reply gave every impression the relation had
 * been updated.
 *
 * `ok: true` meant "the POST did not throw". These drive the real router and the
 * real MCP entry point, and assert on what the reply actually tells the caller,
 * because the gap was between what Plane did and what the caller was told.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const ITEM = randomUUID();
const BLOCKER = randomUUID();
const FRESH = randomUUID();

interface Sent {
  related: Array<{ relation: string; targets: string[] }>;
  comments: string[];
}

function recordingPlane(existing: Partial<Relations>): { plane: PlaneClient; sent: Sent } {
  const sent: Sent = { related: [], comments: [] };
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    relations: async () => relationsWith(existing),
    relate: async (_p: string, _i: string, relation: string, targets: string[]) => {
      sent.related.push({ relation, targets });
      return {};
    },
    comment: async (_p: string, _i: string, html: string) => {
      sent.comments.push(html);
      return {};
    },
  }) as unknown as PlaneClient;
  return { plane, sent };
}

async function harness(existing: Partial<Relations> = {}) {
  const { plane, sent } = recordingPlane(existing);
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

  const name = `t-link-${randomUUID().slice(0, 8)}/worker`;
  const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
  const actor = await authenticate(pool, `Bearer ${token}`);

  const call = (tool: string, args: Record<string, unknown>) =>
    callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, tool, args);

  const payload = (res: { content?: Array<{ text?: string }> }) =>
    JSON.parse(res.content?.[0]?.text ?? '{}');

  return { call, payload, sent, app };
}

// Retractions are rows, and these tests share one item id. Without this, a test
// that asserts on what is retracted would be reading its predecessors' work.
beforeEach(async () => {
  await pool.query('delete from relation_retraction where project_id = $1', [PROJECT]);
});

afterAll(async () => {
  await pool.query("delete from agent_token where name like 't-link-%/worker'");
  await pool.query('delete from relation_retraction where project_id = $1', [PROJECT]);
  await pool.end();
});

const BLOCKED_BY = { blocked_by: [{ project_id: PROJECT, issue_id: BLOCKER }] };

describe('link says what actually happened', () => {
  it('reports a genuinely new relation as created', async () => {
    const { call, payload, app } = await harness();
    const res = payload(
      await call('link', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [FRESH],
      }),
    );
    expect(res.created).toEqual([FRESH]);
    expect(res.conflicts).toBeUndefined();
    await app.close();
  });

  it('names a pair that already has a DIFFERENT relation as a conflict', async () => {
    // The reported case exactly: re-link a blocked_by pair as relates_to.
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('link', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [BLOCKER],
      }),
    );

    expect(res.created).toEqual([]);
    expect(res.conflicts).toEqual([{ target: BLOCKER, existing: 'blocked_by' }]);
    // And it must say what that means, not merely that a conflict exists: the
    // old edge is still gating and re-linking did not remove it.
    expect(res.warning).toContain('still in force');
    expect(res.warning).toContain('unlink');
    await app.close();
  });

  it('distinguishes "already linked that way" from a conflict', async () => {
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('link', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'blocked_by',
        targets: [BLOCKER],
      }),
    );
    expect(res.alreadyLinked).toEqual([BLOCKER]);
    expect(res.conflicts).toBeUndefined();
    await app.close();
  });

  it('separates new targets from conflicting ones in the same call', async () => {
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('link', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [BLOCKER, FRESH],
      }),
    );
    expect(res.created).toEqual([FRESH]);
    expect(res.conflicts).toEqual([{ target: BLOCKER, existing: 'blocked_by' }]);
    await app.close();
  });

  it('still creates the relation — this reports, it does not refuse', async () => {
    // Refusing would be a second judgement call in a tool whose job is to record
    // what someone decided. Saying so is enough.
    const { call, sent, app } = await harness(BLOCKED_BY);
    await call('link', {
      projectId: PROJECT,
      workItemId: ITEM,
      relation: 'relates_to',
      targets: [BLOCKER],
    });
    expect(sent.related).toEqual([{ relation: 'relates_to', targets: [BLOCKER] }]);
    await app.close();
  });

  it('admits when it could not read the existing relations', async () => {
    // Otherwise a degraded answer is indistinguishable from a clean create —
    // the same failure shape as the gate this all came from.
    const { plane } = recordingPlane({});
    Object.assign(plane, {
      relations: async () => {
        throw new Error('unreachable');
      },
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
    const name = `t-link-${randomUUID().slice(0, 8)}/worker`;
    const { token } = await issueToken(pool, { name, principal: 'human:t@example.com' });
    const actor = await authenticate(pool, `Bearer ${token}`);
    const res = await callTool({ app, pool, plane: null }, actor, `Bearer ${token}`, 'link', {
      projectId: PROJECT,
      workItemId: ITEM,
      relation: 'relates_to',
      targets: [FRESH],
    });
    const body = JSON.parse(res.content?.[0]?.text ?? '{}');
    expect(body.warning).toContain('cannot say which targets were already linked');
    await app.close();
  });
});

describe('unlink is honest about what it cannot do', () => {
  it('retracts the edge and reports it was really there', async () => {
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        targets: [BLOCKER],
        reason: 'scope changed; the dependency is not real',
      }),
    );
    expect(res.results).toEqual([
      { target: BLOCKER, retracted: true, presentInPlane: true },
    ]);
    await app.close();
  });

  it('writes the decision into Plane, because Plane still draws the edge', async () => {
    // The divergence is the price of Plane having no delete. An invisible
    // divergence would be its own silent failure, so a human reading the item in
    // Plane has to be able to see why an edge shown there is not enforced.
    const { call, sent, app } = await harness(BLOCKED_BY);
    await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      targets: [BLOCKER],
      reason: 'scope changed',
    });
    expect(sent.comments.length).toBe(1);
    expect(sent.comments[0]).toContain('scope changed');
    expect(sent.comments[0]).toContain('cannot delete a relation');
    await app.close();
  });

  it('requires a reason, and will not take an empty one', async () => {
    const { call, app } = await harness(BLOCKED_BY);
    const res = await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      targets: [BLOCKER],
      reason: '',
    });
    expect(res.isError).toBeTruthy();
    await app.close();
  });

  /**
   * PLANE-15: `unlink` took no relation, so it could only ever retract a
   * `blocked_by`. An agent that wrote a wrong `relates_to` had no way to take it
   * back — not symmetric with `link`, which writes all four kinds.
   */
  it('undoes a relates_to, with the arguments that created it', async () => {
    const { call, payload, app } = await harness({
      relates_to: [{ project_id: PROJECT, issue_id: FRESH }],
    });
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [FRESH],
        reason: 'linked the wrong item',
      }),
    );
    expect(res.results).toEqual([{ target: FRESH, retracted: true, presentInPlane: true }]);
    await app.close();
  });

  it('checks the relation actually named, not always blocked_by', async () => {
    // The only signal a caller who named the wrong kind gets back. Reading
    // blocked_by here would report an edge as present on the strength of a
    // different relation entirely.
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [BLOCKER],
        reason: 'there is no relates_to here, only a blocked_by',
      }),
    );
    // The retraction is still recorded — this reports, it does not refuse — but
    // it says plainly that Plane had no such edge.
    expect(res.results).toEqual([{ target: BLOCKER, retracted: true, presentInPlane: false }]);
    await app.close();
  });

  it('retracts per kind, so undoing a relates_to leaves a blocked_by gating', async () => {
    // Both kinds on the same pair. Retracting one must not quietly ungate the
    // other — that would turn a tidy-up into an unnoticed release of real work.
    const { call, app } = await harness({
      blocked_by: [{ project_id: PROJECT, issue_id: BLOCKER }],
      relates_to: [{ project_id: PROJECT, issue_id: BLOCKER }],
    });
    await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      relation: 'relates_to',
      targets: [BLOCKER],
      reason: 'the relates_to was noise',
    });
    const { rows } = await pool.query<{ relation: string }>(
      'select relation from relation_retraction where work_item_id = $1 and active',
      [ITEM],
    );
    expect(rows.map((r) => r.relation)).toEqual(['relates_to']);
    await app.close();
  });

  it('names the relation in the comment Plane keeps', async () => {
    const { call, sent, app } = await harness({
      duplicate: [{ project_id: PROJECT, issue_id: FRESH }],
    });
    await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      relation: 'duplicate',
      targets: [FRESH],
      reason: 'not a duplicate after all',
    });
    expect(sent.comments[0]).toContain('duplicate');
    // And it says what changed for a human, which differs by kind: only
    // blocked_by gates, so only blocked_by frees work.
    expect(sent.comments[0]).not.toContain('readiness gate');
    await app.close();
  });

  it('still defaults to blocked_by, so callers that never passed one are unchanged', async () => {
    const { call, payload, app } = await harness(BLOCKED_BY);
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        targets: [BLOCKER],
        reason: 'scope changed',
      }),
    );
    expect(res.results).toEqual([{ target: BLOCKER, retracted: true, presentInPlane: true }]);
    await app.close();
  });

  it('reinstates the kind it is given, not the default', async () => {
    const { call, payload, app } = await harness({
      relates_to: [{ project_id: PROJECT, issue_id: FRESH }],
    });
    await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      relation: 'relates_to',
      targets: [FRESH],
      reason: 'linked the wrong item',
    });
    // Without the relation, this would look for a blocked_by row and find none —
    // reporting nothing to reinstate while the relates_to stayed retracted.
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        relation: 'relates_to',
        targets: [FRESH],
        reason: 'it was the right item',
        reinstate: true,
      }),
    );
    expect(res.results).toEqual([{ target: FRESH, reinstated: true }]);
    await app.close();
  });

  it('reinstates without commenting — nothing diverged to explain', async () => {
    const { call, payload, sent, app } = await harness(BLOCKED_BY);
    await call('unlink', {
      projectId: PROJECT,
      workItemId: ITEM,
      targets: [BLOCKER],
      reason: 'scope changed',
    });
    const res = payload(
      await call('unlink', {
        projectId: PROJECT,
        workItemId: ITEM,
        targets: [BLOCKER],
        reason: 'it was real after all',
        reinstate: true,
      }),
    );
    expect(res.results).toEqual([{ target: BLOCKER, reinstated: true }]);
    expect(sent.comments.length).toBe(1); // only the retraction commented
    await app.close();
  });
});
