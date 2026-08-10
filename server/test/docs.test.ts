import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

/** Every file the playbook is made of, SKILL.md and the references beside it. */
const skillFiles = (): string[] => readdirSync(repo('skills/work-tracking')).sort();
const skillText = (): string =>
  skillFiles()
    .map((f) => read(`skills/work-tracking/${f}`))
    .join('\n');

describe('the skill covers the surface it claims to', () => {
  /**
   * The general check, and the one worth having: a tool that exists and is not in
   * the playbook is invisible to every agent that reads the playbook to find out
   * what it can do. Adding a tool now fails here until it is written down, which
   * is the only moment anyone has the context to write it down well.
   */
  it('names every coordination tool', () => {
    // Across the whole skill, not just SKILL.md: reference material moved into
    // sibling files when the playbook outgrew the 500-line budget, and a tool
    // documented in one of those is still documented.
    const missing = NATIVE_TOOLS.map((t) => t.name).filter((n) => !skillText().includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  /**
   * The plugin has to ship a real copy -- an installed plugin cannot reach back
   * into this repository -- and two copies of anything drift. This is the cheapest
   * thing that makes the drift loud: editing one and not the other fails here,
   * rather than shipping rules that quietly disagree with the ones we develop
   * against. The plugin directory was already advertising a skill it did not
   * contain, which is the same failure one step earlier.
   */
  it('ships the same playbook in the plugin', () => {
    for (const f of skillFiles()) {
      expect(read(`plugin/skills/work-tracking/${f}`)).toBe(read(`skills/work-tracking/${f}`));
    }
  });

  it('ships every file the skill has, and no stale extras', () => {
    // A file added here and not copied would leave the installed plugin with a
    // dangling link; one deleted here and left there would ship rules we no
    // longer keep.
    expect(readdirSync(repo('plugin/skills/work-tracking')).sort()).toEqual(skillFiles());
  });
});

/**
 * The limits Anthropic publishes for skill authoring, checked rather than
 * remembered. Each of these was already wrong once: the body ran past the budget,
 * and the plugin advertised a skill directory that was empty.
 */
describe('the playbook obeys the authoring limits', () => {
  it('keeps SKILL.md under the 500-line budget', () => {
    // Past this the body starts competing with conversation history, and the
    // guidance is to split into files that load only when needed.
    expect(read('skills/work-tracking/SKILL.md').split('\n').length).toBeLessThan(500);
  });

  it('keeps every reference one level deep from SKILL.md', () => {
    // Claude partially reads files reached through another reference -- it will
    // `head` them rather than read them -- so a link from a linked file silently
    // yields incomplete instructions. Every reference must hang off SKILL.md.
    const links = (text: string): string[] =>
      [...text.matchAll(/\]\((?!https?:)([^)]+\.md)\)/g)].map((m) => m[1]!);

    for (const f of skillFiles()) {
      if (f === 'SKILL.md') continue;
      expect(links(read(`skills/work-tracking/${f}`))).toEqual(['SKILL.md']);
    }
  });

  it('points at reference files that exist', () => {
    const skill = read('skills/work-tracking/SKILL.md');
    const targets = [...skill.matchAll(/\]\((?!https?:)([^)]+\.md)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !skillFiles().includes(t))).toEqual([]);
  });

  it('gives every reference file a table of contents', () => {
    // For anything past ~100 lines, so a partial read still shows the full scope
    // of what is in the file.
    for (const f of skillFiles()) {
      if (f === 'SKILL.md') continue;
      expect(read(`skills/work-tracking/${f}`)).toMatch(/^## Contents$/m);
    }
  });

  it('describes the skill in the third person, with when to use it', () => {
    // The description is injected into the system prompt and is what selection
    // runs on; first or second person there measurably hurts discovery.
    const front = read('skills/work-tracking/SKILL.md').split('---')[1] ?? '';
    const description = /description:\s*(.+)/.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/use when/i);
    expect(description).not.toMatch(/\b(I can|you can help|I will)\b/i);
  });
});

describe('what the agent is told to keep doing', () => {
  /**
   * Liveness moved out of the model and into a monitor, and an instruction to
   * heartbeat is now worse than merely stale: it describes an obligation the
   * agent will fail to meet, and the whole point of the change is that it no
   * longer has to. The old wording survived in three places at once, which is
   * why this is checked rather than remembered.
   */
  const promisesToHeartbeat = (text: string): boolean =>
    /heartbeat (every|periodically|roughly every)|call heartbeat periodically/i.test(text);

  it('does not ask for a heartbeat in the server instructions', () => {
    expect(promisesToHeartbeat(INSTRUCTIONS)).toBe(false);
  });

  it('does not ask for a heartbeat in the playbook', () => {
    expect(promisesToHeartbeat(read('skills/work-tracking/SKILL.md'))).toBe(false);
  });

  it('does not ask for a heartbeat in the always-on instructions', () => {
    // AGENTS.md is read as CLAUDE.md and is in context for every request, so a
    // stale rule here outranks every other copy. It went on saying "call
    // heartbeat on long tasks" for weeks after the tool was removed from the
    // surface, and the two checks above both passed the whole time — they
    // covered the files somebody thought to name.
    expect(promisesToHeartbeat(read('AGENTS.md'))).toBe(false);
    expect(read('AGENTS.md')).not.toMatch(/`heartbeat`/);
  });

  it('tells the agent its claim holds, without naming the machinery', () => {
    // Silence is not reassurance: an agent that reads no mention of leases at all
    // reasonably assumes a long task is unprotected. But the reassurance has to be
    // positive. Saying "you do not need to call heartbeat" teaches the tool and
    // then spends words unteaching it, which lands as doubt rather than as nothing
    // — so the fact is stated and the mechanism is not mentioned.
    expect(INSTRUCTIONS).toMatch(/stays yours for as long as you are working on it/i);
    expect(INSTRUCTIONS).not.toMatch(/heartbeat/i);
  });

  it('keeps the tool off the surface the model chooses from', () => {
    // A tool in the list is one the model must consider and can misuse. The HTTP
    // endpoint stays for clients without the plugin; it is simply not offered.
    expect(NATIVE_TOOLS.map((t) => t.name)).not.toContain('heartbeat');
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
