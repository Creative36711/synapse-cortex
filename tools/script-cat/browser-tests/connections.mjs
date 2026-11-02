import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = process.env.RELAY_BROWSER_PREFIX;
if (!prefix) throw new Error('Set RELAY_BROWSER_PREFIX to a directory containing playwright-core and @sparticuz/chromium.');
const { chromium } = await import(pathToFileURL(join(prefix, 'node_modules/playwright-core/index.mjs')).href);
const { default: chromiumBin } = await import(pathToFileURL(join(prefix, 'node_modules/@sparticuz/chromium/build/index.js')).href);
const script = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const uuid = n => `${String(n).padStart(8,'0')}-1111-4111-8111-${String(n).padStart(12,'0')}`;
const profile = { id:uuid(1), name:'Test project', roles:uuid(11), missions:uuid(12), requests:uuid(13), questions:uuid(14),
  pageUrl:'https://www.notion.so/regulation', questionsUrl:'https://www.notion.so/feedback', repo:'example/relay-fixture', branch:'main', driveFolder:'test-project' };
const browser = await chromium.launch({ executablePath: await chromiumBin.executablePath(), args: chromiumBin.args, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let external = [];
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith('https://arena.ai/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Offline Arena mock</title><main style="padding:20px;color:#344">Arena mock — no external traffic</main>' });
  external.push(url); return route.abort();
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', err => errors.push(err.message));
await page.goto('https://arena.ai/agent/example');
await page.evaluate((profile) => {
  const key = name => `project:${profile.id}:${name}`;
  const store = new Map([
    ['cfn-project-profiles-v1', [profile]],
    [key('cfn-notion-token'), 'synthetic-notion-secret'], [key('cfn-gw-url'), 'https://script.google.com/macros/s/mock/exec'],
    [key('cfn-gw-key'), 'synthetic-drive-key'], [key('cfn-github-token'), 'synthetic-github-secret'],
  ]);
  sessionStorage.setItem('cfn-active-project-v1', profile.id);
  window.__testStore = store; window.__testCalls = [];
  window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  window.GM_setValue = (key, value) => { store.set(key, value); };
  window.GM_xmlhttpRequest = (opts) => {
    window.__testCalls.push({ method: opts.method, url: opts.url, headers: opts.headers, body: opts.data });
    let result;
    if (opts.url.includes('/users/me')) result = { object: 'user' };
    else if (opts.url.includes('/data_sources/') && opts.url.endsWith('/query')) result = { results: [], has_more: false };
    else if (opts.url.includes('/data_sources/')) result = { object: 'data_source' };
    else if (opts.url.includes('/contents/')) result = [];
    else if (opts.url.includes('api.github.com/repos/')) result = { full_name: 'example/relay-fixture' };
    else if (opts.url.includes('script.google.com')) result = { ok: true, version: '1.6', projectScoped:true, projectId:profile.id, project:{name:profile.driveFolder} };
    else result = {};
    setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify(result) }), 0);
  };
  window.setInterval = () => 0;
}, profile);
await page.evaluate(script);
await page.locator('#cfn-setup').click();
await page.locator('[role=dialog]').waitFor();
assert.equal(await page.locator('#cfn-gh').count(), 0);
assert.equal(await page.locator('#cfn-ntfy').count(), 0);
assert.equal(await page.locator('#cfn-connection-notion').inputValue(), '');
assert.ok(!(await page.locator('#cfn-connections').innerHTML()).includes('synthetic-notion-secret'));
await page.locator('#cfn-connections-close').focus();
await page.keyboard.press('Shift+Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'cfn-connections-save', 'keyboard focus wraps backwards');
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'cfn-connections-close', 'keyboard focus wraps forwards');
await page.screenshot({ path: '/tmp/relay-connections-desktop.png', fullPage: false });
await page.locator('#cfn-connection-notion').fill('new-notion');
await page.locator('#cfn-connection-key').fill('new-drive');
await page.locator('#cfn-connection-github').fill('new-github');
await page.locator('#cfn-connections-check').click();
await page.locator('#cfn-connections-note').getByText('Проверка завершена', { exact: false }).waitFor({timeout: 20000});
assert.match(await page.locator('#cfn-connection-notion-status').innerText(), /четыре источника читаются/);
assert.match(await page.locator('#cfn-connection-drive-status').innerText(), /Шлюз ответил/);
assert.match(await page.locator('#cfn-connection-github-status').innerText(), /репозиторий|Репозиторий/);
assert.equal(await page.evaluate(id => window.__testStore.get(`project:${id}:cfn-notion-token`), profile.id), 'synthetic-notion-secret');
await page.locator('#cfn-connections-save').click();
assert.equal(await page.evaluate(id => window.__testStore.get(`project:${id}:cfn-notion-token`), profile.id), 'new-notion');
assert.equal(await page.locator('#cfn-connection-notion').inputValue(), '');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: '/tmp/relay-connections-mobile.png', fullPage: false });
const sizes = await page.locator('[role=dialog]').evaluate(el => ({ width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth, height: el.getBoundingClientRect().height }));
assert.ok(sizes.width <= 390 && sizes.scrollWidth <= sizes.width + 1 && sizes.height <= 844, `responsive size ${JSON.stringify(sizes)}`);
await page.locator('summary').click();
assert.equal(await page.locator('#cfn-connection-recover').count(), 1);
await page.locator('#cfn-connection-ntfy').click();
assert.equal(await page.locator('#cfn-connections').count(), 0);
assert.equal(await page.locator('#cfn-ntfy-dialog').count(), 1);
// Новый параметр setup при включённом автоцикле: никакого нового шага до закрытия окна.
const autoPage = await context.newPage();
autoPage.on('pageerror', err => errors.push(err.message));
await autoPage.goto('https://arena.ai/agent/example?cf-auth-setup=1');
await autoPage.evaluate((profile) => {
  const key = name => `project:${profile.id}:${name}`;
  const store = new Map([
    ['cfn-project-profiles-v1', [profile]], [key('cfn-project-approved'), true],
    [key('cfn-notion-token'), 'auto-notion'], [key('cfn-gw-url'), 'https://script.google.com/macros/s/mock/exec'],
    [key('cfn-gw-key'), 'auto-drive'], [key('cfn-github-token'), 'auto-github'], [key('cfn-debug'), true],
  ]);
  window.__autoStore = store; window.__autoCalls = [];
  sessionStorage.setItem('cfn-active-project-v1', profile.id);
  sessionStorage.setItem(key('cfn-auto-enabled'), '1');
  window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  window.GM_setValue = (key, value) => { store.set(key, value); };
  window.GM_xmlhttpRequest = (opts) => {
    window.__autoCalls.push(opts.url);
    let result = opts.url.includes('/query') ? { results: [], has_more: false }
      : opts.url.includes('/contents/') ? [] : {};
    setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify(result) }), 0);
  };
  window.setInterval = () => 0;
}, profile);
await autoPage.evaluate(script);
await autoPage.locator('#cfn-connections').waitFor();
assert.ok(!autoPage.url().includes('cf-auth-setup='));
await autoPage.waitForTimeout(50); // ждём завершения мокированных фоновых сторожей
const before = await autoPage.evaluate(() => window.__autoCalls.length);
await autoPage.evaluate(() => window.__relay.step());
assert.equal(await autoPage.evaluate(() => window.__autoCalls.length), before, 'шаг не начинает сетевые запросы, пока окно открыто');
await autoPage.locator('#cfn-connection-notion').fill('auto-new-notion');
await autoPage.locator('#cfn-connections-save').click();
assert.equal(await autoPage.evaluate(id => window.__autoStore.get(`project:${id}:cfn-notion-token`), profile.id), 'auto-notion');
assert.match(await autoPage.locator('#cfn-connections-note').innerText(), /Остановите цикл/);
await autoPage.locator('#cfn-connection-stop-auto').click();
assert.equal(await autoPage.evaluate(id => sessionStorage.getItem(`project:${id}:cfn-auto-enabled`), profile.id), null);
await autoPage.locator('#cfn-connections-save').click();
assert.equal(await autoPage.evaluate(id => window.__autoStore.get(`project:${id}:cfn-notion-token`), profile.id), 'auto-new-notion');
assert.equal(errors.length, 0, `page errors: ${errors}`);
assert.equal(external.length, 0, `network blocked: ${external}`);
console.log('OK: Chromium desktop/mobile; hub, masking, checks/save, ntfy; setup defers tick, stop-auto; no external traffic');
await browser.close();
