// Проба 1.4.44: Continue после мержа по маркеру.
//
// 24.10 в 15:46 ScriptCat принял мерж PR #35 по маркеру Kernel и сразу ушёл к
// Координатору. Continue на странице агента не была нажата — Мастер жал её
// руками. Причина: с 1.4.39 ветка «мерж заявлен маркером» выходила немедленно,
// хотя Arena дорисовывает бейдж Merged и Continue уже после того, как узнала о
// мерже.
//
// Здесь проверяется:
//   • Continue, появившаяся с задержкой, нажимается (finishMerge);
//   • если её нет вовсе — шаг не висит, но и не молчит: в журнале сказано,
//     что кнопка не появилась и что делать дальше;
//   • кнопки Create/Merge по-прежнему не нажимаются;
//   • обе ветки ensureMerged идут через claimMerge, а не выходят сами.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Исходник claimMerge ─────────────────────────────────────────────────
const claimFrom = src.indexOf('  async function claimMerge(');
const claimTo = src.indexOf('  /**\n   * PR закрыт.');
assert.ok(claimFrom > 0 && claimTo > claimFrom, 'claimMerge на месте');
const claimBlock = src.slice(claimFrom, claimTo);

function make({ mergedAfter = 0, continueAfter = 0 } = {}) {
  const logs = [];
  const calls = { finishMerge: 0, merge: 0, create: 0 };
  const store = new Map();
  let reads = 0;
  const fn = new Function(
    'K', 'C', 'GM_getValue', 'GM_setValue', 'log', 'waitFor', 'mergedFlag',
    'continueButton', 'finishMerge', 'prLabelOf', 'patience', 'verifyMergeClaim', 'ghToken', 'dispatchTarget',
    `${claimBlock}; return claimMerge;`,
  );
  const claimMerge = fn(
    { merged: 'cfn-merged:' },
    { mergeGraceMs: 200 },
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    (t, e) => logs.push({ t, e }),
    async (check, timeoutMs, stepMs = 20) => {
      const until = Date.now() + (Number(timeoutMs) || 0);
      for (;;) {
        reads += 1;
        const value = check();
        if (value) return value;
        if (Date.now() >= until) return null;
        await new Promise((r) => setTimeout(r, stepMs));
      }
    },
    () => (mergedAfter && reads >= mergedAfter ? { aria: 'merged' } : null),
    () => (continueAfter && reads >= continueAfter ? { click() {} } : null),
    async () => {
      calls.finishMerge += 1;
      store.set('cfn-merged:card-1', true);
      return 'merged';
    },
    (r) => {
      const pr = String((r && r.pr) ?? '').trim();
      return !pr ? 'PR' : /^https?:/i.test(pr) ? pr : `PR #${pr.replace(/^#/, '')}`;
    },
    (ms) => ms,
    // Заявка уже подтверждена GitHub — проба про Continue, а не про проверку.
    async () => ({ status: 'merged', why: 'PR #35 слит' }),
    // Токен нужен проверке; в пробе он не ходит в сеть.
    () => 'ghp_test',
    // dispatchTarget: ожидание выдачи в этой пробии не развёрнуто — цель из глобального конфига.
    () => null,
  );
  return { claimMerge, logs, calls, store };
}

// ── 2. Continue появилась с задержкой: она нажимается ──────────────────────
{
  const { claimMerge, calls, store, logs } = make({ continueAfter: 2 });
  const state = await claimMerge({ id: 'card-1' }, { pr: 35, merged: true }, 'cfn-merged:card-1', ' (PR-интерфейс живёт на странице PR)');
  assert.equal(state, 'merged', 'мерж доведён до конца, а не принят «на слово»');
  assert.equal(calls.finishMerge, 1, 'Continue нажата через finishMerge');
  assert.equal(store.get('cfn-merged:card-1'), true, 'мерж запомнен');
  assert.equal(logs.length, 0, 'лишних строк в журнале нет: о Continue скажет finishMerge');
}

// ── 3. Бейдж Merged без Continue: тоже finishMerge ─────────────────────────
{
  const { claimMerge, calls } = make({ mergedAfter: 2 });
  const state = await claimMerge({ id: 'card-1' }, { pr: 35, merged: true }, 'cfn-merged:card-1');
  assert.equal(state, 'merged', 'бейдж Merged считается мержем');
  assert.equal(calls.finishMerge, 1, 'дальше работает общий путь мержа');
}

// ── 4. Не появилось ничего: шаг не висит, но и не молчит ───────────────────
{
  const { claimMerge, calls, store, logs } = make();
  const state = await claimMerge({ id: 'card-1' }, { pr: 35, merged: true }, 'cfn-merged:card-1', ' (PR-интерфейс живёт на странице PR)');
  assert.equal(state, 'claimed', 'решение принимает маркер');
  assert.equal(calls.finishMerge, 0, 'finishMerge без бейджа и Continue не вызывается');
  assert.equal(store.get('cfn-merged:card-1'), true, 'мерж всё равно запомнен: к нему не возвращаемся');
  assert.equal(logs.length, 1, 'ровно одна строка в журнале');
  assert.match(logs[0].t, /PR #35 слит: принято по маркеру агента/, 'видно, на чём основано решение');
  assert.match(logs[0].t, /Бейджа Merged и Continue на странице нет/, 'сказано, чего не появилось');
  assert.match(logs[0].t, /нажмите её сами/, 'Мастер знает, что делать, если кнопка появится позже');
  assert.equal(logs[0].e, undefined, 'это не ошибка: в красный журнал не красим');
}

// ── 5. Обе ветки ensureMerged идут через claimMerge ────────────────────────
const ensureFrom = src.indexOf('  async function ensureMerged(task, result) {');
const ensureTo = src.indexOf('  async function finishMerge(');
const ensureBlock = src.slice(ensureFrom, ensureTo);
assert.equal(
  (ensureBlock.match(/return claimMerge\(/g) || []).length,
  2,
  'и «PR-интерфейса нет», и «интерфейс есть, но мерж заявлен» — через claimMerge',
);
assert.doesNotMatch(ensureBlock, /GM_setValue\(key, true\);\s*\n\s*return "claimed";/, 'немедленного выхода больше нет');
assert.match(claimBlock, /mergedFlag\(\) \|\| continueButton\(\)/, 'ждём и бейдж, и Continue');

console.log('OK: relay 1.4.63 — при мерже по маркеру Continue ждётся и нажимается, а не теряется');
