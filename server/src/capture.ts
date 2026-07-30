import { createHash } from 'node:crypto';
import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { heldBy } from './lease.js';
import { GatewayError } from './errors.js';
import { resolveLabels } from './labels.js';
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
  /**
   * Decomposition: makes this a sub-item of `parentId`.
   *
   * Distinct from `discoveredFrom`, and the difference matters to the readiness
   * gate. `discoveredFrom` is a fact about history — "I was here when I noticed
   * this" — and constrains nothing. `parentId` is a claim about structure: the
   * parent is not done until its children are, so a parent with open children
   * stops being claimable work and becomes a container. Using the wrong one
   * silently changes what the fleet is allowed to pick up.
   */
  parentId?: string | undefined;
  /**
   * Put the item in a module — the epic layer.
   *
   * Deliberately not inherited from `parentId`. Plane does not inherit it either,
   * and guessing would put work in a feature nobody assigned it to; a rollup that
   * quietly includes things is worse than one that visibly misses them. Callers
   * breaking an item up should pass it explicitly, which is why `decompose` takes
   * it once and applies it to every child.
   */
  moduleId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface CaptureResult {
  workItemId: string;
  readableId: string;
  title: string;
  deduped: boolean;
  replayed: boolean;
  parentId?: string | undefined;
  moduleId?: string | undefined;
  /** The item this was linked back to, whether stated or derived from the lease. */
  discoveredFrom?: string | undefined;
  /**
   * True when nobody said where this came from and the gateway worked it out from
   * the caller's live lease. Reported rather than hidden: an agent should be able
   * to see that a link it did not ask for was made, and correct it if wrong.
   */
  discoveredFromInferred?: boolean | undefined;
  /** Set when the item was created but could not be put in the module. */
  moduleError?: string | undefined;
}

/**
 * Where this capture came from, asked of the lease rather than of the caller.
 *
 * The gateway already knows what an agent is working on — that is the entire
 * content of the lease table — so requiring `discoveredFrom` as an argument means
 * provenance is recorded only when someone remembers, under context pressure, in
 * the middle of something else. Measured on 2026-07-30: 36 items, two links, both
 * added by hand on the same day. Structure that costs an extra argument does not
 * get built.
 *
 * Three cases where it deliberately infers nothing:
 *
 * - **`parentId` was given.** A parent is a stronger statement than provenance
 *   and already places the item; adding a relates_to edge to the same work would
 *   be noise on both.
 * - **The agent holds several items in this project.** There is no way to tell
 *   which one it was looking at, and a confidently wrong provenance edge is worse
 *   than an absent one — a human reading the graph cannot tell a guess from a
 *   fact, so this refuses to make one.
 * - **The agent holds nothing.** Capture is deliberately callable with no lease.
 */
async function inferSource(
  pool: Pool,
  actor: Actor,
  input: CaptureInput,
): Promise<{ id: string; inferred: boolean } | null> {
  if (input.discoveredFrom) return { id: input.discoveredFrom, inferred: false };
  if (input.parentId) return null;

  const held = (await heldBy(pool, actor.holder).catch(() => [])).filter(
    (l) => l.projectId === input.projectId,
  );
  const only = held.length === 1 ? held[0] : undefined;
  return only ? { id: only.workItemId, inferred: true } : null;
}

export async function capture(
  plane: PlaneClient,
  pool: Pool,
  actor: Actor,
  input: CaptureInput,
): Promise<CaptureResult> {
  // Fingerprinted from what the caller sent, before any inference: two identical
  // calls made while holding different items are the same request, and letting
  // the lease into the hash would defeat the idempotency key it was given.
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
    // Dedup and decomposition interact badly if left alone. An agent that breaks a
    // task into five children expects five children; if one of them dedups against
    // a pre-existing item, that child silently ends up outside the parent and the
    // parent looks complete when it is not. So adopt an orphan into the requested
    // parent — but never re-parent an item that already belongs somewhere else,
    // because that would rearrange work the agent knows nothing about.
    let parent: string | undefined;
    if (input.parentId && input.parentId !== dupe.id) {
      const existing = await plane.getWorkItem(input.projectId, dupe.id).catch(() => null);
      if (existing && !existing.parent) {
        await plane
          .updateWorkItem(input.projectId, dupe.id, { parent: input.parentId })
          .then(() => {
            parent = input.parentId;
          })
          .catch(() => {});
      } else if (existing?.parent) {
        parent = existing.parent;
      }
    }
    result = {
      workItemId: dupe.id,
      readableId: `${dupe.project__identifier}-${dupe.sequence_id}`,
      title: dupe.name,
      deduped: true,
      replayed: false,
      ...(parent ? { parentId: parent } : {}),
    };
  } else {
    // Names in, ids out — Plane's API takes only uuids, and every caller writes
    // words. Resolved before the create so a bad label fails the call outright
    // rather than leaving a work item with silently missing routing.
    const labelIds = input.labels?.length
      ? await resolveLabels(plane, input.projectId, input.labels)
      : [];

    const created = await plane.createWorkItem(input.projectId, {
      name: input.title,
      description_html: `<p>${escapeHtml(input.body)}</p>`,
      priority: input.priority ?? 'none',
      ...(labelIds.length ? { labels: labelIds } : {}),
      // Plane models a sub-item as a plain `parent` uuid on the work item — there
      // is no separate sub-issue resource — so decomposition costs nothing extra.
      ...(input.parentId ? { parent: input.parentId } : {}),
    });
    result = {
      workItemId: created.id,
      readableId: `#${created.sequence_id}`,
      title: created.name,
      deduped: false,
      replayed: false,
      ...(created.parent ? { parentId: created.parent } : {}),
    };

    // Provenance. Plane has no `discovered_from` relation type, so this is
    // recorded as relates_to plus an explicit comment — the edge keeps it
    // navigable, the comment keeps it meaningful.
    const source = await inferSource(pool, actor, input);
    if (source) {
      await plane
        .relate(input.projectId, created.id, 'relates_to', [source.id])
        .catch(() => {});
      await plane
        .comment(
          input.projectId,
          created.id,
          // Stated and inferred provenance are not equally strong, and a reader
          // deciding what to trust needs to know which this was.
          source.inferred
            ? `<p>Captured by ${actor.holder} while it held the linked item. Provenance inferred from the lease, not stated.</p>`
            : `<p>Discovered while working on a related item, by ${actor.holder}.</p>`,
        )
        .catch(() => {});
      result = { ...result, discoveredFrom: source.id, ...(source.inferred ? { discoveredFromInferred: true } : {}) };
    }
  }

  // Membership is an edge, added after the item exists — and applied on the dedup
  // branch too. An item someone already wrote down still belongs in the feature
  // this caller is working on, and a rollup that misses it is wrong in the
  // direction that looks like less work remaining.
  if (input.moduleId) {
    try {
      await plane.addToModule(input.projectId, input.moduleId, [result.workItemId]);
      result = { ...result, moduleId: input.moduleId };
    } catch (err) {
      // Reported, never thrown. Write-it-down-first only survives if capture
      // cannot fail in interesting ways, and by this point the item exists: a
      // missing module edge is a reporting gap, an unwritten item is a lost
      // intention. Throwing here would tell the agent the capture failed, which
      // is false, and the honest alternative is to say what did not happen.
      result = {
        ...result,
        moduleError:
          err instanceof GatewayError && err.code === 'NOT_FOUND'
            ? `No module ${input.moduleId} in this project, or modules are not enabled on it. The item was created but is not in a module.`
            : `Could not add to module ${input.moduleId}: ${String(err)}. The item was created.`,
      };
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
