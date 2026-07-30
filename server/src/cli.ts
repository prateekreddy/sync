/**
 * Operator CLI. Issuing an agent token is the one routine admin task, so it gets
 * a first-class command rather than a paragraph of SQL in a runbook.
 *
 *   node dist/cli.js issue-token --name sync-worker-3 --principal human:prateek \
 *                               [--capabilities backend,tests] [--plane-user <uuid>]
 *   node dist/cli.js revoke-token --name sync-worker-3
 *   node dist/cli.js list-tokens
 */
import { createPool } from './db.js';
import { issueToken } from './auth.js';

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const pool = createPool();

try {
  switch (cmd) {
    case 'issue-token': {
      const name = flag('name');
      const principal = flag('principal');
      if (!name || !principal) {
        throw new Error('--name and --principal are required');
      }
      const caps = flag('capabilities')?.split(',').filter(Boolean) ?? [];
      const planeUser = flag('plane-user');
      const planeToken = flag('plane-token');
      // Bound to the token so the agent's install needs no project configured.
      const project = flag('project');

      const { token } = await issueToken(pool, {
        name,
        principal,
        capabilities: caps,
        ...(planeUser ? { planeUserId: planeUser } : {}),
        ...(planeToken ? { planeToken } : {}),
        ...(project ? { defaultProjectId: project } : {}),
      });

      console.log(`\n  agent:    ${name}`);
      console.log(`  for:      ${principal}`);
      console.log(`  can pick: ${caps.length ? caps.join(', ') : 'anything ready'}`);
      console.log(`  project:  ${project ?? 'none — the agent must name one on every call'}`);
      console.log(
        `  writes as: ${
          planeToken
            ? 'its own Plane user (attributed natively in Plane)'
            : 'the gateway service account — pass --plane-token for real attribution'
        }`,
      );
      // The token line is deliberately the only line matching /token:/ — operators
      // and scripts extract it with grep, and a wrapped warning that happens to
      // begin with "token:" silently corrupts that.
      console.log(`\n  token:    ${token}`);
      console.log(`\n  Store it now — only its hash is kept, so it cannot be shown again.`);
      if (planeToken) {
        console.log(
          `  Give this agent ONLY the value above. It must never receive its own\n` +
            `  Plane credential: a Plane Member key lets an agent set assignee\n` +
            `  directly and bypass the lease entirely.`,
        );
      }
      console.log('');
      break;
    }

    case 'revoke-token': {
      const name = flag('name');
      if (!name) throw new Error('--name is required');
      const { rowCount } = await pool.query('update agent_token set active = false where name = $1', [
        name,
      ]);
      console.log(rowCount ? `revoked ${name}` : `no such agent: ${name}`);
      break;
    }

    case 'list-tokens': {
      const { rows } = await pool.query(
        `select name, principal, capabilities, active, last_seen_at
           from agent_token order by name`,
      );
      for (const r of rows) {
        const caps = r.capabilities.length ? r.capabilities.join(',') : 'any';
        const seen = r.last_seen_at ? new Date(r.last_seen_at).toISOString() : 'never';
        console.log(
          `  ${r.active ? '●' : '○'} ${r.name.padEnd(20)} for=${String(r.principal).padEnd(18)} caps=${caps.padEnd(16)} seen=${seen}`,
        );
      }
      break;
    }

    default:
      console.error('usage: issue-token | revoke-token | list-tokens');
      process.exitCode = 1;
  }
} finally {
  await pool.end();
}
