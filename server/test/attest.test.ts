import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimsIn, corroborate, matchKey, record, unlanded } from '../src/attest.js';
import { createPool } from '../src/db.js';

const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

beforeEach(async () => {
  await pool.query('truncate attestation');
});
afterAll(async () => {
  await pool.query('truncate attestation');
  await pool.end();
});

/**
 * Everything rests on one property: the same artefact, described by an agent in
 * free text and by GitHub in a payload, must reduce to the same key. If that ever
 * stops holding, nothing errors — corroboration silently returns false forever.
 */
describe('artefact identity', () => {
  it('reduces an abbreviated sha and a full one to the same artefact', () => {
    const full = '3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4';
    expect(matchKey('commit', '3f7a891')).toBe(matchKey('commit', full));
    expect(matchKey('commit', '3F7A891')).toBe(matchKey('commit', full));
  });

  it('does not merge two different commits', () => {
    expect(matchKey('commit', '3f7a891')).not.toBe(matchKey('commit', '3f7a892'));
  });

  it('treats a pull request URL as one artefact however it was written', () => {
    const key = matchKey('url', 'https://github.com/acme/app/pull/42');
    for (const v of [
      'https://github.com/acme/app/pull/42/',
      'https://github.com/Acme/App/pull/42',
      'https://www.github.com/acme/app/pull/42#issuecomment-9',
      'https://github.com/acme/app/pull/42?w=1',
    ]) {
      expect(matchKey('url', v), v).toBe(key);
    }
  });

  it('keeps different pull requests apart', () => {
    expect(matchKey('url', 'https://github.com/acme/app/pull/42')).not.toBe(
      matchKey('url', 'https://github.com/acme/app/pull/43'),
    );
    expect(matchKey('url', 'https://github.com/acme/app/pull/42')).not.toBe(
      matchKey('url', 'https://github.com/other/app/pull/42'),
    );
  });
});

describe('what becomes a claim', () => {
  it('keeps only what something outside could confirm', () => {
    // A file path is evidence a human can follow and counts against the "cited
    // nothing" warning — but no webhook will ever confirm it, so recording it
    // would leave a row that can only ever look uncorroborated.
    const kinds = claimsIn('Fixed in 3f7a891 (server/src/view.ts), closes SYNC-30').map(
      (c) => c.kind,
    );
    expect(new Set(kinds)).toEqual(new Set(['commit']));
  });
});

describe('corroboration', () => {
  const item = randomUUID();
  const project = randomUUID();

  const agentSaid = (value: string, kind: 'commit' | 'url' = 'commit') =>
    record(pool, [
      { workItemId: item, projectId: project, source: 'agent', kind, value, actor: 'agent:w1' },
    ]);
  const githubSaw = (value: string, kind: 'commit' | 'url' = 'commit') =>
    record(pool, [
      { workItemId: item, projectId: project, source: 'github', kind, value, actor: 'octo' },
    ]);

  it('is false while only the agent has spoken', async () => {
    await agentSaid('3f7a891');
    const c = await corroborate(pool, item);
    expect(c.verified).toBe(false);
    expect(c.claimed[0]).toMatchObject({ value: '3f7a891', confirmed: false });
  });

  it('confirms across the abbreviation, in either order', async () => {
    await agentSaid('3f7a891');
    await githubSaw('3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4');
    expect((await corroborate(pool, item)).verified).toBe(true);
  });

  it('confirms when the webhook arrived first', async () => {
    // The ordering that makes this one mechanism rather than two features.
    await githubSaw('https://github.com/acme/app/pull/42', 'url');
    expect((await corroborate(pool, item)).verified).toBe(false);
    await agentSaid('https://github.com/acme/app/pull/42/', 'url');
    expect((await corroborate(pool, item)).verified).toBe(true);
  });

  it('does not confirm a different artefact', async () => {
    await agentSaid('3f7a891');
    await githubSaw('9999999');
    const c = await corroborate(pool, item);
    expect(c.verified).toBe(false);
    expect(c.observed).toHaveLength(1);
  });

  it('is idempotent, because GitHub retries deliveries', async () => {
    expect(await githubSaw('3f7a891')).toBe(1);
    expect(await githubSaw('3f7a891')).toBe(0);
    expect(await githubSaw('3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4')).toBe(0);
    expect((await corroborate(pool, item)).observed).toHaveLength(1);
  });

  it('says nothing about an item nobody has cited', async () => {
    const c = await corroborate(pool, randomUUID());
    expect(c).toEqual({ claimed: [], observed: [], verified: false });
  });
});

describe('evidence that never landed', () => {
  const item = randomUUID();

  it('reports an old uncorroborated claim exactly once', async () => {
    await pool.query(
      `insert into attestation (work_item_id, project_id, source, kind, value, match_key, actor, observed_at)
       values ($1, $2, 'agent', 'url', $3, $4, 'agent:w1', now() - interval '48 hours')`,
      [
        item,
        randomUUID(),
        'https://github.com/acme/app/pull/99',
        'pr:acme/app#99',
      ],
    );

    expect((await unlanded(pool, 24)).map((u) => u.workItemId)).toEqual([item]);
    // Flagged on the way out, so a human is told once rather than every hour.
    expect(await unlanded(pool, 24)).toEqual([]);
  });

  it('leaves a claim alone until enough time has passed', async () => {
    await record(pool, [
      { workItemId: item, source: 'agent', kind: 'commit', value: 'abcdef1', actor: 'agent:w1' },
    ]);
    expect(await unlanded(pool, 24)).toEqual([]);
  });

  it('never reports a claim GitHub confirmed', async () => {
    const confirmed = randomUUID();
    await pool.query(
      `insert into attestation (work_item_id, source, kind, value, match_key, observed_at)
       values ($1, 'agent', 'commit', '3f7a891', 'commit:3f7a891', now() - interval '48 hours'),
              ($1, 'github', 'commit', '3f7a891c4e1d', 'commit:3f7a891', now())`,
      [confirmed],
    );
    expect(await unlanded(pool, 24)).toEqual([]);
  });
});
