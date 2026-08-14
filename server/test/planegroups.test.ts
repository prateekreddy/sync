import { describe, expect, it, vi } from 'vitest';
import { callTool, listTools } from '../src/tools.js';
import type { ToolDeps } from '../src/tools.js';
import type { Actor } from '../src/auth.js';
import { GROUPED_UPSTREAM, PLANE_GROUPS, groupSchema, resolveGroup } from '../src/planegroups.js';
import { NATIVE_TOOLS } from '../src/toolspec.js';

/**
 * Plane's 47 tools, offered as 10.
 *
 * One tool per REST endpoint is the right shape for an API and the wrong one for
 * a tool list. Every entry costs context on every request, and the list is what
 * the model reads to decide what it can do -- so 47 near-identical CRUD entries
 * crowd out the handful that matter and bury `claim` among them.
 *
 * The risk of a mapping layer is that it silently loses something, so the checks
 * that matter here are coverage (every upstream tool still reachable), fidelity
 * (a grouped call arrives as the call it stood for) and that the lease guard is
 * not something a group can route around.
 */

/** The real upstream surface of @makeplane/plane-mcp-server 0.1.5. */
const UPSTREAM_47 = [
  'add_cycle_issues', 'add_issue_comment', 'add_module_issues', 'create_cycle',
  'create_issue', 'create_issue_type', 'create_label', 'create_module',
  'create_project', 'create_state', 'create_worklog', 'delete_cycle',
  'delete_cycle_issue', 'delete_issue_type', 'delete_label', 'delete_module',
  'delete_module_issue', 'delete_state', 'delete_worklog', 'get_cycle',
  'get_issue_comments', 'get_issue_type', 'get_issue_using_readable_identifier',
  'get_issue_worklogs', 'get_label', 'get_module', 'get_projects', 'get_state',
  'get_total_worklogs', 'get_user', 'get_workspace_members', 'list_cycle_issues',
  'list_cycles', 'list_issue_types', 'list_labels', 'list_module_issues',
  'list_modules', 'list_project_issues', 'list_states', 'transfer_cycle_issues',
  'update_cycle', 'update_issue', 'update_issue_type', 'update_label',
  'update_module', 'update_state', 'update_worklog',
];

const spec = (name: string) => ({
  name,
  description: name,
  inputSchema: {
    type: 'object' as const,
    properties: { project_id: { type: 'string' }, issue_id: { type: 'string' } },
    required: ['project_id'],
  },
});

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

function deps(upstream: string[] = UPSTREAM_47, held: string[] = []): ToolDeps {
  return {
    app: { log: { warn: vi.fn(), error: vi.fn() } },
    pool: {
      query: async () => ({
        rows: held.map((id) => ({
          work_item_id: id,
          project_id: 'p',
          holder: 'agent:t',
          holder_chain: [],
          epoch: 1,
          state: 'held',
          claimed_at: new Date(),
          expires_at: new Date(Date.now() + 60000),
          heartbeat_at: new Date(),
        })),
      }),
    },
    plane: {
      tools: async () => upstream.map(spec),
      call: async (_token: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: '{}' }] };
      },
    },
  } as unknown as ToolDeps;
}

const actor = (capabilities: string[] = []): Actor =>
  ({
    holder: 'agent:t',
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: 'u1',
    defaultProjectId: 'default-project',
    capabilities,
  }) as unknown as Actor;

const call = (name: string, args: Record<string, unknown>, d = deps()) =>
  callTool(d, actor(), 'Bearer t', name, args);

describe('nothing is lost in the grouping', () => {
  it('covers every upstream tool exactly once', () => {
    // The failure this prevents is silent: a tool left out of the table is simply
    // absent from the list, and nothing reports it.
    expect([...GROUPED_UPSTREAM].sort()).toEqual([...UPSTREAM_47].sort());
    expect(new Set(GROUPED_UPSTREAM).size).toBe(GROUPED_UPSTREAM.length);
  });

  it('turns 47 tools into 10', async () => {
    const names = (await listTools(deps())).map((t) => t.name);
    const proxied = names.filter((n) => !NATIVE_TOOLS.some((t) => t.name === n));
    expect(proxied).toHaveLength(10);
    expect(proxied).toEqual(PLANE_GROUPS.map((g) => g.name));
  });

  it('still puts every coordination tool first', async () => {
    // Position in the list is attention, and these are the tools an agent needs
    // in order to take work at all.
    const names = (await listTools(deps())).map((t) => t.name);
    const lastNative = Math.max(...NATIVE_TOOLS.map((t) => names.indexOf(t.name)));
    const firstProxied = Math.min(...PLANE_GROUPS.map((g) => names.indexOf(g.name)));
    expect(lastNative).toBeLessThan(firstProxied);
  });

  it('lists an upstream tool no group claims, rather than hiding it', async () => {
    // A Plane release that adds a tool should be reachable that day, not on the
    // day someone remembers to extend the table.
    const names = (await listTools(deps([...UPSTREAM_47, 'brand_new_tool']))).map((t) => t.name);
    expect(names).toContain('brand_new_tool');
  });

  it('only advertises actions this Plane actually serves', async () => {
    // Offering an action that 404s is worse than never mentioning it.
    const trimmed = UPSTREAM_47.filter((n) => n !== 'delete_cycle');
    const tools = await listTools(deps(trimmed));
    const cycles = tools.find((t) => t.name === 'plane_cycles')!;
    const actions = (cycles.inputSchema as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions).not.toContain('delete');
    expect(actions).toContain('create');
  });

  it('drops a whole group when this Plane serves none of it', async () => {
    const noWorklogs = UPSTREAM_47.filter((n) => !n.includes('worklog'));
    const names = (await listTools(deps(noWorklogs))).map((t) => t.name);
    expect(names).not.toContain('plane_worklogs');
    expect(names).toContain('plane_cycles');
  });
});

describe('resolving a grouped call', () => {
  it('maps an action to the tool it stands for', () => {
    expect(resolveGroup('plane_cycles', { action: 'create', name: 'Sprint 1' })).toEqual({
      tool: 'create_cycle',
      args: { name: 'Sprint 1' },
    });
  });

  it('does not forward `action` as an argument', () => {
    // It chose the tool; upstream would reject it as an unknown property.
    const out = resolveGroup('plane_labels', { action: 'list', project_id: 'p' });
    expect(out).toEqual({ tool: 'list_labels', args: { project_id: 'p' } });
  });

  it('returns null for a name that is not a group', () => {
    expect(resolveGroup('update_issue', { issue_id: 'x' })).toBeNull();
  });

  it('names the valid actions when given one that does not exist', () => {
    const out = resolveGroup('plane_labels', { action: 'archive' }) as { error: string };
    expect(out.error).toMatch(/no action "archive"/);
    expect(out.error).toMatch(/list, get, create, update, delete/);
  });

  it('asks for an action when none was given', () => {
    const out = resolveGroup('plane_labels', {}) as { error: string };
    expect(out.error).toMatch(/needs an action/);
  });
});

describe('a grouped call reaches the right tool', () => {
  it('forwards to the upstream tool the action named', async () => {
    calls.length = 0;
    await call('plane_cycles', { action: 'list', project_id: 'p1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('list_cycles');
  });

  it('still accepts the raw upstream name, so nothing that worked stops working', async () => {
    calls.length = 0;
    await call('list_cycles', { project_id: 'p1' });
    expect(calls[0]!.tool).toBe('list_cycles');
  });

  it('fills in the agent\'s project from the resolved tool, not the group', async () => {
    // A group's schema is the union of its actions. Defaulting from that union
    // would hand a project to an action that never asked for one, and upstream
    // rejects the call for a field it does not know.
    calls.length = 0;
    await call('plane_cycles', { action: 'list' });
    expect(calls[0]!.args['project_id']).toBe('default-project');
  });

  it('refuses an unknown action without troubling Plane', async () => {
    calls.length = 0;
    const out = await call('plane_cycles', { action: 'nope' });
    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('a group is not a way around the lease', () => {
  it('refuses to set assignees through the group on an item you do not hold', async () => {
    // The guard keys on the upstream name, and grouping resolves before it runs.
    // Had resolution happened after, `issues` would have been an unguarded alias
    // for the one tool that must never be unguarded.
    calls.length = 0;
    await expect(
      call('plane_issues', {
        action: 'update',
        issue_id: 'not-mine',
        issue_data: { assignees: ['someone'] },
      }),
    ).rejects.toMatchObject({ code: 'NOT_HOLDER' });
    expect(calls).toHaveLength(0);
  });

  it('allows the same edit on an item you do hold', async () => {
    calls.length = 0;
    await call(
      'plane_issues',
      { action: 'update', issue_id: 'mine', issue_data: { assignees: ['me'] } },
      deps(UPSTREAM_47, ['mine']),
    );
    expect(calls[0]!.tool).toBe('update_issue');
  });

  it('leaves a harmless edit alone', async () => {
    calls.length = 0;
    await call('plane_issues', { action: 'update', issue_id: 'any', issue_data: { name: 'retitled' } });
    expect(calls[0]!.tool).toBe('update_issue');
  });

  it('keeps the destructive-capability check on a grouped delete', async () => {
    calls.length = 0;
    await expect(call('plane_states', { action: 'delete', state_id: 's1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('what the model is told about a group', () => {
  it('lists each action with the arguments it needs', async () => {
    // The schema cannot say "these fields when action=create"; the description
    // has to, or the union of properties is a guessing game.
    const tools = await listTools(deps());
    const cycles = tools.find((t) => t.name === 'plane_cycles')!;
    expect(cycles.description).toMatch(/create — /);
    expect(cycles.description).toMatch(/project_id/);
  });

  it('requires the action and nothing else', async () => {
    const tools = await listTools(deps());
    const schema = tools.find((t) => t.name === 'plane_labels')!.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['action']);
    expect(schema.properties).toHaveProperty('project_id');
  });

  it('keeps the projection escape hatch on every group', async () => {
    const tools = await listTools(deps());
    for (const g of PLANE_GROUPS) {
      const schema = tools.find((t) => t.name === g.name)!.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties).toHaveProperty('fields');
      expect(schema.properties).toHaveProperty('verbose');
    }
  });

  it('says which actions each field belongs to', async () => {
    // A union of properties with only `action` required is otherwise a guessing
    // game: the model can see `issue_id` exists but not that `create` ignores it.
    // Anthropic's tool guidance warns against exactly this — a schema loose
    // enough to be a free-form blob — and the answer belongs on the field, where
    // the model is already looking when it fills it in.
    // Schemas that differ per action, as Plane's really do — the shared fixture
    // gives every tool the same one, which would make "every action" trivially
    // true and prove nothing.
    const varied = {
      app: { log: { warn: vi.fn(), error: vi.fn() } },
      pool: {},
      plane: {
        tools: async () => [
          {
            name: 'list_cycles',
            description: 'l',
            inputSchema: {
              type: 'object',
              properties: { project_id: { type: 'string' } },
              required: ['project_id'],
            },
          },
          {
            name: 'delete_cycle',
            description: 'd',
            inputSchema: {
              type: 'object',
              properties: { project_id: { type: 'string' }, cycle_id: { type: 'string' } },
              required: ['project_id', 'cycle_id'],
            },
          },
        ],
      },
    } as unknown as ToolDeps;

    const tools = await listTools(varied);
    const schema = tools.find((t) => t.name === 'plane_cycles')!.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    // Shared by both actions, and required by both.
    expect(schema.properties['project_id']!.description).toMatch(/required by every action/i);
    // Belongs to one action only, and the field says which.
    expect(schema.properties['cycle_id']!.description).toMatch(/delete/);
    expect(schema.properties['cycle_id']!.description).not.toMatch(/every action/);
  });

  it('does not make update require the fields only create needs', async () => {
    // The bug this replaces destroyed data. Every `*_data` argument in Plane's
    // API is an object whose requirements differ per action: `create_issue` is
    // `IssueSchema.partial().required({name, description_html})` while
    // `update_issue` is a bare `.partial()` that sends a PATCH. Merging the union
    // first-definition-wins handed `update` the CREATE object, so the schema said
    // an agent must supply `name` and `description_html` to change a priority.
    //
    // A model that believes that supplies them, and having nothing to say puts a
    // placeholder in `description_html`. SLATE-948 lost ten lines of scope to the
    // word "keep" on 2026-08-13. Nothing refused the call.
    const upstream = new Map<string, unknown>([
      [
        'create_issue',
        {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            issue_data: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description_html: { type: 'string' },
                priority: {},
              },
              required: ['description_html', 'name'],
            },
          },
          required: ['project_id', 'issue_data'],
        },
      ],
      [
        'update_issue',
        {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            issue_id: { type: 'string' },
            issue_data: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description_html: { type: 'string' },
                state: { type: 'string' },
              },
            },
          },
          required: ['project_id', 'issue_id', 'issue_data'],
        },
      ],
    ]);

    const group = PLANE_GROUPS.find((g) => g.name === 'plane_issues')!;
    const schema = groupSchema({ ...group, actions: { create: 'create_issue', update: 'update_issue' } }, upstream) as {
      properties: Record<string, { required?: string[]; properties?: Record<string, { description?: string }> }>;
    };
    const data = schema.properties['issue_data']!;

    expect(data.required ?? []).toEqual([]);
    // Still says who needs it, on the field itself — the requirement is real for
    // create, it just cannot be stated as a requirement of the union.
    expect(data.properties!['description_html']!.description).toMatch(/required by create/i);
    expect(data.properties!['description_html']!.description).toMatch(/unchanged/i);
    // And the union is still a union: a field only `update` takes survives.
    expect(data.properties).toHaveProperty('state');
  });

  it('keeps a nested field required when every action requires it', () => {
    // The other direction. Dropping `required` unconditionally would be just as
    // wrong, and would make the check above pass for a merge that says nothing.
    const both = {
      type: 'object',
      properties: {
        thing_data: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      required: ['thing_data'],
    };
    const schema = groupSchema(
      { name: 'x', summary: 's', actions: { create: 'a', update: 'b' } },
      new Map<string, unknown>([
        ['a', both],
        ['b', both],
      ]),
    ) as { properties: Record<string, { required?: string[] }> };

    expect(schema.properties['thing_data']!.required).toEqual(['name']);
  });

  it('warns in plain words that update is a patch', async () => {
    // The schema fix removes the reason a model sends a description it did not
    // mean to. This is the part that covers a model deciding to anyway.
    const tools = await listTools(deps());
    const issues = tools.find((t) => t.name === 'plane_issues')!;
    expect(issues.description).toMatch(/update is a patch/i);
    expect(issues.description).toMatch(/description_html/);
  });

  it('marks Plane\'s half with a prefix, because the two halves are not alike', async () => {
    // These do not understand the lease and the coordination tools do. The
    // mistake that costs something is reaching for plane_issues/update instead of
    // complete, so the warning belongs in the name, at the moment of choosing.
    const names = (await listTools(deps())).map((t) => t.name);
    const proxied = names.filter((n) => !NATIVE_TOOLS.some((t) => t.name === n));
    expect(proxied.every((n) => n.startsWith('plane_'))).toBe(true);
    expect(NATIVE_TOOLS.every((t) => !t.name.startsWith('plane_'))).toBe(true);
  });

  it('points the agent back at claim and capture from the tool it might misuse', async () => {
    const tools = await listTools(deps());
    const issues = tools.find((t) => t.name === 'plane_issues')!;
    expect(issues.description).toMatch(/claim/);
    expect(issues.description).toMatch(/capture/);
  });

  it('never lets a group shadow a coordination tool', async () => {
    // Nothing may take the name of the only safe way to claim work.
    const groupNames = PLANE_GROUPS.map((g) => g.name);
    const nativeNames = NATIVE_TOOLS.map((t) => t.name);
    expect(groupNames.filter((n) => nativeNames.includes(n))).toEqual([]);
  });
});
