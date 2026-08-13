import { describe, expect, it } from 'vitest';
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NATIVE_TOOLS } from '../src/toolspec.js';
import { RECOVERY } from '../src/errors.js';
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
  /**
   * The count, not just the names.
   *
   * The playbook opened by telling the agent how many coordination tools there
   * are, and said eighteen while there were seventeen — left behind when
   * `heartbeat` came off the surface. The check above passed the whole time,
   * because it asks whether every tool is named and never whether the number is
   * right. A stale count is small on its own; it matters because it is the first
   * concrete claim in the document, and an agent that can falsify the first line
   * has reason to doubt the rest.
   */
  it('states the right number of coordination tools', () => {
    const stated = /\*\*Coordination tools\*\* — (\d+) of them/.exec(
      read('skills/work-tracking/SKILL.md'),
    )?.[1];
    expect(stated).toBeDefined();
    expect(Number(stated)).toBe(NATIVE_TOOLS.length);
  });

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
 * Every refusal the gateway can produce is decoded somewhere the agent will look.
 *
 * troubleshooting.md's table is what the playbook points at when a call fails, and
 * it listed eleven of fourteen codes. The gap was not neutral. `REVOKED` — a
 * person took the item back in Plane — was missing, and the nearest row by name
 * and by feel is `LEASE_EXPIRED`, which says "claim it again before continuing".
 * That is the exact action `REVOKED` exists to forbid, and errors.ts keeps the two
 * codes apart in a comment for that reason. An incomplete lookup table does not
 * fail by saying nothing; it fails by making a neighbouring row look like the
 * answer.
 *
 * `NEEDS_APPROVAL` was missing too, while SKILL.md described the gate that raises
 * it at length without ever naming it — so the section that teaches the behaviour
 * and the table that decodes the refusal had no term in common.
 *
 * Keyed on RECOVERY rather than on a list written out here: it is a
 * Record<ErrorCode, string>, so it has every code by construction and a new one
 * cannot be added without this failing.
 */
describe('every error code an agent can meet is documented', () => {
  it('gives each one a row in the troubleshooting table', () => {
    const table = read('skills/work-tracking/troubleshooting.md');
    const undocumented = Object.keys(RECOVERY).filter((code) => !table.includes(`\`${code}\``));
    expect(undocumented).toEqual([]);
  });

  it('does not invent codes the gateway cannot return', () => {
    // The other direction: a row for a code that no longer exists teaches an agent
    // to watch for something it will never see, and reads as coverage.
    //
    // Scanned over the table's rows rather than the whole file, because prose
    // elsewhere legitimately backticks SHOUTING_CASE that is not an error code —
    // env vars like SYNC_MCP_URL. Reading those as codes failed this test for
    // documentation that was correct, which is the kind of false alarm that gets
    // a guard deleted rather than fixed.
    const rows = read('skills/work-tracking/troubleshooting.md')
      .split('\n')
      .filter((l) => l.startsWith('| `'));
    const cited = rows.flatMap((l) => [...l.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((m) => m[1]!));
    expect([...new Set(cited)].filter((c) => !(c in RECOVERY))).toEqual([]);
    // The scoping must not silently empty the check.
    expect(cited.length).toBeGreaterThanOrEqual(Object.keys(RECOVERY).length);
  });

  it('tells REVOKED and LEASE_EXPIRED apart where they are read', () => {
    // The specific confusion, pinned. These two look alike and their recoveries
    // are opposites, so the table has to say so rather than leaving an agent to
    // notice — which is precisely what it did not do.
    const table = read('skills/work-tracking/troubleshooting.md');
    const revoked = table.split('\n').find((l) => l.includes('`REVOKED`')) ?? '';
    expect(revoked).toMatch(/do NOT claim it again/);
    expect(revoked).toMatch(/LEASE_EXPIRED/);
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
      const out = links(read(`skills/work-tracking/${f}`));
      // Every link must point back at SKILL.md — but a reference file may point
      // back more than once. This asserted exactly one for a while, which quietly
      // made "cross-reference the parent where it helps" a thing you could only
      // do at most once per file, for no reason anybody would have defended.
      expect(out.filter((l) => l !== 'SKILL.md')).toEqual([]);
      expect(out.length).toBeGreaterThan(0);
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

  /**
   * Withholding a tool is only half the job — nothing may still tell the agent to
   * call it.
   *
   * `claim`'s description went on saying "the lease expires; keep it alive with
   * heartbeat" for as long as the tool had been gone, and every check above
   * passed: `promisesToHeartbeat` covers INSTRUCTIONS, SKILL.md and AGENTS.md but
   * not tool descriptions, and its pattern would not have matched this phrasing
   * anywhere. That is the worst channel to be wrong in, by this file's own
   * argument (see the block below): a tool that was never listed cannot be
   * called, so its description is in context by construction. Every agent that
   * claimed anything read an instruction to call a tool it could not find, whose
   * most natural reading is that its lease is unprotected — the exact doubt the
   * monitor exists to remove.
   *
   * WITHHELD is the vocabulary this checks against: reachable over HTTP, kept
   * deliberately out of the model's reach. Adding one here is what makes the next
   * removal fail loudly instead of leaving residue in a description nobody rereads.
   */
  const WITHHELD = ['heartbeat'];

  it.each(WITHHELD)('never tells the agent to call `%s`', (name) => {
    const offenders = NATIVE_TOOLS.filter((t) =>
      new RegExp(`\\b${name}\\b`, 'i').test(`${t.description} ${t.title ?? ''}`),
    ).map((t) => t.name);
    expect(offenders).toEqual([]);
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
    // Was ['complete', 'heartbeat'] — the second named a tool that no longer
    // exists, so `describes` returned '' for it and the rule rested silently on
    // `complete` alone. A dead name in a table of live ones reads as coverage.
    ['finish explicitly', ['complete', 'release'], /end the lease|lease.*(expire|lapse)/i],
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

/**
 * Connecting a box nobody is sitting at (SYNC-117).
 *
 * The plugin's whole proposition is that nothing is cloned and nothing is built,
 * which is exactly why the script that connects a browser-less machine cannot
 * live only in this repository: the boxes that need it are the ones that do not
 * have it. It ships inside the plugin, and `bin/onboard.sh` — the path the README
 * and provisioning have always used — forwards to it rather than being a second
 * copy, because two onboarding scripts drift and the drift reads as a box that
 * will not connect.
 */
describe('the connect script reaches the boxes that need it', () => {
  it('ships in the plugin, executable', () => {
    // Not executable is the same as absent here: it is invoked by path, from a
    // shell, by somebody who has no way to know they need to chmod it.
    accessSync(repo('plugin/bin/sync-connect'), constants.X_OK);
  });

  it('is forwarded to, not copied, by the documented repo path', () => {
    const forwarder = read('bin/onboard.sh');
    expect(forwarder).toMatch(/exec .*plugin\/bin\/sync-connect/);
    // A forwarder is short by nature. If this has grown into a script again,
    // somebody has started keeping logic in two places.
    expect(forwarder.split('\n').length).toBeLessThan(30);
  });

  it('is documented where each kind of box would look', () => {
    expect(read('plugin/README.md')).toMatch(/sync-connect/);
    expect(read('docs/onboarding.md')).toMatch(/sync-connect/);
    expect(read('README.md')).toMatch(/sync-connect/);
  });
});

/**
 * The plugin's server entry must stay browser-only.
 *
 * Measured 2026-08-10 against a live gateway: Claude Code reports "OAuth fallback
 * is disabled when headers.Authorization is set", and it means it — an entry
 * whose Authorization header expands to the EMPTY STRING still gets no sign-in
 * offer, just a hard 401. So the obvious-looking improvement, `Authorization:
 * Bearer ${SYNC_AGENT_TOKEN:-}` so that provisioned boxes carry a token and
 * everyone else falls back to the browser, does not degrade gracefully: it
 * silently converts every unprovisioned install into one that can never sign in.
 *
 * A token and a browser sign-in are alternatives, not layers. `sync-connect`
 * therefore writes a server entry of its own, and this one stays clean.
 */
describe("the plugin's MCP server", () => {
  const config = () => JSON.parse(read('plugin/.mcp.json')).mcpServers.sync;

  it('configures no Authorization header', () => {
    const headers: Record<string, string> = config().headers ?? {};
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('authorization');
  });

  it('still passes the session id, which is what headers are for here', () => {
    // The other direction of the same check: this must not be "solved" by
    // dropping headers altogether. Session identity is what every protection
    // built on sessions rests on.
    expect(config().headers['X-Sync-Session']).toMatch(/CLAUDE_CODE_SESSION_ID/);
  });

  /**
   * The repo is public and the plugin installs from it, so a URL written here
   * is not a convenience default — it is the address every stranger's agents
   * take. It points them at a live gateway that will authenticate them, rate
   * limit on their behalf, and receive whatever they capture.
   *
   * Caught before the repo went public: the entry carried the maintainer's own
   * gateway as the `:-` fallback, and the onboarding doc advertised "no URL to
   * know" as a feature of installing the plugin.
   *
   * Asserted as "no host at all" rather than "not that one host", because the
   * next person to add a default will pick a different hostname.
   */
  it('hardcodes no gateway address, so it cannot ship one deployment to everyone', () => {
    const url: string = config().url;
    expect(url).toMatch(/SYNC_MCP_URL/);
    // Every https:// in this value would be a baked-in destination. The
    // variable may carry a default only if that default has no host.
    expect(url).not.toMatch(/https?:\/\//);
  });
});
