import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ArtefactKind } from './attest.js';

/**
 * Reading GitHub's webhook deliveries: what is signed, what is referenced, and
 * what actually landed.
 *
 * Pure on purpose. Everything here is a decision about text and bytes, and the
 * two decisions that can silently cause real damage — is this delivery genuine,
 * and does this string name one of our work items — are exactly the two that are
 * cheapest to test in isolation.
 */

/**
 * Is this delivery from GitHub?
 *
 * The endpoint transitions work items, so an unauthenticated one is a way for
 * anyone on the internet to close other people's work. Compared in constant time:
 * a `===` on an HMAC leaks the prefix length through timing, which is enough to
 * forge one byte at a time.
 */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Ref {
  /** Uppercased, e.g. `SYNC-42`. */
  readableId: string;
  /** The project identifier half, for checking it names a real project. */
  identifier: string;
  sequence: number;
  /**
   * The text said this change *finishes* the item, not merely that it touches it.
   * A bare mention corroborates evidence; only a closing reference transitions.
   */
  closing: boolean;
}

/**
 * GitHub's own closing keywords, which is the point: nobody has to learn a new
 * convention, and `Fixes SYNC-42` in a pull request body already reads correctly
 * to a human.
 */
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+([A-Za-z][A-Za-z0-9]{1,19}-\d{1,7})\b/gi;
const MENTION = /\b([A-Za-z][A-Za-z0-9]{1,19})-(\d{1,7})\b/g;

/**
 * Work item references in a piece of GitHub text.
 *
 * **Bare `#42` is deliberately not a reference here.** In a pull request body it
 * means GitHub issue 42 — that is what the author saw when they typed it and what
 * GitHub renders it as. Reading it as ours would let an ordinary cross-reference
 * close an unrelated work item, silently and permanently. Only the qualified form
 * is accepted. (Inside our own tracker `#42` *is* unambiguous, which is why
 * `evidence.ts` reads it and this does not: the same characters, two namespaces.)
 *
 * The qualified form still collides with ordinary words — `UTF-8`, `SHA-256`,
 * `covid-19`. Rather than guess, this returns the identifier half and the caller
 * discards anything that is not a real project. A reference that cannot name a
 * project is not a near miss; it is a different word.
 */
export function refsIn(text: string): Ref[] {
  if (!text) return [];
  const out = new Map<string, Ref>();

  const add = (raw: string, closing: boolean) => {
    const [ident, seq] = raw.toUpperCase().split('-') as [string, string];
    const readableId = `${ident}-${Number(seq)}`;
    const prev = out.get(readableId);
    // Closing wins: "Fixes SYNC-42. See also SYNC-42" is one closing reference.
    if (!prev || (closing && !prev.closing)) {
      out.set(readableId, { readableId, identifier: ident, sequence: Number(seq), closing });
    }
  };

  for (const m of text.matchAll(CLOSING)) add(m[1]!, true);
  for (const m of text.matchAll(MENTION)) add(`${m[1]}-${m[2]}`, false);
  return [...out.values()];
}

export interface Artefact {
  kind: ArtefactKind;
  value: string;
}

export interface Delivery {
  /** What this event says landed. */
  artefacts: Artefact[];
  /** Work items the text points at. */
  refs: Ref[];
  /** Who did it, for attribution on the Plane comment. */
  actor: string;
  /** Human-readable summary used in the comment we post. */
  summary: string;
  /** A merged pull request, or a push to the default branch. Mentions alone do not close. */
  landed: boolean;
}

interface PullRequestEvent {
  action?: string;
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    title?: string;
    body?: string | null;
    number?: number;
    merge_commit_sha?: string | null;
    head?: { ref?: string };
    merged_by?: { login?: string } | null;
    user?: { login?: string };
  };
  repository?: { full_name?: string; default_branch?: string };
}

interface PushEvent {
  ref?: string;
  repository?: { full_name?: string; default_branch?: string };
  pusher?: { name?: string };
  commits?: Array<{ id?: string; message?: string; url?: string }>;
}

/**
 * An event, read as "what landed and what does it say it finished".
 *
 * Returns null for everything we do not act on — including a pull request that
 * closed *without* merging, which is the case most worth getting right: it
 * references the item just as a merged one does, and treating it the same would
 * close work that was explicitly abandoned.
 */
export function readDelivery(event: string, payload: unknown): Delivery | null {
  if (event === 'pull_request') {
    const p = payload as PullRequestEvent;
    const pr = p.pull_request;
    if (!pr || p.action !== 'closed' || !pr.merged) return null;

    const text = [pr.title ?? '', pr.body ?? '', pr.head?.ref ?? ''].join('\n');
    const artefacts: Artefact[] = [];
    if (pr.html_url) artefacts.push({ kind: 'url', value: pr.html_url });
    if (pr.merge_commit_sha) artefacts.push({ kind: 'commit', value: pr.merge_commit_sha });

    const repo = p.repository?.full_name ?? 'unknown';
    return {
      artefacts,
      refs: refsIn(text),
      actor: pr.merged_by?.login ?? pr.user?.login ?? 'github',
      summary: `${repo}#${pr.number ?? '?'} merged${pr.title ? `: ${pr.title}` : ''}`,
      landed: true,
    };
  }

  if (event === 'push') {
    const p = payload as PushEvent;
    const branch = (p.ref ?? '').replace(/^refs\/heads\//, '');
    // Only the default branch. A push to a feature branch has not landed
    // anywhere, and treating it as evidence would confirm work that may still be
    // rejected in review.
    if (!branch || branch !== (p.repository?.default_branch ?? 'main')) return null;

    const commits = p.commits ?? [];
    if (commits.length === 0) return null;

    const artefacts: Artefact[] = [];
    const refs = new Map<string, Ref>();
    for (const c of commits) {
      if (c.id) artefacts.push({ kind: 'commit', value: c.id });
      for (const r of refsIn(c.message ?? '')) {
        const prev = refs.get(r.readableId);
        if (!prev || (r.closing && !prev.closing)) refs.set(r.readableId, r);
      }
    }

    const repo = p.repository?.full_name ?? 'unknown';
    return {
      artefacts,
      refs: [...refs.values()],
      actor: p.pusher?.name ?? 'github',
      summary: `${commits.length} commit${commits.length === 1 ? '' : 's'} pushed to ${repo}@${branch}`,
      landed: true,
    };
  }

  return null;
}
