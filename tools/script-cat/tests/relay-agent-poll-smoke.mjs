// Проба 1.4.63: агент спросил вместо работы — цикл отвечает сам.
//
// 24.10 в 17:25 Kernel на середине NAR-1.12 остановился и выставил опрос
// «May I expand the write zone for this task?»: варианты, свободное поле и
// `Skip`. Для транспорта это конец хода без маркера — работа не сдана, карточка
// висит в Running, а напоминание уходит агенту, который просто ждёт ответа.
//
// Здесь проверяется:
//   • вопросы видны все сразу и вместе с вариантами, а не только первый;
//   • на каждый вопрос уходит универсальный ответ в его собственное поле;
//   • вопросы и варианты попадают в журнал попытки (их читает Координатор);
//   • повторный тик не отвечает на тот же вопрос второй раз;
//   • `Skip` внутри группы вариантов не считается плашкой и не закрывает
//     опросник целиком;
//   • опрос разбирается до напоминаний, в ручном и в автоматическом режиме;
//   • третий опрос за ход — пауза: это уже противоречие в карточке.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Версия ──────────────────────────────────────────────────────────────
const versionMatch = assertUserscriptVersionContract(src);

// ── 2. Вопросы читаются целиком ────────────────────────────────────────────
const pollFrom = src.indexOf('  const POLL_REPLY = "Реши сам в рамках Scope');
const pollTo = src.indexOf('  /**\n   * Ждём появления редактора.');
assert.ok(pollFrom > 0 && pollTo > pollFrom, 'блок разбора опроса на месте');
const pollBlock = src.slice(pollFrom, pollTo);
assert.match(
  pollBlock,
  /POLL_REPLY = "Реши сам в рамках Scope карточки и продолжай; допущение запиши в отчёт\."/,
  'ответ универсальный: решай сам в рамках Scope и запиши допущение',
);
assert.match(pollBlock, /querySelectorAll\('\[role="radiogroup"\]'\)/, 'вопросы ищутся по группам');
assert.match(pollBlock, /\.at\(-1\);/, 'смотрим последнее сообщение агента');
assert.match(pollBlock, /question: pollQuestionText\(group\)/, 'текст вопроса сохраняется');

const store = new Map();
const logged = [];
const journal = [];
const pauses = [];
const events = [];
let clock = 0;

function makeGroup(question, options, { input = true, submitDisabled = false, staleFor = 0 } = {}) {
  const box = {
    value: '',
    ownerDocument: { defaultView: { Event: class Ev { constructor(type) { this.type = type; } } } },
    dispatchEvent(e) {
      events.push(`${question}:${e.type}`);
      return true;
    },
  };
  // Кнопки повторяют живую разметку: у Submit есть aria-label, у Skip — нет.
  const button = (text, aria, extra = {}) => ({
    textContent: text,
    clicks: 0,
    getAttribute: (name) => (name === 'aria-label' ? aria : null),
    click() { this.clicks += 1; },
    ...extra,
  });
  const submit = button('Submit', 'Submit custom response', { disabled: submitDisabled });
  // Клик в Arena очищает поле: по этому признаку скрипт и понимает, что ответ ушёл.
  submit.click = function click() {
    this.clicks += 1;
    if (this.disabled) return;
    this.sent = box.value; // что именно ушло — проверяем по этому
    box.value = ''; // Arena очищает поле после Submit
  };
  const skip = button('Skip', null);
  // Submit в Arena включается только после того, как React примет текст.
  // `staleFor` — сколько первых чтений кнопка ещё выключена.
  if (staleFor) {
    let reads = 0;
    Object.defineProperty(submit, 'disabled', { get: () => (reads += 1) <= staleFor, configurable: true });
  }
  const radios = options.map((o) => ({ innerText: o, textContent: o }));
  return {
    box,
    submit,
    skip,
    el: {
      isConnected: true,
      getAttribute: (name) => (name === 'aria-label' ? question : null),
      querySelector: (sel) => (input && sel.startsWith('input') ? box : null),
      querySelectorAll: (sel) =>
        sel === 'button' ? [submit, skip] : sel === '[role="radio"]' ? radios : [],
      getBoundingClientRect: () => ({ width: 240, height: 60 }),
    },
  };
}

function makePollApi(groups) {
  const message = {
    id: 'chat-message-01a16e73-b2f2-7096-9b53-da7ff06fd4ac',
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[role="radiogroup"]' ? groups.map((g) => g.el) : []),
  };
  const document = {
    querySelectorAll: (sel) =>
      sel === '[data-agent-transcript-message="true"]' ? [message] : [],
  };
  const fn = new Function(
    'document', 'GM_getValue', 'GM_setValue', 'log', 'sleep', 'firstLine', 'textHash',
    'nowIso', 'gateway', 'C', 'pause', 'location', 'window', 'nodeId', 'visible', 'getComputedStyle', 'Date',
    `${pollBlock}
     return { answerPolls, pollQuestions, pollLogEntry, POLL_REPLY };`,
  );
  return fn(
    document,
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    (text, bad, opts) => logged.push({ text, bad, opts }),
    async () => {},
    (text, n = 220) => String(text).slice(0, n),
    (text) => `h${String(text).length}`,
    () => '2026-10-24T14:31:00.000Z',
    async (action, fileId, extra) => {
      journal.push({ action, fileId, ...extra });
      return { ok: true };
    },
    { pollPauseCount: 3 },
    (reason, context) => pauses.push({ reason, context }),
    { pathname: '/agent/kernel' },
    { KeyboardEvent: class KE { constructor(type) { this.type = type; } } },
    (node) => node.id.replace('chat-message-', ''),
    () => true,
    () => ({ visibility: 'visible', display: 'block' }),
    // Часы идут быстрее реальных: ожидание кнопки не должно растягивать пробу.
    { now: () => (clock += 250) },
  );
}

// 2.1. Два вопроса в одном опросе — оба видны сразу, со своими вариантами.
{
  store.clear();
  logged.length = 0;
  journal.length = 0;
  const zone = makeGroup('May I expand the write zone for this task?', [
    'Yes—complete the mission scope',
    'Source scope, no bundle',
    'Keep current zone',
  ]);
  const bundle = makeGroup('Rebuild the tracked CLI bundle?', ['Allow', 'Do not']);
  const api = makePollApi([zone, bundle]);
  const found = api.pollQuestions();
  assert.equal(found.length, 2, 'в опросе видны оба вопроса, а не только первый');
  assert.equal(found[0].question, 'May I expand the write zone for this task?', 'текст первого вопроса');
  assert.deepEqual(found[0].options, [
    'Yes—complete the mission scope',
    'Source scope, no bundle',
    'Keep current zone',
  ], 'варианты первого вопроса');
  assert.equal(found[1].question, 'Rebuild the tracked CLI bundle?', 'текст второго вопроса');
  assert.ok(found[0].input && found[0].submit, 'поле и кнопка Submit найдены');
}

// 2.2. Ответ уходит в каждое поле, вопросы пишутся в журнал попытки.
{
  store.clear();
  logged.length = 0;
  journal.length = 0;
  pauses.length = 0;
  const zone = makeGroup('May I expand the write zone for this task?', ['Yes', 'No']);
  const bundle = makeGroup('Rebuild the tracked CLI bundle?', ['Allow', 'Do not']);
  const api = makePollApi([zone, bundle]);
  const result = await api.answerPolls(
    { name: 'Kernel' },
    { runId: 'run-1', ref: 'card-1', logId: 'log-1' },
  );
  assert.equal(result, 'answered', 'опрос разобран');
  assert.equal(zone.submit.sent, api.POLL_REPLY, 'в первое поле вписан и отправлен ответ скрипта');
  assert.equal(bundle.submit.sent, api.POLL_REPLY, 'во второе поле тоже');
  assert.equal(zone.submit.clicks, 1, 'первый вопрос отправлен кнопкой Submit');
  assert.equal(bundle.submit.clicks, 1, 'второй вопрос тоже');
  assert.ok(!events.includes('May I expand the write zone for this task?:input') === false, 'поле правится событием input, а не напрямую');
  assert.ok(logged.some((l) => /Kernel спросил вместо работы/.test(l.text)), 'вопрос назван в журнале');
  assert.ok(
    logged.filter((l) => /спросил вместо работы/.test(l.text)).length === 2,
    'в журнале оба вопроса, а не первый',
  );
  assert.equal(journal.length, 1, 'опрос записан в журнал попытки');
  assert.equal(journal[0].fileId, 'log-1', 'журнал попытки — файл этой выдачи');
  const entry = journal[0].entry;
  assert.match(entry, /<!-- CF_DISPATCH .*:poll:/, 'маркер принимается шлюзом и защищает от повтора');
  assert.match(entry, /May I expand the write zone for this task\?/, 'первый вопрос в журнале');
  assert.match(entry, /Rebuild the tracked CLI bundle\?/, 'второй вопрос в журнале');
  assert.match(entry, /Keep current zone|Do not/, 'варианты ответов тоже записаны');
  assert.match(entry, /Реши сам в рамках Scope карточки/, 'ответ скрипта записан');
}

// 2.3. Повторный тик не отвечает второй раз: карточка остаётся в транскрипте.
{
  store.clear();
  logged.length = 0;
  journal.length = 0;
  const zone = makeGroup('May I expand the write zone for this task?', ['Yes', 'No']);
  const api = makePollApi([zone]);
  const first = await api.answerPolls({ name: 'Kernel' }, { runId: 'run-2', ref: 'card-2' });
  const second = await api.answerPolls({ name: 'Kernel' }, { runId: 'run-2', ref: 'card-2' });
  assert.equal(first, 'answered', 'первый раз отвечаем');
  assert.equal(second, 'waiting', 'второй раз только ждём');
  assert.equal(zone.submit.clicks, 1, 'второй отправки нет');
}

// 2.4. Опроса нет — функция молчит и ничего не трогает.
{
  store.clear();
  const api = makePollApi([]);
  assert.equal(await api.answerPolls({ name: 'Kernel' }, null), null, 'нет опроса — нет работы');
}

// 2.5. Свободного поля нет — только тогда Skip, и об этом сказано прямо.
{
  store.clear();
  logged.length = 0;
  pauses.length = 0;
  const noField = makeGroup('Разрешить расширение зоны?', ['Да', 'Нет'], { input: false });
  const api = makePollApi([noField]);
  const result = await api.answerPolls({ name: 'Kernel' }, { runId: 'run-3', ref: 'card-3' });
  assert.equal(result, 'waiting', 'ответить некуда — работа не считается сделанной');
  assert.equal(noField.skip.clicks, 1, 'Skip нажимается только здесь');
  assert.ok(logged.some((l) => /Skip нажат, но опрос не исчез.*не подтверждено/.test(l.text)), 'неподтверждённый Skip назван честно');
  assert.equal((store.get('cfn-poll2:run-3') || []).length, 0, 'неподтверждённый Skip не блокирует повтор');
}

// 2.6. Submit включается не сразу — скрипт ждёт его и всё равно отправляет.
// 24.10 в 18:50 текст «Решай сам» появился в поле, а кнопка осталась
// выключенной: клик «одновременно с вставкой» ушёл в пустоту, и вопрос повис.
{
  store.clear();
  logged.length = 0;
  const slow = makeGroup('May I expand the write zone?', ['Yes', 'No'], { staleFor: 3 });
  const api = makePollApi([slow]);
  const result = await api.answerPolls({ name: 'Kernel' }, { runId: 'run-5', ref: 'card-5' });
  assert.equal(result, 'answered', 'дождались включения кнопки и отправили');
  assert.equal(slow.submit.sent, api.POLL_REPLY, 'текст ушёл именно через Submit');
  assert.ok(!logged.some((l) => /нажал Skip/.test(l.text)), 'Skip не понадобился');
}

// 2.7. Третий опрос за ход — пауза: это уже поломка, а не случайность.
{
  store.clear();
  pauses.length = 0;
  for (let i = 1; i <= 3; i += 1) {
    const g = makeGroup(`Вопрос ${i}`, ['Да', 'Нет']);
    const api = makePollApi([g]);
    await api.answerPolls({ name: 'Kernel' }, { runId: 'run-4', ref: 'card-4' });
  }
  assert.equal(pauses.length, 1, 'третий опрос подряд ставит цикл на паузу');
  assert.match(pauses[0].reason, /спрашивает вместо работы 3 раз за ход/, 'причина названа');
  assert.equal(pauses[0].context.kind, 'poll-loop', 'вид паузы');
}

// ── 3. Skip внутри вопроса не закрывает опросник ───────────────────────────
const skipFrom = src.indexOf('  function skipCardButton() {');
const skipTo = src.indexOf('  /**\n   * Плашка «Эта задача была выполнена успешно?»', skipFrom);
assert.ok(skipFrom > 0 && skipTo > skipFrom, 'skipCardButton на месте');
const skipBlock = src.slice(skipFrom, skipTo);
assert.match(skipBlock, /button\.closest\?\.\('\[role="radiogroup"\]'\)\) continue;/, 'внутри опроса Skip не нажимается');
assert.match(skipBlock, /закрыл бы сразу весь опросник/, 'причина записана рядом с кодом');

// ── 4. Опрос разбирается до напоминаний ────────────────────────────────────
const tickFrom = src.indexOf('  async function tick(');
const tickBlock = src.slice(tickFrom, src.indexOf('  // ───────────────────────────── старт ─────────────────────────────', tickFrom));
const pollAt = tickBlock.indexOf('const poll = await answerPolls(me, expect);');
const waitAt = tickBlock.indexOf('// Ждать ответа бесконечно нельзя');
const readAt = tickBlock.indexOf('await submitExecutor(me, expect, fromToggle);');
assert.ok(pollAt > 0, 'в тике есть разбор опроса');
assert.ok(pollAt < waitAt, 'опрос разбирается раньше ожидания и напоминаний');
assert.ok(readAt > 0 && pollAt < readAt, 'и раньше чтения ответа');
assert.match(
  tickBlock.slice(pollAt, pollAt + 400),
  /if \(poll === "answered"\) \{\s*\n\s*log\(/,
  'об ответе сказано в журнале',
);
assert.match(
  tickBlock.slice(pollAt, pollAt + 1600),
  /waitedPoll > C\.replyWaitMs/,
  'если агент не продолжил — сторож тишины, а не вечное ожидание',
);
assert.match(tickBlock.slice(0, pollAt), /if \(!auto && !fromToggle\) return;/, 'порядок: ручной режим — только по «Шагу»');

// ── 5. Промпт: зона не спорит с Scope, вопрос полем маркера ────────────────
const { PromptCompiler, dispatchRequest, planRequest } = await import('./helpers/prompt-env.mjs');
const rules = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(rules, /Scope расширяет на ход/, 'зона — рамка по умолчанию');
// D-083: канал назван «обратной связью» — это то же поле, но слово то, которым
// Мастер и агенты его называют: «вопрос» читалось как «строка в базе».
assert.match(rules, /question в маркере/, 'обратная связь только полем маркера');
assert.match(rules, /default пиши его целиком/, 'вариант по умолчанию передаётся без усечения');
assert.match(rules, /Чат-опрос запрещён/, 'опрос в чате по-прежнему запрещён');
assert.doesNotMatch(rules, /Не задавай вопросов, не создавай опросов/, 'старый полный запрет убран');
const coordRules = PromptCompiler.compile(planRequest()).text;
assert.match(coordRules, /Scope покрывает артефакты оракула/, 'Scope покрывает пробу и npm-скрипт');
assert.match(coordRules, /next:"blocked"/, 'право остановить цикл — в промпте Координатора');

// ── 6. Маркер blocked ставит паузу, а не ищет роль с таким именем ──────────
const coordFrom = src.indexOf('  async function coordinatorStep(');
const coordBlock = src.slice(coordFrom, src.indexOf('  /**\n   * Запрос хода Координатора.', coordFrom));
// D-083: `blocked` считается один раз вверху (`const blocked = …`), потому что
// от него зависит ещё и разбор вопроса: при остановке вопрос держит ход.
assert.match(coordBlock, /const blocked = norm\(decision\.next\) === "blocked";/, 'blocked разбирается до маршрута');
assert.match(coordBlock, /kind: "blocked-role"/, 'отдельный вид паузы');
assert.ok(
  coordBlock.indexOf('const blocked = norm(decision.next)') < coordBlock.indexOf('decisionRoute('),
  'до поиска роли по имени',
);

console.log(`OK: relay ${versionMatch[1]} — опрос агента разбирается целиком, ответ уходит после Submit и пишется в журнал`);
