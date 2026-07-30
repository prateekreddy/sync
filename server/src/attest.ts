import type { Pool } from './db.js';
import { findEvidence, type Evidence } from './evidence.js';

/**
 * Claims that a work item is connected to an artefact, and whether anyone
 * independent agrees.
 *
 * `evidence.ts` answers "did this completion cite anything at all" — a pure
 * predicate over a string, applied at the moment of completion. This answers the
 * question that outlives the call: *did the thing it cited actually happen?*
 *
 * The whole design rests on one idea: **normalise on write, compare exactly on
 * read**. An agent writes `3f7a891`; GitHub sends
 * `3f7a891c4e1d2b0a9f8e7d6c5b4a39281706f5e4`. A fuzzy comparison between those
 * would be a source of silent wrong answers forever. Instead both reduce to
 * `commit:3f7a891` at write time, by one function, and corroboration is `=`.
 */

export type AttestSource = 'agent' | 'github';

/** Only artefacts GitHub can independently attest to. See migration 004. */
export type ArtefactKind = 'commit' | 'url';

export interface Claim {
  workItemId: string;
  projectId?: string | undefined;
  source: AttestSource;
  kind: ArtefactKind;
  value: string;
  actor?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

/** Abbreviated shas start at 7 characters, so that is the widest common prefix. */
const SHA_PREFIX = 7;

/**
 * A pull request URL and a shorthand reference to the same pull request are the
 * same artefact, and an agent will write either. Reduced to `pr:owner/repo#42` so
 * they meet.
 */
const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;

/**
 * The identity of an artefact.
 *
 * Called for every row written from both sources; if it ever disagrees with
 * itself the feature silently stops corroborating anything, which is why it takes
 * the artefact and nothing else — no source, no context, no options.
 */
export function matchKey(kind: ArtefactKind, value: string): string {
  const v = value.trim();
  if (kind === 'commit') return `commit:${v.toLowerCase().slice(0, SHA_PREFIX)}`;

  const pr = PR_URL.exec(v);
  if (pr) return `pr:${pr[1]!.toLowerCase()}/${pr[2]!.toLowerCase()}#${pr[3]}`;

  // Any other URL: drop the fragment, the query and a trailing slash, so the same
  // link pasted from a browser and from a CLI is one artefact.
  return `url:${v.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()}`;
}

/**
 * The corroboratable part of a completion's evidence.
 *
 * A cited file path or work item is evidence a human can follow, and counts for
 * the warning in `evidence.ts` — but nothing outside will ever confirm it, so
 * recording it as a claim would leave a row that can only ever be uncorroborated.
 */
export function claimsIn(outcome: string): Evidence[] {
  return findEvidence(outcome).filter((e) => e.kind === 'commit' || e.kind === 'url');
}

/**
 * Write claims, ignoring ones already recorded.
 *
 * Idempotent by (work item, source, artefact): GitHub retries deliveries, and an
 * agent may complete the same item again after a re-claim.
 */
export async function record(pool: Pool, claims: Claim[]): Promise<number> {
  if (claims.length === 0) return 0;

  let written = 0;
  for (const c of claims) {
    const { rowCount } = await pool.query(
      `insert into attestation (work_item_id, project_id, source, kind, value, match_key, actor, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (work_item_id, source, match_key) do nothing`,
      [
        c.workItemId,
        c.projectId ?? null,
        c.source,
        c.kind,
        c.value,
        matchKey(c.kind, c.value),
        c.actor ?? null,
        JSON.stringify(c.detail ?? {}),
      ],
    );
    written += rowCount ?? 0;
  }
  return written;
}

export interface Corroboration {
  /** What an agent said, and whether anything independent agrees. */
  claimed: Array<{ kind: ArtefactKind; value: string; actor: string | null; confirmed: boolean }>;
  /** What GitHub reported, whether or not an agent mentioned it. */
  observed: Array<{ kind: ArtefactKind; value: string; actor: string | null }>;
  /** True when at least one agent claim is corroborated. */
  verified: boolean;
}

export async function corroborate(pool: Pool, workItemId: string): Promise<Corroboration> {
  const { rows } = await pool.query<{
    source: AttestSource;
    kind: ArtefactKind;
    value: string;
    match_key: string;
    actor: string | null;
  }>(
    `select source, kind, value, match_key, actor
       from attestation where work_item_id = $1 order by observed_at`,
    [workItemId],
  );

  const seen = new Set(rows.filter((r) => r.source === 'github').map((r) => r.match_key));
  const claimed = rows
    .filter((r) => r.source === 'agent')
    .map((r) => ({
      kind: r.kind,
      value: r.value,
      actor: r.actor,
      confirmed: seen.has(r.match_key),
    }));

  return {
    claimed,
    observed: rows
      .filter((r) => r.source === 'github')
      .map((r) => ({ kind: r.kind, value: r.value, actor: r.actor })),
    verified: claimed.some((c) => c.confirmed),
  };
}

export interface Unlanded {
  workItemId: string;
  projectId: string | null;
  value: string;
  actor: string | null;
  observedAt: Date;
}

/**
 * Agent claims old enough that the artefact should have shown up, and it never
 * did — a completion citing a pull request that was never merged.
 *
 * Deliberately not "unverified": that label means *cited nothing*. This is the
 * opposite and worse failure, a completion that cited something specific and
 * checkable which turns out not to exist. Distinguishing them is the whole point
 * of keeping the citation rather than a boolean.
 */
export async function unlanded(pool: Pool, olderThanHours: number): Promise<Unlanded[]> {
  const { rows } = await pool.query<{
    id: string;
    work_item_id: string;
    project_id: string | null;
    value: string;
    actor: string | null;
    observed_at: Date;
  }>(
    `select a.id, a.work_item_id, a.project_id, a.value, a.actor, a.observed_at
       from attestation a
      where a.source = 'agent'
        and a.flagged_at is null
        and a.observed_at < now() - make_interval(hours => $1::int)
        and not exists (
          select 1 from attestation g
           where g.work_item_id = a.work_item_id
             and g.source = 'github'
             and g.match_key = a.match_key)
      order by a.observed_at
      limit 50`,
    [olderThanHours],
  );

  if (rows.length === 0) return [];
  // Marked before the caller reports them: a flag written twice is noise on a
  // board a human reads, and the report itself is best-effort anyway.
  await pool.query(`update attestation set flagged_at = now() where id = any($1::uuid[])`, [
    rows.map((r) => r.id),
  ]);

  return rows.map((r) => ({
    workItemId: r.work_item_id,
    projectId: r.project_id,
    value: r.value,
    actor: r.actor,
    observedAt: r.observed_at,
  }));
}

/** The label put on an item whose cited artefact never appeared. */
export const UNLANDED_LABEL = 'evidence-missing';
