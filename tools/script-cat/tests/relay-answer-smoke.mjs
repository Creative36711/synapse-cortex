// Проба 1.4.80: на вопросы агентов отвечает приёмка, и ход переходит к ней
// сразу.
//
// Мастер (28.10): «на доработки всегда отвечаешь ты, на вопросы тоже ты…
// задали вопрос и ход тут же переходит к тебе». До этой версии вопрос ложился
// строкой в «Вопросы» со сроком в сутки, цикл шёл по варианту по умолчанию, а
// ответ Мастера мог не прийти вовсе.
//
// Проверяется:
//   • вопрос ставится в очередь приёмки, повтор не дублируется;
//   • промпт приёмки: вопрос, варианты, default, роль, карточка, оба маркера;
//   • вердикт answer пишет «Ответ» и «Решено», снимает вопрос с очереди и
//     возвращает ход Координатору;
//   • вердикт master — пауза и вызов Мастера, вопрос остаётся открытым;
//   • пустой ответ, неизвестный вердикт и чужой question_id — паузы;
//   • без маркера — обычное ожидание, без паузы;
//   • в тике ход-ответ подключён, а в напоминании о формате — свой маркер.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { promptShim } from './helpers/prompt-shim.mjs';

import { assertIndependentVersionSources, assertUserscriptVersionContract, readUserscriptVersionFields } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);
const fields = readUserscriptVersionFields(src);
assert.equal(versionMatch[1], fields.metadataVersion, 'versionMatch reports the metadata field read by the shared oracle');
const [major, minor, patch] = fields.metadataVersion.split('.').map(Number);
const mismatchVersion = `${major}.${minor}.${patch + 1}`;

// Negative control: reading @version for both sides is self-reference and
// accepts any substitution. The runtime fallback is a distinct source and
// rejects a metadata-only divergence.
const metadataOnlyMismatch = src.replace(
  /^\/\/ @version\s+\S+\s*$/m,
  (line) => line.replace(/\S+\s*$/, mismatchVersion),
);
assert.notEqual(metadataOnlyMismatch, src, 'metadata mismatch fixture must modify only @version');
const selfDerivedExpected = metadataOnlyMismatch.match(/^\/\/ @version\s+(\S+)\s*$/m)?.[1];
assert.equal(selfDerivedExpected, mismatchVersion, 'self-reference fixture has a syntactically valid substituted value');
assert.doesNotThrow(
  () => assert.equal(selfDerivedExpected, selfDerivedExpected),
  'self-reference negative control: reading the same field twice falsely accepts its substitution',
);
assert.throws(
  () => assertUserscriptVersionContract(metadataOnlyMismatch),
  /version mismatch: @version metadata at line \d+ .* differs from SCRIPT_VERSION runtime fallback at line \d+/,
  'independent runtime fallback rejects the metadata-only substitution',
);
assert.throws(
  () => assertIndependentVersionSources('@version', '@version'),
  /version oracle must compare independent sources/,
  'self-referential fields are not independent evidence',
);
const incompatibleMetadata = src.replace(/^\/\/ @version\s+\S+\s*$/m, '// @version incompatible');
assert.throws(
  () => assertUserscriptVersionContract(incompatibleMetadata),
  /plain MAJOR\.MINOR\.PATCH/,
  'incompatible metadata is rejected even when no release number is pinned',
);

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

// ── 1. Вопрос не ждёт срока ────────────────────────────────────────────────
assert.match(src, /answers: "cfn-answer-queue",/, 'у очереди ответов свой ключ');
assert.match(
  src,
  /queueAnswer\(row, q, ctx\);/,
  'askQuestion ставит вопрос в очередь приёмки',
);
// D-080: ход уходит приёмке только когда вопрос держит ход (`gate`/`need`).
// Обычный вопрос записывается, а план идёт по своему next.
assert.match(
  src,
  /if \(askedRow && \(askedRow\.gate === true \|\| askedRow\.need\)\) \{\s*\n\s*const item = answerQueue\(\)\.find\(\(row\) => row\.id === askedRow\.id\);\s*\n\s*if \(item && \(await startAnswer\(mission, item\)\)\) return true;/,
  'ход уходит приёмке только по gate, иначе next применяется',
);
assert.match(src, /ход идёт дальше по /, 'и в журнале сказано, что ход продолжается');
assert.match(
  src,
  /if \(expect\.kind === "answer"\) await answerStep\(me, expect, fromToggle\);/,
  'в тике ход-ответ подключён к приёмке',
);
assert.match(
  src,
  /if \(!expect && me\.fn !== "Reviewer"\) \{\s*\n\s*const item = answerPending\(\);/,
  'незавершённый ответ важнее нового хода',
);
{
  const { PromptCompiler, reminderRequest, UUID } = await import('./helpers/prompt-env.mjs');
  const rem = PromptCompiler.compile(reminderRequest('Reviewer', 'CF_ANSWER_RESULT')).text;
  assert.match(rem, /CF_ANSWER_RESULT/, 'напоминание о формате говорит на языке ответа');
  assert.ok(rem.includes(UUID.question), 'напоминание несёт question_id того же вопроса');
}

// ── 2. Остановки: Координатор — только с ролью, приёмка — только master ─────
assert.match(
  src,
  /if \(!need \|\| canTake\) \{[\s\S]{0,4000}?requestPlan\(\s*mission,\s*role,/,
  'остановка без роли возвращает ход Координатору, а не будит Мастера',
);
assert.match(
  src,
  /const canTake = Boolean\(named && \(named\.status \|\| ""\) === "Активна" && named\.url\);/,
  'остановка с активной ролью тоже не принимается',
);
assert.match(src, /kind: "blocked-norole"/, 'упорство без роли — пауза с честной причиной');
assert.match(src, /verdict === "master"/, 'приёмка может позвать Мастера');
assert.match(src, /kind: "answer-needs-master"/, 'вызов Мастера из ответа — отдельная пауза');

// ── 3. Тихие пуши там, где человек больше не нужен ─────────────────────────
// D-080: тихое уведомление осталось, но называется по-новому — вопрос либо
// держит ход («вопрос держит ход»), либо просто записан.
assert.match(src, /queueAnswer\(row, q, ctx\);[\s\S]{0,500}?ntfy: "quiet", title: "Relay: вопрос держит ход"/, 'тихий пуш у вопроса, который держит ход');
assert.match(
  src,
  /kind: "closed-unreviewed",\n\s+ref: closed\.id,\n\s+quiet: true,/,
  'закрытие в обход приёмки — тихая пауза, а не ночной звонок',
);
assert.match(src, /if \(context\.quiet\) \{/, 'пауза умеет молчать');
assert.match(
  src,
  /ntfy: failed && \(running \|\| waited\) \? "loud" : "quiet",/,
  'без приёмки конец не звонит; провал громкий, только когда остановил работу',
);

// ── 4. Сам блок ответа ─────────────────────────────────────────────────────
const block = sliceBetween(
  '  const answerQueue = () => {',
  '  async function dispatchTask(card, roleName, mission = null) {',
);

const store = new Map();
const calls = { sends: [], patches: [], plans: [], pauses: [], logs: [], missing: [], reads: [] };

const api = new Function(
  'C',
  'K',
  'Q',
  'rt',
  'norm',
  'uid',
  'firstLine',
  'oneLine',
  'dbg',
  'GM_getValue',
  'GM_setValue',
  'log',
  'pause',
  'patch',
  'technicalInfo',
  'roleContext',
  'reviewerRole',
  'sendToRole',
  'messagesAfter',
  'parseMarker',
  'markerMissing',
  'openQuestions',
  'paintQuestions',
  'activeMission',
  'roles',
  'queueOf',
  'requestPlan',
  'richText',
  'notion',
  'questionMaterial',
  'recordQuestionChange',
  'logThrottled',
  'withQuestionWriteLock', 'isUuid', 'retainRejectedResult',
  `${promptShim}
${block}
   return { answerQueue, queueAnswer, dropAnswer, answerPending, answerPrompt, startAnswer, answerStep };`,
)(
  { pageUrl: 'https://app.notion.com/p/Relay', reworkLimit: 3 },
  { expect: 'cfn-expect', answers: 'cfn-answer-queue' },
  { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт', cancelled: 'Отменён' },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  () => 'turn-new',
  (text, max = 220) => String(text || '').split('\n')[0].slice(0, max),
  (value, max) => String(value || '').slice(0, max),
  () => {},
  (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  (key, value) => store.set(key, value),
  (text) => calls.logs.push(String(text)),
  (reason, context = {}) => calls.pauses.push({ reason: String(reason), kind: context.kind, quiet: Boolean(context.quiet) }),
  async (id, props) => {
    calls.patches.push({ id, props });
    return {};
  },
  () => 'ТЕХНИКА',
  (role) => `Ты — ${role.name}.`,
  async () => api.__reviewer,
  async (role, text, kind, ref, extra = {}) => {
    calls.sends.push({ role: role.name, text, kind, ref, extra });
    return true;
  },
  () => api.__messages,
  (raw, name) => (raw && raw.includes(name) ? JSON.parse(raw.slice(raw.indexOf('{'))) : null),
  async (role, expect, markerName) => {
    calls.missing.push({ role: role.name, markerName });
    return false;
  },
  () => ({ at: Date.now(), rows: [{ id: 'q-1', text: 'вопрос' }] }),
  () => {},
  async () => api.__mission,
  async () => api.__roles,
  async () => ({ summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 3 Draft' }),
  async (mission, role, queue, note, opts = {}) => {
    calls.plans.push({ role: role.name, note, opts });
    return true;
  },
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
  async (method, path) => {
    calls.reads.push({ method, path });
    return { id: 'q-1', properties: {
      'Статус': { select: { name: api.__rowStatus || 'Ждёт' } },
      'Ответ': { rich_text: api.__rowAnswer ? [{ plain_text: api.__rowAnswer }] : [] },
    } };
  },
  (url) => url || '',
  () => {},
  () => {},
  (work) => work(), (value) => Boolean(value), () => true,
);

const runAnswerStep = (expect) => { const live = { kind:'answer', turnId:'t', ...expect }; store.set('cfn-expect', live); return api.answerStep(reviewer, live); };

const reviewer = { id: 'rev-1', name: 'Warden', url: 'https://arena.ai/agent/warden', fn: 'Reviewer' };
const coordinator = { id: 'coord-1', name: 'Coordinator', url: 'https://arena.ai/agent/coord', fn: 'Coordinator' };
const mission = {
  id: 'mission-1',
  properties: {
    'Миссия': { title: [{ plain_text: 'NAR-5 · state-ui' }] },
    'ТЗ URL': { url: 'https://github.com/example/relay-fixture/blob/main/docs/agents/tz-nar-5.md' },
  },
};

const reset = () => {
  store.clear();
  calls.sends.length = 0;
  calls.patches.length = 0;
  calls.plans.length = 0;
  calls.pauses.length = 0;
  calls.logs.length = 0;
  calls.missing.length = 0;
  api.__reviewer = reviewer;
  api.__roles = [coordinator, reviewer];
  api.__mission = mission;
  api.__messages = [];
};

const question = {
  text: 'Какой исход выбрать для ADR 0015?',
  fullText: 'Какой исход выбрать для предложенного правила в docs/contracts/adr/0015-format-freeze.md?',
  fallback: 'Оставить как есть',
  options: ['Оставить как есть', 'Принять в NAR-5.10', 'Отклонить ADR 0015'],
};

// ── 5. Очередь ─────────────────────────────────────────────────────────────
{
  reset();
  const item = api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect', card: 'NAR-5.1' });
  assert.equal(item.id, 'q-1', 'вопрос в очереди');
  assert.equal(api.answerQueue().length, 1, 'ровно один элемент');
  assert.equal(api.answerPending().role, 'Architect', 'кто спросил — видно');
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  assert.equal(api.answerQueue().length, 1, 'повтор не дублируется');
  api.dropAnswer('q-1');
  assert.equal(api.answerQueue().length, 0, 'вопрос снимается с очереди');
  assert.equal(api.answerPending(), null, 'очередь пуста');
}

// ── 6. Промпт ответа ───────────────────────────────────────────────────────
{
  reset();
  const item = api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect', card: 'NAR-5.1' });
  const env = api.answerPrompt(mission, reviewer, item, 'turn-9');
  const text = env.text;
  assert.match(text, /Миссия: NAR-5 · state-ui/, 'миссия в промпте');
  assert.match(text, /ТЗ: https:\/\/github\.com\/example\/relay-fixture\/blob\/main\/docs\/agents\/tz-nar-5\.md/, 'оракул ссылкой');
  assert.match(text, /Вопрос задал: Architect · карточка «NAR-5\.1»/, 'кто и по какой карточке');
  assert.match(text, /0015-format-freeze\.md/, 'полный текст вопроса');
  assert.match(text, /Варианты: Оставить как есть · Принять в NAR-5\.10/, 'варианты');
  assert.match(text, /Вариант по умолчанию \(работа идёт по нему сейчас\): Оставить как есть/, 'default назван');
  assert.match(text, /вместо Мастера/, 'роль названа');
  assert.match(text, /CF_ANSWER_RESULT \{"question_id":"q-1","turn_id":"turn-9","verdict":"answer","answer"/, 'маркер ответа');
  assert.match(text, /"verdict":"master","reason"/, 'маркер вызова Мастера');
  assert.match(text, /ничего не правь/, 'приёмка не правит');
  assert.match(text, /приёмка \(Reviewer\)/, 'контекст роли на месте');
}

// ── 7. Передача хода приёмке ───────────────────────────────────────────────
{
  reset();
  const item = api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  const sent = await api.startAnswer(mission, item);
  assert.equal(sent, true, 'ход ушёл приёмке');
  assert.equal(calls.sends.length, 1, 'ровно одна отправка');
  assert.equal(calls.sends[0].role, 'Warden', 'адресат — приёмка');
  assert.equal(calls.sends[0].kind, 'answer', 'вид ожидания — answer');
  assert.equal(calls.sends[0].ref, 'q-1', 'ожидание привязано к вопросу');
  assert.equal(calls.sends[0].extra.questionId, 'q-1', 'questionId в ожидании');
  assert.equal(calls.sends[0].extra.missionId, 'mission-1', 'missionId в ожидании');
  assert.equal(calls.pauses.length, 0, 'никого не будим');
}

// ── 8. Приёмки нет: вопрос остаётся Мастеру, цикл не встаёт ────────────────
{
  reset();
  api.__reviewer = null;
  const item = api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  const sent = await api.startAnswer(mission, item);
  assert.equal(sent, false, 'передавать некому');
  assert.equal(calls.sends.length, 0, 'никому не отправлено');
  assert.equal(api.answerQueue().length, 0, 'из очереди снят, чтобы не крутиться');
  assert.equal(calls.pauses.length, 0, 'паузы нет: вопрос закроется сроком или Мастером');
  assert.ok(calls.logs.some((l) => /отвечать некому/.test(l)), 'сказано честно');
}

// ── 9. Вердикт answer: «Ответ», «Решено», ход Координатору ─────────────────
{
  reset();
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  api.__messages = [
    {
      raw:
        'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"answer","answer":"Принять в NAR-5.10 после зелёных проверок пака и игры-примера; сейчас текст не переписывать."}',
    },
  ];
  await runAnswerStep({ watermark: 'w-1', ref: 'q-1', kind: 'answer' });
  assert.equal(calls.patches.length, 1, 'вопрос обновлён');
  assert.equal(calls.patches[0].id, 'q-1', 'правильная строка');
  assert.equal(calls.patches[0].props['Статус'].select.name, 'Решено', 'статус «Решено»');
  assert.match(calls.patches[0].props['Ответ'].rich_text[0].text.content, /NAR-5\.10/, 'ответ записан');
  assert.equal(api.answerQueue().length, 0, 'с очереди снят');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято');
  assert.equal(calls.plans.length, 1, 'ход вернулся Координатору');
  assert.equal(calls.plans[0].role, 'Coordinator', 'план запрошен у Координатора');
  assert.equal(calls.plans[0].opts.force, true, 'троттлинг плана не мешает');
  assert.match(calls.plans[0].note, /Ответ на вопрос записан/, 'Координатору сказано, что делать');
  assert.equal(calls.pauses.length, 0, 'цикл не встал');
}

// ── 10. Вердикт master: пауза и вызов Мастера ──────────────────────────────
{
  reset();
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  api.__messages = [
    { raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"master","reason":"нужна роль Pack Author с Agent URL"}' },
  ];
  await runAnswerStep({ watermark: 'w-2', ref: 'q-1', kind: 'answer' });
  assert.equal(calls.pauses.length, 1, 'цикл остановлен');
  assert.equal(calls.pauses[0].kind, 'answer-needs-master', 'вид паузы — нужен Мастер');
  assert.match(calls.pauses[0].reason, /нужна роль Pack Author/, 'причина названа');
  assert.equal(calls.pauses[0].quiet, false, 'вызов Мастера — громкий');
  assert.equal(calls.patches.length, 0, 'вопрос не закрыт: его решает Мастер');
  assert.equal(calls.plans.length, 0, 'работа не запущена');
  assert.equal(store.get('cfn-expect').masterEscalated, true, 'исходный question/turn сохраняется для ответа после паузы');
  assert.equal(api.answerQueue().length, 1, 'вопрос не удаляется, пока Мастер решает');
}

// ── 10a. Ответ Warden после решения Мастера принимается на том же turn ─────
{
  reset();
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Coordinator' });
  api.__messages = [
    { id: 'master-verdict', raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"master","reason":"нужно решение владельца"}' },
  ];
  await runAnswerStep({ watermark: 'before-master', ref: 'q-1', kind: 'answer' });
  const pending = store.get('cfn-expect');
  api.__messages = [
    { id: 'late-answer', raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"answer","answer":"Мастер подтвердил Creative36711, 2026 и MIT."}' },
  ];
  await api.answerStep(reviewer, pending, true);
  assert.equal(calls.patches.length, 1, 'поздний ответ записан автоматически');
  assert.equal(calls.patches[0].props['Статус'].select.name, 'Решено', 'вопрос закрыт после ответа');
  assert.match(calls.patches[0].props['Ответ'].rich_text[0].text.content, /Creative36711/, 'содержимое позднего ответа сохранено');
  assert.equal(calls.plans.length, 1, 'после записи ход возвращён Координатору');
  assert.equal(calls.pauses.length, 1, 'новой ложной паузы нет');
}

// ── 10b. Ручной ответ в Notion после эскалации тоже продолжает цикл ────────
{
  reset();
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Coordinator' });
  api.__messages = [
    { id: 'master-verdict', raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"master","reason":"нужно решение владельца"}' },
  ];
  await runAnswerStep({ watermark: 'before-master', ref: 'q-1', kind: 'answer' });
  api.__messages = [];
  api.__rowStatus = 'Решено';
  api.__rowAnswer = 'Мастер подтвердил Creative36711, 2026 и MIT.';
  await api.answerStep(reviewer, store.get('cfn-expect'), true);
  assert.equal(calls.patches.length, 0, 'уже внесённый человеком ответ не перезаписывается');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято после сверки Notion');
  assert.equal(api.answerQueue().length, 0, 'вопрос снят с очереди');
  assert.equal(calls.plans.length, 1, 'цикл возвращён Координатору после ручной записи');
  assert.equal(calls.pauses.length, 1, 'цикл не зациклился на прежнем verdict master');
}

// ── 11. Пустой ответ, неизвестный вердикт, чужой вопрос ────────────────────
{
  reset();
  api.__messages = [{ raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"answer","answer":"  "}' }];
  await runAnswerStep({ watermark: 'w-3', ref: 'q-1' });
  assert.equal(calls.pauses[0].kind, 'answer-empty', 'пустой ответ — пауза');
  assert.equal(calls.patches.length, 0, 'вопрос не закрыт пустотой');

  reset();
  api.__messages = [{ raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"maybe","answer":"…"}' }];
  await runAnswerStep({ watermark: 'w-4', ref: 'q-1' });
  assert.equal(calls.pauses[0].kind, 'answer-marker', 'неизвестный вердикт — пауза');
  assert.equal(calls.patches.length, 0, 'вопрос на месте');

  reset();
  api.__messages = [{ raw: 'CF_ANSWER_RESULT {"question_id":"q-OLD","turn_id":"t","verdict":"answer","answer":"Да"}' }];
  await runAnswerStep({ watermark: 'w-5', ref: 'q-1' });
  assert.equal(calls.pauses[0].kind, 'marker-mismatch', 'чужой вопрос не закрывается');
  assert.equal(calls.patches.length, 0, 'ничего не изменено');
}

// ── 12. Маркера нет — обычное ожидание ─────────────────────────────────────
{
  reset();
  api.__messages = [{ raw: 'подумал и решил, что вопрос сложный' }];
  const waited = await runAnswerStep({ watermark: 'w-6', ref: 'q-1' });
  assert.equal(waited, false, 'ожидание не считается ходом');
  assert.equal(calls.missing[0].markerName, 'CF_ANSWER_RESULT', 'напоминание просит маркер ответа');
  assert.equal(calls.patches.length, 0, 'ничего не изменено');
  assert.equal(calls.pauses.length, 0, 'паники нет: ответ ещё может дописаться');
}

// ── 13. Вопрос закрыли руками, пока приёмка думала ────────────────────────
{
  reset();
  api.__rowStatus = 'Решено';
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  api.__messages = [
    { raw: 'CF_ANSWER_RESULT {"question_id":"q-1","turn_id":"t","verdict":"answer","answer":"Принять"}' },
  ];
  await runAnswerStep({ watermark: 'w-7', ref: 'q-1', kind: 'answer' });
  assert.equal(calls.patches.length, 0, 'чужое решение не перезаписано');
  assert.equal(api.answerQueue().length, 0, 'с очереди снят');
  assert.ok(calls.logs.some((l) => /закрыт раньше приёмки/.test(l)), 'в журнале сказано, почему');
  assert.equal(calls.plans.length, 1, 'ход всё равно возвращается Координатору');
  assert.equal(calls.pauses.length, 0, 'паузы нет');
  api.__rowStatus = 'Ждёт';
}

// ── 14. Длинный ответ: 2296 знаков — случай 28.10 ─────────────────────────
// Notion ответил 400 «content.length should be ≤ 2000, instead was 2296», и
// вопрос остался «Ждёт». Ответ режется на части и уезжает целиком.
{
  reset();
  const long = 'Ответ приёмки. '.repeat(160); // 2400 знаков
  api.queueAnswer({ id: 'q-1' }, question, { roleName: 'Architect' });
  api.__messages = [
    { raw: `CF_ANSWER_RESULT ${JSON.stringify({ question_id: 'q-1', turn_id: 't', verdict: 'answer', answer: long })}` },
  ];
  await runAnswerStep({ watermark: 'w-8', ref: 'q-1', kind: 'answer' });
  assert.equal(calls.pauses.length, 0, 'цикл не встал на длинном ответе');
  assert.equal(calls.patches.length, 1, 'вопрос закрыт');
  const parts = calls.patches[0].props['Ответ'].rich_text;
  assert.equal(parts.length, 2, '2296+ знаков — две части');
  for (const part of parts) {
    assert.ok(part.text.content.length <= 2000, `часть в пределе, а было ${part.text.content.length}`);
  }
  // Ответ приходит с trim(): хвостовой пробел срезается до записи, и это не потеря.
  assert.equal(parts.map((p) => p.text.content).join(''), long.trim(), 'текст решения не потерян');
  assert.equal(calls.patches[0].props['Статус'].select.name, 'Решено', 'статус выставлен');
}

console.log('relay-answer-smoke: ok');
