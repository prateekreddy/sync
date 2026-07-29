import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { log } from './log.js';
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

/**
 * Mirror writes for one work item, run strictly in order.
 *
 * Every mirror call is fired and forgotten so an agent never waits on Plane. That
 * is right, but it means two mirrors for the same item are in flight at once
 * whenever an agent claims and finishes quickly — and each is several requests
 * long (look up a state, PATCH it, post a comment). If the claim's PATCH lands
 * after the completion's, Plane is left showing "In Progress" for an item that is
 * done, and it stays that way: nothing ever recomputes it.
 *
 * That is not cosmetic. The readiness gate answers "is this blocker finished?"
 * and "does this parent still have open children?" by reading Plane, so a lost
 * completion strands every item downstream of it.
 *
 * Chaining per item costs nothing — the common case has an empty chain — and
 * makes the last call win, which is the only ordering that can be correct.
 *
 * Scope: one gateway process. Two replicas would need Plane-side conditional
 * writes, which Plane does not offer; the lease table remains the source of
 * truth either way, so the failure would stay confined to the display.
 */
const chains = new Map<string, Promise<void>>();

function serial(workItemId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(workItemId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // a failed predecessor must not block the rest
  chains.set(workItemId, next);
  void next.finally(() => {
    // Only the tail clears the entry, or a slow early write would drop a chain
    // that later calls are still queued behind.
    if (chains.get(workItemId) === next) chains.delete(workItemId);
  });
  return next;
}

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
  return serial(args.workItemId, async () => {
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
    } catch (err) {
      // Never fail the claim over this: the agent already legitimately holds the
      // item. But say so — a mirror that fails silently leaves the board showing
      // work as unclaimed while an agent is busy on it.
      log.warn({ err, workItemId: args.workItemId, op: 'claim' }, 'plane mirror failed');
    }
  });
}

export async function mirrorComplete(
  plane: PlaneClient,
  pool: Pool,
  args: { projectId: string; workItemId: string; actor: Actor; outcome: string; close: boolean },
): Promise<void> {
  return serial(args.workItemId, async () => {
    try {
      if (args.close) {
        const done = await plane.stateByGroup(args.projectId, 'completed');
        if (done) await plane.updateWorkItem(args.projectId, args.workItemId, { state: done.id });
      }
      await plane.comment(args.projectId, args.workItemId, actorNote(args.actor, args.outcome));
      await pool.query('update lease set mirrored = true where work_item_id = $1', [args.workItemId]);
    } catch (err) {
      log.warn({ err, workItemId: args.workItemId, op: 'complete' }, 'plane mirror failed');
    }
  });
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
  return serial(args.workItemId, async () => {
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
    } catch (err) {
      log.warn({ err, workItemId: args.workItemId, op: 'return' }, 'plane mirror failed');
    }
  });
}
