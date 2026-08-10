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

/**
 * A uuid is not two commits.
 *
 * `\b` alone was not enough, because a hyphen IS a word boundary: every uuid in
 * an outcome handed back its first and last segments as shas. Measured closing
 * SYNC-87, whose outcome quoted the session id the fix had just produced.
 *
 * Harmless only while nothing checks them. With evidence checking on, those
 * phantom shas resolve to no commit, so a completion backed by three real ones
 * is flagged for citing two that do not exist — and the flag meaning "backed by
 * nothing" would fire hardest on the completions that showed their work.
 */
describe('what looks like a commit', () => {
  const commits = (s: string) =>
    findEvidence(s).filter((e) => e.kind === 'commit').map((e) => e.value);

  it('reads no commits out of a uuid', () => {
    expect(commits('"sessionId": "b12e9747-49c2-4b77-bc72-c1a6fe82d1eb"')).toEqual([]);
  });

  it('still reads the real shas in the same sentence', () => {
    // The exact outcome that produced this: three real shas and one session id.
    const out = commits(
      'Fixed in 2b10900 and eeee49c, see 073581b. sessionId b12e9747-49c2-4b77-bc72-c1a6fe82d1eb',
    );
    expect(out).toEqual(['2b10900', 'eeee49c', '073581b']);
  });

  it('keeps a full-length sha', () => {
    expect(commits('at eeee49c35416381a1c6a7525fe94ed8bce6d5dda')).toEqual([
      'eeee49c35416381a1c6a7525fe94ed8bce6d5dda',
    ]);
  });

  it('keeps a sha in a range, where the neighbours are dots', () => {
    // `git push` output and compare links both look like this, and a dot is not
    // a hyphen -- the trade this makes is only about hyphens.
    expect(commits('ffe75ef..17fcc59 main -> main')).toEqual(['ffe75ef', '17fcc59']);
  });

  it('does not invent one from a hyphenated hex word', () => {
    // The deliberate cost of the rule. A bare "deadbeef" still counts, because
    // it is indistinguishable from a short sha and costs nothing; hyphenated, it
    // is far more likely part of an identifier.
    expect(commits('deadbeef')).toEqual(['deadbeef']);
    expect(commits('deadbeef-cafe1234')).toEqual([]);
  });
});
