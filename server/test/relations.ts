import type { Relations } from '../src/plane.js';

/**
 * A relations payload with every bucket present and empty.
 *
 * Shared because it has to be identical everywhere. Every fake Plane feeding a
 * read tool must answer `relations`, or the real client falls through to a real
 * fetch and the test hangs on backoff rather than failing — which is how the
 * SYNC-65 wiring change first showed up: thirty-eight timeouts, no assertion
 * failures. A per-file copy of this literal would let one file's version drift
 * (a missing bucket, a stray field) and the failure would look like a bug in the
 * gate rather than in the double.
 */
export const NO_RELATIONS: Relations = {
  blocking: [],
  blocked_by: [],
  duplicate: [],
  relates_to: [],
  start_after: [],
  start_before: [],
  finish_after: [],
  finish_before: [],
};

/** Relations with only the buckets you name filled in. */
export const relationsWith = (over: Partial<Relations>): Relations => ({
  ...NO_RELATIONS,
  ...over,
});
