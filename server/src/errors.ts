/**
 * Failures an agent must be able to tell apart, because each implies a different
 * recovery. Vague errors are how agents end up retrying something that will never
 * succeed, or giving up on something that would have worked.
 */
export type ErrorCode =
  /** Nothing ready and unleased matched. Not really an error: back off, retry later. */
  | 'NO_WORK'
  /** Someone live holds this item, or it is not ready. Try a different item. */
  | 'NOT_CLAIMABLE'
  /** Caller is not the holder. Stop. Retrying cannot help. */
  | 'NOT_HOLDER'
  /**
   * Caller's epoch is behind the current holder's: its lease lapsed and the item
   * was reclaimed while it was away. Whatever it computed is based on stale state
   * and must be thrown away, not written. Stop.
   */
  | 'STALE_EPOCH'
  /** Lease lapsed and nobody else took it. A fresh claim may succeed. */
  | 'LEASE_EXPIRED'
  /** Lease was already completed or released. Terminal — a re-claim is not the fix. */
  | 'LEASE_ENDED'
  /** Same idempotency key replayed with a different body. Caller bug. */
  | 'IDEMPOTENCY_MISMATCH'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'UPSTREAM';

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Transport mapping lives in exactly one place. */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  NO_WORK: 404,
  NOT_CLAIMABLE: 409,
  NOT_HOLDER: 403,
  STALE_EPOCH: 409,
  LEASE_EXPIRED: 410,
  LEASE_ENDED: 409,
  IDEMPOTENCY_MISMATCH: 422,
  NOT_FOUND: 404,
  INVALID: 400,
  UPSTREAM: 502,
};

/** Guidance carried to the agent alongside the code, so the model need not infer it. */
export const RECOVERY: Record<ErrorCode, string> = {
  NO_WORK: 'No ready work matched. Back off and poll again later.',
  NOT_CLAIMABLE: 'Another agent holds this item. Pick a different one.',
  NOT_HOLDER: 'You do not hold this lease. Stop working this item.',
  STALE_EPOCH:
    'Your lease expired and the item was reclaimed by another agent. Discard your work on it — do NOT submit results — and claim fresh work.',
  LEASE_EXPIRED: 'Your lease expired. Claim it again before continuing.',
  LEASE_ENDED:
    'This lease was already completed or released. The work is finished — do not re-submit; claim fresh work instead.',
  IDEMPOTENCY_MISMATCH: 'That idempotency key was used with a different body. Use a new key.',
  NOT_FOUND: 'No such work item.',
  INVALID: 'Request was malformed.',
  UPSTREAM: 'Plane was unreachable or errored. Retry with backoff.',
};
