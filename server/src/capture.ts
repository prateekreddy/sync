import { createHash } from 'node:crypto';
import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { lastWorkedOn } from './lease.js';
import { GatewayError } from './errors.js';
import { resolveLabels } from './labels.js';
import type { PlaneClient } from './plane.js';
import { escapeHtml } from './html.js';
import { readableId } from './view.js';

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
   * silently changes what other agents are allowed to pick up.
   */
  parentId?: string | undefined;
  /**
   * Put the item in a module — the epic layer.
   *
   * Omitted, it is inherited from `parentId` or from the discovery source; see
   * `inheritModule` for why that reverses the earlier decision not to. Pass it
   * explicitly to place work somewhere neither of those would put it.
   */
  moduleId?: string | undefined;
  idempotencyKey?: string | undefined;
  /**
   * Which client session this capture was written in, from the header the plugin
   * sets. Used only to pick between things this holder was working on: agents
   * authenticate as the human running them, so two windows open at once share a
   * holder, and a note written here should not be attributed to work happening
   * over there.
   *
   * Deliberately not in `CaptureBody`. It is not something a model should be
   * asked to supply, and unlike `claim` there is nothing here it could break by
   * getting it wrong — an absent session just falls back to recency.
   */
  sessionId?: string | null | undefined;
}

export interface CaptureResult {
  workItemId: string;
  readableId: string;
  title: string;
  deduped: boolean;
  replayed: boolean;
  parentId?: string | undefined;
  moduleId?: string | undefined;
  /**
   * True when no module was named and this took the one its parent or discovery
   * source is in. Reported for the same reason as `discoveredFromInferred`: an
   * agent should be able to see a placement it did not ask for.
   */
  moduleInherited?: boolean | undefined;
  /**
   * True when no parent was named and this became a SIBLING of the item the
   * caller is holding — that is, took its parent.
   *
   * Reported for the same reason as `moduleInherited`: an agent should be able to
   * see a placement it did not ask for, and move it in one call if the guess is
   * wrong. Never means the item became a *child* of what you are holding; see
   * `inheritParent` for why that would be the wrong default.
   */
  parentInherited?: boolean | undefined;
  /** The item this was linked back to, whether stated or derived from the lease. */
  discoveredFrom?: string | undefined;
  /**
   * True when nobody said where this came from and the gateway worked it out from
   * what the caller was working on. Reported rather than hidden: an agent should
   * be able to see that a link it did not ask for was made, and correct it if
   * wrong.
   */
  discoveredFromInferred?: boolean | undefined;
  /**
   * How strong the guess is, so two guesses of different strength do not look
   * identical in a reply:
   *
   * - `held` — you are holding this right now, which is nearly a fact.
   * - `recent` — you finished this a while ago; an inference about a session.
   * - `other-session` — this lease belongs to your agent identity but to a
   *   DIFFERENT session. It may be you before a restart, or another agent
   *   authenticating as the same token; the gateway cannot tell. The link is
   *   still offered because a wrong relates_to edge is cheap, but no parent is
   *   inherited from it — see `inheritParent` and PLANE-8.
   *
   * An agent deciding whether to correct the provenance needs to know which of
   * these it got.
   */
  discoveredFromBasis?: 'held' | 'recent' | 'other-session' | undefined;
  /** Set when the item was created but could not be put in the module. */
  moduleError?: string | undefined;
  /**
   * What this call actually applied — echoed so the caller can check it against
   * what it sent.
   *
   * Added after six consecutive captures landed with the wrong priority and no
   * labels and nothing in any reply said so. That particular fault was a
   * malformed call on the client side, not a defect here, but it ran six times
   * because the reply carried nothing to compare against the request. A write
   * primitive that does not report what it wrote cannot be checked by its own
   * caller, and agents are exactly the callers who never see the board
   * afterwards.
   */
  priority?: string | undefined;
  /** Label names actually on the item after this call. */
  labels?: string[] | undefined;
  /**
   * Parts of the request that did NOT take effect, named individually.
   *
   * Only the dedup path produces these: an existing item is returned untouched,
   * so a priority or label the caller asked for was silently ignored. Absence of
   * a field is not a report — saying which parts were dropped is.
   */
  notApplied?: string[] | undefined;
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
 * It used to answer only when the agent held EXACTLY ONE lease in the project,
 * on the reasoning that several leases give no way to tell which one was being
 * looked at. That was right about ambiguity and wrong about frequency: the way
 * work is actually noticed here is a design session holding nothing at all, so
 * the precondition was almost never met and the link was almost never made. Eight
 * shipped fixes did not move the number, because none of them touched the case
 * that occurs — see SYNC-36.
 *
 * So it now asks the lease table what this agent was doing, rather than only what
 * it is holding: the rows are already there — completing a lease sets `ended_at`
 * rather than deleting it — and recency inside one session is what "I noticed
 * this while working on that" actually means. Several live leases resolve to the
 * most recent instead of declining, for the same reason.
 *
 * Two cases still infer nothing:
 *
 * - **`parentId` was given.** A parent is a stronger statement than provenance
 *   and already places the item; adding a relates_to edge to the same work would
 *   be noise on both.
 * - **Nothing in the window.** A cold start with no history is not a guess worth
 *   making, and a confidently wrong provenance edge is worse than an absent one.
 *
 * What this never does is write a PARENT. Provenance is a fact about history and
 * costs nothing if it is wrong; a parent is a claim about structure, and a wrong
 * one hides work under a heading nobody drilling down will look at — which is
 * worse than leaving it at the top level where it is at least visible. Provenance
 * is the raw material, `gather` is the act, and a human is the authority.
 */
async function inferSource(
  pool: Pool,
  actor: Actor,
  input: CaptureInput,
): Promise<{ id: string; inferred: boolean; live: boolean; mine: boolean } | null> {
  if (input.discoveredFrom) {
    return { id: input.discoveredFrom, inferred: false, live: false, mine: true };
  }
  if (input.parentId) return null;

  const recent = await lastWorkedOn(pool, {
    holder: actor.holder,
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
  }).catch(() => null);

  return recent
    ? { id: recent.workItemId, inferred: true, live: recent.live, mine: recent.mine }
    : null;
}

/**
 * Which module this belongs to, when nobody said.
 *
 * This reverses a decision recorded in `CaptureInput.moduleId`, and the reversal
 * is worth stating: the argument was that a rollup which quietly includes things
 * is worse than one that visibly misses them. Measured on the real board six days
 * later, "visibly misses" meant **25 of 35 items in no module at all**, so the
 * rollup described under a third of the work and the caution bought nothing.
 *
 * Inheriting from the *parent* or the *discovery source* is safe in a way that
 * guessing would not be: both are places this work demonstrably came from, and
 * moving an item afterwards is one call. Parent first, because it is the stronger
 * statement — a sub-item belongs to its feature more definitely than a note
 * belongs to whatever its author happened to be holding.
 *
 * Costs one Plane round trip per module on a cold cache, because Plane exposes no
 * way to ask an item which module it is in. Never fails a capture: an inherited
 * module is a convenience, and the write-first primitive outranks it.
 */
const INHERIT_DEADLINE_MS = 2_000;

async function inheritModule(
  plane: PlaneClient,
  input: CaptureInput,
  source: { id: string } | null,
): Promise<{ id: string; inherited: boolean } | null> {
  if (input.moduleId) return { id: input.moduleId, inherited: false };

  const from = input.parentId ?? source?.id;
  if (!from) return null;

  // Bounded, because this is on the capture path and capture must stay trivial.
  // The warm case is a Map lookup with no I/O at all; the cold case is one
  // listing per module. The case this guards is neither: when Plane's module
  // endpoint is unreachable, PlaneClient's retry ladder turns a convenience into
  // roughly four seconds of backoff on every capture an agent makes. Caught in a
  // test that suddenly took 25 seconds.
  //
  // The deadline lives here rather than in `moduleOf` deliberately: the latency
  // budget belongs to the caller that has one, not to the lookup.
  const found = await Promise.race([
    plane.moduleOf(input.projectId, from).catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), INHERIT_DEADLINE_MS).unref?.()),
  ]);
  return found ? { id: found, inherited: true } : null;
}

/**
 * Which parent this belongs under, when nobody said.
 *
 * The module was made to inherit and the parent was not, and the asymmetry was
 * invisible because it fails in the flattering direction: the module *is* filled
 * in, so `board` reports the item as placed while it hangs off nothing. Measured
 * on a board built by one planning session and then worked normally — every item
 * from the planning session parented, every item captured afterwards an orphan.
 * The session used `decompose`, which always sets a parent; ordinary work uses
 * `capture`, which never did. Structure was being built only by the tool nobody
 * calls after day one.
 *
 * This inherits the source's **parent**, not the source — the capture becomes a
 * SIBLING of the item being worked, not its child. That distinction is the whole
 * design:
 *
 * - A child would make the source item unclaimable and uncompletable until the
 *   new item is done, so an agent recording a tangential discovery would block
 *   its own completion. Structure is not worth that.
 * - A child would also convert a claimable leaf into a container, changing what
 *   other agents may pick up as a side effect of someone writing a note.
 *
 * A sibling does neither, and matches what "I noticed this while doing X" usually
 * means: same workstream as X, not X is incomplete without it. When the source
 * has no parent there is nothing to be a sibling of, and this infers nothing
 * rather than inventing a hierarchy.
 *
 * Note what this deliberately does NOT claim to fix: a sibling is no more visible
 * to whoever claims the source than an orphan was. Delivery is a separate
 * problem, solved by the briefing `claim` returns. This one is about whether the
 * board describes a plan.
 *
 * ONLY from a lease the caller's own session took, which is the asymmetry with
 * `discoveredFrom` and the point of PLANE-8. The lease table keys on agent
 * identity, so two agents authenticating as `agent:dev2/worker-1` are one row
 * set: on 2026-08-03 agent B claimed a flaky-test item at 07:41:27 and agent A's
 * unrelated capture a minute later was filed as its sibling, under a container
 * neither the capture nor its author had anything to do with.
 *
 * The two inferences differ in what a wrong one costs, so they get different
 * rules. A wrong `discoveredFrom` is a relates_to edge — noise, and reported as
 * inferred so a reader can discount it. A wrong parent makes a container
 * unclaimable, because a parent with unfinished children is withheld by design;
 * unrelated work then blocks an epic and nobody finds out until they wonder why
 * it never becomes available. That is worth losing the inference over.
 *
 * The test is positive evidence of a MISMATCH — both sessions known and
 * different — not absence of a match. A client that cannot set the session
 * header, and a lease claimed before sessions existed, both read as "cannot
 * tell", and declining there would remove a working inference to guard against
 * nothing detectable.
 */
async function inheritParent(
  plane: PlaneClient,
  input: CaptureInput,
  source: { id: string; mine?: boolean } | null,
): Promise<{ id: string; inherited: boolean } | null> {
  if (input.parentId) return { id: input.parentId, inherited: false };
  if (!source) return null;
  if (source.mine === false) return null;

  // Bounded for the same reason as the module lookup: capture must stay trivial,
  // and an unreachable Plane must cost a missing convenience rather than
  // PlaneClient's full retry ladder on every capture an agent makes.
  const src = await Promise.race([
    plane.getWorkItem(input.projectId, source.id).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), INHERIT_DEADLINE_MS).unref?.()),
  ]);
  return src?.parent ? { id: src.parent, inherited: true } : null;
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

  // Computed before the branch: the dedup path needs it too, because an item
  // someone already wrote down still belongs in the workstream this caller is
  // working in.
  const source = await inferSource(pool, actor, input);

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
    // An existing item is handed back untouched, so anything the caller asked to
    // set on it did not happen. Naming those parts is the point: `deduped: true`
    // says a different item came back, not that a priority was dropped on the
    // floor.
    const notApplied = [
      ...(input.priority && input.priority !== 'none' ? ['priority'] : []),
      ...(input.labels?.length ? ['labels'] : []),
    ];
    result = {
      workItemId: dupe.id,
      readableId: readableId(dupe.sequence_id, dupe.project__identifier),
      title: dupe.name,
      deduped: true,
      replayed: false,
      ...(parent ? { parentId: parent } : {}),
      ...(notApplied.length ? { notApplied } : {}),
    };
  } else {
    // Names in, ids out — Plane's API takes only uuids, and every caller writes
    // words. Resolved before the create so a bad label fails the call outright
    // rather than leaving a work item with silently missing routing.
    const labelIds = input.labels?.length
      ? await resolveLabels(plane, input.projectId, input.labels)
      : [];

    // Inferred only on this branch. The dedup path deliberately does not adopt an
    // item into a *guessed* parent: re-parenting somebody else's existing work on
    // the strength of what this caller happened to be holding rearranges a board
    // nobody asked to have rearranged. An explicit `parentId` still adopts an
    // orphan, below, because that is a stated intention rather than an inference.
    const parent = await inheritParent(plane, input, source);

    const identifier = plane.identifierFor(input.projectId);
    const created = await plane.createWorkItem(input.projectId, {
      name: input.title,
      description_html: `<p>${escapeHtml(input.body)}</p>`,
      priority: input.priority ?? 'none',
      ...(labelIds.length ? { labels: labelIds } : {}),
      // Plane models a sub-item as a plain `parent` uuid on the work item — there
      // is no separate sub-issue resource — so decomposition costs nothing extra.
      ...(parent ? { parent: parent.id } : {}),
      // Which agent wrote this down. `created_by` cannot answer it: an agent
      // minted from a personal token authenticates AS that human, so Plane records
      // the owner for everything its own agents capture — measured 2026-08-04.
      // Plane's own field rather than a new label, and informational only: it
      // gates nothing, it tells a reader whether to take the wording as a person's
      // or as another agent's shorthand. Verified to persist through the API.
      external_source: actor.holder,
    });
    result = {
      workItemId: created.id,
      readableId: readableId(created.sequence_id, identifier),
      title: created.name,
      deduped: false,
      replayed: false,
      ...(created.parent ? { parentId: created.parent } : {}),
      ...(parent?.inherited ? { parentInherited: true } : {}),
      // Echoed from what was sent rather than read back off `created`: Plane's
      // create response is the same object we posted, so reading it there would
      // prove only that we can quote ourselves. The value here is that the
      // caller can compare it with its own request.
      priority: input.priority ?? 'none',
      ...(input.labels?.length ? { labels: input.labels } : {}),
    };

    // Provenance. Plane has no `discovered_from` relation type, so this is
    // recorded as relates_to plus an explicit comment — the edge keeps it
    // navigable, the comment keeps it meaningful.
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
          !source.inferred
            ? `<p>Discovered while working on a related item, by ${actor.holder}.</p>`
            : !source.mine
              ? `<p>Captured by ${actor.holder}. Provenance inferred from a lease held under the same agent identity in a different session, so it may not be this caller's work — not stated, and no parent was inherited from it.</p>`
              : source.live
              ? `<p>Captured by ${actor.holder} while it held the linked item. Provenance inferred from the lease, not stated.</p>`
              : `<p>Captured by ${actor.holder} shortly after it finished the linked item. Provenance inferred from what it was last working on, not stated.</p>`,
        )
        .catch(() => {});
      result = {
        ...result,
        discoveredFrom: source.id,
        ...(source.inferred
          ? {
              discoveredFromInferred: true,
              discoveredFromBasis: !source.mine
                ? ('other-session' as const)
                : source.live
                  ? ('held' as const)
                  : ('recent' as const),
            }
          : {}),
      };
    }
  }

  // Membership is an edge, added after the item exists — and applied on the dedup
  // branch too. An item someone already wrote down still belongs in the feature
  // this caller is working on, and a rollup that misses it is wrong in the
  // direction that looks like less work remaining.
  const module = await inheritModule(plane, input, source);
  if (module) {
    try {
      await plane.addToModule(input.projectId, module.id, [result.workItemId]);
      result = {
        ...result,
        moduleId: module.id,
        ...(module.inherited ? { moduleInherited: true } : {}),
      };
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
            ? `No module ${module.id} in this project, or modules are not enabled on it. The item was created but is not in a module.`
            : `Could not add to module ${module.id}: ${String(err)}. The item was created.`,
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

