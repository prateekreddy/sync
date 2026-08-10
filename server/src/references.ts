import { log } from './log.js';
import type { PlaneClient } from './plane.js';

/**
 * Work items a completion DECLARES, turned into edges instead of prose.
 *
 * Completions in this project say "Superseded by SYNC-32", "Replaced by … See
 * SYNC-35", "captured as SYNC-34". Every one is a real relationship written as
 * text in a field nothing queries, and making them reachable is why this exists.
 *
 * ### Why prose is no longer a source of edges
 *
 * It was, and the correction is the same lesson as `#42` below, learned the
 * expensive way. An outcome names work items as DATA at least as often as it
 * names them as relations: the closure of SYNC-88 reported that the top level
 * goes from 65 roots to 7 and named which 7, creating seven permanent edges to
 * items it had nothing to do with. The better the completion, the worse the
 * damage — and edges feed `claim`'s briefing, so each false one dilutes the
 * mechanism that stops an agent missing a requirement.
 *
 * `refs` is the declared channel and now the only one. What prose mentions still
 * get is a line in the reply saying they were not linked and how to link them,
 * because agents were told the old behaviour and a rule that changes silently is
 * the failure this file exists to stop.
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

  // Prose is prose. This used to be the primary source of edges, and the reasons
  // it cannot be are the reasons `refs` was added:
  //
  // An outcome names work items as DATA as often as it names them as relations.
  // Measured on the closure of SYNC-88, whose outcome reported that the top level
  // goes from 65 roots to 7 and said which 7 — and which therefore created seven
  // permanent `relates_to` edges to items it had nothing to do with. The more
  // carefully a completion shows its work, the more the graph is corrupted by it.
  //
  // And the edges are not inert. They are what `claim` builds a briefing from,
  // where linked items are handed over open-first with their full text precisely
  // so an agent does not miss a requirement. Every false edge dilutes the one
  // mechanism protecting against that. They are also asymmetric and permanent:
  // nothing prunes them, and the item at the far end never agreed.
  //
  // `refs` already existed as the deliberate channel. Inferring from prose as
  // WELL meant there was no way to mention an item without linking it, so the
  // caller had no choice to make. Now they do.
  const refs: Reference[] = [];
  const seen = new Set<number>();

  // Reported rather than dropped, because agents were told the old behaviour and
  // an edge that silently stops being made is the failure this file exists to
  // stop, arriving from the other side. Named in prose, not linked, and told how
  // to link it if that is what was meant.
  const mentioned = referencesIn(args.text, identifier);

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

  // Everything named in the outcome that the caller did not also declare.
  const pending = mentioned.filter((m) => !seen.has(m.sequence));

  // Nothing to resolve and nothing to say: the common completion, and it must
  // not put a Plane listing in front of every one of them.
  if (refs.length === 0 && pending.length === 0) return rejected;

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

  // Said once each, after the rejects, so a caller can see what it would have
  // got under the old behaviour and ask for it deliberately -- except for the
  // item being completed, which every thorough outcome names and which can only
  // ever be a self-edge. Telling somebody to link an item to itself is noise,
  // and it is the one readableId that is always safe to drop.
  const notLinked: LinkedReference[] = pending
    .filter((m) => bySequence.get(m.sequence) !== args.fromId)
    .map((m) => ({
      readableId: m.readableId,
      linked: false,
      reason: 'named in the outcome, which does not create a relation — pass it in refs if it is one',
    }));

  const out: LinkedReference[] = [...rejected, ...notLinked];
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
