import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(candidate => existsSync(candidate));
const fixture = await startConsoleFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let protectedMode = false;
  let apiRequests = 0;
  let nativeDialogs = 0;
  const blocked = [];
  let delayed401;
  let releaseValidation;
  let holdValidation = false;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== fixture.url) {
      blocked.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    apiRequests++;
    if (url.pathname === '/api/auth-always-unauthorized') return route.fulfill({ status: 401, json: { error: 'fixture unauthorized' } });
    if (url.pathname === '/api/auth-delayed') {
      delayed401 = () => route.fulfill({ status: 401, json: { error: 'fixture unauthorized' } });
      return;
    }
    if (holdValidation && url.pathname === '/api/status' && request.headers()['x-console-token'] === 'fixture-valid') {
      releaseValidation = () => route.continue();
      return;
    }
    if (protectedMode && request.headers()['x-console-token'] !== 'fixture-valid') {
      return route.fulfill({ status: 401, json: { error: 'fixture unauthorized' } });
    }
    if (url.pathname === '/api/auth-retry') return route.fulfill({ json: { ok: true } });
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });
  await page.clock.install();
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'qq-chat-v2');
  protectedMode = true;
  await page.evaluate(() => {
    localStorage.setItem('consoleToken', 'fixture-expired');
    window.authResults = null;
    window.authBatch = Promise.allSettled(Array.from({ length: 5 }, () => api('/api/auth-retry')))
      .then(results => { window.authResults = results.map(result => result.status); });
  });
  if (process.argv.includes('--expect-old')) {
    await page.waitForFunction(() => window.authResults !== null);
    assert.equal(nativeDialogs, 5);
    console.log('REPRODUCED: five concurrent 401 responses opened five native dialogs.');
  } else {
    await page.locator('#consoleLoginDialog[open]').waitFor();
    assert.equal(await page.locator('#consoleLoginDialog[open]').count(), 1);
    await page.waitForTimeout(100);
    const pausedCount = apiRequests;
    await page.clock.fastForward(9000);
    await page.waitForTimeout(100);
    assert.equal(apiRequests, pausedCount, 'polling must stop while login is pending');
    await page.locator('#consoleLoginToken').fill('fixture-wrong');
    await page.locator('#consoleLoginSubmit').click();
    await page.waitForFunction(() => document.getElementById('consoleLoginError').textContent.includes('令牌无效'));
    assert.equal(await page.evaluate(() => window.authResults), null, 'wrong token keeps shared login pending');
    await page.locator('#consoleLoginToken').fill('fixture-valid');
    await page.locator('#consoleLoginSubmit').click();
    await page.waitForFunction(() => window.authResults !== null);
    assert.deepEqual(await page.evaluate(() => window.authResults), Array(5).fill('fulfilled'));
    assert.equal(nativeDialogs, 0);
    const resumedCount = apiRequests;
    await page.clock.fastForward(3000);
    await page.waitForTimeout(100);
    assert.ok(apiRequests > resumedCount, 'polling resumes after authentication');
    console.log('PASS concurrent 401 shares one form, wrong token stays pending, success retries and resumes polling');

    await page.evaluate(() => {
      localStorage.setItem('consoleToken', 'fixture-expired');
      window.delayedResult = api('/api/auth-delayed').then(() => 'fulfilled', () => 'rejected');
      window.cancelResults = null;
      window.cancelBatch = Promise.allSettled(Array.from({ length: 3 }, () => api('/api/auth-retry')))
        .then(results => { window.cancelResults = results.map(result => result.status); });
    });
    await page.locator('#consoleLoginDialog[open]').waitFor();
    await page.locator('#consoleLoginCancel').click();
    await page.waitForFunction(() => window.cancelResults !== null);
    assert.deepEqual(await page.evaluate(() => window.cancelResults), Array(3).fill('rejected'));
    assert.equal(await page.locator('#consoleLoginDialog[open]').count(), 0);
    assert.equal(await page.locator('#consoleAuthNotice').isVisible(), true);
    await delayed401();
    assert.equal(await page.evaluate(() => window.delayedResult), 'rejected');
    assert.equal(await page.locator('#consoleLoginDialog[open]').count(), 0, 'late 401 cannot reopen canceled login');
    const canceledCount = apiRequests;
    await page.clock.fastForward(6000);
    await page.waitForTimeout(100);
    assert.equal(apiRequests, canceledCount, 'polling remains paused after cancel');
    console.log('PASS cancel settles callers, ignores late 401, and leaves polling paused');

    await page.locator('#consoleLoginOpen').click();
    holdValidation = true;
    await page.locator('#consoleLoginToken').fill('fixture-valid');
    await page.locator('#consoleLoginSubmit').click();
    await page.waitForFunction(() => document.getElementById('consoleLoginSubmit').disabled);
    await page.locator('#consoleLoginCancel').click();
    holdValidation = false;
    await releaseValidation();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#consoleAuthNotice').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('consoleToken')), null);
    await page.locator('#consoleLoginOpen').click();
    await page.locator('#consoleLoginToken').fill('fixture-valid');
    await page.locator('#consoleLoginSubmit').click();
    await page.waitForFunction(() => document.getElementById('consoleAuthNotice').hidden);
    assert.equal(await page.evaluate(() => api('/api/auth-retry').then(result => result.ok)), true);
    console.log('PASS cancel during validation ignores late success and allows a fresh login');

    await page.evaluate(() => {
      localStorage.setItem('consoleToken', 'fixture-expired');
      window.delayedResult = api('/api/auth-delayed').then(() => 'fulfilled', () => 'rejected');
      window.loginResult = api('/api/auth-retry').then(() => 'fulfilled', () => 'rejected');
    });
    await page.locator('#consoleLoginDialog[open]').waitFor();
    await page.locator('#consoleLoginToken').fill('fixture-valid');
    await page.locator('#consoleLoginSubmit').click();
    assert.equal(await page.evaluate(() => window.loginResult), 'fulfilled');
    await context.route('**/api/auth-delayed', route => route.fulfill({ json: { ok: true } }));
    await delayed401();
    assert.equal(await page.evaluate(() => window.delayedResult), 'fulfilled');
    assert.equal(await page.locator('#consoleLoginDialog[open]').count(), 0);
    assert.equal(nativeDialogs, 0);
    console.log('PASS delayed old 401 retries current credentials without another login');
    await page.evaluate(() => {
      localStorage.setItem('consoleToken', 'fixture-expired');
      window.refused = api('/api/auth-always-unauthorized').then(() => 'fulfilled', () => 'rejected');
    });
    await page.locator('#consoleLoginDialog[open]').waitFor();
    await page.locator('#consoleLoginToken').fill('fixture-valid');
    await page.locator('#consoleLoginSubmit').click();
    assert.equal(await page.evaluate(() => window.refused), 'rejected');
    await page.locator('#consoleLoginDialog[open]').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('consoleToken')), null);
    await page.waitForTimeout(100);
    const retryPausedCount = apiRequests;
    await page.clock.fastForward(6000);
    await page.waitForTimeout(100);
    assert.equal(apiRequests, retryPausedCount, 'retry 401 pauses polling again');
    await page.locator('#consoleLoginCancel').click();
    console.log('PASS retry 401 returns to shared login and pauses polling');
  }
  assert.deepEqual(blocked, []);
} finally {
  await browser?.close();
  await fixture.close();
}
