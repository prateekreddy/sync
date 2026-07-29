import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for stored Plane API tokens.
 *
 * These have to be reversible — the gateway replays them to Plane — so unlike
 * agent tokens (stored as one-way hashes) they cannot be protected by hashing.
 *
 * The key comes from the environment and is never written to any database. That
 * matters more than the algorithm choice here: the gateway and Plane databases
 * live on one Postgres instance and are captured by one backup, so a key stored
 * alongside the ciphertext would protect nothing.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;

function key(): Buffer {
  const raw = process.env.GATEWAY_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      'GATEWAY_TOKEN_KEY is not set. Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        'Do NOT reuse Plane\'s SECRET_KEY — rotating it would make stored tokens undecryptable.',
    );
  }
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error(`GATEWAY_TOKEN_KEY must be 32 bytes as hex (64 chars); got ${buf.length}`);
  }
  return buf;
}

/** Returns base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext is truncated');

  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag); // GCM: authenticated, so tampering fails loudly
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** True when a key is configured — lets the server warn at boot rather than mid-request. */
export const hasKey = (): boolean => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};
