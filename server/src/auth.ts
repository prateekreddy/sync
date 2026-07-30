import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt } from './crypto.js';
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';

export interface Actor {
  name: string;                 // 'sync-worker-3'
  holder: string;               // 'agent:sync-worker-3'
  capabilities: string[];
  planeUserId: string | null;
  /** Project used when a tool wants one and the caller omitted it. */
  defaultProjectId: string | null;
  principal: string;            // the human this agent ultimately acts for
  /**
   * This agent's own Plane API token, decrypted for the life of the request.
   *
   * Plane has no impersonation header, so writing as the agent means writing with
   * the agent's token. The agent never receives this: holding it would let it set
   * `assignee` directly and bypass the lease entirely. Identity is passed through;
   * possession is not.
   *
   * Null when the agent has no mapped Plane user — writes then fall back to the
   * gateway's service account.
   */
  planeToken: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Tokens are shown once at issue time and stored only as a hash. */
export function generateToken(): string {
  return `sync_agent_${randomBytes(24).toString('hex')}`;
}

export async function issueToken(
  pool: Pool,
  args: {
    name: string;
    capabilities?: string[];
    planeUserId?: string;
    principal: string;
    /** The agent's own Plane API token, so its writes are attributed to it. */
    planeToken?: string;
    /**
     * Project the agent works in by default. Carried on the token so an install
     * is a URL and a token with nothing else to configure — and so a re-scoped
     * agent is a server-side change rather than a visit to every box.
     */
    defaultProjectId?: string;
    /**
     * Refuse to rotate this name unless it is already owned by this Plane user.
     *
     * The upsert below is keyed on `name`, which is exactly right for an operator
     * at a shell and exactly wrong once anyone can mint: without this guard,
     * asking for a name someone else already took silently rotates their token
     * and steals their agent identity. Set by the self-service endpoint; the CLI
     * omits it, because an operator rotating a token by name is the intent there.
     */
    onlyIfOwnedBy?: string;
  },
): Promise<{ token: string; name: string }> {
  const token = generateToken();
  // Applied to the DO UPDATE rather than checked first, so two concurrent mints
  // for the same name cannot both pass the check and then race.
  const guard = args.onlyIfOwnedBy
    ? 'where agent_token.plane_user_id is not distinct from excluded.plane_user_id'
    : '';
  const { rows } = await pool.query<{ name: string }>(
    `insert into agent_token
       (name, token_sha256, capabilities, plane_user_id, principal, plane_token_enc,
        default_project_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (name) do update
        set token_sha256    = excluded.token_sha256,
            capabilities    = excluded.capabilities,
            plane_user_id   = excluded.plane_user_id,
            principal       = excluded.principal,
            -- Keep any existing Plane mapping when rotating only the gateway
            -- token, so rotation does not silently drop attribution.
            plane_token_enc = coalesce(excluded.plane_token_enc, agent_token.plane_token_enc),
            -- Same reasoning: rotating a gateway token must not silently unbind
            -- the agent from its project.
            default_project_id = coalesce(excluded.default_project_id,
                                          agent_token.default_project_id),
            active          = true
     ${guard}
     returning name`,
    [
      args.name,
      sha256(token),
      args.capabilities ?? [],
      args.planeUserId ?? null,
      args.principal,
      args.planeToken ? encrypt(args.planeToken) : null,
      args.defaultProjectId ?? null,
    ],
  );
  // No row came back, so the guard rejected the update: the name exists and
  // belongs to someone else. Never report this as success — the caller would hand
  // out a token that was never stored and works nowhere.
  if (rows.length === 0) {
    throw new GatewayError(
      'FORBIDDEN',
      `The agent name "${args.name}" already belongs to a different Plane user. Choose another.`,
    );
  }
  return { token, name: args.name };
}

/**
 * Turn a token off, given the token itself (RFC 7009).
 *
 * Presenting the credential is the authorisation: whoever holds it can already
 * use it, so letting them retire it removes capability rather than granting any.
 * Returns quietly either way — the spec requires that an unknown token be
 * indistinguishable from a revoked one, so this cannot be used to test whether a
 * token is live.
 */
export async function revokeByToken(pool: Pool, token: string): Promise<void> {
  await pool.query('update agent_token set active = false where token_sha256 = $1', [
    sha256(token.replace(/^Bearer\s+/i, '').trim()),
  ]);
}

/**
 * Turn an agent off by name, on behalf of the Plane user who owns it.
 *
 * The ownership predicate is the whole point: minting is self-service, so
 * revocation has to be too, and without this anyone could retire anyone else's
 * agents — a denial of service that needs no credential of the victim's.
 */
export async function revokeOwnedAgent(
  pool: Pool,
  name: string,
  planeUserId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ name: string }>(
    `update agent_token set active = false
      where name = $1 and plane_user_id = $2 and active
      returning name`,
    [name, planeUserId],
  );
  return rows.length > 0;
}

export async function authenticate(pool: Pool, bearer: string | undefined): Promise<Actor> {
  const token = bearer?.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new GatewayError('UNAUTHENTICATED', 'No Authorization: Bearer <token> header');

  const { rows } = await pool.query<{
    name: string;
    capabilities: string[];
    plane_user_id: string | null;
    principal: string;
    plane_token_enc: string | null;
    default_project_id: string | null;
  }>(
    `update agent_token set last_seen_at = now()
      where token_sha256 = $1 and active
     returning name, capabilities, plane_user_id, principal, plane_token_enc,
               default_project_id`,
    [sha256(token)],
  );

  const row = rows[0];
  if (!row) throw new GatewayError('UNAUTHENTICATED', 'Unknown or revoked agent token');

  let planeToken: string | null = null;
  if (row.plane_token_enc) {
    try {
      planeToken = decrypt(row.plane_token_enc);
    } catch {
      // A bad or rotated key must not take the whole agent offline: fall back to
      // the service account so work continues, attributed less precisely.
      planeToken = null;
    }
  }

  return {
    name: row.name,
    holder: `agent:${row.name}`,
    capabilities: row.capabilities,
    planeUserId: row.plane_user_id,
    defaultProjectId: row.default_project_id,
    principal: row.principal,
    planeToken,
  };
}

/**
 * Attribution is a chain, not a field: 'human:prateek' <- 'agent:worker-3'.
 * When most writes are machine-generated, "who decided this?" still has to
 * resolve back to a person.
 */
export const chainFor = (actor: Actor, spawnedBy?: string[]): string[] =>
  [actor.principal, ...(spawnedBy ?? []), actor.holder].filter(Boolean);
