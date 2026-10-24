import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const start = html.indexOf('const consoleAuth =');
const end = html.indexOf('function esc(', start);
assert.ok(start >= 0 && end > start, 'the production authentication flow must be available');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    hidden: true, open: false, value: '', disabled: false, textContent: '', handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
  });
  return elements.get(id);
}
const storage = new Map([['consoleToken', 'fixture-expired']]);
const requests = [];
let nativePrompts = 0;
let refreshes = 0;
let delayed;
let delayValidation = false;
let finishValidation;
const context = vm.createContext({
  document: { getElementById: element },
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  },
  prompt: () => { nativePrompts++; },
  refreshConsoleData: () => { refreshes++; },
  fetch: async (url, options) => {
    requests.push({ url, options });
    if (url === '/always-unauthorized') return { status: 401 };
    if (url === '/delayed') return new Promise(resolve => { delayed = resolve; });
    if (url === '/api/status' && delayValidation) return new Promise(resolve => { finishValidation = resolve; });
    const ok = options.headers['x-console-token'] === 'fixture-valid';
    return { status: ok ? 200 : 401, ok, json: async () => ({ ok }) };
  },
});
vm.runInContext(html.slice(start, end), context);
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const submit = async token => {
  element('consoleLoginToken').value = token;
  return element('consoleLoginForm').handlers.submit({ preventDefault() {} });
};

const batch = Promise.allSettled(Array.from({ length: 5 }, () => context.api('/fixture', 'POST', { fixture: true })));
await settle();
assert.equal(element('consoleLoginDialog').open, true);
assert.equal(requests.length, 5);
const waiting = context.api('/waiting');
await settle();
assert.equal(requests.length, 5, 'new calls wait while authentication is pending');
await submit('fixture-wrong');
assert.match(element('consoleLoginError').textContent, /令牌无效/);
assert.equal(element('consoleLoginDialog').open, true);
assert.equal(storage.has('consoleToken'), false, 'invalid credentials are not stored');
await submit('fixture-valid');
assert.deepEqual((await batch).map(result => result.status), Array(5).fill('fulfilled'));
assert.equal((await waiting).ok, true);
assert.equal(requests.filter(request => request.url === '/fixture').length, 10, 'each rejected write retries once');
assert.equal(nativePrompts, 0);
assert.equal(element('consoleLoginDialog').open, false);

storage.set('consoleToken', 'fixture-expired');
const late = context.api('/delayed').then(() => 'fulfilled', () => 'rejected');
const canceled = Promise.allSettled([context.api('/fixture'), context.api('/fixture')]);
await settle();
element('consoleLoginCancel').handlers.click();
assert.deepEqual((await canceled).map(result => result.status), ['rejected', 'rejected']);
delayed({ status: 401 });
assert.equal(await late, 'rejected');
assert.equal(element('consoleLoginDialog').open, false);
const count = requests.length;
await assert.rejects(context.api('/fixture'), /未授权/);
assert.equal(requests.length, count, 'canceled authentication sends no further requests');

const reopen = element('consoleLoginOpen').handlers.click();
delayValidation = true;
const validation = submit('fixture-valid');
await settle();
element('consoleLoginCancel').handlers.click();
finishValidation({ status: 200, ok: true });
await validation;
await reopen;
assert.equal(storage.has('consoleToken'), false, 'late validation cannot restore canceled credentials');
delayValidation = false;
const retry = element('consoleLoginOpen').handlers.click();
await submit('fixture-valid');
await retry;
assert.equal(refreshes, 1);
assert.equal((await context.api('/fixture')).ok, true);
storage.set('consoleToken', 'fixture-expired');
const refused = context.api('/always-unauthorized').then(() => 'fulfilled', () => 'rejected');
await settle();
await submit('fixture-valid');
assert.equal(await refused, 'rejected');
assert.equal(element('consoleLoginDialog').open, true);
assert.equal(storage.has('consoleToken'), false, 'retry 401 invalidates credentials and pauses polling');
assert.equal(vm.runInContext('consoleAuth.phase', context), 'required');
element('consoleLoginCancel').handlers.click();
console.log('PASS console authentication shares requests, retries once, cancels cleanly, and ignores stale validation.');
