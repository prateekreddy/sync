import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * The one sync failure that produces no refusal (SYNC-117).
 *
 * Installing the plugin does not connect it: the hooks, the monitor and the
 * playbook come off disk, every tool comes from the gateway over an
 * authenticated connection, and completing that authentication needs a browser
 * and a person. So a freshly provisioned box has all of the former and none of
 * the latter — and because there is no `claim` tool to call, nothing refuses,
 * and the agent works with no lease at all. Reported from a fresh box on
 * 2026-08-10: no sync tool existed in-session for the first twenty minutes.
 *
 * Every other fault in this file announces itself. This one is an absence, which
 * is why it has to be announced from the outside.
 */
describe('a box that has never reached the gateway', () => {
  /**
   * With no gateway address there is nothing to sign in to, and the symptom is
   * identical to nobody having signed in. This is the one of the three causes
   * that can be known rather than guessed, so it is said on its own — sending
   * somebody to `/mcp` here is advice that cannot work, and advice that cannot
   * work is how a notice stops being read.
   */
  it('names an unset SYNC_MCP_URL, instead of hedging about sign-in', () => {
    const { stdout } = run(
      'sync-session',
      ['preflight'],
      {},
      { CLAUDE_CODE_SESSION_ID: SESSION, SYNC_MCP_URL: '' },
    );
    expect(stdout).toMatch(/SYNC_MCP_URL is not set/);
    expect(stdout).toMatch(/sync-setup/);
    // Says what will NOT fix it, because that is the wrong turn people take.
    expect(stdout).toMatch(/not a sign-in problem/i);
    expect(stdout).toMatch(/do not do tracked work/i);
    // And must not also offer the sign-in advice, which is the thing it is
    // correcting. Two notices that contradict each other are worse than one.
    expect(stdout).not.toMatch(/may not be connected/i);
  });

  it('says the tools may not be there, and names both ways out', () => {
    const { stdout } = run(
      'sync-session',
      ['preflight'],
      {},
      { CLAUDE_CODE_SESSION_ID: SESSION, SYNC_MCP_URL: 'https://gateway.example.dev/mcp' },
    );
    expect(stdout).toMatch(/may not be connected/i);
    // Both routes, because each is useless on the other kind of box: /mcp needs
    // somebody at a keyboard, and sync-connect is what a container has instead.
    expect(stdout).toMatch(/\/mcp/);
    expect(stdout).toMatch(/sync-connect/);
    // The instruction, not just the diagnosis. Without this the agent reads a
    // note about tooling and carries on doing exactly the unclaimed work the
    // notice exists to stop.
    expect(stdout).toMatch(/do not do tracked work/i);
  });

  it('stops saying it once a claim has been harvested here', () => {
    // Keyed on "has this machine ever held a claim", not on "is this a new
    // session" — a connected box would otherwise be told this every time it
    // starts, and a notice that fires on every healthy session is one people
    // learn to scroll past before the day it is true.
    const { state } = run(
      'sync-session',
      ['harvest'],
      { session_id: SESSION, tool_response: CLAIM_RESULT },
      { CLAUDE_CODE_SESSION_ID: SESSION },
    );
    const stdout = execFileSync(bin('sync-session'), ['preflight'], {
      input: '{}',
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: state,
        SYNC_STATE_DIR: state,
        CLAUDE_CODE_SESSION_ID: SESSION,
      },
    });
    expect(stdout).toBe('');
  });

  it('does not count a claim whose watch URL could not be read', () => {
    // That harvest failed, so nothing proves this box ever authenticated —
    // and it is exactly the case where a further warning is warranted rather
    // than suppressed.
    const { state } = run(
      'sync-session',
      ['harvest'],
      { session_id: SESSION, tool_response: { somethingElse: true } },
      { CLAUDE_CODE_SESSION_ID: SESSION },
    );
    expect(existsSync(join(state, 'connected'))).toBe(false);
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

/**
 * What the push fence is allowed to touch.
 *
 * hooks.json declares `"if": "Bash(git push*)"` beside the matcher and it reads
 * as though only a push is fenced. Measured 2026-08-10: it does not gate, and
 * commands containing no git and no push at all were run through the fence.
 * While the watch credential was dead that made the fence deny EVERY shell
 * command, telling the agent its work had been taken — and it made every
 * ordinary Bash call pay an HTTP round trip with a ten second timeout.
 *
 * Getting the declarative condition right is not the fix. A guard that fails
 * open on its own scope is the matcher-that-never-matched again, so the script
 * decides from the command it was given, and that is what is pinned here.
 */
describe('what the push fence acts on', () => {
  // Points at a gateway that is not there. A command in scope would hang on it
  // and fail the test; one out of scope must never reach it.
  const fence = (command: string) => {
    const state = mkdtempSync(join(tmpdir(), 'sync-fence-'));
    writeFileSync(join(state, `${SESSION}.watch`), 'http://127.0.0.1:9/v1/watch/dead');
    return spawnSync(bin('sync-session'), ['fence'], {
      input: JSON.stringify({ session_id: SESSION, tool_input: { command } }),
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: state,
        SYNC_STATE_DIR: state,
        CLAUDE_CODE_SESSION_ID: SESSION,
      },
    });
  };

  const outOfScope = [
    'echo hello',
    'ls -la',
    'npm test',
    'git status',
    'git commit -m "push the button"',
    'cat notes-about-git-push.md',
  ];

  it.each(outOfScope)('does not contact the gateway for: %s', (command) => {
    // stderr is the discriminator, not stdout. A fence that DOES reach for the
    // credential and fails to connect says so on stderr ("could not reach the
    // gateway; allowing the push unchecked") while writing nothing to stdout --
    // so asserting on stdout alone would have passed before this fix too.
    const r = fence(command);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('');
  });

  const inScope = [
    'git push',
    'git push --force origin main',
    'git -C /repo push',
    'npm test && git push',
  ];

  it.each(inScope)('does check the lease for: %s', (command) => {
    // The gateway is unreachable here, which is ignorance rather than a verdict,
    // so the fence allows -- and says so on stderr. That message is the proof it
    // looked, which is what this asserts.
    expect(fence(command).stderr).toMatch(/could not reach the gateway/i);
  });

  /**
   * What the fence does with each answer, which is the rule the whole design
   * rests on: only a VERDICT may block a push, never ignorance.
   *
   * A gateway that answers on demand, so the three cases are driven for real
   * rather than reasoned about.
   */
  const answering = async (status: number, body = '{}') => {
    const port = 18900 + Math.floor(process.hrtime()[1] % 300);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-gw3-')), 'gw.py');
    writeFileSync(
      script,
      [
        'import http.server, sys',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        b = BODY.encode()',
        '        self.send_response(STATUS)',
        '        self.send_header("content-type", "application/json")',
        '        self.send_header("content-length", str(len(b)))',
        '        self.end_headers(); self.wfile.write(b)',
        '    def log_message(self, *a): pass',
        'PORT, STATUS, BODY = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]',
        'http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()',
      ].join('\n'),
    );
    const proc = spawn('python3', [script, String(port), String(status), body], {
      stdio: 'ignore',
      detached: true,
    });
    for (let i = 0; i < 100; i++) {
      try {
        execFileSync('curl', ['-sS', '-o', '/dev/null', `http://127.0.0.1:${port}/x`], {
          timeout: 500,
        });
        break;
      } catch {
        execFileSync('sleep', ['0.05']);
      }
    }
    const state = mkdtempSync(join(tmpdir(), 'sync-fence2-'));
    writeFileSync(join(state, `${SESSION}.watch`), `http://127.0.0.1:${port}/v1/watch/c`);
    const r = spawnSync(bin('sync-session'), ['fence'], {
      input: JSON.stringify({ session_id: SESSION, tool_input: { command: 'git push' } }),
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: state,
        SYNC_STATE_DIR: state,
        CLAUDE_CODE_SESSION_ID: SESSION,
      },
    });
    proc.kill();
    return r;
  };

  it('refuses the push when the gateway says the work was taken', async () => {
    const r = await answering(410);
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    expect(r.stdout).toMatch(/no longer yours/i);
  }, 30_000);

  it('allows the push when the credential merely expired, and says why', async () => {
    // The case that used to arrive as 410. A laptop opened after a long weekend
    // refused every push and told the agent its work had been taken -- on a
    // credential that had done nothing but get old. Ignorance never blocks.
    const r = await answering(401, '{"error":"EXPIRED"}');
    expect(r.stdout).not.toContain('deny');
    expect(r.stderr).toMatch(/expired while you were away/i);
    // And it must not repeat the accusation in any form.
    expect(r.stderr).not.toMatch(/discard/i);
  }, 30_000);
});

/**
 * What the monitor does after a 410, which is an ordinary event and not a fault.
 *
 * A 410 means the credential is gone -- somebody else claimed the item, or the
 * lease was revoked. The monitor says so once, deletes the file, and that is
 * correct. What was not correct is that it also went to MAXIMUM backoff, and
 * backoff clears only on a 200. Having just deleted the credential it makes no
 * further requests, so no 200 can ever arrive: the monitor latched at 1020s per
 * pass for the rest of the session.
 *
 * Measured live 2026-08-10 on a real session: `sleep 1020` with 1016s elapsed,
 * and the claim made at 09:28:41 went unpolled until 09:33:52 -- 5m11s against a
 * default lease TTL of 600s. So one ordinary 410 left the NEXT lease unwatched
 * for most of its life, which is precisely the collision the monitor exists to
 * prevent.
 *
 * Driven through the real script rather than reasoned about, because the bug was
 * in the interaction between two branches that each read correctly on their own.
 * SYNC_POLL_SECONDS collapses the interval; MAX_BACKOFF is not configurable,
 * which is what makes this a decisive test -- if the latch returns, the monitor
 * sleeps 901s and the assertion times out rather than quietly passing.
 */
describe('the monitor after a verdict it cannot appeal', () => {
  const gateway = async () => {
    const port = 18600 + Math.floor(process.hrtime()[1] % 300);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-gw2-')), 'gw.py');
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
        '        body = json.dumps({"watchUrl": "http://127.0.0.1:%d/v1/watch/tok-%d" % (PORT, state["n"])}).encode()',
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
    return { port, stop: () => proc.kill() };
  };

  /** Poll a predicate rather than sleeping a guessed amount. */
  const until = async (what: string, ok: () => boolean, budgetMs = 15_000) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
  };

  it('picks up the next claim in one interval rather than seventeen minutes', async () => {
    const gw = await gateway();
    const base = `http://127.0.0.1:${gw.port}/v1/watch`;
    const dir = mkdtempSync(join(tmpdir(), 'sync-mon-'));
    const session = 'a-session';
    const file = join(dir, `${session}.watch`);

    // A credential this gateway has retired. Indistinguishable, by design, from
    // one cleared because another agent claimed the item -- both answer 410.
    writeFileSync(file, `${base}/tok-99`);

    const mon = spawn(join(plugin, 'bin', 'sync-monitor'), [], {
      stdio: 'ignore',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        SYNC_STATE_DIR: dir,
        CLAUDE_CODE_SESSION_ID: session,
        SYNC_POLL_SECONDS: '1',
      },
    });

    try {
      // It saw the verdict: the credential is removed, which is also what stops
      // the message repeating.
      await until('the retired credential to be discarded', () => !existsSync(file));

      // Now the agent claims something new, and harvest writes a live credential.
      writeFileSync(file, `${base}/tok-0`);

      // The whole point. Latched, the monitor is asleep for 901s and this times
      // out; unlatched, it polls on the next ordinary pass and rotates.
      await until('the new credential to be polled and rotated', () =>
        existsSync(file) ? readFileSync(file, 'utf8').includes('tok-1') : false,
      );
    } finally {
      mon.kill();
      gw.stop();
    }
  }, 40_000);
});

/**
 * The monitor says which of the three callers it is.
 *
 * The monitor, the push fence and the resume report all poll the same endpoint,
 * and only the monitor's poll is evidence that liveness is working. Being
 * indistinguishable on the wire meant the gateway read "something polled" as
 * "the monitor is running", so a session whose monitor was dead stayed silent as
 * long as an agent kept running `git push`. Pinned here rather than trusted,
 * because it is one word in one curl invocation and nothing else would notice
 * if it were dropped.
 */
describe('identifying the caller to the gateway', () => {
  /** A gateway that reports back the User-Agent it was given. */
  const echoUa = async () => {
    const port = 19300 + Math.floor(process.hrtime()[1] % 300);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-ua-')), 'gw.py');
    writeFileSync(
      script,
      [
        'import http.server, json, sys',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        b = json.dumps({"ua": self.headers.get("User-Agent", "")}).encode()',
        '        self.send_response(200)',
        '        self.send_header("content-type", "application/json")',
        '        self.send_header("content-length", str(len(b)))',
        '        self.end_headers(); self.wfile.write(b)',
        '    def log_message(self, *a): pass',
        'PORT = int(sys.argv[1])',
        'http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()',
      ].join('\n'),
    );
    const proc = spawn('python3', [script, String(port)], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 100; i++) {
      try {
        execFileSync('curl', ['-sS', '-o', '/dev/null', `http://127.0.0.1:${port}/x`], {
          timeout: 500,
        });
        break;
      } catch {
        execFileSync('sleep', ['0.05']);
      }
    }
    return { port, stop: () => proc.kill() };
  };

  const pollAs = (port: number, who?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-ua-'));
    const file = join(dir, 'a.watch');
    writeFileSync(file, `http://127.0.0.1:${port}/v1/watch/c`);
    const arg = who ? ` "${who}"` : '';
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `SYNC_BIN="${join(plugin, 'bin')}"; . "$SYNC_BIN/sync-paths.sh"; sync_poll "${file}" "${file}.body"${arg}`,
      ],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: dir } },
    );
    return JSON.parse(readFileSync(`${file}.body`, 'utf8')).ua as string;
  };

  it('sends sync-monitor when the monitor polls', async () => {
    const gw = await echoUa();
    try {
      expect(pollAs(gw.port, 'sync-monitor')).toBe('sync-monitor');
    } finally {
      gw.stop();
    }
  }, 30_000);

  it('never claims to be the monitor by default', async () => {
    // The fence and the resume report call sync_poll without saying who they
    // are. A default of "monitor" would make every `git push` look like proof
    // of liveness, which is the bug this exists to prevent.
    const gw = await echoUa();
    try {
      expect(pollAs(gw.port)).not.toMatch(/^sync-monitor/);
    } finally {
      gw.stop();
    }
  }, 30_000);
});

/**
 * A monitor that has been updated out from under itself.
 *
 * Claude Code starts a monitor once per session and freezes its plugin path, so
 * it keeps running the version installed when the session began. Hooks do not
 * work that way — they resolve the install on every invocation — so an update
 * leaves current hooks talking to a stale monitor for the life of that session.
 *
 * Measured 2026-08-10, minutes after updating to 0.4.4: monitors from 0.2.0 and
 * 0.4.4 running at once, and nothing reaps the old one. 0.2.0 predates the
 * shared-path fix and polls a file nothing writes, forever, while looking
 * perfectly healthy in `ps` — the exact failure 904f33b was about.
 */
describe('a monitor that has been superseded', () => {
  /** A plugin cache with our scripts at `version`, and `installed` recorded. */
  const cache = (version: string, installed: string) => {
    const home = mkdtempSync(join(tmpdir(), 'sync-cache-'));
    const root = join(home, 'cache', 'sync', 'sync', version);
    execFileSync('mkdir', ['-p', join(root, 'bin'), join(home, '.claude', 'plugins')]);
    for (const f of readdirSync(join(plugin, 'bin'))) {
      execFileSync('cp', [join(plugin, 'bin', f), join(root, 'bin', f)]);
    }
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'sync@sync': [{ installPath: join(home, 'cache', 'sync', 'sync', installed), version: installed }],
        },
      }),
    );
    return { home, monitor: join(root, 'bin', 'sync-monitor') };
  };

  const run = (
    c: { home: string; monitor: string },
    seconds: number,
    extraEnv: Record<string, string> = {},
  ) =>
    spawnSync('timeout', [String(seconds), c.monitor], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: c.home,
        CLAUDE_CONFIG_DIR: join(c.home, '.claude'),
        SYNC_STATE_DIR: join(c.home, 'state'),
        CLAUDE_CODE_SESSION_ID: 'a-session',
        SYNC_POLL_SECONDS: '1',
        ...extraEnv,
      },
    });

  /**
   * The same, but the installed version exists on disk too — which is the
   * ordinary case after an update, and the only one where handing over is
   * possible at all.
   *
   * The installed copy gets a marker line so the test can tell the two apart.
   * Without it, "still running" is equally consistent with the exec having
   * landed and with it having silently not happened, and those are the two
   * outcomes the whole change is about.
   */
  const cacheBoth = (version: string, installed: string) => {
    const c = cache(version, installed);
    const root = join(c.home, 'cache', 'sync', 'sync', installed);
    execFileSync('mkdir', ['-p', join(root, 'bin')]);
    for (const f of readdirSync(join(plugin, 'bin'))) {
      execFileSync('cp', [join(plugin, 'bin', f), join(root, 'bin', f)]);
    }
    execFileSync('sed', [
      '-i',
      `1a echo "MARKER the ${installed} monitor is the one running"`,
      join(root, 'bin', 'sync-monitor'),
    ]);
    return c;
  };

  /**
   * The ordinary case: an update landed and the new monitor is on disk.
   *
   * Stopping here used to be the whole behaviour, and it left the session with
   * no liveness until somebody started a new one. Worse, the obvious repair
   * raced with it: `/reload-plugins` finds this process still alive under the
   * monitor's name, dedupes against it and starts nothing, and then this one
   * wakes up and exits. The reload meant to fix liveness guaranteed there was
   * none.
   */
  it('hands over to the new version rather than leaving the session unwatched', () => {
    const r = run(cacheBoth('0.4.6', '0.9.9'), 6);
    expect(r.stdout).toMatch(/handing over/i);
    // The proof, and the reason the marker exists: execution actually moved
    // into the installed copy. "Still running" alone cannot tell that apart
    // from the exec having quietly not happened.
    expect(r.stdout).toMatch(/MARKER the 0\.9\.9 monitor is the one running/);
    // And it must not tell anyone their claims have stopped being kept alive,
    // because they have not — that is the difference this makes.
    expect(r.stdout).not.toMatch(/will NOT be kept alive/i);
    // Killed by the timeout: the replacement is looping, not exited.
    expect(r.status).not.toBe(0);
  }, 30_000);

  it('stops when there is nothing to hand over to', () => {
    // The install record names a version whose monitor is not on disk. Handing
    // over is impossible, so the old behaviour is still right — and the message
    // has to name the action, because now somebody does have to take one.
    const r = run(cache('0.4.6', '0.9.9'), 10);
    expect(r.stdout).toMatch(/0\.9\.9 is now installed/);
    expect(r.stdout).toMatch(/will NOT be kept alive/i);
    expect(r.stdout).toMatch(/reload-plugins/);
    // Stopped on purpose, not killed by the timeout.
    expect(r.status).toBe(0);
  }, 30_000);

  it('stops rather than hopping for ever', () => {
    // The exit condition is a file Claude Code owns and this process does not,
    // so an install record that keeps naming somewhere else would spin — while
    // looking like a perfectly healthy monitor in `ps`, which is the exact
    // shape of failure this whole check exists to end.
    const r = run(cacheBoth('0.4.6', '0.9.9'), 10, { SYNC_MONITOR_HOPS: '5' });
    expect(r.stdout).not.toMatch(/handing over/i);
    expect(r.stdout).toMatch(/will NOT be kept alive/i);
    expect(r.status).toBe(0);
  }, 30_000);

  it('keeps running when it is the installed version', () => {
    // The failure mode to avoid is worse than the one being fixed: a monitor
    // that stops when it did not have to leaves the session with no liveness.
    const r = run(cache('0.4.6', '0.4.6'), 3);
    expect(r.stdout).not.toMatch(/now installed/);
    // Killed by the timeout, which is the proof it was still looping.
    expect(r.status).not.toBe(0);
  }, 30_000);

  it('carries on when there is no install record to read', () => {
    // Any doubt answers "carry on". This file is Claude Code's, not ours, and a
    // monitor that stops because it could not find it would be a plugin update
    // away from disabling liveness for everyone.
    const c = cache('0.4.6', '0.4.6');
    execFileSync('rm', ['-f', join(c.home, '.claude', 'plugins', 'installed_plugins.json')]);
    const r = run(c, 3);
    expect(r.stdout).not.toMatch(/now installed/);
    expect(r.status).not.toBe(0);
  }, 30_000);
});

/**
 * A monitor whose plugin has been deleted out from under it.
 *
 * Found on the other box, 2026-08-10: a monitor alive for 44 minutes from
 * .../cache/sync/sync/0.4.7/bin/sync-monitor while the whole plugins/cache tree
 * was gone and installed_plugins.json did not exist. The script is already
 * parsed and the sourced functions are in memory, so it polls perfectly well
 * from a path that no longer exists — and a reinstall starts a second one
 * beside it.
 *
 * The supersession check cannot catch this: it is deliberately conservative and
 * answers "carry on" whenever it cannot read Claude Code's private state, which
 * is precisely the state an uninstall leaves behind. A process whose own bin
 * directory is gone needs no external file to know it has been uninstalled.
 */
describe('a monitor whose plugin has been deleted', () => {
  it('stops, and says something true about why', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sync-gone-'));
    const root = join(home, 'cache', 'sync', 'sync', '0.4.8');
    execFileSync('mkdir', ['-p', join(root, 'bin'), join(home, '.claude', 'plugins')]);
    for (const f of readdirSync(join(plugin, 'bin'))) {
      execFileSync('cp', [join(plugin, 'bin', f), join(root, 'bin', f)]);
    }
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'sync@sync': [{ installPath: root, version: '0.4.8' }] } }),
    );

    const mon = spawn(join(root, 'bin', 'sync-monitor'), [], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        SYNC_STATE_DIR: join(home, 'state'),
        CLAUDE_CODE_SESSION_ID: 'a-session',
        SYNC_POLL_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let said = '';
    mon.stdout.on('data', (b: Buffer) => (said += b.toString()));

    const ended = new Promise<number | null>((r) => mon.on('exit', (code) => r(code)));
    await new Promise((r) => setTimeout(r, 1500));
    // The uninstall, while it is running.
    execFileSync('rm', ['-rf', join(home, 'cache')]);

    const code = await Promise.race([
      ended,
      new Promise<'never'>((r) => setTimeout(() => r('never'), 12_000)),
    ]);

    expect(code).not.toBe('never');
    expect(said).toMatch(/removed from disk/i);
    // And it must not claim to have been superseded by a version, which is what
    // the first cut said: "but uninstalled is now installed".
    expect(said).not.toMatch(/is now installed/i);
    mon.kill();
  }, 30_000);
});

/**
 * The monitor's side of retirement (SYNC-115).
 *
 * The gateway answers a poll with `retired` once nothing live is left under the
 * credential. The monitor has to act on that quietly: drop the file, say
 * nothing, and keep running. Each of those three is a separate way to get it
 * wrong — leaving the file keeps the credential renewed forever, saying
 * something turns the ordinary end of a day into a notification, and exiting
 * would leave the session unwatched for whatever it claims next.
 */
describe('a monitor told its work is all finished', () => {
  const retiringGateway = async () => {
    const port = 18900 + Math.floor(process.hrtime()[1] % 300);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-gw4-')), 'gw.py');
    writeFileSync(
      script,
      [
        'import http.server, json, sys',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        body = json.dumps({"retired": True}).encode()',
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
    return { port, stop: () => proc.kill() };
  };

  it('drops the credential, stays quiet, and keeps running', async () => {
    const gw = await retiringGateway();
    const dir = mkdtempSync(join(tmpdir(), 'sync-ret-'));
    const session = 'finished-session';
    const file = join(dir, `${session}.watch`);
    writeFileSync(file, `http://127.0.0.1:${gw.port}/v1/watch/tok`);

    const out = join(dir, 'out.txt');
    const fd = openSync(out, 'w');
    const mon = spawn(join(plugin, 'bin', 'sync-monitor'), [], {
      stdio: ['ignore', fd, fd],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        SYNC_STATE_DIR: dir,
        CLAUDE_CODE_SESSION_ID: session,
        SYNC_POLL_SECONDS: '1',
      },
    });

    try {
      const deadline = Date.now() + 15_000;
      while (existsSync(file) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(file)).toBe(false);

      // Still alive: a session that finishes one thing and claims another must
      // still be watched, and nothing restarts a monitor inside a session.
      await new Promise((r) => setTimeout(r, 1500));
      expect(mon.exitCode).toBeNull();

      // And silent. Finishing your work is not news, and a line here would print
      // after every completion that happened to be a session's last.
      expect(readFileSync(out, 'utf8')).toBe('');
    } finally {
      mon.kill();
      gw.stop();
    }
  }, 25_000);
});

/**
 * The half of the window the fence cannot close (SYNC-116).
 *
 * The fence forms its verdict on PreToolUse and nothing revisits it: poll,
 * answer, allow, push, published. Measured on the other box, the poll alone is
 * ~350ms and the push took ~2.5s as a dry run against a warm remote, so a
 * revocation landing anywhere in between goes out and the fence never knows.
 * No PreToolUse hook can fix that — the check and the publish are not atomic.
 *
 * So the re-check does not prevent anything, and is not meant to. It converts
 * "never finds out" into "told immediately". What is pinned here is that it
 * stays quiet on every ordinary path, because a hook that runs after every Bash
 * call and speaks on ignorance would be noise on the channel that carries the
 * one message that matters.
 */
describe('the re-check after a push', () => {
  const postpush = (command: string, url?: string) => {
    const state = mkdtempSync(join(tmpdir(), 'sync-post-'));
    if (url) writeFileSync(join(state, `${SESSION}.watch`), url);
    return spawnSync(bin('sync-session'), ['postpush'], {
      input: JSON.stringify({ session_id: SESSION, tool_input: { command } }),
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: state,
        SYNC_STATE_DIR: state,
        CLAUDE_CODE_SESSION_ID: SESSION,
      },
    });
  };

  it.each(['echo hello', 'git status', 'cat notes-about-git-push.md'])(
    'does not contact the gateway for: %s',
    (command) => {
      // The same scope as the fence, and now literally the same function — a
      // guard and its follow-up disagreeing about what they cover is the same
      // defect one step removed.
      const r = postpush(command, 'http://127.0.0.1:9/v1/watch/dead');
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('');
    },
  );

  it('says nothing when the gateway cannot be reached', () => {
    // Ignorance, on a hook that runs after every push. The fence says "allowing
    // unchecked" because it had a decision to make and made it; this one has
    // nothing to report, and a line here would be noise on the ordinary path.
    expect(postpush('git push', 'http://127.0.0.1:9/v1/watch/dead').stderr).toBe('');
  });

  it('says nothing when there is no credential at all', () => {
    expect(postpush('git push').stderr).toBe('');
  });

  const answering = async (status: number, body: string) => {
    const port = 19200 + Math.floor(process.hrtime()[1] % 300);
    const script = join(mkdtempSync(join(tmpdir(), 'sync-gw5-')), 'gw.py');
    writeFileSync(
      script,
      [
        'import http.server, sys',
        'STATUS = int(sys.argv[2]); BODY = sys.argv[3].encode()',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        self.send_response(STATUS)',
        '        self.send_header("content-type", "application/json")',
        '        self.send_header("content-length", str(len(BODY)))',
        '        self.end_headers(); self.wfile.write(BODY)',
        '    def log_message(self, *a): pass',
        'http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()',
      ].join('\n'),
    );
    const proc = spawn('python3', [script, String(port), String(status), body], {
      stdio: 'ignore',
      detached: true,
    });
    for (let i = 0; i < 100; i++) {
      try {
        execFileSync('curl', ['-sS', '-o', '/dev/null', `http://127.0.0.1:${port}/x`], {
          timeout: 500,
        });
        break;
      } catch {
        execFileSync('sleep', ['0.05']);
      }
    }
    return { url: `http://127.0.0.1:${port}/v1/watch/t`, stop: () => proc.kill() };
  };

  it('says the work went out anyway when the gateway answers 410', async () => {
    const gw = await answering(410, '{}');
    try {
      const r = postpush('git push origin main', gw.url);
      // Past tense, because it is. The fence's wording ("do not push") would be
      // advice about something that has already happened.
      expect(r.stderr).toMatch(/went out AFTER your claim ended/);
      // And a next step, because an agent told "that was not yours" with nothing
      // to do will either invent something or carry on.
      expect(r.stderr).toMatch(/tell the human/i);
    } finally {
      gw.stop();
    }
  }, 20_000);

  it('relays the gateway"s own reason on a stale 200', async () => {
    const gw = await answering(200, '{"stale":true,"say":"worker-9 took SYNC-1"}');
    try {
      const r = postpush('git push', gw.url);
      expect(r.stderr).toMatch(/worker-9 took SYNC-1/);
    } finally {
      gw.stop();
    }
  }, 20_000);

  it('stays quiet on a healthy 200', async () => {
    // The overwhelmingly common case: the push was fine. This is the assertion
    // that decides whether the hook is worth having at all.
    const gw = await answering(200, '{"holding":"SYNC-1"}');
    try {
      expect(postpush('git push', gw.url).stderr).toBe('');
    } finally {
      gw.stop();
    }
  }, 20_000);
});
