import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NATIVE_TOOLS } from '../src/toolspec.js';
import { INSTRUCTIONS } from '../src/mcphttp.js';

/**
 * The documentation drifts silently, which is the failure mode everything else in
 * this repo is written to avoid — so the parts of it that are mechanically true or
 * false are checked here rather than by whoever next happens to read carefully.
 *
 * The drift these tests exist for was real and shipped: the skill documented ten
 * of fifteen coordination tools for weeks, and `capture`'s own description told
 * every agent to break work up one child at a time long after `decompose` existed
 * to do it in one call. Neither is the kind of thing a reviewer notices, because
 * nothing about a stale sentence looks stale.
 */

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(repo(p), 'utf8');

describe('the skill covers the surface it claims to', () => {
  /**
   * The general check, and the one worth having: a tool that exists and is not in
   * the playbook is invisible to every agent that reads the playbook to find out
   * what it can do. Adding a tool now fails here until it is written down, which
   * is the only moment anyone has the context to write it down well.
   */
  it('names every coordination tool', () => {
    const skill = read('skills/work-tracking/SKILL.md');
    const missing = NATIVE_TOOLS.map((t) => t.name).filter((n) => !skill.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});

/**
 * No load-bearing rule may live only in `instructions`.
 *
 * MCP 2026-07-28 removes the `initialize` handshake. `instructions` survives on
 * `DiscoverResult`, but calling `server/discover` is optional for clients — so a
 * rule stated only there reaches whoever happens to ask for it. Tool descriptions
 * have no such gap: a tool that was never listed cannot be called, so its
 * description is in context by construction.
 *
 * Each rule is therefore pinned to the tool that creates the obligation it
 * describes, which is also where an agent is already looking when it applies. See
 * docs/architecture.md § Onboarding channels.
 */
describe('no rule depends on a channel a client may skip', () => {
  const describes = (tool: string) =>
    NATIVE_TOOLS.find((t) => t.name === tool)?.description ?? '';

  const rules: Array<[string, string[], RegExp]> = [
    ['write it down first', ['capture'], /MOMENT you notice/],
    ['claim before you work', ['claim'], /ONLY way to start work/],
    ['the lease expires', ['claim', 'release'], /lease expires|back to the pool/i],
    ['finish explicitly', ['complete', 'heartbeat'], /end the lease|lease.*(expire|lapse)/i],
    ['resume before re-claiming', ['held'], /after a restart/i],
  ];

  it.each(rules)('“%s” is stated on the tools that carry it', (_rule, tools, pattern) => {
    // `some`, not `every`: a rule reaches an agent if any one of the tools it
    // belongs to states it, and demanding all of them would push the same
    // sentence into descriptions where it is noise.
    expect(tools.some((t) => pattern.test(describes(t)))).toBe(true);
  });
});

/**
 * Two channels carry the rules: tool descriptions and the repo context file. A
 * rule that appears in one and not the other does not read as a contradiction to
 * an agent — it reads as two rules, and the one in front of it wins.
 *
 * The audit that caught the stale decomposition advice missed exactly this,
 * because it enumerated docs by directory and `AGENTS.md` is not in one.
 */
describe('the always-on channels agree', () => {
  /**
   * Markdown stripped before matching. The stale sentence was written three ways —
   * `capture once per child`, ``call `capture` once per child``, and with
   * `parentId` in backticks mid-phrase — so a pattern written against any one of
   * them silently passes the other two. The first draft of this test did exactly
   * that and cleared AGENTS.md, the file that was still wrong.
   */
  const plain = (s: string) => s.replace(/[`*_]/g, '');

  const channels: Array<[string, string]> = [
    ['MCP instructions', INSTRUCTIONS],
    ['AGENTS.md', read('AGENTS.md')],
    ['capture tool description', NATIVE_TOOLS.find((t) => t.name === 'capture')?.description ?? ''],
  ];

  it.each(channels)('%s sends decomposition to `decompose`', (_name, text) => {
    expect(plain(text)).toMatch(/decompose/);
    // Pins one sentence rather than proving agreement in general — but it is the
    // sentence that was wrong in three places at once, and a canary on the exact
    // drift that happened is worth more than a check for drift in the abstract.
    expect(plain(text)).not.toMatch(/capture once per child/i);
  });
});
