// Проба 1.4.63: «страница не открылась» — это не «агент молчит 77 минут».
//
// Журнал Мастера 25.10:
//   15:39:29 задание NAR-2.11 отправлено в «Turn Runtime»;
//   16:55:58 автоцикл включён, 16:55:59 скрипт открывает страницу адресата;
//   16:56:07 ПАУЗА: «Turn Runtime не ответил ни одним сообщением за 77 мин и
//            ничего не делает: похоже, задание до него не дошло»;
//   16:56:37 карточка возвращена в Ready.
//
// Восьми секунд не хватило даже на отрисовку: интернет только что вернулся,
// транскрипт пуст, кнопки Stop нет — и сторож тишины сработал по таймеру,
// который считался от отправки, а не от того, что скрипт вообще успел увидеть.
// Ответ при этом лежал в чате: агент отработал 17 м 53 с и прислал маркер.
//
// Здесь проверяется: пока `pageReady()` не сказал «страница отрисована»,
// ожидание и карточка не трогаются; одна перезагрузка страницы разрешена;
// пауза про связь не снимает очередь; сторож тишины требует выдержки после
// отрисовки; «Продолжить» начинает наблюдение заново.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 60)}`);
  return src.slice(a, b);
};

// ── 1. Пороги названы в конфиге ─────────────────────────────────────────────
assert.match(src, /\n    pageWaitMs: 90000,/, 'предел ожидания отрисовки — 90 с');
assert.match(src, /\n    pageReloadMs: 20000,/, 'через 20 с страница перечитывается один раз');
assert.match(src, /\n    observeGraceMs: 30000,/, 'выдержка после отрисовки — 30 с');
assert.match(src, /replyWaitMs: 1800000/, 'предел молчания не тронут');

// ── 2. `pageReady()` отличает загрузку от готовой страницы ──────────────────
const pageReadySrc = cut(
  '  function pageReady(expect) {',
  '  /** Наша реплика: в транскрипте Arena она помечена отдельным layout. */',
);
const makePageReady = ({
  state = 'complete',
  nodes = [],
  mine = [],
  editor = null,
  plaque = null,
  alert = null,
} = {}) => {
  const document = {
    readyState: state,
    querySelectorAll: (sel) => (sel === '[role="alert"]' && alert ? [alert] : []),
  };
  const fn = new Function(
    'document',
    'visible',
    'shortLabel',
    'messages',
    'composer',
    'completionPlaque',
    'userMessages',
    `${pageReadySrc}\nreturn pageReady;`,
  );
  return fn(
    document,
    () => true,
    () => '',
    () => nodes,
    () => editor,
    () => plaque,
    () => mine,
  );
};

assert.equal(makePageReady({ state: 'loading' })().ok, false, 'loading — страница не готова');
assert.match(makePageReady({ state: 'loading' })().why, /грузится/);
assert.equal(makePageReady({ nodes: [] })().ok, false, 'пустая страница без поля ввода — не готова');
assert.match(makePageReady({ nodes: [] })().why, /не отрисовалась/);
assert.equal(makePageReady({ nodes: [{}] })().ok, true, 'реплики есть — страница готова');
assert.equal(makePageReady({ editor: {} })().ok, true, 'поле ввода есть — страница готова');
assert.equal(makePageReady({ plaque: {} })().ok, true, 'плашка завершения — страница готова');
assert.equal(
  makePageReady({ alert: { textContent: 'Connection lost' } })().ok,
  false,
  'ошибка связи на странице — не готова',
);
assert.match(makePageReady({ alert: { textContent: 'Connection lost' } })().why, /нет связи/);

// 1.4.63: задание отправлено, а транскрипт пуст — это не «агент молчит».
// 25.10 в 17:47 поле ввода уже было, сообщений 0, и скрипт по нажатому «Шагу»
// написал «маркера этой выдачи в чате нет», хотя маркер лежал в чате.
assert.equal(
  makePageReady({ nodes: [] })({ sentAt: Date.now() }).ok,
  false,
  'своих реплик не видно — страница ещё не отрисована, судить нельзя',
);
assert.match(
  makePageReady({ nodes: [] })({ sentAt: Date.now() }).why,
  /своих реплик не видно/,
);
assert.equal(
  makePageReady({ nodes: [], mine: [{}] })({ sentAt: Date.now() }).ok,
  true,
  'своя реплика видна — чат отрисован, можно судить об ответе',
);
assert.match(
  src,
  /const page = pageReady\(expect\);\s+if \(!page\.ok\) \{/,
  'перед выводом «маркера нет» проверяется, что страница отрисована',
);

// ── 3. Пока страница не готова, ожидание и карточка не трогаются ────────────
const guard = cut('        if (!page.ok) {', '        const observed = Number(expect.readyAt)');
assert.ok(
  !/dropHandoff|releaseUndelivered/.test(guard),
  'на неотрисованной странице очередь, ожидание и карточка остаются на месте',
);

const runGuard = async ({
  watched,
  pageReloaded = false,
  page = { ok: false, why: 'ни реплик, ни поля ввода — страница не отрисовалась' },
}) => {
  const out = { sets: [], logs: [], pauses: [], reloaded: 0, flushes: [] };
  const fn = new Function(
    'GM_setValue',
    'K',
    'C',
    'log',
    'logThrottled',
    'pause',
    'location',
    'me',
    'expect',
    'page',
    'watched',
    // D-045: перечитывание страницы ждёт подтверждения записей.
    'flushBeforeNavigate',
    `return (async function () {\n${guard}\nreturn 'fell-through';\n})();`,
  );
  const result = await fn(
    (key, v) => out.sets.push({ key, v }),
    { expect: 'cfn-expect', pending: 'cfn-pending', log: 'cfn-log' },
    { pageWaitMs: 90000, pageReloadMs: 20000, tickMs: 15000 },
    (text) => out.logs.push(text),
    (key, text) => out.logs.push(text),
    (text, ctx) => out.pauses.push({ text, ctx }),
    {
      reload: () => {
        out.reloaded += 1;
      },
    },
    { id: 'r1', name: 'Turn Runtime' },
    { ref: 'c1', roleId: 'r1', roleName: 'Turn Runtime', runId: 'run-1', pageReloaded },
    page,
    watched,
    async (keys) => { out.flushes.push([...keys]); },
  );
  return { result, ...out };
};

// 8 секунд после перехода: ровно тот случай из журнала.
{
  const h = await runGuard({ watched: 8_000 });
  assert.equal(h.result, undefined, 'шаг завершается ожиданием, а не падением');
  assert.deepEqual(h.pauses, [], 'паузы нет: прошло слишком мало времени');
  assert.deepEqual(h.sets, [], 'ожидание не переписывается и не снимается');
  assert.equal(h.reloaded, 0, 'перезагрузка ещё не нужна');
  assert.match(h.logs[0], /ещё не отрисовалась/);
  assert.match(h.logs[0], /ответ не снимаю/);
}

// 40 секунд: страница всё ещё пуста — перечитываем её один раз.
{
  const h = await runGuard({ watched: 40_000 });
  assert.equal(h.reloaded, 1, 'страница перечитывается');
  assert.deepEqual(h.pauses, [], 'и это всё ещё не повод останавливать цикл');
  assert.equal(h.sets.length, 1, 'отметка о перезагрузке сохранена');
  assert.equal(h.sets[0].key, 'cfn-expect', 'пишется в ожидание, а не в очередь');
  assert.equal(h.sets[0].v.pageReloaded, true);
  assert.deepEqual(h.flushes, [['cfn-expect', 'cfn-log']], 'D-045: записи доведены до хранилища до перезагрузки');
}

// Перезагрузка одна: второй раз страницу не дёргаем.
{
  const h = await runGuard({ watched: 40_000, pageReloaded: true });
  assert.equal(h.reloaded, 0, 'повторной перезагрузки нет');
  assert.deepEqual(h.pauses, []);
}

// 100 секунд: страница так и не открылась — пауза про связь, а не про агента.
{
  const h = await runGuard({ watched: 100_000 });
  assert.equal(h.pauses.length, 1, 'пауза ставится');
  assert.equal(h.pauses[0].ctx.kind, 'offline', 'причина — связь, а не молчание исполнителя');
  assert.match(h.pauses[0].text, /не открылась/);
  assert.match(h.pauses[0].text, /не молчание агента/);
  assert.match(h.pauses[0].text, /Продолжить/);
  assert.equal(h.reloaded, 0, 'перед паузой страницу не перезагружаем');
  const keys = h.sets.map((s) => s.key);
  assert.deepEqual(keys, ['cfn-expect'], 'очередь не снимается: задание остаётся адресату');
  assert.equal(h.sets[0].v.seenAt, 0, 'наблюдение начинается заново после «Продолжить»');
  assert.equal(h.sets[0].v.readyAt, 0);
}

// ── 4. Сторож тишины требует выдержки после отрисовки ───────────────────────
assert.match(
  src,
  /if \(waited > C\.replyWaitMs && observed > C\.observeGraceMs && !fresh && !working\) \{/,
  'молчание считается потерей, только если страница уже отрисована',
);
assert.match(src, /const page = pageReady\(expect\);/, 'готовность страницы проверяется до сторожа');
assert.match(src, /const observed = Number\(expect\.readyAt\)/, 'выдержка считается от отрисовки');
assert.match(src, /expect\.seenPath !== path/, 'новый переход — новое наблюдение');
assert.match(
  src,
  /страница открыта и видна, ответа в ней нет/,
  'в паузе сказано, что страница была видна: загрузку за молчание больше не принимают',
);

console.log(
  'OK: relay 1.4.63 — недогруженная страница адресата не считается молчанием агента: ожидание и карточка на месте',
);
