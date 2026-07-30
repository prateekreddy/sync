import type { ToolResult } from './tools.js';

/**
 * Trim proxied Plane responses to what an agent reads.
 *
 * The gateway can afford API calls and CPU; the agent pays for every returned byte
 * in the one resource that runs out.
 *
 * Measured, and not what was first assumed: `@makeplane/plane-mcp-server` already
 * projects, so `list_project_issues` hands back **7 fields**, not the 29 Plane's
 * REST API returns. (The 29-field payload is what the gateway itself fetches, and
 * that is trimmed separately by `PlaneClient.LIST_FIELDS`.) So the 48% this saves
 * end to end is mostly **compact JSON instead of pretty-printing** — the first cut
 * indented its output and gave back 5,121 of the chars it had just saved.
 *
 * The consequence for callers is the one worth knowing: a field list can only
 * narrow what upstream sent, never widen it. Asking for `description_html` on a
 * listing returns nothing, because that tool never sends it — use a single-item
 * read instead.
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

/**
 * What the default projection removes, exported so the tool description can name
 * it. A caller who cannot tell "Plane did not send this" from "the gateway
 * removed it" will eventually conclude the data is missing upstream.
 */
export const droppedByDefault = (): { always: string[]; inLists: string[] } => ({
  always: [...ALWAYS_DROP].sort(),
  inLists: [...DROP_IN_LISTS].sort(),
});

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

function trim(item: unknown, inList: boolean, want?: Set<string>): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    // An explicitly named field is never dropped, whatever the defaults say. A
    // projection that silently ignores half the request is worse than none: the
    // caller cannot tell "Plane did not send it" from "we removed it".
    if (want) {
      if (want.has(k)) out[k] = v;
      continue;
    }
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
export function projectPayload(value: unknown, fields?: string[]): unknown {
  const want = fields?.length ? new Set(fields) : undefined;

  if (Array.isArray(value)) return value.map((v) => trim(v, true, want));

  if (isRecord(value) && Array.isArray(value['results'])) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (ENVELOPE_DROP.has(k)) continue;
      if (k === 'results') {
        out[k] = (v as unknown[]).map((r) => trim(r, true, want));
        continue;
      }
      if (v === null) continue;
      out[k] = v;
    }
    return out;
  }

  return trim(value, false, want);
}

/**
 * Every key the payload actually carried.
 *
 * A field list can only narrow what upstream sent, so a name that appears in
 * neither this set nor the response is a name the caller will never receive —
 * and until now that was silent. Asking for `descrition_html` returned a clean
 * object missing the field, indistinguishable from Plane not having it.
 *
 * A separate walk rather than a second return value or an out-parameter from
 * `projectPayload`: each function then means exactly one thing, and the extra
 * pass over an array we are about to JSON-stringify anyway costs nothing worth
 * measuring.
 */
export function keysIn(value: unknown): Set<string> {
  const keys = new Set<string>();
  const add = (v: unknown) => {
    if (isRecord(v)) for (const k of Object.keys(v)) keys.add(k);
  };

  if (Array.isArray(value)) value.forEach(add);
  else if (isRecord(value) && Array.isArray(value['results'])) value['results'].forEach(add);
  else add(value);

  return keys;
}

/**
 * Requested names this response could never satisfy.
 *
 * Empty when nothing was asked for, and — deliberately — empty when the response
 * carried no items at all: a zero-result listing tells us nothing about which
 * fields the tool sends, and reporting every requested name there would be noise
 * that trains agents to ignore the warning.
 */
export function unmatchedFields(value: unknown, fields?: string[]): string[] {
  if (!fields?.length) return [];
  const present = keysIn(value);
  if (present.size === 0) return [];
  return fields.filter((f) => !present.has(f));
}

/**
 * Project an upstream MCP tool result in place.
 *
 * Plane's MCP server returns JSON as text inside a content block. Anything that
 * does not parse is passed through untouched — a human-readable message must not
 * be mangled by a transformation meant for data.
 *
 * A field the response cannot supply is reported alongside the data rather than
 * swallowed. It is a note, not an error: a caller listing fields across mixed row
 * types is being reasonable, and failing the call would punish that.
 */
export function projectToolResult(result: unknown, fields?: string[]): unknown {
  if (!isRecord(result) || !Array.isArray(result['content'])) return result;

  const unmatched = new Set<string>();

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
    for (const f of unmatchedFields(parsed, fields)) unmatched.add(f);
    // Compact, not pretty-printed. Indenting a 34-item array adds back much of
    // what the trimming saved, and whitespace is tokens like anything else.
    return { ...block, text: JSON.stringify(projectPayload(parsed, fields)) };
  });

  if (unmatched.size > 0) {
    content.push({
      type: 'text',
      text:
        `Note: this tool does not return ${[...unmatched].join(', ')}, so ${unmatched.size === 1 ? 'that field was' : 'those fields were'} not included. ` +
        'A field list narrows what the tool already sends and cannot add to it — for something a listing omits entirely, such as a description, fetch the single item instead.',
    });
  }

  return { ...result, content } as ToolResult;
}
