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

// D-069: разбор поля и склейка файлов берутся из самого скрипта, а не копией в
// пробе — иначе мутация в исходнике не роняет проверку.
const utilsFrom = src.indexOf('  function driveFileIds(');
const utilsTo = src.indexOf('  function joinPayloadFiles(', utilsFrom);
const utilsEnd = src.indexOf('\n  }', utilsTo) + 4;
assert.ok(utilsFrom > 0 && utilsTo > utilsFrom && utilsEnd > utilsTo, 'помощники payload на месте');
const { driveFileIds, joinPayloadFiles } = new Function(
  `${src.slice(utilsFrom, utilsEnd)}; return { driveFileIds, joinPayloadFiles };`,
)();

function makeHarness({ payloadId = '', fileText = '', fileTexts = null, readFails = false, checkFail = false, reworkObserved = true } = {}) {
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
      'Check': { select: checkFail ? { name: 'fail' } : null },
      'PR': { url: checkFail ? 'https://github.com/example/relay-fixture/pull/1' : null },
      'Submitted At': { date: checkFail ? { start: '2026-11-03T10:00:00Z' } : null },
      'Run ID': { rich_text: checkFail ? [{ plain_text: 'previous-run' }] : [] },
    },
  };

  const dispatchTask = new Function(
    'roles', 'roleRows', 'norm', 'rt', 'gateway', 'patch', 'taskLogEntry', 'executorPrompt',
    'log', 'dbg', 'taskTitle', 'uid', 'nowIso', 'sendToRole',
    'notion', 'taskState', 'taskRole', 'taskTargetRepository', 'reworkSeen', 'C', 'ACTIVE_PROFILE', 'GM_getValue', 'GM_setValue', 'pause', 'K',
    'profileSessionRepo', 'canonicalTargetRepository', 'profileRepoBranch',
    'redispatchClearProps', 'redispatchWhy', 'noteRedispatch', 'REDISPATCH_LIMIT',
    'answerStampKey', 'reworkKey', 'taskPreflight', 'driveFileIds', 'joinPayloadFiles',
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
        const content = fileTexts && Object.prototype.hasOwnProperty.call(fileTexts, fileId)
          ? fileTexts[fileId]
          : fileText;
        return { ok: true, content };
      }
      if (action === 'createLog') return { ok: true, fileId: 'LOG1' };
      return { ok: true, result: 'appended' };
    },
    async (id, props) => calls.push({ action: 'patch', id, props }),
    (task, role, payload) => `LOG[${payload}]`,
    (task, role, payload) => `PROMPT[${payload}]`,
    (text, error) => calls.push({ action: 'log', text, error }),
    () => {},
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
    (page, fallback) => page?.properties?.Repository?.rich_text?.[0]?.plain_text || fallback,
    () => reworkObserved,
    { repo: 'example/relay-fixture', branch: 'main' },
    { legacy: true, repo: 'example/relay-fixture', branch: 'main' },
    (key, fallback) => store[key] ?? fallback,
    (key, value) => {
      store[key] = value;
    },
    (text) => calls.push({ action: 'pause', text }),
    { pending: 'cfn-pending', expect: 'cfn-expect' },
    // Цель выдачи в этой пробии — глобальный конфиг профиля.
    (id) => 'example/relay-fixture',
    (value, fallback) => String(value || fallback || '').trim(),
    (repo) => 'main',
    // 1.4.78: снятие следов повторной работы проверяется отдельной пробой
    // (relay-rework-return-smoke.mjs); здесь важно, что обычная выдача идёт
    // прежним путём.
    () => null,
    () => "",
    () => 1,
    3,
    (id) => `cfn-answer-stamp:${id}`,
    (id) => `cfn-rework:${id}`, async () => '',
    driveFileIds,
    joinPayloadFiles,
  );
  return { dispatchTask, card, calls };
}

// ── 1. Файл есть: его текст идёт и в задание, и в журнал ───────────────────
{
  const text = 'ПОДРОБНОЕ ЗАДАНИЕ ИЗ ФАЙЛА\nвторая строка';
  const h = makeHarness({ payloadId: 'PAYLOADFILE1aaaaaaaaaaaaaaaaaaa', fileText: text });
  const sent = await h.dispatchTask(h.card, 'Kernel');

  assert.equal(sent, true, 'ход выдан');
  const read = h.calls.find((c) => c.action === 'read');
  assert.ok(read, 'файл задания прочитан');
  assert.equal(read.fileId, 'PAYLOADFILE1aaaaaaaaaaaaaaaaaaa', 'читается именно id из карточки');
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
  const h = makeHarness({ payloadId: 'BROKENFILEaaaaaaaaaaaaaaaaaaaaaaa', readFails: true });
  await assert.rejects(
    () => h.dispatchTask(h.card, 'Kernel'),
    /Payload не прочитан \(файл BROKENFILEaaaaaaaaaaaaaaaaaaaaaaa\): Файл недоступен/,
    'нечитаемый файл останавливает выдачу с причиной',
  );
  assert.ok(!h.calls.some((c) => c.action === 'send'), 'исполнителю пустышка не уходит');
}

// ── 3б. Несколько файлов в поле (боевой B1 08.11): строка «id1, id2» — это два
// файла, а не один битый id. Раньше шлюз отвечал «Некорректный Drive file ID»,
// отказ разбирался как сбой Notion, и ход вставал.
{
  const first = 'ФАЙЛ-КОНТРАКТ: таблица ошибок сцены';
  const second = 'ФАЙЛ-ДОПОЛНЕНИЕ: карта соответствий';
  const ids = '1dCrg0UDwIwuPCDHHBC6hXx-rSrmrf2RV, 1nzGpfiDROrv5aiMfbyW-6dzceSvPjyrT (SYN3-B0-addendum-mapping.md)';
  const texts = {
    '1dCrg0UDwIwuPCDHHBC6hXx-rSrmrf2RV': first,
    '1nzGpfiDROrv5aiMfbyW-6dzceSvPjyrT': second,
  };
  const h = makeHarness({ payloadId: ids, fileText: '', fileTexts: texts });
  const sent = await h.dispatchTask(h.card, 'Kernel');
  assert.equal(sent, true, 'выдача с двумя файлами проходит');
  const reads = h.calls.filter((c) => c.action === 'read').map((c) => c.fileId);
  assert.deepEqual(reads, Object.keys(texts), 'каждый id прочитан отдельно, имя файла не мешает');
  const prompt = h.calls.find((c) => c.action === 'send').prompt;
  assert.ok(prompt.includes(first) && prompt.includes(second), 'в задании оба файла');
  assert.match(prompt, /--- файл 1 из 2: 1dCrg0UDwIwuPCDHHBC6hXx-rSrmrf2RV ---/, 'видно, где кончается первый файл');
  assert.match(prompt, /--- файл 2 из 2: 1nzGpfiDROrv5aiMfbyW-6dzceSvPjyrT ---/, 'и где начинается второй');
  const log = h.calls.find((c) => c.action === 'append');
  assert.ok(log && log.entry.includes(second), 'журнал попытки знает оба файла');
}

// ── 3в. Один файл остаётся дословным: заголовков «файл 1 из 1» в задании нет.
{
  const text = 'ОДИН ФАЙЛ, ДОСЛОВНО';
  const h = makeHarness({ payloadId: 'PAYLOADFILE1aaaaaaaaaaaaaaaaaaa', fileText: text });
  h.calls.length = 0;
  await h.dispatchTask(h.card, 'Kernel');
  const prompt = h.calls.find((c) => c.action === 'send').prompt;
  assert.equal(prompt, `PROMPT[${text}]`, 'текст единственного файла не обёрнут и не обрезан');
}

// ── 4. Check=fail без наблюдённого Rework возвращается Coordinator, не паузит и не чистит следы ──
{
  const h = makeHarness({ checkFail: true, reworkObserved: false });
  const reason = await h.dispatchTask(h.card, 'Kernel');
  assert.match(reason, /Check=fail/);
  assert.match(reason, /оставь карточку в Rework/);
  assert.equal(h.calls.filter((c) => c.action === 'pause').length, 0, 'первый отказ не останавливает цикл');
  assert.equal(h.calls.filter((c) => c.action === 'send').length, 0, 'исполнителю повторная выдача не уходит');
  assert.equal(h.calls.filter((c) => c.action === 'patch').length, 0, 'следы ответа и статус не меняются');
  assert.equal(h.card.properties['Run ID'].rich_text[0].plain_text, 'previous-run', 'Run ID сохранён');
}

// ── 5. Порядок: файл читается до выдачи, запись в журнал — до отправки ────
assert.match(
  src.slice(from, to),
  /gateway\("read", id\)[\s\S]*?const prompt = executorPrompt[\s\S]*?await patch\(card\.id[\s\S]*?gateway\("append", logId[\s\S]*?sendToRole\(role, prompt/,
  'чтение файла (каждый id отдельно) → проверка промпта → Running → журнал → отправка',
);

// ── 4б. Отказ чтения файла называется своим именем, а не «записью в Notion».
// Боевой разбор 08.11 показывал Мастеру «Шаг прервался на записи в Notion», хотя
// ни одной записи не было: упало чтение файла задания.
{
  const cycle = readFileSync(new URL('../src/28-cycle.js', import.meta.url), 'utf8');
  const payloadBranch = cycle.indexOf('/^Payload не прочитан/');
  const notionFallback = cycle.indexOf('"Шаг прервался на записи в Notion."');
  assert.ok(payloadBranch > 0, 'ветка «Payload не прочитан» есть');
  assert.ok(notionFallback > payloadBranch, 'она проверяется раньше общего «записи в Notion»');
  const branchText = cycle.slice(payloadBranch, notionFallback);
  assert.match(branchText, /Payload Drive File ID/, 'Мастеру сказано, что проверить');
  assert.match(branchText, /карточка не тронута/, 'сказано, что ход не потерян');
}

// ── 5. Координатору сказано, когда файл нужен, а когда нет ────────────────
const { PromptCompiler, planRequest } = await import('./helpers/prompt-env.mjs');
const tech = PromptCompiler.compile(planRequest()).text;
assert.match(tech, /Payload Drive File ID/, 'поле названо');
assert.match(tech, /обычно не нужен/, 'сказано, что файл не обязателен');
assert.match(tech, /Arena\/<project>\/payloads/, 'названа папка');
assert.match(tech, /docs\/agents\/drive\.md/, 'есть ссылка на раскладку Диска');
assert.doesNotMatch(tech, /кнопк|Continue|интерфейс/i, 'про интерфейс Координатору не рассказывают');

console.log('OK: relay 1.4.63 — текст из файла задания доходит до исполнителя и в журнал; без файла работает карточка');
