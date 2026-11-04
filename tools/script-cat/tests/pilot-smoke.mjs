// Эфемерные пилоты SYN-P1: регистрация только по URL Мастера, изоляция брифа,
// идемпотентность, отдельный namespace и завершение по фактам, а не по маркеру.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { PromptCompiler, pilotRequest } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../src/pilot-transport.js', import.meta.url), 'utf8');
const from = src.indexOf('  const PILOT_TIMEOUT_MS');
const to = src.indexOf('  const pilotOnPage');
assert.ok(from > 0 && to > from, 'модуль пилотов на месте');

const store = new Map();
const GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
const GM_setValue = (k, v) => store.set(k, v);
let seq = 0;
const api = new Function('GM_getValue', 'GM_setValue', 'norm', 'uid', 'nowIso', 'PromptCompiler', 'K', 'log', 'location',
  `${src.slice(from, to)}\nreturn { registerPilotAgent, listPilots, pilotBriefClean, pilotVariant, sendToEphemeralAgent };`)(
  GM_getValue, GM_setValue,
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  () => `pilot-${++seq}`,
  () => '2026-11-04T00:00:00.000Z',
  PromptCompiler,
  { pilots: 'cfn-pilots-v1', rolesCache: 'cfn-roles-cache', pilotWait: 'cfn-pilot-wait:' },
  () => {},
  { assign() {} },
);

const SHA = 'b'.repeat(40);
const good = { url: 'https://arena.ai/agent/pilot-xyz', brief: 'B. Сделай 2D выживание на canvas.', startSha: SHA, isolation: 'Мастер подтвердил: отдельный агент, без памяти команды' };

// 1. Валидация: https, SHA, вариант, изоляция, чистый бриф.
assert.equal(api.registerPilotAgent({ ...good, url: 'http://x' }).ok, false, 'только https');
assert.equal(api.registerPilotAgent({ ...good, startSha: 'short' }).ok, false, 'SHA 40 hex');
assert.equal(api.registerPilotAgent({ ...good, brief: 'Сделай игру' }).ok, false, 'вариант A/B/C обязателен');
assert.equal(api.registerPilotAgent({ ...good, isolation: '' }).ok, false, 'изоляция обязательна');
assert.equal(api.registerPilotAgent({ ...good, brief: 'A. Сделай игру и запиши в Notion' }).ok, false, 'внутренние токены запрещены');
assert.equal(api.pilotBriefClean('A. Используй CF_AGENT_RESULT и REGULATION'), false);
assert.equal(api.pilotVariant('C. бриф'), 'C');

// 2. Успешная регистрация и идемпотентность по URL.
const first = api.registerPilotAgent(good);
assert.ok(first.ok && !first.reused);
const again = api.registerPilotAgent(good);
assert.ok(again.ok && again.reused && again.id === first.id, 'повтор по URL не плодит пилотов');
assert.equal(api.listPilots().length, 1);

// 3. Изоляция от боевой роли: тот же URL, что у роли команды, отклоняется.
store.set('cfn-roles-cache', [{ url: 'https://arena.ai/agent/team-kernel' }]);
assert.equal(api.registerPilotAgent({ ...good, url: 'https://arena.ai/agent/team-kernel' }).ok, false, 'боевой URL запрещён');

// 4. Отправка пишет в отдельный namespace, не в K.pending/K.expect.
const sent = api.sendToEphemeralAgent(first.id);
assert.ok(sent.ok);
assert.ok(store.has('cfn-pilot-wait:' + first.id), 'ожидание пилота в своём ключе');
assert.ok(!store.has('cfn-pending') && !store.has('cfn-expect'), 'командный транспорт не тронут');
const wait = store.get('cfn-pilot-wait:' + first.id);
assert.ok(wait.text.includes(SHA), 'бриф несёт startSha');
assert.ok(!/CF_[A-Z]+_RESULT/.test(wait.text), 'пилот без командных маркеров');

// 5. Компилятор пилота держит бюджет и не пропускает командную роль.
assert.ok(PromptCompiler.compile(pilotRequest()).ok);
assert.equal(PromptCompiler.compile(pilotRequest({ role: { fn: 'Coordinator' } })).error.code, 'unknown_profile');

console.log('OK: pilot — регистрация по URL Мастера, изоляция, идемпотентность, отдельный namespace, без маркеров');
