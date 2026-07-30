/**
 * What counts as evidence in a completion.
 *
 * `complete` takes free text and accepts anything, including "done". The lease
 * ends and the item closes on an agent's unverified word, and nothing downstream
 * can tell a completion backed by a merged PR from one backed by nothing.
 *
 * This half asks only "did you cite anything at all", which needs nothing but the
 * string. Whether what was cited actually exists is a separate question with a
 * separate answer — see ghcheck.ts, which asks GitHub while the agent is still on
 * the call.
 *
 * A pure predicate over a string, deliberately: detection is a primitive, and
 * what to do about a completion with no evidence is policy the caller applies.
 */

export type EvidenceKind = 'commit' | 'url' | 'file' | 'workItem';

export interface Evidence {
  kind: EvidenceKind;
  value: string;
}

/**
 * A hex run of 7-40 characters, which is how git abbreviates and spells a sha.
 * Bounded on both sides so a word like "deadbeef" inside prose still counts (it
 * is indistinguishable from a short sha, and a false positive here costs nothing)
 * while a long hex blob or a uuid segment does not masquerade as one.
 */
const COMMIT = /\b[0-9a-f]{7,40}\b/g;
const URL = /\bhttps?:\/\/[^\s<>"')]+/g;
/** A path with an extension, optionally with :line — how anyone cites code. */
const FILE = /\b[\w.-]+(?:\/[\w.-]+)+\.\w{1,10}(?::\d+)?\b/g;
/**
 * Plane's own readable identifier, e.g. SYNC-42 or #42.
 *
 * No leading `\b` on the `#` alternative: a word boundary needs a word character
 * on one side, and " #17" has none, so anchoring it there matches nothing.
 */
const WORK_ITEM = /(?:\b[A-Z][A-Z0-9]{1,9}-\d+\b|#\d+\b)/g;

/**
 * Everything checkable in this outcome.
 *
 * Order matters only for readability of the result; a completion usually has one
 * kind and occasionally several.
 */
export function findEvidence(outcome: string): Evidence[] {
  const found: Evidence[] = [];
  const seen = new Set<string>();

  const collect = (re: RegExp, kind: EvidenceKind) => {
    for (const m of outcome.matchAll(re)) {
      const value = m[0];
      // A commit sha inside a URL is the same evidence twice.
      if (seen.has(value) || [...seen].some((s) => s.includes(value))) continue;
      seen.add(value);
      found.push({ kind, value });
    }
  };

  collect(URL, 'url');
  collect(FILE, 'file');
  collect(COMMIT, 'commit');
  collect(WORK_ITEM, 'workItem');
  return found;
}

/**
 * What to do about a completion carrying none.
 *
 * `warn` is the default and the right one for now. Refusing is stronger but
 * blocks legitimate completions of work that produces no artefact — a question
 * answered, an investigation that concluded "no, and here is why" — and an agent
 * that cannot complete such an item will either fabricate a sha or go silent,
 * both worse than an unverified completion that says so.
 */
export type EvidencePolicy = 'off' | 'warn' | 'refuse';

export const UNVERIFIED_LABEL = 'unverified';

export function evidenceWarning(outcome: string): string | null {
  if (findEvidence(outcome).length > 0) return null;
  return (
    'This completion cites nothing checkable — no commit, URL, file path or work item. ' +
    `It is recorded and labelled "${UNVERIFIED_LABEL}" so a human can tell it apart from ` +
    'a completion backed by evidence. If there is an artefact, add it as a comment.'
  );
}
