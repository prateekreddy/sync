/**
 * Which build is this, and which migrations has its database had?
 *
 * Every other question about a running gateway can be answered by asking it
 * something. This one could not: `/healthz` returned `{"ok":true}` and two
 * different deployments, three commits apart, answered identically. So "did my
 * deploy take?" had no direct answer, and the substitutes are all worse:
 *
 *   - Probe a behaviour that changed. Only works when you happen to know a
 *     difference, needs a token, and says nothing about any other host. This
 *     produced a wrong conclusion on 2026-08-03 that was written into a
 *     completed item's notes before it was caught (SYNC-65, SYNC-67).
 *   - Look at the tool list. Better — a tool that exists dates the build — but
 *     it is still inference from a side effect, and only distinguishes builds
 *     that added or removed a tool.
 *   - Get a shell on the host. Not available to the agents doing the deciding.
 *
 * Unauthenticated on purpose. The point is to check a host *before* trusting it
 * with a credential, which is exactly when you have no token — and it is what
 * `bin/onboard.sh` needs. The cost is that the commit sha is public: it tells a
 * reader which known bugs this instance still has. For a project whose source is
 * public anyway that is a small, deliberate trade against never being able to
 * tell two deployments apart.
 *
 * Absence is meaningful, so nothing here is omitted when unknown. A reply with
 * no `build` key at all is an older gateway that predates this file; a reply
 * with `build.sha: null` is a current one whose image was built without the arg.
 * Those are different problems and a missing field would conflate them — the
 * same shape of ambiguity SYNC-67 is about.
 */
import type { Pool } from 'pg';

/** Set from a Docker build arg. Not read from .git: the image has no repo. */
export interface BuildIdentity {
  /** Full commit sha the image was built from, or null if it was not passed. */
  sha: string | null;
  /** ISO 8601 build time, or null. */
  builtAt: string | null;
}

/** How far the *database this process is connected to* has been migrated. */
export interface SchemaLevel {
  /** Highest migration filename applied, e.g. `006_relation_retraction`. */
  level: string | null;
  /** How many migrations the ledger has recorded. */
  count: number;
  /** When the newest one was applied. */
  appliedAt: string | null;
}

export function buildIdentity(env: NodeJS.ProcessEnv = process.env): BuildIdentity {
  // Empty string and unset are the same thing here: Compose passes an empty
  // build arg when the variable is unset, so `GIT_SHA=` reaches the image.
  const sha = env['GIT_SHA']?.trim();
  const builtAt = env['BUILD_TIME']?.trim();
  return { sha: sha || null, builtAt: builtAt || null };
}

const TTL_MS = 60_000;
let cached: { at: number; value: SchemaLevel | null } | null = null;

/** Test seam: forget the cached schema level. */
export function resetSchemaCache(): void {
  cached = null;
}

/**
 * Read the migration ledger, cached briefly.
 *
 * Cached rather than read at startup because migrations can be applied to a
 * running gateway — `docker compose up gateway-migrate` while the server stays
 * up is a normal thing to do — and a value fixed at boot would then answer the
 * question wrongly for the whole process lifetime.
 *
 * Never throws, and never affects whether the health check passes. A gateway
 * that cannot reach Postgres is already reported healthy by `/healthz` today;
 * making that worse is not this change's business, and a reporting extra that
 * can turn a deployment red is a bad trade. It reports `null`, which reads as
 * "could not tell" rather than as "no migrations".
 */
export async function schemaLevel(pool: Pool): Promise<SchemaLevel | null> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value: SchemaLevel | null = null;
  try {
    const { rows } = await pool.query<{ level: string; count: string; applied_at: Date }>(
      `select max(filename) as level,
              count(*)::text as count,
              max(applied_at) as applied_at
         from schema_migration`,
    );
    const row = rows[0];
    if (row) {
      value = {
        level: row.level ?? null,
        count: Number(row.count),
        appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
      };
    }
  } catch {
    // Includes "relation schema_migration does not exist", which is the honest
    // answer for a database migrated before the ledger existed: we do not know.
    value = null;
  }
  cached = { at: now, value };
  return value;
}
