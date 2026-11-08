// Проба 1.4.80: миссию закрывает приёмка, а не Координатор.
//
// Мастер (28.10): «цикл должен останавливаться только когда миссия точно
// закрыта». До этой версии `next: "done"` сам ставил «Завершена» и гасил
// автоцикл: проверялось только «в очереди ноль карточек», то есть «всё ли
// выдано», а не «получилось ли то, о чём миссия». Ошибку видел человек и
// только если открывал «Итог».
//
// Теперь `done` — передача на приёмку. Роль с функцией Reviewer читает оракул,
// «Итог» и принятые карточки и отвечает маркером CF_REVIEW_RESULT:
//   accept → миссия «Завершена», автоцикл выключен, громкий пуш;
//   rework → «Возвращена», круг +1, замечания в карточку миссии, ход
//            Координатору.
// Доработок больше `reworkLimit` не бывает: следующий возврат останавливает
// цикл и зовёт Мастера — приёмка, которая возвращает бесконечно, это не
// контроль, а вечный цикл.
//
// Проверяется:
//   • ветка done больше не закрывает миссию и не гасит автоцикл сама;
//   • промпт приёмки: оракул, «Итог», принятые карточки, маркер, предел;
//   • accept закрывает миссию и объявляет конец цикла один раз;
//   • rework пишет «Возвращена», «Круг», «Замечания» и возвращает ход;
//   • возврат без замечаний и четвёртый возврат — пауза, а не работа;
//   • пустая приёмка (нет роли Reviewer) не выдумывает вердикт, но говорит
//     об этом вслух;
//   • ход приёмки разбирается общим parseMarker, а не своим разбором строки.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
import { promptShim } from './helpers/prompt-shim.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

// ── 1. Предел доработок и роль приёмки ─────────────────────────────────────
assert.match(src, /reworkLimit: 3,/, 'предел доработок в конфиге');
assert.match(
  src,
  /const reviewerRole = async \(\) => \(await roles\(\)\)\.find\(\(r\) => r\.fn === "Reviewer"\) \|\| null;/,
  'приёмка ищется по функции Reviewer, а не по имени роли',
);
{
  const { PromptCompiler, reviewRequest } = await import('./helpers/prompt-env.mjs');
  const r = PromptCompiler.compile(reviewRequest());
  assert.ok(r.profileId === 'reviewer.mission' && r.ruleIds.includes('R-VERIFY-GITHUB'), 'у приёмки свой профиль и правила');
}
assert.match(src, /if \(role\.fn === "Reviewer"\) \{/, 'у приёмки своё правило поведения');

// ── 2. Ветка done: передача на приёмку вместо закрытия ─────────────────────
const doneBranch = sliceBetween('      if (decision.next === "done") {', '      const route = decisionRoute(');
assert.match(doneBranch, /return startReview\(mission, fresh\);/, 'done передаёт миссию приёмке');
assert.doesNotMatch(doneBranch, /"Состояние": \{ select: \{ name: "Завершена" \} \}/, 'done больше не ставит «Завершена»');
assert.doesNotMatch(doneBranch, /autoSet\(false\)/, 'done больше не гасит автоцикл');
assert.doesNotMatch(doneBranch, /Миссия завершена Координатором/, 'прежней формулировки закрытия нет');
assert.match(doneBranch, /done-with-open/, 'живые карточки по-прежнему держат миссию открытой');
assert.match(doneBranch, /done-with-remarks/, 'возврат без разбора замечаний по-прежнему держит миссию открытой');
assert.match(
  src,
  /else if \(me\.fn === "Reviewer" && expect\) \{[\s\S]{0,320}?expect\.kind === "review"\) await reviewStep\(me, expect, fromToggle\);/,
  'ход приёмки подключён к тику',
);
assert.match(src, /parseMarker\(m\.raw, "CF_REVIEW_RESULT"\)/, 'маркер приёмки читается общим разбором');
{
  const { PromptCompiler, reminderRequest } = await import('./helpers/prompt-env.mjs');
  const rem = PromptCompiler.compile(reminderRequest('Reviewer', 'CF_REVIEW_RESULT')).text;
  assert.match(rem, /CF_REVIEW_RESULT/, 'напоминание о формате говорит на языке приёмки');
}

// ── 3. Сам блок приёмки ────────────────────────────────────────────────────
const block = sliceBetween('  const reviewerRole = async () =>', '  async function dispatchTask(');

const store = new Map();
const calls = { sends: [], patches: [], plans: [], pauses: [], logs: [], logOptions: [], autos: [] };

const api = new Function(
  'C',
  'K',
  'rt',
  'norm',
  'uid',
  'nowIso',
  'firstLine',
  'oneLine',
  'roles',
  'patch',
  'log',
  'pause',
  'autoSet',
  'GM_getValue',
  'GM_setValue',
  'tasks',
  'sendToRole',
  'requestPlan',
  'queueOf',
  'missionBindingBlockers',
  'notion',
  'richText',
  'taskTitle',
  'taskRole',
  'technicalInfo',
  'roleContext',
  'activeMission',
  'messagesAfter',
  'parseMarker',
  'markerMissing', 'isUuid', 'retainRejectedResult',
  `${promptShim}
${block}
   return { reviewerRole, missionRound, reviewCards, reviewPrompt, startReview, closeMission, returnMission, reviewStep };`,
)(
  { reworkLimit: 3, pageUrl: 'https://app.notion.com/p/Relay', markerReminders: 2 },
  { expect: 'cfn-expect' },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  () => 'turn-new',
  () => '2026-10-28T12:00:00.000Z',
  (text, max = 220) => String(text || '').split('\n')[0].slice(0, max),
  (value, max) => String(value || '').slice(0, max),
  async () => api.__roles,
  async (id, props) => {
    calls.patches.push({ id, props });
    return {};
  },
  (text, error, options) => {
    calls.logs.push(String(text));
    calls.logOptions.push({ text: String(text), error, options, autoAtLog: calls.autos.at(-1) });
  },
  (reason, context = {}) => calls.pauses.push({ reason: String(reason), kind: context.kind }),
  (on) => calls.autos.push(on),
  (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  (key, value) => store.set(key, value),
  async (state) => (state === 'Accepted' ? api.__accepted : []),
  async (role, text, kind, ref, extra = {}) => {
    calls.sends.push({ role: role.name, text, kind, ref, extra });
    return true;
  },
  async (mission, role, queue, note, opts = {}) => {
    calls.plans.push({ role: role.name, note, opts });
    return true;
  },
  async () => ({ submitted: [], running: [], ready: [], rework: [], draft: [], summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 0 Draft' }),
  async () => [],
  async () => ({ properties: {} }),
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
  (card) => (card?.properties?.['Запрос']?.title || []).map((x) => x.text?.content || x.plain_text || '').join(''),
  (card) => card?.properties?.['Кому']?.select?.name || '',
  () => 'ТЕХНИКА',
  (role) => `Ты — ${role.name}.`,
  async () => api.__mission,
  () => api.__messages,
  (raw, name) => (raw && raw.includes(name) ? JSON.parse(raw.slice(raw.indexOf('{'))) : null),
  async () => false, (value) => Boolean(value), () => true,
);

// reviewStep вызывается только при живом ожидании того же хода.
const rawReviewStep = api.reviewStep;
api.reviewStep = async (role, expect, ...rest) => {
  const live = {turnId:'t', ...expect};
  store.set('cfn-expect', live);
  return rawReviewStep(role, live, ...rest);
};

const mission = (over = {}) => ({
  id: over.id || 'mission-1',
  properties: {
    'Миссия': { title: [{ plain_text: over.name || 'NAR-5 · Контракты' }] },
    'ТЗ URL': { url: 'https://github.com/example/relay-fixture/blob/main/docs/agents/tz-nar-5.md' },
    'Итог': { rich_text: [{ plain_text: over.result ?? 'Сделано 12 карточек, npm run check:contracts = 0.' }] },
    'Круг': { number: over.round ?? 0 },
    'Возвращена': { date: over.returned ? { start: over.returned } : null },
  },
});

const card = (id, role, extra = {}) => ({
  id,
  properties: {
    'Запрос': { title: [{ text: { content: `${id} · работа` } }] },
    'Кому': { select: { name: role } },
    'Ответ': { rich_text: extra.answer ? [{ plain_text: extra.answer }] : [] },
    'PR': { url: extra.pr ?? null },
  },
});

const reviewer = { id: 'rev-1', name: 'Warden', url: 'https://arena.ai/agent/01a159d9-8b86-75cd-8e68-60987ec1e953', fn: 'Reviewer' };
const coordinator = { id: 'coord-1', name: 'Coordinator', url: 'https://arena.ai/agent/coord', fn: 'Coordinator' };

const reset = () => {
  store.clear();
  calls.sends.length = 0;
  calls.patches.length = 0;
  calls.plans.length = 0;
  calls.pauses.length = 0;
  calls.logs.length = 0;
  calls.logOptions.length = 0;
  calls.autos.length = 0;
};

// ── 4. Промпт приёмки: оракул, очередь, итог, маркер, предел ────────────────
{
  const m = mission({ round: 1 });
  api.__accepted = [card('5.1', 'Architect', { answer: 'ADR принят', pr: 'https://github.com/x/y/pull/1' }), card('5.2', 'Tools')];
  const text = api.reviewPrompt(m, reviewer, 'turn-9', 1, { summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 2 Draft' }, api.__accepted).text;
  assert.match(text, /Миссия: NAR-5 · Контракты/, 'миссия в промпте');
  assert.match(text, /ТЗ: https:\/\/github\.com\/example\/relay-fixture\/blob\/main\/docs\/agents\/tz-nar-5\.md/, 'оракул назван ссылкой');
  assert.match(text, /Круг: 1 \(предел доработок 3\)/, 'круг и предел видны');
  assert.match(text, /0 Submitted, 0 Running, 0 Ready, 0 Rework, 2 Draft/, 'очередь видна');
  assert.match(text, /5\.1 · Architect · https:\/\/github\.com\/x\/y\/pull\/1 · ответ: ADR принят/, 'принятая карточка с ответом и PR');
  assert.match(text, /ИТОГ МИССИИ:\nСделано 12 карточек/, '«Итог» в промпте');
  assert.match(text, /CF_REVIEW_RESULT \{"mission_id":"mission-1","turn_id":"turn-9","verdict":"accept"/, 'маркер accept');
  assert.match(text, /"verdict":"rework","remarks"/, 'маркер rework');
  assert.match(text, /Предел доработок 3/, 'предел назван в промпте приёмки');
  assert.match(text, /приёмка \(Reviewer\)/, 'роль приёмки названа');

  const empty = api.reviewPrompt(mission({ result: '' }), reviewer, 't', 0, { summary: '—' }, []).text;
  assert.match(empty, /«Итог» пусто — повод не принимать/, 'пустой «Итог» назван поводом');
  assert.match(empty, /Принятых карточек нет/, 'пустая приёмка не выглядит как работа');
}

// ── 5. startReview: передача хода приёмке ──────────────────────────────────
{
  reset();
  api.__roles = [coordinator, reviewer];
  api.__accepted = [card('5.1', 'Architect')];
  const m = mission();
  const done = await api.startReview(m, { summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 0 Draft' });
  assert.equal(done, true, 'ход уходит приёмке');
  assert.equal(calls.sends.length, 1, 'ровно одна отправка');
  assert.equal(calls.sends[0].role, 'Warden', 'адресат — приёмка');
  assert.equal(calls.sends[0].kind, 'review', 'вид ожидания — review');
  assert.equal(calls.sends[0].ref, 'mission-1', 'ожидание привязано к миссии');
  assert.equal(calls.sends[0].extra.missionId, 'mission-1', 'missionId в ожидании');
  assert.equal(calls.sends[0].extra.turnId, 'turn-new', 'turnId в ожидании');
  assert.equal(calls.patches.length, 0, 'миссия не закрыта до вердикта');
  assert.equal(calls.autos.length, 0, 'автоцикл не выключен до вердикта');
}

// ── 6. Приёмки нет: миссия не закрывается «за компанию» ────────────────────
{
  reset();
  api.__roles = [coordinator];
  api.__accepted = [];
  const done = await api.startReview(mission(), { summary: '—' });
  assert.equal(done, true, 'ход заканчивается остановкой');
  assert.equal(calls.sends.length, 0, 'никому не отправлено');
  assert.equal(calls.patches.length, 0, 'миссия НЕ закрыта: без вердикта приёмки закрывать нельзя');
  assert.equal(calls.pauses.length, 1, 'цикл остановлен');
  assert.equal(calls.pauses[0].kind, 'no-reviewer', 'вид паузы — приёмка не настроена');
  assert.equal(calls.autos.length, 0, 'автоцикл гасит пауза, а не закрытие');
}

// ── 7. accept: закрытие и один громкий пуш ─────────────────────────────────
{
  reset();
  const m = mission({ returned: '2026-10-27T10:00:00.000Z' });
  api.__mission = m;
  api.__messages = [{ raw: 'CF_REVIEW_RESULT {"mission_id":"mission-1","turn_id":"t","verdict":"accept","summary":"оракул закрыт"}' }];
  await api.reviewStep(reviewer, { watermark: 'w-1', ref: 'mission-1', kind: 'review' });
  assert.equal(calls.patches.length, 1, 'миссия закрыта вердиктом');
  assert.equal(calls.patches[0].props['Состояние'].select.name, 'Завершена', 'состояние «Завершена»');
  assert.equal(calls.patches[0].props['Завершена'].date.start, '2026-10-28T12:00:00.000Z', 'дата закрытия');
  assert.deepEqual(calls.autos, [false], 'автоцикл остановлен');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято');
  const key = 'cfn-mission-done:mission-1:2026-10-28T12:00:00.000Z:2026-10-27T10:00:00.000Z';
  assert.equal(store.get(key), true, 'событие объявлено тем же ключом, что и в missionDoneNotice');
  assert.equal(store.get('cfn-review:mission-1'), 'accept', 'отметка «закрыто приёмкой» поставлена');
  assert.ok(calls.logs.some((l) => /принята «Warden»/.test(l)), 'принятие названо');
  const notice = calls.logOptions.find((row) => /принята «Warden»/.test(row.text));
  assert.equal(notice.autoAtLog, false, 'автоцикл выключен до отправки события');
  assert.equal(notice.options.ntfy, 'loud');
  assert.equal(notice.options.cycleStopped, true, 'громкое событие имеет подтверждённую остановку');
  assert.ok(calls.logs.some((l) => /приёмка: оракул закрыт/i.test(l) || /Приёмка: оракул закрыт/.test(l)), 'чем принято — в журнале');
}

// ── 8. rework: возврат с кругом и замечаниями, ход Координатору ────────────
{
  reset();
  api.__roles = [coordinator, reviewer];
  api.__mission = mission({ round: 1 });
  api.__messages = [
    { raw: 'CF_REVIEW_RESULT {"mission_id":"mission-1","turn_id":"t","verdict":"rework","remarks":"1) нет команды проверки контрактов 2) долг по версии движка не записан"}' },
  ];
  await api.reviewStep(reviewer, { watermark: 'w-2', ref: 'mission-1', kind: 'review' });
  const patch = calls.patches[0];
  assert.equal(patch.props['Состояние'].select.name, 'Возвращена', 'состояние «Возвращена»');
  assert.equal(patch.props['Круг'].number, 2, 'круг увеличен на единицу');
  assert.match(patch.props['Замечания'].rich_text[0].text.content, /нет команды проверки контрактов/, 'замечания в карточке миссии');
  assert.ok(patch.props['Возвращена'].date.start, 'дата возврата поставлена');
  assert.equal(calls.plans.length, 1, 'ход вернулся Координатору');
  assert.equal(calls.plans[0].role, 'Coordinator', 'план запрошен у Координатора');
  assert.equal(calls.plans[0].opts.force, true, 'троттлинг плана не мешает возврату');
  assert.match(calls.plans[0].note, /разбери замечания карточками/, 'Координатору сказано, что делать');
  assert.equal(calls.autos.length, 0, 'автоцикл не выключен: работа продолжается');
  assert.equal(store.get('cfn-plan-at'), 0, 'троттлинг плана снят');
}

// ── 9. Предел доработок: четвёртый возврат — стоп и вызов Мастера ──────────
{
  reset();
  api.__roles = [coordinator, reviewer];
  api.__mission = mission({ round: 3 });
  api.__messages = [
    { raw: 'CF_REVIEW_RESULT {"mission_id":"mission-1","turn_id":"t","verdict":"rework","remarks":"1) снова не сходится оракул"}' },
  ];
  await api.reviewStep(reviewer, { watermark: 'w-3', ref: 'mission-1', kind: 'review' });
  assert.equal(calls.pauses.length, 1, 'цикл остановлен');
  assert.equal(calls.pauses[0].kind, 'rework-limit', 'вид паузы — предел доработок');
  assert.match(calls.pauses[0].reason, /3 кругов доработки/, 'сколько кругов прошло — названо');
  assert.match(calls.pauses[0].reason, /снова не сходится оракул/, 'последние замечания в тексте паузы');
  assert.equal(calls.patches.length, 0, 'карточку миссии не трогаем: решает Мастер');
  assert.equal(calls.plans.length, 0, 'новый круг не запускается');
}

// ── 10. Возврат без причины — не возврат ───────────────────────────────────
{
  reset();
  api.__roles = [coordinator, reviewer];
  api.__mission = mission({ round: 1 });
  api.__messages = [{ raw: 'CF_REVIEW_RESULT {"mission_id":"mission-1","turn_id":"t","verdict":"rework","remarks":"  "}' }];
  await api.reviewStep(reviewer, { watermark: 'w-4', ref: 'mission-1', kind: 'review' });
  assert.equal(calls.pauses[0].kind, 'review-empty', 'пауза с честной причиной');
  assert.equal(calls.patches.length, 0, 'миссия не возвращена');
  assert.equal(calls.plans.length, 0, 'работа не запущена');
}

// ── 11. Маркер не про эту миссию и неизвестный вердикт ─────────────────────
{
  reset();
  api.__roles = [coordinator, reviewer];
  api.__mission = mission();
  api.__messages = [{ raw: 'CF_REVIEW_RESULT {"mission_id":"mission-OLD","turn_id":"t","verdict":"accept"}' }];
  await api.reviewStep(reviewer, { watermark: 'w-5', ref: 'mission-1', kind: 'review' });
  assert.equal(calls.pauses[0].kind, 'marker-mismatch', 'чужой маркер не закрывает миссию');
  assert.equal(calls.patches.length, 0, 'ничего не изменено');

  reset();
  api.__messages = [{ raw: 'CF_REVIEW_RESULT {"mission_id":"mission-1","turn_id":"t","verdict":"maybe"}' }];
  await api.reviewStep(reviewer, { watermark: 'w-6', ref: 'mission-1', kind: 'review' });
  assert.equal(calls.pauses[0].kind, 'review-marker', 'неизвестный вердикт — пауза, а не догадка');
  assert.equal(calls.patches.length, 0, 'миссия на месте');
}

// ── 12. Маркера нет — обычное ожидание, без паники ─────────────────────────
{
  reset();
  api.__mission = mission();
  api.__messages = [{ raw: 'принято, всё хорошо, спасибо' }];
  const waited = await api.reviewStep(reviewer, { watermark: 'w-7', ref: 'mission-1', kind: 'review' });
  assert.equal(waited, false, 'ожидание не считается ходом');
  assert.equal(calls.patches.length, 0, 'ничего не изменено');
  assert.equal(calls.pauses.length, 0, 'паузы нет: ответ ещё может дописаться');
  assert.equal(calls.plans.length, 0, 'работа не запущена');
}

console.log('relay-review-gate-smoke: ok');
