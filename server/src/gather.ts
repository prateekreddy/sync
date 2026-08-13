import type { Actor } from './auth.js';
import { GatewayError } from './errors.js';
import { escapeHtml } from './html.js';
import { actorNote } from './mirror.js';
import type { PlaneClient, WorkItem } from './plane.js';
import { rollUp } from './rollup.js';
import { readableId } from './view.js';

/**
 * Put a pile of existing items under one container.
 *
 * `decompose` builds structure downwards, from a plan somebody already has. There
 * was no inverse, so the only way to organise items that already exist was to
 * edit each one by hand — which is precisely what the periodic structural review
 * asks a human to do, and precisely why it goes unactioned. A board goes flat
 * because captures land where they fall; the fix is not to demand structure at
 * capture time, when nobody yet knows what the workstreams are, but to make
 * grouping cheap once they are obvious.
 *
 * The authority question is the whole design. Deciding what belongs under what is
 * a judgement about somebody's work, and agents that reorganised their own backlog
 * unprompted would be worse than a flat one. So the agent PROPOSES and a human
 * DISPOSES: the call is refused with the proposal attached until it carries the
 * name of a person who agreed, and the layer that can actually reach a person —
 * the MCP transport — is what fills that in. See tools.ts.
 *
 * `approvedBy` is an accountability record, not a capability check, and it is
 * worth being honest about which. An agent can already reparent one item at a
 * time through Plane's own `update_issue`, so nothing here is granting a power it
 * lacked; what this adds is that a bulk regrouping gets looked at, and that who
 * agreed to it is written on the container.
 */

export interface GatherMove {
  workItemId: string;
  readableId: string;
  title: string;
  /** What it used to hang off, so an unwanted regrouping can be undone. */
  from: string | null;
}

export interface GatherResult {
  containerId: string;
  readableId: string;
  title: string;
  /** True when the container was made by this call rather than named by it. */
  created: boolean;
  moved: GatherMove[];
  /** Items Plane would not move, with the reason. Empty on full success. */
  failed: Array<{ workItemId: string; readableId: string; error: string }>;
  /** True when nothing failed — so a caller can branch without counting. */
  complete: boolean;
}

/** How many items to name in the question. Enough to judge, short of a wall of text. */
const NAMED = 10;

export async function gather(
  plane: PlaneClient,
  actor: Actor,
  input: {
    projectId: string;
    workItemIds: string[];
    /** An existing item to file them under. Mutually exclusive with `title`. */
    containerId?: string | undefined;
    /** Make a new container with this name instead. */
    title?: string | undefined;
    body?: string | undefined;
    /** Required to move an item that already hangs off something else. */
    reparent?: boolean | undefined;
    /** The person who agreed. Written by the server, never by the model. */
    approvedBy?: string | undefined;
  },
): Promise<GatherResult> {
  if (Boolean(input.containerId) === Boolean(input.title)) {
    throw new GatewayError(
      'INVALID',
      'Name an existing container with containerId, or give a title to make one — not both, and not neither.',
      { recovery: 'Send exactly one of containerId and title.' },
    );
  }

  // One listing answers every question this needs: which items exist, what each
  // already hangs off, and the parent chain the cycle check walks. The
  // alternative is a request per item to learn things a single call already knows.
  const items = await plane.listWorkItems(input.projectId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const identifier = plane.identifierFor(input.projectId);
  const rid = (i: WorkItem) => readableId(i.sequence_id, identifier);

  // Order-preserving dedup. A repeated id is a caller's slip rather than a
  // failure, and moving the same item twice would report it moved twice.
  const wanted = [...new Set(input.workItemIds)];

  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new GatewayError('NOT_FOUND', 'Some of those items are not in this project', {
      workItemIds: missing,
    });
  }

  let container = input.containerId ? byId.get(input.containerId) : undefined;
  if (input.containerId && !container) {
    throw new GatewayError('NOT_FOUND', 'No such container work item in this project', {
      containerId: input.containerId,
    });
  }

  if (container) {
    // An item under itself, or under its own descendant, is a loop Plane will
    // accept and then be unable to render — and which would hang every walk in
    // this gateway that has a cycle guard bolted on precisely because Plane does
    // not stop this.
    const inMove = new Set(wanted);
    if (inMove.has(container.id)) {
      throw new GatewayError('INVALID', 'An item cannot be filed under itself', {
        containerId: container.id,
      });
    }
    const climbed = new Set<string>([container.id]);
    let cursor = container.parent;
    while (cursor && !climbed.has(cursor)) {
      if (inMove.has(cursor)) {
        throw new GatewayError(
          'INVALID',
          'That container already sits underneath one of the items you are moving, so this would make a loop.',
          { containerId: container.id, ancestor: cursor },
        );
      }
      climbed.add(cursor);
      cursor = byId.get(cursor)?.parent ?? null;
    }
  }

  // Placing unplaced work is the point of this tool. Moving work somebody has
  // already placed is a different act — it overrules a decision — so it is
  // refused until the caller says that is what they meant.
  const rehomed = wanted
    .map((id) => byId.get(id) as WorkItem)
    .filter((i) => i.parent && i.parent !== container?.id);
  if (rehomed.length && !input.reparent) {
    throw new GatewayError(
      'INVALID',
      `${rehomed.length} of those items already hang off something else. Moving them would overrule a placement somebody made.`,
      {
        alreadyPlaced: rehomed.map((i) => ({
          workItemId: i.id,
          readableId: rid(i),
          title: i.name,
          parent: i.parent,
        })),
        recovery:
          'Leave them where they are and gather the rest, or pass reparent: true if moving them is genuinely intended.',
      },
    );
  }

  const moving = wanted.map((id) => byId.get(id) as WorkItem).filter((i) => i.id !== container?.id);

  if (!input.approvedBy) {
    const named = moving.slice(0, NAMED);
    const under = container ? `${rid(container)} ${container.name}` : `a new item "${input.title}"`;
    const more = moving.length > named.length ? `\n…and ${moving.length - named.length} more.` : '';
    throw new GatewayError(
      'NEEDS_APPROVAL',
      `Grouping work is a judgement about what belongs under what, so a person has to agree to it.`,
      {
        // Read by tools.ts, which is the only layer with a channel to a human.
        // The question is composed here because this is the layer holding the
        // items; asking the transport to look them up again would put a board
        // listing in front of a yes/no prompt.
        question:
          `File ${moving.length} item${moving.length === 1 ? '' : 's'} under ${under}?\n\n` +
          named.map((i) => `• ${rid(i)} ${i.name}`).join('\n') +
          more,
        /** The field a yes gets written into. */
        grant: 'approvedBy',
        moves: moving.map((i) => ({ workItemId: i.id, readableId: rid(i), title: i.name })),
        recovery:
          'Ask the person you are working with whether these belong together, and show them the list. ' +
          'Do not file them without an answer — a wrong grouping hides work where nobody drilling down will find it.',
      },
    );
  }

  let created = false;
  if (!container) {
    // Deliberately `createWorkItem` rather than `capture`. Capture infers
    // placement from the caller's lease — a container filed as a sibling of
    // whatever the agent happens to be holding is exactly the arbitrary
    // placement this tool exists to correct.
    container = await plane.createWorkItem(input.projectId, {
      name: input.title,
      description_html:
        input.body ??
        `<p>Groups ${moving.length} item${moving.length === 1 ? '' : 's'} that were sitting at the top level with nothing rolling them up.</p>`,
    });
    created = true;
    byId.set(container.id, container);
  }

  const moved: GatherMove[] = [];
  const failed: GatherResult['failed'] = [];

  // Sequential, like decompose: these are writes against somebody's live tracker
  // and finishing a few hundred milliseconds sooner is worth less than staying
  // inside Plane's rate limit.
  for (const item of moving) {
    try {
      await plane.updateWorkItem(input.projectId, item.id, { parent: container.id });
      moved.push({ workItemId: item.id, readableId: rid(item), title: item.name, from: item.parent });
    } catch (err) {
      // Carry on rather than aborting. Stopping at the first failure leaves the
      // regrouping half-done *and* hides which items made it.
      failed.push({
        workItemId: item.id,
        readableId: rid(item),
        error: err instanceof GatewayError ? `${err.code}: ${err.message}` : String(err),
      });
    }
  }

  if (moved.length) {
    // Said on the container, where anyone drilling down will meet it. Who agreed
    // to a regrouping is the part that cannot be reconstructed afterwards — the
    // parent links themselves are visible, but not the fact that a person chose
    // them.
    const list = moved.map((m) => `<li>${m.readableId} — ${escapeHtml(m.title)}</li>`).join('');
    await plane
      .comment(
        input.projectId,
        container.id,
        await actorNote(
          plane,
          actor,
          `Gathered ${moved.length} item${moved.length === 1 ? '' : 's'} here, approved by ${escapeHtml(input.approvedBy)}.</p><ul>${list}</ul><p>`,
        ),
      )
      .catch(() => {
        // The regrouping is real and visible; only the note is missing.
      });

    // The container's own state is now a function of children it did not have a
    // moment ago — gathering three finished items under a fresh container should
    // not leave it reading "Backlog". Not awaited: rollup is best-effort by
    // design and the caller is waiting on a write that already landed.
    void rollUp(plane, input.projectId, moved[0]!.workItemId).catch(() => {});
  }

  return {
    containerId: container.id,
    readableId: rid(container),
    title: container.name,
    created,
    moved,
    failed,
    complete: failed.length === 0,
  };
}
