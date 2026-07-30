import { z } from 'zod';

/**
 * The gateway's own tools, defined once.
 *
 * Each entry is both the HTTP contract and the MCP tool description. Keeping them
 * in one place is the point: the agent-facing surface now lives entirely on the
 * server, so adding a tool or rewording a description reaches every agent box on
 * the next gateway deploy, with nothing to reinstall. That is only true while
 * there is a single definition — two copies would drift within a week.
 */

const uuid = z.string().uuid();

export const DEFAULT_TTL = 600;
export const MAX_TTL = 3600;

export const CaptureBody = z.object({
  projectId: uuid,
  title: z.string().min(3).max(255).describe('One line. What needs doing.'),
  body: z
    .string()
    .min(1)
    .describe(
      'Enough for another agent to act without you: what, where, and how anyone would know it is done.',
    ),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  labels: z
    .array(z.string())
    .optional()
    .describe(
      'Label names, e.g. ["backend"]. Created in the project if they do not exist yet. ' +
        'Four names are load-bearing — needs-human, needs-refinement, blocked, wontfix ' +
        'make an item unclaimable — so a name one character away from those is refused ' +
        'rather than created.',
    ),
  discoveredFrom: uuid.optional().describe('Work item you were on when you noticed this.'),
  parentId: uuid
    .optional()
    .describe(
      'Makes this a sub-item of that work item. Use for real decomposition, not for "related": ' +
        'a parent with unfinished sub-items stops being claimable, so nobody will pick it up ' +
        'until every child is done.',
    ),
  idempotencyKey: z.string().max(200).optional().describe('Pass a stable key if you may retry.'),
});

export const NextQuery = z.object({
  projectId: uuid,
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const ClaimBody = z.object({
  projectId: uuid,
  workItemId: uuid.optional().describe('Omit to let the gateway pick the best ready item.'),
  ttlSeconds: z.number().int().min(30).max(MAX_TTL).default(DEFAULT_TTL),
  spawnedBy: z.array(z.string()).optional(),
});

export const Held = z.object({
  workItemId: uuid,
  epoch: z.number().int().positive().describe('From the lease you were given. Proves it is still yours.'),
});

export const HeartbeatBody = Held.extend({
  ttlSeconds: z.number().int().min(30).max(MAX_TTL).default(DEFAULT_TTL),
});

export const ReleaseBody = Held.extend({
  reason: z.string().max(500).default('released by agent'),
});

export const CompleteBody = Held.extend({
  outcome: z.string().min(1).max(2000).describe('What you did, and the evidence. Links to a PR or commit belong here.'),
  close: z.boolean().default(true),
});

export const LinkBody = z.object({
  projectId: uuid,
  workItemId: uuid,
  // Plane's own vocabulary — 'blocking', not 'blocks'. Anything else is silently
  // accepted by the serializer and then ignored.
  relation: z.enum(['blocking', 'blocked_by', 'duplicate', 'relates_to']),
  targets: z.array(uuid).min(1).max(20),
});

export const HeldQuery = z.object({});

export interface NativeTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Which project field, if any, should be defaulted from the agent's config. */
  method: 'GET' | 'POST';
  /** Builds the HTTP request this tool is a synonym for. */
  request: (args: Record<string, unknown>) => { path: string; body?: unknown };
}

const q = (path: string, args: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
};

/**
 * Every tool is a synonym for an HTTP endpoint that already exists. Tool calls are
 * dispatched back through the gateway's own router rather than into a parallel set
 * of handlers, so the MCP surface and the REST surface cannot disagree about what
 * `claim` means.
 */
export const NATIVE_TOOLS: NativeTool[] = [
  {
    name: 'capture',
    title: 'Write down a task',
    description:
      'Record a task, bug, or idea in the tracker. Use this the MOMENT you notice something ' +
      'worth doing — before deciding whether to do it now. Safe to call freely: near-duplicates ' +
      'are merged into the existing item rather than creating a second one, and passing the same ' +
      'idempotencyKey twice returns the original instead of duplicating. If you noticed this ' +
      'while working another item, pass that item as discoveredFrom. To break a large item into ' +
      'sub-items, call capture once per child with parentId set to the large item.',
    schema: CaptureBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/capture', body: a }),
  },
  {
    name: 'next',
    title: 'See available work',
    description:
      'List work that is ready and not held by another agent. Read-only — it does NOT reserve ' +
      'anything, so two agents calling this will see the same items. To actually take work, call ' +
      'claim. Items missing a description, blocked by unfinished work, or with unfinished ' +
      'sub-items are withheld on purpose.',
    schema: NextQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/next', a) }),
  },
  {
    name: 'claim',
    title: 'Take a piece of work',
    description:
      'Atomically take exclusive ownership of a work item, and return the lease. This is the ' +
      'ONLY way to start work: assigning yourself in Plane does not reserve anything and two ' +
      'agents doing it will both believe they own the item. Omit workItemId to let the gateway ' +
      'pick the best ready item in one step — calling next and then claim is a race. The lease ' +
      'expires; keep it alive with heartbeat, and end it with complete or release.',
    schema: ClaimBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/claim', body: a }),
  },
  {
    name: 'heartbeat',
    title: 'Keep your claim alive',
    description:
      'Extend the lease on an item you hold. Call this periodically during long work — if the ' +
      'lease lapses the item returns to the pool and another agent may take it.',
    schema: HeartbeatBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/heartbeat', body: a }),
  },
  {
    name: 'release',
    title: 'Give work back',
    description:
      'Hand an item back to the pool without finishing it. Prefer this over going silent: it ' +
      'returns the work immediately instead of after the lease expires, and records why.',
    schema: ReleaseBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/release', body: a }),
  },
  {
    name: 'complete',
    title: 'Finish work',
    description:
      'Report an item finished, record the outcome in Plane, and end the lease. Put the evidence ' +
      'in outcome — a PR link, a commit, what you verified.',
    schema: CompleteBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/complete', body: a }),
  },
  {
    name: 'link',
    title: 'Relate two work items',
    description:
      'Create a typed relation between work items. blocked_by is load-bearing: an item with an ' +
      'unfinished blocker cannot be claimed, so use it to stop other agents starting work that ' +
      'cannot succeed yet.',
    schema: LinkBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/link', body: a }),
  },
  {
    name: 'held',
    title: 'What am I holding?',
    description:
      'List the leases you currently hold. Call this after a restart to find out what you were ' +
      'in the middle of before deciding to claim anything new.',
    schema: HeldQuery,
    method: 'GET',
    request: () => ({ path: '/v1/held' }),
  },
];

/** Args that should default to the agent's configured project when omitted. */
export const PROJECT_DEFAULTED = new Set(['capture', 'next', 'claim', 'link']);
