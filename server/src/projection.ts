import type { ToolResult } from './tools.js';

/**
 * Trim proxied Plane responses to what an agent reads.
 *
 * The gateway can afford API calls and CPU; the agent pays for every returned byte
 * in the one resource that runs out. Plane's list endpoints return 29 fields per
 * work item — measured at 888 chars each against ~150 an agent uses to choose work
 * — so a 300-item board is most of a context window spent on a list.
 *
 * This runs at the MCP boundary, deliberately, NOT inside PlaneClient. The
 * readiness gate and the mirror consume the same payloads internally and screen on
 * fields no agent reads (`is_draft`, `state`, `parent`). Trimming at the source
 * would starve them, and the failure would be silent — the same shape as the label
 * bug, where a gate looked correct and matched nothing.
 *
 * Denylist rather than allowlist: an unrecognised field survives. Dropping the
 * wrong thing is invisible to us and confusing to an agent, while keeping one
 * extra field costs a few bytes.
 */

/** Plumbing on every Plane entity. Nothing chooses or decides on these. */
const ALWAYS_DROP = new Set([
  'created_at',
  'updated_at',
  'deleted_at',
  'created_by',
  'updated_by',
  'archived_at',
  'workspace',
  'external_source',
  'external_id',
  'sort_order',
  'view_props',
  'logo_props',
  'description_binary',
  'description_text',
  'is_triage',
  'slug',
  'sub_grouped_by',
  'grouped_by',
]);

/**
 * Kept on a single read, dropped from lists.
 *
 * Descriptions are the bulk of a work item and the reason a board listing is
 * expensive. You do not read thirty-four descriptions to pick one — you read
 * titles, then fetch the item you chose.
 */
const DROP_IN_LISTS = new Set(['description_html', 'description']);

/** Pagination fields an agent cannot act on. `next_cursor` is kept; the rest are not. */
const ENVELOPE_DROP = new Set([
  'prev_cursor',
  'prev_page_results',
  'total_pages',
  'extra_stats',
  'grouped_by',
  'sub_grouped_by',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function trim(item: unknown, inList: boolean): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (ALWAYS_DROP.has(k)) continue;
    if (inList && DROP_IN_LISTS.has(k)) continue;
    // Plane returns nulls for most optional fields on most items; they carry no
    // more information than the key being absent, and there are a lot of them.
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Project a parsed Plane payload.
 *
 * Three shapes reach here: a paginated envelope with `results`, a bare array, and
 * a single object. Only the first two are treated as lists — a single read is
 * where a caller most plausibly wants the field we would otherwise drop.
 */
export function projectPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => trim(v, true));

  if (isRecord(value) && Array.isArray(value['results'])) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (ENVELOPE_DROP.has(k)) continue;
      if (k === 'results') {
        out[k] = (v as unknown[]).map((r) => trim(r, true));
        continue;
      }
      if (v === null) continue;
      out[k] = v;
    }
    return out;
  }

  return trim(value, false);
}

/**
 * Project an upstream MCP tool result in place.
 *
 * Plane's MCP server returns JSON as text inside a content block. Anything that
 * does not parse is passed through untouched — a human-readable message must not
 * be mangled by a transformation meant for data.
 */
export function projectToolResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result['content'])) return result;

  const content = (result['content'] as unknown[]).map((block) => {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') {
      return block;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block['text']);
    } catch {
      return block;
    }
    // Compact, not pretty-printed. Indenting a 34-item array adds back much of
    // what the trimming saved, and whitespace is tokens like anything else.
    return { ...block, text: JSON.stringify(projectPayload(parsed)) };
  });

  return { ...result, content } as ToolResult;
}
