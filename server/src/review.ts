import { rootlessOpenOf } from './board.js';
import { resolveLabels } from './labels.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { escapeHtml } from './html.js';

/**
 * The periodic structural review.
 *
 * Every check this gateway makes is per-item and instantaneous: the readiness
 * gate screens one item at claim time, the lease tracks one item live. Nothing
 * ever looked at a board as a whole and asked whether it still described a plan,
 * so drift was found only when a human happened to ask — twice, on two projects,
 * a day apart, in the same shape.
 *
 * The proof that this was the missing piece is SYNC-36: it diagnosed the cause
 * correctly, was filed high priority, and sat open while a second board decayed
 * the same way. The system had already written down the answer and had no way to
 * act on what it knew. A metric is worth exactly as much as whatever reads it,
 * and until now nothing read this one.
 *
 * Deliberately conservative about writing. It raises at most one open item per
 * project, never a second while the first is open, and labels it `needs-human`
 * — restructuring a board is a judgement about what belongs under what, and a
 * fleet that reorganised its own backlog unprompted would be worse than a flat
 * one.
 */

/**
 * Kept stable, and matched on, so a review that is already open is never raised
 * twice. Changing this text orphans any open review item and the next pass files
 * a fresh one.
 */
export const REVIEW_TITLE = 'This board has gone flat: most open work hangs off nothing';

export interface ReviewThresholds {
  /**
   * Below this many rootless items, a flat board is just a small board and
   * naming it is noise. A floor rather than a ratio because early projects are
   * legitimately flat — structure that has not been needed yet is not decay.
   */
  minRootless: number;
  /**
   * Share of open work that must be rootless. Half is the point where the board
   * stops being a plan with some loose ends and becomes an inbox with some plan
   * in it.
   */
  ratio: number;
}

/**
 * Starting points, not measurements — say so rather than implying they were
 * tuned. Both are configurable, and every pass logs the numbers it saw even when
 * it raises nothing, so these can be corrected from evidence instead of taste.
 */
export const DEFAULT_THRESHOLDS: ReviewThresholds = { minRootless: 10, ratio: 0.5 };

const DONE_GROUPS = new Set(['completed', 'cancelled']);

export interface Assessment {
  flat: boolean;
  openItems: number;
  rootless: WorkItem[];
  /** Rootless share of open work, 0 when there is no open work to divide by. */
  ratio: number;
  /** Why it did or did not trip, in the words a log line should use. */
  reason: string;
}

export function assess(
  items: WorkItem[],
  groupOf: Map<string, State['group']>,
  t: ReviewThresholds = DEFAULT_THRESHOLDS,
): Assessment {
  const open = items.filter((i) => !DONE_GROUPS.has(groupOf.get(i.state) ?? ''));
  const rootless = rootlessOpenOf(items, groupOf);
  const ratio = open.length ? rootless.length / open.length : 0;

  const base = { openItems: open.length, rootless, ratio };
  if (rootless.length < t.minRootless) {
    return {
      ...base,
      flat: false,
      reason: `${rootless.length} rootless open items, below the floor of ${t.minRootless}`,
    };
  }
  if (ratio < t.ratio) {
    return {
      ...base,
      flat: false,
      reason: `${rootless.length} of ${open.length} open items are rootless, under the ${t.ratio} share`,
    };
  }
  return {
    ...base,
    flat: true,
    reason: `${rootless.length} of ${open.length} open items hang off nothing`,
  };
}

/** How many offenders to name. Enough to act on, short of pasting the board back. */
const NAMED = 12;

function body(a: Assessment): string {
  const named = a.rootless.slice(0, NAMED);
  const list = named
    .map((i) => `<li>#${i.sequence_id} — ${escapeHtml(i.name)}</li>`)
    .join('');
  const more =
    a.rootless.length > named.length
      ? `<p>…and ${a.rootless.length - named.length} more.</p>`
      : '';

  return [
    `<p>${a.rootless.length} of ${a.openItems} open items have no parent and no sub-items, so nothing rolls them up. A board in this shape is an inbox with a tracker's name on it: it can say what is left, and not what any of it is part of.</p>`,
    // Naming them is the point. A count tells a reader the board is flat and
    // leaves them to go and find out which parts, which is the work they were
    // already not doing.
    `<p>Open items hanging off nothing:</p><ul>${list}</ul>`,
    more,
    `<p>This is not a request to parent all of them. Most boards go flat because captures land where they fall, so the useful move is usually to find the two or three real workstreams already implicit in this list, make those the containers, and file the rest under them — leaving anything that genuinely stands alone at the root.</p>`,
    `<p>Raised automatically by the gateway's periodic structural review, and labelled needs-human deliberately: deciding what belongs under what is a judgement, and a fleet that reorganised its own backlog unprompted would be worse than a flat one. Close this when the board reads like a plan again; it will be raised afresh if it drifts back.</p>`,
  ].join('');
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface ReviewOutcome {
  projectId: string;
  raised: boolean;
  assessment: Assessment;
  workItemId?: string | undefined;
  /** Set when a review was warranted but deliberately not filed. */
  skipped?: string | undefined;
}

/**
 * Assess one project and, if it has gone flat, raise exactly one item about it.
 *
 * Reads the item list once and answers every question from it — whether the
 * board is flat, which items to name, and whether a review is already open. The
 * open-review check is done here rather than left to `capture`'s dedup because
 * dedup would merge into a CLOSED review from a previous episode and quietly
 * raise nothing, which is the one outcome this whole mechanism cannot afford.
 */
export async function reviewProject(
  plane: PlaneClient,
  projectId: string,
  t: ReviewThresholds = DEFAULT_THRESHOLDS,
): Promise<ReviewOutcome> {
  const [items, states] = await Promise.all([
    plane.listWorkItems(projectId),
    plane.states(projectId),
  ]);
  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const assessment = assess(items, groupOf, t);

  if (!assessment.flat) return { projectId, raised: false, assessment };

  const wanted = normalise(REVIEW_TITLE);
  const alreadyOpen = items.find(
    (i) => normalise(i.name) === wanted && !DONE_GROUPS.has(groupOf.get(i.state) ?? ''),
  );
  if (alreadyOpen) {
    return {
      projectId,
      raised: false,
      assessment,
      skipped: `review #${alreadyOpen.sequence_id} is already open`,
    };
  }

  // Never fails the sweep. A label that cannot be resolved is worth less than
  // the item itself, and an unraised review is the failure mode this exists to
  // prevent.
  const labels = await resolveLabels(plane, projectId, ['needs-human']).catch(() => []);

  const created = await plane.createWorkItem(projectId, {
    name: REVIEW_TITLE,
    description_html: body(assessment),
    priority: 'medium',
    ...(labels.length ? { labels } : {}),
  });

  return { projectId, raised: true, assessment, workItemId: created.id };
}

/**
 * Review every project the gateway can see.
 *
 * Sequential on purpose. This runs on a timer against someone's live tracker
 * with nobody watching; finishing a few seconds sooner is worth nothing, and a
 * burst of concurrent list calls against Plane's rate limit could cost the fleet
 * its own budget.
 */
export async function reviewAll(
  plane: PlaneClient,
  t: ReviewThresholds = DEFAULT_THRESHOLDS,
): Promise<ReviewOutcome[]> {
  const projects = await plane.listProjects();
  const out: ReviewOutcome[] = [];
  for (const p of projects) {
    try {
      out.push(await reviewProject(plane, p.id, t));
    } catch {
      // One unreadable project must not stop the rest being reviewed.
    }
  }
  return out;
}
