import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { issueToken, type Actor } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { PlaneClient, type State, type WorkItem } from '../src/plane.js';
import { registerRoutes } from '../src/routes.js';
import { callTool, type AskHuman } from '../src/tools.js';
import { NO_RELATIONS } from './relations.js';

/**
 * Who is allowed to say yes to a regrouping.
 *
 * `gather` is refused until the call carries the name of a person who agreed, and
 * the only thing that can put that name there is an elicitation the model does
 * not author. This is the same lesson as `takeover: true`, which was a boolean an
 * agent set to assert that somebody had agreed — the argument *was* the trust.
 */
const pool = createPool(
  process.env.GATEWAY_DATABASE_URL ?? 'postgres://agent_gw:agent_gw_dev@localhost:15432/gateway',
);

const PROJECT = randomUUID();
const CONTAINER = randomUUID();
const LOOSE = randomUUID();

const STATES: State[] = [{ id: 'backlog', name: 'Backlog', group: 'backlog', default: true }];

const wi = (id: string, name: string): WorkItem => ({
  id,
  sequence_id: 1,
  project: PROJECT,
  name,
  description_html: '<p>enough to act on</p>',
  state: 'backlog',
  priority: 'medium',
  assignees: [],
  labels: [],
  parent: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

let updates: Array<{ id: string; body: Record<string, unknown> }> = [];

function fakePlane(): PlaneClient {
  const items = [wi(CONTAINER, 'A container'), wi(LOOSE, 'Something loose')];
  const plane = Object.assign(new PlaneClient('http://plane.invalid', 'k', 'ws'), {
    as: () => plane,
    listProjects: async () => [{ id: PROJECT, identifier: 'P', name: 'Project' }],
    listWorkItems: async () => items,
    getWorkItem: async (_p: string, id: string) => items.find((i) => i.id === id),
    states: async () => STATES,
    labels: async () => [],
    labelNames: async () => new Map(),
    modules: async () => [],
    moduleIssueIds: async () => new Set<string>(),
    relations: async () => NO_RELATIONS,
    members: async () => [],
    stateByGroup: async () => STATES[0],
    updateWorkItem: async (_p: string, id: string, body: Record<string, unknown>) => {
      updates.push({ id, body });
      return items.find((i) => i.id === id)!;
    },
    comment: async () => ({}),
    createWorkItem: async (_p: string, body: Record<string, unknown>) => wi(randomUUID(), String(body['name'])),
    search: async () => [],
  }) as unknown as PlaneClient;
  return plane;
}

async function harness() {
  const app = Fastify();
  registerRoutes(app, {
    pool,
    plane: fakePlane(),
    allowAgentClose: true,
    evidencePolicy: 'warn',
    planeMcp: null,
    planeBaseUrl: 'http://plane.invalid',
    workspaceSlug: 'ws',
    github: null,
    allowMinting: false,
    mintRatePerMinute: 10,
  });
  await app.ready();

  process.env.GATEWAY_TOKEN_KEY ??= 'a'.repeat(64);
  const { token } = await issueToken(pool, {
    name: `t-gth-${randomUUID().slice(0, 8)}/worker`,
    principal: 'human:me@example.com',
    planeToken: 'plane_pat_test',
    planeUserId: randomUUID(),
  });
  return { app, token };
}

/** A gather made the way an agent actually makes one — through the tool surface. */
async function gatherViaTool(
  app: Awaited<ReturnType<typeof harness>>['app'],
  token: string,
  args: Record<string, unknown>,
  askHuman?: AskHuman,
) {
  const deps = {
    app,
    pool,
    plane: null,
    rest: fakePlane(),
    ...(askHuman ? { askHuman } : {}),
  } as unknown as Parameters<typeof callTool>[0];
  const actor = {
    holder: 'agent:t-gth/worker',
    principal: 'human:me@example.com',
    defaultProjectId: PROJECT,
    capabilities: [],
  } as unknown as Actor;
  const out = await callTool(deps, actor, `Bearer ${token}`, 'gather', args);
  const text = (out.content[0] as { text?: string } | undefined)?.text ?? '';
  return { out, text };
}

const ARGS = { projectId: PROJECT, workItemIds: [LOOSE], containerId: CONTAINER };

beforeEach(() => {
  updates = [];
});

afterAll(async () => {
  await pool.end();
});

describe('who may agree to a regrouping', () => {
  it('files the items once a person says yes', async () => {
    const { app, token } = await harness();
    const asked: string[] = [];
    const { text } = await gatherViaTool(app, token, ARGS, async (m) => {
      asked.push(m);
      return 'approved';
    });

    expect(asked[0]).toContain('Something loose');
    expect(updates).toEqual([{ id: LOOSE, body: { parent: CONTAINER } }]);
    expect(text).toContain('"complete": true');
    await app.close();
  });

  it('attributes it to the human the agent acts for, not the agent', async () => {
    // The elicitation proves that *a* person at this client answered; it cannot
    // say which. Recording the principal is the same attribution the rest of the
    // gateway uses, and it names somebody accountable rather than a process.
    const { app, token } = await harness();
    const { text } = await gatherViaTool(app, token, ARGS, async () => 'approved');
    expect(text).toContain('"complete": true');
    // The name reaches Plane through the container comment; what matters here is
    // that the retry carried one at all, which the endpoint refuses without.
    expect(updates).toHaveLength(1);
    await app.close();
  });

  it('changes nothing when they say no, and says to write the proposal down', async () => {
    const { app, token } = await harness();
    const { out, text } = await gatherViaTool(app, token, ARGS, async () => 'refused');
    expect(out.isError).toBe(true);
    expect(text).toContain('said no');
    expect(text).toContain('Write down what you proposed');
    expect(updates).toEqual([]);
    await app.close();
  });

  it('changes nothing when there is nobody to ask', async () => {
    // A headless run. Telling the agent it was refused would be a lie about a
    // conversation that never happened, so the original refusal stands with its
    // own recovery line.
    const { app, token } = await harness();
    const { out, text } = await gatherViaTool(app, token, ARGS);
    expect(out.isError).toBe(true);
    expect(text).toContain('NEEDS_APPROVAL');
    expect(updates).toEqual([]);
    await app.close();
  });

  it('does not believe an agent that approves itself', async () => {
    // The whole point of the field. An agent that sends `approvedBy` is not
    // refused, it is simply not believed: the value is stripped before the
    // request is built, so the endpoint still refuses and a person is still
    // asked. Without the strip this would be `takeover: true` again.
    const { app, token } = await harness();
    let asked = 0;
    await gatherViaTool(
      app,
      token,
      { ...ARGS, approvedBy: 'human:definitely-a-person@example.com' },
      async () => {
        asked++;
        return 'refused';
      },
    );
    expect(asked).toBe(1);
    expect(updates).toEqual([]);
    await app.close();
  });

  it('refuses a self-approved call outright when nobody can be asked', async () => {
    const { app, token } = await harness();
    const { out } = await gatherViaTool(app, token, {
      ...ARGS,
      approvedBy: 'human:definitely-a-person@example.com',
    });
    expect(out.isError).toBe(true);
    expect(updates).toEqual([]);
    await app.close();
  });
});
