import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `sync-connect` must run on every box the plugin runs on.
 *
 * It moved into the plugin in d43cc5b, which was right — the boxes that need it
 * are the ones with no clone of this repository — but the dependency contract
 * came along unexamined. It used python3 in three places with no fallback, while
 * `sync-json` exists precisely so that jq OR node OR python3 is enough, and says
 * so in its own header. An ordinary macOS box without the Xcode command line
 * tools has jq and no python3: it ran the hooks, the fence and the monitor
 * perfectly well, and could not run the one script it needed to connect at all.
 *
 * So this drives the whole flow — mint, verify, register — three times, once per
 * JSON backend, each with the other two REMOVED FROM PATH. The removal is the
 * test. Running it on a machine that happens to have all three proves nothing,
 * which is exactly how the dependency got in.
 */

const plugin = new URL('../../plugin/', import.meta.url).pathname;
const connect = join(plugin, 'bin/sync-connect');

const TOKEN = 'sync_agent_deadbeefdeadbeefdeadbeef';
const PROJECT = '74661462-b37a-421d-b51d-2b2d3ca6c1ad';
const VISIBLE = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

/**
 * A gateway that answers the four calls this script makes, and nothing else.
 *
 * Run from the TEST's python3, not the script's — the point is to take python3
 * away from the subprocess, not from the harness.
 */
const GATEWAY = `
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

TOOLS = [{"name": n} for n in ("capture", "claim", "complete")]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply({"ok": True, "build": {"sha": "test"}})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        req = json.loads(raw or b"{}")
        if self.path == "/v1/agent-tokens":
            self.reply({
                "token": ${JSON.stringify(TOKEN)},
                "agent": "me/" + req.get("agent", "?"),
                "planeUser": {"email": "me@example.com"},
                "visibleProjects": ${JSON.stringify(VISIBLE)},
            })
        elif req.get("method") == "initialize":
            self.reply({"result": {"serverInfo": {"name": "sync"}}})
        else:
            self.reply({"result": {"tools": TOOLS}})

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
`;

const PORT = 17831;
let gateway: ReturnType<typeof spawn>;

beforeAll(() => {
  const script = join(mkdtempSync(join(tmpdir(), 'sync-connect-gw-')), 'gw.py');
  writeFileSync(script, GATEWAY);
  gateway = spawn('python3', [script, String(PORT)], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync('curl', ['-sS', '-o', '/dev/null', `http://127.0.0.1:${PORT}/healthz`], {
        stdio: 'ignore',
      });
      return;
    } catch {
      execFileSync('sleep', ['0.05']);
    }
  }
  throw new Error('the fake gateway never came up');
});

afterAll(() => {
  if (gateway.pid) process.kill(-gateway.pid, 'SIGKILL');
});

/**
 * A PATH holding the shell, the ordinary utilities, and exactly ONE JSON parser.
 *
 * Plus a `claude` that records its arguments instead of touching real config —
 * registering the server for real would write into the developer's own
 * ~/.claude.json, which is both a side effect and a way to lose an entry.
 */
function sandbox(parser: 'jq' | 'node' | 'python3'): { path: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), `sync-connect-${parser}-`));
  const tools = [
    'sh', 'bash', 'env', 'cat', 'curl', 'sed', 'tr', 'cut', 'grep', 'head',
    'mv', 'rm', 'dirname', 'sleep', 'uname',
  ];
  for (const t of [...tools, parser]) {
    try {
      symlinkSync(execFileSync('command', ['-v', t], {
        encoding: 'utf8', shell: '/bin/bash',
      }).trim(), join(dir, t));
    } catch {
      // Not present on this machine, and not every name here is needed by every
      // path through the script. A genuinely missing one fails the run loudly.
    }
  }

  const log = join(dir, 'claude.log');
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(dir, 'claude'), 0o755);
  writeFileSync(log, '');
  return { path: dir, log };
}

function connectWith(parser: 'jq' | 'node' | 'python3'): { stdout: string; log: string } {
  const { path, log } = sandbox(parser);
  const stdout = execFileSync(
    connect,
    [
      '--url', `http://127.0.0.1:${PORT}`,
      '--plane-token', 'plane_api_test',
      '--agent', 'Worker 12!!',
      '--project', PROJECT,
      '--scope', 'local',
      '--client', 'claude',
      '-y',
    ],
    { encoding: 'utf8', env: { PATH: path, HOME: path }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { stdout, log: readFileSync(log, 'utf8') };
}

describe.each(['jq', 'node', 'python3'] as const)(
  'connecting a box whose only JSON parser is %s',
  (parser) => {
    it('mints, verifies and registers, with the other two parsers absent', () => {
      const { stdout, log } = connectWith(parser);

      // Read out of the mint reply — the first thing that needed a parser.
      expect(stdout).toMatch(/minted me\/worker-12 for me@example\.com/);
      // Counted out of tools/list, which needed one that could measure a list.
      expect(stdout).toMatch(/ok — 3 tools available/);
      // And the token reached the client, which is the only outcome that matters.
      expect(log).toContain(`Authorization: Bearer ${TOKEN}`);
      expect(log).toMatch(/mcp add .*--transport http --scope local sync/);
    });

    it('sends the name the gateway will actually store', () => {
      // "Worker 12!!" is not a name the gateway keeps — mint.ts lowercases,
      // maps anything outside [a-z0-9._-] to a dash and trims. Doing the same
      // here is what removed the python3 call that existed only to quote a
      // string for JSON, and it means the name you are shown is the name you
      // will have to revoke by later.
      const { stdout } = connectWith(parser);
      expect(stdout).toMatch(/using "worker-12"/);
      expect(stdout).toMatch(/minted me\/worker-12\b/);
    });
  },
);

describe('a gateway that authenticates but offers nothing', () => {
  it('is called out rather than reported as success', () => {
    // "Connects, but zero tools" is a fault with a cause of its own: the gateway
    // is up and the token is good, and it cannot reach Plane to build the
    // catalogue. Everywhere else it is indistinguishable from success until an
    // agent goes looking for a tool it will not find.
    expect(readFileSync(connect, 'utf8')).toMatch(/zero tools.*cannot reach Plane/);
  });
});

describe('the script itself', () => {
  it('needs no parser of its own', () => {
    // The regression guard, stated as the rule rather than as its symptom: any
    // direct call to a JSON parser here is a dependency the rest of the plugin
    // does not have. Reading goes through sync-json; the one write that shell
    // cannot do safely — merging into an existing .mcp.json — asks for jq and
    // prints what to paste when it is missing.
    const text = readFileSync(connect, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(text).not.toMatch(/\bpython3 /);
    expect(text).not.toMatch(/\bnode -e/);
  });
});
