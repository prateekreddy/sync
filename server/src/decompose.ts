import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { capture, type CaptureResult } from './capture.js';
import { GatewayError } from './errors.js';
import type { PlaneClient } from './plane.js';

/**
 * Break an item into sub-items in one call.
 *
 * N separate `capture(parentId:)` calls cost N round trips, but the real problem
 * is what happens between them: a parent stops being claimable the moment its
 * *first* child appears, so a half-written decomposition is indistinguishable
 * from a finished one. Another agent can start work under a tree that is still
 * being built, against a plan that is not all there yet.
 *
 * This is not a transaction — Plane has no multi-item write, and pretending
 * otherwise would be worse than not offering it. What it does buy is that the
 * window shrinks from "however long the agent takes between tool calls" to a few
 * hundred milliseconds, and that a partial failure is *reported* rather than left
 * for the agent to notice.
 *
 * Children are created in order rather than concurrently, deliberately: capture
 * dedups by searching for an existing title, and two identical children racing
 * that search would both miss and both create.
 */

export interface DecomposeChild {
  title: string;
  body: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none' | undefined;
  labels?: string[] | undefined;
  idempotencyKey?: string | undefined;
}

export interface DecomposeResult {
  parentId: string;
  created: CaptureResult[];
  /** Children that could not be created, with the reason. Empty on full success. */
  failed: Array<{ title: string; error: string }>;
  /** True when nothing failed — so a caller can branch without counting. */
  complete: boolean;
}

export async function decompose(
  plane: PlaneClient,
  pool: Pool,
  actor: Actor,
  input: { projectId: string; parentId: string; children: DecomposeChild[] },
): Promise<DecomposeResult> {
  // A parent that does not exist would otherwise produce N children pointing at
  // nothing, each of which Plane accepts, leaving orphans nobody is looking for.
  const parent = await plane.getWorkItem(input.projectId, input.parentId).catch(() => null);
  if (!parent) {
    throw new GatewayError('NOT_FOUND', 'No such parent work item in this project', {
      parentId: input.parentId,
    });
  }

  const created: CaptureResult[] = [];
  const failed: DecomposeResult['failed'] = [];

  for (const child of input.children) {
    try {
      created.push(
        await capture(plane, pool, actor, {
          projectId: input.projectId,
          title: child.title,
          body: child.body,
          parentId: input.parentId,
          ...(child.priority ? { priority: child.priority } : {}),
          ...(child.labels ? { labels: child.labels } : {}),
          ...(child.idempotencyKey ? { idempotencyKey: child.idempotencyKey } : {}),
        }),
      );
    } catch (err) {
      // Carry on rather than aborting. Stopping at the first failure leaves the
      // tree half-built *and* hides which children made it, which is strictly
      // worse than finishing and saying what did not.
      failed.push({
        title: child.title,
        error: err instanceof GatewayError ? `${err.code}: ${err.message}` : String(err),
      });
    }
  }

  return { parentId: input.parentId, created, failed, complete: failed.length === 0 };
}
