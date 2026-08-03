import type { Actor } from './auth.js';
import { GatewayError } from './errors.js';
import type { PlaneClient } from './plane.js';

interface VisibleProject {
  id: string;
  name: string;
}

/**
 * May this caller read this project at all?
 *
 * A token's `default_project_id` was a convenience default, never a boundary, and
 * the read tools imposed no boundary either: `find`, `tree` and `board` called the
 * gateway's own service account, which can see every project in the workspace. So
 * an agent that named some other project id got that project's items, titles,
 * descriptions and lease state back, member or not. `search` was the exception,
 * and its comment gave the reasoning that had simply not been applied to the
 * others (SYNC-64).
 *
 * The decision, now recorded in docs/architecture.md: **agent tokens are scoped to
 * what their own Plane user can see.** Minting derives an agent token from a
 * human's Plane token and only ever reduces privilege; letting reads bypass that
 * made the reduction cosmetic.
 *
 * The interesting part is what this is NOT. The obvious fix — swap the service
 * account for `plane.as(actor.planeToken)` in each tool — is wrong, because the
 * same service account underpins the readiness gate, which must see blockers and
 * children in projects the caller cannot read. Scope the gate and it fails open on
 * exactly the items it exists to withhold: an unreadable blocker would look like
 * no blocker.
 *
 * So authority is checked once, at the door, and separately from how the data is
 * fetched. Past that check the caller is entitled to this project's contents, so
 * the service account reading them returns the same rows the caller's own token
 * would — while the gate keeps the workspace-wide view it needs to be strict.
 * "What the gate must evaluate" and "what the caller may be told" become two
 * questions with two answers, which is what they always were.
 */

/**
 * How long a token's project list is trusted.
 *
 * This sits in front of every project-scoped read, so without a cache it doubles
 * the request count of the whole surface. Short, because the failure it bounds is
 * an agent removed from a project keeping read access for up to a minute — an
 * access change is not an emergency revocation, and `revoke` kills the token
 * outright and is not cached.
 */
const TTL_MS = 60_000;

interface Entry {
  at: number;
  projects: VisibleProject[];
}

const cache = new Map<string, Entry>();

/** Drops a token's cached project list — for tests, and for an explicit refresh. */
export function forgetAccess(holder?: string): void {
  if (holder) cache.delete(holder);
  else cache.clear();
}

/**
 * The projects this caller can see, cached per agent.
 *
 * Goes through `plane.as(token)` rather than the raw helper the consent screen
 * uses. That helper calls `fetch` directly, outside `PlaneClient`, so it shares
 * none of the backoff or rate-limit budget every other Plane call goes through —
 * tolerable for a once-per-sign-in screen, not for something now in front of
 * every project-scoped read. It also could not be faked, which is how the first
 * version of this check broke a test that had no business knowing about it.
 *
 * Keyed by holder rather than by the token itself: one agent has one Plane token,
 * and a map keyed on secrets is a map that eventually gets logged.
 */
export async function projectsFor(
  plane: PlaneClient,
  actor: Actor,
): Promise<VisibleProject[]> {
  if (!actor.planeToken) {
    throw new GatewayError(
      'FORBIDDEN',
      'This agent has no Plane identity, so there is no access to check against. ' +
        'Re-mint its token from a Plane personal token.',
    );
  }

  const hit = cache.get(actor.holder);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.projects;

  // Not caught. A failure here must refuse rather than fall through to the
  // service account, which is the whole defect: an access check that fails open
  // is an access check that does nothing on the day it matters.
  const projects = await plane.as(actor.planeToken).listProjects();
  const visible = projects.map((p) => ({ id: p.id, name: p.name }));
  cache.set(actor.holder, { at: Date.now(), projects: visible });
  return visible;
}

/**
 * Refuse unless this caller's own Plane user can see the project.
 *
 * Names what the caller CAN see. An agent given a project id it cannot use needs
 * to know which ones it may use, or its only recovery is to guess — and the
 * message is not a leak, since it lists exactly what this token already had the
 * authority to enumerate for itself.
 */
export async function assertCanRead(
  plane: PlaneClient,
  actor: Actor,
  projectId: string,
): Promise<void> {
  const projects = await projectsFor(plane, actor);
  if (projects.some((p) => p.id === projectId)) return;

  throw new GatewayError(
    'FORBIDDEN',
    `Your Plane user is not a member of project ${projectId}`,
    {
      projectId,
      visibleProjects: projects.map((p) => ({ id: p.id, name: p.name })),
    },
  );
}
