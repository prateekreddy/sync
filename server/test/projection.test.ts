import { describe, expect, it } from 'vitest';
import { projectPayload, projectToolResult } from '../src/projection.js';

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

  it('passes through anything that is not a tool result', () => {
    expect(projectToolResult({ isError: true })).toEqual({ isError: true });
    expect(projectToolResult(null)).toBeNull();
  });

  it('leaves image and other block types alone', () => {
    const mixed = { content: [{ type: 'image', data: 'abc' }] };
    expect(projectToolResult(mixed)).toEqual(mixed);
  });
});
