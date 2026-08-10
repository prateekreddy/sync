import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A plugin change nobody can install is a change that did not happen.
 *
 * `/plugin update` compares the installed version with the marketplace's and
 * says "already at the latest version" when they match — it does not look at the
 * files. So shipping a fix without bumping `plugin.json` leaves every existing
 * install on the old copy, and the only symptom is a reassuring message.
 *
 * Measured on the first real install, 2026-08-09: seventeen commits had touched
 * plugin/ since the version was set, including two hook fixes and every skill
 * update, and none of them were reachable by anyone who had installed it. The
 * failure is silent in both directions — the author sees a green push, the user
 * sees "latest".
 *
 * So: the version file must be touched no earlier than the last change to
 * anything else in the plugin. Comparing commit dates rather than contents keeps
 * this honest without a manifest of hashes to maintain.
 *
 * WHICH PART TO BUMP, because "it changed" is not the question:
 *
 *   patch  a fix. Nothing new to use, nothing removed, no config anyone writes
 *          changes shape. Almost everything here is this.
 *   minor  a new capability, or a new thing to configure. Something an existing
 *          user could now do that they could not before.
 *   major  something that already works stops working, or works differently.
 *
 * Written down because it was got wrong: 0.2.0 -> 0.3.0 -> 0.4.0 for two bug
 * fixes, which makes the number track that a change happened rather than what
 * kind, and leaves nothing to say with the minor when a real feature lands.
 */

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: `${import.meta.dirname}/../..`, encoding: 'utf8' }).trim();

const VERSION_FILE = 'plugin/.claude-plugin/plugin.json';

describe('the plugin version', () => {
  it('is bumped whenever anything else in the plugin changes', () => {
    let lastPluginChange: string;
    let lastVersionChange: string;
    try {
      // `:!` excludes the version file itself, so this is "the last time the
      // plugin's CONTENT moved" rather than "the last time anything did".
      lastPluginChange = git('log', '-1', '--format=%ct', '--', 'plugin/', `:!${VERSION_FILE}`);
      lastVersionChange = git('log', '-1', '--format=%ct', '--', VERSION_FILE);
    } catch {
      // No git history — a tarball, or a shallow checkout in CI. Nothing to
      // check, and failing here would be a test about the environment.
      return;
    }
    if (!lastPluginChange || !lastVersionChange) return;

    expect(
      Number(lastVersionChange),
      `${VERSION_FILE} was last touched before the plugin's contents changed. ` +
        'Bump the version, or every existing install stays on the old copy and ' +
        '`/plugin update` reports "already at the latest version".',
    ).toBeGreaterThanOrEqual(Number(lastPluginChange));
  });

  /**
   * Never goes backwards, which is the trap on the way to correcting an
   * over-bump. Two minors were spent on bug fixes; the fix is to make the NEXT
   * number a patch, not to reissue a lower one. `/plugin update` compares
   * versions, so an install sitting on the number you just walked back from is
   * offered nothing, forever, silently — the same failure as never bumping at
   * all, arrived at by trying to be tidy.
   */
  it('never goes backwards from what is already published', () => {
    const rank = (v: string): number => {
      const [maj = 0, min = 0, patch = 0] = v.split('.').map(Number);
      return maj * 1e6 + min * 1e3 + patch;
    };
    const versionIn = (text: string): string => JSON.parse(text).version;

    let published: string;
    try {
      published = versionIn(git('show', `HEAD:${VERSION_FILE}`));
    } catch {
      return; // No history, or the file is new. Nothing to have gone back from.
    }
    const current = versionIn(readFileSync(`${import.meta.dirname}/../../${VERSION_FILE}`, 'utf8'));

    expect(
      rank(current),
      `Plugin version went from ${published} to ${current}. Anyone already on ` +
        `${published} would never be offered an update again.`,
    ).toBeGreaterThanOrEqual(rank(published));
  });
});
