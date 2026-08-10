import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * The liveness chain, end to end, because every link of it was broken at once
 * and each break was silent.
 *
 * Keeping a claim alive is a process now rather than an obligation on the model
 * — that was SYNC-73, and the reasoning holds. But the process only works if a
 * hook writes a credential to a file the monitor then reads, and on 2026-08-10
 * that chain had three independent faults, any one of them sufficient:
 *
 *   1. The PostToolUse matcher named `mcp__sync__claim`. A plugin's MCP server
 *      is namespaced by the plugin, so the tool is `mcp__plugin_sync_sync__claim`
 *      and the hook never fired.
 *   2. Harvest read `.tool_response.watchUrl`. An MCP tool result is a
 *      CallToolResult whose payload is a JSON *string* in a content block, so
 *      the field was never there.
 *   3. The monitor read `${CLAUDE_SESSION_ID:-default}.watch` while the hook
 *      wrote the real session id. CLAUDE_SESSION_ID is not a variable Claude
 *      Code sets, so the monitor polled a file nothing writes.
 *
 * Every one of those reports success. The hook exits 0, the monitor loops
 * happily, and the lease lapses on the ordinary timer as though no monitor
 * existed — an agent works for an hour, another agent takes the item, and the
 * two collide. Which is precisely the failure the monitor replaced.
 *
 * So the tests here run the real scripts against the real payload shape and
 * check that the writer and the reader agree on a filename. Testing either side
 * alone is what allowed this: both were individually reasonable.
 */

const plugin = fileURLToPath(new URL('../../plugin/', import.meta.url));
const bin = (name: string) => join(plugin, 'bin', name);

const WATCH_URL = 'https://gateway.invalid/v1/watch/T';

/** A claim response as an MCP client actually receives it. */
const CLAIM_RESULT = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({ lease: { workItemId: 'abc', epoch: 1 }, watchUrl: WATCH_URL }),
    },
  ],
};

const SESSION = 'c1d59356-ee1b-475d-8c6b-c9997941c519';

/** Run a plugin script with hook JSON on stdin, in a throwaway state directory. */
function run(
  script: string,
  args: string[],
  input: unknown,
  env: Record<string, string>,
): { stdout: string; state: string } {
  const state = mkdtempSync(join(tmpdir(), 'sync-liveness-'));
  const stdout = execFileSync(bin(script), args, {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: state, SYNC_STATE_DIR: state, ...env },
  });
  return { stdout, state };
}

describe('reading a field out of JSON', () => {
  /**
   * Pinned because the three backends disagreed, which is worse than any of them
   * failing: node indexed arrays with a string key and worked, python raised and
   * reported the field absent, and jq rejected `.0` outright. Whether the fence
   * worked depended on which parser the machine happened to have.
   */
  it('steps through an array index, whichever parser is installed', () => {
    const out = execFileSync(bin('sync-json'), ['.tool_response.content.0.text'], {
      input: JSON.stringify({ tool_response: CLAIM_RESULT }),
      encoding: 'utf8',
    });
    expect(JSON.parse(out).watchUrl).toBe(WATCH_URL);
  });

  it('says nothing for a path that is not there', () => {
    const out = execFileSync(bin('sync-json'), ['.tool_response.nope.3.deeper'], {
      input: JSON.stringify({ tool_response: CLAIM_RESULT }),
      encoding: 'utf8',
    });
    expect(out).toBe('');
  });
});

describe('harvesting the credential from a claim', () => {
  /**
   * Which shape a tool result arrives in is not this script's decision, and
   * betting on one is what shipped: it read `.tool_response.watchUrl`, the MCP
   * form does not have it, and the failure was total and silent. Each of these
   * is a shape some real caller produces, so each is tried.
   */
  const shapes: Array<[string, unknown]> = [
    ['a plain object, as REST and stdio return', { watchUrl: WATCH_URL }],
    [
      'structured output',
      { structuredContent: { watchUrl: WATCH_URL }, content: [] },
    ],
    ['a text content block', CLAIM_RESULT],
    [
      'a bare content array',
      [{ type: 'text', text: JSON.stringify({ watchUrl: WATCH_URL }) }],
    ],
  ];

  it.each(shapes)('finds the watch URL in %s', (_name, tool_response) => {
    const { state } = run(
      'sync-session',
      ['harvest'],
      { session_id: SESSION, tool_response },
      { CLAUDE_CODE_SESSION_ID: SESSION },
    );
    expect(readFileSync(join(state, `${SESSION}.watch`), 'utf8')).toBe(
      WATCH_URL,
    );
  });

  it('says so loudly when the claim carries a URL it cannot find', () => {
    // The anti-silence guard, and the one that would have caught all of this on
    // the first claim rather than weeks later. Harvest runs only after a claim,
    // and a claim always returns a watch URL — so finding none is never normal.
    const { stdout, state } = run(
      'sync-session',
      ['harvest'],
      { session_id: SESSION, tool_response: { somethingElse: true } },
      { CLAUDE_CODE_SESSION_ID: SESSION },
    );
    expect(stdout).toMatch(/NOT be kept alive/i);
    expect(readdirSync(state)).toEqual([]);
  });

  it('writes nothing at all when the session cannot be identified', () => {
    // Rather than to a shared or pid-derived name. A file only the writer can
    // find is indistinguishable from no file, except that it looks like success.
    const { state } = run(
      'sync-session',
      ['harvest'],
      { tool_response: CLAIM_RESULT },
      { CLAUDE_CODE_SESSION_ID: '' },
    );
    expect(readdirSync(state)).toEqual([]);
  });
});

describe('the writer and the reader agree on a filename', () => {
  /**
   * The bug the report named, and the one that survived being found once: the
   * comment in sync-session describes this exact mistake, and the monitor went
   * on making it in the next file along. Two processes deriving one path is a
   * missing primitive — so the path is derived in sync-paths.sh, and this checks
   * that both callers actually use it.
   */
  it('resolves the same watch file from the same environment', () => {
    const ask = (script: string) =>
      execFileSync(
        '/bin/sh',
        [
          '-c',
          `. "${bin('sync-paths.sh')}"; sync_watch_file "$(sync_session_id)"`,
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: '/nonexistent',
            SYNC_STATE_DIR: '/state',
            CLAUDE_CODE_SESSION_ID: SESSION,
          },
        },
      ).trim();

    // Both scripts source the one helper, so the agreement is structural rather
    // than a coincidence two files maintain separately.
    for (const script of ['sync-session', 'sync-monitor']) {
      expect(readFileSync(bin(script), 'utf8')).toContain('sync-paths.sh');
    }
    expect(ask('sync-session')).toBe(`/state/${SESSION}.watch`);
  });

  it('has no fallback that invents a session name', () => {
    // `default` gave every window on the box one file and made "I do not know
    // which session this is" look like a valid answer.
    for (const script of ['sync-session', 'sync-monitor', 'sync-paths.sh']) {
      const text = readFileSync(bin(script), 'utf8');
      expect(text).not.toMatch(/:-default\}/);
      // The variable Claude Code does not set. Naming it is always a bug.
      expect(text).not.toMatch(/\$\{?CLAUDE_SESSION_ID/);
    }
  });

  it('tells the human when liveness is off rather than looping quietly', () => {
    const { stdout } = run('sync-session', ['preflight'], {}, { CLAUDE_CODE_SESSION_ID: '' });
    expect(stdout).toMatch(/not be kept alive/i);
  });
});

describe('the hook that starts the chain', () => {
  it('matches the tool name the plugin actually publishes', () => {
    // A plugin's MCP server is namespaced by the plugin, so the tool an agent
    // calls is mcp__plugin_sync_sync__claim. The matcher named mcp__sync__claim
    // and therefore never fired.
    const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8'));
    const matchers: string[] = hooks.hooks.PostToolUse.map((h: { matcher: string }) => h.matcher);
    const harvest = matchers.find((m) => new RegExp(m).test('mcp__plugin_sync_sync__claim'));
    expect(harvest).toBeTruthy();
    // And still fires without the plugin namespace, for a hand-added server.
    expect(new RegExp(harvest!).test('mcp__sync__claim')).toBe(true);
  });

  it('ships every script the hooks and monitor invoke', () => {
    // A sourced file that the plugin does not ship is a chain that breaks on
    // somebody else's machine and works on ours.
    for (const f of ['sync-paths.sh', 'sync-json', 'sync-session', 'sync-monitor']) {
      expect(existsSync(bin(f))).toBe(true);
    }
  });
});
