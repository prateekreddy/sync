import { describe, expect, it, vi } from 'vitest';
import { listTools } from '../src/tools.js';
import type { ToolDeps } from '../src/tools.js';
import { NATIVE_TOOLS } from '../src/toolspec.js';

/**
 * MCP 2026-07-28 says servers SHOULD return `tools/list` in a deterministic
 * order, so clients can cache and so the model's prompt cache hits.
 *
 * We already do, and it is worth writing down *why* rather than only that:
 * `NATIVE_TOOLS` is a literal array, and the Plane child registers its tools
 * through a fixed sequence of imperative calls, which the SDK keeps in insertion
 * order. Measured against a real child rather than reasoned about — two cold
 * starts of `@makeplane/plane-mcp-server` 0.1.5 returned the same 47 names in
 * the same order, and that order is registration order, not alphabetical.
 *
 * So this file pins a property that currently holds, against the refactors that
 * would quietly end it: building the catalogue from an object keyed by name,
 * merging with `Promise.all`, or deduplicating through a `Set` and spreading it
 * back out. A reordered list costs nothing visible and invalidates the prompt
 * cache for every agent on their next call.
 */

const spec = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const } });

function deps(upstream: string[]): ToolDeps {
  return {
    app: { log: { warn: vi.fn(), error: vi.fn() } },
    pool: {},
    plane: { tools: async () => upstream.map(spec) },
  } as unknown as ToolDeps;
}

// Deliberately not in registration order and not alphabetical, so a merge that
// happens to sort would fail rather than pass by coincidence.
//
// Names no group claims, on purpose: these tests are about ordering, and a tool
// that gets folded into a group loses its own position by design. Grouping has
// its own file. Using real Plane names here would have made this test measure
// two things and fail for the wrong reason.
const UPSTREAM = ['ungrouped_alpha', 'ungrouped_delta', 'ungrouped_beta', 'ungrouped_charlie'];

describe('the tool catalogue is ordered deterministically', () => {
  it('returns the same sequence across independent builds', async () => {
    // Separate deps each time: the catalogue is cached per PlaneClient, so
    // reusing one would prove only that a cache returns its own array.
    const a = await listTools(deps(UPSTREAM));
    const b = await listTools(deps(UPSTREAM));
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
  });

  it('puts every coordination tool before Plane\'s', async () => {
    // Not incidental. These are the tools an agent needs to take work at all,
    // and position in the list is attention: `claim` buried between
    // `add_cycle_issues` and `create_label` is worse for the model than
    // alphabetical tidiness is good for anyone.
    const names = (await listTools(deps(UPSTREAM))).map((t) => t.name);
    const lastNative = Math.max(...NATIVE_TOOLS.map((t) => names.indexOf(t.name)));
    const firstProxied = Math.min(...UPSTREAM.map((n) => names.indexOf(n)));

    expect(names).toHaveLength(NATIVE_TOOLS.length + UPSTREAM.length);
    expect(lastNative).toBeLessThan(firstProxied);
  });

  it('preserves the order the child gave, rather than sorting it', async () => {
    const names = (await listTools(deps(UPSTREAM))).map((t) => t.name);
    expect(names.filter((n) => UPSTREAM.includes(n))).toEqual(UPSTREAM);
  });

  it('drops a Plane tool that would shadow ours, without disturbing the rest', async () => {
    // The shadow check runs inside the same loop that builds the order, so it is
    // the most likely place for a `continue` to take the wrong entry with it.
    const d = deps(['ungrouped_alpha', 'claim', 'ungrouped_beta']);
    const names = (await listTools(d)).map((t) => t.name);

    expect(names.filter((n) => n === 'claim')).toHaveLength(1);
    expect(names.slice(NATIVE_TOOLS.length)).toEqual(['ungrouped_alpha', 'ungrouped_beta']);
  });

  it('serves the coordination tools alone when the child is unreachable', async () => {
    // Fewer tools is a content change and legitimate; a *reordered* prefix would
    // not be, so check the surviving order rather than only the count.
    const d = {
      app: { log: { warn: vi.fn(), error: vi.fn() } },
      pool: {},
      plane: {
        tools: async () => {
          throw new Error('child will not start');
        },
      },
    } as unknown as ToolDeps;

    const names = (await listTools(d)).map((t) => t.name);
    expect(names).toEqual(NATIVE_TOOLS.map((t) => t.name));
  });
});
