import { execFileSync } from 'node:child_process';
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
});
