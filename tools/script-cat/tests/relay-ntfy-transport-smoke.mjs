// Структурная проба relay.user.js: транспорт ntfy.sh.
//
// Регресс 1.4.0: тема и заголовок пуша уходили в HTTP-заголовках X-Title/X-Tags.
// Заголовки допускают только ISO-8859-1, поэтому кириллица отклонялась браузером
// ещё до отправки — «Тихий тест»/«Громкий тест» не делали ничего и молчали.
// Теперь публикация идёт JSON-телом на https://ntfy.sh/, а топик нормализуется
// (принимается и ссылка https://ntfy.sh/<топик>).

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const file = new URL('../relay.user.js', import.meta.url);
const src = readFileSync(file, 'utf8');

// 1. В @connect есть ntfy.sh, версия поднята.
assert.match(src, /@connect\s+ntfy\.sh/, '@connect ntfy.sh');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

// 2. В коде нет кириллицы в заголовках: X-Title/X-Priority/X-Tags не используются.
for (const header of ['X-Title', 'X-Tags', 'X-Priority']) {
  assert.ok(!src.includes(`"${header}"`), `заголовок ${header} больше не шлётся`);
}
assert.match(src, /Content-Type": "application\/json; charset=utf-8"/, 'тело уходит JSON (UTF-8 разрешён)');

// 3. Нормализация топика и публикация — вытаскиваем и проверяем поведение.
const start = src.indexOf('const NTFY_BASE =');
const end = src.indexOf('function notifyNtfy(');
assert.ok(start > 0 && end > start, 'блок транспорта найден');
const block = src.slice(start, end);

const load = (stubs = {}) =>
  new Function(
    'GM_xmlhttpRequest',
    'fetch',
    `${block}\nreturn { normalizeNtfyTopic, ntfyPublish, ntfyHealth };`,
  )(stubs.GM_xmlhttpRequest, stubs.fetch);

// 3.1. Старый топик Мастера проходит и в исходном виде, и ссылкой.
const { normalizeNtfyTopic } = load();
assert.equal(normalizeNtfyTopic('arena-creative36711'), 'arena-creative36711', 'простое имя');
assert.equal(normalizeNtfyTopic('  arena-creative36711 \n'), 'arena-creative36711', 'пробелы обрезаются');
assert.equal(normalizeNtfyTopic('https://ntfy.sh/arena-creative36711'), 'arena-creative36711', 'ссылка ntfy.sh');
assert.equal(normalizeNtfyTopic('https://ntfy.sh/arena-creative36711?x=1#y'), 'arena-creative36711', 'ссылка с query');
assert.equal(normalizeNtfyTopic('ntfy.sh/arena-creative36711'), 'arena-creative36711', 'имя с префиксом');
assert.equal(normalizeNtfyTopic('https://ntfy.sh/arena-creative36711/'), 'arena-creative36711', 'ссылка со слешем');
assert.equal(normalizeNtfyTopic(''), '', 'пусто — выключено');
assert.equal(normalizeNtfyTopic('плохой топик!'), '', 'недопустимые символы не уходят на сервер');

// 3.2. Успешная отправка: один POST через GM, JSON-тело, база ntfy.sh.
const posts = [];
const ok = load({
  GM_xmlhttpRequest: (opts) => {
    posts.push(opts);
    setTimeout(() => opts.onload({ status: 200, responseText: '{"id":"abc"}' }), 0);
  },
  fetch: async () => {
    throw new Error('fetch не должен вызываться, если GM сработал');
  },
});
const sent = await ok.ntfyPublish('https://ntfy.sh/arena-creative36711', '', {
  message: 'Тихий тест: привет, Мастер.',
  title: 'Relay: тихий тест',
  priority: 2,
  tags: 'memo',
});
assert.equal(sent.via, 'gm', 'первый путь — GM_xmlhttpRequest');
assert.equal(posts.length, 1, 'ровно один запрос');
assert.equal(posts[0].method, 'POST', 'POST');
assert.equal(posts[0].url, 'https://ntfy.sh/', 'публикация JSON — на корень, топик в теле');
assert.equal(posts[0].headers.Authorization, undefined, 'без токена нет Authorization');
for (const value of Object.values(posts[0].headers)) {
  assert.ok(!/[^\x00-\x7F]/.test(String(value)), `в заголовке только ASCII: ${value}`);
}
const body = JSON.parse(posts[0].data);
assert.equal(body.topic, 'arena-creative36711', 'топик нормализован в теле');
assert.equal(body.title, 'Relay: тихий тест', 'кириллический заголовок идёт в теле');
assert.equal(body.priority, 2, 'тихий приоритет');
assert.deepEqual(body.tags, ['memo'], 'теги массивом');

// 3.3. Отказ GM (например, нет @connect) — пробуем fetch, а не молчим.
let viaFetch = null;
const fallback = load({
  GM_xmlhttpRequest: (opts) => setTimeout(() => opts.onerror(), 0),
  fetch: async (url, init) => {
    viaFetch = { url, init };
    return { ok: true, status: 200, text: async () => '{}' };
  },
});
const second = await fallback.ntfyPublish('arena-creative36711', 'tk_1', { message: 'x', title: 'y', priority: 5 });
assert.equal(second.via, 'fetch', 'второй путь — fetch');
assert.equal(viaFetch.url, 'https://ntfy.sh/', 'fetch тоже на корень');
assert.equal(viaFetch.init.headers.Authorization, 'Bearer tk_1', 'токен уходит как Bearer');

// 3.4. Оба пути упали — в сообщении видны оба, а не пустая тишина.
const broken = load({
  GM_xmlhttpRequest: (opts) => setTimeout(() => opts.ontimeout(), 0),
  fetch: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
});
await assert.rejects(
  () => broken.ntfyPublish('arena-creative36711', '', { message: 'x' }),
  (e) => /GM: таймаут/.test(e.message) && /fetch: HTTP 403/.test(e.message),
  'ошибка называет оба пути',
);

// 3.5. Пустой/битый топик — понятная ошибка, а не запрос на сервер.
let touched = false;
const empty = load({
  GM_xmlhttpRequest: () => { touched = true; },
  fetch: async () => { touched = true; return { ok: true, status: 200, text: async () => '{}' }; },
});
await assert.rejects(() => empty.ntfyPublish('плохой топик!', '', { message: 'x' }), /топик/i);
assert.equal(touched, false, 'при битом топике сеть не дёргается');

// 4. Диалог: тест берёт значение из поля (persist до отправки), а результат
// виден в самом диалоге — успех, HTTP-код или текст исключения.
const dialog = src.slice(src.indexOf('function ntfyDialog()'), src.indexOf('function inputStyle()'));
assert.match(dialog, /const test = async/, 'общий обработчик тестов');
assert.match(dialog, /const name = persist\(\);/, 'тест сохраняет и берёт топик из поля, а не только сохранённый');
assert.match(dialog, /Отправлено: \$\{result\.via/, 'успех виден в диалоге');
assert.match(dialog, /Не ушло: \$\{e\.message\}/, 'ошибка видна в диалоге');
assert.match(dialog, /cfn-ntfy-health/, 'есть «Проверка связи»');
assert.match(dialog, /cfn-ntfy-open/, 'есть «Открыть топик» — проверить, дошло ли сообщение');
assert.match(dialog, /const watchdog = setTimeout\(/, 'есть сторож: зависший запрос не молчит');
assert.match(dialog, /log\(`ntfy: \$\{label\} отправлен/, 'успех теста попадает в журнал');
assert.match(dialog, /log\(`ntfy: \$\{label\} не отправлен/, 'ошибка теста попадает в журнал');
assert.ok(!/catch\s*\(\s*\)\s*\{/.test(src), 'нет пустых catch, глотающих ошибку');

// 5. Обычные пуши используют тот же транспорт с нормализованным топиком.
const notifyStart = src.indexOf('function notifyNtfy(');
const notify = src.slice(notifyStart, src.indexOf('  /** Гудок', notifyStart));
assert.ok(notifyStart > 0 && notify.length > 0, 'notifyNtfy найден целиком');
assert.match(notify, /ntfyPublish\(/, 'notifyNtfy идёт через ntfyPublish');
assert.match(notify, /normalizeNtfyTopic\(GM_getValue\(K\.ntfyTopic/, 'битый сохранённый топик не ломает цикл');
assert.match(notify, /console\.warn/, 'ошибка пуша не роняет цикл, но след остаётся');
assert.match(notify, /log\(`ntfy: пуш не ушёл/, 'сбой обычного пуша виден в журнале панели');
assert.match(notify, /skip: true/, 'сбой пуша не порождает новый пуш');

// 6. Настоящий классификатор и отправка: громко только при остановленном цикле.
const policyStart = src.indexOf('  const QUIET_NTFY = [');
const policyEnd = src.indexOf('\n\n  /**', src.indexOf('  function classifyNtfy(', policyStart));
assert.ok(policyStart > 0 && policyEnd > policyStart, 'классификатор на месте');
const classifyNtfy = new Function(`${src.slice(policyStart, policyEnd)}\nreturn classifyNtfy;`)();
const limiterStart = src.indexOf('  const NTFY_QUIET_WINDOW_MS =');
const limiterEnd = src.indexOf('  /** Гудок', limiterStart);
assert.ok(limiterStart > 0 && limiterEnd > limiterStart, 'реальная отправка и ограничитель на месте');
const notifierFactory = new Function(
  'GM_getValue', 'GM_setValue', 'K', 'normalizeNtfyTopic', 'isPaused', 'autoOn', 'ntfyPublish', 'log', 'Date',
  `${src.slice(limiterStart, limiterEnd)}\nreturn { notifyNtfy, allowQuietNtfy };`,
);
function notifier({ store = new Map(), clock = { now: 1_000_000 }, running = true, paused = false, fail = false } = {}) {
  if (!store.has('topic')) store.set('topic', 'arena-testing');
  const sent = [];
  const logs = [];
  const state = { running, paused };
  const api = notifierFactory(
    (k, fallback) => store.has(k) ? store.get(k) : fallback,
    (k, v) => store.set(k, structuredClone(v)),
    { ntfyTopic: 'topic', ntfyToken: 'token' }, normalizeNtfyTopic,
    () => state.paused, () => state.running,
    async (topic, token, message) => { sent.push({ topic, token, ...message }); if (fail) throw new Error('offline'); },
    (...args) => logs.push(args),
    class extends Date { static now() { return clock.now; } },
  );
  return { ...api, sent, logs, state, store, clock };
}

assert.equal(classifyNtfy('HTTP 502, запрос повторяется', true), null, 'обычная ошибка не превращается в сирену');
const noMerge = classifyNtfy('PR не слит, карточка в Rework', true, { ntfy: 'loud' });
assert.equal(noMerge.priority, '2', 'даже ошибочная пометка loud при работающем цикле становится тихой');
assert.equal(classifyNtfy('Переход на паузу', true, { ntfy: 'loud', cycleStopped: true }).priority, '5');
assert.equal(classifyNtfy('Игнорируется', true, { skip: true, ntfy: 'loud', cycleStopped: true }), null);
{
  const n = notifier();
  n.notifyNtfy('PR не слит, карточка в Rework', noMerge);
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].priority, '2');
  n.notifyNtfy('Ошибочно заявленная остановка', { priority: '5', tags: 'warning', cycleStopped: true, key: 'bad-stop' });
  assert.equal(n.sent[1].priority, '2', 'проверяется реальное состояние: цикл ещё работает');
  assert.equal(n.sent[1].tags, 'memo');
  n.state.paused = true;
  n.notifyNtfy('Действительная пауза', { priority: '5', tags: 'warning', cycleStopped: true });
  assert.equal(n.sent[2].priority, '5', 'пауза с сохранённым состоянием — громкая');
  n.state.paused = false;
  n.state.running = false;
  n.notifyNtfy('Миссия закончена', { priority: '5', tags: 'warning', cycleStopped: true });
  assert.equal(n.sent[3].priority, '5', 'закрытие миссии после выключения цикла — громкое');
}

// 7. Дедупликация переживает перезагрузку, различает run и топик, а лимит
// ограничивает разные тихие события. Остановка через лимит не теряется.
{
  const n = notifier();
  const opt = { priority: '2', key: 'dispatch-sent:card:run-1' };
  n.notifyNtfy('Первый запуск', opt);
  n.notifyNtfy('Первый запуск', opt);
  const reloaded = notifier({ store: n.store, clock: n.clock });
  reloaded.notifyNtfy('Та же веха после перехода', opt);
  assert.equal(n.sent.length, 1, 'одинаковая веха отправлена один раз');
  assert.equal(reloaded.sent.length, 0, 'переход страницы не сбросил дедупликацию');
  reloaded.notifyNtfy('Повторная выдача', { priority: '2', key: 'dispatch-sent:card:run-2' });
  assert.equal(reloaded.sent.length, 1, 'другой run — отдельное событие');
  n.clock.now += 10 * 60_000;
  reloaded.notifyNtfy('Первая веха через десять минут', opt);
  assert.equal(reloaded.sent.length, 2, 'ограничение не вечно');
  reloaded.store.set('topic', 'another-topic');
  reloaded.notifyNtfy('Веха на новом топике', opt);
  assert.equal(reloaded.sent.length, 3, 'новый топик имеет собственный лимит');
}
{
  const n = notifier();
  for (let i = 0; i < 12; i++) n.notifyNtfy(`событие ${i}`, { priority: '2', key: `event-${i}` });
  assert.equal(n.sent.length, 8, 'не больше восьми обычных тихих событий за десять минут');
  n.state.paused = true;
  n.notifyNtfy('Тихая остановка', { priority: '2', cycleStopped: true, key: 'pause' });
  n.notifyNtfy('Тихая остановка повторно', { priority: '2', cycleStopped: true, key: 'pause' });
  assert.equal(n.sent.length, 9, 'остановка проходит мимо лимита, но не дублируется');
  n.notifyNtfy('Громкая остановка', { priority: '5', tags: 'warning', cycleStopped: true });
  assert.equal(n.sent.length, 10, 'лимит тихих не блокирует громкую остановку');
  assert.equal(n.sent.at(-1).priority, '5');
  n.clock.now += 10 * 60_000;
  n.state.paused = false;
  n.notifyNtfy('Окно открылось', { priority: '2', key: 'after-window' });
  assert.equal(n.sent.length, 11);
}
{
  const n = notifier();
  n.store.set('topic', 'плохой топик!');
  n.notifyNtfy('Без топика', { priority: '2' });
  assert.equal(n.sent.length, 0);
  assert.equal(n.store.has('cfn-ntfy-recent'), false, 'отключённый топик не расходует лимит');
}
{
  const n = notifier({ fail: true });
  n.notifyNtfy('Не дошло', { priority: '2' });
  await Promise.resolve();
  assert.ok(n.logs.some((row) => /пуш не ушёл/.test(row[0]) && row[2].skip === true), 'сбой не порождает второй пуш');
}
// Ошибки нового хранилища лимитера не могут остановить выдачу или паузу.
for (const badRead of [true, false]) {
  let published = 0;
  const api = notifierFactory(
    (key, fallback) => {
      if (badRead) throw new Error('storage read failed');
      return key === 'topic' ? 'arena-testing' : fallback;
    },
    () => { throw new Error('storage write failed'); },
    { ntfyTopic: 'topic', ntfyToken: 'token' }, normalizeNtfyTopic,
    () => false, () => true,
    async () => { published++; }, () => {}, Date,
  );
  const warn = console.warn;
  try {
    console.warn = () => {};
    assert.doesNotThrow(() => api.notifyNtfy('Сбой настроек', { priority: '2' }));
  } finally {
    console.warn = warn;
  }
  assert.equal(published, 0, 'при недоступном хранилище не пытаемся обойти ограничитель');
}
// Реальные обработчики диалога, с минимальным DOM и поддельной сетью.
{
  const nodes = new Map();
  const box = { style: {}, remove() {}, querySelector: (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, { style: {}, value: '', textContent: '' });
    return nodes.get(sel);
  } };
  const state = { paused: false, running: true };
  const posts = [];
  const document = { getElementById: () => null, createElement: () => box, body: { appendChild() {} } };
  const open = new Function(
    'document', 'SCRIPT_VERSION', 'btnStyle', 'inputStyle', 'GM_getValue', 'GM_setValue', 'K',
    'normalizeNtfyTopic', 'isPaused', 'autoOn', 'ntfyPublish', 'log', 'ntfyHealth', 'window', 'setTimeout', 'clearTimeout',
    `${dialog}\nreturn ntfyDialog;`,
  )(
    document, 'test', () => '', () => '', (key) => key === 'topic' ? 'arena-testing' : '', () => {},
    { ntfyTopic: 'topic', ntfyToken: 'token' }, normalizeNtfyTopic, () => state.paused, () => state.running,
    async (topic, token, msg) => { posts.push({ topic, token, ...msg }); return { via: 'gm', status: 200 }; },
    () => {}, async () => [], { open() {} }, () => 1, () => {},
  );
  open();
  await nodes.get('#cfn-ntfy-loud').onclick();
  assert.equal(posts.length, 0, 'громкий тест не отправляется, пока автоцикл работает');
  assert.match(nodes.get('#cfn-ntfy-note').textContent, /только на паузе или при выключенном автоцикле/);
  await nodes.get('#cfn-ntfy-quiet').onclick();
  assert.equal(posts.at(-1).priority, 2, 'тихий тест доступен и во время работы');
  state.paused = true;
  await nodes.get('#cfn-ntfy-loud').onclick();
  assert.equal(posts.at(-1).priority, 5, 'громкий тест доступен на действительной паузе');
  state.paused = false;
  state.running = false;
  await nodes.get('#cfn-ntfy-loud').onclick();
  assert.equal(posts.at(-1).priority, 5, 'громкий тест доступен при выключенном автоцикле');
  assert.equal(posts.length, 3);
}
assert.match(src, /cycleStopped: true, title: "Relay: миссия принята"/, 'миссия выключает цикл перед громким событием');

// 8. Время вычисляется по подтверждённой отправке, а не по моменту окончания
// проверки PR; при недоступной дате время не придумывается.
const durationStart = src.indexOf('  function executorDuration(');
const durationEnd = src.indexOf('  async function submitExecutor(', durationStart);
assert.ok(durationStart > 0 && durationEnd > durationStart, 'форматирование времени найдено');
const { executorDuration, executorNtfyText } = new Function(
  'taskTitle', `${src.slice(durationStart, durationEnd)}\nreturn { executorDuration, executorNtfyText };`,
)(() => 'STAB-1.18 · доработка');
assert.equal(executorDuration({ dispatchSentAt: 10_000 }, {}, 85_000), '1 мин 15 с');
assert.equal(executorDuration({ dispatchSentAt: 10_000 }, {}, 3_710_000), '1 ч 1 мин');
assert.equal(executorDuration({ dispatchSentAt: 10_000 }, {}, 10_500), 'менее 1 с');
assert.equal(executorDuration({ dispatchSentAt: 10_000, sentAt: 80_000, tries: 1 }, {}, 85_000), '1 мин 15 с',
  'напоминание не обнуляет длительность исходной работы');
const startedPage = { properties: { 'Started At': { date: { start: '2026-10-31T12:00:00.000Z' } } } };
const afterStart = Date.parse('2026-10-31T12:02:00.000Z');
assert.equal(executorDuration({}, startedPage, afterStart), '2 мин 0 с');
assert.equal(executorDuration({ adopted: true, sentAt: afterStart - 1000 }, startedPage, afterStart), '2 мин 0 с',
  'при ручном поиске ответа sentAt — фиктивное сейчас, берём Started At');
assert.equal(executorDuration({ adopted: true, sentAt: 99_000 }, {}, 100_000), '', 'фиктивное время ручного поиска не сообщаем');
assert.equal(executorDuration({ dispatchSentAt: 0, sentAt: 99_000 }, {}, 100_000), '', 'неподтверждённое время не выдаём за работу');
assert.equal(executorDuration({ tries: 1, sentAt: 99_000 }, {}, 100_000), '', 'для старого напоминания без даты время не выдумывается');
assert.equal(executorDuration({ sentAt: 99_000 }, {}, 100_000), '', 'старое sentAt без подтверждённого начала может быть напоминанием');
assert.equal(executorDuration({}, {}, 100_000), '', 'при отсутствии данных нет вымышленного времени');
assert.equal(executorDuration({ dispatchSentAt: 100_000 }, {}, 99_000), '', 'будущее время отправки не превращается в отрицательную длительность');
assert.match(
  executorNtfyText({}, { name: 'Tools' }, { dispatchSentAt: 10_000 }, 85_000, 'ответ записан, карточка Submitted'),
  /STAB-1\.18.*Tools.*Submitted.*1 мин 15 с/,
  'тихое уведомление содержит задание, роль, результат и длительность',
);

console.log('OK: ntfy 1.4.92 — UTF-8 транспорт, тихие вехи с дедупликацией, громко только после остановки');
