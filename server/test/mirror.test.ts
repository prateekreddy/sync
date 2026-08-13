import { describe, expect, it } from 'vitest';
import { actorNote } from '../src/mirror.js';
import { PlaneClient } from '../src/plane.js';
import type { Actor } from '../src/auth.js';

/**
 * Plane renders the author of a comment itself. Provenance we add on top is only
 * worth the space when it says something Plane's own byline does not — otherwise
 * every mirrored comment on the board carries a line naming the person already
 * named directly above it.
 */
const actor = (over: Partial<Actor> = {}): Actor => ({
  name: 'me/worker-1',
  holder: 'agent:me/worker-1',
  capabilities: [],
  planeUserId: 'plane-user-1',
  defaultProjectId: null,
  principal: 'human:me@example.com',
  planeToken: 'plane_api_x',
  ...over,
});

/**
 * A PlaneClient whose only live call, `me()`, is stubbed. `as()` returns the same
 * object, because the production path re-authenticates as the agent before asking
 * — a fresh client there would bypass the stub and quietly test nothing.
 */
const planeAs = (email: string | Error, seen?: string[]): PlaneClient => {
  const client: PlaneClient = Object.assign(new PlaneClient('http://plane.invalid', 'svc', 'ws'), {
    as: () => client,
    me: async () => {
      seen?.push('me');
      if (email instanceof Error) throw email;
      return { id: 'plane-user-1', email };
    },
  });
  return client;
};

describe('mirrored comment provenance', () => {
  it('says nothing extra when Plane will show the principal as the author', async () => {
    // The self-service case: the agent writes with its owner's own Plane token,
    // so "for human:x" names the same person as the byline.
    const note = await actorNote(planeAs('me@example.com'), actor(), 'Claimed.');
    expect(note).toBe('<p>Claimed.</p>');
  });

  it('names the human when the agent has a Plane account of its own', async () => {
    // The provisioned case: Plane shows "sync-worker-3" and only the gateway
    // knows who that is acting for.
    const note = await actorNote(
      planeAs('sync-worker-3@agents.local'),
      actor({ planeUserId: 'plane-user-2', principal: 'human:alice@example.com' }),
      'Claimed.',
    );
    expect(note).toContain('for human:alice@example.com');
  });

  it('names both when the write lands as the shared service account', async () => {
    // No token of its own: Plane's byline identifies neither the agent nor the
    // human, so dropping either would lose the only record there is.
    const note = await actorNote(planeAs('svc@example.com'), actor({ planeToken: null }), 'Done.');
    expect(note).toContain('by agent:me/worker-1');
    expect(note).toContain('for human:me@example.com');
  });

  it('keeps printing provenance when Plane cannot be asked', async () => {
    // Redundant provenance is noise; missing provenance loses the only record of
    // who a machine write was made for. Fail towards keeping it.
    // A user id no other test has resolved, so the cache cannot answer for it.
    const note = await actorNote(
      planeAs(new Error('Plane down')),
      actor({ planeUserId: 'plane-user-unreachable' }),
      'Claimed.',
    );
    expect(note).toContain('for human:me@example.com');
  });

  it('keeps printing when the principal is a bare name, not an account', async () => {
    // 'human:alice' from the CLI cannot be matched against a Plane account, so
    // it must not be silently assumed to be the author.
    const note = await actorNote(
      planeAs('alice@example.com'),
      actor({ planeUserId: 'plane-user-3', principal: 'human:alice' }),
      'Claimed.',
    );
    expect(note).toContain('for human:alice');
  });

  it('asks Plane once per agent, not once per comment', async () => {
    const seen: string[] = [];
    const plane = planeAs('cache@example.com', seen);
    const a = actor({ planeUserId: 'plane-user-cache', principal: 'human:cache@example.com' });
    expect(await actorNote(plane, a, 'one')).toBe('<p>one</p>');
    expect(await actorNote(plane, a, 'two')).toBe('<p>two</p>');
    expect(seen).toEqual(['me']);
  });
});
