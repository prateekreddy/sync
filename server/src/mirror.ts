import type { Pool } from './db.js';
import type { Actor } from './auth.js';
import { nameOf, principalPlaneUser } from './assignment.js';
import { GatewayError } from './errors.js';
import { UNVERIFIED_LABEL } from './evidence.js';
import { resolveLabels } from './labels.js';
import { log } from './log.js';
import type { PlaneClient } from './plane.js';
import { rollUp } from './rollup.js';
import { serial } from './serial.js';

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
    }
  | {
      /**
       * Put back a claim Plane has lost.
       *
       * Raised by reconciliation rather than by an agent: the lease is live and
       * says this item is being worked, and Plane no longer shows it. Nothing was
       * owed — the original write is recorded as having landed — so no retry
       * would ever have fixed it. See reconcile.ts.
       *
       * Carries the assignee outright instead of an actor. The agent that made
       * the claim is not on this call and may be hours gone; what the board needs
       * is the name the lease already implies.
       */
      kind: 'reclaim';
      projectId: string;
      holder: string;
      planeUserId: string | null;
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
  // A principal recorded as a bare name ('human:alice') is not something we can
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

    // ── what we are about to overwrite ──────────────────────────────────────
    // Read before the write below replaces it, so `mirrorReturn` can put the item
    // back exactly as it was found rather than clearing it to nobody. A name in
    // Plane can be a human's — assignment there needs no lease and predates this
    // gateway — and erasing it on release discarded state we did not create.
    //
    // Best-effort, and outside the block that may fail the claim: not knowing the
    // previous assignees is a reason to fall back to the old clearing behaviour,
    // not to refuse work. Written on every claim including the failure case,
    // because a value left over from an earlier claim of the same item would be
    // restored later as if it were current.
    let prior: string[] | null = null;
    try {
      prior = (await plane.getWorkItem(args.projectId, args.workItemId)).assignees ?? null;
    } catch (err) {
      log.warn({ err, workItemId: args.workItemId, op: 'claim' }, 'prior assignees unreadable');
    }
    await pool.query('update lease set prior_assignees = $2 where work_item_id = $1 and epoch = $3', [
      args.workItemId,
      prior,
      args.epoch,
    ]);

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
      // Marked only after Plane accepted the write. This flag is also what tells
      // the assignment gate that the name now on the item is ours rather than a
      // person's — see assignment.ts.
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

    // Deliberately not awaited: `claim` waits for this whole function, and an
    // item having a parent is not a reason for the agent that claimed it to wait
    // longer. The rollup is best-effort by design and says so in rollup.ts.
    void rollUp(plane, args.projectId, args.workItemId).catch(() => {});
  }, pool);
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
      // Whether the name stays is decided by whether the item actually lands in a
      // completed state — not by whether the caller asked to close it.
      //
      // An assignee means two different things depending on where the item sits.
      // On an open item it means "somebody is on this", and the SYNC-70 rule
      // withholds it from everyone else; leaving a name on a finished-but-open
      // item withholds it forever. On a closed one it means "this is who did it",
      // which is the only record of authorship the board has — and `screen()`
      // withholds anything outside backlog/unstarted regardless of assignee, so
      // keeping it costs nothing there. reconcile.ts already assumes this: its
      // "lease ended, still In Progress" rule exists precisely because a
      // completed item is expected to keep a name on it.
      //
      // Keyed on `done` rather than on `args.close` because those come apart: a
      // project with no completed state group leaves the item OPEN after a close,
      // and an open item must not keep a name it did not start with. An item that
      // stays open goes back to the assignees it had before the claim, exactly as
      // `mirrorReturn` does — same reason, same rule.
      const done = args.close ? await plane.stateByGroup(args.projectId, 'completed') : undefined;
      await plane.updateWorkItem(args.projectId, args.workItemId, {
        ...(done
          ? { state: done.id }
          : { assignees: await priorAssignees(pool, args.workItemId) }),
      });
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

      // Only when the item actually closed. A completion that leaves the item
      // open changed no state a container could be derived from, so nudging
      // would be a project listing spent to decide nothing. The claim path has
      // no such test because a claim always moves the item to `started`.
      if (args.close) void rollUp(plane, args.projectId, args.workItemId).catch(() => {});
    } catch (err) {
      // Deliberately not rethrown and deliberately not cleared: the debt stays on
      // the row and the drain will try again. Before this, the warning below was
      // the entire response to a failed completion mirror, and the board kept
      // showing finished work as in progress until a human noticed.
      log.warn({ err, workItemId: args.workItemId, op: 'complete' }, 'plane mirror failed, queued');
    }
  }, pool);
}

/**
 * The assignees this item had before the current lease claimed it.
 *
 * Empty when we never recorded any, which covers both "it was unassigned" and
 * "the pre-read failed" — see the migration note in 015_prior_assignees.sql for
 * why those collapse to the same safe answer rather than to "leave it alone".
 */
async function priorAssignees(pool: Pool, workItemId: string): Promise<string[]> {
  const { rows } = await pool.query<{ prior_assignees: string[] | null }>(
    'select prior_assignees from lease where work_item_id = $1',
    [workItemId],
  );
  return rows[0]?.prior_assignees ?? [];
}

/**
 * Return an item to the pool in Plane's UI.
 *
 * Always comments — a lease that lapsed because an agent died is exactly the kind
 * of event that is invisible and expensive if it happens silently.
 *
 * No container rollup here, unlike claim and complete. Returning an item moves it
 * back to `unstarted`, and `rolledGroup` never un-starts a container that has
 * genuinely been worked on — so the nudge could only ever decide nothing.
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
        // Put back, not wiped. The item returns to the pool in the state it was
        // found in: a name a human had put there survives, and an item that was
        // unassigned goes back to unassigned. `null` means the pre-read failed,
        // and clearing is the safe fallback — a name we cannot account for reads
        // as a person's intent under rule 4 and would withhold the item from
        // everyone.
        assignees: await priorAssignees(pool, args.workItemId),
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
      await settled(pool, args.workItemId);
    } catch (err) {
      // Left owed on purpose. This is the path a dead agent's item takes, so a
      // failure here is exactly when nobody is watching.
      log.warn({ err, workItemId: args.workItemId, op: 'return' }, 'plane mirror failed, queued');
    }
  }, pool);
}

/**
 * Put back a claim Plane has lost.
 *
 * Every other mirror function is driven by something an agent just did. This one
 * is driven by a comparison: reconciliation found a live lease whose item no
 * longer shows as claimed, and nothing was owed — the original write is recorded
 * as having landed — so no retry would ever have addressed it.
 *
 * Deliberately quieter than `mirrorClaim`. It restores the assignee and the
 * state and leaves no comment: nobody made a decision here, and a "Claimed by …"
 * note on an item that has been claimed for an hour would read to a human as a
 * second agent arriving. The log line is the record that it happened.
 */
export async function mirrorReclaim(
  plane: PlaneClient,
  pool: Pool,
  args: {
    projectId: string;
    workItemId: string;
    holder: string;
    planeUserId: string | null;
  },
): Promise<void> {
  return serial(args.workItemId, async () => {
    await owe(pool, args.workItemId, {
      kind: 'reclaim',
      projectId: args.projectId,
      holder: args.holder,
      planeUserId: args.planeUserId,
    });
    try {
      const started = await plane.stateByGroup(args.projectId, 'started');
      await plane.updateWorkItem(args.projectId, args.workItemId, {
        ...(started ? { state: started.id } : {}),
        ...(args.planeUserId ? { assignees: [args.planeUserId] } : {}),
      });
      await settled(pool, args.workItemId);
      log.info(
        { workItemId: args.workItemId, projectId: args.projectId, holder: args.holder },
        'reconciliation restored a claim Plane had lost',
      );
    } catch (err) {
      // Left owed, like the others: the drain will retry it with backoff.
      log.warn({ err, workItemId: args.workItemId, op: 'reclaim' }, 'plane mirror failed, queued');
    }
  }, pool);
}
