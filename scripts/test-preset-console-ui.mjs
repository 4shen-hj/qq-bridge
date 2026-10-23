import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file => existsSync(file));
const fixture = await startConsoleFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  let saveResponse = null;
  let restoreResponse = null;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url) {
      blocked.push(url.href);
      return route.abort();
    }
    const response = route.request().method() === 'POST'
      ? (url.pathname === '/api/preset/sim-prompt' ? saveResponse
        : url.pathname === '/api/preset/sim-prompt/restore' ? restoreResponse : null)
      : null;
    if (response) return route.fulfill({ status: response.ok ? 200 : 500, contentType: 'application/json', body: JSON.stringify(response) });
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url);
  await page.locator('[data-view="persona"]').first().click();
  await page.waitForFunction(() => document.getElementById('simPromptText').value.length > 0);
  await page.locator('#simPromptEdit').click();
  const original = await page.locator('#simPromptText').inputValue();
  const draft = original + '\n发布失败后保留的草稿。';
  await page.locator('#simPromptText').fill(draft);
  saveResponse = { ok: false, error: '发布失败：测试 bundle 不可写，原文件已回滚' };
  await page.locator('#simPromptSave').click();
  await page.waitForFunction(() => document.getElementById('simPromptMsg').textContent.includes('原文件已回滚'));
  assert.equal(await page.locator('#simPromptText').inputValue(), draft);
  assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), null);
  assert.equal(await page.locator('#simPromptSave').isEnabled(), true);
  console.log('PASS preset publication failure preserves editable draft');

  await page.locator('#simPromptText').fill(original);
  saveResponse = { ok: true, unchanged: false, synced: true, requiresRestart: true, warnings: [], status: { label: '二代仿真' } };
  await page.locator('#simPromptSave').click();
  await page.waitForFunction(() => document.getElementById('simPromptMsg').textContent.includes('重启 DSH'));
  assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), '');
  assert.doesNotMatch(await page.locator('#simPromptMsg').textContent(), /未写入文件/);
  console.log('PASS repairing a stale bundle with unchanged source shows restart guidance');

  restoreResponse = { ok: false, error: '还原发布失败：原文件已回滚' };
  await page.locator('#simPromptRestore').click();
  await page.waitForFunction(() => document.getElementById('simPromptMsg').textContent.includes('还原发布失败'));
  assert.equal(await page.locator('#simPromptText').inputValue(), original);
  console.log('PASS restore publication failure displays failure without claiming success');

  restoreResponse = { ok: true, restoredFrom: 'fixture-backup', synced: true, requiresRestart: true };
  await page.locator('#simPromptRestore').click();
  await page.waitForFunction(() => document.getElementById('simPromptMsg').textContent.includes('fixture-backup'));
  assert.match(await page.locator('#simPromptMsg').textContent(), /重启 DSH/);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log('PASS successful restore shows restart guidance and no external requests');
  console.log('4/4 preset browser checks passed; all writes intercepted by the fixture.');
} finally {
  await browser?.close();
  await fixture.close();
}
