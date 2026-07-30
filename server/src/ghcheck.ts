import { GatewayError } from './errors.js';
import type { Evidence } from './evidence.js';

/**
 * Asking GitHub whether the thing a completion cited actually exists.
 *
 * `complete` is the notification. An agent calling it is telling us, at that
 * exact moment, that the work is done and here is the artefact — so that is the
 * moment to check, and no background machinery is needed to find out later.
 *
 * This deliberately does *not* try to answer "was it merged eventually". A pull
 * request is usually still open when the agent that opened it finishes, and
 * whether a human merges it afterwards is not the agent's to control. The
 * question worth asking synchronously is much sharper and much more valuable:
 * **does the cited artefact exist at all?** A fabricated sha, a pull request
 * number that was never opened, a link to nothing — those are the failures that
 * make a completion actively misleading, and every one of them is visible now.
 */

/** Did the cited work land? */
export type Landing =
  /** Merged, or an ancestor of the default branch. */
  | 'landed'
  /** Real, and not merged yet. An open pull request is the normal case. */
  | 'pending'
  /** GitHub says there is no such thing. The citation is wrong. */
  | 'absent'
  /** Not something we can ask about — no token, no repository, not GitHub, or GitHub was unreachable. */
  | 'unchecked';

export interface Check {
  kind: Evidence['kind'];
  value: string;
  status: Landing;
  /** Why, in words a human reading the board can act on. */
  detail: string;
}

export interface GitHubConfig {
  /** Read-only token. Without one, only public repositories can be checked. */
  token?: string | undefined;
  /** `owner/name`, used for bare commit shas, which carry no repository of their own. */
  defaultRepo?: string | undefined;
  apiBase: string;
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const COMMIT_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-f]{7,40})/i;

/**
 * One request, with a short deadline.
 *
 * `complete` ends a lease, and a lease must never fail to end because a third
 * party was slow. Anything that goes wrong here becomes `unchecked` — a stated
 * absence of information, never an accusation.
 */
async function ask(
  cfg: GitHubConfig,
  path: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    signal: AbortSignal.timeout(5_000),
  });
  const body = res.ok || res.status === 404 ? await res.json().catch(() => ({})) : {};
  return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
}

async function checkPullRequest(
  cfg: GitHubConfig,
  owner: string,
  repo: string,
  number: string,
): Promise<{ status: Landing; detail: string }> {
  const { ok, status, body } = await ask(cfg, `/repos/${owner}/${repo}/pulls/${number}`);

  if (status === 404) {
    // Ambiguous without a token: a private repository answers 404 to a stranger
    // rather than 403, so "does not exist" and "cannot see it" look identical.
    // Only claim it is absent when we had the credentials to know.
    return cfg.token
      ? { status: 'absent', detail: `${owner}/${repo}#${number} does not exist` }
      : {
          status: 'unchecked',
          detail: `${owner}/${repo}#${number} not visible — set GITHUB_TOKEN if the repository is private`,
        };
  }
  if (!ok) return { status: 'unchecked', detail: `GitHub answered ${status}` };

  if (body['merged'] === true) {
    return { status: 'landed', detail: `${owner}/${repo}#${number} is merged` };
  }
  if (body['state'] === 'closed') {
    return { status: 'absent', detail: `${owner}/${repo}#${number} was closed without merging` };
  }
  return { status: 'pending', detail: `${owner}/${repo}#${number} is open, not merged yet` };
}

/**
 * Is this commit on the default branch?
 *
 * One request rather than two: `compare` 404s when the sha is unknown, and its
 * `status` says where the commit sits relative to the branch — `identical` or
 * `behind` means the branch already contains it.
 */
async function checkCommit(
  cfg: GitHubConfig,
  owner: string,
  repo: string,
  sha: string,
): Promise<{ status: Landing; detail: string }> {
  const { ok, status, body } = await ask(
    cfg,
    `/repos/${owner}/${repo}/compare/HEAD...${encodeURIComponent(sha)}`,
  );

  if (status === 404) {
    return cfg.token
      ? { status: 'absent', detail: `no commit ${sha} in ${owner}/${repo}` }
      : {
          status: 'unchecked',
          detail: `${owner}/${repo} not visible — set GITHUB_TOKEN if the repository is private`,
        };
  }
  if (!ok) return { status: 'unchecked', detail: `GitHub answered ${status}` };

  const where = body['status'];
  if (where === 'identical' || where === 'behind') {
    return { status: 'landed', detail: `${sha} is on the default branch of ${owner}/${repo}` };
  }
  return {
    status: 'pending',
    detail: `${sha} exists in ${owner}/${repo} but is not on the default branch`,
  };
}

/**
 * Check one citation.
 *
 * Exported for its own sake: the routing from "a string an agent wrote" to "a
 * question GitHub can answer" is the whole of the logic worth testing, and it is
 * decided entirely by the shape of the value.
 */
export async function checkOne(cfg: GitHubConfig, e: Evidence): Promise<Check> {
  const out = (status: Landing, detail: string): Check => ({
    kind: e.kind,
    value: e.value,
    status,
    detail,
  });

  // A file path or a work item reference is evidence a human can follow, and it
  // counts against the "cited nothing" warning — but GitHub is not the authority
  // on either, so claiming to have checked one would be a lie.
  if (e.kind !== 'commit' && e.kind !== 'url') {
    return out('unchecked', 'not a GitHub artefact');
  }

  let probe: { status: Landing; detail: string };
  try {
    if (e.kind === 'url') {
      const pr = PR_URL.exec(e.value);
      if (pr) {
        probe = await checkPullRequest(cfg, pr[1]!, pr[2]!, pr[3]!);
      } else {
        const c = COMMIT_URL.exec(e.value);
        if (!c) return out('unchecked', 'not a GitHub pull request or commit URL');
        probe = await checkCommit(cfg, c[1]!, c[2]!, c[3]!);
      }
    } else {
      // A bare sha names no repository. Without a configured default there is
      // nothing to ask, and guessing would be worse than saying so.
      const repo = cfg.defaultRepo?.split('/');
      if (!repo || repo.length !== 2 || !repo[0] || !repo[1]) {
        return out('unchecked', 'no repository configured — set GITHUB_REPO to check bare commits');
      }
      probe = await checkCommit(cfg, repo[0], repo[1], e.value);
    }
  } catch (err) {
    // Unreachable, timed out, rate limited. Never an accusation.
    return out('unchecked', `could not reach GitHub: ${(err as Error).message}`);
  }

  return out(probe.status, probe.detail);
}

/**
 * Check everything a completion cited, concurrently.
 *
 * Bounded by how much an agent bothers to cite, which in practice is one or two
 * things; the cap exists so an outcome pasting fifty shas cannot turn one
 * `complete` into fifty requests against a shared rate limit.
 */
const MAX_CHECKS = 8;

export async function checkEvidence(
  cfg: GitHubConfig | null,
  evidence: Evidence[],
): Promise<Check[]> {
  if (!cfg) {
    return evidence.map((e) => ({
      kind: e.kind,
      value: e.value,
      status: 'unchecked' as const,
      detail: 'evidence checking is not configured on this gateway',
    }));
  }
  return Promise.all(evidence.slice(0, MAX_CHECKS).map((e) => checkOne(cfg, e)));
}

/**
 * The label an item earns when it cited something that does not exist.
 *
 * Deliberately distinct from `unverified`, which means *cited nothing at all*.
 * One is an agent being terse; the other is an agent being wrong, and a board
 * that shows them the same way loses the only distinction that matters.
 */
export const ABSENT_LABEL = 'evidence-missing';

/** Did anything cited turn out not to exist? That is the refusable failure. */
export function absent(checks: Check[]): Check[] {
  return checks.filter((c) => c.status === 'absent');
}

export function configFromEnv(env: NodeJS.ProcessEnv): GitHubConfig | null {
  // Nothing configured: checking is off, and every citation is honestly reported
  // as unchecked rather than silently treated as fine.
  if (!env['GITHUB_TOKEN'] && !env['GITHUB_REPO'] && env['GITHUB_CHECK'] !== 'on') return null;
  const repo = env['GITHUB_REPO'];
  if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new GatewayError('INVALID', `GITHUB_REPO must be "owner/name", got "${repo}"`);
  }
  return {
    token: env['GITHUB_TOKEN'],
    defaultRepo: repo,
    apiBase: (env['GITHUB_API_BASE'] ?? 'https://api.github.com').replace(/\/$/, ''),
  };
}
