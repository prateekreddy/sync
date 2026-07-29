import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { GatewayError } from '../src/errors.js';
import { claim } from '../src/lease.js';
import { checkToolCall } from '../src/toolpolicy.js';

/**
 * Proxying Plane's own MCP hands agents a much wider surface than our eight
 * tools, including `update_issue`, which can set `assignees` and `state` — the
 * two fields that *are* the lease as far as Plane's UI is concerned.
 *
 * So the wide surface has to be unable to walk around the narrow one. These tests
 * are the check on that: without them, adding Plane's tools would quietly reopen
 * the exact race the gateway exists to close.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const actor = (over: Partial<Actor> = {}): Actor => ({
  name: 'worker-1',
  holder: 'agent:worker-1',
  capabilities: [],
  planeUserId: null,
  planeToken: 'plane_api_test',
  principal: 'human:test',
  ...over,
});

beforeEach(async () => {
  await pool.query('truncate lease');
});

afterAll(async () => {
  await pool.end();
});

const call = (a: Actor, name: string, args: Record<string, unknown>) =>
  checkToolCall({ pool, actor: a }, name, args);

describe('lease-guarded fields', () => {
  it('refuses to set assignees on an item the caller does not hold', async () => {
    const issueId = randomUUID();
    await expect(
      call(actor(), 'update_issue', {
        project_id: randomUUID(),
        issue_id: issueId,
        issue_data: { assignees: [randomUUID()] },
      }),
    ).rejects.toMatchObject({ code: 'NOT_HOLDER' });
  });

  it('refuses to move state on an item the caller does not hold', async () => {
    await expect(
      call(actor(), 'update_issue', {
        project_id: randomUUID(),
        issue_id: randomUUID(),
        issue_data: { state: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'NOT_HOLDER' });
  });

  it('allows the holder to set them', async () => {
    const issueId = randomUUID();
    const a = actor();
    await claim(pool, {
      workItemId: issueId,
      projectId: randomUUID(),
      holder: a.holder,
      ttlSeconds: 60,
    });

    const args = {
      project_id: randomUUID(),
      issue_id: issueId,
      issue_data: { state: randomUUID(), assignees: [randomUUID()] },
    };
    await expect(call(a, 'update_issue', args)).resolves.toEqual(args);
  });

  it('does not block a holder whose lease lapsed from being told why', async () => {
    // Expiry, not absence: the item was theirs, so the message has to be about the
    // lease rather than a generic permission error.
    const issueId = randomUUID();
    const a = actor();
    await claim(pool, {
      workItemId: issueId,
      projectId: randomUUID(),
      holder: a.holder,
      ttlSeconds: 60,
    });
    await pool.query('update lease set expires_at = now() - interval \'1 second\'');

    const err = await call(a, 'update_issue', {
      project_id: randomUUID(),
      issue_id: issueId,
      issue_data: { assignees: [] },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).message).toMatch(/bypass the lease/);
  });

  it('leaves harmless edits alone', async () => {
    // Titles, descriptions, labels and priority are Plane's business, not ours.
    // Guarding them would make this a second, worse copy of Plane's roles.
    const args = {
      project_id: randomUUID(),
      issue_id: randomUUID(),
      issue_data: { name: 'Renamed', priority: 'high', labels: [randomUUID()] },
    };
    await expect(call(actor(), 'update_issue', args)).resolves.toEqual(args);
  });

  it('leaves creation alone — a new item has no lease to bypass', async () => {
    const args = { project_id: randomUUID(), issue_data: { name: 'New', assignees: [] } };
    await expect(call(actor(), 'create_issue', args)).resolves.toEqual(args);
  });
});

describe('destructive tools', () => {
  it('withholds state surgery from an ordinary agent', async () => {
    // Deleting a state strands every item that referenced it: the readiness gate
    // reads state *groups* to decide what is claimable.
    await expect(call(actor(), 'delete_state', { state_id: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows it for an agent explicitly granted the capability', async () => {
    const a = actor({ capabilities: ['destructive'] });
    await expect(call(a, 'delete_state', { state_id: randomUUID() })).resolves.toBeTruthy();
  });

  it('does not restrict reads', async () => {
    await expect(call(actor(), 'list_states', { project_id: randomUUID() })).resolves.toBeTruthy();
  });
});
