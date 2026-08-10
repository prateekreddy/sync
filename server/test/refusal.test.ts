import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sizeSuffix } from '../src/routes.js';
import { callTool } from '../src/tools.js';
import {
  CaptureBody,
  CompleteBody,
  ConstrainBody,
  DecomposeBody,
  GatherBody,
} from '../src/toolspec.js';
import { RECOVERY } from '../src/errors.js';

/**
 * A refusal an agent cannot act on is nearly as bad as a wrong answer.
 *
 * The defect this covers: the REST layer computed exactly which field failed and
 * why, and the MCP layer forwarded only the code, the message and the recovery
 * line. So `complete` with an over-long `outcome` arrived as "INVALID: Request
 * validation failed / Request was malformed" — no field, no limit, no value —
 * and the only way to learn about the 2000-character cap was to read
 * `toolspec.ts`.
 *
 * That is the shape of failure this repo keeps finding: nothing is incorrect,
 * information is just dropped between two layers that each look right alone. So
 * the assertions below follow the message across the boundary rather than
 * checking either side in isolation.
 */

const issuesFor = (body: unknown): z.ZodIssue[] => {
  const r = CompleteBody.safeParse(body);
  if (r.success) throw new Error('expected this body to be rejected');
  return r.error.issues;
};

const validBody = {
  workItemId: '00000000-0000-4000-8000-000000000000',
  epoch: 1,
  outcome: 'done',
};

describe('a rejected field says how far over it was', () => {
  it('reports the length actually sent, not only the cap', () => {
    const body = { ...validBody, outcome: 'x'.repeat(2160) };
    const issue = issuesFor(body).find((i) => i.path[0] === 'outcome');

    expect(issue).toBeDefined();
    // The number is the point: an agent trimming blind against a cap it cannot
    // see costs a round trip per attempt.
    expect(sizeSuffix(issue as z.ZodIssue, { body })).toBe(' — you sent 2160');
    expect((issue as z.ZodIssue).message).toContain('2000');
  });

  it('counts array entries, not characters, for an over-long refs list', () => {
    const body = { ...validBody, refs: Array.from({ length: 51 }, (_, i) => `SYNC-${i + 1}`) };
    const issue = issuesFor(body).find((i) => i.path[0] === 'refs');

    expect(sizeSuffix(issue as z.ZodIssue, { body })).toBe(' — you sent 51');
  });

  it('stays silent when it cannot know the size', () => {
    // A wrong number is worse than none. A missing field has no length, and a
    // number out of range already carries the value in Zod's own message.
    const missing = issuesFor({ ...validBody, outcome: undefined });
    for (const i of missing) expect(sizeSuffix(i, { body: {} })).toBe('');

    const tooBig = issuesFor({ ...validBody, epoch: 0 });
    for (const i of tooBig) expect(sizeSuffix(i, { body: { epoch: 0 } })).toBe('');
  });

  it('finds the value in the query when the route validated one', () => {
    const body = { ...validBody, outcome: 'x'.repeat(2160) };
    const issue = issuesFor(body).find((i) => i.path[0] === 'outcome') as z.ZodIssue;

    // GET routes parse `req.query`; falling back rather than reporting nothing
    // is what keeps this useful on `find` and `search`.
    expect(sizeSuffix(issue, { query: { outcome: 'y'.repeat(2160) } })).toBe(' — you sent 2160');
  });
});

/**
 * The layer that actually dropped the information. `callTool` reads the REST
 * reply and renders what the model sees, and it used to pick `error`, `message`
 * and `recovery` out of a payload that also carried `fields`.
 */
describe('the field detail survives the trip to the model', () => {
  const refusal = {
    error: 'INVALID',
    message: 'Request validation failed',
    recovery: RECOVERY.INVALID,
    fields: [{ field: 'outcome', problem: 'String must contain at most 2000 character(s) — you sent 2160' }],
  };

  const deps = {
    app: {
      log: { warn: () => {}, error: () => {} },
      inject: async () => ({ statusCode: 400, body: JSON.stringify(refusal) }),
    },
    pool: {},
    plane: null,
  } as unknown as Parameters<typeof callTool>[0];

  it('names the field, the limit, and the size sent', async () => {
    const out = await callTool(deps, {} as never, 'Bearer t', 'complete', {
      workItemId: '00000000-0000-4000-8000-000000000000',
      epoch: 1,
      outcome: 'x'.repeat(2160),
    });

    const rendered = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(out.isError).toBe(true);
    // All three, because any one alone still leaves the caller guessing: the
    // field without the limit, or the limit without which field it applies to.
    expect(rendered).toContain('outcome');
    expect(rendered).toContain('2000');
    expect(rendered).toContain('2160');
    expect(rendered).toContain(RECOVERY.INVALID);
  });

  it('renders a refusal that carries no fields without inventing structure', async () => {
    // Most refusals are not schema failures — NOT_HOLDER, STALE_EPOCH — and must
    // not grow an empty section where the fields would go.
    const plain = {
      app: {
        log: { warn: () => {}, error: () => {} },
        inject: async () => ({
          statusCode: 409,
          body: JSON.stringify({
            error: 'STALE_EPOCH',
            message: 'reclaimed',
            recovery: RECOVERY.STALE_EPOCH,
          }),
        }),
      },
      pool: {},
      plane: null,
    } as unknown as Parameters<typeof callTool>[0];

    const out = await callTool(plain, {} as never, 'Bearer t', 'release', {
      workItemId: '00000000-0000-4000-8000-000000000000',
      epoch: 1,
      reason: 'handing it back',
    });
    const rendered = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');

    expect(rendered).toBe(`STALE_EPOCH: reclaimed\n\nWhat to do: ${RECOVERY.STALE_EPOCH}`);
  });
});

describe('the recovery line tells the caller what to do', () => {
  it('does not merely restate the code', () => {
    // It used to read "Request was malformed.", which says nothing the code
    // `INVALID` did not already say. What it must convey is that retrying the
    // same call is futile — the one thing an agent would otherwise try.
    expect(RECOVERY.INVALID).not.toBe('Request was malformed.');
    expect(RECOVERY.INVALID).toMatch(/fail identically|same thing/i);
  });

  it('does not promise a field list, because not every INVALID has one', () => {
    // A near-miss label name, a rejected epoch, an unparseable repo setting:
    // all INVALID, none with `fields`. A recovery line naming "the listed
    // fields" would send those callers looking for something not there.
    expect(RECOVERY.INVALID).not.toMatch(/listed field/i);
  });
});

/**
 * Text that ends in the wreckage of the caller's own tool call (SYNC-69).
 *
 * An agent that closes `<body>` early leaves the rest of its XML inside the
 * parameter. Three items were stored carrying it — SYNC-57, SYNC-64, SYNC-68 —
 * each ending in a literal `</body> <priority>high</priority> </invoke>`, and a
 * fourth, SYNC-67, was still carrying it when this was written.
 *
 * The debris in the record is the smaller cost. Everything after the premature
 * close is dropped, which in all three cases included the priority: items meant
 * to be `high` arrived as `none`. So the call that arrived is not the call the
 * agent wrote, and repairing the body would leave the priority wrong while
 * looking like it worked. Refusing is the only answer that does not silently
 * store a different intention than the one sent.
 */
describe('a body that ends in tool-call debris', () => {
  const capture = (body: string) =>
    CaptureBody.safeParse({
      projectId: '00000000-0000-4000-8000-000000000000',
      title: 'something worth doing',
      body,
    });

  const tags = ['body', 'priority', 'labels', 'invoke', 'parameter', 'function_calls'];

  it.each(tags)('is refused when it ends in </%s>', (tag) => {
    const r = capture(`Real prose that got cut short.</${tag}>`);
    expect(r.success).toBe(false);
  });

  it('is refused for the exact shape three items were stored with', () => {
    const r = capture('The description.</body> <priority>high</priority> </invoke>');
    expect(r.success).toBe(false);
    // The message has to say what to do, because the agent cannot see what was
    // dropped — that is the whole reason this is not a silent repair.
    expect(r.error?.issues[0]?.message).toMatch(/dropped/);
    expect(r.error?.issues[0]?.message).toMatch(/Nothing was saved/);
  });

  it('allows a closing tag that is not at the end', () => {
    // Anchored at the end deliberately. Somebody writing about HTML, or quoting
    // this very defect in a bug report, is not making the mistake — and a guard
    // that refuses them does more harm than the bug.
    expect(capture('The parser chokes on </body> when it appears mid-document.').success).toBe(
      true,
    );
  });

  it('allows ordinary prose, including angle brackets', () => {
    expect(capture('Fails when count < 3 and the flag is <unset>.').success).toBe(true);
  });

  /**
   * Every free-text field on the same path, which the item asked to be checked.
   * A guard on `capture` alone would leave three doors open onto the same board.
   */
  it('covers decompose, gather, constrain and complete too', () => {
    const debris = 'Cut short.</body> <priority>high</priority> </invoke>';
    const project = '00000000-0000-4000-8000-000000000000';

    expect(
      DecomposeBody.safeParse({
        projectId: project,
        parentId: project,
        children: [{ title: 'a child that says what it delivers', body: debris }],
      }).success,
    ).toBe(false);

    expect(
      GatherBody.safeParse({
        projectId: project,
        workItemIds: [project],
        title: 'a container that names an outcome',
        body: debris,
      }).success,
    ).toBe(false);

    expect(
      ConstrainBody.safeParse({
        projectId: project,
        workItemId: project,
        requirement: debris,
      }).success,
    ).toBe(false);

    expect(
      CompleteBody.safeParse({ workItemId: project, epoch: 1, outcome: debris }).success,
    ).toBe(false);
  });
});
