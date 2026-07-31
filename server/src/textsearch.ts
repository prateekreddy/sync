import type { WorkItem } from './plane.js';

/**
 * Text search over work items the gateway already has in hand.
 *
 * Plane's `/work-items/search/` matches **titles only** — verified: a marker
 * placed solely in a description returns nothing, and the endpoint carries no
 * description field at all. That was survivable while titles named the code they
 * were about. It stopped being survivable when titles started leading with
 * behaviour instead, because the identifiers a searcher actually types moved into
 * the body.
 *
 * Nothing extra is fetched to do this: `listWorkItems` already returns
 * `description_html`, and the projection that drops it runs at the MCP boundary,
 * not here.
 */

export interface TextHit {
  workItemId: string;
  readableId: string;
  title: string;
  projectId: string;
  /** Which part matched. Callers rank on it; a body-only hit is weaker evidence. */
  where: 'title' | 'body';
  /** Present for body hits: the text around the match, so nobody has to fetch the item to find out why it matched. */
  excerpt?: string;
}

/** Descriptions are HTML. Matching raw would make `<p>` a hit on everything. */
export function plainText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * All terms must appear, in any order and anywhere.
 *
 * Phrase matching would miss "label uuid" against "the label's uuid", which is
 * exactly the near-miss a person types from memory. Requiring every term keeps a
 * two-word query from returning half the board.
 */
const terms = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);

function matches(haystack: string, want: string[]): boolean {
  const hay = haystack.toLowerCase();
  return want.every((t) => hay.includes(t));
}

/** ~140 characters around the first term that hit, so the reason is visible. */
function excerptAround(text: string, want: string[], width = 140): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of want) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, width);

  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Title hits first, then body hits, each keeping the caller's item order.
 *
 * Ranking is the difference between useful and noise: without it an item that
 * mentions the subject in passing outranks the item that *is* the subject.
 */
export function searchItems(
  items: WorkItem[],
  query: string,
  // `projectId` is passed rather than read off the items: a list response omits
  // `project` entirely, so taking it from there would yield undefined for every
  // hit — and the caller had to name the project to get this list at all.
  opts: { projectId: string; projectIdentifier?: string; limit?: number },
): TextHit[] {
  const want = terms(query);
  if (!want.length) return [];

  const titleHits: TextHit[] = [];
  const bodyHits: TextHit[] = [];

  for (const i of items) {
    const readableId = opts.projectIdentifier
      ? `${opts.projectIdentifier}-${i.sequence_id}`
      : `#${i.sequence_id}`;
    const base = { workItemId: i.id, readableId, title: i.name, projectId: opts.projectId };

    if (matches(i.name, want)) {
      titleHits.push({ ...base, where: 'title' });
      continue; // a title hit is the strongest signal; no excerpt adds to it
    }

    const body = plainText(i.description_html);
    if (body && matches(body, want)) {
      bodyHits.push({ ...base, where: 'body', excerpt: excerptAround(body, want) });
    }
  }

  return [...titleHits, ...bodyHits].slice(0, opts.limit ?? 20);
}

/**
 * Merge per-project results, keeping the title-before-body rule across projects.
 *
 * Concatenating each project's already-ranked list would rank by project instead:
 * every body hit from the first project would outrank a title hit from the
 * second, so which project happened to be listed first would decide the answer.
 */
export function rankAcross(groups: TextHit[][], limit = 20): TextHit[] {
  const all = groups.flat();
  return [...all.filter((h) => h.where === 'title'), ...all.filter((h) => h.where === 'body')].slice(
    0,
    limit,
  );
}
