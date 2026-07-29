import { createHash } from 'node:crypto';
import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { GatewayError } from './errors.js';
import type { PlaneClient } from './plane.js';

/**
 * Capture — the write-first primitive.
 *
 * The discipline is "the moment you notice something, write it down, then decide
 * whether to do it". That only survives if capture is trivial: two required
 * fields, safe to retry, and never an error the agent has to reason about. If
 * capture can fail in interesting ways, agents stop doing it and the backlog
 * silently stops reflecting reality.
 *
 * The cost of making it trivial is volume, and volume without curation becomes
 * landfill. Dedup-on-write is the v1 hedge: a near-duplicate returns the existing
 * item rather than creating a second one.
 */

/** Same title modulo case, punctuation and whitespace counts as the same thing. */
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const hashBody = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

export interface CaptureInput {
  projectId: string;
  title: string;
  body: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none' | undefined;
  labels?: string[] | undefined;
  /** Provenance: the item being worked when this was noticed. */
  discoveredFrom?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface CaptureResult {
  workItemId: string;
  readableId: string;
  title: string;
  deduped: boolean;
  replayed: boolean;
}

export async function capture(
  plane: PlaneClient,
  pool: Pool,
  actor: Actor,
  input: CaptureInput,
): Promise<CaptureResult> {
  const fingerprint = hashBody({ ...input, idempotencyKey: undefined });

  // 1. Exact retry of a call we already answered.
  if (input.idempotencyKey) {
    const { rows } = await pool.query<{ request_hash: string; response: CaptureResult }>(
      'select request_hash, response from idempotency where key = $1',
      [input.idempotencyKey],
    );
    const prior = rows[0];
    if (prior) {
      // Replaying a stored response for a *different* body would be worse than
      // failing: the caller would believe something happened that did not.
      if (prior.request_hash !== fingerprint) {
        throw new GatewayError(
          'IDEMPOTENCY_MISMATCH',
          'That idempotency key was already used with a different request body',
          { key: input.idempotencyKey },
        );
      }
      return { ...prior.response, replayed: true };
    }
  }

  // 2. Somebody — human or agent — already wrote this down.
  //
  // Search with the NORMALIZED title, not the raw one. Plane's search does a
  // substring match, so punctuation the writer happened to include ("...client!!")
  // prevents it matching the punctuation-free original, and the duplicate gets
  // created anyway. Normalising first is what makes dedup actually fire.
  const target = normalize(input.title);
  const hits = await plane.search(target).catch(() => []);
  const dupe = hits.find((h) => normalize(h.name) === target);

  let result: CaptureResult;
  if (dupe) {
    result = {
      workItemId: dupe.id,
      readableId: `${dupe.project__identifier}-${dupe.sequence_id}`,
      title: dupe.name,
      deduped: true,
      replayed: false,
    };
  } else {
    const created = await plane.createWorkItem(input.projectId, {
      name: input.title,
      description_html: `<p>${escapeHtml(input.body)}</p>`,
      priority: input.priority ?? 'none',
      ...(input.labels?.length ? { labels: input.labels } : {}),
    });
    result = {
      workItemId: created.id,
      readableId: `#${created.sequence_id}`,
      title: created.name,
      deduped: false,
      replayed: false,
    };

    // Provenance. Plane has no `discovered_from` relation type, so this is
    // recorded as relates_to plus an explicit comment — the edge keeps it
    // navigable, the comment keeps it meaningful.
    if (input.discoveredFrom) {
      await plane
        .relate(input.projectId, created.id, 'relates_to', [input.discoveredFrom])
        .catch(() => {});
      await plane
        .comment(
          input.projectId,
          created.id,
          `<p>Discovered while working on a related item, by ${actor.holder}.</p>`,
        )
        .catch(() => {});
    }
  }

  if (input.idempotencyKey) {
    await pool.query(
      `insert into idempotency (key, actor, request_hash, response)
       values ($1, $2, $3, $4) on conflict (key) do nothing`,
      [input.idempotencyKey, actor.holder, fingerprint, JSON.stringify(result)],
    );
  }
  return result;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
