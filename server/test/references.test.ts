import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { linkReferences, referencesIn } from '../src/references.js';
import { PlaneClient } from '../src/plane.js';
import type { WorkItem } from '../src/plane.js';

/**
 * Completions already say "Superseded by SYNC-32" and "captured as SYNC-34".
 * `findEvidence` was pulling those tokens out and discarding them, so the
 * relationships existed as prose nothing could query.
 *
 * The tests that matter are the ones about *not* linking. A wrong edge is
 * permanent and indistinguishable from a real one to anyone reading the graph
 * later, which is a much worse outcome than a missing one.
 */
describe('finding references', () => {
  it('reads the qualified form for this project', () => {
    expect(referencesIn('Superseded by SYNC-32, see also SYNC-7.', 'SYNC').map((r) => r.sequence))
      .toEqual([32, 7]);
  });

  it('never reads a bare #42 as a work item', () => {
    // evidence.ts does, and is right to — it only asks "did you cite anything",
    // where a false positive costs nothing. Here it would write a permanent wrong
    // edge. The board has the counterexample: SYNC-24 is titled "Merge PR #1",
    // where #1 is a GitHub pull request and SYNC-1 is an unrelated redeploy.
    expect(referencesIn('Merge PR #1 (work-tracking skill). Closes #7.', 'SYNC')).toEqual([]);
  });

  it('ignores another project, and words shaped like references', () => {
    expect(referencesIn('Encode UTF-8, hash SHA-256, blocked on OTHER-3', 'SYNC')).toEqual([]);
  });

  it('mentions each item once however often it appears', () => {
    expect(referencesIn('SYNC-5 and SYNC-5 again, plus SYNC-5', 'SYNC')).toHaveLength(1);
  });

  it('says nothing when the project identifier is unknown', () => {
    // Better than falling back to "anything well-shaped", which is how UTF-8
    // becomes an edge.
    expect(referencesIn('Superseded by SYNC-32', '')).toEqual([]);
  });
});

const PROJECT = randomUUID();
const ids = new Map<number, string>();
const idFor = (seq: number): string => {
  const hit = ids.get(seq);
  if (hit) return hit;
  const made = randomUUID();
  ids.set(seq, made);
  return made;
};

interface Recorder {
  related: Array<{ from: string; to: string[] }>;
}

function fakePlane(opts: { known?: number[]; relateFails?: boolean; listFails?: boolean } = {}) {
  const rec: Recorder = { related: [] };
  const known = opts.known ?? [7, 32, 40];
  const client = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    rec,
    projectIdentifier: async () => 'SYNC',
    listWorkItems: async (): Promise<WorkItem[]> => {
      if (opts.listFails) throw new Error('plane down');
      return known.map((seq) => ({
        id: idFor(seq),
        sequence_id: seq,
        name: `item ${seq}`,
        state: 's',
        priority: 'none' as const,
        labels: [],
        parent: null,
        is_draft: false,
        assignees: [],
        created_at: '',
        updated_at: '',
      }));
    },
    relate: async (_p: string, from: string, _t: string, to: string[]) => {
      if (opts.relateFails) throw new Error('duplicate relation');
      rec.related.push({ from, to });
      return {};
    },
  });
  return client as PlaneClient & { rec: Recorder };
}

describe('turning references into edges', () => {
  it('links every item the caller declared', async () => {
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Supersedes one of these.',
      refs: ['SYNC-32', 'SYNC-40'],
    });

    expect(out.every((r) => r.linked)).toBe(true);
    expect(plane.rec.related.map((r) => r.to[0]).sort()).toEqual(
      [idFor(32), idFor(40)].sort(),
    );
  });

  it('does not link an item to itself', async () => {
    // A completion naming its own id is the normal case; a self-edge is not.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: idFor(32),
      text: '',
      refs: ['SYNC-32'],
    });

    expect(out).toEqual([]);
    expect(plane.rec.related).toEqual([]);
  });

  it('reports a reference to something that does not exist', async () => {
    // Silently dropping it would be the same failure this replaces — an
    // unqueryable claim — with more machinery behind it.
    const plane = fakePlane({ known: [7] });
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: '',
      refs: ['SYNC-999'],
    });

    expect(out).toEqual([
      { readableId: 'SYNC-999', linked: false, reason: 'no such work item in this project' },
    ]);
    expect(plane.rec.related).toEqual([]);
  });

  it('costs nothing when nothing was declared and nothing named', async () => {
    let listed = 0;
    const plane = Object.assign(fakePlane(), {
      listWorkItems: async () => {
        listed++;
        return [];
      },
    });
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Fixed in 3f7a891, see server/src/view.ts',
    });

    expect(out).toEqual([]);
    // The common case must not add a Plane listing to every completion.
    expect(listed).toBe(0);
  });

  it('treats a refused relation as already-linked, not as failure', async () => {
    const plane = fakePlane({ relateFails: true });
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: '',
      refs: ['SYNC-7'],
    });
    expect(out[0]).toMatchObject({ linked: false, workItemId: idFor(7) });
    expect(out[0]?.reason).toContain('already linked');
  });

  it('says it could not resolve when Plane is unreachable', async () => {
    const plane = fakePlane({ listFails: true });
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: '',
      refs: ['SYNC-32'],
    });
    expect(out.find((r) => r.readableId === 'SYNC-32')?.reason).toContain('could not reach Plane');
  });
});

/**
 * An outcome names work items as DATA at least as often as it means them as
 * relations, and prose used to create edges from both.
 *
 * Measured on the closure of SYNC-88: its outcome reported that the top level
 * goes from 65 roots to 7 and said which 7 — creating seven permanent
 * `relates_to` edges to items it had nothing to do with. The better the
 * completion, the worse the corruption, which is exactly backwards.
 *
 * Edges are not inert either: `claim` builds its briefing from them, handing
 * over linked items open-first with their full text so an agent does not miss a
 * requirement. Every false edge dilutes that.
 */
describe('what an outcome merely mentions', () => {
  it('does not link an item just because the prose names it', async () => {
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'The seven that remain are SYNC-32 and SYNC-40.',
    });

    expect(plane.rec.related).toEqual([]);
    expect(out.every((r) => !r.linked)).toBe(true);
  });

  it('says so rather than dropping it silently', async () => {
    // Agents were told the old behaviour. A rule that changes without saying so
    // is the same failure as an edge that silently was not made.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Compare with SYNC-32.',
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.readableId).toBe('SYNC-32');
    expect(out[0]?.reason).toContain('refs');
  });

  it('does not report one the caller also declared', async () => {
    // Naming it in both places is the clearest possible statement of intent, and
    // must not come back as a complaint.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Supersedes SYNC-32.',
      refs: ['SYNC-32'],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ readableId: 'SYNC-32', linked: true });
    expect(plane.rec.related).toHaveLength(1);
  });
});

describe('references passed as data', () => {
  it('links exactly what the caller named, and nothing the prose did', async () => {
    // The prose mentions SYNC-32; only the two declared refs become edges.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Supersedes SYNC-32.',
      refs: ['SYNC-7', 'SYNC-40'],
    });

    expect(out.filter((r) => r.linked).map((r) => r.readableId).sort()).toEqual([
      'SYNC-40',
      'SYNC-7',
    ]);
    expect(plane.rec.related.map((r) => r.to[0]).sort()).toEqual([idFor(7), idFor(40)].sort());
  });

  it('does not link the same item twice when prose and refs agree', async () => {
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'Supersedes SYNC-32.',
      refs: ['SYNC-32'],
    });
    expect(out).toHaveLength(1);
    expect(plane.rec.related).toHaveLength(1);
  });

  it('accepts a ref that was not shouted', async () => {
    // Prose must stay case-strict or `utf-8` becomes a reference. A ref passed
    // deliberately carries no such risk.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: '',
      refs: ['sync-7', ' SYNC-32 '],
    });
    expect(out.every((r) => r.linked)).toBe(true);
  });

  it('reports a ref that names nothing, where prose would just ignore it', async () => {
    // The asymmetry is deliberate: a stated intention discarded in silence is
    // the exact failure this file exists to stop.
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: '',
      refs: ['OTHER-3', 'nonsense', 'SYNC-7'],
    });

    expect(out.filter((r) => !r.linked).map((r) => r.readableId).sort()).toEqual([
      'OTHER-3',
      'nonsense',
    ]);
    expect(out.find((r) => r.readableId === 'SYNC-7')?.linked).toBe(true);
  });

  it('reports bad refs even when there is nothing else to link', async () => {
    const plane = fakePlane();
    const out = await linkReferences(plane, {
      projectId: PROJECT,
      fromId: randomUUID(),
      text: 'no references here',
      refs: ['garbage'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toContain('SYNC-123');
  });
});
