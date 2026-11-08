// Проба 1.14.3: «временный сбой» вместо дефекта кода, и потерянный ход
// Координатора при сбое после получения ответа.
//
// Что видел Мастер 08.11 (журнал 00:43–01:01):
//
//   00:49:25 Маркер Координатора найден: дальше «Spec Auditor» (turn a1700d6a…)
//   00:49:25 ПАУЗА: Цикл остановлен. Шаг прервался на записи в Notion. …
//            Технически: draft is not defined
//   00:49:37 временный сбой транспорта или сети: продолжаю сам (1 из 2)
//   00:50:24 План Координатора запрошен (… 2 Ready, 6 Draft …)
//   …
//   01:00:55 то же самое второй раз, «draft is not defined»
//
// Три отдельные поломки, и ни одна не была «сбоем сети»:
//   1. `draft` в шаге Координатора не был объявлен — ReferenceError на гейте
//      состава D-075. Ответ Координатора при этом уже получен.
//   2. ReferenceError попадал в класс `momentary` («временный сбой»), потому что
//      вид паузы у общего catch — `error`, а он в таблице моментов. Повтор
//      отправки дефект кода не лечит: цикл дважды просил новый план.
//   3. Ожидание хода снималось ДО применения решения. После сбоя «Продолжить»
//      нечего было перечитывать, следующий «Шаг» спрашивал новый план — и
//      задание уходило Координатору второй раз. Отсюда «+ ещё раз отправляет
//      сообщение координатору» в жалобе Мастера.
//
// Проверяется поведение, а не строки: шаг Координатора исполняется на моделях,
// восстановление хода — на хранилище и чате-заглушке.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healApi } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `не найден блок ${String(from).slice(0, 48)}`);
  return src.slice(a, b);
};

// ── 1. Дефект кода — не «временный сбой» ───────────────────────────────────
// Настоящая строка из журнала Мастера.
{
  const v = healApi.classifyPause('error', 'Цикл остановлен. Шаг прервался на записи в Notion.\nТехнически: draft is not defined');
  assert.equal(v.cls, 'transport', 'ReferenceError — поломка транспорта, а не сбой сети');
  assert.equal(v.route, 'maintainer', 'такой сбой разбирает Maintainer: у него дифф и проба');
  assert.equal(v.unknown, false, 'причина распознана, «наугад» не помечается');
  assert.match(v.why, /дефект сборки/, 'причина названа своим именем');
  assert.equal(healApi.decideHeal(v, { retries: 0 }, { healRetryMax: 2 }).action, 'maintainer',
    'повтор отправки не назначается: дефект кода повтором не лечится');

  for (const text of [
    'TypeError: Cannot read properties of undefined (reading \'id\')',
    'Cannot access \'x\' before initialization',
    'pause is not a function',
    'SyntaxError: Unexpected token',
  ]) {
    assert.equal(healApi.classifyPause('error', text).cls, 'transport', `«${text}» — дефект кода`);
  }
  // Настоящий обрыв остаётся momentary: правило не должно съесть его собой.
  const net = healApi.classifyPause('error', 'Notion не ответил: сеть или блокировка запроса.');
  assert.equal(net.cls, 'momentary', 'сеть по-прежнему повторяется сама');
  assert.equal(healApi.classifyPause('nav', 'Не удалось открыть страницу').cls, 'momentary', 'навигация — момент');
  assert.equal(healApi.classifyPause('captcha', 'капча: без человека сообщение не уйдёт').cls, 'arena', 'капча — Arena');
}

// ── 2. `draft` объявлена: гейт состава D-075 больше не падает ──────────────
{
  const step = src.slice(src.indexOf('  async function coordinatorStep('), src.indexOf('  async function requestPlan('));
  assert.ok(step.length > 5000, 'шаг Координатора на месте');
  // Каждое имя, которое шаг читает, должно быть объявлено в нём: иначе снова
  // ReferenceError в самом дорогом месте — после получения ответа.
  const declared = new Set([...step.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const name of ['submitted', 'running', 'ready', 'rework', 'draft']) {
    assert.ok(declared.has(name), `«${name}» объявлена в шаге Координатора`);
  }
  assert.match(step, /const draft = await tasks\("Draft", mission\)/, 'черновики читаются, а не выдумываются');
  assert.match(step, /\.\.\.\(draft \|\| \[\]\)/, 'гейт состава видит черновики');
}

// ── 3. Снимок хода: ожидание возвращается, ответ не теряется ───────────────
// Исполняется настоящий фрагмент catch из 28-cycle.js.
{
  const recover = cut('      let recovered = false;', '      const stillWaiting =');
  const store = new Map();
  const logs = [];
  const get = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
  const set = (key, value) => store.set(key, value);
  const K = { expect: 'cfn-expect', planRecover: 'cfn-plan-recover' };
  const MISSION = '40c6f0cf-5705-81ae-ab6c-efac6bad62f0';

  const runRecover = (messages = []) => new Function(
    'GM_getValue', 'GM_setValue', 'K', 'messagesAfter', 'parseMarker', 'log', 'dbg', 'Date',
    `return async function() {
      ${recover}
      return recovered;
    }`,
  )(
    get, set, K,
    () => messages,
    (raw, name) => (String(raw).includes(name) ? { next: 'Spec Auditor' } : null),
    (text, loud, opts) => logs.push({ text, loud, opts }),
    () => {},
    Date,
  );

  // Сбой сразу после маркера: ожидание снято, снимок лежит, ответ в чате есть.
  const planExpect = { kind: 'plan', ref: MISSION, turnId: 'a1700d6a-c693-474b-a468-a95a6d5c3c16', watermark: 'before', sentAt: 1 };
  const reply = { raw: 'CF_COORDINATOR_RESULT {"next":"Spec Auditor"}', id: 'm1' };
  store.clear();
  set(K.planRecover, { expect: planExpect, missionId: MISSION, at: Date.now() });
  set('cfn-plan-at', Date.now());
  assert.equal(await runRecover([reply])(), true, 'ход восстановлен');
  assert.deepEqual(get(K.expect, null), planExpect, 'ожидание вернулось к прежнему ходу, а не к пустому');
  assert.equal(get(K.planRecover, null), null, 'снимок одноразовый');
  assert.equal(get('cfn-plan-at', 0), 0, 'троттлинг снят: ответ уже в чате');
  assert.match(logs.at(-1).text, /ожидание хода восстановлено/, 'Мастеру сказано, что ход цел');
  assert.match(logs.at(-1).text, /второй раз задание не уйдёт/, 'и что второй отправки не будет');

  // Ответа в чате нет — снимок не применяется: иначе вернули бы чужое ожидание.
  store.clear();
  set(K.planRecover, { expect: planExpect, missionId: MISSION, at: Date.now() });
  assert.equal(await runRecover([])(), false, 'без маркера в чате ход не восстанавливается');
  assert.equal(get(K.expect, null), null, 'ожидание не выдумано');

  // Старый снимок — не ход: истёк срок.
  store.clear();
  set(K.planRecover, { expect: planExpect, missionId: MISSION, at: Date.now() - 20 * 60_000 });
  assert.equal(await runRecover([reply])(), false, 'снимок старше 15 минут не восстанавливается');

  // Живое ожидание главнее снимка.
  store.clear();
  const live = { kind: 'dispatch', ref: 'card-1', sentAt: 5 };
  set(K.expect, live);
  set(K.planRecover, { expect: planExpect, missionId: MISSION, at: Date.now() });
  assert.equal(await runRecover([reply])(), false, 'при живом ожидании снимок не трогается');
  assert.deepEqual(get(K.expect, null), live, 'живое ожидание не перезаписано');

  // Снимка нет — ведём себя как раньше.
  store.clear();
  assert.equal(await runRecover([reply])(), false, 'без снимка восстанавливать нечего');
}

// ── 4. Снимок кладётся ровно там, где снимается ожидание ──────────────────
{
  const step = src.slice(src.indexOf('  async function coordinatorStep('), src.indexOf('  async function requestPlan('));
  // Отсчёт — момент, когда ответ Координатора найден в чате: до него снимок
  // не нужен (ответа нет), после него ожидание уже снимается.
  const marker = step.indexOf('const decision = messagesAfter(expect.watermark)');
  const snap = step.indexOf('GM_setValue(K.planRecover,');
  const clear = step.indexOf('GM_setValue(K.expect, null);', snap);
  assert.ok(marker > 0 && snap > marker, 'снимок кладётся после того, как маркер найден');
  assert.ok(snap < clear, 'и до снятия ожидания — иначе ход уже потерян');
  assert.match(step.slice(snap, clear), /\bexpect\b/, 'в снимок идёт само ожидание');
  assert.match(step.slice(snap, clear), /missionId/, 'и миссия, к которой относится ход');
  // Новый план отменяет снимок прошлого хода.
  const plan = src.slice(src.indexOf('  async function requestPlan('), src.indexOf('\n  }\n', src.indexOf('  async function requestPlan(')));
  assert.match(plan, /GM_setValue\(K\.planRecover, null\)/, 'новый план снимает снимок');
  // ↺ снимает его вместе с очередью и ожиданием.
  const reset = src.slice(src.indexOf('  function resetState()'), src.indexOf('  /** После обновления ни очередь'));
  assert.match(reset, /GM_setValue\(K\.planRecover, null\)/, '↺ снимает снимок: снятое Мастером не возвращается');
}

// ── 5. Текст паузы не обещает того, чего нет ──────────────────────────────
{
  const cycle = readFileSync(join(srcDir, '28-cycle.js'), 'utf8');
  const pauseText = cycle.slice(cycle.indexOf('      const stillWaiting ='), cycle.indexOf('      } finally {'));
  assert.match(pauseText, /recovered\s*\?/, 'у паузы три разных исхода, а не один');
  assert.match(pauseText, /stillWaiting\s*\?/, 'живое ожидание названо отдельно');
  assert.match(pauseText, /«Продолжить» его не/, 'и честно сказано, когда перечитывать нечего');
  assert.match(pauseText, /перечитает ответ, второй раз задание не уйдёт/, 'восстановленный ход описан по делу');
  // Прежняя безусловная фраза ушла: она была неправдой ровно в этом сбое.
  assert.doesNotMatch(cycle, /`после «Продолжить» скрипт перечитает ответ\.\\nТехнически/, 'безусловного обещания больше нет');
}
