import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import yaml from 'js-yaml';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { PRESETS, renderPatch, patchFileFor } from '../src/agent-preset-patches.js';
import { inspectPresetPublication, publishAgentPresets } from '../src/preset-publication.js';
import { extractPresetPrefix, renderPresetPromptYaml } from '../src/preset-prompt.js';

const root = path.resolve(import.meta.dirname, '..');
const preset = 'qq-chat-v2';
const sourceRel = `dsh/agent-presets/${preset}/agent.cordis.yml`;
const patchRel = `plugins/qq-agent-presets/presets/${preset}.patch.yml`;
const source = fs.readFileSync(path.join(root, sourceRel), 'utf8');
const prefix = extractPresetPrefix(source);
let failures = 0;

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(run, { installed = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-preset-publication-home-'));
  const files = {};
  for (const name of PRESETS) {
    for (const filename of ['preset.yml', 'agent.cordis.yml']) {
      const rel = `dsh/agent-presets/${name}/${filename}`;
      files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    }
    const rel = `plugins/qq-agent-presets/presets/${name}.patch.yml`;
    files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  }
  for (const filename of ['package.json', 'qq-tool-restrict.mjs']) {
    const rel = `plugins/qq-agent-presets/${filename}`;
    files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  }
  const h = await bridgeHarness({ files, globals: { os: { ...os, homedir: () => home } } });
  const dshHome = path.join(home, '.dsh');
  const options = { repoRoot: h.temp, dshHome };
  let server;
  try {
    if (installed) publishAgentPresets({ ...options, profile: 'web', install: true });
    server = h.startConsoleServer();
    if (!server.listening) await once(server, 'listening');
    const call = (url, body) => request(server.address().port, url, body);
    const activeFile = path.join(dshHome, 'profiles/web/node_modules/qq-agent-presets/presets', `${preset}.patch.yml`);
    const activePrefix = () => yaml.load(fs.readFileSync(activeFile, 'utf8'))[0].insert[0].config.plugins.find((row) => row.id === 'persona').config.prefix;
    await run({ h, call, options, activeFile, activePrefix });
    assert.equal(h.calls.http.length, 0, 'preset publication must not send to the gateway');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function test(name, run, options) {
  try { await fixture(run, options); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
}

await test('HTTP save and restore update the patch read through the registered DSH profile', async ({ h, call, activePrefix, options }) => {
  const changed = `${prefix}\nPUBLICATION_SENTINEL`;
  const legacy = path.join(options.dshHome, '.agent-presets', preset, 'agent.cordis.yml');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, 'legacy user content');
  const saved = await call('/api/preset/sim-prompt', { preset, content: changed });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.synced, true);
  assert.equal(saved.body.status.installed, true);
  assert.equal(saved.body.requiresRestart, true);
  assert.equal(activePrefix(), changed);
  assert.equal(extractPresetPrefix(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8')), changed);
  const backups = await call(`/api/preset/sim-prompt/backups?preset=${preset}`);
  const restored = await call('/api/preset/sim-prompt/restore', { preset, file: backups.body.backups[0].file });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.synced, true);
  assert.equal(activePrefix(), prefix);
  assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy user content');
});

await test('same-source save repairs a stale installed patch and reports restart', async ({ h, call, activePrefix }) => {
  const stale = renderPresetPromptYaml(source, `${prefix}\nSTALE`, 'v2');
  fs.writeFileSync(path.join(h.temp, patchRel), renderPatch(preset, { repoRoot: h.temp, sourceText: stale }));
  const before = await call(`/api/preset/sim-prompt?preset=${preset}`);
  assert.equal(before.body.status.installed, false);
  const repaired = await call('/api/preset/sim-prompt', { preset, content: prefix });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.equal(repaired.body.unchanged, false);
  assert.equal(repaired.body.requiresRestart, true);
  assert.equal(activePrefix(), prefix);
  assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source, 'same-source save preserves source formatting');
  const unchanged = await call('/api/preset/sim-prompt', { preset, content: prefix });
  assert.equal(unchanged.body.unchanged, true);
  assert.equal(unchanged.body.synced, true);
  assert.equal(unchanged.body.requiresRestart, false);
});

await test('uninstalled save refuses without changing source or generated patch', async ({ h, call }) => {
  const before = fs.readFileSync(path.join(h.temp, patchRel), 'utf8');
  for (const content of [prefix, `${prefix}\nNOT_INSTALLED`]) {
    const result = await call('/api/preset/sim-prompt', { preset, content });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /setup-dsh/);
    assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(h.temp, patchRel), 'utf8'), before);
  }
}, { installed: false });

await test('generation failure changes neither source nor an earlier stale patch', async ({ h, call, activeFile }) => {
  const earlier = patchFileFor('qq-chat', h.temp);
  fs.writeFileSync(earlier, 'old generated artifact');
  fs.writeFileSync(path.join(h.temp, `dsh/agent-presets/${preset}/preset.yml`), 'description: invalid metadata\n');
  const before = fs.readFileSync(activeFile, 'utf8');
  const result = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nGENERATION_FAILURE` });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /preset.yml/);
  assert.equal(fs.readFileSync(earlier, 'utf8'), 'old generated artifact');
  assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
  assert.equal(fs.readFileSync(activeFile, 'utf8'), before);
});

for (const operation of ['save', 'restore']) await test(`HTTP ${operation} rolls back source and effective patch after a patch write fails`, async ({ h, call, activeFile }) => {
  let backup;
  if (operation === 'restore') {
    const saved = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nBEFORE_RESTORE` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    backup = (await call(`/api/preset/sim-prompt/backups?preset=${preset}`)).body.backups[0].file;
  }
  const originalSource = fs.readFileSync(path.join(h.temp, sourceRel), 'utf8');
  const originalPatch = fs.readFileSync(activeFile, 'utf8');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (to === path.join(h.temp, patchRel) && !injected) {
      injected = true;
      throw new Error('injected patch write failure');
    }
  };
  try {
    const result = operation === 'save'
      ? await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nWRITE_FAILURE` })
      : await call('/api/preset/sim-prompt/restore', { preset, file: backup });
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.match(result.body.error, /injected patch write failure/);
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), originalSource);
    assert.equal(fs.readFileSync(activeFile, 'utf8'), originalPatch);
  } finally { fs.renameSync = rename; }
});

await test('readback verification failure rolls back the published source and patch', async ({ h, call, activeFile }) => {
  const before = fs.readFileSync(activeFile, 'utf8');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (to === path.join(h.temp, patchRel) && !injected) {
      injected = true;
      fs.writeFileSync(to, 'corrupted after write');
    }
  };
  try {
    const result = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nCORRUPT_WRITE` });
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.match(result.body.error, /patch 未同步/);
    assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
    assert.equal(fs.readFileSync(activeFile, 'utf8'), before);
  } finally { fs.renameSync = rename; }
});

await test('foreign installation is refused by HTTP without altering either repository', async ({ h, call, options }) => {
  const foreign = path.join(options.dshHome, 'foreign-bundle');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'keep.txt'), 'untouched');
  const plugin = path.join(options.dshHome, 'plugins/qq-agent-presets');
  fs.unlinkSync(plugin);
  fs.symlinkSync(foreign, plugin, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nFOREIGN` });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /其他仓库/);
  assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'untouched');
});

await test('setup publication rolls back generation and both links when installation fails', async ({ h, options }) => {
  const packageFile = path.join(options.dshHome, 'profiles/web/package.json');
  fs.mkdirSync(path.dirname(packageFile), { recursive: true });
  fs.writeFileSync(packageFile, '{"dependencies":{"custom":"1"}}\n');
  const originalPackage = fs.readFileSync(packageFile, 'utf8');
  const patch = path.join(h.temp, patchRel);
  fs.writeFileSync(patch, 'original stale patch');
  const link = fs.symlinkSync;
  let injected = false;
  fs.symlinkSync = (target, file, type) => {
    if (file === path.join(options.dshHome, 'profiles/web/node_modules/qq-agent-presets') && !injected) {
      injected = true;
      throw new Error('injected link failure');
    }
    return link(target, file, type);
  };
  try {
    assert.throws(() => publishAgentPresets({ ...options, profile: 'web', install: true, sourceChanges: {
      [preset]: renderPresetPromptYaml(source, `${prefix}\nINSTALL_FAILURE`, 'v2'),
    } }), /injected link failure/);
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
    assert.equal(fs.readFileSync(patch, 'utf8'), 'original stale patch');
    assert.equal(fs.readFileSync(packageFile, 'utf8'), originalPackage);
    assert.equal(fs.existsSync(path.join(options.dshHome, 'plugins/qq-agent-presets')), false);
    assert.equal(inspectPresetPublication({ ...options, preset }).installed, false);
  } finally { fs.symlinkSync = link; }
}, { installed: false });

await test('all registered profiles must resolve the verified bundle', async ({ h, call, options }) => {
  publishAgentPresets({ ...options, profile: 'desktop', install: true });
  const file = path.join(options.dshHome, 'profiles/desktop/package.json');
  const pkg = JSON.parse(fs.readFileSync(file));
  delete pkg.dependencies['qq-agent-presets'];
  fs.writeFileSync(file, JSON.stringify(pkg));
  const result = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nBAD_PROFILE` });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /desktop/);
  assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
});

for (const persistent of [false, true]) await test(`lock-release failure rolls back publication and preserves the failure (${persistent ? 'persistent' : 'one-shot'})`, async ({ h, call, activeFile }) => {
  const before = fs.readFileSync(activeFile, 'utf8');
  const lock = path.join(h.temp, 'plugins/qq-agent-presets/.publish-lock');
  const rmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = (file, ...args) => {
    if (file === lock && (persistent || !injected)) {
      injected = true;
      throw new Error('injected lock release failure');
    }
    return rmdir(file, ...args);
  };
  try {
    const result = await call('/api/preset/sim-prompt', { preset, content: `${prefix}\nLOCK_FAILURE` });
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.match(result.body.error, /injected lock release failure/);
    assert.equal(fs.readFileSync(path.join(h.temp, sourceRel), 'utf8'), source);
    assert.equal(fs.readFileSync(activeFile, 'utf8'), before);
    if (persistent) assert.match(result.body.error, /发布锁未清理/);
    else assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmdirSync = rmdir; }
});

console.log(`preset publication: ${12 - failures}/12 checks passed`);
process.exitCode = failures ? 1 : 0;
