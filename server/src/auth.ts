import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt } from './crypto.js';
import type { Pool } from './db.js';
import { GatewayError } from './errors.js';

export interface Actor {
  name: string;                 // 'sync-worker-3'
  holder: string;               // 'agent:sync-worker-3'
  capabilities: string[];
  planeUserId: string | null;
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
  },
): Promise<{ token: string; name: string }> {
  const token = generateToken();
  await pool.query(
    `insert into agent_token
       (name, token_sha256, capabilities, plane_user_id, principal, plane_token_enc)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (name) do update
        set token_sha256    = excluded.token_sha256,
            capabilities    = excluded.capabilities,
            plane_user_id   = excluded.plane_user_id,
            principal       = excluded.principal,
            -- Keep any existing Plane mapping when rotating only the gateway
            -- token, so rotation does not silently drop attribution.
            plane_token_enc = coalesce(excluded.plane_token_enc, agent_token.plane_token_enc),
            active          = true`,
    [
      args.name,
      sha256(token),
      args.capabilities ?? [],
      args.planeUserId ?? null,
      args.principal,
      args.planeToken ? encrypt(args.planeToken) : null,
    ],
  );
  return { token, name: args.name };
}

export async function authenticate(pool: Pool, bearer: string | undefined): Promise<Actor> {
  const token = bearer?.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new GatewayError('NOT_HOLDER', 'Missing agent token');

  const { rows } = await pool.query<{
    name: string;
    capabilities: string[];
    plane_user_id: string | null;
    principal: string;
    plane_token_enc: string | null;
  }>(
    `update agent_token set last_seen_at = now()
      where token_sha256 = $1 and active
     returning name, capabilities, plane_user_id, principal, plane_token_enc`,
    [sha256(token)],
  );

  const row = rows[0];
  if (!row) throw new GatewayError('NOT_HOLDER', 'Unknown or revoked agent token');

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
