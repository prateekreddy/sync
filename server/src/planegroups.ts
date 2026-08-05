/**
 * Plane's 47 tools, offered as 10.
 *
 * Plane's MCP server exposes one tool per REST endpoint, which is the right shape
 * for an API and the wrong one for a tool list. Every tool costs context on every
 * request, and the list is what the model reads to work out what it can do — so
 * 47 near-identical CRUD entries crowd out the handful of tools that actually
 * matter and bury `claim` in a wall of `delete_module_issue`. Position in that
 * list is attention.
 *
 * Grouping is by the thing being worked on rather than by the operation, because
 * that is how the question arrives: an agent knows it wants to do something with
 * a cycle before it knows whether that is a create or an update.
 *
 * This is a presentation layer and nothing more. Each grouped call resolves to
 * exactly one upstream tool and is forwarded unchanged, so Plane remains the only
 * thing that validates or executes. The raw names stay callable too — they are
 * simply no longer advertised — which keeps existing scripts working and gives
 * anything this mapping gets wrong an escape hatch that needs no deploy.
 *
 * What is deliberately NOT here: `update_issue` still goes through the same
 * policy check it always did. Resolution happens before that check, so an agent
 * cannot reach a guarded operation by asking for it through a group.
 */

/** One grouped tool: what it is called, and which upstream tool each action means. */
export interface PlaneGroup {
  name: string;
  /** What this group is for, in the agent's terms rather than the API's. */
  summary: string;
  /** action -> upstream tool name. Insertion order is the order shown. */
  actions: Record<string, string>;
}

/**
 * The grouping.
 *
 * Action names are normalised across groups on purpose — `list`, `get`, `create`,
 * `update`, `delete` mean the same thing everywhere — so an agent that has used
 * one group can use the rest without re-reading. Where an operation has no
 * counterpart elsewhere it keeps a name that says what it does.
 */
export const PLANE_GROUPS: PlaneGroup[] = [
  {
    name: 'cycles',
    summary: "Time-boxed iterations. Use to see what is in the current cycle, or to move work between cycles.",
    actions: {
      list: 'list_cycles',
      get: 'get_cycle',
      create: 'create_cycle',
      update: 'update_cycle',
      delete: 'delete_cycle',
      list_issues: 'list_cycle_issues',
      add_issues: 'add_cycle_issues',
      remove_issue: 'delete_cycle_issue',
      transfer_issues: 'transfer_cycle_issues',
    },
  },
  {
    name: 'modules',
    summary: 'Features or workstreams — the epic layer. One flat level; modules do not nest.',
    actions: {
      list: 'list_modules',
      get: 'get_module',
      create: 'create_module',
      update: 'update_module',
      delete: 'delete_module',
      list_issues: 'list_module_issues',
      add_issues: 'add_module_issues',
      remove_issue: 'delete_module_issue',
    },
  },
  {
    name: 'labels',
    summary: 'Cross-cutting dimensions on work items: area, capability, risk.',
    actions: {
      list: 'list_labels',
      get: 'get_label',
      create: 'create_label',
      update: 'update_label',
      delete: 'delete_label',
    },
  },
  {
    name: 'states',
    summary: "A project's workflow columns (Backlog, In Progress, Done) and their groups.",
    actions: {
      list: 'list_states',
      get: 'get_state',
      create: 'create_state',
      update: 'update_state',
      delete: 'delete_state',
    },
  },
  {
    name: 'issue_types',
    summary: "A project's own taxonomy — bug, task, spike. Prefer these over encoding the kind in a title.",
    actions: {
      list: 'list_issue_types',
      get: 'get_issue_type',
      create: 'create_issue_type',
      update: 'update_issue_type',
      delete: 'delete_issue_type',
    },
  },
  {
    name: 'worklogs',
    summary: 'Effort recorded against a work item. The only way anyone learns what this class of work costs.',
    actions: {
      list: 'get_issue_worklogs',
      total: 'get_total_worklogs',
      create: 'create_worklog',
      update: 'update_worklog',
      delete: 'delete_worklog',
    },
  },
  {
    name: 'comments',
    summary: 'The discussion on a work item. Where a human looks to find out what happened and why.',
    actions: {
      list: 'get_issue_comments',
      add: 'add_issue_comment',
    },
  },
  {
    name: 'issues',
    summary:
      'Plane work items directly. For taking work use claim; for writing something down use capture — ' +
      'both do more than these and neither can be replaced by them.',
    actions: {
      list: 'list_project_issues',
      get_by_identifier: 'get_issue_using_readable_identifier',
      create: 'create_issue',
      update: 'update_issue',
    },
  },
  {
    name: 'projects',
    summary: 'Projects in this workspace.',
    actions: {
      list: 'get_projects',
      create: 'create_project',
    },
  },
  {
    name: 'people',
    summary: 'Who you are authenticated as, and who else is in the workspace.',
    actions: {
      me: 'get_user',
      members: 'get_workspace_members',
    },
  },
];

/** Every upstream tool reachable through a group, for checking nothing was dropped. */
export const GROUPED_UPSTREAM: string[] = PLANE_GROUPS.flatMap((g) => Object.values(g.actions));

interface Schema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

const asSchema = (s: unknown): Schema =>
  typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Schema) : {};

/**
 * Resolve a grouped call to the upstream tool it means.
 *
 * Returns null for anything that is not a group, so callers can fall through to
 * the raw name unchanged. An unknown action is an error rather than a fallthrough:
 * silently forwarding it would reach Plane as a missing-tool failure that names
 * something the agent never asked for.
 */
export function resolveGroup(
  name: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | { error: string } | null {
  const group = PLANE_GROUPS.find((g) => g.name === name);
  if (!group) return null;

  const action = args['action'];
  if (typeof action !== 'string' || action === '') {
    return { error: `"${name}" needs an action. One of: ${Object.keys(group.actions).join(', ')}.` };
  }
  const tool = group.actions[action];
  if (!tool) {
    return {
      error:
        `"${name}" has no action "${action}". One of: ${Object.keys(group.actions).join(', ')}.`,
    };
  }
  // `action` chose the tool and is not part of its arguments.
  const { action: _drop, ...rest } = args;
  return { tool, args: rest };
}

/**
 * Build one grouped tool's schema from the schemas of the tools it covers.
 *
 * The properties are the union of every action's properties, because a single
 * JSON Schema cannot say "these fields when action=create, those when
 * action=delete" in a way models reliably read. `action` is the only required
 * field for the same reason: requiring a field that half the actions do not take
 * would make the schema wrong for those.
 *
 * That looseness is paid for in the description, which lists each action with the
 * arguments it actually needs. It is the description models read when choosing
 * arguments, and being explicit there costs a few hundred tokens once against 47
 * tool schemas on every request.
 */
export function groupSchema(group: PlaneGroup, upstream: Map<string, unknown>): unknown {
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: Object.keys(group.actions),
      description: 'Which operation to perform. Required.',
    },
  };

  for (const toolName of Object.values(group.actions)) {
    const schema = asSchema(upstream.get(toolName));
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      // First definition wins: the same field means the same thing across a
      // group's actions, and the earliest action is the most commonly used one.
      if (!(key in properties)) properties[key] = value;
    }
  }

  return { type: 'object', properties, required: ['action'] };
}

/** The per-action argument list that the schema itself cannot express. */
export function groupDescription(group: PlaneGroup, upstream: Map<string, unknown>): string {
  const lines = Object.entries(group.actions).map(([action, toolName]) => {
    const schema = asSchema(upstream.get(toolName));
    const required = schema.required ?? [];
    const optional = Object.keys(schema.properties ?? {}).filter((k) => !required.includes(k));
    const args = [...required, ...optional.map((o) => `${o}?`)].join(', ');
    return `  ${action} — ${args || 'no arguments'}`;
  });

  return (
    `${group.summary}\n\nSet \`action\` to one of these. Required arguments first, ` +
    `optional marked with ?:\n${lines.join('\n')}`
  );
}
