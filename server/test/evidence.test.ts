import { describe, expect, it } from 'vitest';
import { findEvidence, evidenceWarning } from '../src/evidence.js';

/**
 * `complete` takes free text and accepts anything, including "done". Nothing
 * downstream can tell a completion backed by a merged PR from one backed by
 * nothing. This catches the empty claim; ghcheck.ts asks GitHub whether a
 * non-empty one is true.
 *
 * The bar is deliberately low. This is not verification, it is "did you cite
 * anything at all", and a false positive costs nothing while a false negative
 * nags an agent that did the right thing.
 */
describe('finding evidence', () => {
  it('recognises the things people actually cite', () => {
    const cases: Array<[string, string]> = [
      ['Fixed in 3f7a891, pushed.', 'commit'],
      ['See https://github.com/o/r/pull/42', 'url'],
      ['Rewrote server/src/labels.ts:88', 'file'],
      ['Superseded by SYNC-32', 'workItem'],
      ['Closes #17', 'workItem'],
    ];
    for (const [outcome, kind] of cases) {
      expect(findEvidence(outcome).map((e) => e.kind), outcome).toContain(kind);
    }
  });

  it('finds nothing in an assertion', () => {
    for (const empty of ['done', 'Fixed it.', 'All tests pass now', '']) {
      expect(findEvidence(empty)).toEqual([]);
      expect(evidenceWarning(empty)).toContain('nothing checkable');
    }
  });

  it('stays quiet when there is evidence', () => {
    expect(evidenceWarning('Done in 07f4286')).toBeNull();
  });

  it('does not count a commit inside a URL twice', () => {
    const found = findEvidence('https://github.com/o/r/commit/3f7a891');
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('url');
  });

  it('reports several kinds when a completion cites several', () => {
    const kinds = findEvidence(
      'Fixed in 3f7a891 (server/src/view.ts), see https://example.com/pr/9. Closes SYNC-30.',
    ).map((e) => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['commit', 'file', 'url', 'workItem']));
  });

  it('does not mistake ordinary prose for a sha', () => {
    // Short hex-looking words are the obvious false positive. 7 chars is the
    // git minimum, so anything shorter must not count.
    expect(findEvidence('added, fed, decade, beef')).toEqual([]);
  });

  it('does not treat a bare version or number as evidence', () => {
    expect(findEvidence('bumped to 1.4.0 and retried 3 times')).toEqual([]);
  });
});
