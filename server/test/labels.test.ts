import { describe, expect, it } from 'vitest';
import { editDistance, resolveLabels } from '../src/labels.js';
import { PlaneClient } from '../src/plane.js';
import type { Label } from '../src/plane.js';
import { GatewayError } from '../src/errors.js';

/**
 * Plane takes label uuids; every human and every agent writes names. Until this
 * resolved, `capture(labels: ["backend"])` failed outright — which is why nothing
 * on the board carried a label, and why capability routing (which matches label
 * names) had nothing to match against.
 */
const ID = {
  backend: '11111111-1111-4111-8111-111111111111',
  needsHuman: '22222222-2222-4222-8222-222222222222',
  fresh: '33333333-3333-4333-8333-333333333333',
};

/** A PlaneClient with the two label calls stubbed and every call recorded. */
const fakePlane = (existing: Label[], calls: string[] = []) => {
  let labels = [...existing];
  const client = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    labels: async (_p: string, ttlMs?: number) => {
      calls.push(ttlMs === 0 ? 'labels:fresh' : 'labels');
      return labels;
    },
    createLabel: async (_p: string, name: string) => {
      calls.push(`create:${name}`);
      const made = { id: ID.fresh, name };
      labels = [...labels, made];
      return made;
    },
  });
  return { client: client as PlaneClient, calls };
};

describe('label resolution', () => {
  it('turns a name into the existing label id', async () => {
    const { client } = fakePlane([{ id: ID.backend, name: 'backend' }]);
    expect(await resolveLabels(client, 'p', ['backend'])).toEqual([ID.backend]);
  });

  it('matches whatever case the caller used', async () => {
    const { client, calls } = fakePlane([{ id: ID.backend, name: 'Backend' }]);
    expect(await resolveLabels(client, 'p', ['BACKEND'])).toEqual([ID.backend]);
    expect(calls).not.toContain('create:BACKEND');
  });

  it('passes a uuid through untouched, so existing callers keep working', async () => {
    const { client, calls } = fakePlane([]);
    expect(await resolveLabels(client, 'p', [ID.backend])).toEqual([ID.backend]);
    expect(calls).toEqual([]); // no lookup needed at all
  });

  it('creates a label that does not exist yet', async () => {
    const { client, calls } = fakePlane([]);
    expect(await resolveLabels(client, 'p', ['frontend'])).toEqual([ID.fresh]);
    expect(calls).toContain('create:frontend');
  });

  it('re-reads before creating, in case another agent just made it', async () => {
    // The cache is a minute stale by design. Creating on a stale miss is how a
    // project ends up with two labels called 'backend', which is worse than none.
    const { client, calls } = fakePlane([{ id: ID.backend, name: 'backend' }]);
    await resolveLabels(client, 'p', ['nope']);
    expect(calls).toEqual(['labels', 'labels:fresh', 'create:nope']);
  });

  it('creates a load-bearing label when the project simply lacks it', async () => {
    // Exact match is not a near miss — a project without `needs-human` should get
    // one, which is the case that made this necessary in the first place.
    const { client, calls } = fakePlane([]);
    expect(await resolveLabels(client, 'p', ['needs-human'])).toEqual([ID.fresh]);
    expect(calls).toContain('create:needs-human');
  });

  it('refuses a name one keystroke from a label that gates claiming', async () => {
    // 'needs-humans' would be created, look right on the board, and withhold
    // nothing. The requested failure is silent, so refuse instead of guessing.
    const { client, calls } = fakePlane([]);
    await expect(resolveLabels(client, 'p', ['needs-humans'])).rejects.toThrow(GatewayError);
    await expect(resolveLabels(client, 'p', ['blockd'])).rejects.toThrow(/blocked/);
    expect(calls.filter((c) => c.startsWith('create:'))).toEqual([]);
  });

  it('still allows an ordinary name that merely looks similar', async () => {
    // 'blocking' is 3 edits from 'blocked' and a perfectly reasonable label.
    const { client } = fakePlane([]);
    await expect(resolveLabels(client, 'p', ['blocking'])).resolves.toEqual([ID.fresh]);
  });

  it('drops blanks and collapses repeats', async () => {
    const { client, calls } = fakePlane([{ id: ID.backend, name: 'backend' }]);
    expect(await resolveLabels(client, 'p', ['backend', ' ', 'backend', 'BACKEND'])).toEqual([
      ID.backend,
    ]);
    expect(calls.filter((c) => c.startsWith('create:'))).toEqual([]);
  });

  it('reuses a label it created earlier in the same call', async () => {
    const { client, calls } = fakePlane([]);
    expect(await resolveLabels(client, 'p', ['new-one', 'new-one'])).toEqual([ID.fresh]);
    expect(calls.filter((c) => c.startsWith('create:'))).toEqual(['create:new-one']);
  });
});

describe('editDistance', () => {
  it('measures single edits', () => {
    expect(editDistance('blocked', 'blocked')).toBe(0);
    expect(editDistance('blockd', 'blocked')).toBe(1);
    expect(editDistance('needs-humans', 'needs-human')).toBe(1);
    expect(editDistance('wontfx', 'wontfix')).toBe(1);
  });

  it('gives up early on lengths that cannot be near', () => {
    expect(editDistance('a', 'needs-refinement')).toBe(99);
  });
});
