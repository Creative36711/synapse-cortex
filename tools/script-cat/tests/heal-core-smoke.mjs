// Самовосстановление транспорта (D-073): правила, а не текст.
//
// Проверяется то, ради чего правила писались отдельным ядром:
//   • у КАЖДОГО вида остановки из кода есть класс и маршрут (машинная сверка с
//     `pause(..., { kind })` — «нераспознанное» не должно быть обычным путём);
//   • штатные остановки (вопрос, план, пилот, приёмка, предел доработок) не
//     маршрутизируются как поломка — их класс `master`;
//   • капча/авторизация/сбой сайта — стоп и Мастер, чинить нечего;
//   • предохранители считаются по инциденту: 2 автопродолжения и 2 разбора
//     Maintainer'ом, дальше стоп;
//   • телеметрия не несёт переписки и секретов, укладывается в лимит;
//   • гейт версии различает «новая сборка», «прежняя», «тот же отпечаток под
//     новым номером» и таймаут.
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healApi } from './helpers/prompt-env.mjs';

const {
  HEAL_PAUSE_CLASS, classifyPause, decideHeal, healIncidentKey, healBackoff,
  buildHealTelemetry, healRedact, decideVersionGate, heartbeatLine, parseHeartbeat,
} = healApi;

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

// ── 1. Каждый вид паузы из кода назван в таблице ───────────────────────────
// Собираем `kind:"…"` ТОЛЬКО из вызовов pause(...) (со скобочной сверкой, чтобы
// не поймать вид сообщения или иной kind рядом) и сверяем с таблицей. Порядок
// важен: таблица не может «отстать» от кода молча.
function pauseKinds(text) {
  const out = [];
  const re = /(^|[^.\w])pause\(/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const call = text.slice(start, i - 1);
    const kind = call.match(/kind:\s*"([a-z0-9-]+)"/);
    if (kind) out.push(kind[1]);
    // Тернарный вид: `kind: liveAnswer ? "mission-change-answer" : "…"` — оба
    // значения настоящие виды паузы, и оба должны быть в таблице.
    const ternary = call.match(/kind:\s*[^,}]*\?\s*"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"/);
    if (ternary) out.push(ternary[1], ternary[2]);
    // Другие вызовы `pause(` внутри того же файла не теряются: регексп идёт с
    // lastIndex по всей строке, а сверка границ исключает одноимённые функции.
  }
  return out;
}

/** Виды пауз, поставленные напрямую в состояние (`GM_setValue(K.pause, …)`). */
function directPauseKinds(text) {
  const out = [];
  for (const m of text.matchAll(/GM_setValue\(K\.pause,\s*\{/g)) {
    const rest = text.slice(m.index, m.index + 900);
    const kind = rest.match(/kind:\s*"([a-z0-9-]+)"/);
    if (kind) out.push(kind[1]);
  }
  return out;
}
const kinds = new Map();
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js') && f !== '40-heal-core.js')) {
  const text = readFileSync(join(srcDir, file), 'utf8');
  for (const kind of [...pauseKinds(text), ...directPauseKinds(text)]) if (!kinds.has(kind)) kinds.set(kind, file);
}
assert.ok(kinds.size >= 60, `видов паузы найдено ${kinds.size}: сверка осмысленна только на полном списке`);
const missing = [...kinds.keys()].filter((kind) => !(kind in HEAL_PAUSE_CLASS));
assert.deepEqual(missing, [], `виды паузы без класса: ${missing.join(', ')}`);
const unknownKinds = Object.keys(HEAL_PAUSE_CLASS).filter((kind) => !kinds.has(kind));
// D-085: занятый номер решения — дефект ответа приёмки, а не повод будить
// человека: список номеров лежит в docs/DECISIONS.md и читается транспортом.
assert.equal(HEAL_PAUSE_CLASS['answer-decisions'], 'transport',
  'answer-decisions уходит транспорту: правит приёмка, не Мастер');
assert.equal(HEAL_PAUSE_CLASS['marker-mismatch'], 'master',
  'соседние паузы приёмки не сдвинулись');
assert.deepEqual(unknownKinds, [],
  `в таблице есть виды, которых нет в коде (опечатка или удалённая пауза): ${unknownKinds.join(', ')}`);

// ── 2. Штатные остановки — не поломка ──────────────────────────────────────
//
// D-092: класс у них по-прежнему `master` («нужен ход рассуждения, а не
// повтор»), но адресат рассуждения разный: лимит инструментов и предел
// доработок снимает транспорт, решение по ТЗ и по петле — приёмка, и только
// пилот и «вопрос про продукт» остаются человеку.
const ADDRESS = {
  'tool-limit': 'transport',
  'rework-limit': 'warden',
  'arbiter-limit': 'warden',
  'no-reply': 'warden',
  'review-needs-master': 'master',
  'pilot-timeout': 'master',
};
for (const [kind, address] of Object.entries(ADDRESS)) {
  const v = classifyPause(kind, 'штатная остановка');
  assert.equal(v.cls, 'master', `${kind}: штатная остановка не маршрутизируется как поломка`);
  assert.equal(v.repair, 'none', `${kind}: транспорт это не чинит`);
  assert.equal(v.with, address, `${kind}: адресат решения — ${address}`);
  const action = decideHeal(v, {}, {}).action;
  assert.equal(action, address === 'warden' ? 'warden' : address === 'transport' ? 'maintainer' : 'master',
    `${kind}: маршрут решения — ${action}`);
}

// ── 3. Капча, авторизация, сбой сайта — стоп и Мастер ──────────────────────
for (const [kind, text, cls] of [
  ['captcha', 'Появилась капча (Security Verification)', 'captcha'],
  ['arena-error', 'Видимая ошибка Arena в последнем сообщении: Something went wrong', 'arena-error'],
  ['ui-error', 'Необработанная ошибка интерфейса: rate limit', 'ui-error'],
  ['', 'Войдите в аккаунт, сессия истекла', 'auth'],
]) {
  const v = classifyPause(kind, text);
  assert.equal(v.cls, 'arena', `${kind || 'без вида'}: класс arena`);
  assert.equal(v.reason, cls, `${kind || 'без вида'}: причина названа (${cls})`);
  assert.equal(v.route, 'master', `${cls}: маршрут — человек`);
  assert.equal(decideHeal(v, { retries: 0, escalations: 0 }, {}).action, 'master', `${cls}: автопродолжения нет`);
}
// Ярлык не сильнее текста: «временный» вид с текстом капчи остаётся капчей.
assert.equal(classifyPause('nav', 'появилась капча').reason, 'captcha', 'текст причины важнее ярлыка');
assert.equal(classifyPause('nav', 'появилась капча').route, 'master', 'капча не уходит в автопродолжение');

// ── 4. Поломка транспорта — Maintainer, с предохранителем N=2 ─────────────
for (const kind of ['prompt-compile', 'orphan-dispatch', 'delivery-state-lost', 'handoff-kind']) {
  const v = classifyPause(kind, 'поломка в транспорте');
  assert.equal(v.cls, 'transport', `${kind}: класс transport`);
  assert.equal(v.route, 'maintainer', `${kind}: маршрут к Maintainer'у`);
  assert.equal(v.repair, 'maintainer', `${kind}: чинит Maintainer`);
}
{
  const v = classifyPause('prompt-compile', 'поломка');
  assert.deepEqual(decideHeal(v, { escalations: 0 }, { healMaintainerMax: 2 }).action, 'maintainer');
  assert.deepEqual(decideHeal(v, { escalations: 1 }, { healMaintainerMax: 2 }).action, 'maintainer');
  const third = decideHeal(v, { escalations: 2 }, { healMaintainerMax: 2 });
  assert.equal(third.action, 'master', 'третий разбор того же инцидента — стоп');
  assert.match(third.why, /Maintainer уже 2/, 'причина стопа называет предохранитель');
}

// ── 5. Временный сбой — продолжаем сами, но не бесконечно ─────────────────
{
  const v = classifyPause('nav', 'Не удалось открыть страницу');
  assert.equal(v.cls, 'momentary');
  const first = decideHeal(v, { retries: 0 }, { healRetryMax: 2, healBackoffMs: [30000, 120000] });
  assert.equal(first.action, 'retry');
  assert.equal(first.delayMs, 30000, 'первая выдержка — 30 с');
  const second = decideHeal(v, { retries: 1 }, { healRetryMax: 2, healBackoffMs: [30000, 120000] });
  assert.equal(second.action, 'retry');
  assert.equal(second.delayMs, 120000, 'вторая выдержка — 2 мин');
  // D-092: исчерпанный повтор — дефект, а не «решение человека». Уходит
  // транспорту, у него дифф и проба; человек тут ничего не выбирает.
  const third = decideHeal(v, { retries: 2 }, { healRetryMax: 2 });
  assert.equal(third.action, 'maintainer', 'после двух автопродолжений — разбор транспорта');
  assert.equal(healBackoff(5, { healBackoffMs: [1000, 2000] }), 2000, 'выдержка не выходит за список');
}

// ── 6. Нераспознанное — транспорту, а не человеку (D-092) ─────────────────
//
// Инверсия по умолчанию: раньше неизвестный вид уходил Мастеру, и любая
// опечатка в имени паузы будила человека. Теперь неизвестное читается как
// «вид не назван» и уходит разбору транспорта: у него есть журнал, снимок и
// дифф, а у человека — только кнопка «Продолжить», которая ничего не чинит.
{
  const v = classifyPause('never-seen-kind', 'непонятно что');
  assert.equal(v.unknown, true, 'нераспознанное помечено');
  assert.equal(v.cls, 'transport', 'неизвестное — дефект транспорта, а не решение человека');
  assert.equal(v.with, 'transport', 'адресат — транспорт');
  assert.equal(decideHeal(v, {}, { healMaintainerMax: 2 }).action, 'maintainer', 'уходит Maintainer-у');
  const exhausted = decideHeal(v, { escalations: 2 }, { healMaintainerMax: 2 });
  assert.equal(exhausted.action, 'master', 'после предела разбора — единственный стоп');
}

// ── 7. Ключ инцидента: цифры и id не делают новый инцидент ────────────────
{
  const a = healIncidentKey({ kind: 'nav', ref: 'x', reason: 'ждал 17 мин, попытка 2' });
  const b = healIncidentKey({ kind: 'nav', ref: 'x', reason: 'ждал 18 мин, попытка 3' });
  assert.equal(a, b, 'разные числа в одной причине — один инцидент');
  const c = healIncidentKey({ kind: 'nav', ref: 'y', reason: 'ждал 17 мин' });
  assert.notEqual(a, c, 'другая карточка — другой инцидент');
  const d = healIncidentKey({ kind: 'nav', ref: 'x', reason: 'ждал 17 мин, id 7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f' });
  assert.equal(healIncidentKey({ kind: 'nav', ref: 'x', reason: 'ждал 19 мин, id 11111111-2222-4333-8444-555555555555' }),
    d, 'UUID в причине не создаёт новый инцидент');
}

// ── 8. Телеметрия: состав журнала и снимок страницы, без переписки ────────
{
  const built = buildHealTelemetry({
    phase: 'stop',
    at: '2026-11-08T20:00:00.000Z',
    version: '1.13.0',
    fingerprint: 'deadbeefdeadbeef',
    profile: 'synapse',
    incident: { kind: 'prompt-compile', ref: 'a709d6df-4698-4a98-b111-90d22de42894', reason: 'Промпт не собран' },
    verdict: { cls: 'transport', route: 'maintainer', why: 'поломка транспорта' },
    snapshot: {
      url: 'https://arena.ai/agent/01a1a650?token=secret-value',
      messages: 12,
      tail: [{ id: 'm1', chars: 900 }],
      editor: { found: true, textLength: 42 },
    },
    journal: [{ at: '2026-11-08T19:59:00.000Z', profileId: 'executor.card', chars: 8000, outcome: 'queued' }],
  }, 200000);
  assert.ok(built.fits, 'payload уложился в лимит');
  assert.equal(built.payload.schema, 'relay-heal/1');
  assert.equal(built.payload.journal.length, 1, 'журнал попыток входит в состав');
  assert.equal(built.payload.page.messages, 12, 'снимок страницы структурный');
  assert.ok(!('text' in built.payload.page), 'текста страницы нет');
  assert.doesNotMatch(JSON.stringify(built.payload), /secret-value/, 'query-строка адреса вырезана');
  assert.match(built.payload.page.url, /<скрыто>/);
  // Переписка: снимок несёт только id и длины, ни одного текста реплики.
  assert.doesNotMatch(JSON.stringify(built.payload), /ЗАДАНИЕ|Отчёт исполнителя/);
}

// ── 9. Секреты не выносятся ───────────────────────────────────────────────
{
  const dirty = {
    token: 'ntn_abcdefghijklmno12345',
    header: 'Authorization: Bearer abcdefghijklmnop',
    github: 'ghp_abcdefghijklmnopqrst',
    key: 'CF_GATEWAY_KEY=abcdef',
    url: 'https://script.google.com/macros/s/AKfy/exec?key=abcdefgh&x=1',
    sha: 'feade59ea36ecbf5589d91ace70dbb31a9a1ea2e',
  };
  const clean = buildHealTelemetry({ journal: [], snapshot: dirty, incident: {}, phase: 'stop' }, 200000).payload;
  const text = JSON.stringify(clean);
  for (const secret of ['ntn_abcdefghijklmno12345', 'abcdefghijklmnop', 'ghp_abcdefghijklmnopqrst', 'abcdefgh', 'feade59ea36ecbf5589d91ace70dbb31a9a1ea2e']) {
    assert.ok(!text.includes(secret), `секрет «${secret.slice(0, 8)}…» не вынесен`);
  }
  assert.equal(clean.page.token, '<скрыт>', 'поле токена скрыто по имени');
  assert.match(healRedact('ghp_abcdefghijklmnopqrst'), /gh_<скрыт>/);
}

// ── 10. Усечение: сам инцидент остаётся, история режется ──────────────────
{
  const journal = Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(500) }));
  const built = buildHealTelemetry({ journal, incident: { kind: 'nav', reason: 'важное' }, snapshot: {} }, 20000);
  assert.ok(built.fits, 'payload уложился в предел даже на большом журнале');
  assert.ok(built.dropped > 0, 'часть истории отброшена и это посчитано');
  assert.equal(built.payload.incident.reason, 'важное', 'сам инцидент не режется');
}

// ── 11. Гейт версии ───────────────────────────────────────────────────────
{
  assert.equal(decideVersionGate({ pausedVersion: '1.13.0', nowVersion: '1.13.0', waitedMs: 1000 }).ok, false,
    'прежняя сборка не пропускает продолжение');
  assert.equal(decideVersionGate({ pausedVersion: '1.13.0', nowVersion: '1.13.0', waitedMs: 1000 }).stop, false,
    'ожидание новой сборки — не стоп');
  const timedOut = decideVersionGate({ pausedVersion: '1.13.0', nowVersion: '1.13.0', waitedMs: 1000000, timeoutMs: 900000 });
  assert.equal(timedOut.stop, true, 'таймаут подтверждения — стоп');
  assert.match(timedOut.why, /не подтверждена/);
  const fresh = decideVersionGate({ pausedVersion: '1.12.21', nowVersion: '1.13.0',
    pausedFingerprint: 'aaaa', nowFingerprint: 'bbbb' });
  assert.equal(fresh.ok, true, 'новая версия с другим отпечатком — продолжаем');
  const samePrint = decideVersionGate({ pausedVersion: '1.12.21', nowVersion: '1.13.0',
    pausedFingerprint: 'aaaa', nowFingerprint: 'aaaa' });
  assert.equal(samePrint.ok, false, 'номер сменился, сборка та же — не продолжаем');
  assert.equal(samePrint.stop, true);
  assert.match(samePrint.why, /отпечаток сборки тот же/);
  assert.equal(decideVersionGate({ cancelled: true }).stop, true, 'отмена подтверждения — стоп');
  assert.equal(decideVersionGate({ pausedVersion: '', nowVersion: '1.13.0' }).ok, true,
    'сравнивать не с чем — версия названа, продолжаем');
}

// ── 12. Сердцебиение читается и не несёт секретов ────────────────────────
{
  const line = heartbeatLine({ version: '1.13.0', fingerprint: 'deadbeef', state: 'running', at: '2026-11-08T20:00:00.000Z', seq: 7 });
  const back = parseHeartbeat(line);
  assert.deepEqual(back, { schema: 1, version: '1.13.0', state: 'running', at: '2026-11-08T20:00:00.000Z', fingerprint: 'deadbeef', seq: 7 });
  assert.equal(parseHeartbeat('мусор'), null, 'нечитаемая строка — null, а не догадка');
  assert.equal(parseHeartbeat(heartbeatLine({ state: 'paused' })).state, 'paused', 'пауза видна сторожу');
  assert.doesNotMatch(line, /ntn_|ghp_|Bearer/, 'в пульсе нет секретов');
}

console.log(
  `OK: heal-core — ${kinds.size} видов паузы размечены, маршруты и предохранители проверены, ` +
  'телеметрия без переписки и секретов, гейт версии различает 4 исхода',
);
