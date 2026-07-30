import { log } from './log.js';
import type { PlaneClient } from './plane.js';

/**
 * Work items an outcome names, turned into edges instead of prose.
 *
 * Completions in this project already say "Superseded by SYNC-32", "Replaced by
 * … See SYNC-35", "captured as SYNC-34". Every one is a real relationship,
 * written as text, in a field nothing queries — and `findEvidence` was already
 * pulling those tokens out and discarding them one line later. The information
 * was never missing; it was unreachable.
 *
 * ### Why `#42` is deliberately not read here
 *
 * `evidence.ts` treats a bare `#42` as a work item reference, and that is right
 * *there*: it answers "did this completion cite anything at all", where a false
 * positive costs nothing.
 *
 * This is not that question. Here a false positive writes a permanent, wrong edge
 * between two unrelated items, and nobody reading the graph later can tell it
 * from a real one. The board already contains the counterexample — SYNC-24 is
 * titled "Merge PR #1 (work-tracking skill)", where `#1` is a GitHub pull request
 * and SYNC-1 is an unrelated redeploy. Same characters, different namespace, and
 * only the qualified form is unambiguous.
 *
 * Same reasoning as the deleted webhook receiver, arrived at from the opposite
 * direction: cheap detection may guess, durable structure may not.
 */

/** `SYNC-42`. Uppercase, because the readable identifier is. */
const QUALIFIED = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

export interface Reference {
  readableId: string;
  sequence: number;
}

/**
 * References to *this* project's items in a piece of text.
 *
 * Scoped by the project's own identifier rather than accepting anything
 * well-shaped: `UTF-8` and `SHA-256` match the pattern exactly, and nothing in
 * the text distinguishes them from a work item. Filtering against the one
 * identifier that can be correct here makes that whole class of false positive
 * impossible rather than unlikely.
 *
 * Cross-project references are dropped for now, not because they are meaningless
 * but because Plane's relation write is project-scoped and "what happens to an
 * edge whose ends live in different projects" deserves its own decision.
 */
export function referencesIn(text: string, identifier: string): Reference[] {
  if (!text || !identifier) return [];
  const want = identifier.toUpperCase();
  const out = new Map<number, Reference>();

  for (const m of text.matchAll(QUALIFIED)) {
    if (m[1] !== want) continue;
    const sequence = Number(m[2]);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) continue;
    out.set(sequence, { readableId: `${want}-${sequence}`, sequence });
  }
  return [...out.values()];
}

export interface LinkedReference {
  readableId: string;
  workItemId?: string;
  linked: boolean;
  /** Present when it was not linked, in words the agent can act on. */
  reason?: string;
}

/**
 * Resolve references and record them as `relates_to`.
 *
 * Plane has no `supersedes` or `caused_by` — its vocabulary is blocking,
 * blocked_by, duplicate, relates_to and four scheduling types — so "X replaced Y"
 * necessarily flattens to "X relates to Y". The edge keeps the pair navigable;
 * the completion text next to it keeps the meaning. That is a real loss and worth
 * knowing about rather than papering over.
 *
 * A reference to something that does not exist is **reported**, not swallowed.
 * The whole point of this file is that unqueryable prose is a failure; replacing
 * it with an edge that silently did not get made would be the same failure with
 * more machinery.
 */
export async function linkReferences(
  plane: PlaneClient,
  args: {
    projectId: string;
    fromId: string;
    text: string;
    /**
     * Work items named as data rather than prose.
     *
     * Parsing the outcome is the fallback for an agent that just writes the
     * sentence; this is the interface for one that already knows. It matters most
     * for references harvested from commit messages, where a completion spanning
     * five commits might touch four items and pasting all four into the outcome
     * would clutter the only part a human reads.
     */
    refs?: string[] | undefined;
  },
): Promise<LinkedReference[]> {
  let identifier: string;
  try {
    identifier = (await plane.projectIdentifier(args.projectId)) ?? '';
  } catch (err) {
    log.warn({ err, projectId: args.projectId }, 'could not read project identifier');
    return [];
  }

  const refs = referencesIn(args.text, identifier);
  const seen = new Set(refs.map((r) => r.sequence));

  // An explicit ref that names nothing is *reported*, where the same string
  // buried in prose is simply not a reference. The caller stated an intention
  // here, and silently discarding a stated intention is the failure this whole
  // file exists to stop.
  const rejected: LinkedReference[] = [];
  for (const raw of args.refs ?? []) {
    // Uppercased first. Prose has to stay case-strict or `utf-8` becomes a
    // reference; a ref the caller passed deliberately carries no such risk, and
    // rejecting "sync-32" on capitalisation would be pedantry.
    const one = referencesIn(raw.trim().toUpperCase(), identifier)[0];
    if (!one) {
      rejected.push({
        readableId: raw,
        linked: false,
        reason: `not a work item reference for this project — expected the form ${identifier}-123`,
      });
      continue;
    }
    if (!seen.has(one.sequence)) {
      seen.add(one.sequence);
      refs.push(one);
    }
  }

  if (refs.length === 0) return rejected;

  // One listing resolves every reference, however many there are, and avoids
  // asking Plane to look up a readable id whose project we would then have to
  // check. The readiness gate lists this project constantly; this is the same
  // call.
  const bySequence = new Map<number, string>();
  try {
    for (const i of await plane.listWorkItems(args.projectId)) bySequence.set(i.sequence_id, i.id);
  } catch (err) {
    log.warn({ err, projectId: args.projectId }, 'could not resolve references');
    return [
      ...rejected,
      ...refs.map((r) => ({
        readableId: r.readableId,
        linked: false,
        reason: 'could not reach Plane to resolve this reference',
      })),
    ];
  }

  const out: LinkedReference[] = [...rejected];
  for (const ref of refs) {
    const target = bySequence.get(ref.sequence);
    // An outcome naming its own item is the common case, not a mistake. An edge
    // from a thing to itself would be. Compared by id after resolution rather
    // than by sequence beforehand, so the caller need not know its own number.
    if (target === args.fromId) continue;
    if (!target) {
      out.push({
        readableId: ref.readableId,
        linked: false,
        reason: 'no such work item in this project',
      });
      continue;
    }
    try {
      await plane.relate(args.projectId, args.fromId, 'relates_to', [target]);
      out.push({ readableId: ref.readableId, workItemId: target, linked: true });
    } catch {
      // Plane rejects a duplicate relation, which is the expected outcome when a
      // capture already linked these two. Not logged: it is the normal case, and
      // the caller is told in the reply, which is a better place than a log line
      // nobody is reading.
      out.push({
        readableId: ref.readableId,
        workItemId: target,
        linked: false,
        reason: 'already linked, or Plane refused the relation',
      });
    }
  }
  return out;
}
