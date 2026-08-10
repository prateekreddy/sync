import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

/**
 * Polling must leave the credential usable, because three different callers poll.
 *
 * Every GET rotates: the gateway retires the URL that was used and returns its
 * successor in the body. That makes every reader a writer, and only the monitor
 * kept the new value. The fence and the resume report dropped it, leaving a
 * credential the gateway had already retired — and the next poll of a retired
 * credential is answered 410, the same answer given when somebody else really
 * has taken the item.
 *
 * Measured live 2026-08-10, within a minute of a good claim: the fence refused a
 * push with "this work is no longer yours", the monitor announced the claim lost
 * and deleted the credential, and the lease then stopped being extended and
 * lapsed for real. Nobody had touched the item. An agent was told to discard
 * correct work and stopped from pushing it.
 */
describe('polling the watch credential', () => {
  /**
   * A fake gateway in its OWN process, which is not fussiness: the scripts are
   * driven with execFileSync, and that blocks Node's event loop, so a server
   * living in this process could never answer them. The first version of this
   * test hung for twenty seconds per poll and reported curl failing.
   *
   * It rotates like the real one — every GET retires the URL used and returns
   * its successor — and answers 410 to anything it has retired, which is exactly
   * what the real endpoint does and exactly what makes the fence cry theft.
   */
  const gateway = async () => {
    const port = 18100 + Math.floor(process.hrtime()[1] % 400);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-gw-')), 'gw.py');
    writeFileSync(
      script,
      [
        'import http.server, json, sys',
        'state = {"n": 0}',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        want = "/v1/watch/tok-%d" % state["n"]',
        '        if self.path != want:',
        '            self.send_response(410); self.end_headers(); return',
        '        state["n"] += 1',
        '        body = json.dumps({"watchUrl": "http://127.0.0.1:%d/v1/watch/tok-%d" % (PORT, state["n"]), "holding": "X"}).encode()',
        '        self.send_response(200)',
        '        self.send_header("content-type", "application/json")',
        '        self.send_header("content-length", str(len(body)))',
        '        self.end_headers(); self.wfile.write(body)',
        '    def log_message(self, *a): pass',
        'PORT = int(sys.argv[1])',
        'http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()',
      ].join('\n'),
    );
    const proc = spawn('python3', [script, String(port)], { stdio: 'ignore', detached: true });
    // Wait for it to accept, rather than sleeping a guessed amount.
    for (let i = 0; i < 100; i++) {
      try {
        execFileSync('curl', ['-sS', '-o', '/dev/null', `http://127.0.0.1:${port}/ping`], {
          timeout: 500,
        });
        break;
      } catch {
        execFileSync('sleep', ['0.05']);
      }
    }
    return { url: `http://127.0.0.1:${port}/v1/watch/tok-0`, stop: () => proc.kill() };
  };

  const poll = (file: string) =>
    execFileSync(
      '/bin/sh',
      ['-c', `SYNC_BIN="${join(plugin, 'bin')}"; . "$SYNC_BIN/sync-paths.sh"; sync_poll "${file}" "${file}.body"`],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: '/tmp' } },
    );

  it('keeps the replacement, so the next poll still works', async () => {
    const gw = await gateway();
    const file = join(mkdtempSync(join(tmpdir(), 'sync-poll-')), 'a.watch');
    writeFileSync(file, gw.url);

    expect(poll(file)).toBe('200');
    // This is the one that used to come back 410 and be reported to the agent as
    // somebody else taking its work.
    expect(poll(file)).toBe('200');
    expect(poll(file)).toBe('200');
    expect(readFileSync(file, 'utf8')).toContain('tok-3');

    gw.stop();
  }, 30_000);

  it('leaves a credential the gateway has retired alone', async () => {
    // Ignorance, not a verdict: a file that was never rotated forward is stale,
    // and the honest answer is the gateway's, unchanged.
    const gw = await gateway();
    const file = join(mkdtempSync(join(tmpdir(), 'sync-poll-')), 'a.watch');
    writeFileSync(file, gw.url);

    expect(poll(file)).toBe('200');
    writeFileSync(file, gw.url); // put the retired one back
    expect(poll(file)).toBe('410');

    gw.stop();
  }, 30_000);
});
