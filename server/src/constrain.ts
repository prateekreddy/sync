import type { Actor } from './auth.js';
import { capture, type CaptureResult } from './capture.js';
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';
import { escapeHtml } from './html.js';
import * as lease from './lease.js';
import type { PlaneClient, WorkItem } from './plane.js';
import { readableId } from './view.js';

/**
 * Record that a discovery constrains work that already exists.
 *
 * `capture` offers exactly one shape — "there is a new item" — so an agent that
 * finds a *requirement* on existing work files it as a sibling of the thing it
 * constrains. The constraint then sits NEXT TO the work instead of IN it, and
 * whoever claims the work never sees it. Observed twice on one board in a day,
 * and diagnosed by the box that hit it: "I treated 'I discovered something' as
 * 'there is a new task.' It usually isn't." (SYNC-57, via SYNC-54 and SYNC-56.)
 *
 * The fix is not a new relation. A `constrains` edge would put the requirement
 * one hop away from the work, which is the same failure with better labelling —
 * and Plane has no such edge anyway (SYNC-44). A requirement belongs in the
 * acceptance criteria of the item it constrains, as text the claimer cannot miss,
 * because `claim` hands over the description.
 *
 * So this appends to the constrained items, and optionally opens the *proof* as a
 * separate task blocked by them. One call, so the requirement and its proof
 * cannot drift apart — writing them separately is what produced the orphans.
 *
 * When the proof deserves to be its own item is a real judgement and this tool
 * does not make it. The test, which belongs in the caller's head: **does the
 * wrong implementation look right?** A rate limit applied to the wrong side
 * compiles and passes a naive test; an address copied across chains produces
 * config that reads as symmetric and never fails in normal operation. Neither is
 * caught by implementing carefully, only by feeding the guard bad input
 * deliberately — that is when the proof is real separate work. When the wrong
 * version looks obviously wrong, the acceptance criterion alone is enough and a
 * second item is landfill.
 */

/** The heading appended to a constrained item, and matched to avoid repeating it. */
export const CRITERIA_HEADING = 'Acceptance criteria';

export interface ConstrainResult {
  /** Items the requirement was written into. */
  constrained: Array<{
    workItemId: string;
    readableId: string;
    title: string;
    /** Set when the item is held: the holder was told, since they may be mid-run. */
    heldBy?: string | undefined;
  }>;
  /** Items that could not be updated, with the reason. Empty on full success. */
  failed: Array<{ workItemId: string; error: string }>;
  /** The proof task, when one was asked for. */
  proof?: CaptureResult | undefined;
  /**
   * Constrained items the proof could not be blocked on. Reported rather than
   * absorbed: a proof that is claimable before the work it verifies will be
   * picked up and will pass against nothing.
   */
  proofUnblocked?: string[] | undefined;
  complete: boolean;
}

export interface ConstrainInput {
  projectId: string;
  /** The items this requirement applies to. */
  workItemIds: string[];
  /**
   * The requirement, in the words the claimer needs. Specific enough that it
   * cannot be paraphrased into vagueness — the value of the pattern came from
   * naming exact addresses to test against, not from "handle this carefully".
   */
  requirement: string;
  /** Open the proof as its own item, blocked by everything named above. */
  proof?: { title: string; body: string } | undefined;
}

/**
 * Append the requirement to one item's description.
 *
 * Read-modify-write, which Plane gives no way to avoid — there is no append and
 * no precondition on update. The window is small and the failure is additive
 * (a lost append, never a corrupted description), which is why this is acceptable
 * where the same pattern on the lease would not be.
 */
async function appendCriterion(
  plane: PlaneClient,
  projectId: string,
  item: WorkItem,
  requirement: string,
): Promise<void> {
  const existing = item.description_html ?? '';
  const criterion = `<li>${escapeHtml(requirement)}</li>`;

  // Already there: appending it twice would make the item's own criteria look
  // like two different requirements that happen to read alike.
  if (existing.includes(criterion)) return;

  const html = existing.includes(`<p><strong>${CRITERIA_HEADING}</strong></p>`)
    ? // Extend the list that is already there rather than starting a second
      // heading, which would split one item's criteria into two places.
      existing.replace(/<\/ul>(?![\s\S]*<\/ul>)/, `${criterion}</ul>`)
    : `${existing}<p><strong>${CRITERIA_HEADING}</strong></p><ul>${criterion}</ul>`;

  await plane.updateWorkItem(projectId, item.id, { description_html: html });
}

export async function constrain(
  plane: PlaneClient,
  pool: Pool,
  actor: Actor,
  input: ConstrainInput,
): Promise<ConstrainResult> {
  const ids = [...new Set(input.workItemIds)];
  if (ids.length === 0) {
    throw new GatewayError('INVALID', 'Name at least one work item this constrains');
  }

  const constrained: ConstrainResult['constrained'] = [];
  const failed: ConstrainResult['failed'] = [];
  const identifier = plane.identifierFor(input.projectId);

  // In order, not concurrently. Two appends to the same item would each read the
  // description before the other wrote it, and the second would silently drop the
  // first — the exact failure this tool exists to prevent, one level down.
  for (const id of ids) {
    try {
      const item = await plane.getWorkItem(input.projectId, id);
      if (!item) throw new GatewayError('NOT_FOUND', 'No such work item in this project');

      await appendCriterion(plane, input.projectId, item, input.requirement);

      // A held item is precisely the case that matters most and is easiest to
      // miss: the holder already has the old description in context and will not
      // re-read it. A comment is the only thing Plane will actually surface to
      // them mid-run.
      const held = (await lease.liveHolders(pool, [id])).get(id);
      const holder = held && held.holder !== actor.holder ? held.holder : undefined;
      if (holder) {
        await plane
          .comment(
            input.projectId,
            id,
            `<p><strong>New acceptance criterion</strong> added by ${escapeHtml(actor.holder)} ` +
              `while you hold this item — it is not in the description you were handed:</p>` +
              `<p>${escapeHtml(input.requirement)}</p>`,
          )
          .catch(() => {});
      }

      constrained.push({
        workItemId: item.id,
        readableId: readableId(item.sequence_id, identifier),
        title: item.name,
        ...(holder ? { heldBy: holder } : {}),
      });
    } catch (err) {
      failed.push({ workItemId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!input.proof) {
    return { constrained, failed, complete: failed.length === 0 };
  }

  // The proof is captured only after the criteria land. A proof that exists while
  // the requirement does not is the drift this call exists to prevent, and it is
  // the more dangerous half — an item claiming to verify something nobody was
  // told to build.
  const proof = await capture(plane, pool, actor, {
    projectId: input.projectId,
    title: input.proof.title,
    body: input.proof.body,
  });

  // Blocked by everything it verifies, so it cannot be claimed and "pass" before
  // the work exists. Only the items actually constrained — blocking on one that
  // failed above would gate the proof on work nobody was asked to do.
  const blockOn = constrained.map((c) => c.workItemId);
  const proofUnblocked: string[] = [];
  if (blockOn.length) {
    await plane
      .relate(input.projectId, proof.workItemId, 'blocked_by', blockOn)
      .catch(() => proofUnblocked.push(...blockOn));
  }

  return {
    constrained,
    failed,
    proof,
    ...(proofUnblocked.length ? { proofUnblocked } : {}),
    complete: failed.length === 0 && proofUnblocked.length === 0,
  };
}
