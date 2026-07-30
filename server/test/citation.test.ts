import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { citationsFor, recordCitations } from '../src/citation.js';
import { createPool } from '../src/db.js';
import type { Check } from '../src/ghcheck.js';

const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

beforeEach(async () => {
  await pool.query('truncate citation');
});
afterAll(async () => {
  await pool.query('truncate citation');
  await pool.end();
});

const check = (over: Partial<Check> = {}): Check => ({
  kind: 'commit',
  value: '3f7a891',
  status: 'landed',
  detail: 'on the default branch',
  ...over,
});

describe('the record of what a completion pointed at', () => {
  it('keeps the verdict, not just the citation', async () => {
    // The point of storing this at all: "what did the agent claim, and did it
    // exist?" has to survive the call that produced it.
    const item = randomUUID();
    await recordCitations(pool, {
      workItemId: item,
      projectId: randomUUID(),
      actor: 'agent:w1',
      checks: [check(), check({ value: 'https://github.com/a/b/pull/9', kind: 'url', status: 'absent', detail: 'does not exist' })],
    });

    const rows = await citationsFor(pool, item);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['absent', 'landed']);
    expect(rows[0]?.actor).toBe('agent:w1');
    expect(rows[0]?.checkedAt).toMatch(/^\d{4}-/);
  });

  it('writes every citation in one statement', async () => {
    // An agent's `complete` should not wait on a round trip per citation.
    const item = randomUUID();
    const many = Array.from({ length: 8 }, (_, i) => check({ value: `sha${i}` }));
    await recordCitations(pool, { workItemId: item, actor: 'a', checks: many });
    expect(await citationsFor(pool, item)).toHaveLength(8);
  });

  it('does nothing at all when a completion cited nothing', async () => {
    const item = randomUUID();
    await recordCitations(pool, { workItemId: item, actor: 'a', checks: [] });
    expect(await citationsFor(pool, item)).toEqual([]);
  });

  it('says nothing about an item nobody has completed', async () => {
    expect(await citationsFor(pool, randomUUID())).toEqual([]);
  });

  it('keeps both attempts when an item is completed twice', async () => {
    // Re-claimed and finished again: the earlier citation is history, not noise,
    // and overwriting it would hide that the first attempt cited nothing real.
    const item = randomUUID();
    await recordCitations(pool, {
      workItemId: item,
      actor: 'agent:w1',
      checks: [check({ status: 'absent', detail: 'no such commit' })],
    });
    await recordCitations(pool, {
      workItemId: item,
      actor: 'agent:w2',
      checks: [check({ value: 'bbbbbbb' })],
    });

    const rows = await citationsFor(pool, item);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actor)).toEqual(['agent:w1', 'agent:w2']);
  });
});
