import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import {
  forgetAssignment,
  nameOf,
  principalPlaneUser,
  recordAssignment,
} from './assignment.js';
import { GatewayError } from './errors.js';
import { UNVERIFIED_LABEL } from './evidence.js';
import { resolveLabels } from './labels.js';
import { log } from './log.js';
import type { PlaneClient } from './plane.js';

/**
 * Reflects lease state into Plane so humans watching a board see what agents are
 * doing.
 *
 * Best-effort everywhere except one place. For completion and return the lease
 * row is the commit point: if a mirror write fails the lease still stands and the
 * write is queued on the row for `drain.ts` to retry. There is deliberately no
 * distributed transaction between the gateway and Plane -- the gateway is
 * authoritative for *who holds what*, Plane for *what it is*.
 *
 * "Queued" is now literal. It used to mean `mirrored = false`, which recorded
 * that a write was owed but not what it was, so nothing could replay it and
 * nothing did -- the sentence above was true of the intent and false of the
 * code for months.
 *
 * `mirrorClaim` is the exception, and it earns it. A claim exists to tell people
 * the work is taken; a claim that Plane never heard about is a lease held where
 * nobody can see it, so the board offers the item to the next agent and two of
 * them do the same work. That is the failure this project exists to prevent, so
 * the claim waits for Plane and is given back if Plane will not take it.
 *
 * The cost is honest: claiming is now as available as Plane is. That is the right
 * trade only for claim, and only for the write that makes the claim *visible* --
 * the comment that follows is still best-effort, because losing the annotation
 * costs a note while losing the assignment costs duplicated work.
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
/**
 * The Plane write a lease still owes, in a form that survives a restart.
 *
 * Only what cannot be read back off the lease row: the outcome text, whether the
 * item closes, the labels, and enough of the actor to attribute a comment. The
 * agent's Plane token is deliberately absent — it is a credential, this is a
 * database column, and a retry running as the service account is a small loss of
 * byline against a large one of storing tokens we do not need to store.
 */
export type MirrorIntent =
  | {
      kind: 'complete';
      projectId: string;
      outcome: string;
      close: boolean;
      labels?: string[];
      actor: PortableActor;
    }
  | {
      kind: 'return';
      projectId: string;
      reason: string;
      holder: string;
      expiryCount?: number;
    };

export interface PortableActor {
  holder: string;
  principal: string;
  planeUserId: string | null;
}

const portable = (a: Actor): PortableActor => ({
  holder: a.holder,
  principal: a.principal,
  planeUserId: a.planeUserId ?? null,
});

/**
 * Record the debt before attempting it.
 *
 * The counter and the backoff are initialised only when there was no debt
 * already. The drain replays by calling these same functions, so resetting
 * unconditionally would clear the attempt count on every retry — the row would
 * always look new, always be due, and be retried forever. The bound would exist
 * and never once fire.
 */
async function owe(pool: Pool, workItemId: string, intent: MirrorIntent): Promise<void> {
  await pool.query(
    `update lease
        set pending_mirror  = $2::jsonb,
            mirror_attempts = case when pending_mirror is null then 0 else mirror_attempts end,
            mirror_after    = case when pending_mirror is null then now() else mirror_after end
      where work_item_id = $1`,
    [workItemId, JSON.stringify(intent)],
  );
}

/** Clear it, once Plane has actually accepted the write. */
async function settled(pool: Pool, workItemId: string): Promise<void> {
  await pool.query(
    `update lease
        set mirrored       = true,
            pending_mirror = null,
            mirror_after   = null
      where work_item_id = $1`,
    [workItemId],
  );
}

const chains = new Map<string, Promise<void>>();

function serial(workItemId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(workItemId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // a failed predecessor must not block the rest
  chains.set(workItemId, next);
  void next
    .finally(() => {
      // Only the tail clears the entry, or a slow early write would drop a chain
      // that later calls are still queued behind.
      if (chains.get(workItemId) === next) chains.delete(workItemId);
    })
    // The cleanup is a second branch off `next`, so a rejection travels down it
    // as well as to the caller. Nobody is listening on this one, and since
    // `mirrorClaim` began throwing to trigger a rollback that surfaces as an
    // unhandled rejection -- which newer Node treats as fatal. The caller still
    // gets the error through the returned promise; this only silences the copy.
    .catch(() => {});
  return next;
}

/**
 * Which Plane account each agent writes as, by the agent's Plane user id.
 *
 * Cached for the process: it cannot change without the token being re-minted, and
 * the alternative is a `/users/me/` request on every mirror write.
 */
const writerEmail = new Map<string, string>();

/**
 * Is the account Plane will show as the author already the human this agent acts
 * for?
 *
 * Self-service minting hands an agent its owner's own Plane token, so Plane's
 * byline and the principal are the same person — the case this exists to detect.
 * A provisioned agent with its own Plane account is the opposite: Plane shows
 * `sync-worker-3` and only the gateway knows who that is working for.
 */
async function writerIsPrincipal(plane: PlaneClient, actor: Actor): Promise<boolean> {
  if (!actor.planeToken || !actor.planeUserId) return false;

  const principal = actor.principal.startsWith('human:')
    ? actor.principal.slice('human:'.length).trim().toLowerCase()
    : '';
  // A principal recorded as a bare name ('human:prateek') is not something we can
  // match against a Plane account, so it stays printed.
  if (!principal.includes('@')) return false;

  let mine = writerEmail.get(actor.planeUserId);
  if (mine === undefined) {
    try {
      mine = (await plane.as(actor.planeToken).me()).email.trim().toLowerCase();
    } catch {
      // Unresolvable: keep printing it. Redundant provenance is noise; missing
      // provenance loses the only record of who a machine write was made for.
      return false;
    }
    writerEmail.set(actor.planeUserId, mine);
  }
  return mine !== '' && mine === principal;
}

/**
 * Plane renders the author of every comment itself, so the only provenance worth
 * adding is what Plane cannot know: which human an agent account acts for.
 */
export async function actorNote(plane: PlaneClient, actor: Actor, body: string): Promise<string> {
  // No token of its own: the comment lands as the service account, so both halves
  // are invisible to Plane and both have to be said.
  if (!actor.planeToken) {
    return `<p>${body}</p><p><em>by ${actor.holder} — for ${actor.principal}</em></p>`;
  }
  if (await writerIsPrincipal(plane, actor)) return `<p>${body}</p>`;
  return `<p>${body}</p><p><em>for ${actor.principal}</em></p>`;
}

export async function mirrorClaim(
  plane: PlaneClient,
  pool: Pool,
  args: {
    projectId: string;
    workItemId: string;
    actor: Actor;
    epoch: number;
    expiresAt: Date;
    /**
     * Set when a human approved taking this item off its assignee.
     *
     * The item then moves to *them* rather than to the agent executing it: taking
     * work off someone was their decision, and the board should name the person
     * who made it. Falls back to the agent when the principal is not a Plane user
     * we can resolve — an unresolvable approver is a reason to record the takeover
     * differently, not to leave the item on the person it was taken from.
     */
    takeover?: { takenFrom: string | null } | undefined;
  },
): Promise<void> {
  return serial(args.workItemId, async () => {
    // Already reflected, so there is nothing to do and a second comment would be
    // noise on an item a human reads. This covers a re-sent claim, and also two
    // copies of one arriving together: the serial chain makes the second wait for
    // the first, and it then finds the work done.
    const { rows } = await pool.query<{ mirrored: boolean }>(
      'select mirrored from lease where work_item_id = $1 and epoch = $2',
      [args.workItemId, args.epoch],
    );
    if (rows[0]?.mirrored) return;

    // `members` is best-effort by contract and returns empty rather than throwing.
    const members = args.takeover ? await plane.members() : [];
    const assignee = args.takeover
      ? (principalPlaneUser(args.actor, members) ?? args.actor.planeUserId)
      : args.actor.planeUserId;

    // ── the visible fact ────────────────────────────────────────────────────
    // The only part allowed to fail the claim. If this does not land, the board
    // shows the item as free while an agent works it, which is precisely the
    // collision this project exists to prevent — better to hand the lease back
    // and say so than to hold work nobody can see.
    try {
      const started = await plane.stateByGroup(args.projectId, 'started');
      await plane.updateWorkItem(args.projectId, args.workItemId, {
        ...(started ? { state: started.id } : {}),
        ...(assignee ? { assignees: [assignee] } : {}),
      });
    } catch (err) {
      log.warn({ err, workItemId: args.workItemId, op: 'claim' }, 'plane mirror failed');
      throw new GatewayError(
        'UPSTREAM',
        'Plane would not accept the claim, so the lease was handed back rather than held where nobody can see it.',
        { workItemId: args.workItemId },
      );
    }

    // ── past the commit point ───────────────────────────────────────────────
    // Nothing below may throw. The claim is now visible in Plane, so failing the
    // request here would roll back a lease while leaving the item showing as
    // assigned and started — the inconsistency this whole change is removing,
    // with the two halves swapped.
    try {
      // Recorded only after Plane accepted the write, and recorded at all so the
      // gate can later tell this name from one a person put there. Without it,
      // every item any agent has ever claimed reads as assigned-by-a-human — see
      // assignment.ts.
      if (assignee) await recordAssignment(pool, args.workItemId, assignee, args.epoch);
      await pool.query('update lease set mirrored = true where work_item_id = $1', [args.workItemId]);
      await plane.comment(
        args.projectId,
        args.workItemId,
        await actorNote(
          plane,
          args.actor,
          `Claimed (epoch ${args.epoch}). Lease expires ${args.expiresAt.toISOString()}.` +
            // Said on the item, not just in a transcript: the person it was taken
            // from is the one who most needs to know, and they are not in the
            // conversation where it was agreed.
            (args.takeover
              ? ` Taken over from ${nameOf(members, args.takeover.takenFrom)}, approved by ${args.actor.principal}.`
              : ''),
        ),
      );
    } catch (err) {
      // The claim stands and is visible; only the annotation is missing.
      log.warn({ err, workItemId: args.workItemId, op: 'claim' }, 'plane claim note failed');
    }
  });
}

export async function mirrorComplete(
  plane: PlaneClient,
  pool: Pool,
  args: {
    projectId: string;
    workItemId: string;
    actor: Actor;
    outcome: string;
    close: boolean;
    /**
     * Labels to add to the item, by name.
     *
     * A list rather than the `unverified` boolean this replaced: there are two
     * distinct ways a completion falls short — cited nothing, and cited something
     * that does not exist — and a second boolean would have been the point at
     * which the shape was clearly wrong. The caller names what it means.
     */
    labels?: string[];
  },
): Promise<void> {
  return serial(args.workItemId, async () => {
    // Recorded before the attempt, cleared after it succeeds — the ordinary
    // outbox order. A crash in between costs a repeat rather than a loss, and
    // these writes are idempotent, so a repeat is harmless. The other order
    // loses the write entirely, which is the bug this exists to end.
    await owe(pool, args.workItemId, {
      kind: 'complete',
      projectId: args.projectId,
      outcome: args.outcome,
      close: args.close,
      ...(args.labels?.length ? { labels: args.labels } : {}),
      actor: portable(args.actor),
    });
    try {
      // The assignee goes whether or not the item closes, and it is one write
      // with the state rather than two. An assignee means "somebody is on this",
      // and once the work is reported finished nobody is — leaving the name
      // behind is what made every completed item read as assigned-to-a-human,
      // which under the SYNC-70 rule would withhold it forever.
      const done = args.close ? await plane.stateByGroup(args.projectId, 'completed') : undefined;
      await plane.updateWorkItem(args.projectId, args.workItemId, {
        ...(done ? { state: done.id } : {}),
        assignees: [],
      });
      await forgetAssignment(pool, args.workItemId);
      await plane.comment(
        args.projectId,
        args.workItemId,
        await actorNote(plane, args.actor, args.outcome),
      );

      // Labelled rather than refused: the completion is real, it simply falls
      // short of proving itself, and a board that shows which is which is worth
      // more than one that blocks the agent. Best-effort like every mirror write.
      if (args.labels?.length) {
        try {
          // Read-modify-write, because Plane's `labels` is a replacement, not an
          // append: writing the one label we care about would silently strip
          // every label the item already carried, including load-bearing ones.
          const [ids, current] = await Promise.all([
            resolveLabels(plane, args.projectId, args.labels),
            plane.getWorkItem(args.projectId, args.workItemId),
          ]);
          const merged = [...new Set([...(current.labels ?? []), ...ids])];
          if (merged.length !== (current.labels ?? []).length) {
            await plane.updateWorkItem(args.projectId, args.workItemId, { labels: merged });
          }
        } catch (err) {
          log.warn({ err, workItemId: args.workItemId, labels: args.labels }, 'labelling failed');
        }
      }
      await settled(pool, args.workItemId);
    } catch (err) {
      // Deliberately not rethrown and deliberately not cleared: the debt stays on
      // the row and the drain will try again. Before this, the warning below was
      // the entire response to a failed completion mirror, and the board kept
      // showing finished work as in progress until a human noticed.
      log.warn({ err, workItemId: args.workItemId, op: 'complete' }, 'plane mirror failed, queued');
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
    await owe(pool, args.workItemId, {
      kind: 'return',
      projectId: args.projectId,
      reason: args.reason,
      holder: args.holder,
      ...(args.expiryCount === undefined ? {} : { expiryCount: args.expiryCount }),
    });
    try {
      const todo = await plane.stateByGroup(args.projectId, 'unstarted');
      await plane.updateWorkItem(args.projectId, args.workItemId, {
        ...(todo ? { state: todo.id } : {}),
        assignees: [],
      });
      // After the clear, never before: dropping the record first would turn a
      // failed clear into a name the gate no longer recognises as ours, which it
      // would then honour as a human's and withhold the item indefinitely.
      await forgetAssignment(pool, args.workItemId);

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
      await settled(pool, args.workItemId);
    } catch (err) {
      // Left owed on purpose. This is the path a dead agent's item takes, so a
      // failure here is exactly when nobody is watching.
      log.warn({ err, workItemId: args.workItemId, op: 'return' }, 'plane mirror failed, queued');
    }
  });
}
