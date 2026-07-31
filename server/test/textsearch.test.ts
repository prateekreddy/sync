import { describe, expect, it } from 'vitest';
import { plainText, searchItems } from '../src/textsearch.js';
import type { WorkItem } from '../src/plane.js';

/**
 * Plane's search reads titles only — verified against the running instance: a
 * marker placed solely in a description returns nothing.
 *
 * That was survivable while titles named the code they were about. It stopped
 * being survivable the day titles started leading with behaviour, because the
 * identifiers a searcher actually types — file names, error strings, env vars —
 * moved into the body by the same rule.
 */
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'i1',
  sequence_id: 1,
  name: 'Do the thing',
  description_html: '<p>Body text.</p>',
  state: 's',
  priority: 'medium',
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const find = (items: WorkItem[], q: string) => searchItems(items, q, { projectId: 'p' });

describe('matching', () => {
  it('finds a term that appears only in the description', () => {
    const got = find([item({ description_html: '<p>set GITHUB_WEBHOOK_SECRET first</p>' })], 'github_webhook_secret');
    expect(got).toHaveLength(1);
    expect(got[0]?.where).toBe('body');
  });

  it('finds a term in the title', () => {
    const got = find([item({ name: 'Labelling work fails' })], 'labelling');
    expect(got[0]?.where).toBe('title');
  });

  it('ignores case on both sides', () => {
    expect(find([item({ name: 'Redeploy The Gateway' })], 'redeploy the GATEWAY')).toHaveLength(1);
  });

  it('requires every word, so two words narrow rather than widen', () => {
    // The opposite — any-word matching — turns a two-word query into half the
    // board, which is the failure mode that makes people stop using search.
    const items = [item({ id: 'a', name: 'label uuid problem' }), item({ id: 'b', name: 'label only' })];
    expect(find(items, 'label uuid').map((h) => h.workItemId)).toEqual(['a']);
  });

  it('matches words in any order and across the title/body boundary', () => {
    const got = find([item({ name: 'Search is limited', description_html: '<p>only titles</p>' })], 'titles only');
    expect(got).toHaveLength(1);
    expect(got[0]?.where).toBe('body');
  });

  it('returns nothing rather than everything for a query with no terms', () => {
    expect(find([item()], '   ')).toEqual([]);
  });
});

describe('ranking and evidence', () => {
  it('puts title hits above body hits', () => {
    // Without this an item that mentions the subject in passing outranks the
    // item that *is* the subject.
    const items = [
      item({ id: 'mention', name: 'Something else', description_html: '<p>see the lease table</p>' }),
      item({ id: 'about', name: 'The lease is per-process' }),
    ];
    expect(find(items, 'lease').map((h) => h.workItemId)).toEqual(['about', 'mention']);
  });

  it('carries the surrounding text for a body hit, so a passing mention is visible as one', () => {
    const body = `<p>${'filler '.repeat(40)}the marker WORD sits here${' more'.repeat(40)}</p>`;
    const got = find([item({ description_html: body })], 'marker');
    expect(got[0]?.excerpt).toContain('marker WORD sits here');
    expect(got[0]?.excerpt?.length).toBeLessThan(200);
    expect(got[0]?.excerpt?.startsWith('…')).toBe(true);
  });

  it('adds no excerpt to a title hit, which is already the strongest signal', () => {
    expect(find([item({ name: 'lease' })], 'lease')[0]?.excerpt).toBeUndefined();
  });

  it('reports the project the caller named, not one read off the item', () => {
    // List responses omit `project` entirely, so reading it there would make
    // every hit's projectId undefined — a pointer that points nowhere.
    const got = searchItems([item()], 'thing', { projectId: 'the-project' });
    expect(got[0]?.projectId).toBe('the-project');
  });

  it('uses the project identifier for readable ids when given one', () => {
    const got = searchItems([item({ sequence_id: 42 })], 'thing', {
      projectId: 'p',
      projectIdentifier: 'SYNC',
    });
    expect(got[0]?.readableId).toBe('SYNC-42');
  });

  it('honours the limit', () => {
    const items = Array.from({ length: 30 }, (_, i) => item({ id: `i${i}` }));
    expect(searchItems(items, 'thing', { projectId: 'p', limit: 5 })).toHaveLength(5);
  });
});

describe('descriptions are HTML', () => {
  it('does not let markup match', () => {
    // Searching the raw HTML would make every item with a paragraph a hit for
    // "p", and every styled item a hit for "span".
    expect(find([item({ description_html: '<p><span>hello</span></p>' })], 'span')).toEqual([]);
  });

  it('keeps words apart when a tag is all that separated them', () => {
    expect(plainText('<p>one</p><p>two</p>')).toBe('one two');
  });

  it('decodes the entities Plane emits', () => {
    expect(plainText('<p>a &amp; b &lt;tag&gt; &quot;q&quot; &#39;s&#39;&nbsp;end</p>')).toBe(
      'a & b <tag> "q" \'s\' end',
    );
  });

  it('treats a missing or empty description as no body at all', () => {
    expect(plainText(undefined)).toBe('');
    expect(find([item({ description_html: '<p></p>' })], 'anything')).toEqual([]);
  });
});
