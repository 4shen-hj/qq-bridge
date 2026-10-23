// Offline regressions for DSH rediscovery and persisted sticker-cache limits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const MEDIA_LIMIT = 256 * 1024;
const OLD_IMAGE = Buffer.concat([PNG, Buffer.alloc(MEDIA_LIMIT)]);
const LOCAL_DSH = 'http://127.0.0.1:43210';
let failures = 0;
let passed = 0;

async function test(name, run) {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error.message); }
}

async function discoveryFixture(baseUrl) {
  let discoveries = 0;
  let invalidations = 0;
  class FakeDshClient {
    constructor(base) {
      this.baseUrl = base;
      this.events = { follow() {} };
      this.settings = { describe: async () => {
        if (this.baseUrl !== LOCAL_DSH) throw new Error('fixture endpoint unavailable');
        return { result: { ok: true, value: { namespaces: [] } } };
      } };
    }
    invalidateAuth() { invalidations++; }
  }
  const h = await bridgeHarness({
    config: { dsh: { baseUrl, allowRemote: true, authToken: 'fixture-only' } },
    globals: {
      NodeApiClient: FakeDshClient,
      discoverDshBaseUrls: async () => { discoveries++; return [LOCAL_DSH]; },
    },
  });
  return { h, discoveries: () => discoveries, invalidations: () => invalidations };
}

await test('failed remote DSH keeps its configured endpoint and never discovers localhost', async () => {
  const { h, discoveries, invalidations } = await discoveryFixture('https://dsh.example.invalid');
  try {
    const configFile = path.join(h.temp, 'config.json');
    const before = fs.readFileSync(configFile, 'utf8');
    await h.checkDsh();
    assert.equal(discoveries(), 0, 'remote DSH failure invoked local endpoint discovery');
    assert.equal(h.cfg.dsh.baseUrl, 'https://dsh.example.invalid');
    assert.equal(h.api.baseUrl, 'https://dsh.example.invalid');
    assert.equal(invalidations(), 0);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'remote DSH configuration was rewritten');
  } finally { await h.close(); }
});

await test('failed loopback DSH rediscovers its port, invalidates auth, and persists the endpoint', async () => {
  const { h, discoveries, invalidations } = await discoveryFixture('http://localhost:43209');
  try {
    await h.checkDsh();
    assert.equal(discoveries(), 1);
    assert.equal(h.cfg.dsh.baseUrl, LOCAL_DSH);
    assert.equal(h.api.baseUrl, LOCAL_DSH);
    assert.equal(invalidations(), 1, 'changing authority must discard the previous authentication');
    const persisted = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.equal(persisted.dsh.baseUrl, LOCAL_DSH);
    assert.equal(persisted.dsh.authToken, 'fixture-only');
    assert.equal(persisted.consoleToken, 'fixture-console-token');
  } finally { await h.close(); }
});

async function stickerFixture(cachedImage, cache = true) {
  let downloads = 0;
  const h = await bridgeHarness({
    config: { socialV2: { media: { maxBytes: MEDIA_LIMIT, normalize: false }, sticker: { cache } } },
    globals: {
      safeFetchBuffer: async (_url, maxBytes) => {
        downloads++;
        assert.equal(maxBytes, MEDIA_LIMIT, 'downloads must retain the current media limit');
        return { buffer: PNG };
      },
    },
  });
  // A cache written under the old, larger limit survives a config change/restart.
  const cacheDir = path.join(h.temp, 'state', 'sticker-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'fixture-sticker.img'), cachedImage);
  return { h, downloads: () => downloads };
}

async function getStickerImage(h) {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/sticker-image?key=group%3A456&stickerId=fixture-sticker`, {
      headers: { 'x-console-token': 'fixture-console-token' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    assert.equal(body.ok, true, body.error);
    return Buffer.from(body.image.data, 'base64');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function sendSticker(h) {
  await h.sendStickerV2('group:456', 'fixture-sticker');
  const sent = h.calls.http.find((call) => call.url.endsWith('/send_group_msg'));
  assert.ok(sent, 'the fake OneBot gateway should receive one image');
  const file = sent.body.message.find((part) => part.type === 'image')?.data.file;
  assert.ok(file?.startsWith('base64://'), 'OneBot must receive bytes instead of a URL');
  return Buffer.from(file.slice('base64://'.length), 'base64');
}

for (const [label, consume] of [['sendStickerV2', sendSticker], ['GET sticker-image', getStickerImage]]) {
  await test(`${label} re-downloads an oversized cache entry after media.maxBytes is lowered`, async () => {
    const { h, downloads } = await stickerFixture(OLD_IMAGE);
    try {
      const image = await consume(h);
      assert.ok(image.length <= MEDIA_LIMIT, `oversized cached image escaped: ${image.length} bytes > ${MEDIA_LIMIT}`);
      assert.equal(downloads(), 1, 'the obsolete oversized cache entry must be downloaded again');
      assert.ok(image.equals(PNG), 'the consumer must receive the replacement image');
    } finally { await h.close(); }
  });
  await test(`${label} reuses a valid cache entry without downloading`, async () => {
    const { h, downloads } = await stickerFixture(PNG);
    try {
      assert.ok((await consume(h)).equals(PNG));
      assert.equal(downloads(), 0);
    } finally { await h.close(); }
  });
  await test(`${label} downloads when sticker.cache=false despite an existing cache file`, async () => {
    const { h, downloads } = await stickerFixture(PNG, false);
    try {
      assert.ok((await consume(h)).equals(PNG));
      assert.equal(downloads(), 1);
    } finally { await h.close(); }
  });
}

console.log(`Local optimization regressions: ${passed}/${passed + failures} passed.`);
process.exitCode = failures ? 1 : 0;
