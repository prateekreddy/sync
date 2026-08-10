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

/**
 * Field selection, defined once and shared by every read tool.
 *
 * Bolting a different flag onto each tool is how `verbose: boolean` happened.
 * Selection is a property of the shared work-item view, so it is one parameter
 * with one meaning wherever it appears.
 */
const fields = z
  .string()
  .optional()
  .describe(
    'Comma-separated keys to return per item, e.g. "workItemId,title,holder". ' +
      'Omit for the full view: workItemId, readableId, title, priority, state, labels, ' +
      'parentId, holder, expiresAt, updatedAt. workItemId is always returned.',
  );

/**
 * One title rule, applied wherever a title is written.
 *
 * Left to itself a fleet titles work after the code it will touch —
 * `why(workItemId): return screen()'s reasons` — because that is what is in mind
 * at the moment of writing. It reads fine on the day and is unreadable a month
 * later: it names a function that may not survive, says nothing about what anyone
 * gains, and makes the board a list of diffs rather than of intentions. The board
 * outlives every one of those names.
 *
 * Shared by `capture` and `decompose` so the two cannot drift, and so a
 * decomposition's children are held to the same bar as its parent.
 */
const titleField = z
  .string()
  .min(3)
  .max(255)
  .describe(
    'One line that leads with the capability someone gains, or the behaviour that is wrong. ' +
      '"Tell an agent why it cannot claim an item", not "why(workItemId): return the gate ' +
      'reasons" — the second names a function and never says what is wrong or what anyone ' +
      'gets. An identifier is welcome where it is the most precise short way to say what you ' +
      'mean ("GITHUB_WEBHOOK_SECRET is unset in production"); avoid the volatile kind — a ' +
      'function or parameter that will be renamed before the item is read. The test: would ' +
      'someone who has never read this codebase know what changes for them?',
  );

export const DEFAULT_TTL = 600;
export const MAX_TTL = 3600;

export const CaptureBody = z.object({
  projectId: uuid,
  title: titleField,
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
  discoveredFrom: uuid
    .optional()
    .describe(
      'Work item you were on when you noticed this. Usually leave it out: the gateway links ' +
        'whatever you were last working on in this project — a lease you hold, or one you ' +
        'finished in the last few hours — and says so in the reply, with discoveredFromBasis ' +
        'telling you which. Pass it explicitly when the real source is something older, or ' +
        'something other than the last thing you touched.',
    ),
  parentId: uuid
    .optional()
    .describe(
      'Makes this a sub-item of that work item. Use for real decomposition, not for "related": ' +
        'a parent with unfinished sub-items stops being claimable, so nobody will pick it up ' +
        'until every child is done. Usually leave it out: if you hold an item that itself has a ' +
        'parent, the capture is filed alongside it as a SIBLING and the reply says ' +
        'parentInherited: true. It never becomes a child of what you are holding — that would ' +
        'make your own item unclaimable until the note you just wrote is done. Pass it to place ' +
        'work under something the gateway would not have chosen.',
    ),
  moduleId: uuid
    .optional()
    .describe(
      'Put this in a module — the epic layer, one per feature or workstream. Usually leave it ' +
        'out: it is inherited from parentId, or failing that from the item you are holding, and ' +
        'the reply says when it was inherited. Pass it to place work in a module neither of ' +
        'those would have chosen.',
    ),
  idempotencyKey: z.string().max(200).optional().describe('Pass a stable key if you may retry.'),
});

export const NextQuery = z.object({
  projectId: uuid,
  limit: z.coerce.number().int().min(1).max(50).default(10),
  fields,
});

export const WhyQuery = z.object({
  projectId: uuid,
  workItemId: uuid,
});

export const TreeQuery = z.object({
  projectId: uuid,
  workItemId: uuid
    .optional()
    .describe(
      'Omit to see the top level of the project — every item with no parent, with ' +
        'what is under it. That is the question to start from when you do not already ' +
        'know which item you want.',
    ),
  // No `.default()`: the right depth differs between the two questions, and only
  // the handler knows which was asked. See tree.ts.
  depth: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Levels to expand. Defaults to 5 under a named item, 2 for the top level.'),
  ready: z.coerce
    .boolean()
    .optional()
    .describe(
      'Show only what you could claim right now, plus the containers holding it. ' +
        'Answers "what is left under this that I can pick up".',
    ),
  includeDone: z.coerce
    .boolean()
    .optional()
    .describe(
      'Put finished work back into the top level. Off by default: a root whose ' +
        'whole subtree is done is left out, and the count comes back as ' +
        '`finishedRootsHidden` so nothing is hidden silently. A container with ' +
        'any unfinished work under it always appears regardless. Only affects ' +
        'the top level — asking for an item by id shows it whatever its state.',
    ),
  fields,
});

export const GatherBody = z.object({
  projectId: uuid,
  workItemIds: z
    .array(uuid)
    .min(1)
    .max(50)
    .describe('The loose items to file. They keep their own state, priority and labels.'),
  containerId: uuid
    .optional()
    .describe('An existing item to file them under. Give this or title, not both.'),
  title: titleField
    .optional()
    .describe(
      'Make a new container with this name instead. Name the outcome the group delivers, ' +
        'not the category it belongs to — "Agents can find work without being told where it is" ' +
        'reads as something that finishes; "Search improvements" never does.',
    ),
  body: z.string().optional().describe('What this group is, for whoever opens it later.'),
  reparent: z
    .boolean()
    .optional()
    .describe(
      'Move items that already hang off something else. Off by default: that overrules a ' +
        'placement somebody made, and the call is refused naming those items so you can decide.',
    ),
  approvedBy: z
    .string()
    .optional()
    .describe(
      'Filled in by the server after a person answers. Anything you send here is discarded — ' +
        'the point of the field is that it records an answer you did not write.',
    ),
});

export const DecomposeBody = z.object({
  projectId: uuid,
  parentId: uuid.describe('The item being broken up. It becomes a container and stops being claimable.'),
  moduleId: uuid.optional().describe('Applied to every child — a decomposition belongs to one feature.'),
  children: z
    .array(
      z.object({
        title: titleField,
        body: z
          .string()
          .min(1)
          .describe('Enough for another agent to act without you. A child with no body is unclaimable.'),
        priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
        labels: z.array(z.string()).optional(),
        idempotencyKey: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const SearchQuery = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      'Text to look for. Every word must appear, in any order — two words narrow, they do ' +
        'not widen.',
    ),
  projectId: uuid
    .optional()
    .describe('Defaults to your own project. Only a project you can see in Plane.'),
  workspace: z.coerce
    .boolean()
    .default(false)
    .describe(
      'Search every project you can see instead of just yours, descriptions included. Costs one ' +
        'request per project, from your own Plane budget — fine when you mean it, wasteful as a ' +
        'default. Leave it off unless the work could be anywhere. A workspace with more projects ' +
        'than this will read falls back to titles and says so in the reply.',
    ),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const HistoryQuery = z.object({
  projectId: uuid,
  workItemId: uuid,
});

export const BoardQuery = z.object({
  projectId: uuid,
  moduleId: uuid.optional().describe('Just this module. Omit for the whole project.'),
});

export const FindQuerySchema = z.object({
  projectId: uuid,
  labels: z
    .string()
    .optional()
    .describe('Comma-separated label names. An item must carry all of them.'),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  stateGroup: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']).optional(),
  moduleId: uuid.optional().describe('Only items in this module.'),
  holder: z
    .string()
    .optional()
    .describe("An agent name, or 'any' for anything currently held, or 'none' for unheld."),
  parentId: uuid.optional().describe('Direct children of this item.'),
  ready: z.coerce.boolean().optional().describe('Only items claim would accept.'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  fields,
});

export const ClaimBody = z.object({
  projectId: uuid,
  workItemId: uuid.optional().describe('Omit to let the gateway pick the best ready item.'),
  ttlSeconds: z.number().int().min(30).max(MAX_TTL).default(DEFAULT_TTL),
  spawnedBy: z.array(z.string()).optional(),
  sessionId: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Leave this alone. The sync plugin sends your session on a header, which ' +
        'overrides anything set here; it exists only for clients that cannot set ' +
        'headers. Do not invent a value — a wrong one is worse than none, because ' +
        'two agents that guess the same string are treated as one session.',
    ),
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
  outcome: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'What you did, and the evidence. A commit sha, PR or issue URL, file path or work item ' +
        'id belongs here — a completion citing none of those is recorded but labelled ' +
        '"unverified", because nobody downstream can tell it apart from one backed by nothing.',
    ),
  refs: z
    .array(z.string().min(2).max(32))
    .max(50)
    .optional()
    .describe(
      'Other work items this touched, e.g. ["SYNC-32"] — they become real relations, and this ' +
        'is the ONLY way to make one. Naming an item in `outcome` does not link it: an outcome ' +
        'mentions items as data at least as often as it means them as relations, and a wrong ' +
        'edge is permanent and shows up in the other item\'s briefing. Mentions are reported ' +
        'back as unlinked so you can promote them here if you meant them. A ref naming nothing ' +
        'in this project is reported back too, not dropped.',
    ),
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

/**
 * Retracting a blocker, not deleting it.
 *
 * Plane's relations endpoint is `["get", "post"]` — measured at v1.3.1, the
 * version we run, and still true on `preview`. There is no delete to call, so
 * this stops the readiness gate honouring the edge instead. See retraction.ts.
 */
export const UnlinkBody = z.object({
  projectId: uuid,
  workItemId: uuid,
  targets: z.array(uuid).min(1).max(20),
  // Required, and deliberately not defaulted. Removing a dependency is a
  // judgement someone will want to audit, and "" would be the value every caller
  // in a hurry left behind.
  reason: z.string().min(3).max(500),
  /** Put the dependency back under the gate. */
  reinstate: z.boolean().optional(),
});

/**
 * A discovery that constrains work which already exists.
 *
 * No relation type here, deliberately: the requirement goes INTO the constrained
 * items' acceptance criteria rather than one hop away on an edge. See SYNC-44.
 */
export const ConstrainBody = z.object({
  projectId: uuid,
  workItemIds: z.array(uuid).min(1).max(20),
  requirement: z.string().min(10).max(1000),
  proof: z
    .object({
      title: z.string().min(3).max(255),
      body: z.string().min(1),
    })
    .optional(),
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
      'while working another item, the link back to it is made automatically from your lease. ' +
      'To break a large item into sub-items, use decompose rather than calling this once per ' +
      'child: the plan becomes claimable at its FIRST child, so written one call at a time it is ' +
      'open to another agent before you have finished writing it. The reply echoes the priority ' +
      'and labels it applied, and on a dedup lists in notApplied the parts of your request that ' +
      'did not happen — compare them with what you sent rather than assuming the call landed.',
    schema: CaptureBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/capture', body: a }),
  },
  {
    name: 'decompose',
    title: 'Break an item into sub-items',
    description:
      'Create several sub-items under one parent in a single call. Prefer this over calling ' +
      'capture repeatedly: a parent stops being claimable the moment its FIRST child appears, so ' +
      'a decomposition built one call at a time looks finished while it is still half written, ' +
      'and another agent can start work under it. Each child gets the same dedup and idempotency ' +
      'handling as capture. Not a transaction — if some children fail the rest still land and ' +
      'the reply names exactly which did not, so check `complete`.',
    schema: DecomposeBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/decompose', body: a }),
  },
  {
    name: 'gather',
    title: 'File loose items under one container',
    description:
      'The inverse of decompose: take items that already exist and put them under one parent, ' +
      'either an item you name or a new one this creates. Use it when a project has gone flat — ' +
      'lots of open items hanging off nothing, which tree with no workItemId and board\'s ' +
      'rootlessOpen both show — because the alternative is editing each item by hand, which is ' +
      'why flat boards stay flat. A person is asked before anything moves, and shown the list: ' +
      'deciding what belongs under what is a judgement about somebody\'s work, so propose it and ' +
      'let them answer. If they say no, write the proposal down rather than filing it anyway. ' +
      'Items that already hang off something else are left alone unless you pass reparent. ' +
      'Not a transaction — check `complete` and `failed`.',
    schema: GatherBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/gather', body: a }),
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
    name: 'why',
    title: 'Why can I not have this item?',
    description:
      'Explain why a work item is not claimable — missing description, draft, wrong state, ' +
      'unfinished sub-items, a blocking label, an unfinished blocker, a live lease held by ' +
      'someone else, or a capability mismatch with your token. Call this when next returns ' +
      'nothing useful or claim refuses, instead of guessing. Read-only; it answers with the ' +
      'same reasons the gate itself used.',
    schema: WhyQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/why', a) }),
  },
  {
    name: 'tree',
    title: 'What is under this item — or at the top of this project?',
    description:
      'The sub-tree under a work item — every sub-item with its state, priority and, if someone ' +
      'is working it right now, the holder and when their lease runs out. Also returns the path ' +
      'up to the root, so an item handed to you in isolation still shows what it is part of. Every ' +
      'node carries progress — total, done, held, ready, blocked over itself and everything beneath ' +
      'it — so you can see which branch is nearly finished and which has not started without ' +
      'expanding either. Those are the board\'s own buckets and add up the same way. Use this before decomposing ' +
      'further, and instead of listing the project and reassembling it yourself. Pass ' +
      'ready: true to see only what you could claim, with the containers holding it kept so ' +
      'the tree still makes sense. Omit workItemId to get the top level instead: every item with ' +
      'no parent, in `roots`, each with its own children. Start there when you are new to a ' +
      'project or picking up after a break — it is the shape of the work, which a flat listing ' +
      'cannot show you. The top level leaves out roots whose whole subtree is finished, and says ' +
      'how many in `finishedRootsHidden`; anything with unfinished work under it still appears, ' +
      'and includeDone: true brings the rest back. Asking for an item by id is unaffected, so a ' +
      'container that finished last month is still there when you go looking for it.',
    schema: TreeQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/tree', a) }),
  },
  {
    name: 'board',
    title: 'Where does this project stand?',
    description:
      'Progress per module — the epic layer — plus every live lease, in one call. Each module ' +
      'reports total, done, held, ready and blocked, which add up: an item is in exactly one ' +
      'bucket. `ready` is the number Plane cannot produce, because it needs the readiness gate ' +
      'and the lease table; `blocked` holds everything the gate withholds — no description, ' +
      'drafts, unfinished sub-items, human flags, and items waiting on an unfinished blocked_by. ' +
      'Use it to decide whether to finish something nearly done rather ' +
      'than start something new, and to see what the rest of the fleet is holding. ' +
      '`structure` says whether the board has any shape at all: how many items are filed in a ' +
      'module, have a parent, or are containers, how deep the hierarchy goes, and how many are ' +
      'unplaced. Read `rootlessOpen` rather than `unplacedOpen` to judge the tree: `unplaced` ' +
      'counts only items that are in no module AND have no parent, so a board where everything ' +
      'was filed in a module and nothing had a parent reported unplaced: 0 and read as fully ' +
      'structured while being flat. `rootlessOpen` is open leaf work sitting at top level ' +
      'whether filed or not — high, or a depth of 1, means an inbox rather than a plan.',
    schema: BoardQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/board', a) }),
  },
  {
    name: 'search',
    title: 'Find work already written down',
    description:
      'Search work by text. Your own project by default, matching titles AND descriptions — ' +
      'which is where the file names, error strings and identifiers usually are, since titles ' +
      'lead with behaviour. Use it before capturing, to check whether something is already ' +
      'written down, and to find an item a human referred to only by subject. A body hit says ' +
      'where=body and carries the surrounding text, so you can tell a real match from a passing ' +
      'mention without opening it. Pass workspace:true to cross project boundaries — descriptions ' +
      'included, at one request per project, and the reply says how many it read. Results are ' +
      'pointers — use find, tree or why inside the project for more. Scoped to your own Plane ' +
      'access either way.',
    schema: SearchQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/search', a) }),
  },
  {
    name: 'find',
    title: 'Search this project',
    description:
      'Filter a project\'s work by label, priority, state group, module, parent, or who is ' +
      'holding it — and combine them. Returns compact rows plus `matched`, the number of hits ' +
      'before `limit`. Plane\'s own list tools cannot filter at all, so use this rather than ' +
      'listing the project and sifting it yourself. `holder` is unique to this tool: it comes ' +
      'from the lease table, so \'any\' shows what the fleet is working on and \'none\' shows ' +
      'what is free. `ready: true` applies the same gate claim uses — including unfinished ' +
      'blocked_by, so an item listed ready will not then be refused.',
    schema: FindQuerySchema,
    method: 'GET',
    request: (a) => ({ path: q('/v1/find', a) }),
  },
  {
    name: 'history',
    title: 'Has this item been attempted before?',
    description:
      'What the lease knows about an item: how many times it has been claimed, how many of ' +
      'those lapsed rather than finishing, who holds or last held it, and how the last attempt ' +
      'ended. Check this before claiming something that looks harder than it reads — two agents ' +
      'having already timed out on it is the context that should change whether you take it or ' +
      'refine it first. Returns null if nobody has ever claimed it.',
    schema: HistoryQuery,
    method: 'GET',
    request: (a) => ({ path: q('/v1/history', a) }),
  },
  {
    name: 'claim',
    title: 'Take a piece of work',
    description:
      'Atomically take exclusive ownership of a work item, and return the lease. This is the ' +
      'ONLY way to start work: assigning yourself in Plane does not reserve anything and two ' +
      'agents doing it will both believe they own the item. Omit workItemId to let the gateway ' +
      'pick the best ready item in one step — calling next and then claim is a race. The lease ' +
      'expires; keep it alive with heartbeat, and end it with complete or release. The reply also ' +
      'carries a briefing: the item\'s full text, its parent, and every item linked to it with ' +
      'open ones first and their text included. READ THE OPEN ONES BEFORE STARTING — a linked ' +
      'item that is still open is often a requirement on the work you just took, and the natural ' +
      'implementation is what it exists to warn you against.',
    schema: ClaimBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/claim', body: a }),
  },
  // `heartbeat` is deliberately not a tool.
  //
  // A monitor outside the conversation keeps leases alive, so an agent has no
  // reason to call this — and offering it anyway is not free. A tool in the list
  // is a thing the model has to consider and can misuse, and one described as
  // "call periodically during long work" reintroduces exactly the obligation the
  // monitor exists to remove. Naming it only to say "you will not need this"
  // teaches the concept and then spends words unteaching it, which lands as
  // doubt rather than as nothing.
  //
  // POST /v1/heartbeat remains, for clients running without the plugin and for
  // extending a lease meant to outlive its session. It is reachable by anything
  // that speaks HTTP; it is simply not put in front of the model.
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
      'cannot succeed yet. Plane keeps every relation on a pair rather than replacing one, so ' +
      'linking a pair a second time with a different type ADDS it and leaves the first in force ' +
      '— the reply names any it found under `conflicts`. To undo a blocked_by, call unlink; ' +
      're-linking as relates_to does not remove it.',
    schema: LinkBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/link', body: a }),
  },
  {
    name: 'constrain',
    title: 'This is a requirement on work that already exists',
    description:
      'Most discoveries are not new tasks. When you find a requirement on work that already has ' +
      'an item, this writes it INTO those items as an acceptance criterion, so whoever claims ' +
      'them sees it — capture would file it as a sibling, where the claimer never looks. Say the ' +
      'requirement specifically enough that it cannot be paraphrased into vagueness: name the ' +
      'exact input to test against, not "handle this carefully". ' +
      'Pass `proof` only when the residue is genuinely separate work, and use this test to ' +
      'decide: does the WRONG implementation look right? A rate limit on the wrong side compiles ' +
      'and passes a naive test; an address copied across chains reads as symmetric and never ' +
      'fails in normal use. Those need a proof someone can claim, and it is opened blocked_by ' +
      'the work it verifies. If the wrong version looks obviously wrong, the criterion is enough ' +
      'and a second item is landfill.',
    schema: ConstrainBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/constrain', body: a }),
  },
  {
    name: 'unlink',
    title: 'This dependency is not real',
    description:
      'Stop the readiness gate honouring a blocked_by relation, so work it was wrongly gating ' +
      'can be claimed again. Use it when a dependency stops being true — the scope changed, or ' +
      'the edge was a mistake. `reason` is required and is recorded against the decision. ' +
      'Note what this does NOT do: Plane\'s API cannot delete a relation, so the edge stays ' +
      'visible in Plane and a comment is written on the item saying it is no longer enforced. ' +
      'Delete it in Plane\'s UI to make the two agree. Pass reinstate: true to put it back.',
    schema: UnlinkBody,
    method: 'POST',
    request: (a) => ({ path: '/v1/unlink', body: a }),
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
