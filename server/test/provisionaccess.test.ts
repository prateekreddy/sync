import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * How the gateway's own Plane account gets into every project — and why that one
 * step cannot go through the public API the rest of provisioning uses.
 *
 * Plane blocks it twice, and neither block produces an error:
 *
 *   1. `GET /api/v1/workspaces/<slug>/projects/` filters to the projects you are
 *      already an active member of, plus public ones. A private project the
 *      service account was never added to is simply absent, so a loop over that
 *      list skips exactly the projects that need fixing and finishes cleanly.
 *   2. `POST /projects/<id>/members/` is guarded by ProjectAdminPermission,
 *      which wants an active member with role ADMIN *on that project*. Being a
 *      workspace admin does not satisfy it, so the account cannot let itself in
 *      even given the id.
 *
 * A version of provisioning that used the API for this shipped, reported success
 * on every run, and left a UI-made project answering 403 to every service-client
 * read. It was re-run twice against that workspace before anyone looked at the
 * queryset. This is a source-shape check because there is no Plane to test
 * against here — but the shape is the thing that was wrong.
 */
const deploy = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../deploy/${name}`, import.meta.url)), 'utf8');

const grant = deploy('grant_access.py');
const provision = deploy('provision.sh');
const planeApi = deploy('plane_api.py');

describe('granting the gateway its own project access', () => {
  it('enumerates projects through the ORM, not through the member-filtered API', () => {
    expect(grant).toMatch(/Project\.objects\.filter\(workspace=workspace\)/);
    // No HTTP client at all in this file. The whole point is that it does not
    // ask Plane's API which projects exist, because that answer is filtered to
    // the ones it is already in.
    expect(grant).not.toMatch(/urllib|requests|http/i);
  });

  it('repairs a membership that was switched off rather than treating it as present', () => {
    // A removed member leaves an is_active=False row. get_or_create would find
    // it, change nothing, and report the account a member of a project it still
    // cannot read.
    expect(grant).toMatch(/member\.is_active = True/);
    expect(grant).not.toMatch(/ProjectMember\.objects\.get_or_create/);
  });

  it('runs every time, before the optional project step', () => {
    const grantAt = provision.indexOf('grant_access.py');
    const projectIf = provision.indexOf('if [ -n "$PROJECT_ID_PREFIX" ]');
    const planeApiAt = provision.indexOf('plane_api.py "$BASE"');

    expect(grantAt).toBeGreaterThan(0);
    expect(projectIf).toBeGreaterThan(0);
    expect(planeApiAt).toBeGreaterThan(0);
    // Before the conditional, so no flag can switch it off — and before
    // plane_api.py, because adopting an existing project means listing it, and
    // Plane does not list a project you are not a member of.
    expect(grantAt).toBeLessThan(projectIf);
    expect(grantAt).toBeLessThan(planeApiAt);
  });

  it('fails the run when the grant does not report back', () => {
    // The failure being guarded is a step that quietly does less than it claims,
    // so "it printed nothing" has to be fatal rather than ignored.
    expect(grant).toMatch(/GRANT_JSON:/);
    expect(provision).toMatch(/GRANT_JSON:/);
    expect(provision).toMatch(/could not grant the gateway project access/);
  });

  it('says how many projects it touched', () => {
    // The predecessor covered fewer projects than it claimed and printed nothing
    // at all, which is why nobody could tell.
    expect(grant).toMatch(/"granted"/);
    expect(grant).toMatch(/"total"/);
    expect(provision).toMatch(/projects joined/);
  });

  it('leaves plane_api.py out of it entirely', () => {
    // plane_api.py still adds AGENTS to the one project a run asked for — that
    // is a project it is admin of by then, so the API can do it. What it must
    // not do is try to place the service account, which is the call that cannot
    // work and cannot report that it did not.
    expect(planeApi).not.toMatch(/users\/me/);
    expect(planeApi).not.toMatch(/service_account/);
    expect(planeApi).toMatch(/grant_access\.py/); // points at where it moved
  });

  it('pages through the project list where it still reads one', () => {
    // Reading `results` once covers 100 projects and then stops. Stopping early
    // does not fail here either: an identifier that already exists looks free,
    // and provisioning tries to create a second project with it.
    expect(planeApi).toMatch(/next_page_results/);
    expect(planeApi).toMatch(/next_cursor/);
  });
});
