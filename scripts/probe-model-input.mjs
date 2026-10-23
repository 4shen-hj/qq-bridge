import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import yaml from 'js-yaml';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv.indexOf('--output');
const compare = process.argv.indexOf('--compare');
const size = (value) => ({ characters: value.length, utf8Bytes: Buffer.byteLength(value) });
const withoutDescriptions = (value, parentKey = '') => Array.isArray(value)
  ? value.map((item) => withoutDescriptions(item))
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description' || parentKey === 'properties').map(([key, item]) => [key, withoutDescriptions(item, key)]))
    : value;
const now = Date.UTC(2026, 9, 23, 12);
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

let fixture;
let client;
let bridge;
try {
  fixture = await fs.mkdtemp(path.join(root, '.tmp-input-probe-'));
  await fs.mkdir(path.join(fixture, 'src'));
  for (const name of ['mcp-snowluma-safe.js', 'qq-model-view.js', 'sensitive.js']) {
    await fs.copyFile(path.join(root, 'src', name), path.join(fixture, 'src', name));
  }
  await fs.writeFile(path.join(fixture, 'config.json'), '{}');
  client = new Client({ name: 'offline-model-input-probe', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(fixture, 'src/mcp-snowluma-safe.js')],
    cwd: fixture, stderr: 'pipe',
  }));
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  const preset = yaml.load(await fs.readFile(path.join(root, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8'));
  const prefix = preset.find((row) => row.id === 'persona').config.prefix;
  bridge = await bridgeHarness({
    globals: { Date: FixtureDate },
    config: { socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } },
    files: { 'state/current-role.json': { role: 'fixture-role', mode: 'active' }, 'roles/fixture-role.md': '你是测试角色，喜欢读书。' },
  });
  bridge.setMode('reserved2');
  bridge.setSelfIdentity('测试昵称', '10000');
  const state = bridge.getSocialV2State('group:456');
  state.agentToken = 'fixture-agent-token';
  bridge.appendSocialV2Message('group:456', '测试成员', '今晚一起聊天吗', '今晚一起聊天吗', false, false, '1001', [], '10001', []);
  const ordinary = bridge.buildWakePromptV2('group:456', 'atMention@seq1');
  const bootstrap = bridge.buildWakePromptV2('group:456', 'bootstrap');
  assert.ok(ordinary.includes('fixture-agent-token'));
  assert.ok(ordinary.includes('group:456'));
  assert.ok(bootstrap.includes('qq_get_prompt'));
  assert.equal(bridge.calls.sent.length, 0);
  assert.equal(bridge.calls.prompts.length, 0);
  const report = {
    scope: 'Offline QQ MCP tools/list with all tool flags enabled and no mode file (includes legacy read tools); synthetic reserved2 wake with stickers disabled. Excludes history, other MCP servers, provider framing and model tokenization.',
    toolCount: tools.length,
    schemaContractSha256: crypto.createHash('sha256').update(JSON.stringify(withoutDescriptions(tools))).digest('hex'),
    measurements: {
      qqToolSchema: size(JSON.stringify(tools)), personaPrefix: size(prefix),
      ordinaryWake: size(ordinary), bootstrapWake: size(bootstrap),
    },
    toolDescriptions: tools.map(({ name, description, inputSchema }) => ({
      name, descriptionCharacters: description?.length ?? 0, inputSchemaCharacters: JSON.stringify(inputSchema).length,
    })),
  };
  if (compare !== -1) {
    assert.ok(process.argv[compare + 1], '--compare requires a saved report');
    const before = JSON.parse(await fs.readFile(process.argv[compare + 1], 'utf8'));
    assert.equal(report.toolCount, before.toolCount, 'tool count changed');
    assert.equal(report.schemaContractSha256, before.schemaContractSha256, 'tool contract changed beyond descriptions');
    report.comparison = Object.fromEntries(Object.entries(report.measurements).map(([name, current]) => [name, {
      before: before.measurements[name], after: current,
    }]));
  }
  if (output !== -1) {
    assert.ok(process.argv[output + 1], '--output requires a report path');
    await fs.writeFile(process.argv[output + 1], JSON.stringify(report, null, 2) + '\n');
  }
  const { toolDescriptions, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (client) await client.close();
  if (bridge) await bridge.close();
  if (fixture) {
    assert.equal(path.dirname(fixture), path.resolve(root));
    assert.ok(path.basename(fixture).startsWith('.tmp-input-probe-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
