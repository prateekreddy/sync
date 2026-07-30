import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readDelivery, refsIn, verifySignature } from '../src/github.js';

const SECRET = 'shhh';
const sign = (body: string): string =>
  `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')}`;

describe('signature', () => {
  const body = '{"hello":"world"}';

  it('accepts a delivery GitHub actually signed', () => {
    expect(verifySignature(SECRET, Buffer.from(body), sign(body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(SECRET, Buffer.from('{"hello":"evil"}'), sign(body))).toBe(false);
  });

  it('rejects a missing signature, and refuses to run without a secret', () => {
    // The endpoint transitions work items. There is no unauthenticated mode.
    expect(verifySignature(SECRET, Buffer.from(body), undefined)).toBe(false);
    expect(verifySignature('', Buffer.from(body), sign(body))).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; that must not become a 500.
    expect(verifySignature(SECRET, Buffer.from(body), 'sha256=abc')).toBe(false);
  });
});

describe('references', () => {
  it('never reads a bare #42 as ours', () => {
    // In a PR body `#42` is a GitHub issue — that is what the author saw when
    // they typed it. Reading it as SYNC-42 would close unrelated work.
    expect(refsIn('Fixes #42 and closes #7')).toEqual([]);
  });

  it('reads the qualified form, and knows closing from mentioning', () => {
    const refs = refsIn('Fixes SYNC-42. See also SYNC-9 for background.');
    expect(refs.find((r) => r.readableId === 'SYNC-42')?.closing).toBe(true);
    expect(refs.find((r) => r.readableId === 'SYNC-9')?.closing).toBe(false);
  });

  it('accepts every keyword GitHub itself accepts, in any case', () => {
    for (const kw of ['Closes', 'closed', 'fix', 'Fixes', 'fixed', 'resolve', 'Resolves']) {
      expect(refsIn(`${kw} SYNC-1`)[0]?.closing, kw).toBe(true);
    }
  });

  it('does not let a later mention downgrade a closing reference', () => {
    expect(refsIn('Fixes SYNC-42. More on SYNC-42 below.')).toEqual([
      { readableId: 'SYNC-42', identifier: 'SYNC', sequence: 42, closing: true },
    ]);
  });

  it('surfaces the identifier so ordinary words can be discarded', () => {
    // `UTF-8` matches the shape exactly. Nothing in the text can distinguish it,
    // so the caller checks the identifier against real projects instead.
    const refs = refsIn('Encode as UTF-8, hash with SHA-256, fixes SYNC-3');
    expect(refs.map((r) => r.identifier).sort()).toEqual(['SHA', 'SYNC', 'UTF']);
    expect(refs.find((r) => r.identifier === 'SYNC')?.closing).toBe(true);
  });
});

describe('deliveries', () => {
  const repo = { full_name: 'acme/app', default_branch: 'main' };

  it('acts on a merged pull request', () => {
    const d = readDelivery('pull_request', {
      action: 'closed',
      repository: repo,
      pull_request: {
        merged: true,
        html_url: 'https://github.com/acme/app/pull/42',
        title: 'Fixes SYNC-42',
        body: '',
        number: 42,
        merge_commit_sha: '3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4',
        merged_by: { login: 'octo' },
      },
    });
    expect(d?.landed).toBe(true);
    expect(d?.refs[0]?.closing).toBe(true);
    expect(d?.artefacts.map((a) => a.kind)).toEqual(['url', 'commit']);
    expect(d?.actor).toBe('octo');
  });

  it('ignores a pull request closed without merging', () => {
    // It references the item exactly as a merged one does. Treating it the same
    // would close work that was explicitly abandoned.
    expect(
      readDelivery('pull_request', {
        action: 'closed',
        repository: repo,
        pull_request: { merged: false, title: 'Fixes SYNC-42', number: 42 },
      }),
    ).toBeNull();
  });

  it('reads commit messages on a push to the default branch', () => {
    const d = readDelivery('push', {
      ref: 'refs/heads/main',
      repository: repo,
      pusher: { name: 'octo' },
      commits: [
        { id: 'aaaaaaa1111', message: 'chore: tidy' },
        { id: 'bbbbbbb2222', message: 'fix: resolve SYNC-7' },
      ],
    });
    expect(d?.refs).toEqual([
      { readableId: 'SYNC-7', identifier: 'SYNC', sequence: 7, closing: true },
    ]);
    expect(d?.artefacts).toHaveLength(2);
  });

  it('ignores a push to a feature branch', () => {
    // Nothing has landed anywhere; the change may still be rejected in review.
    expect(
      readDelivery('push', {
        ref: 'refs/heads/wip',
        repository: repo,
        commits: [{ id: 'aaaaaaa', message: 'fixes SYNC-7' }],
      }),
    ).toBeNull();
  });

  it('ignores events it does not act on', () => {
    expect(readDelivery('issue_comment', { action: 'created' })).toBeNull();
    expect(readDelivery('star', {})).toBeNull();
  });
});
