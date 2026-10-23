import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import * as roleCard from '../src/role-card.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'fixture-console-token';

export async function requestConsole(base, token, route, method = 'GET', body) {
  const response = await fetch(new URL(route, base), {
    method,
    headers: { 'x-console-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: route === '/' ? await response.text() : await response.json() };
}

export async function runIsolatedConsoleTest({ config = {}, request = requestConsole, observeCleanup } = {}) {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({
    globals: roleCard,
    config: { deny: { private: ['789'], groups: ['900'] }, ...config },
    files: {
      'public/console.html': fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8'),
      'roles/fixture-original.md': '- 性格：测试\n- 说话风格：简短',
    },
  });
  const touched = ['config.json', 'state/current-role.json', 'roles/fixture-test.md'];
  const snapshot = new Map(touched.map(name => {
    const file = path.join(h.temp, name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file) : null];
  }));
  let server;
  try {
    server = h.startConsoleServer();
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (route, method, body) => request(base, TOKEN, route, method, body);
    let r = await api('/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('人格与角色'));
    r = await api('/api/roles');
    assert.ok(r.body.roles.includes('fixture-original'));
    r = await api('/api/roles/create', 'POST', { name: 'fixture-test', content: '- 性格：测试\n- 说话风格：简短' });
    assert.equal(r.body.ok, true);
    r = await api('/api/role', 'POST', { role: 'fixture-test' });
    assert.equal(r.body.role, 'fixture-test');
    r = await api('/api/role', 'POST', { role: null });
    assert.equal(r.body.role, null);
    assert.ok(Array.isArray((await api('/api/sessions')).body.sessions));
    assert.ok(Array.isArray((await api('/api/pending')).body.pending));
    const original = (await api('/api/whitelist')).body;
    const testGroup = '123456789';
    r = await api('/api/whitelist', 'POST', {
      allow: { ...original.allow, groups: [...new Set([...(original.allow?.groups ?? []).map(String), testGroup])] },
      deny: original.deny,
    });
    assert.equal(r.body.ok, true);
    assert.ok(r.body.allow.groups.map(String).includes(testGroup));
    for (const kind of ['private', 'groups']) {
      assert.deepEqual(r.body.deny[kind].map(String), original.deny[kind].map(String));
    }
    r = await api('/api/test-send', 'POST', { kind: 'group', id: testGroup, message: 'isolated console test' });
    assert.equal(r.body.ok, true);
    assert.equal(h.calls.sent.length, 1, 'the real console route reaches only the fake gateway');
    r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'isolated denied test' });
    assert.equal(r.status, 403);
    assert.equal(h.calls.sent.length, 1);
    return { sent: h.calls.sent.length };
  } finally {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      for (const [name, bytes] of snapshot) {
        const file = path.join(h.temp, name);
        if (bytes === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, bytes);
      }
      if (observeCleanup) await observeCleanup({ root: h.temp, snapshot, calls: h.calls });
    } finally { await h.close(); }
  }
}

export async function runLiveConsoleTest({ base, token, send = false, kind, target, request = requestConsole }) {
  if (!base || !token) throw new Error('--live requires --base and QQ_CONSOLE_TEST_TOKEN');
  const url = new URL(base);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid console URL');
  if (send && (!['group', 'private'].includes(kind) || !/^\d+$/.test(target ?? ''))) {
    throw new Error('--live-send requires --kind group|private and --target with an explicit QQ ID');
  }
  for (const route of ['/api/roles', '/api/sessions', '/api/pending', '/api/whitelist']) {
    const r = await request(base, token, route);
    assert.equal(r.status, 200, route);
  }
  if (send) {
    const r = await request(base, token, '/api/test-send', 'POST', { kind, id: target, message: '控制台显式发送测试' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, r.body.error);
  }
  return { sent: send ? 1 : 0 };
}

export function parseConsoleTestArgs(args) {
  const allowed = new Set(['--live', '--live-send', '--base', '--kind', '--target']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.has(arg) || Object.hasOwn(values, arg)) throw new Error(`Unknown or duplicate argument ${arg}`);
    if (arg === '--live' || arg === '--live-send') values[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      values[arg] = value;
    }
  }
  if (!values['--live'] && args.length) throw new Error('Live options require --live');
  if ((values['--kind'] || values['--target']) && !values['--live-send']) throw new Error('Send targets require --live-send');
  return { live: Boolean(values['--live']), send: Boolean(values['--live-send']), base: values['--base'], kind: values['--kind'], target: values['--target'] };
}

async function main() {
  const args = parseConsoleTestArgs(process.argv.slice(2));
  const result = args.live
    ? await runLiveConsoleTest({ ...args, token: process.env.QQ_CONSOLE_TEST_TOKEN })
    : await runIsolatedConsoleTest();
  console.log(`PASS console regression (${args.live ? 'live' : 'isolated fake gateway'}, ${result.sent} sends)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
