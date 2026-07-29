/**
 * Drives sync-mcp over real MCP stdio, the same way Claude Code / Codex will.
 *
 *   SYNC_GATEWAY_URL=... SYNC_AGENT_TOKEN=... SYNC_PROJECT_ID=... node test/smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = process.argv[2] ?? Math.random().toString(36).slice(2, 8);
let ok = true;
const check = (label, cond, detail = '') => {
  ok &&= cond;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: {
    PATH: process.env.PATH,
    SYNC_GATEWAY_URL: process.env.SYNC_GATEWAY_URL,
    SYNC_AGENT_TOKEN: process.env.SYNC_AGENT_TOKEN,
    SYNC_PROJECT_ID: process.env.SYNC_PROJECT_ID,
  },
});

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log('\ntools exposed:', names.join(', '));
check('exactly the 8 agent tools', names.length === 8);
check('no raw Plane API surface leaked', !names.some((n) => /issue|project|cycle|module/i.test(n)));

const callJson = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  try {
    return { isError: r.isError, data: JSON.parse(text), text };
  } catch {
    return { isError: r.isError, data: null, text };
  }
};

console.log('\ncapture → claim → complete, over MCP:');
const cap = await callJson('capture', {
  title: `MCP smoke ${run}`,
  body: 'Created through the MCP stdio transport to prove the client path works.',
  priority: 'low',
});
check('capture returns a work item', !cap.isError && !!cap.data?.workItemId, cap.data?.readableId);

const claim = await callJson('claim', { workItemId: cap.data.workItemId, ttlSeconds: 120 });
check('claim returns a lease with an epoch', !claim.isError && claim.data?.lease?.epoch === 1);

const held = await callJson('held', {});
check('held reports the claimed item', held.data?.leases?.some((l) => l.workItemId === cap.data.workItemId));

// Wrong epoch must be refused, and the refusal must tell the agent what to do.
const bad = await callJson('complete', {
  workItemId: cap.data.workItemId,
  epoch: 999,
  outcome: 'should not be accepted',
});
check('a wrong epoch is refused', bad.isError === true);
check('the refusal carries recovery guidance', /What to do:/.test(bad.text), bad.text.split('\n')[0]);

const done = await callJson('complete', {
  workItemId: cap.data.workItemId,
  epoch: claim.data.lease.epoch,
  outcome: 'Verified the MCP path end to end.',
});
check('complete succeeds for the holder', !done.isError && done.data?.closed === true);

await client.close();
console.log(`\n${ok ? 'ALL PASS' : 'FAILURES PRESENT'}`);
process.exit(ok ? 0 : 1);
