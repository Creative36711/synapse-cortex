// Проба 1.14.4: «агент ещё отвечает» не должно быть вечным.
//
// Что видел Мастер 09.11 (журнал 13:30): задание Locale Auditor сначала
// получило «Something went wrong», транспорт честно повторил его минимальным
// сообщением, а дальше 12 часов стояло:
//
//   13:31:03 Агент ещё отвечает: задание из очереди подождёт и уйдёт, как только
//            он закончит (плашка «Карточка «SYN-3 · B5 · Анализатор литералов
//            fail-closed» · d»).
//   13:32:10 Автоцикл выключен.
//
// Ошибки не было, паузы тоже: цикл формально не останавливался, он ждал
// «агента», который давно молчал. Виновата проверка индикаторов работы, и в ней
// два независимых дефекта:
//
//   1. длину сверяли по ОБРЕЗАННОЙ подписи (`shortLabel` режет до 60 знаков), а
//      порог был 80 — условие «длинный текст — значит транскрипт» не срабатывало
//      НИКОГДА, ни на одной странице;
//   2. шаблон `/thinking|reasoning|typing|дума|размышл|анализ/i` искал слово
//      ГДЕ УГОДНО в тексте. Наша же реплика задания лежит в контейнере с
//      `aria-live`, в ней есть «Анализатор литералов» — совпало «анализ», и
//      задание само себя объявило признаком работы агента.
//
// Проверяется поведением: настоящий `busyReason` исполняется на модели DOM.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `не найден блок ${String(from).slice(0, 48)}`);
  return src.slice(a, b);
};

// ── 1. Обрезка подписи и полный текст ──────────────────────────────────────
{
  const helpers = cut('  const fullLabel = (el) =>', '  /**\n   * Причина «агент ещё работает»');
  const { shortLabel, fullLabel } = new Function(`${helpers}; return { shortLabel, fullLabel };`)();
  const el = {
    getAttribute: () => null,
    textContent: 'Карточка «SYN-3 · B5 · Анализатор литералов fail-closed» · dispatch 4126f0cf-5705-813f-9b45-c60f2fd06e49',
  };
  assert.ok(fullLabel(el).length > 80, 'полный текст длиннее порога — транскрипт виден как транскрипт');
  assert.equal(shortLabel(el).length, 60, 'обрезанная подпись остаётся 60 знаками (журнал не раздувается)');
  assert.match(shortLabel(el), /Анализатор/, 'и всё равно содержит злополучное слово');
  assert.equal(shortLabel(el), fullLabel(el).slice(0, 60), 'короткая — производная от полной');
}

// ── 2. busyReason на разметке: индикатор против транскрипта ─────────────────
// Исполняется настоящий busyReason с настоящими fullLabel/shortLabel.
const busySource = `${cut('  const fullLabel = (el) =>', '  const busyLabel = (reason) =>')}
  return { busyReason };`;

const el = (text, { attrs = {}, area = true, inside = null, tag = 'div' } = {}) => ({
  tagName: tag.toUpperCase(),
  textContent: text,
  isConnected: true,
  disabled: false,
  attrs,
  closest(sel) {
    if (inside && sel.split(',').some((part) => part.trim() === inside)) return { inside };
    if (sel.includes('[data-state="closed"]') && attrs.closed) return { closed: true };
    return null;
  },
  getAttribute(name) { return this.attrs[name] ?? null; },
  hasAttribute(name) { return Boolean(this.attrs[name]); },
  getBoundingClientRect: () => ({ width: area ? 100 : 0, height: area ? 20 : 0 }),
});

const makeBusy = ({ marks = [], stop = null, plaque = null } = {}) => {
  const document = {
    querySelectorAll(sel) {
      if (sel.includes('[role="status"]')) return marks;
      if (sel.includes('[data-agent-transcript-message]')) return [];
      return [];
    },
  };
  // fullLabel/shortLabel объявлены внутри самого блока — передавать их нельзя,
  // иначе Identifier has already been declared. Это и есть проверка, что проба
  // исполняет настоящие функции, а не свои копии.
  return new Function(
    'document', 'getComputedStyle', 'completionPlaque', 'visible', 'sleep',
    `${busySource}`,
  )(
    document,
    () => ({ opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }),
    () => plaque,
    (node) => Boolean(node && node.getBoundingClientRect().width > 0),
    async () => {},
  ).busyReason;
};

// Ровно та строка из журнала Мастера: своя реплика с заданием в aria-live.
{
  const busyReason = makeBusy({
    marks: [el('Карточка «SYN-3 · B5 · Анализатор литералов fail-closed» · dispatch 4126f0cf-5705-813f-9b45-c60f2fd06e49 · run 11774abe-3ef2-41e9-b42d-32d693639385', {
      attrs: { 'aria-live': 'polite' },
      inside: '[data-user-message-layout="true"]',
    })],
  });
  assert.equal(busyReason(), null, 'своё же задание с «Анализатором» — не признак работы агента');
}

// Даже без разметки сообщения: длинный текст — транскрипт, а не индикатор.
{
  const busyReason = makeBusy({
    marks: [el('Карточка «SYN-3 · B5 · Анализатор литералов fail-closed» · dispatch 4126f0cf-5705-813f-9b45-c60f2fd06e49')],
  });
  assert.equal(busyReason(), null, 'длинный текст не считается индикатором (проверка по полному тексту)');
}

// Настоящие индикаторы продолжают работать — правило не выключило признак.
for (const label of ['Thinking', 'Thinking…', 'Анализирую задание', 'Думает', 'agent is typing']) {
  const busyReason = makeBusy({ marks: [el(label, { attrs: { 'aria-live': 'polite' } })] });
  assert.deepEqual(busyReason(), { kind: 'status', label }, `«${label}» — признак работы`);
}

// Прошедшее время и свёрнутая история — по-прежнему не работа.
assert.equal(makeBusy({ marks: [el('Thought for 12s')] }).busyReason?.() ?? null, null, 'прошедшее время — не работа');
{
  const busyReason = makeBusy({ marks: [el('Thinking…', { attrs: { closed: true } })] });
  assert.equal(busyReason(), null, 'свёрнутая история рассуждений — не работа');
}
// Нулевая площадь — не «видно».
{
  const busyReason = makeBusy({ marks: [el('Thinking', { area: false })] });
  assert.equal(busyReason(), null, 'скрытый индикатор не держит шаг');
}
// Индикатор внутри ответа агента — тоже часть транскрипта.
{
  const busyReason = makeBusy({ marks: [el('Thinking', { inside: '[data-agent-transcript-message]' })] });
  assert.equal(busyReason(), null, 'индикатор в старом сообщении не держит шаг');
}
// Плашка «задача выполнена» сильнее любого признака: ход закончен.
{
  const busyReason = makeBusy({ marks: [el('Thinking')], plaque: { found: true } });
  assert.equal(busyReason(), null, 'плашка завершения гасит признак работы');
}

// ── 3. Слово о состоянии — в начале подписи, а не где попало ───────────────
{
  const busyReason = makeBusy({ marks: [el('Если «Анализ» не нужен — пропусти')] });
  assert.equal(busyReason(), null, 'слово в кавычках посреди фразы — не индикатор');
  const real = makeBusy({ marks: [el('Анализ задачи: 3 файла')] });
  assert.deepEqual(real(), { kind: 'status', label: 'Анализ задачи: 3 файла' }, 'подпись о состоянии в начале — индикатор');
}

// ── 4. Порог длины по полному тексту жив, а не мёртв ──────────────────────
{
  assert.match(src, /const full = fullLabel\(el\);/, 'длина берётся из полного текста');
  assert.match(src, /full\.length > 80/, 'порог сверяется с полным текстом');
  assert.doesNotMatch(src, /label\.length > 80/, 'проверки по обрезанной строке нет');
  assert.doesNotMatch(src, /shortLabel\(el\);\s*\n\s*if \(!label \|\| label\.length > 80\)/, 'старый дефект не вернулся');
}

// ── 5. Даже честная занятость не длится вечно ─────────────────────────────
// Исполняется настоящая ветка «адресат занят» из consumePending: у ожидания
// есть предел, после которого ставится пауза, а задание остаётся в очереди.
{
  const src17 = readFileSync(new URL('../src/17-arena-polls.js', import.meta.url), 'utf8');
  const from = src17.indexOf('    const busy = await busySettled();');
  const to = src17.indexOf('    // Капча висит поверх чата', from);
  assert.ok(from > 0 && to > from, 'ветка занятости на месте');
  const block = src17.slice(from, to);

  const MIN = 60_000;
  const run = ({ busySince = 0, busy = { kind: 'stop', label: 'Stop generating' }, now = Date.now() } = {}) => {
    const store = new Map();
    const logs = [];
    const pauses = [];
    const pending = { roleId: 'agent-1', roleName: 'Locale Auditor', title: 'SYN-3 · B5', text: 'x'.repeat(4000), at: 1, busySince };
    const code = `return async function(pending) {
      const C = { pendingBusyMaxMs: 30 * 60 * 1000 };
      ${block}
      return "ушло дальше";
    }`;
    const fn = new Function(
      'GM_getValue', 'GM_setValue', 'K', 'C', 'busySettled', 'busyLabel', 'pendingSay', 'log', 'pause',
      'firstLine', 'Date',
      code,
    )(
      (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      (key, value) => store.set(key, value),
      { pending: 'cfn-pending' },
      { pendingBusyMaxMs: 30 * MIN },
      async () => busy,
      (reason) => `кнопка «${reason?.label || ''}»`,
      (p, text, error) => logs.push({ text, error }),
      () => {},
      (reason, context) => pauses.push({ reason, context }),
      (text, max = 80) => String(text || '').slice(0, max),
      class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    );
    return { pending, store, logs, pauses, fn };
  };

  // Первый заход: занят — ставим отметку и объясняем ожидание.
  {
    const { store, logs, pauses, fn } = run({ busySince: 0 });
    assert.equal(await fn({ roleId: 'a', at: 1, busySince: 0 }), true, 'ждём, дальше не идём');
    assert.ok(store.get('cfn-pending').busySince > 0, 'момент начала занятости запомнен');
    assert.equal(pauses.length, 0, 'первый заход паузы не ставит');
    assert.match(logs[0].text, /подождёт и уйдёт/, 'Мастер видит, что происходит');
  }
  // Занят 5 минут — ждём дальше, но уже с числом и пределом.
  {
    const now = Date.now();
    const { logs, pauses, fn } = run({ busySince: now - 5 * MIN, now });
    assert.equal(await fn({ roleId: 'a', at: 1, busySince: now - 5 * MIN }), true, 'ещё ждём');
    assert.equal(pauses.length, 0, 'пять минут — не поломка');
    assert.match(logs[0].text, /5 мин/, 'в журнале видно, сколько уже ждём');
    assert.match(logs[0].text, /Предел ожидания — 30 мин/, 'и сколько ещё будем');
  }
  // Занят 31 минуту — это уже зависание: пауза, а не молчание.
  {
    const now = Date.now();
    const { pauses, store, fn } = run({ busySince: now - 31 * MIN, now });
    assert.equal(await fn({ roleId: 'a', at: 1, busySince: now - 31 * MIN }), true, 'шаг не продолжается');
    assert.equal(pauses.length, 1, 'поставлена пауза — цикл больше не «жив формально»');
    assert.equal(pauses[0].context.kind, 'busy-stuck', 'вид паузы назван по причине');
    assert.match(pauses[0].reason, /31 мин/, 'названо, сколько ждали');
    assert.match(pauses[0].reason, /осталось в очереди и не потеряно/, 'сказано, что задание цело');
    assert.match(pauses[0].reason, /«Продолжить»/, 'сказано, что делать');
    assert.equal(store.get('cfn-pending').busySince, 0, 'отметка снята: следующий заход начнёт отсчёт заново');
  }
  // Освободился — отсчёт снимается, чтобы предел не копился.
  {
    const now = Date.now();
    const { store, fn } = run({ busySince: now - 29 * MIN, busy: null, now });
    const result = await fn({ roleId: 'a', at: 1, busySince: now - 29 * MIN });
    assert.equal(result, 'ушло дальше', 'свободен — задание уходит');
    assert.equal(store.get('cfn-pending').busySince, 0, 'отсчёт занятости сброшен');
  }
  // Предел живёт в конфиге и совпадает с replyWaitMs по смыслу.
  const config = readFileSync(new URL('../src/01-config.js', import.meta.url), 'utf8');
  assert.match(config, /pendingBusyMaxMs:\s*1800000/, 'предел занятости — 30 минут');
  // Вид паузы есть в таблице классов: иначе heal-core падал бы на сверке.
  assert.match(readFileSync(new URL('../src/40-heal-core.js', import.meta.url), 'utf8'),
    /"busy-stuck": "master"/, 'busy-stuck классифицирован');
}
