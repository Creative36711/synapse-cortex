// Проба файла задания: доходит ли текст из Drive до исполнителя.
//
// Мастер (49): «проверь на всякий случай, действительно ли для исполнителя
// подтягивается информация из файла задания». Вопрос по делу: в карточке поле
// `Payload Drive File ID` необязательное, а весь текст задания обычно и так
// лежит в карточке — незаметно сломанное чтение файла никто бы не увидел.
//
// Здесь `dispatchTask` исполняется целиком (кусок исходника вычисляется), а
// Notion, шлюз Drive и отправка в чат заменены заглушками. Проверяется не
// наличие строк в файле, а поведение: файл прочитан, его текст ушёл в задание
// и в журнал попытки; без файла выдача идёт по карточке; битый id — пауза.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const from = src.indexOf('  async function dispatchTask(');
const to = src.indexOf('  // ───────────────────────────── цикл', from);
assert.ok(from > 0 && to > from, 'dispatchTask на месте');

function makeHarness({ payloadId = '', fileText = '', readFails = false } = {}) {
  const calls = [];
  const store = {};
  const card = {
    id: 'card-1',
    properties: {
      'Запрос': { title: [{ plain_text: 'NAR-1.7 · Эффекты' }] },
      'Намерение': { rich_text: [{ plain_text: 'Вынести эффекты.' }] },
      'Кому': { select: { name: 'Kernel' } },
      'Payload Drive File ID': { rich_text: payloadId ? [{ plain_text: payloadId }] : [] },
      'Dispatch State': { select: { name: 'Ready' } },
      'PR': { url: null },
      'Submitted At': { date: null },
    },
  };

  const dispatchTask = new Function(
    'roles', 'roleRows', 'norm', 'rt', 'gateway', 'patch', 'taskLogEntry', 'executorPrompt',
    'log', 'taskTitle', 'uid', 'nowIso', 'sendToRole',
    'notion', 'taskState', 'taskRole', 'GM_getValue', 'GM_setValue', 'pause', 'K',
    'redispatchClearProps', 'redispatchWhy', 'noteRedispatch', 'REDISPATCH_LIMIT',
    'answerStampKey', 'reworkKey', 'taskPreflight',
    `${src.slice(from, to)}; return dispatchTask;`,
  )(
    async () => [{ id: 'agent-1', name: 'Kernel', fn: 'Executor' }],
    async () => [{ id: 'agent-1', name: 'Kernel', fn: 'Executor', status: 'Активна', url: '/agent/agent-1' }],
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
    async (action, fileId, extra = {}) => {
      calls.push({ action, fileId, entry: extra.entry, marker: extra.marker });
      if (action === 'read') {
        if (readFails) throw new Error('Файл недоступен');
        return { ok: true, content: fileText };
      }
      if (action === 'createLog') return { ok: true, fileId: 'LOG1' };
      return { ok: true, result: 'appended' };
    },
    async (id, props) => calls.push({ action: 'patch', id, props }),
    (task, role, payload) => `LOG[${payload}]`,
    (task, role, payload) => `PROMPT[${payload}]`,
    (text, error) => calls.push({ action: 'log', text, error }),
    (task) => (task.properties['Запрос']?.title || []).map((x) => x.plain_text).join(''),
    () => 'run-1',
    () => '2026-10-23T17:00:00.000Z',
    async (role, prompt, kind, ref) => {
      calls.push({ action: 'send', prompt, kind, ref });
      return true;
    },
    // 1.4.20: перед выдачей карточка перечитывается из Notion. Заглушка
    // отдаёт ту же карточку, поэтому состояние остаётся Ready.
    async () => card,
    (page) => page?.properties?.['Dispatch State']?.select?.name || '',
    (page) => page?.properties?.['Кому']?.select?.name || '',
    (key, fallback) => store[key] ?? fallback,
    (key, value) => {
      store[key] = value;
    },
    (text) => calls.push({ action: 'pause', text }),
    { pending: 'cfn-pending', expect: 'cfn-expect' },
    // 1.4.78: снятие следов повторной работы проверяется отдельной пробой
    // (relay-rework-return-smoke.mjs); здесь важно, что обычная выдача идёт
    // прежним путём.
    () => null,
    () => "",
    () => 1,
    3,
    (id) => `cfn-answer-stamp:${id}`,
    (id) => `cfn-rework:${id}`, async () => '',
  );
  return { dispatchTask, card, calls };
}

// ── 1. Файл есть: его текст идёт и в задание, и в журнал ───────────────────
{
  const text = 'ПОДРОБНОЕ ЗАДАНИЕ ИЗ ФАЙЛА\nвторая строка';
  const h = makeHarness({ payloadId: 'PAYLOAD_FILE_1', fileText: text });
  const sent = await h.dispatchTask(h.card, 'Kernel');

  assert.equal(sent, true, 'ход выдан');
  const read = h.calls.find((c) => c.action === 'read');
  assert.ok(read, 'файл задания прочитан');
  assert.equal(read.fileId, 'PAYLOAD_FILE_1', 'читается именно id из карточки');
  assert.ok(
    h.calls.some((c) => c.action === 'send' && c.prompt === `PROMPT[${text}]`),
    'текст файла дошёл до промпта исполнителя',
  );
  assert.ok(
    h.calls.some((c) => c.action === 'append' && String(c.entry || '').includes(text)),
    'текст файла записан в журнал попытки',
  );
  assert.ok(
    h.calls.some((c) => c.action === 'patch' && c.props['Dispatch State'].select.name === 'Running'),
    'карточка переведена в Running',
  );
}

// ── 2. Файла нет: выдача идёт по карточке, чтения не было ─────────────────
{
  const h = makeHarness();
  const sent = await h.dispatchTask(h.card, 'Kernel');
  assert.equal(sent, true, 'ход выдан без файла');
  assert.ok(!h.calls.some((c) => c.action === 'read'), 'без Payload Drive File ID шлюз не дёргается');
  assert.ok(
    h.calls.some((c) => c.action === 'send' && c.prompt === 'PROMPT[]'),
    'задание собрано из карточки',
  );
  assert.ok(
    h.calls.some((c) => c.action === 'log' && /отдельного файла с заданием нет/.test(c.text)),
    'в журнале панели видно, откуда взялось задание',
  );
}

// ── 3. Битый id: пауза с понятной причиной, а не тихий переход на карточку ─
{
  const h = makeHarness({ payloadId: 'BROKEN', readFails: true });
  await assert.rejects(
    () => h.dispatchTask(h.card, 'Kernel'),
    /Payload не прочитан: Файл недоступен/,
    'нечитаемый файл останавливает выдачу с причиной',
  );
  assert.ok(!h.calls.some((c) => c.action === 'send'), 'исполнителю пустышка не уходит');
}

// ── 4. Порядок: файл читается до выдачи, запись в журнал — до отправки ────
assert.match(
  src.slice(from, to),
  /gateway\("read", payloadId\)[\s\S]*?gateway\("append", logId[\s\S]*?sendToRole\(role, executorPrompt/,
  'чтение файла → журнал → отправка',
);

// ── 5. Координатору сказано, когда файл нужен, а когда нет ────────────────
const techFrom = src.indexOf('  const COORDINATOR_TECH = [');
const techTo = src.indexOf('  const TECH_BY_FN', techFrom);
const tech = src.slice(techFrom, techTo);
assert.match(tech, /Payload Drive File ID/, 'поле названо');
assert.match(tech, /обычно не нужен/, 'сказано, что файл не обязателен');
assert.match(tech, /Arena\/payloads/, 'названа папка');
assert.match(tech, /docs\/agents\/drive\.md/, 'есть ссылка на раскладку Диска');
assert.doesNotMatch(tech, /кнопк|Continue|интерфейс/i, 'про интерфейс Координатору не рассказывают');

console.log('OK: relay 1.4.63 — текст из файла задания доходит до исполнителя и в журнал; без файла работает карточка');
