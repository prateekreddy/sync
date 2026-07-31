import { GatewayError } from './errors.js';

export interface WorkItem {
  id: string;
  sequence_id: number;
  /**
   * Optional because list responses do not carry it: `fields=` omits both this
   * and `assignees`, which nothing reads off a list, and a type that promised
   * them would be lying about two thirds of the objects in circulation.
   */
  project?: string;
  name: string;
  description_html?: string;
  state: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  assignees?: string[];
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
  /** Never expires: a project identifier is fixed at creation. */
  private identifierCache = new Map<string, string>();
  /**
   * item id -> module id, per project. Plane offers no reverse lookup.
   *
   * `ok` records whether the map was built successfully. A failed build is cached
   * too, briefly: without that, a `decompose` of ten children against an
   * unreachable module endpoint retries the whole lookup ten times, and each
   * retry is the full backoff ladder.
   */
  private moduleCache = new Map<
    string,
    { at: number; byItem: Map<string, string>; ok: boolean }
  >();

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
    scoped.identifierCache = this.identifierCache;
    scoped.moduleCache = this.moduleCache;
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

  /**
   * Every field any consumer of `listWorkItems` reads.
   *
   * Plane returns 29 fields per work item and its `fields` parameter cuts that to
   * whatever is named here. On a 34-item board that is 30,271 chars down to about
   * 14,000, and the saving is upstream, so the bytes never cross the network.
   *
   * Do not expect a dramatic number here. Measured per field, the cost is spread
   * almost evenly — `description_html` is only 17.6% — because most of the payload
   * is 36-char uuids and JSON key names repeated once per row. Going materially
   * lower would mean changing the response *shape*, which no parameter reaches.
   * This payload is also gateway-to-Plane only; what an agent receives is the
   * seven-field projection built from it.
   *
   * This list is load-bearing and fails silently when wrong: the readiness gate
   * screens on `is_draft`, `state`, `parent`, `labels` and `description_html`, so
   * dropping one does not raise anything, it just stops withholding work. Anything
   * added to `WorkItem` and read off a *list* must be added here too, and
   * test/fields.test.ts exists to make that failure loud.
   */
  static readonly LIST_FIELDS = [
    'id',
    'sequence_id',
    'name',
    'description_html',
    'state',
    'priority',
    'labels',
    'parent',
    'is_draft',
    'created_at',
    'updated_at',
  ] as const;

  listWorkItems(projectId: string): Promise<WorkItem[]> {
    const fields = PlaneClient.LIST_FIELDS.join(',');
    return this.listAll<WorkItem>(`/projects/${projectId}/work-items/?fields=${fields}`);
  }

  /**
   * Every project this client's token can see, with the identifier a readable id
   * needs.
   *
   * `visibleProjects()` in mint.ts answers the narrower question — is this one id
   * allowed — and returns bare ids, which cannot build `SYNC-42`. Both survive
   * because they authenticate differently: that one takes a raw Plane token
   * before any agent exists, this one is a method on an already-scoped client.
   */
  listProjects(): Promise<Array<{ id: string; identifier: string; name: string }>> {
    return this.listAll<{ id: string; identifier: string; name: string }>(
      '/projects/?fields=id,identifier,name',
    );
  }

  getWorkItem(projectId: string, id: string): Promise<WorkItem> {
    return this.request<WorkItem>('GET', `/projects/${projectId}/work-items/${id}/`);
  }

  /**
   * A project's readable identifier — the `SYNC` in `SYNC-42`.
   *
   * Cached for the process: it is chosen when the project is created and Plane
   * gives no way to change it afterwards, so re-reading it per completion would
   * be a request that can only ever return the same answer.
   */
  async projectIdentifier(projectId: string): Promise<string | undefined> {
    const hit = this.identifierCache.get(projectId);
    if (hit !== undefined) return hit;
    const p = await this.request<{ identifier?: string }>('GET', `/projects/${projectId}/`);
    if (p.identifier) this.identifierCache.set(projectId, p.identifier);
    return p.identifier;
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

  /**
   * Work item ids in a module.
   *
   * Paginated like every other list here, and returning full work items — only
   * the ids are kept, because the caller already has the items from the project
   * listing and Plane will not filter that listing for us anyway.
   *
   * An earlier version read this as a bare array. It is not, and the failure was
   * silent: `.map` on the envelope object threw, a caller's catch swallowed it,
   * and every module reported zero items. Hence `listAll`.
   *
   * Requires `module_view` on the project; without it Plane answers 404, which
   * reads like a wrong URL rather than a disabled feature.
   */
  async moduleIssueIds(projectId: string, moduleId: string): Promise<Set<string>> {
    const rows = await this.listAll<{ id: string }>(
      `/projects/${projectId}/modules/${moduleId}/module-issues/`,
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Which module a work item belongs to — the lookup Plane does not offer.
   *
   * Measured: a work item payload carries no module field at all, and
   * `?expand=modules` is ignored. Membership is readable only from the module
   * side, so the reverse direction costs one request per module and has to be
   * cached or it would land on every capture.
   *
   * Returns the first module found. An item can belong to several; there is no
   * basis for preferring one, and picking arbitrarily is honest only because the
   * caller uses this to *suggest* a module, never to move work between them.
   */
  async moduleOf(projectId: string, workItemId: string, ttlMs = 60_000): Promise<string | undefined> {
    const hit = this.moduleCache.get(projectId);
    // A failed build is trusted for less time than a good one: it should stop a
    // burst of lookups, not hide a project whose modules just came back.
    const ttl = hit && !hit.ok ? Math.min(ttlMs, 10_000) : ttlMs;
    if (hit && Date.now() - hit.at < ttl) return hit.byItem.get(workItemId);

    const byItem = new Map<string, string>();
    try {
      const mods = await this.modules(projectId);
      for (const m of mods) {
        for (const id of await this.moduleIssueIds(projectId, m.id)) {
          if (!byItem.has(id)) byItem.set(id, m.id);
        }
      }
    } catch {
      // Modules disabled on this project, or Plane unreachable. Inheriting a
      // module is a convenience; failing a capture over it would trade the
      // write-first primitive for a nicety.
      this.moduleCache.set(projectId, { at: Date.now(), byItem: new Map(), ok: false });
      return undefined;
    }

    this.moduleCache.set(projectId, { at: Date.now(), byItem, ok: true });
    return byItem.get(workItemId);
  }

  /**
   * Keep the membership cache honest about a write we just made.
   *
   * Without this the common chain breaks: an agent captures item A into a module,
   * then captures B while holding A, and B fails to inherit because the map was
   * built before A joined. Cheaper and more correct than shortening the TTL,
   * which would only narrow the window rather than close it.
   */
  private rememberModule(projectId: string, moduleId: string, issues: string[]): void {
    const hit = this.moduleCache.get(projectId);
    if (!hit) return;
    for (const id of issues) if (!hit.byItem.has(id)) hit.byItem.set(id, moduleId);
  }

  /** A project's modules — the epic layer. Requires `module_view` on the project. */
  modules(projectId: string): Promise<Array<{ id: string; name: string }>> {
    return this.listAll<{ id: string; name: string }>(`/projects/${projectId}/modules/`);
  }

  /**
   * Put work items in a module.
   *
   * Module membership is an edge, not a field on the item — Plane keeps it behind
   * its own endpoint, which is why nothing about it appears in a work item
   * listing and why a rollup costs a separate call.
   */
  async addToModule(projectId: string, moduleId: string, issues: string[]): Promise<unknown> {
    const res = await this.request(
      'POST',
      `/projects/${projectId}/modules/${moduleId}/module-issues/`,
      { issues },
    );
    this.rememberModule(projectId, moduleId, issues);
    return res;
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
   * Create a label and keep the cache truthful.
   *
   * Without the cache write, a capture that creates `backend` and a capture a few
   * seconds later would both miss and create it twice — near-duplicate labels being
   * exactly what makes label routing useless.
   */
  async createLabel(projectId: string, name: string, color = '#6B7280'): Promise<Label> {
    const label = await this.request<Label>('POST', `/projects/${projectId}/labels/`, {
      name,
      color,
    });
    const hit = this.labelCache.get(projectId);
    if (hit) hit.labels = [...hit.labels, label];
    return label;
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
