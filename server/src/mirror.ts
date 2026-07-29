import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import type { PlaneClient } from './plane.js';

/**
 * Reflects lease state into Plane so humans watching a board see what agents are
 * doing.
 *
 * Explicitly best-effort. The lease row is the commit point; if a mirror write
 * fails, the lease still stands and `mirrored = false` leaves it on the sweeper's
 * retry queue. There is deliberately no distributed transaction between the
 * gateway and Plane -- the gateway is authoritative for *who holds what*, Plane
 * for *what it is*, and the mirror only has to be fast enough for a human to
 * watch.
 */

function actorNote(actor: Actor, body: string): string {
  // When the agent has its own Plane token, Plane already attributes the comment
  // to it natively — repeating "by agent:x" would be noise. What Plane still does
  // not know is the principal chain: which human this agent ultimately acts for.
  const provenance = actor.planeToken
    ? `<p><em>for ${actor.principal}</em></p>`
    : `<p><em>by ${actor.holder} — for ${actor.principal}</em></p>`;
  return `<p>${body}</p>${provenance}`;
}

export async function mirrorClaim(
  plane: PlaneClient,
  pool: Pool,
  args: { projectId: string; workItemId: string; actor: Actor; epoch: number; expiresAt: Date },
): Promise<void> {
  try {
    const started = await plane.stateByGroup(args.projectId, 'started');
    await plane.updateWorkItem(args.projectId, args.workItemId, {
      ...(started ? { state: started.id } : {}),
      ...(args.actor.planeUserId ? { assignees: [args.actor.planeUserId] } : {}),
    });
    await plane.comment(
      args.projectId,
      args.workItemId,
      actorNote(
        args.actor,
        `Claimed (epoch ${args.epoch}). Lease expires ${args.expiresAt.toISOString()}.`,
      ),
    );
    await pool.query('update lease set mirrored = true where work_item_id = $1', [args.workItemId]);
  } catch {
    // Left for the sweeper's retry queue. Never fail the claim over this: the
    // agent already legitimately holds the item.
  }
}

export async function mirrorComplete(
  plane: PlaneClient,
  pool: Pool,
  args: { projectId: string; workItemId: string; actor: Actor; outcome: string; close: boolean },
): Promise<void> {
  try {
    if (args.close) {
      const done = await plane.stateByGroup(args.projectId, 'completed');
      if (done) await plane.updateWorkItem(args.projectId, args.workItemId, { state: done.id });
    }
    await plane.comment(args.projectId, args.workItemId, actorNote(args.actor, args.outcome));
    await pool.query('update lease set mirrored = true where work_item_id = $1', [args.workItemId]);
  } catch {
    /* retried by the sweeper */
  }
}

/**
 * Return an item to the pool in Plane's UI.
 *
 * Always comments — a lease that lapsed because an agent died is exactly the kind
 * of event that is invisible and expensive if it happens silently.
 */
export async function mirrorReturn(
  plane: PlaneClient,
  pool: Pool,
  args: {
    projectId: string;
    workItemId: string;
    reason: string;
    holder: string;
    expiryCount?: number;
  },
): Promise<void> {
  try {
    const todo = await plane.stateByGroup(args.projectId, 'unstarted');
    await plane.updateWorkItem(args.projectId, args.workItemId, {
      ...(todo ? { state: todo.id } : {}),
      assignees: [],
    });

    const repeat =
      args.expiryCount && args.expiryCount >= 3
        ? `<p><strong>This item has now expired ${args.expiryCount} times.</strong> ` +
          `Repeated expiry usually means it is underspecified or not actually doable — worth a human look.</p>`
        : '';

    await plane.comment(
      args.projectId,
      args.workItemId,
      `<p>Returned to the pool: ${args.reason} (was held by ${args.holder}).</p>${repeat}`,
    );
    await pool.query('update lease set mirrored = true where work_item_id = $1', [args.workItemId]);
  } catch {
    /* retried by the sweeper */
  }
}
