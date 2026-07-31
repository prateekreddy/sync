import { describe, expect, it } from 'vitest';
import { consentPage } from '../src/oauth.js';
import { resolveProject } from '../src/mint.js';

/**
 * The consent screen asked people to paste "the uuid in the project's URL in
 * Plane".
 *
 * The `<select>` branch existed the whole time and was unreachable: the only call
 * that knew what a project was called — `visibleProjects` — reduced its answer to
 * a Set of ids before anything could render a name, and no call site ever passed
 * `projects`. Dead code that looked like a feature.
 *
 * It cannot be fixed by passing the list at render time either, because the list
 * takes the user's Plane token to fetch and they have not typed it yet. So there
 * are two paths, and both need pinning: the dropdown once a token is known, and a
 * text field that accepts a NAME for anyone without JavaScript.
 */
const page = (projects?: { id: string; name: string }[]) =>
  consentPage({
    action: '/oauth/authorize',
    hidden: { client_id: 'c', redirect_uri: 'http://x', code_challenge: 'y'.repeat(30) },
    ...(projects ? { projects } : {}),
  });

describe('the project field', () => {
  it('renders a dropdown of names when the projects are known', () => {
    const html = page([
      { id: 'p-1', name: 'Sync Platform' },
      { id: 'p-2', name: 'Bridge ETH BSC' },
    ]);

    expect(html).toContain('<select name="projectId"');
    expect(html).toContain('Sync Platform');
    expect(html).toContain('Bridge ETH BSC');
    expect(html).toContain('value="p-1"');
    // No uuid anywhere in the instructions — that phrasing was the problem.
    expect(html).not.toContain("the uuid in the project's URL");
  });

  it('offers an explicit "choose per call" option rather than a blank first row', () => {
    // Leaving the binding off is a real choice — it is what a conversational
    // agent working across projects wants — so it has to be selectable and named,
    // not something you get by not touching the control.
    const html = page([{ id: 'p-1', name: 'Sync Platform' }]);
    expect(html).toContain('<option value="">— choose per call —</option>');
  });

  it('falls back to a text field that asks for a name OR an id', () => {
    const html = page();
    expect(html).toContain('name="projectId"');
    expect(html).toContain('name or id');
    expect(html).not.toContain("the uuid in the project's URL");
  });

  it('carries the script that upgrades the field once a token is entered', () => {
    const html = page();
    expect(html).toContain("fetch('/oauth/projects'");
  });

  it('guards the upgrade script against a field that is already a dropdown', () => {
    // The script ships on every render, so it has to recognise when the server
    // already answered the question and leave the control alone — otherwise it
    // would replace a correct <select> with one built from a second fetch.
    const html = page([{ id: 'p-1', name: 'Sync Platform' }]);
    expect(html).toContain("pid.tagName === 'SELECT'");
  });

  it('escapes project names, which are user-controlled', () => {
    const html = page([{ id: 'p-1', name: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('resolving what someone typed', () => {
  const projects = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'Sync Platform' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Bridge ETH BSC' },
  ];

  it('accepts the id, which is what the dropdown submits', () => {
    expect(resolveProject(projects, projects[1]!.id)?.name).toBe('Bridge ETH BSC');
  });

  it('accepts the name, so the no-JavaScript path is usable', () => {
    expect(resolveProject(projects, 'Sync Platform')?.id).toBe(projects[0]!.id);
  });

  it('ignores case and surrounding whitespace, because people type', () => {
    expect(resolveProject(projects, '  bridge eth bsc ')?.id).toBe(projects[1]!.id);
  });

  it('prefers an id over a name when something matches both', () => {
    // Contrived, but the precedence has to be decided rather than incidental:
    // an id is unambiguous and a name is not.
    const odd = [
      { id: 'shared', name: 'other' },
      { id: 'other', name: 'shared' },
    ];
    expect(resolveProject(odd, 'shared')?.name).toBe('other');
  });

  it('returns null for something that matches nothing', () => {
    expect(resolveProject(projects, 'Not A Project')).toBeNull();
  });

  it('returns null rather than a false match when the list is empty', () => {
    expect(resolveProject([], 'Sync Platform')).toBeNull();
  });
});
