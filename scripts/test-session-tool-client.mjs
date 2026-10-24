import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-auth-client-'));
const pluginDir = path.join(root, 'plugins', 'qq-agent-presets');
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(root, 'state'));
fs.copyFileSync(new URL('../plugins/qq-agent-presets/qq-session-tools.mjs', import.meta.url), path.join(pluginDir, 'qq-session-tools.mjs'));
const { resolveSession } = await import(pathToFileURL(path.join(pluginDir, 'qq-session-tools.mjs')).href);
const realFetch = globalThis.fetch;
const observed = [];
globalThis.fetch = async (url, options) => {
  observed.push({ url: String(url), options });
  return { ok: true, json: async () => ({ ok: true, key: 'group:456', token: 'fixture-agent-token' }) };
};

try {
  const config = path.join(root, 'config.json');
  const stateToken = path.join(root, 'state', 'console-token');
  fs.writeFileSync(config, '\uFEFF' + JSON.stringify({ consolePort: 3131, consoleToken: 'fixture-console-token' }));
  assert.deepEqual(await resolveSession('session A', new AbortController().signal), {
    key: 'group:456', token: 'fixture-agent-token'
  });
  assert.equal(observed.at(-1).url, 'http://127.0.0.1:3131/api/internal/session-tool-auth?sessionId=session%20A');
  assert.equal(observed.at(-1).options.headers['x-console-token'], 'fixture-console-token');
  assert.equal(observed.at(-1).options.headers['x-agent-token'], undefined);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(resolveSession('session A', aborted.signal), /QQ 工具调用已取消/);
  fs.writeFileSync(config, JSON.stringify({ consolePort: 3131, consoleToken: 'short' }));
  fs.writeFileSync(stateToken, 'fixture-fallback-token');
  await resolveSession('session A', new AbortController().signal);
  assert.equal(observed.at(-1).options.headers['x-console-token'], 'fixture-fallback-token');
  fs.writeFileSync(config, '{"consoleToken":"secret-unclosed');
  await assert.rejects(resolveSession('session A', new AbortController().signal), (error) =>
    error.message === 'QQ 会话认证不可用');
  fs.rmSync(config);
  await assert.rejects(resolveSession('session A', new AbortController().signal), (error) =>
    error.message === 'QQ 会话认证不可用');
  fs.writeFileSync(config, JSON.stringify({ consolePort: 3131, consoleToken: 'fixture-console-token' }));
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'secret-from-server' }) });
  await assert.rejects(resolveSession('session A', new AbortController().signal), (error) =>
    error.message === 'QQ 会话认证不可用');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('session tool client config, cancellation boundary, and error redaction regression passed');
