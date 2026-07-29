import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { GatewayError } from './errors.js';
import { heldBy } from './lease.js';

/**
 * What an agent may do with Plane's own tools.
 *
 * The gateway exists to enforce exactly one invariant: at most one agent works an
 * item at a time. Everything else is Plane's business, and Plane already has a
 * permission model — so this policy is deliberately tiny. It guards the lease and
 * nothing else, because a policy that tries to guard everything becomes a second,
 * worse copy of Plane's roles that drifts out of step with the real one.
 *
 * Two things are guarded:
 *
 *  1. `assignees` and `state` on an existing work item. These are the lease's
 *     representation in Plane's UI. An agent that can set them directly can make
 *     an item look claimed without claiming it, or quietly take one that another
 *     agent holds — the exact failure measured in docs/race2.py. So writing them
 *     requires actually holding the lease.
 *
 *  2. Schema-shaped destruction — deleting or re-grouping states, labels, cycles,
 *     modules. Deleting a state is the sharp one: the readiness gate reads state
 *     *groups* to decide what is claimable, so removing one can strand every item
 *     that referenced it. This needs the `destructive` capability, which agents do
 *     not get by default.
 */

/** Fields whose value in Plane *is* the lease. Writing them requires holding it. */
const LEASE_FIELDS = ['assignees', 'state'] as const;

/** Tools that reshape the structures the readiness gate depends on. */
const DESTRUCTIVE = new Set([
  'delete_state',
  'update_state',
  'create_state',
  'delete_label',
  'delete_cycle',
  'delete_module',
  'delete_issue_type',
  'delete_worklog',
  'delete_cycle_issue',
  'delete_module_issue',
]);

export const DESTRUCTIVE_CAPABILITY = 'destructive';

export interface PolicyContext {
  pool: Pool;
  actor: Actor;
}

/**
 * Throws if the call is not permitted. Returns the arguments to actually forward,
 * which may differ from those supplied — see the `update_issue` case.
 */
export async function checkToolCall(
  ctx: PolicyContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (DESTRUCTIVE.has(name) && !ctx.actor.capabilities.includes(DESTRUCTIVE_CAPABILITY)) {
    throw new GatewayError(
      'FORBIDDEN',
      `"${name}" changes structures the readiness gate depends on and needs the "${DESTRUCTIVE_CAPABILITY}" capability`,
      { tool: name },
    );
  }

  if (name !== 'update_issue') return args;

  const data = args['issue_data'];
  if (!data || typeof data !== 'object') return args;

  const touched = LEASE_FIELDS.filter((f) => f in (data as Record<string, unknown>));
  if (touched.length === 0) return args;

  const issueId = typeof args['issue_id'] === 'string' ? args['issue_id'] : undefined;
  if (!issueId) {
    throw new GatewayError('INVALID', 'update_issue requires issue_id', { tool: name });
  }

  const held = await heldBy(ctx.pool, ctx.actor.holder);
  if (held.some((l) => l.workItemId === issueId)) return args;

  throw new GatewayError(
    'NOT_HOLDER',
    `Setting ${touched.join(' and ')} on a work item you do not hold would bypass the lease. ` +
      `Claim it first — claim() sets these for you.`,
    { tool: name, workItemId: issueId, fields: touched },
  );
}
