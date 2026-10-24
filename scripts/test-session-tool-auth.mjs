import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';
import { installSessionTools } from '../plugins/qq-agent-presets/qq-session-tools.mjs';

let installedModules;
try { installedModules = dshModulesDir(); }
catch {
  console.log('SKIP session ToolRuntime integration: DSH installation is unavailable');
  process.exit(0);
}
const installed = async (name) => import(pathToFileURL(path.join(installedModules, '@deepseek-ai', name, 'lib', 'index.js')).href);
const { Context } = await installed('cordis');
const { default: SystemPrompt } = await installed('dsh-system-prompt');
const { ToolRuntime } = await installed('dsh-tools');
const { createScope } = await installed('dsh-scope');
const { createMcpToolDefinition } = await installed('dsh-mcp-client');

const ctx = new Context();
new SystemPrompt(ctx, {});
const tools = new ToolRuntime(ctx, {});
const agentA = { session: { id: 'session-A' } };
const agentB = { session: { id: 'session-B' } };
const scope = createScope(ctx, agentA);
const scopeB = createScope(ctx, agentB);
const calls = [];
const auth = new Map([
  ['session-A', { key: 'group:111', token: 'token-A' }],
  ['session-B', { key: 'group:222', token: 'token-B' }]
]);
const resolver = async (id, signal) => {
  if (signal.aborted) throw new Error('canceled');
  const value = auth.get(id);
  if (!value) throw new Error('revoked');
  return value;
};
installSessionTools(scope.ctx, resolver);
installSessionTools(scopeB.ctx, resolver);

const parameters = {
  type: 'object',
  properties: {
    key: { type: 'string' }, token: { type: 'string' }, messages: { type: 'string' },
    throughSeq: { type: 'integer' }
  },
  required: ['key', 'token', 'messages'],
  additionalProperties: false
};
const name = 'mcp__snowluma__qq_send_message';
const original = createMcpToolDefinition(ctx, {
  name, rawName: 'qq_send_message', description: 'Send QQ message', inputSchema: parameters,
  call: async (args, exec) => {
    calls.push({ args, exec });
    return { content: [{ type: 'text', text: `sent ${args.key}` }] };
  }
});
const dispose = tools.register(original);
const shown = tools.schemas(agentA).find((s) => s.name === name);
assert.ok(shown);
assert.deepEqual(shown.parameters.required, ['messages']);
assert.deepEqual(Object.keys(shown.parameters.properties).sort(), ['messages', 'throughSeq']);
assert.deepEqual(tools.schemas().find((s) => s.name === name).parameters, parameters);

let callId = 0;
const execute = (agent, args, signal = new AbortController().signal) => tools.execute({
  name, arguments: args, agent, signal, callId: `call-${++callId}`
});
const [resultA, resultB] = await Promise.all([
  execute(agentA, { messages: 'hello', throughSeq: 17 }),
  execute(agentB, { messages: 'world' })
]);
assert.equal(resultA.isError, false);
assert.equal(resultB.isError, false);
const callA = calls.find((c) => c.exec.agent === agentA);
const callB = calls.find((c) => c.exec.agent === agentB);
assert.deepEqual(callA.args, { messages: 'hello', throughSeq: 17, token: 'token-A', key: 'group:111' });
assert.deepEqual(callB.args, { messages: 'world', token: 'token-B', key: 'group:222' });
assert.deepEqual(callA.exec.arguments, { messages: 'hello', throughSeq: 17 });
assert.equal(callA.exec.signal.aborted, false);
assert.equal(resultA.content[0].text, 'sent group:111');

assert.equal((await execute(agentA, { messages: 'bad', key: 'group:222' })).isError, true);
assert.equal((await execute(agentA, { messages: 'bad', token: 'forged' })).isError, true);
assert.equal(calls.length, 2);
auth.delete('session-A');
assert.equal((await execute(agentA, { messages: 'after reset' })).isError, true);
assert.equal(calls.length, 2);
auth.set('session-A', { key: 'group:111', token: 'token-A2' });

// ToolRuntime snapshots projector callbacks on creation. Dispatch then reconnect the
// global MCP definition; the facade must select the new definition for this exec.
const pending = tools.createExecution({ name, arguments: { messages: 'image' }, agent: agentA,
  signal: new AbortController().signal, callId: `call-${++callId}` });
assert.equal(pending.kind, 'ready');
dispose();
const replacement = createMcpToolDefinition(ctx, {
  name, rawName: 'qq_send_message', description: 'Send QQ message', inputSchema: parameters,
  call: async (args, exec) => {
    calls.push({ args, exec });
    return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
  }
});
const disposeReplacement = tools.register(replacement);
const imageResult = await tools.completeScheduledExecution({ kind: 'dispatch', exec: pending.exec });
assert.equal(imageResult.isError, false);
assert.match(imageResult.content[0].text, /image unavailable/);
assert.equal(calls.at(-1).exec, pending.exec);
assert.equal(calls.at(-1).args.token, 'token-A2');
disposeReplacement();
assert.equal(tools.get(name, agentA), undefined, 'facade is removed when global MCP tool disappears');

const groupName = 'mcp__snowluma__qq_send_group_message';
const groupParameters = {
  type: 'object', properties: {
    groupId: { type: 'string' }, token: { type: 'string' }, message: { type: 'string' }
  }, required: ['groupId', 'message'], additionalProperties: false
};
const groupTool = createMcpToolDefinition(ctx, {
  name: groupName, rawName: 'qq_send_group_message', description: 'Send a group message',
  inputSchema: groupParameters, call: async (args, exec) => {
    calls.push({ args, exec });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
});
const disposeGroup = tools.register(groupTool);
const groupSchema = tools.schemas(agentA).find((s) => s.name === groupName);
assert.deepEqual(Object.keys(groupSchema.parameters.properties), ['message']);
const groupResult = await tools.execute({ name: groupName, arguments: { message: 'group' }, agent: agentA,
  signal: new AbortController().signal, callId: `call-${++callId}` });
assert.equal(groupResult.isError, false);
assert.equal(calls.at(-1).args.groupId, '111');
assert.equal(calls.at(-1).args.token, 'token-A2');
const canceled = new AbortController();
canceled.abort();
const callCount = calls.length;
assert.equal((await tools.execute({ name: groupName, arguments: { message: 'never' }, agent: agentA,
  signal: canceled.signal, callId: `call-${++callId}` })).isError, true);
assert.equal(calls.length, callCount);
disposeGroup();

const unsupportedName = 'mcp__snowluma__qq_unfamiliar';
const unsupported = tools.register({
  name: unsupportedName, description: 'Unfamiliar schema',
  parameters: { oneOf: [{ type: 'object', properties: { token: { type: 'string' }, key: { type: 'string' } } }] },
  output: { schema: { type: 'object', properties: {} }, render: () => [] },
  execute: () => { throw new Error('raw tool must never run'); }
});
const unavailable = tools.schemas(agentA).find((s) => s.name === unsupportedName);
assert.deepEqual(unavailable.parameters, { type: 'object', properties: {} });
assert.equal((await tools.execute({ name: unsupportedName, arguments: {}, agent: agentA,
  signal: new AbortController().signal, callId: `call-${++callId}` })).isError, true);
unsupported();

console.log('session-bound QQ ToolRuntime/MCP regression passed');
