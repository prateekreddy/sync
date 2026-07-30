import type { Pool } from './db.js';
import {
  corroborate,
  record,
  unlanded,
  UNLANDED_LABEL,
  type Claim,
} from './attest.js';
import { UNVERIFIED_LABEL } from './evidence.js';
import { readDelivery, type Delivery, type Ref } from './github.js';
import { resolveLabels } from './labels.js';
import { log } from './log.js';
import type { PlaneClient, WorkItem } from './plane.js';

/**
 * Turning what GitHub saw into what the tracker believes.
 *
 * The rule that keeps this safe is GitHub's own: a **mention** references an item,
 * a **closing keyword** finishes it. So `See SYNC-42 for context` records evidence
 * and changes nothing, while `Fixes SYNC-42` transitions the item when the pull
 * request merges. Nobody has to learn a convention, and the destructive action
 * requires the author to have said the destructive thing.
 */

export interface WebhookDeps {
  pool: Pool;
  plane: PlaneClient;
  /** Whether a merged closing reference may transition an item nobody is holding. */
  autoClose: boolean;
}

export interface RefOutcome {
  readableId: string;
  workItemId?: string;
  /** `closed`, `verified`, `recorded`, or why nothing happened. */
  action: string;
}

/** More than a handful of references in one delivery is a mistake, not intent. */
const MAX_REFS = 10;

/**
 * Does `SYNC-42` name a work item in the project its prefix claims?
 *
 * Two separate checks, because Plane resolves the identifier itself and we do not
 * control how: the project must exist under that identifier, and the item that
 * came back must actually belong to it.
 */
async function resolveRef(
  plane: PlaneClient,
  ref: Ref,
  projectsByIdentifier: Map<string, string>,
): Promise<{ item: WorkItem; projectId: string } | null> {
  const projectId = projectsByIdentifier.get(ref.identifier);
  if (!projectId) return null;

  const item = await plane.byReadableId(ref.readableId).catch(() => null);
  if (!item) return null;
  if (item.project && item.project !== projectId) {
    log.warn(
      { readableId: ref.readableId, expected: projectId, got: item.project },
      'readable id resolved to a different project — ignoring',
    );
    return null;
  }
  return { item, projectId };
}

async function heldBySomeone(pool: Pool, workItemId: string): Promise<string | null> {
  const { rows } = await pool.query<{ holder: string }>(
    `select holder from lease
      where work_item_id = $1 and state = 'held' and expires_at > now()`,
    [workItemId],
  );
  return rows[0]?.holder ?? null;
}

/**
 * Add and remove labels in one read-modify-write.
 *
 * Plane's `labels` is a replacement, not a patch — writing the one label you care
 * about silently strips every other label the item carries, including the ones
 * the readiness gate reads.
 */
async function relabel(
  plane: PlaneClient,
  projectId: string,
  item: WorkItem,
  opts: { add?: string[]; remove?: string[] },
): Promise<void> {
  const add = opts.add?.length ? await resolveLabels(plane, projectId, opts.add) : [];
  const remove = new Set(
    opts.remove?.length
      ? (await plane.labels(projectId))
          .filter((l) => opts.remove!.includes(l.name.toLowerCase()))
          .map((l) => l.id)
      : [],
  );

  const current = item.labels ?? [];
  const next = [...new Set([...current, ...add])].filter((id) => !remove.has(id));
  if (next.length === current.length && next.every((id) => current.includes(id))) return;
  await plane.updateWorkItem(projectId, item.id, { labels: next });
}

/**
 * Everything one referenced work item needs.
 *
 * Ordering matters here in a way worth stating: the attestation is written
 * *before* anything is decided, so a later `complete` by an agent that cites the
 * same pull request is corroborated the instant it arrives. That is what makes
 * the webhook-first and the agent-first orderings the same code path rather than
 * two features.
 */
async function reconcileRef(
  deps: WebhookDeps,
  delivery: Delivery,
  ref: Ref,
  resolved: { item: WorkItem; projectId: string },
): Promise<RefOutcome> {
  const { pool, plane } = deps;
  const { item, projectId } = resolved;

  const claims: Claim[] = delivery.artefacts.map((a) => ({
    workItemId: item.id,
    projectId,
    source: 'github' as const,
    kind: a.kind,
    value: a.value,
    actor: delivery.actor,
    detail: { summary: delivery.summary, closing: ref.closing },
  }));
  // How many of those were new. GitHub redelivers, and this is the honest way to
  // tell a first delivery from a replay: a replay writes nothing, so anything
  // visible — a comment, a label change — is guarded on it. Deriving it from the
  // board's own state instead would mean a label doing double duty as a marker.
  const fresh = (await record(pool, claims)) > 0;

  const group = await plane.stateGroupOf(projectId, item.state);
  const done = group === 'completed' || group === 'cancelled';

  // Already finished. The only thing left is to say whether the evidence holds up.
  if (done) {
    if (!fresh) return { readableId: ref.readableId, workItemId: item.id, action: 'recorded' };

    // Two ways this delivery corroborates a finished item, and both matter:
    //
    //   verified   — the exact artefact the agent cited has landed. Strongest.
    //   ref.closing — the agent cited nothing checkable (which is what earns the
    //                 "unverified" label in the first place, so there is no claim
    //                 to match), but a merged change says outright that it fixes
    //                 this item. External, and enough to lift the label.
    //
    // A bare mention on a finished item is neither, and proves nothing.
    const { verified } = await corroborate(pool, item.id);
    if (!verified && !ref.closing) {
      return { readableId: ref.readableId, workItemId: item.id, action: 'recorded' };
    }

    const names = await plane.labels(projectId);
    const carried = names
      .filter((l) => item.labels?.includes(l.id))
      .map((l) => l.name.toLowerCase())
      .filter((n) => n === UNVERIFIED_LABEL || n === UNLANDED_LABEL);

    if (carried.length) await relabel(plane, projectId, item, { remove: carried });
    await plane.comment(
      projectId,
      item.id,
      `<p>Evidence confirmed: ${escapeHtml(delivery.summary)}.</p>` +
        (carried.length
          ? `<p><em>This completion had been flagged "${carried.join('", "')}"; the change has now landed, so that is lifted.</em></p>`
          : `<p><em>The completion cited this, and it has now landed.</em></p>`),
    );
    return { readableId: ref.readableId, workItemId: item.id, action: 'verified' };
  }

  // Open, but only mentioned. Evidence is recorded; nothing moves.
  if (!ref.closing) {
    return { readableId: ref.readableId, workItemId: item.id, action: 'mentioned' };
  }

  if (!deps.autoClose) {
    return { readableId: ref.readableId, workItemId: item.id, action: 'autoclose-disabled' };
  }

  // Someone is actively holding it. Closing under a live lease would leave an
  // agent working an item the board says is finished — and it is unnecessary,
  // because the attestation above means their own `complete` is corroborated the
  // moment they call it. Tell them instead.
  const holder = await heldBySomeone(pool, item.id);
  if (holder) {
    if (fresh) {
      await plane.comment(
        projectId,
        item.id,
        `<p>${escapeHtml(delivery.summary)} — and it says it closes this item.</p>` +
          `<p><em>Left open because ${escapeHtml(holder)} holds the lease. Complete it when you are done; the evidence is already recorded.</em></p>`,
      );
    }
    return { readableId: ref.readableId, workItemId: item.id, action: 'held' };
  }

  // The transition runs even on a replay — setting a state that is already set is
  // the same state — but the comment does not.
  const completed = await plane.stateByGroup(projectId, 'completed');
  if (completed) await plane.updateWorkItem(projectId, item.id, { state: completed.id });
  if (fresh) {
    await plane.comment(
      projectId,
      item.id,
      `<p>Closed by ${escapeHtml(delivery.summary)}.</p>` +
        `<p><em>No agent asserted this — it is recorded because the change actually landed.</em></p>`,
    );
  }
  return { readableId: ref.readableId, workItemId: item.id, action: 'closed' };
}

export async function handleDelivery(
  deps: WebhookDeps,
  event: string,
  payload: unknown,
): Promise<{ event: string; handled: boolean; refs: RefOutcome[] }> {
  const delivery = readDelivery(event, payload);
  if (!delivery || delivery.refs.length === 0) {
    return { event, handled: false, refs: [] };
  }

  const projects = await deps.plane.projects();
  const byIdentifier = new Map(projects.map((p) => [p.identifier.toUpperCase(), p.id]));

  const outcomes: RefOutcome[] = [];
  for (const ref of delivery.refs.slice(0, MAX_REFS)) {
    const resolved = await resolveRef(deps.plane, ref, byIdentifier);
    if (!resolved) {
      // Overwhelmingly this is an ordinary word that looks like a reference.
      outcomes.push({ readableId: ref.readableId, action: 'no-such-item' });
      continue;
    }
    try {
      outcomes.push(await reconcileRef(deps, delivery, ref, resolved));
    } catch (err) {
      log.warn({ err, readableId: ref.readableId }, 'webhook reconcile failed');
      outcomes.push({ readableId: ref.readableId, workItemId: resolved.item.id, action: 'error' });
    }
  }

  return { event, handled: true, refs: outcomes };
}

/**
 * Report completions whose cited artefact never showed up.
 *
 * The other half of the loop, and the one nothing else can do: a completion that
 * cites a pull request nobody ever merged looks exactly like a good completion
 * until someone goes looking. Runs on the sweeper, so it costs nothing until
 * there is something to say.
 */
export async function sweepUnlanded(
  deps: Omit<WebhookDeps, 'autoClose'>,
  olderThanHours: number,
): Promise<number> {
  const stale = await unlanded(deps.pool, olderThanHours);
  for (const s of stale) {
    if (!s.projectId) continue;
    try {
      const item = await deps.plane.getWorkItem(s.projectId, s.workItemId);
      await relabel(deps.plane, s.projectId, item, { add: [UNLANDED_LABEL] });
      await deps.plane.comment(
        s.projectId,
        s.workItemId,
        `<p>This was completed citing <code>${escapeHtml(s.value)}</code>, and ${olderThanHours}h later nothing matching it has landed.</p>` +
          `<p><em>Either the change was never merged, or the webhook is not reaching this gateway. Labelled "${UNLANDED_LABEL}" so it is not mistaken for verified work.</em></p>`,
      );
    } catch (err) {
      log.warn({ err, workItemId: s.workItemId }, 'unlanded flag failed');
    }
  }
  return stale.length;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}
