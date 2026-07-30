import { GatewayError } from './errors.js';

export interface WorkItem {
  id: string;
  sequence_id: number;
  project: string;
  name: string;
  description_html?: string;
  state: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  assignees: string[];
  labels: string[];
  parent: string | null;
  is_draft: boolean;
  created_at: string;
  updated_at: string;
}

export interface State {
  id: string;
  name: string;
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  default: boolean;
}

/**
 * A project label. Work items reference labels by **id**, never by name, so
 * anything matching on a label's meaning -- the readiness gate's blocking
 * labels, capability routing -- has to resolve ids through here first.
 */
export interface Label {
  id: string;
  name: string;
}

/**
 * Plane's relation vocabulary, as returned by the relations endpoint.
 * Note there is no `discovered_from`: provenance is recorded as `relates_to`
 * plus an explanatory comment. See link() in routes.ts.
 */
export interface Relations {
  blocking: RelatedRef[];
  blocked_by: RelatedRef[];
  duplicate: RelatedRef[];
  relates_to: RelatedRef[];
  start_after: RelatedRef[];
  start_before: RelatedRef[];
  finish_after: RelatedRef[];
  finish_before: RelatedRef[];
}

/**
 * What Plane actually returns in a relations payload — ids only. Notably there is
 * no `state`, so deciding whether a blocker is finished requires fetching it.
 */
export interface RelatedRef {
  project_id: string;
  issue_id: string;
}

export type RelationType = 'blocking' | 'blocked_by' | 'duplicate' | 'relates_to';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plane REST client.
 *
 * Every agent reaches Plane through this one client, so from Plane's side we are
 * a single API consumer sharing a single rate-limit budget. That makes backoff a
 * correctness concern rather than politeness: without it one busy agent starves
 * all the others.
 *
 * Uses the `work-items/` routes rather than the older `issues/` aliases -- only
 * the former exposes relations, which the readiness gate depends on.
 */
export class PlaneClient {
  private stateCache = new Map<string, { at: number; states: State[] }>();
  private labelCache = new Map<string, { at: number; labels: Label[] }>();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly workspaceSlug: string,
    private readonly maxRetries = 4,
  ) {}

  /**
   * A view of this client that authenticates as a different Plane user.
   *
   * Plane exposes no impersonation header, so the only way to have Plane's own
   * activity log attribute a change to an agent is to send it with that agent's
   * token. The state cache is shared deliberately: states are workspace data, not
   * per-user, and re-fetching them per agent would multiply rate-limit spend for
   * identical results.
   */
  as(token: string | null | undefined): PlaneClient {
    if (!token || token === this.apiKey) return this;
    const scoped = new PlaneClient(this.baseUrl, token, this.workspaceSlug, this.maxRetries);
    scoped.stateCache = this.stateCache;
    scoped.labelCache = this.labelCache;
    return scoped;
  }

  private get root() {
    return `${this.baseUrl.replace(/\/$/, '')}/api/v1/workspaces/${this.workspaceSlug}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.root + path, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        lastErr = err;
        await sleep(2 ** attempt * 250);
        continue;
      }

      if (res.ok) {
        return (res.status === 204 ? undefined : await res.json()) as T;
      }

      // Follow Plane's own guidance on when to return rather than guessing.
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const waitMs =
          Number.isFinite(reset) && reset > 0
            ? Math.min(Math.max(reset * 1000 - Date.now(), 1_000), 60_000)
            : 2 ** attempt * 500;
        lastErr = new GatewayError('UPSTREAM', 'Plane rate limited (429)', { path });
        await sleep(waitMs);
        continue;
      }

      if (res.status >= 500) {
        lastErr = new GatewayError('UPSTREAM', `Plane ${res.status} on ${method} ${path}`, { path });
        await sleep(2 ** attempt * 250);
        continue;
      }

      // Any other 4xx is our bug, not a transient fault. Retrying would only burn
      // the rate-limit budget the rest of the fleet is sharing.
      const text = await res.text().catch(() => '');
      throw new GatewayError(
        res.status === 404 ? 'NOT_FOUND' : 'INVALID',
        `Plane ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`,
        { status: res.status, path },
      );
    }

    throw lastErr instanceof GatewayError
      ? lastErr
      : new GatewayError('UPSTREAM', `Plane unreachable after ${this.maxRetries} retries`, {
          path,
          cause: String(lastErr),
        });
  }

  /**
   * Plane paginates by cursor; pull every page.
   *
   * `per_page` is set explicitly rather than left to Plane's default. The default
   * happens to be large today, but it is not part of any contract — if a future
   * release lowered it to 20, every list here would silently turn into five
   * requests against a per-token rate limit, and the first symptom would be
   * agents failing under load for no visible reason.
   */
  private async listAll<T>(path: string, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    let guard = 0;

    const sep = path.includes('?') ? '&' : '?';
    const sized = `${path}${sep}per_page=${perPage}`;

    while (guard++ < 50) {
      const url = cursor ? `${sized}&cursor=${encodeURIComponent(cursor)}` : sized;
      const page = await this.request<{
        results: T[];
        next_page_results: boolean;
        next_cursor?: string;
      }>('GET', url);

      out.push(...(page.results ?? []));
      if (!page.next_page_results || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  listWorkItems(projectId: string): Promise<WorkItem[]> {
    return this.listAll<WorkItem>(`/projects/${projectId}/work-items/`);
  }

  getWorkItem(projectId: string, id: string): Promise<WorkItem> {
    return this.request<WorkItem>('GET', `/projects/${projectId}/work-items/${id}/`);
  }

  createWorkItem(projectId: string, body: Record<string, unknown>): Promise<WorkItem> {
    return this.request<WorkItem>('POST', `/projects/${projectId}/work-items/`, body);
  }

  updateWorkItem(projectId: string, id: string, body: Record<string, unknown>): Promise<WorkItem> {
    return this.request<WorkItem>('PATCH', `/projects/${projectId}/work-items/${id}/`, body);
  }

  comment(projectId: string, id: string, html: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/work-items/${id}/comments/`, {
      comment_html: html,
    });
  }

  /** Structured relations — the readiness gate reads `blocked_by` from here. */
  relations(projectId: string, id: string): Promise<Relations> {
    return this.request<Relations>('GET', `/projects/${projectId}/work-items/${id}/relations/`);
  }

  relate(
    projectId: string,
    id: string,
    relationType: RelationType,
    related: string[],
  ): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/work-items/${id}/relations/`, {
      relation_type: relationType,
      issues: related,
    });
  }

  /**
   * The Plane account this client authenticates as.
   *
   * Lives outside `/workspaces/`, so it cannot go through `request()`. Used to
   * find out whether an agent is writing as its own principal, which decides
   * whether provenance is worth printing at all.
   */
  async me(): Promise<{ id: string; email: string }> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1/users/me/`, {
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new GatewayError('UPSTREAM', `Plane ${res.status} on GET /users/me/`);
    const me = (await res.json()) as { id?: string; email?: string };
    return { id: me.id ?? '', email: me.email ?? '' };
  }

  /** Workspace-wide search. Backs capture's dedup-on-write. */
  async search(query: string): Promise<Array<{ id: string; name: string; sequence_id: number; project_id: string; project__identifier: string }>> {
    const res = await this.request<{ issues?: Array<Record<string, unknown>> }>(
      'GET',
      `/work-items/search/?search=${encodeURIComponent(query)}`,
    );
    return (res.issues ?? []) as never;
  }

  /** States change rarely; caching keeps readiness checks off the rate limit. */
  async states(projectId: string, ttlMs = 60_000): Promise<State[]> {
    const hit = this.stateCache.get(projectId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.states;

    const states = await this.listAll<State>(`/projects/${projectId}/states/`);
    this.stateCache.set(projectId, { at: Date.now(), states });
    return states;
  }

  /**
   * Labels, cached like states and for the same reason: the readiness gate reads
   * them on every browse, and they change far more rarely than work items do.
   */
  async labels(projectId: string, ttlMs = 60_000): Promise<Label[]> {
    const hit = this.labelCache.get(projectId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.labels;

    const labels = await this.listAll<Label>(`/projects/${projectId}/labels/`);
    this.labelCache.set(projectId, { at: Date.now(), labels });
    return labels;
  }

  /**
   * id -> lowercased name, for matching a work item's `labels` against anything
   * written by a human. Lowercased here rather than at each call site so the two
   * consumers cannot drift on casing.
   */
  async labelNames(projectId: string): Promise<Map<string, string>> {
    return new Map((await this.labels(projectId)).map((l) => [l.id, l.name.toLowerCase()]));
  }

  async stateByGroup(projectId: string, group: State['group']): Promise<State | undefined> {
    const all = await this.states(projectId);
    return all.find((s) => s.group === group && s.default) ?? all.find((s) => s.group === group);
  }

  async stateGroupOf(projectId: string, stateId: string): Promise<State['group'] | undefined> {
    return (await this.states(projectId)).find((s) => s.id === stateId)?.group;
  }
}
