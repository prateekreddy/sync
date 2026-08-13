# Agent skills

Reference material an agent loads **on demand**, when it judges the topic relevant.

This is not where the rules live. *Write it down first, claim before you work, finish
explicitly* ship on the two always-on channels — the MCP handshake's `instructions` and
a few lines in `CLAUDE.md` / `AGENTS.md` — because a rule that fires only when the model
already decided it was relevant is a rule that does not fire. `docs/architecture.md`
§ *Onboarding channels* has the argument.

What is left over is the part a skill is actually for: **which tool answers which
question**, across a surface too large to hold in context and too rarely needed to earn a
place there. Sixty-two tools, most of them Plane's own, and an agent needs maybe six of
them on any given item — and the count moves on a gateway deploy, which is why the
skill tells you to trust the tool list you were handed over anything written here.

## `work-tracking`

The playbook for the whole surface: the claim loop and its failure modes, what the
readiness gate withholds and why, capture's dedup and how it interacts with
decomposition, and what cycles, modules, labels, states, worklogs and comments are each
good for once you hold an item.

It is derived from this repo's own sources — `toolspec.ts` for the contracts, `errors.ts`
for the recoveries, `readiness.ts` for the gate, `toolpolicy.ts` for the refusals — so it
lives here rather than in any one consumer, and moves when they move.

### Installing it

Claude Code reads skills from `.claude/skills/<name>/SKILL.md`, per project or per user:

```bash
mkdir -p ~/.claude/skills                                 # or <project>/.claude/skills
cp -r skills/work-tracking ~/.claude/skills/
```

Codex has no skill mechanism. Point it at the file directly, or paste the sections you
need — it is plain Markdown and nothing in it depends on being loaded as a skill.

Consumers that provision agents automatically should copy it in the same step that
registers the MCP server, and copy it **only if absent**: once an agent has it, editing it
is the agent's business.
