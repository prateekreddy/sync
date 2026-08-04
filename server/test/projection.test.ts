import { describe, expect, it } from 'vitest';
import {
  keysIn,
  projectPayload,
  projectToolResult,
  unmatchedFields,
} from '../src/projection.js';

/**
 * Measured on a real 34-item board: 888 chars per work item, against roughly 150
 * an agent uses to choose one. Projection is what stops a board listing from
 * costing a context window — but only the MCP boundary may do it, because the
 * readiness gate screens on fields (`is_draft`, `state`, `parent`) that no agent
 * ever reads.
 */
const workItem = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  sequence_id: 7,
  name: 'Do the thing',
  description_html: '<p>'.padEnd(400, 'x') + '</p>',
  priority: 'high',
  state: 's1',
  labels: ['l1'],
  parent: null,
  is_draft: false,
  assignees: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'u1',
  updated_by: null,
  workspace: 'w1',
  sort_order: 65535,
  external_id: null,
  ...over,
});

describe('projecting a list', () => {
  it('keeps what an agent chooses work with', () => {
    const [got] = projectPayload([workItem()]) as Array<Record<string, unknown>>;
    expect(Object.keys(got ?? {}).sort()).toEqual([
      // Since SYNC-70: an agent that is refused an item for being assigned to
      // someone else can see that from the listing, rather than only from the
      // refusal. The reason string names the person; this carries the raw ids.
      'assignees',
      'id',
      'is_draft',
      'labels',
      'name',
      'priority',
      'sequence_id',
      'state',
    ]);
  });

  it('drops descriptions from lists — you read titles to pick, then fetch one', () => {
    const [got] = projectPayload([workItem()]) as Array<Record<string, unknown>>;
    expect(got).not.toHaveProperty('description_html');
  });

  it('keeps the description on a single read', () => {
    // The one place a caller plausibly wants it, and the place it costs least.
    const got = projectPayload(workItem()) as Record<string, unknown>;
    expect(got).toHaveProperty('description_html');
  });

  it('handles Plane\'s paginated envelope and keeps the cursor', () => {
    const got = projectPayload({
      results: [workItem()],
      total_count: 1,
      count: 1,
      next_cursor: 'c2',
      next_page_results: true,
      prev_cursor: 'c0',
      total_pages: 1,
      extra_stats: null,
      grouped_by: null,
    }) as Record<string, unknown>;

    expect(got['next_cursor']).toBe('c2'); // an agent can act on this
    expect(got).not.toHaveProperty('prev_cursor'); // it cannot act on these
    expect(got).not.toHaveProperty('total_pages');
    expect((got['results'] as unknown[]).length).toBe(1);
  });

  it('keeps a field it has never seen, rather than guessing it is noise', () => {
    // Denylist on purpose: dropping the wrong field is invisible to us and
    // baffling to an agent, while keeping a spare one costs a few bytes.
    const [got] = projectPayload([workItem({ some_new_plane_field: 'value' })]) as Array<
      Record<string, unknown>
    >;
    expect(got?.['some_new_plane_field']).toBe('value');
  });

  it('actually shrinks the payload', () => {
    const list = Array.from({ length: 34 }, (_, i) => workItem({ id: `i${i}` }));
    const before = JSON.stringify(list).length;
    const after = JSON.stringify(projectPayload(list)).length;
    expect(after).toBeLessThan(before / 2);
  });
});

describe('an explicit field list', () => {
  it('returns exactly the named keys, and nothing else', () => {
    const [got] = projectPayload([workItem()], ['id', 'name']) as Array<Record<string, unknown>>;
    expect(Object.keys(got ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('returns a field the default would have dropped', () => {
    // The whole point: needing one omitted field should not cost all 29.
    const [got] = projectPayload([workItem()], ['id', 'description_html', 'created_at']) as Array<
      Record<string, unknown>
    >;
    expect(got).toHaveProperty('description_html');
    expect(got).toHaveProperty('created_at');
  });

  it('keeps the envelope so a filtered answer is not mistaken for an empty one', () => {
    const got = projectPayload(
      { results: [workItem()], total_count: 1, count: 1, next_cursor: 'c2' },
      ['id'],
    ) as Record<string, unknown>;
    expect(got['total_count']).toBe(1);
    expect(got['next_cursor']).toBe('c2');
    expect(Object.keys((got['results'] as Array<Record<string, unknown>>)[0] ?? {})).toEqual(['id']);
  });

  it('silently omits a name Plane never sent, rather than inventing a key', () => {
    const [got] = projectPayload([workItem()], ['id', 'no_such_field']) as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(got ?? {})).toEqual(['id']);
  });

  it('falls back to the default when the list is empty', () => {
    const [got] = projectPayload([workItem()], []) as Array<Record<string, unknown>>;
    expect(got).not.toHaveProperty('created_at');
    expect(got).toHaveProperty('priority');
  });
});

describe('projecting an MCP tool result', () => {
  const wrap = (body: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(body) }],
  });

  it('rewrites the JSON inside the text block', () => {
    const out = projectToolResult(wrap({ results: [workItem()] })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(out.content[0]?.text ?? '{}');
    expect(parsed.results[0]).not.toHaveProperty('created_at');
    expect(parsed.results[0].name).toBe('Do the thing');
  });

  it('leaves a non-JSON message exactly as it was', () => {
    // Plane's tools return human-readable errors this way. Mangling one with a
    // transformation meant for data would turn a clear failure into a confusing one.
    const msg = { content: [{ type: 'text', text: 'Project not found' }] };
    expect(projectToolResult(msg)).toEqual(msg);
  });

  it('threads a field list into the text block', () => {
    const out = projectToolResult(wrap({ results: [workItem()] }), ['id', 'description_html']) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(out.content[0]?.text ?? '{}');
    expect(Object.keys(parsed.results[0]).sort()).toEqual(['description_html', 'id']);
  });

  it('passes through anything that is not a tool result', () => {
    expect(projectToolResult({ isError: true })).toEqual({ isError: true });
    expect(projectToolResult(null)).toBeNull();
  });

  it('leaves image and other block types alone', () => {
    const mixed = { content: [{ type: 'image', data: 'abc' }] };
    expect(projectToolResult(mixed)).toEqual(mixed);
  });
});

/**
 * A field list can only narrow what upstream already sent. Until this existed,
 * asking for a field the tool does not return produced a clean object silently
 * missing it — indistinguishable from Plane not having the data, which is the
 * conclusion an agent would eventually draw and act on.
 */
describe('naming a field the tool does not send', () => {
  const wrap = (body: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(body) }],
  });

  it('says so rather than returning quietly short', () => {
    // `description_html` would be the wrong example here: it *is* in the payload,
    // and naming it explicitly correctly overrides the list drop. The failure
    // this catches is a name nothing upstream ever sends.
    const out = projectToolResult(wrap({ results: [workItem()] }), ['id', 'target_date']) as {
      content: Array<{ type: string; text: string }>;
    };

    const note = out.content.at(-1)!.text;
    expect(note).toContain('target_date');
    expect(note).not.toContain(' id,');
    expect(note).toContain('fetch the single item instead');
  });

  it('stays silent when every requested field was available', () => {
    const out = projectToolResult(wrap({ results: [workItem()] }), ['id', 'name']) as {
      content: unknown[];
    };
    expect(out.content).toHaveLength(1);
  });

  it('stays silent when nothing was requested', () => {
    const out = projectToolResult(wrap({ results: [workItem()] })) as { content: unknown[] };
    expect(out.content).toHaveLength(1);
  });

  it('does not accuse an empty result of missing fields', () => {
    // Zero rows tells us nothing about which fields the tool sends. Warning here
    // would fire on every empty listing and train agents to ignore the note.
    const out = projectToolResult(wrap({ results: [] }), ['id', 'no_such_field']) as {
      content: unknown[];
    };
    expect(out.content).toHaveLength(1);
  });

  it('reports a field absent from a single-item read too', () => {
    const out = projectToolResult(wrap(workItem()), ['id', 'nope']) as {
      content: Array<{ text: string }>;
    };
    expect(out.content.at(-1)!.text).toContain('nope');
  });

  it('still returns the data it could supply', () => {
    const out = projectToolResult(wrap({ results: [workItem()] }), ['id', 'nope']) as {
      content: Array<{ text: string }>;
    };
    // A note, not an error: the caller gets what exists and is told what does not.
    const parsed = JSON.parse(out.content[0]!.text) as { results: Array<Record<string, unknown>> };
    expect(Object.keys(parsed.results[0]!)).toEqual(['id']);
  });

  it('reports each missing field once across several content blocks', () => {
    const two = {
      content: [
        { type: 'text', text: JSON.stringify({ results: [workItem()] }) },
        { type: 'text', text: JSON.stringify({ results: [workItem()] }) },
      ],
    };
    const out = projectToolResult(two, ['nope']) as { content: Array<{ text: string }> };
    expect(out.content).toHaveLength(3);
    expect(out.content.at(-1)!.text.match(/nope/g)).toHaveLength(1);
  });
});

describe('what keys a payload actually carried', () => {
  it('reads them off a list, an envelope and a single object alike', () => {
    for (const shape of [
      [workItem()],
      { results: [workItem()] },
      workItem(),
    ]) {
      expect(keysIn(shape).has('name'), JSON.stringify(shape).slice(0, 30)).toBe(true);
    }
  });

  it('is empty for a payload with no items', () => {
    expect(keysIn({ results: [] }).size).toBe(0);
    expect(unmatchedFields({ results: [] }, ['id'])).toEqual([]);
  });
});
