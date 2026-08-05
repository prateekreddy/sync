/**
 * Uuids out, names in — on both sides of a proxied Plane call.
 *
 * The gateway's own tools have answered in names since view.ts existed, and for
 * a reason recorded there: `next` once returned label uuids while `find`
 * returned label names, same field name and different content, and an agent
 * matching one against the other silently got nothing. Plane's proxied tools are
 * the other half of that surface and still answer in uuids, so `plane_issues get`
 * reports `state: "b2c1a…"` for the field `board` reports as `state: "In
 * Progress"`. The divergence view.ts was written to prevent, on the tools it does
 * not cover.
 *
 * What a uuid costs an agent is concrete, not aesthetic. It cannot be read, so
 * every response carrying one forces a second call to `plane_states` or
 * `plane_labels` purely to find out what was just fetched. It cannot be told
 * apart from its neighbours, so two labels are two indistinguishable strings.
 * And it is 36 characters of a budget that runs out.
 *
 * Both directions, deliberately. Resolving on the way out alone would be a trap:
 * an agent reads `state: "In Progress"`, writes it back, and Plane rejects a
 * field it only accepts as a uuid — so the read would have made the write
 * impossible. Names are therefore accepted wherever uuids are, and a raw uuid
 * keeps working unchanged, which is what keeps every existing caller correct.
 *
 * What is deliberately NOT translated is `project_id`. It is the one identifier
 * an agent must be able to hand back on the next call, the gateway fills it in
 * from the token when omitted, and replacing it would buy nothing while breaking
 * anyone working across two projects.
 */
import { GatewayError } from './errors.js';
import { log } from './log.js';
import type { PlaneClient } from './plane.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deliberately not a type predicate. `v is string` reads well at the call sites
 * that test an unknown, and turns the *negative* branch into `never` for a value
 * already known to be a string — which is how the write path lost the ability to
 * say "a string that is not a uuid", the exact case it exists to handle.
 */
export const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);

/** What a uuid-bearing field points at. */
type Kind = 'state' | 'label' | 'member' | 'item';

/**
 * The fields worth translating, by both spellings Plane uses.
 *
 * A closed list rather than "anything that looks like a uuid": a value we cannot
 * name confidently must stay exactly as it arrived, and guessing from shape
 * alone would eventually rewrite an id whose meaning we had not established.
 */
const FIELD_KIND: Record<string, Kind> = {
  state: 'state',
  state_id: 'state',
  labels: 'label',
  label_ids: 'label',
  assignees: 'member',
  assignee_ids: 'member',
  parent: 'item',
  parent_id: 'item',
};

/** How deep to walk. Plane's payloads are shallow; this only bounds a cycle. */
const MAX_DEPTH = 6;

/**
 * What to tell a model about a field it is filling in.
 *
 * A tool that quietly accepts names is half a feature: the model has no way to
 * discover it and will keep making the extra lookup call it always made. This
 * goes on the field itself, which is where a model is already looking when it
 * decides what to put there.
 */
const HINT: Record<Kind, string> = {
  state: 'Takes the state name ("In Progress") or its id, and is returned as the name.',
  label: 'Takes label names ("backend") or ids, and is returned as names.',
  member: "Takes a person's name or email address, or their id, and is returned as the name.",
  item: 'Takes a readable id ("SYNC-12") or an item id, and is returned as the readable id.',
};

/** The sentence to append to a field's description, if it is one we translate. */
export const nameHint = (field: string): string | undefined => {
  const kind = FIELD_KIND[field];
  return kind ? HINT[kind] : undefined;
};

interface Entry {
  id: string;
  /** What an agent sees and may write back. */
  name: string;
  /** A second accepted spelling — an email for a person. */
  alias?: string;
  /** An item's number, so `SYNC-42`, `#42` and `42` all reach the same item. */
  sequence?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The lookup tables for one request, in both directions.
 *
 * Built per call and thrown away, which sounds wasteful and is not: every table
 * comes from a `PlaneClient` method with its own cache, so the second request
 * for a project's states costs a map build rather than a fetch. What being
 * per-request buys is that a table is built at most once even when a payload
 * mentions the same project on a hundred rows.
 *
 * These read through the *service* client rather than the agent's own, matching
 * the choice `as()` already makes for states and labels: this is workspace
 * metadata, the agent has just been served the ids by a call it was authorised
 * to make, and scoping the lookups per agent would rebuild identical tables once
 * per agent per call.
 */
export class NameBook {
  private tables = new Map<string, Promise<Entry[]>>();

  constructor(private readonly plane: PlaneClient) {}

  private table(kind: Kind, projectId: string | null): Promise<Entry[]> {
    const key = `${kind}:${projectId ?? '-'}`;
    let table = this.tables.get(key);
    if (!table) {
      table = this.build(kind, projectId);
      this.tables.set(key, table);
    }
    return table;
  }

  private async build(kind: Kind, projectId: string | null): Promise<Entry[]> {
    if (kind === 'member') {
      return (await this.plane.members()).map((m) => ({ id: m.id, name: m.name, alias: m.email }));
    }
    // Everything else is project data, and without a project there is nothing to
    // look up. Returning empty rather than throwing: on the read side an
    // unresolved id stays a uuid, which is the same outcome as not trying.
    if (!projectId) return [];

    if (kind === 'state') {
      return (await this.plane.states(projectId)).map((s) => ({ id: s.id, name: s.name }));
    }
    if (kind === 'label') {
      return (await this.plane.labels(projectId)).map((l) => ({ id: l.id, name: l.name }));
    }

    const [sequences, identifier] = await Promise.all([
      this.plane.itemSequences(projectId),
      // Absent only if the project read fails; `#42` is still better than a uuid
      // and still round-trips, so a missing identifier degrades rather than
      // disables.
      this.plane.projectIdentifier(projectId).catch(() => undefined),
    ]);
    return [...sequences].map(([id, sequence]) => ({
      id,
      name: identifier ? `${identifier}-${sequence}` : `#${sequence}`,
      sequence,
    }));
  }

  /** The name for a uuid, or undefined — an id we cannot explain stays an id. */
  async nameFor(kind: Kind, projectId: string | null, id: string): Promise<string | undefined> {
    return (await this.table(kind, projectId)).find((e) => e.id === id)?.name;
  }

  /**
   * The uuid for a name, or a sentence saying why not.
   *
   * Ambiguity is refused rather than resolved. Two people with the same display
   * name is the case that matters: picking either would assign real work to
   * whichever happened to sort first, and the agent would have no way to know.
   */
  async idFor(
    kind: Kind,
    projectId: string | null,
    value: string,
  ): Promise<string | { problem: string }> {
    const rows = await this.table(kind, projectId);
    const wanted = value.trim().toLowerCase();

    let matches = rows.filter(
      (e) => e.name.toLowerCase() === wanted || e.alias?.toLowerCase() === wanted,
    );

    // `SYNC-42`, `#42` and `42` are the same item. Agents write all three, and a
    // readable id an agent copied out of a comment is usually the bare number.
    if (kind === 'item' && matches.length === 0) {
      const digits = /(?:^#?|-)(\d+)$/.exec(wanted)?.[1];
      if (digits) matches = rows.filter((e) => e.sequence === Number(digits));
    }

    if (matches.length === 1) return matches[0]!.id;

    if (matches.length > 1) {
      const which = matches.map((m) => m.alias ?? m.name).join(', ');
      return {
        problem: `"${value}" matches ${matches.length} ${kind}s (${which}). Use the exact one you mean, or its id.`,
      };
    }

    // Nothing to match against is not the same as no match, and saying "no such
    // state" when the truth is "we could not read the states" sends an agent off
    // to fix a name that was right. `members()` in particular answers with an
    // empty list when Plane is unreachable.
    if (rows.length === 0) {
      return {
        problem: !projectId && kind !== 'member'
          ? `Cannot resolve "${value}" without knowing the project — pass project_id, or use the id.`
          : `Could not read this workspace's ${kind}s, so "${value}" cannot be resolved. Retry, or pass the id.`,
      };
    }

    if (kind === 'item') {
      return { problem: `No work item "${value}" in this project. Use a readable id like SYNC-42.` };
    }
    // Small, closed vocabularies: listing them turns a refusal into the answer.
    const known = rows
      .map((r) => r.name)
      .slice(0, 25)
      .join(', ');
    return { problem: `No ${kind} called "${value}" in this project. One of: ${known}.` };
  }
}

/** The project a record belongs to, falling back to the one the call was about. */
function projectOf(record: Record<string, unknown>, fallback: string | null): string | null {
  for (const key of ['project_id', 'project', 'projectId']) {
    const v = record[key];
    if (typeof v === 'string' && isUuid(v)) return v;
  }
  return fallback;
}

/**
 * Replace uuids with names throughout a response.
 *
 * Never throws and never fails a call: a lookup that cannot be made leaves the
 * payload exactly as Plane sent it. Prettifying is worth a request; it is not
 * worth an error on a read that otherwise succeeded.
 */
export async function resolveNames(
  book: NameBook,
  payload: unknown,
  projectId: string | null,
): Promise<unknown> {
  const walk = async (value: unknown, project: string | null, depth: number): Promise<unknown> => {
    if (depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => walk(v, project, depth + 1)));
    }
    if (!isRecord(value)) return value;

    const here = projectOf(value, project);
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(value)) {
      const kind = FIELD_KIND[key];
      if (kind && typeof v === 'string' && isUuid(v)) {
        out[key] = (await book.nameFor(kind, here, v)) ?? v;
        continue;
      }
      if (kind && Array.isArray(v) && v.every(isUuid)) {
        out[key] = await Promise.all(
          (v as string[]).map(async (id) => (await book.nameFor(kind, here, id)) ?? id),
        );
        continue;
      }
      out[key] = isRecord(v) || Array.isArray(v) ? await walk(v, here, depth + 1) : v;
    }
    return out;
  };

  try {
    return await walk(payload, projectId, 0);
  } catch (err) {
    log.warn({ err }, 'could not resolve ids to names; returning the raw response');
    return payload;
  }
}

/**
 * Turn names back into uuids throughout a set of tool arguments.
 *
 * The mirror of the above, and the half that makes it safe: what an agent read
 * is what it may write. Recursive because Plane nests the fields that matter —
 * `update_issue` takes them under `issue_data`, not at the top level.
 *
 * A value that is already a uuid is passed through untouched, so nothing that
 * worked before this existed stops working.
 *
 * Unresolvable names are refused here rather than forwarded. Plane would reject
 * them too, with a message naming neither the field nor the alternatives — and
 * an agent that cannot see which of `state` or `labels` was wrong has no better
 * next move than guessing.
 */
export async function resolveIds(
  book: NameBook,
  args: Record<string, unknown>,
  projectId: string | null,
): Promise<Record<string, unknown>> {
  const one = async (kind: Kind, project: string | null, key: string, v: unknown) => {
    if (typeof v !== 'string' || isUuid(v) || v.trim() === '') return v;
    const found = await book.idFor(kind, project, v);
    if (typeof found === 'string') return found;
    throw new GatewayError('INVALID', `${key}: ${found.problem}`, { field: key });
  };

  const walk = async (
    record: Record<string, unknown>,
    project: string | null,
    depth: number,
  ): Promise<Record<string, unknown>> => {
    const here = projectOf(record, project);
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(record)) {
      const kind = FIELD_KIND[key];
      if (kind && depth <= MAX_DEPTH) {
        if (Array.isArray(v)) {
          out[key] = await Promise.all(v.map((item) => one(kind, here, key, item)));
          continue;
        }
        out[key] = await one(kind, here, key, v);
        continue;
      }
      if (Array.isArray(v) && depth < MAX_DEPTH) {
        out[key] = await Promise.all(
          v.map((item) => (isRecord(item) ? walk(item, here, depth + 1) : item)),
        );
        continue;
      }
      out[key] = isRecord(v) && depth < MAX_DEPTH ? await walk(v, here, depth + 1) : v;
    }
    return out;
  };

  return walk(args, projectId, 0);
}
