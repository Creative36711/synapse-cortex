// Current Relay userscript ↔ Drive Gateway 1.5 contract.
// This is a local boundary probe with fake network responses; the Apps Script
// implementation itself is exercised by drive-gateway-arena-smoke.mjs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const userScriptUrl = new URL('../relay.user.js', import.meta.url);
const legacyDispatchUrl = new URL('../dispatch.user.js', import.meta.url);
assert.equal(await existsSync(legacyDispatchUrl), false, 'legacy dispatch.user.js is not restored');
const source = await readFile(userScriptUrl, 'utf8');
const version = source.match(/^\/\/ @version\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version, 'active userscript has a semantic version');

const gatewaySource = await readFile(new URL('../drive-gateway.gs', import.meta.url), 'utf8');
assert.match(gatewaySource, /Relay ScriptCat Drive gateway 1\.7\.1/);
assert.match(gatewaySource, /version: "1\.7\.1"/);
assert.match(gatewaySource, /CF_ARTIFACTS_FOLDER_NAME = "artifacts"/);
assert.match(gatewaySource, /saveArtifact/);
assert.match(gatewaySource, /verifyArtifactPlacement_/);
assert.match(gatewaySource, /Utilities\.newBlob\(content\)\.getBytes\(\)\.length/, 'размер артефакта считается в UTF-8 байтах');
assert.match(gatewaySource, /содержимое другое: конфликт/, 'duplicate с другим содержимым — конфликт');
assert.match(gatewaySource, /Same Dispatch\/Run pair|dispatchId.*runId/s, 'Gateway uses the dispatch/run identity');
assert.match(gatewaySource, /CF_ARENA_FOLDER_NAME = "Arena"/);
assert.match(gatewaySource, /CF_LOGS_FOLDER_NAME = "logs"/);
assert.match(gatewaySource, /Запись разрешена только в текстовые файлы Arena\/logs/);
assert.match(gatewaySource, /old\.includes\(marker\).*duplicate/s, 'duplicate markers are idempotent');

const objectSource = (name) => {
  const start = source.indexOf(`  const ${name} = {`);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `${name} configuration exists`);
  return source.slice(start, end + '\n  };'.length);
};
const config = new Function(`${objectSource('C')}\nreturn C;`)();
const keys = new Function(`${objectSource('K')}\nreturn K;`)();
const networkStart = source.indexOf('  const networkish = (text) =>');
const networkEnd = source.indexOf('\n\n  /**', networkStart);
assert.ok(networkStart > 0 && networkEnd > networkStart, 'network error classifier exists');
const networkish = new Function(`${source.slice(networkStart, networkEnd)}\nreturn networkish;`)();
const gatewayStart = source.indexOf('  async function gateway(action, fileId, extra = {}) {');
const gatewayEnd = source.indexOf('\n  // ───────────────────────────── Notion', gatewayStart);
assert.ok(gatewayStart > 0 && gatewayEnd > gatewayStart, 'active gateway transport exists');
const makeGateway = ({ store, request, fetchImpl }) => {
  const waits = [];
  const gateway = new Function(
    'GM_getValue', 'K', 'request', 'networkish', 'sleep', 'fetch',
    `${source.slice(gatewayStart, gatewayEnd)}\nreturn gateway;`,
  )(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    keys,
    request,
    networkish,
    async (ms) => { waits.push(ms); },
    fetchImpl,
  );
  return { gateway, waits };
};
const baseStore = () => new Map([
  [keys.gwUrl, 'https://script.google.com/macros/s/test/exec'],
  [keys.gwKey, 'test-gateway-key'],
]);

// 1. A successful createLog response is passed through, including the current
//    Apps Script top-level and nested result envelope.
{
  const store = baseStore();
  const calls = [];
  const response = { ok: true, fileId: 'drive-file-123456', name: 'dispatch_run.md', result: { fileId: 'drive-file-123456', name: 'dispatch_run.md' } };
  const { gateway } = makeGateway({
    store,
    request: async (method, url, headers, payload) => {
      calls.push({ method, url, headers, payload: JSON.parse(payload) });
      return response;
    },
    fetchImpl: async () => { throw new Error('fetch fallback must not run'); },
  });
  assert.deepEqual(await gateway('createLog', '', { dispatchId: 'dispatch-1', runId: 'run-1' }), response);
  assert.equal(calls.length, 1, 'successful GM request is not duplicated');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, store.get(keys.gwUrl));
  assert.equal(calls[0].headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(calls[0].payload, {
    action: 'createLog', fileId: '', key: 'test-gateway-key', dispatchId: 'dispatch-1', runId: 'run-1',
  });
}

// 2. Only a network failure is retried (twice via GM), then fetch is the
//    bounded fallback. The same request identity and payload are retained.
{
  const store = baseStore();
  const gmPayloads = [];
  const fetchCalls = [];
  let attempts = 0;
  const { gateway, waits } = makeGateway({
    store,
    request: async (_method, _url, _headers, payload) => {
      gmPayloads.push(payload);
      attempts += 1;
      throw new Error('Failed to fetch');
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { status: 200, json: async () => ({ ok: true, fileId: 'drive-file-123456', name: 'dispatch_run.md' }) };
    },
  });
  const result = await gateway('createLog', '', { dispatchId: 'dispatch-2', runId: 'run-2' });
  assert.equal(result.fileId, 'drive-file-123456');
  assert.equal(attempts, 2, 'GM retry is bounded at two attempts');
  assert.equal(waits.length, 2, 'only the two bounded network retries wait');
  assert.deepEqual(new Set(gmPayloads), new Set([gmPayloads[0]]), 'same identity is reused on retry');
  assert.equal(fetchCalls.length, 1, 'one fetch fallback follows exhausted GM attempts');
  assert.equal(fetchCalls[0].url, store.get(keys.gwUrl));
  assert.equal(JSON.parse(fetchCalls[0].options.body).dispatchId, 'dispatch-2');
  assert.equal(JSON.parse(fetchCalls[0].options.body).runId, 'run-2');
}

// 3. A clear server refusal is not retried and does not fall through to fetch.
{
  const store = baseStore();
  let calls = 0;
  let fetchCalls = 0;
  const { gateway } = makeGateway({
    store,
    request: async () => { calls += 1; return { ok: false, error: 'Неверный ключ шлюза.' }; },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not retry a refusal'); },
  });
  await assert.rejects(
    () => gateway('createLog', '', { dispatchId: 'dispatch-3', runId: 'run-3' }),
    (error) => {
      assert.match(error.message, /шлюз Drive отказал/);
      assert.equal(error.refused, true);
      assert.equal(error.reason, 'Неверный ключ шлюза.');
      assert.equal(error.relay, 'gateway');
      return true;
    },
  );
  assert.equal(calls, 1, 'a refusal has no repeated side effect');
  assert.equal(fetchCalls, 0, 'refusal is not disguised as a transport failure');
}

// 4. Duplicate append response means the same CF_DISPATCH marker was already
//    committed; it is success, not a second write or a false failure.
{
  const { gateway } = makeGateway({
    store: baseStore(),
    request: async () => ({ ok: false, error: 'duplicate marker already present' }),
    fetchImpl: async () => { throw new Error('duplicate must not fall through'); },
  });
  assert.deepEqual(await gateway('append', 'drive-file-123456', { marker: '<!-- CF_DISPATCH d:r -->', entry: '<!-- CF_DISPATCH d:r -->' }), {
    ok: true, duplicate: true,
  });
}

// 5. Missing setup and exhausted transports stay explicit errors, not success.
{
  const store = baseStore();
  store.set(keys.gwUrl, '');
  let called = false;
  const { gateway } = makeGateway({
    store,
    request: async () => { called = true; return { ok: true }; },
    fetchImpl: async () => { called = true; return { status: 200, json: async () => ({ ok: true }) }; },
  });
  await assert.rejects(() => gateway('ping', '', {}), /Не задан URL шлюза Drive/);
  assert.equal(called, false, 'missing endpoint has no network side effect');

  const { gateway: offline } = makeGateway({
    store: baseStore(),
    request: async () => { throw new Error('Failed to fetch'); },
    fetchImpl: async () => { throw new Error('network offline'); },
  });
  await assert.rejects(
    () => offline('ping', '', {}),
    (error) => {
      assert.match(error.message, /шлюз Drive не ответил/);
      assert.equal(error.refused, false);
      assert.equal(error.relay, 'gateway');
      return true;
    },
  );
}

console.log(`OK: relay ${version} ↔ Drive Gateway 1.5 — bounded transport, explicit refusals, idempotent append`);
