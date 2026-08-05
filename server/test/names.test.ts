import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/auth.js';
import { GatewayError } from '../src/errors.js';
import { NameBook, resolveIds, resolveNames } from '../src/names.js';
import type { PlaneClient } from '../src/plane.js';
import { callTool, listTools } from '../src/tools.js';
import type { ToolDeps } from '../src/tools.js';

/**
 * Uuids out, names in.
 *
 * The gateway's own tools have answered in names since view.ts, and Plane's
 * proxied tools answer in uuids -- so `board` and `plane_issues get` disagree
 * about what `state` contains while using the same field name. That is the
 * divergence view.ts exists to prevent, on the half of the surface it does not
 * cover.
 *
 * The tests that matter are the round trip and the refusals. A read that
 * resolves without a write that accepts what it produced is worse than no
 * resolution at all: it shows the agent a value it cannot use. And a name that
 * cannot be resolved must be refused with the alternatives rather than guessed
 * at, because guessing an assignee assigns real work to the wrong person.
 */

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const PROJECT = uuid(1);
const OTHER_PROJECT = uuid(2);
const IN_PROGRESS = uuid(10);
const DONE = uuid(11);
const BACKEND = uuid(20);
const REFINEMENT = uuid(21);
const PRATEEK = uuid(30);
const SAM_ONE = uuid(31);
const SAM_TWO = uuid(32);
const ITEM_42 = uuid(40);
const ITEM_12 = uuid(41);
const STRANGER = uuid(99);

interface Fake {
  states?: unknown;
  labels?: unknown;
  members?: unknown;
  itemSequences?: unknown;
  projectIdentifier?: unknown;
}

/** Counts what was actually fetched, so "one table per request" can be asserted. */
let fetched: string[] = [];

function fakePlane(over: Fake = {}): PlaneClient {
  return {
    states: async (p: string) => {
      fetched.push(`states:${p}`);
      return p === PROJECT
        ? [
            { id: IN_PROGRESS, name: 'In Progress', group: 'started', default: false },
            { id: DONE, name: 'Done', group: 'completed', default: false },
          ]
        : [{ id: uuid(12), name: 'Done', group: 'completed', default: false }];
    },
    labels: async (p: string) => {
      fetched.push(`labels:${p}`);
      return [
        { id: BACKEND, name: 'backend' },
        { id: REFINEMENT, name: 'needs-refinement' },
      ];
    },
    members: async () => {
      fetched.push('members');
      return [
        { id: PRATEEK, name: 'Prateek', email: 'prateek@example.com' },
        // Two people who display the same. The reason ambiguity is refused.
        { id: SAM_ONE, name: 'Sam', email: 'sam@example.com' },
        { id: SAM_TWO, name: 'Sam', email: 'sam.other@example.com' },
      ];
    },
    itemSequences: async (p: string) => {
      fetched.push(`items:${p}`);
      return new Map([
        [ITEM_42, 42],
        [ITEM_12, 12],
      ]);
    },
    projectIdentifier: async () => 'SYNC',
    ...over,
  } as unknown as PlaneClient;
}

const book = (over: Fake = {}) => new NameBook(fakePlane(over));

const ITEM = {
  id: ITEM_42,
  sequence_id: 42,
  name: 'Fix the retry loop',
  project_id: PROJECT,
  state: IN_PROGRESS,
  assignees: [PRATEEK],
  labels: [BACKEND, REFINEMENT],
  parent: ITEM_12,
};

describe('a response an agent can read', () => {
  it('names the state, labels, assignees and parent', async () => {
    const out = (await resolveNames(book(), ITEM, PROJECT)) as Record<string, unknown>;

    expect(out['state']).toBe('In Progress');
    expect(out['labels']).toEqual(['backend', 'needs-refinement']);
    expect(out['assignees']).toEqual(['Prateek']);
    expect(out['parent']).toBe('SYNC-12');
  });

  it('leaves the project id alone', async () => {
    // The one id an agent has to be able to hand back, and the gateway fills it
    // in from the token anyway. Replacing it would cost the multi-project case
    // and buy nothing.
    const out = (await resolveNames(book(), ITEM, PROJECT)) as Record<string, unknown>;
    expect(out['project_id']).toBe(PROJECT);
    expect(out['id']).toBe(ITEM_42);
  });

  it('resolves every row of a paginated listing', async () => {
    const payload = { results: [ITEM, { ...ITEM, id: ITEM_12, state: DONE }], next_cursor: 'x' };
    const out = (await resolveNames(book(), payload, PROJECT)) as {
      results: Array<Record<string, unknown>>;
      next_cursor: string;
    };

    expect(out.results.map((r) => r['state'])).toEqual(['In Progress', 'Done']);
    expect(out.next_cursor).toBe('x');
  });

  it('scopes the lookup to the project each row belongs to', async () => {
    // Two projects each with a "Done" is the ordinary case, not a corner one.
    const rows = [ITEM, { ...ITEM, project_id: OTHER_PROJECT, state: uuid(12) }];
    const out = (await resolveNames(book(), rows, PROJECT)) as Array<Record<string, unknown>>;

    expect(out[0]!['state']).toBe('In Progress');
    expect(out[1]!['state']).toBe('Done');
  });

  it('leaves an id it cannot explain exactly as it arrived', async () => {
    // Never invent and never blank: a uuid we cannot name is still the truth.
    const out = (await resolveNames(book(), { ...ITEM, state: STRANGER }, PROJECT)) as Record<
      string,
      unknown
    >;
    expect(out['state']).toBe(STRANGER);
  });

  it('leaves values that were never ids alone', async () => {
    const out = (await resolveNames(book(), { state: 'In Progress', name: 'x' }, PROJECT)) as Record<
      string,
      unknown
    >;
    expect(out['state']).toBe('In Progress');
    expect(out['name']).toBe('x');
  });

  it('builds each lookup table once however many rows mention it', async () => {
    fetched = [];
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...ITEM, sequence_id: i }));
    await resolveNames(book(), rows, PROJECT);

    expect(fetched.filter((f) => f === `states:${PROJECT}`)).toHaveLength(1);
    expect(fetched.filter((f) => f === 'members')).toHaveLength(1);
  });

  it('returns the raw response rather than failing when Plane will not answer', async () => {
    // Prettifying is worth a request. It is not worth an error on a read that
    // already succeeded.
    const broken = book({
      states: async () => {
        throw new Error('plane 503');
      },
    });
    expect(await resolveNames(broken, ITEM, PROJECT)).toEqual(ITEM);
  });
});

describe('and write back what it read', () => {
  it('takes a state by name', async () => {
    const out = await resolveIds(book(), { state: 'In Progress' }, PROJECT);
    expect(out['state']).toBe(IN_PROGRESS);
  });

  it('reaches the fields Plane nests under issue_data', async () => {
    // update_issue puts every field that matters one level down. A translation
    // that only looked at the top level would silently do nothing on the single
    // most important write.
    const out = await resolveIds(
      book(),
      { issue_id: ITEM_42, issue_data: { state: 'Done', labels: ['backend'] } },
      PROJECT,
    );
    expect(out['issue_data']).toEqual({ state: DONE, labels: [BACKEND] });
  });

  it('takes a person by display name or by email', async () => {
    const byName = await resolveIds(book(), { assignees: ['Prateek'] }, PROJECT);
    const byEmail = await resolveIds(book(), { assignees: ['prateek@example.com'] }, PROJECT);
    expect(byName['assignees']).toEqual([PRATEEK]);
    expect(byEmail['assignees']).toEqual([PRATEEK]);
  });

  it('takes a parent as SYNC-12, #12 or 12', async () => {
    for (const written of ['SYNC-12', '#12', '12', 'sync-12']) {
      const out = await resolveIds(book(), { parent: written }, PROJECT);
      expect(out['parent']).toBe(ITEM_12);
    }
  });

  it('passes a uuid through untouched', async () => {
    // Everything written before this existed keeps working.
    const out = await resolveIds(book(), { state: IN_PROGRESS, parent: ITEM_12 }, PROJECT);
    expect(out['state']).toBe(IN_PROGRESS);
    expect(out['parent']).toBe(ITEM_12);
  });

  it('leaves fields it knows nothing about alone', async () => {
    const out = await resolveIds(book(), { name: 'Done', priority: 'high' }, PROJECT);
    expect(out).toEqual({ name: 'Done', priority: 'high' });
  });

  it('refuses an unknown state and names the ones that exist', async () => {
    const err = await resolveIds(book(), { state: 'Doing' }, PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe('INVALID');
    // The alternatives are the whole point: a refusal that lists them is the
    // answer, one that does not is a second round trip.
    expect((err as GatewayError).message).toContain('In Progress');
    expect((err as GatewayError).message).toContain('state');
  });

  it('refuses an ambiguous person rather than picking one', async () => {
    const err = await resolveIds(book(), { assignees: ['Sam'] }, PROJECT).catch((e: unknown) => e);
    expect((err as GatewayError).code).toBe('INVALID');
    expect((err as GatewayError).message).toContain('sam@example.com');
    expect((err as GatewayError).message).toContain('sam.other@example.com');
  });

  it('does not claim a name is wrong when it could not read the list', async () => {
    // `members()` answers with an empty list when Plane is unreachable, so "no
    // such person" and "we could not check" arrive here identically. Saying the
    // first sends an agent off to fix a name that was right.
    const blind = book({ members: async () => [] });
    const err = await resolveIds(blind, { assignees: ['Prateek'] }, PROJECT).catch(
      (e: unknown) => e,
    );
    expect((err as GatewayError).message).toContain('Could not read');
  });

  it('says how to address a work item it cannot find', async () => {
    const err = await resolveIds(book(), { parent: 'the retry one' }, PROJECT).catch(
      (e: unknown) => e,
    );
    expect((err as GatewayError).message).toContain('SYNC-42');
  });
});

describe('the round trip', () => {
  it('writes back exactly the ids it read', async () => {
    // The property that makes resolution safe rather than a trap. Without it a
    // read hands the agent values its next call cannot use.
    const read = (await resolveNames(book(), ITEM, PROJECT)) as Record<string, unknown>;
    const written = await resolveIds(
      book(),
      {
        state: read['state'],
        labels: read['labels'],
        assignees: read['assignees'],
        parent: read['parent'],
      },
      PROJECT,
    );

    expect(written).toEqual({
      state: ITEM.state,
      labels: ITEM.labels,
      assignees: ITEM.assignees,
      parent: ITEM.parent,
    });
  });
});

// ── through the tool surface, where an agent actually meets it ──────────────

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

function deps(response: unknown, plane: PlaneClient | null = fakePlane()): ToolDeps {
  return {
    app: { log: { warn: vi.fn(), error: vi.fn() } },
    pool: { query: async () => ({ rows: [] }) },
    rest: plane,
    plane: {
      tools: async () => [
        {
          name: 'list_project_issues',
          description: 'x',
          inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } },
        },
        {
          name: 'create_issue',
          description: 'x',
          inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } },
        },
      ],
      call: async (_t: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      },
    },
  } as unknown as ToolDeps;
}

const actor = () =>
  ({
    holder: 'agent:t',
    planeToken: 'plane_pat_test',
    defaultProjectId: PROJECT,
    capabilities: [],
  }) as unknown as Actor;

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe('what an agent sees at the tool boundary', () => {
  it('hands back names on a proxied read', async () => {
    const out = await callTool(deps(ITEM), actor(), 'Bearer t', 'plane_issues', {
      action: 'list',
      project_id: PROJECT,
    });
    expect(body(out as never)['state']).toBe('In Progress');
    expect(body(out as never)['labels']).toEqual(['backend', 'needs-refinement']);
  });

  it('sends ids upstream when the agent wrote names', async () => {
    calls.length = 0;
    await callTool(deps(ITEM), actor(), 'Bearer t', 'plane_issues', {
      action: 'create',
      project_id: PROJECT,
      state: 'Done',
      labels: ['backend'],
    });
    expect(calls[0]!.args['state']).toBe(DONE);
    expect(calls[0]!.args['labels']).toEqual([BACKEND]);
  });

  it('resolves the field a caller narrowed to', async () => {
    // Resolution runs before projection for this reason: it changes values
    // rather than adding keys, so narrowing must not cut it off.
    const out = await callTool(deps(ITEM), actor(), 'Bearer t', 'plane_issues', {
      action: 'list',
      project_id: PROJECT,
      fields: ['state'],
    });
    expect(body(out as never)).toEqual({ state: 'In Progress' });
  });

  it('gives the raw ids back under verbose', async () => {
    const out = await callTool(deps(ITEM), actor(), 'Bearer t', 'plane_issues', {
      action: 'list',
      project_id: PROJECT,
      verbose: true,
    });
    expect(body(out as never)['state']).toBe(IN_PROGRESS);
  });

  it('says so on the fields themselves, including the nested ones', async () => {
    // A tool that quietly accepts names is half a feature: the model keeps
    // making the lookup call it always made. update_issue nests the fields that
    // matter, so a hint that only reached the top level would miss the write
    // this is most useful on.
    const d = {
      ...deps(ITEM),
      plane: {
        tools: async () => [
          {
            name: 'update_issue',
            description: 'x',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string' },
                issue_data: {
                  type: 'object',
                  properties: { state: { type: 'string', description: 'The state.' } },
                },
              },
            },
          },
        ],
        call: async () => ({ content: [] }),
      },
    } as unknown as ToolDeps;

    const tools = await listTools(d);
    const issues = tools.find((t) => t.name === 'plane_issues')!;
    const schema = issues.inputSchema as {
      properties: { issue_data: { properties: { state: { description: string } } } };
    };
    expect(schema.properties.issue_data.properties.state.description).toContain('In Progress');
  });

  it('still forwards ids when there is no REST client to resolve with', async () => {
    calls.length = 0;
    const out = await callTool(deps(ITEM, null), actor(), 'Bearer t', 'plane_issues', {
      action: 'list',
      project_id: PROJECT,
    });
    expect(body(out as never)['state']).toBe(IN_PROGRESS);
  });
});
