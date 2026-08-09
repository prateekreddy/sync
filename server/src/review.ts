import { rootlessOpenOf } from './board.js';
import { resolveLabels } from './labels.js';
import { log } from './log.js';
import type { PlaneClient, State, WorkItem } from './plane.js';
import { rollUpProject } from './rollup.js';
import { escapeHtml } from './html.js';
import { readableId } from './view.js';

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
 * What it raises is a set of PROPOSALS, not a complaint. The first version named
 * the offending items and asked a human to invent a taxonomy — which is the work
 * they were already not doing, which is why the board went flat in the first
 * place. Naming a problem somebody already knows about does not move it. So the
 * review now does the part a machine can do — finding which loose items already
 * belong together, from provenance and shared labels — and leaves the part only a
 * person should do, which is saying yes.
 *
 * Still deliberately conservative about writing. One open item per project, never
 * a second while the first is open, labelled `needs-human`, and it proposes
 * `gather` calls rather than making them: a fleet that reorganised its own
 * backlog unprompted would be worse than a flat one.
 */

/**
 * Kept stable, and matched on, so a review that is already open is never raised
 * twice.
 */
export const REVIEW_TITLE = 'The top level of this board has stopped being readable';

/**
 * Titles this review used to raise.
 *
 * Renaming it would otherwise orphan whatever is currently open — the next pass
 * would find no match, file a second review, and leave a human holding two items
 * about one problem. The check below reads this list as well as the current
 * title, so a rename costs nothing and old items go on being recognised until
 * somebody closes them.
 */
export const PAST_TITLES = ['This board has gone flat: most open work hangs off nothing'];

export interface ReviewThresholds {
  /**
   * How many open items may sit at the top level before it stops being scannable.
   *
   * Nine, because the top level exists to be read at a glance and the point of a
   * container is that a person can hold the list in their head. This replaced a
   * floor-and-ratio pair that measured flatness — the shape of the board — rather
   * than readability, which is what anyone actually suffers from.
   */
  maxRootless: number;
  /** Fewer containers than this, on a board with real work in it, means no spine at all. */
  minContainers: number;
  /** Below this much open work, a board with no containers is just a young board. */
  minOpen: number;
}

/**
 * The readability budget: five to nine things at the top level. Both bounds are
 * judgement rather than measurement, and every pass logs the numbers it saw even
 * when it raises nothing, so they can be corrected from evidence instead of taste.
 */
export const DEFAULT_THRESHOLDS: ReviewThresholds = {
  maxRootless: 9,
  minContainers: 3,
  minOpen: 15,
};

const DONE_GROUPS = new Set(['completed', 'cancelled']);

/**
 * Labels that say what STATE an item is in rather than what workstream it belongs
 * to. Grouping by these would produce a container called "blocked", which is a
 * queue rather than a piece of work and would never finish.
 */
const NOT_A_WORKSTREAM = new Set(['needs-human', 'needs-refinement', 'blocked', 'wontfix', 'unverified']);

export interface Assessment {
  /** True when the top level has more in it than a person can take in. */
  unreadable: boolean;
  openItems: number;
  rootless: WorkItem[];
  /** Items with at least one child. The spine, such as it is. */
  containers: number;
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
  const withChildren = new Set(items.filter((i) => i.parent).map((i) => i.parent as string));
  const ratio = open.length ? rootless.length / open.length : 0;

  const base = { openItems: open.length, rootless, containers: withChildren.size, ratio };

  if (rootless.length > t.maxRootless) {
    return {
      ...base,
      unreadable: true,
      reason: `${rootless.length} open items sit at the top level, past the ${t.maxRootless} a person can scan`,
    };
  }
  // A board can pass the count above and still have no shape: a handful of loose
  // items is fine, a hundred filed in modules with nothing rolling any of them up
  // is not, and the first rule cannot see the second case.
  if (withChildren.size < t.minContainers && open.length > t.minOpen) {
    return {
      ...base,
      unreadable: true,
      reason: `${open.length} open items and only ${withChildren.size} containers — nothing groups the work`,
    };
  }
  return {
    ...base,
    unreadable: false,
    reason: `${rootless.length} at the top level across ${withChildren.size} containers, within budget`,
  };
}

/**
 * A set of loose items that already look like they belong together.
 *
 * Two kinds, kept apart because they are worth different amounts. A provenance
 * group has a container already — the item they were all discovered from — so it
 * is a `gather` call somebody can say yes to. A label group has members and no
 * name, because a label is a category and a container should be named for the
 * outcome it delivers; "Search improvements" never finishes, so proposing it as a
 * title would be proposing the exact thing the playbook warns against.
 */
export interface Grouping {
  kind: 'provenance' | 'label';
  members: WorkItem[];
  /** Provenance only: the existing item to file them under. */
  container?: WorkItem;
  /** Label only: what they have in common. */
  label?: string;
}

/** Two is a group. One is an item that happens to have a source. */
const MIN_GROUP = 2;
/** A label has to be doing more work than a pair to be worth proposing as a workstream. */
const MIN_LABEL_GROUP = 3;

/**
 * Find the groups already implicit in a pile of loose items.
 *
 * Provenance first and exclusively: an item that was discovered while working
 * something else has a real claim to sit under it, and once claimed it is not
 * offered again under a label it happens to share. Related-item edges are
 * symmetric in Plane, so this reads "these were noticed around the same piece of
 * work" rather than a direction — which is all the clustering needs.
 */
export function groupings(
  rootless: WorkItem[],
  relatedTo: Map<string, string[]>,
  byId: Map<string, WorkItem>,
  labelNames: Map<string, string>,
): Grouping[] {
  const out: Grouping[] = [];
  const spoken = new Set<string>();

  const bySource = new Map<string, WorkItem[]>();
  for (const item of rootless) {
    for (const source of relatedTo.get(item.id) ?? []) {
      if (!byId.has(source)) continue;
      const bucket = bySource.get(source);
      if (bucket) bucket.push(item);
      else bySource.set(source, [item]);
    }
  }

  // Biggest first, so the strongest signal claims its members before a weaker one
  // can. A source that is itself sitting at the top level is a fine container —
  // better than fine: filing four items under it takes five rows off the top
  // level rather than four. Two items pointing at each other never reach the
  // minimum, which is what stops an arbitrary direction being chosen between them.
  for (const [source, members] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // Already promised to another group as a member. Filing things under it now
    // could close a loop, which `gather` would refuse at the point somebody ran
    // it — better not to propose what cannot be done.
    if (spoken.has(source)) continue;
    const fresh = members.filter((m) => !spoken.has(m.id) && m.id !== source);
    if (fresh.length < MIN_GROUP) continue;
    for (const m of fresh) spoken.add(m.id);
    spoken.add(source);
    out.push({ kind: 'provenance', members: fresh, container: byId.get(source) as WorkItem });
  }

  const byLabel = new Map<string, WorkItem[]>();
  for (const item of rootless) {
    if (spoken.has(item.id)) continue;
    for (const id of item.labels) {
      const name = labelNames.get(id);
      if (!name || NOT_A_WORKSTREAM.has(name.toLowerCase())) continue;
      const bucket = byLabel.get(name);
      if (bucket) bucket.push(item);
      else byLabel.set(name, [item]);
    }
  }

  for (const [label, members] of [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const fresh = members.filter((m) => !spoken.has(m.id));
    if (fresh.length < MIN_LABEL_GROUP) continue;
    for (const m of fresh) spoken.add(m.id);
    out.push({ kind: 'label', members: fresh, label });
  }

  return out;
}

/** How many offenders to name outside a group. Enough to act on, short of pasting the board back. */
const NAMED = 12;

/** How many items to spend a relations request on. See `sourcesOf`. */
export const RELATION_BUDGET = 40;

/**
 * Which items each loose item is related to.
 *
 * One request per item, which is why it is bounded. Relations live behind their
 * own endpoint in Plane — there is no way to get them off a listing — and this
 * runs unattended against somebody's tracker, so a board with three hundred loose
 * items must not turn a review into three hundred requests. Past the budget the
 * remainder simply go ungrouped, and the caller says so rather than presenting a
 * partial answer as a complete one.
 */
async function sourcesOf(
  plane: PlaneClient,
  projectId: string,
  items: WorkItem[],
): Promise<{ related: Map<string, string[]>; unread: number }> {
  const related = new Map<string, string[]>();
  const within = items.slice(0, RELATION_BUDGET);
  for (const item of within) {
    // Sequential and forgiving: one unreadable item costs its own grouping and
    // nothing else. A review that fails because of a relations lookup would be
    // a review that does not happen.
    const rel = await plane.relations(projectId, item.id).catch(() => null);
    if (rel) related.set(item.id, rel.relates_to.map((r) => r.issue_id));
  }
  return { related, unread: items.length - within.length };
}

function proposal(g: Grouping, identifier: string | undefined): string {
  const rid = (i: WorkItem) => readableId(i.sequence_id, identifier);
  const list = g.members.map((m) => `<li>${rid(m)} — ${escapeHtml(m.name)}</li>`).join('');
  const ids = g.members.map(rid).join(', ');

  if (g.kind === 'provenance' && g.container) {
    return (
      `<p><strong>${g.members.length} items discovered while working ${rid(g.container)} — ${escapeHtml(g.container.name)}</strong></p>` +
      `<ul>${list}</ul>` +
      // The whole point of the rewrite: a call, not a suggestion that somebody
      // work out the call.
      `<p>If they belong under it: <code>gather(containerId: ${rid(g.container)}, workItemIds: [${ids}])</code></p>`
    );
  }
  return (
    `<p><strong>${g.members.length} items share the label <code>${escapeHtml(g.label ?? '')}</code></strong></p>` +
    `<ul>${list}</ul>` +
    // Deliberately no title. A label is a category and a container wants an
    // outcome — proposing "${label}" as a name would propose the thing that never
    // finishes.
    `<p>If that is one workstream rather than one kind of work, name what it delivers and ` +
    `<code>gather(title: "…", workItemIds: [${ids}])</code></p>`
  );
}

function body(a: Assessment, groups: Grouping[], identifier: string | undefined, unread: number): string {
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const rest = a.rootless.filter((i) => !grouped.has(i.id));
  const named = rest.slice(0, NAMED);

  const opening =
    `<p>${a.reason}. A top level is meant to be read at a glance — five to nine things somebody can ` +
    `hold in their head — and this one is a list to be searched instead. It can say what is left, ` +
    `and not what any of it is part of.</p>`;

  const proposals = groups.length
    ? `<p>Some of these already look like they belong together. Each block below is a call you can ` +
      `run as it stands, or say no to:</p>${groups.map((g) => proposal(g, identifier)).join('')}`
    : '';

  const leftovers = named.length
    ? `<p>${groups.length ? 'The rest' : 'Open items'} hanging off nothing:</p><ul>` +
      named.map((i) => `<li>${readableId(i.sequence_id, identifier)} — ${escapeHtml(i.name)}</li>`).join('') +
      `</ul>` +
      (rest.length > named.length ? `<p>…and ${rest.length - named.length} more.</p>` : '')
    : '';

  // Said rather than hidden. A bounded pass that presents itself as a complete
  // one is how "we looked at everything" becomes false without anyone noticing.
  const capped = unread
    ? `<p>${unread} further items were not checked for provenance this pass — the review reads at ` +
      `most ${RELATION_BUDGET} of them, since relations cost one request each.</p>`
    : '';

  return [
    opening,
    proposals,
    leftovers,
    capped,
    `<p>This is not a request to parent all of them. Anything that genuinely stands alone belongs at ` +
      `the root — that is what a root is. Nothing here has been moved: <code>gather</code> asks a ` +
      `person before it files anything, and deciding what belongs under what is a judgement a fleet ` +
      `should not be making on its own.</p>`,
    `<p>Raised automatically by the gateway's periodic structural review and labelled needs-human. ` +
      `Close it when the top level reads like a plan again; it will be raised afresh if it drifts back.</p>`,
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
  /** Containers whose state the same pass repaired. */
  repaired?: number | undefined;
}

/**
 * Assess one project, repair what is mechanical, and propose what is not.
 *
 * The two halves are deliberately different in kind. Rolling a container's state
 * up from its children is a derived fact and is simply written; deciding what
 * belongs under what is a judgement and is only ever proposed. The same listing
 * pays for both.
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

  // First, and regardless of whether anything is raised: a container showing a
  // status nobody has updated is wrong on every board, not only on unreadable
  // ones. Never fails the review — a repair that cannot be made is worth less
  // than the assessment.
  const repaired = await rollUpProject(plane, projectId, items, states).catch((err: unknown) => {
    log.warn({ err, projectId }, 'container state repair pass failed');
    return { changed: 0, failed: 0 };
  });

  const assessment = assess(items, groupOf, t);
  const base = { projectId, raised: false, assessment, repaired: repaired.changed };

  if (!assessment.unreadable) return base;

  const wanted = [REVIEW_TITLE, ...PAST_TITLES].map(normalise);
  const alreadyOpen = items.find(
    (i) => wanted.includes(normalise(i.name)) && !DONE_GROUPS.has(groupOf.get(i.state) ?? ''),
  );
  if (alreadyOpen) {
    return { ...base, skipped: `review #${alreadyOpen.sequence_id} is already open` };
  }

  const [{ related, unread }, labelNames, labels] = await Promise.all([
    sourcesOf(plane, projectId, assessment.rootless),
    plane.labelNames(projectId).catch(() => new Map<string, string>()),
    // Never fails the sweep. A label that cannot be resolved is worth less than
    // the item itself, and an unraised review is the failure mode this exists to
    // prevent.
    resolveLabels(plane, projectId, ['needs-human']).catch(() => []),
  ]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = groupings(assessment.rootless, related, byId, labelNames);

  const created = await plane.createWorkItem(projectId, {
    name: REVIEW_TITLE,
    description_html: body(assessment, groups, plane.identifierFor(projectId), unread),
    priority: 'medium',
    ...(labels.length ? { labels } : {}),
  });

  return { ...base, raised: true, workItemId: created.id };
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
