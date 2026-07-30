import { GatewayError } from './errors.js';
import type { PlaneClient } from './plane.js';
import { BLOCKING_LABELS } from './readiness.js';

/**
 * Label names in, label ids out.
 *
 * Plane's work-item API only accepts label uuids, but every human-facing use of a
 * label is a word: the readiness gate matches `needs-human`, capability routing
 * matches a token's capability names. An agent asked to label something writes
 * `["backend"]` and gets `"backend" is not a valid UUID` — so in practice nothing
 * ever set a label, and capability routing had nothing to match against.
 *
 * Resolving here rather than at each call site keeps the two consumers honest: an
 * id that reaches Plane came from a name that was matched or created, never from
 * a caller guessing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Levenshtein, bounded — only used to catch a typo, never to rank. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99; // far enough not to matter

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 99;
}

/**
 * A name one keystroke away from a label that changes whether work is claimable.
 *
 * `needs-humans` would otherwise be created as an ordinary label, look right on
 * the board, and withhold nothing — the failure being asked for is silent, so it
 * is refused rather than guessed at. An exact match is not a near miss: creating
 * `needs-human` in a project that does not have it yet is the correct outcome.
 */
function nearMiss(name: string): string | null {
  return BLOCKING_LABELS.find((l) => editDistance(name, l) === 1) ?? null;
}

/**
 * Resolve a mixed list of label names and ids to ids, creating names that do not
 * exist yet.
 *
 * Creating on miss is what makes labels usable at all — requiring an agent to
 * create a label first means it will not bother, which is the state we are in.
 */
export async function resolveLabels(
  plane: PlaneClient,
  projectId: string,
  given: string[],
): Promise<string[]> {
  const out: string[] = [];

  for (const raw of given) {
    const value = raw.trim();
    if (!value) continue;
    if (UUID.test(value)) {
      out.push(value);
      continue;
    }

    const wanted = value.toLowerCase();
    let id = (await plane.labels(projectId)).find((l) => l.name.toLowerCase() === wanted)?.id;

    // Cache miss is ambiguous: the label may genuinely not exist, or another agent
    // may have created it seconds ago. Re-read before creating a duplicate.
    if (!id) {
      id = (await plane.labels(projectId, 0)).find((l) => l.name.toLowerCase() === wanted)?.id;
    }

    if (!id) {
      const meant = nearMiss(wanted);
      if (meant) {
        throw new GatewayError(
          'INVALID',
          `No label "${value}" in this project, and it is one character from "${meant}", which controls whether work can be claimed. Use "${meant}" if that is what you meant, or pick a name that is not a near miss.`,
        );
      }
      id = (await plane.createLabel(projectId, value)).id;
    }

    if (!out.includes(id)) out.push(id);
  }

  return out;
}
