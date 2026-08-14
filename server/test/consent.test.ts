import { describe, expect, it } from 'vitest';
import { consentPage, defaultAgentLabel } from '../src/oauth.js';
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

/**
 * The agent name is the holder identity — `holder` is `agent:<name>`, and every
 * lease, takeover check and revocation keys on it. So it has to be unique per
 * concurrently-running agent, and it has to mean something to whoever reads the
 * board. The field was prefilled with `worker-1`, which delivered neither, and
 * made the failure the default rather than an edge case:
 *
 *   - Accept it on a second machine and the mint upserts on name. The ownership
 *     guard only refuses a DIFFERENT Plane user, so a same-owner re-mint passes
 *     and silently rotates the first machine's token. That box then gets
 *     UNAUTHENTICATED with nothing to explain it.
 *   - Two agents under one name are one holder, so leases give them no mutual
 *     exclusion at all and `held` reports one agent's work as the other's.
 *
 * Both were reported from a real fleet. The client registration is a better
 * answer than anything a person types, because it is already the thing that
 * should be unique: one installation.
 */
describe('the agent name a sign-in defaults to', () => {
  const client = (clientId: string, clientName: string | null) => ({
    clientId,
    redirectUris: ['https://example.test/cb'],
    clientName,
  });

  it('is stable for one installation, so signing in again re-authenticates it', () => {
    // The property that stops a second sign-in minting an agent beside the
    // first. Same client, same label, same agent_token row.
    const c = client('sync_client_a4f2c1d9e8b7', 'Claude Code');
    expect(defaultAgentLabel(c)).toBe(defaultAgentLabel(c));
  });

  it('differs between two installs of the same client', () => {
    // The one that matters most: two boxes both running Claude Code register
    // under the same NAME, so the name alone cannot separate them. Getting this
    // wrong is the silent-token-rotation bug, reintroduced.
    const one = defaultAgentLabel(client('sync_client_a4f2c1d9e8b7', 'Claude Code'));
    const two = defaultAgentLabel(client('sync_client_ffffffffffff', 'Claude Code'));
    expect(one).not.toBe(two);
  });

  it('stays readable, because a human reads it off the board', () => {
    // `agent:you/9f3c2a` on a contested item tells nobody anything. The client's
    // own name is already the most useful thing available.
    expect(defaultAgentLabel(client('sync_client_a4f2c1d9e8b7', 'Claude Code'))).toMatch(
      /^claude-code-/,
    );
  });

  it('still produces a usable name when the client registered without one', () => {
    // client_name is optional in RFC 7591, and a name that throws or comes back
    // empty would block the sign-in entirely.
    const anon = defaultAgentLabel(client('sync_client_a4f2c1d9e8b7', null));
    expect(anon).toMatch(/^agent-/);
    expect(anon).not.toBe(defaultAgentLabel(client('sync_client_ffffffffffff', null)));
  });

  it('survives a client name that is punctuation, and cannot escape its own namespace', () => {
    // The label is concatenated as `<owner>/<label>`, so a `/` here would let a
    // client claim another person's namespace.
    const odd = defaultAgentLabel(client('sync_client_a4f2c1d9e8b7', '../../root user!'));
    expect(odd).not.toMatch(/[/\\]/);
    expect(odd).toMatch(/^[a-z0-9._-]+$/);
  });

  it('is what the form offers, so nobody has to think about it', () => {
    const html = consentPage({
      action: '/oauth/authorize',
      hidden: {},
      agentDefault: 'claude-code-a4f2c1',
    });
    expect(html).toContain('value="claude-code-a4f2c1"');
    // And it must not be mandatory: a caller who clears it gets the default
    // rather than a refusal.
    expect(/<input name="agent"[^>]*\srequired/.test(html)).toBe(false);
    // The name it used to ship, which is the collision this replaced.
    expect(html).not.toContain('value="worker-1"');
  });
});
