// D-040 (05.11.2026): маркер есть, но без dispatch_id/run_id — напоминаем, а не зовём Мастера.
//
// Боевой инцидент K-21 (synapse): Executor Core выполнил работу и слил PR #8,
// но финальный маркер прислал как
//   CF_AGENT_RESULT: {"task":"K-21","scope":"…","check":0,"merged":true,"pr":"…","report":"…","logs":"…"}
// — с двоеточием, с «task» вместо dispatch_id/run_id и без «status». Транспорт
// верно отказался подтверждать ответ (защита от зачёта чужой/прошлой попытки),
// но сразу ушёл в паузу, минуя лестницу напоминаний. Работа сделана, а цикл
// встал и потребовал ручного вмешательства.
//
// Правило D-040: различаем «ID выдачи нет» (формат-дефект → напоминание с
// точными ID через markerMissing("ids"), до markerReminders раз) и «ID чужие/
// битые» (возможно, ответ прошлой выдачи → сразу пауза). Значения ID не
// подменяются ни в одном случае; запись в Notion по неверному ID не идёт.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, reminderRequest, UUID } from '../tests/helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const V = assertUserscriptVersionContract(src)[1];

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `не найден блок ${from}`);
  return src.slice(a, b);
};

// ── 1. dispatchIdState: match / missing / conflict на боевом маркере ───────
const ids = cut('  const isUuid = ', '  async function notion(');
const stateFn = cut('  function dispatchIdState(', '  async function submitExecutor(');
const { dispatchIdState } = new Function(
  'norm',
  `${ids}\n${stateFn}\nreturn { dispatchIdState };`,
)((x) => String(x || '').replace(/-/g, '').toLowerCase());

const CARD = '40f6f0cf-5705-819d-9d69-d72e71734f83';
const RUN = 'e79c6297-2649-471c-b2ae-8e2c42c9a327';
const OTHER = '01a1ac15-c3ed-79c4-8eca-feaa2a8e5f1f';
const expect = { ref: CARD, runId: RUN };

// Точная форма маркера K-21: работа сделана, но ID выдачи не скопированы.
const k21 = {
  task: 'K-21', scope: 'K-21 only', check: 0, merged: true,
  pr: 'https://github.com/Creative36711/synapse/pull/8',
  merge_sha: '654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1',
  report: 'drive/report', logs: 'drive/logs',
};
assert.equal(dispatchIdState(k21, expect), 'missing', 'K-21: ID нет — формат-дефект, не чужой ответ');
assert.equal(dispatchIdState({ dispatch_id: CARD, run_id: RUN }, expect), 'match', 'полное совпадение');
assert.equal(dispatchIdState({ dispatch: CARD, run: RUN }, expect), 'match', 'короткие синонимы — то же самое');
assert.equal(dispatchIdState({ dispatch_id: CARD, run_id: '' }, expect), 'missing', 'run пуст — нет ID');
assert.equal(dispatchIdState({ dispatch_id: '', run_id: RUN }, expect), 'missing', 'dispatch пуст — нет ID');
assert.equal(dispatchIdState({ status: 'submitted' }, expect), 'missing', 'маркер вовсе без ID');
assert.equal(dispatchIdState({ dispatch_id: OTHER, run_id: RUN }, expect), 'conflict', 'чужой dispatch — пауза');
assert.equal(dispatchIdState({ dispatch_id: CARD, run_id: OTHER }, expect), 'conflict', 'чужой run — пауза');
assert.equal(dispatchIdState({ dispatch_id: CARD, dispatch: OTHER, run_id: RUN }, expect), 'conflict', 'противоречащий синоним — пауза');
assert.equal(dispatchIdState({ dispatch_id: 'битый-id', run_id: RUN }, expect), 'conflict', 'битый dispatch — пауза');

// ── 2. submitExecutor: нет ID → напоминание, чужие ID → пауза ──────────────
const submit = src.slice(src.indexOf('  async function submitExecutor('), src.indexOf('// ───────────────────────────── ожидание'));
assert.ok(submit.length > 0, 'submitExecutor на месте');
assert.match(submit, /dispatchIdState\(hit\.result, expect\) === "missing"/, 'ветка mismatch классифицирует ID');
assert.match(submit, /return markerMissing\(role, expect, "CF_AGENT_RESULT", manual, "ids"\)/, 'нет ID — напоминание с ID, а не пауза');
assert.match(submit, /kind: "marker-mismatch"/, 'чужие/битые ID по-прежнему пауза');
// Напоминание идёт после сохранения копии ответа — работа не теряется.
assert.ok(submit.indexOf('retainRejectedResult(expect, "dispatch-identity"') < submit.indexOf('dispatchIdState(hit.result'), 'копия ответа сохраняется до классификации');

// ── 3. reminder.marker: why="ids" просит повторить маркер с ID ─────────────
assert.match(src, /const ids = c\.reminder\?\.why === "ids"/, 'блок reminder.marker знает why=ids');
const reminder = PromptCompiler.compile(reminderRequest('Executor', 'CF_AGENT_RESULT', {
  reminder: { markerName: 'CF_AGENT_RESULT', attempt: 1, max: 2, why: 'ids' },
}));
assert.equal(reminder.ok, true, `reminder why=ids компилируется: ${reminder.error?.detail || ''}`);
assert.match(reminder.text, /Скопируй ID из строки ниже; работу не повторяй/, 'напоминание просит повторить маркер, не переделывать ход');
assert.match(reminder.text, /нет dispatch_id\/run_id этой выдачи либо они иные/, 'D-054: why=ids покрывает и отсутствие ID, и опечатку в них');
assert.ok(reminder.text.includes(UUID.dispatch), 'в напоминании есть точный dispatch_id');
assert.ok(reminder.text.includes(UUID.run), 'в напоминании есть точный run_id');
assert.ok(reminder.text.length <= 900, `reminder why=ids в тотал-бюджете 900 (${reminder.text.length})`);

console.log(
  `OK: relay ${V} — D-040: маркер без dispatch_id/run_id напоминает с точными ID (лестница markerReminders), ` +
    'чужие/битые ID — пауза, значения ID не подменяются',
);
