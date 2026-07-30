import { afterEach, describe, expect, it, vi } from 'vitest';
import { absent, checkEvidence, checkOne, configFromEnv } from '../src/ghcheck.js';
import type { GitHubConfig } from '../src/ghcheck.js';

/**
 * `complete` is the notification, so this is asked while the agent is still on
 * the call. Two properties matter more than any individual verdict:
 *
 *   1. It never throws. A lease must not fail to end because GitHub was slow,
 *      rate limited, or down — those become `unchecked`, which is a stated
 *      absence of information rather than an accusation.
 *   2. It only says `absent` when it genuinely knows. Without a token a private
 *      repository answers 404 exactly like a nonexistent one, and calling that
 *      "the agent made it up" would be a false accusation on real work.
 */
const cfg = (over: Partial<GitHubConfig> = {}): GitHubConfig => ({
  token: 'ghp_test',
  apiBase: 'https://api.github.invalid',
  ...over,
});

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('pull requests', () => {
  it('calls a merged pull request landed', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { merged: true, state: 'closed' }));
    const c = await checkOne(cfg(), {
      kind: 'url',
      value: 'https://github.com/acme/app/pull/42',
    });
    expect(c.status).toBe('landed');
    expect(c.detail).toContain('acme/app#42');
  });

  it('calls an open pull request pending, not a failure', async () => {
    // The common case at completion time: the agent opened the PR and finished.
    // Whether a human merges it later is not the agent's to control.
    vi.stubGlobal('fetch', async () => reply(200, { merged: false, state: 'open' }));
    expect((await checkOne(cfg(), { kind: 'url', value: 'https://github.com/a/b/pull/1' })).status)
      .toBe('pending');
  });

  it('calls a pull request closed without merging absent', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { merged: false, state: 'closed' }));
    const c = await checkOne(cfg(), { kind: 'url', value: 'https://github.com/a/b/pull/1' });
    expect(c.status).toBe('absent');
    expect(c.detail).toContain('closed without merging');
  });

  it('calls a nonexistent pull request absent when it had the credentials to know', async () => {
    vi.stubGlobal('fetch', async () => reply(404));
    expect((await checkOne(cfg(), { kind: 'url', value: 'https://github.com/a/b/pull/9' })).status)
      .toBe('absent');
  });

  it('will not accuse without a token, because private looks exactly like absent', async () => {
    vi.stubGlobal('fetch', async () => reply(404));
    const c = await checkOne(cfg({ token: undefined }), {
      kind: 'url',
      value: 'https://github.com/a/b/pull/9',
    });
    expect(c.status).toBe('unchecked');
    expect(c.detail).toContain('GITHUB_TOKEN');
  });
});

describe('commits', () => {
  it('calls a commit on the default branch landed', async () => {
    // `compare` answers both questions at once: 404 if unknown, and `behind` or
    // `identical` when the default branch already contains it.
    for (const where of ['identical', 'behind']) {
      vi.stubGlobal('fetch', async () => reply(200, { status: where }));
      const c = await checkOne(cfg({ defaultRepo: 'acme/app' }), {
        kind: 'commit',
        value: '3f7a891',
      });
      expect(c.status, where).toBe('landed');
    }
  });

  it('calls a commit that exists only on a branch pending', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { status: 'ahead' }));
    expect(
      (await checkOne(cfg({ defaultRepo: 'a/b' }), { kind: 'commit', value: 'abcdef1' })).status,
    ).toBe('pending');
  });

  it('calls an unknown sha absent', async () => {
    vi.stubGlobal('fetch', async () => reply(404));
    expect(
      (await checkOne(cfg({ defaultRepo: 'a/b' }), { kind: 'commit', value: 'deadbee' })).status,
    ).toBe('absent');
  });

  it('does not guess a repository for a bare sha', async () => {
    // Nothing to ask. Saying so beats picking a repository at random.
    const c = await checkOne(cfg({ defaultRepo: undefined }), {
      kind: 'commit',
      value: '3f7a891',
    });
    expect(c.status).toBe('unchecked');
    expect(c.detail).toContain('GITHUB_REPO');
  });

  it('takes the repository from a commit URL when it has one', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return reply(200, { status: 'behind' });
    });
    const c = await checkOne(cfg({ defaultRepo: 'wrong/repo' }), {
      kind: 'url',
      value: 'https://github.com/right/repo/commit/3f7a891',
    });
    expect(c.status).toBe('landed');
    expect(seen[0]).toContain('/repos/right/repo/');
  });
});

describe('what it refuses to judge', () => {
  it('never throws when GitHub is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = await checkOne(cfg({ defaultRepo: 'a/b' }), { kind: 'commit', value: 'abcdef1' });
    expect(c.status).toBe('unchecked');
    expect(c.detail).toContain('could not reach GitHub');
  });

  it('treats a 5xx as unknown rather than absent', async () => {
    vi.stubGlobal('fetch', async () => reply(503));
    expect(
      (await checkOne(cfg({ defaultRepo: 'a/b' }), { kind: 'commit', value: 'abcdef1' })).status,
    ).toBe('unchecked');
  });

  it('does not claim to have checked a file path or a work item', async () => {
    for (const kind of ['file', 'workItem'] as const) {
      const c = await checkOne(cfg(), { kind, value: 'server/src/view.ts' });
      expect(c.status, kind).toBe('unchecked');
      expect(c.detail).toContain('not a GitHub artefact');
    }
  });

  it('does not claim to have checked a non-GitHub link', async () => {
    const c = await checkOne(cfg(), { kind: 'url', value: 'https://example.com/build/9' });
    expect(c.status).toBe('unchecked');
  });
});

describe('the whole set', () => {
  it('reports every citation as unchecked when checking is off', async () => {
    const checks = await checkEvidence(null, [
      { kind: 'commit', value: '3f7a891' },
      { kind: 'url', value: 'https://github.com/a/b/pull/1' },
    ]);
    expect(checks.map((c) => c.status)).toEqual(['unchecked', 'unchecked']);
    expect(absent(checks)).toEqual([]);
  });

  it('picks out only what is genuinely missing', async () => {
    const checks = [
      { kind: 'commit' as const, value: 'a', status: 'landed' as const, detail: '' },
      { kind: 'commit' as const, value: 'b', status: 'pending' as const, detail: '' },
      { kind: 'commit' as const, value: 'c', status: 'unchecked' as const, detail: '' },
      { kind: 'commit' as const, value: 'd', status: 'absent' as const, detail: '' },
    ];
    expect(absent(checks).map((c) => c.value)).toEqual(['d']);
  });

  it('caps how many requests one completion can cause', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return reply(200, { status: 'behind' });
    });
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'commit' as const,
      value: `abcdef${i}`,
    }));
    const checks = await checkEvidence(cfg({ defaultRepo: 'a/b' }), many);
    expect(checks).toHaveLength(8);
    expect(calls).toBe(8);
  });
});

describe('configuration', () => {
  it('is off until something is set', () => {
    expect(configFromEnv({})).toBeNull();
  });

  it('turns on for a token, a repo, or an explicit opt-in', () => {
    expect(configFromEnv({ GITHUB_TOKEN: 't' })).not.toBeNull();
    expect(configFromEnv({ GITHUB_REPO: 'a/b' })).not.toBeNull();
    expect(configFromEnv({ GITHUB_CHECK: 'on' })).not.toBeNull();
  });

  it('rejects a malformed repo at startup rather than on every completion', () => {
    expect(() => configFromEnv({ GITHUB_REPO: 'not-a-repo' })).toThrow(/owner\/name/);
  });
});
