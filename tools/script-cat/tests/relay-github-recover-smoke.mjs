// Проба 1.4.63: карточку, которую проверка ошибочно отправила в Rework, можно
// вернуть в Submitted — без второй выдачи и без повторной работы агента.
//
// 24.10 NAR-1.13 ушла в Rework при слитом PR #37: анонимный запрос к GitHub
// получил 404 от приватного репозитория и был прочитан как «PR нет». Работа
// лежала в main, а Координатор уже готовил повторную выдачу.
//
// Здесь проверяется:
//   • мерж подтверждён, карточка была в Rework — возвращается в Running, чтобы
//     ответ агента был дочитан кнопкой «Взять ответ», а не выдан дублем;
//   • на странице роли ответ берётся сразу, если адресат совпал;
//   • в «Ответ» записано, что это восстановление после ложного отказа;
//   • ложная запись «заявка о мерже не подтвердилась» опровергается в журнале;
//   • уже Submitted/Accepted только чинят журнал, Ready не трогается;
//   • если GitHub мерж не подтверждает — ни одной записи.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Функция на месте ────────────────────────────────────────────────────
const from = src.indexOf('  async function recoverLastClaim(adopt = true) {');
const to = src.indexOf('  let healedThisPage = false;');
assert.ok(from > 0 && to > from, 'recoverLastClaim на месте');
const block = src.slice(from, to);

// ── 2. Прогон с подставными Notion и GitHub ────────────────────────────────
async function run({ last, check, state = 'Rework', here = '', adopt = { ok: true } } = {}) {
  const store = new Map();
  if (last) store.set('cfn-last-result', last);
  const patched = [];
  const logged = [];
  const appended = [];
  const adopted = [];
  const fn = new Function(
    'K', 'GM_getValue', 'GM_setValue', 'verifyMergeClaim', 'ghToken', 'notion',
    'taskState', 'prUrl', 'nowIso', 'patch', 'log', 'gateway',
    'roleFromPath', 'adoptPageAnswer', 'norm', 'richText',
    `${block}; return recoverLastClaim;`,
  );
  const recover = fn(
    { lastResult: 'cfn-last-result' },
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    async () => check,
    () => 'ghp_secret',
    async () => ({ properties: {} }),
    () => state,
    (pr) => (String(pr || '').startsWith('http') ? String(pr) : String(pr || '') ? `https://github.com/example/relay-fixture/pull/${String(pr).replace(/^#/, '')}` : ''),
    () => '2026-10-24T19:50:00.000Z',
    async (id, props) => patched.push({ id, props }),
    (text, error, options) => logged.push({ text, error, options }),
    // Журнал передачи: сюда пишется опровержение ложной записи.
    async (action, fileId, payload) => {
      appended.push({ action, fileId, payload });
      return { ok: true };
    },
    () => here,
    async () => {
      adopted.push(1);
      return adopt;
    },
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    (value) => {
      const text = String(value == null ? '' : value);
      const parts = [];
      let at = 0;
      while (at < text.length && parts.length < 100) {
        let end = Math.min(text.length, at + 1900);
        const code = text.charCodeAt(end - 1);
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
        parts.push({ type: 'text', text: { content: text.slice(at, end) } });
        at = end;
      }
      return parts;
    },
  );
  const result = await recover();
  return { result, patched, store, logged, appended, adopted };
}

const last = {
  dispatch_id: '4016f0cf-5705-810e-83c2-ca18d8e9b66b',
  run_id: 'run-13',
  pr: 37,
  merged: true,
  task: 'NAR-1.13',
  logId: 'log-1',
  roleId: 'role-build',
  roleName: 'Build/Release',
  verdict: 'claim-rejected',
  result: { pr: 37, merged: true },
};

const mergedCheck = {
  status: 'merged',
  why: 'PR #37 слит 2026-10-24T16:16:10Z',
  pr: { html_url: 'https://github.com/example/relay-fixture/pull/37' },
};

// ── 3. Ложный отказ исправляется: Rework → Running ─────────────────────────
{
  const { result, patched, store, logged, appended } = await run({ last, check: mergedCheck });
  assert.equal(result.ok, true, 'восстановление удалось');
  assert.equal(patched.length, 1, 'запись в карточку ровно одна');
  assert.equal(patched[0].id, last.dispatch_id, 'правится та самая карточка');
  // Не Submitted, а Running: ответ агента ещё не прочитан, и карточка должна
  // дождаться «Взять ответ», иначе следующая выдача станет дублем.
  assert.equal(patched[0].props['Dispatch State'].select.name, 'Running', 'состояние снова Running');
  assert.match(patched[0].props['Ответ'].rich_text[0].text.content, /ложного отказа/i, 'причина названа');
  assert.equal(patched[0].props['PR'].url, 'https://github.com/example/relay-fixture/pull/37', 'PR в карточке');
  assert.equal(patched[0].props['Submitted At'], undefined, 'Submitted At не ставим: ответ ещё не принят');
  assert.equal(store.get('cfn-done:4016f0cf-5705-810e-83c2-ca18d8e9b66b:run-13'), false, 'отметка «обработано» снята');
  assert.equal(store.get('cfn-last-result').verdict, 'Running', 'память обновлена');
  assert.match(result.text, /Взять ответ/, 'сказано, как дочитать ответ');
  assert.ok(logged.some((l) => l.options && l.options.tone === 'ok'), 'в журнале зелёная строка');

  // Главное: Координатор читает журнал передачи, а не карточку. Ложная запись
  // «Заявка о мерже не подтвердилась» должна быть опровергнута там же.
  assert.equal(appended.length, 1, 'опровержение ушло в журнал передачи');
  assert.equal(appended[0].fileId, 'log-1', 'в тот самый журнал');
  assert.match(appended[0].payload.marker, /:recovered -->$/, 'отдельный маркер, не перезапись');
  assert.match(appended[0].payload.entry, /Проверка мержа исправлена/, 'заголовок опровержения');
  assert.match(appended[0].payload.entry, /GitHub подтвердил мерж/, 'в опровержении — факт мержа');
  assert.match(result.text, /Опровержение записано в журнал/, 'о записи сказано в ответе');
}

// ── 3б. Мы уже на странице исполнителя — ответ берём сразу ─────────────────
{
  const { result, adopted } = await run({ last, check: mergedCheck, here: 'role-build' });
  assert.equal(adopted.length, 1, 'ответ взят тем же ходом');
  assert.match(result.text, /Ответ прочитан/, 'сказано, что ответ прочитан');
}

// ── 4. Уже Submitted — нечего исправлять ───────────────────────────────────
{
  // 24.10 19:57: карточку уже вернули в Submitted, а журнал остался с ложной
  // записью — Координатор прочитал его и снова поставил Rework. Поэтому
  // журнал исправляется даже тогда, когда карточка уже в порядке.
  const { result, patched, appended } = await run({ last, check: mergedCheck, state: 'Submitted' });
  assert.equal(result.ok, true, 'это не ошибка');
  assert.equal(patched.length, 0, 'карточку не перезаписываем');
  assert.equal(appended.length, 1, 'но журнал всё равно исправлен');
  assert.match(result.text, /уже Submitted/, 'сказано, что карточка на месте');
}

// ── 5. Ready не трогаем: карточку могли выдать заново ──────────────────────
{
  const { result, patched, appended } = await run({ last, check: mergedCheck, state: 'Ready' });
  assert.equal(result.ok, false, 'решение оставлено Мастеру');
  assert.equal(patched.length, 0, 'Ready не перезаписана');
  assert.equal(appended.length, 0, 'и журнал не трогаем: карточку уже выдали заново');
  assert.match(result.text, /Мастер/, 'сказано, к кому идти');
}

// ── 6. GitHub мерж не подтверждает — ничего не пишем ───────────────────────
{
  const { result, patched, appended } = await run({ last, check: { status: 'open', why: 'PR #37 ещё открыт' } });
  assert.equal(result.ok, false, 'без подтверждения не восстанавливаем');
  assert.equal(patched.length, 0, 'Notion не тронут');
  assert.equal(appended.length, 0, 'и журнал не тронут');
  assert.match(result.text, /не подтверждает/, 'причина названа');
}

// ── 7. Нет запомненной выдачи ──────────────────────────────────────────────
{
  const { result, patched } = await run({ last: null, check: mergedCheck });
  assert.equal(result.ok, false, 'возвращать нечего');
  assert.equal(patched.length, 0, 'Notion не тронут');
}

// ── 8. Ответ, который скрипт не прочитал, можно взять со страницы ──────────
// Исполнять adoptPageAnswer без DOM нельзя (jsdom в пробах не используется),
// поэтому проверяются границы: маркер, состояние карточки, адресат и отметка.
const adoptFrom = src.indexOf('  async function adoptPageAnswer() {');
const adoptTo = src.indexOf('  /** Последняя проверка заявки');
assert.ok(adoptFrom > 0 && adoptTo > adoptFrom, 'adoptPageAnswer на месте');
const adopt = src.slice(adoptFrom, adoptTo);
assert.match(adopt, /CF_AGENT_RESULT/, 'берётся только сообщение с маркером выдачи');
assert.match(adopt, /state !== "Running"/, 'читается только карточка в Running');
assert.match(adopt, /cfn-done:\$\{ref\}:\$\{run\}/, 'обработанная выдача не читается второй раз');
assert.match(adopt, /Recipient Agent ID/, 'чужой ответ не берётся');
assert.match(adopt, /role\.fn === "Coordinator"/, 'ход Координатора этой кнопкой не читается');
assert.match(adopt, /GM_setValue\(K\.expect, expect\)/, 'ожидание восстанавливается');
assert.match(adopt, /await submitExecutor\(role, expect, true\)/, 'дальше — обычный путь, а не своя запись');
assert.match(adopt, /adopted: true/, 'видно, что выдача восстановлена, а не отправлена заново');

// ── 9. Версия ──────────────────────────────────────────────────────────────
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

// ── 10. Ложный отказ чинится сам, без клика Мастера ────────────────────────
{
  const from = src.indexOf('  let healedThisPage = false;');
  const to = src.indexOf('  /**\n   * Ответ уже в чате, а ожидания нет.');
  assert.ok(from > 0 && to > from, 'selfHealClaim на месте');
  const heal = src.slice(from, to);

  async function runHeal({ last, check }) {
    const store = new Map();
    if (last) store.set('cfn-last-result', last);
    const calls = [];
    const logged = [];
    const fn = new Function(
      'K', 'GM_getValue', 'GM_setValue', 'verifyMergeClaim', 'ghToken', 'log',
      'prLabelOf', 'recoverLastClaim',
      `${heal}\nreturn selfHealClaim;`,
    );
    const api = fn(
      { lastResult: 'cfn-last-result' },
      (k, d) => (store.has(k) ? store.get(k) : d),
      (k, v) => store.set(k, v),
      async () => check,
      () => 'ghp_secret',
      (text, error, options) => logged.push({ text, error, options }),
      (r) => `PR #${r.pr}`,
      async (adopt) => {
        calls.push({ adopt });
        return { ok: true, text: 'vozvrat' };
      },
    );
    await api();
    await api();
    return { calls, logged };
  }

  const bad = { ...last, verdict: 'claim-rejected' };

  const merged1 = await runHeal({ last: bad, check: mergedCheck });
  assert.equal(merged1.calls.length, 1, 'возврат сработал один раз, второй проход молчит');
  assert.equal(merged1.calls[0].adopt, false, 'ответ сам не берём: его читают кнопкой на странице роли');
  assert.ok(merged1.logged.some((l) => /Проверка ошиблась/.test(l.text)), 'сказано, что проверка ошиблась');

  const notMerged = await runHeal({ last: bad, check: { status: 'open', why: 'PR #37 ещё открыт' } });
  assert.equal(notMerged.calls.length, 0, 'пока мерж не подтверждён — ничего не трогаем');

  const fine = await runHeal({ last: { ...last, verdict: 'Submitted' }, check: mergedCheck });
  assert.equal(fine.calls.length, 0, 'успешную выдачу не перепроверяем');

  const healed = await runHeal({ last: { ...bad, recoveredAt: Date.now() }, check: mergedCheck });
  assert.equal(healed.calls.length, 0, 'уже исправленное не чиним повторно');
}

console.log('OK: relay 1.4.63 — ложный отказ исправляется сам, в журнале и в карточке');
