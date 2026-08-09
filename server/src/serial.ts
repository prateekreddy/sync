/**
 * One write chain per work item, shared by everything that writes to Plane.
 *
 * Every mirror call is fired and forgotten so an agent never waits on Plane. That
 * is right, but it means two writes for the same item are in flight at once
 * whenever an agent claims and finishes quickly — and each is several requests
 * long (look up a state, PATCH it, post a comment). If the claim's PATCH lands
 * after the completion's, Plane is left showing "In Progress" for an item that is
 * done, and it stays that way: nothing ever recomputes it.
 *
 * That is not cosmetic. The readiness gate answers "is this blocker finished?"
 * and "does this parent still have open children?" by reading Plane, so a lost
 * completion strands every item downstream of it.
 *
 * Chaining per item costs nothing — the common case has an empty chain — and
 * makes the last call win, which is the only ordering that can be correct.
 *
 * The map is module-level and therefore shared across callers, which is the whole
 * point rather than an accident: a container's rolled-up state (rollup.ts) and its
 * own claim or completion (mirror.ts) are writes to the same item from two
 * different causes, and they have to queue behind each other exactly as two
 * mirror writes do.
 *
 * Scope: one gateway process. Two replicas would need Plane-side conditional
 * writes, which Plane does not offer; the lease table remains the source of
 * truth either way, so the failure would stay confined to the display.
 */
const chains = new Map<string, Promise<void>>();

export function serial(workItemId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(workItemId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // a failed predecessor must not block the rest
  chains.set(workItemId, next);
  void next
    .finally(() => {
      // Only the tail clears the entry, or a slow early write would drop a chain
      // that later calls are still queued behind.
      if (chains.get(workItemId) === next) chains.delete(workItemId);
    })
    // The cleanup is a second branch off `next`, so a rejection travels down it
    // as well as to the caller. Nobody is listening on this one, and since
    // `mirrorClaim` began throwing to trigger a rollback that surfaces as an
    // unhandled rejection -- which newer Node treats as fatal. The caller still
    // gets the error through the returned promise; this only silences the copy.
    .catch(() => {});
  return next;
}
