// Проба relay.user.js: кнопка «Шаг», поле ввода и плашка завершённой задачи.
//
// История жалоб Мастера, все проверяются здесь:
//   • после перехода на страницу адресата задание не досылалось (гейт «автоцикл
//     выключен» срабатывал раньше очереди);
//   • `consumePending` молчал на каждом раннем выходе;
//   • `generating()` ждал скрытый `stop-button` из прошлой генерации;
//   • поле ввода искалось первым `[contenteditable]`, а не редактором Arena;
//   • «Шаг» на корне (`/`) требовал вручную открыть страницу агента;
//   • плашка «задание выполнено» и карточка с кнопкой Skip перекрывают чат,
//     поэтому в `dispatch.user.js` они закрываются ДО вставки текста.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
import { promptShim } from './helpers/prompt-shim.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// 1. Версия и гейт тика.
const versionMatch = assertUserscriptVersionContract(src);

const tickStart = src.indexOf('async function tick(');
const tickBody = src.slice(tickStart, src.indexOf('// ───────────────────────────── старт', tickStart));
assert.match(tickBody, /const pending = GM_getValue\(K\.pending, null\);/, 'тик знает про очередь');
assert.match(tickBody, /if \(!auto && !fromToggle && !pending && !waiting\) return;/, 'незавершённая отправка и остаток ожидания важнее автоцикла');
assert.match(tickBody, /const silentMs = Date\.now\(\) - busyAt;/, 'залипший шаг снимается по тишине');
assert.match(tickBody, /if \(silentMs < 120000\)/, 'порог тишины — две минуты');
assert.match(tickBody, /stepRestarts > 2/, 'третий перезапуск подряд — пауза, а не бесконечные круги');
assert.match(src, /let busyAt = 0;/, 'признак жизни объявлен рядом с sleep');
assert.match(src, /const sleep = \(ms\) => \{\s*busyAt = Date\.now\(\);/, 'sleep отмечает, что шаг жив: живого шага сторож не касается');
assert.match(src, /stepAlive\(\);\n      if \(Date\.now\(\) >= until\) return null;/, 'waitFor тоже отмечается');
assert.match(tickBody, /Шаг уже выполняется/, 'повторное нажатие объясняется, а не молчит');
assert.match(tickBody, /else if \(!expect\)/, 'исполнитель без задания не падает в TypeError');
assert.match(tickBody, /submitExecutor\(me, expect, fromToggle\)/, 'ручной режим передаётся исполнителю');
assert.match(src, /async function markerMissing\(role, expect, markerName, manual = false, why = ""\)/, 'ожидание маркера знает про ручной шаг');
assert.match(src, /Жду ответ \$\{role.name\}: сообщений агента после нашего задания нет/, 'ручной шаг объясняет ожидание');
assert.match(src, /наших \$\{mine\}, ответов агента \$\{answers.length\}/, 'в журнале виден разбор чата, а не голое «нет сообщений»');

// 1.1. «Шаг» работает с любой страницы: сам открывает нужную роль.
const rootBlock = tickBody.slice(
  tickBody.indexOf('const meId = roleFromPath();'),
  tickBody.indexOf('const me = list.find(', tickBody.indexOf('const meId')),
);
assert.match(rootBlock, /if \(!fromToggle && !autoOn\(\)\) return;/, 'в ручном фоне без нажатия страницу не открываем');
assert.match(rootBlock, /r\.fn === "Coordinator"/, 'Координатор — запасной адрес, если работы нигде не ждут');
assert.match(rootBlock, /const target = pendingRole \|\| waitingRole \|\| coord;/, 'сначала адресат очереди, потом тот, чей ответ ждём');
assert.match(rootBlock, /if \(!pendingNow && fromToggle\) GM_setValue\(K\.step, true\);/, 'шаг запоминается на один переход');
assert.match(rootBlock, /return navigateTo\(target, why\);/, 'открываем нужную страницу сами');
assert.ok(!/в адресе нет \/agent\/<id>/.test(src), 'требования открыть страницу вручную больше нет');
assert.match(src, /if \(GM_getValue\(K\.step, false\) && !projectHeld\(\)\) \{/, 'загрузка страницы выполняет отложенный шаг');
assert.match(src, /GM_setValue\(K\.step, false\);/, 'шаг одноразовый, петли нет');

// 2. Поле ввода и кнопка отправки — шире, чем в dispatch.user.js.
const sendStart = src.indexOf('// ───────────────────────────── отправка');
const sendEnd = src.indexOf('// ───────────────────────────── PR', sendStart);
const sendBlock = src.slice(sendStart, sendEnd);

// 1.4.78: `consumePending` перед вставкой текста нажимает Continue, если ветка
// прошлого хода слита. Функции берём из настоящего исходника, чтобы проба
// проверяла их, а не заглушки.
function sliceToBrace(from) {
  assert.ok(from > 0, 'блок Continue на месте');
  return src.slice(from, src.indexOf('\n  }\n', from) + 4);
}
const contBlock = [
  src.slice(
    src.indexOf('const isContinueLabel ='),
    src.indexOf('\n', src.indexOf(';', src.indexOf('const isContinueLabel ='))) + 1,
  ),
  sliceToBrace(src.indexOf('function continueButton()')),
  sliceToBrace(src.indexOf('async function ensureFreshBranch(')),
].join('\n');
assert.match(sendBlock, /\.editor-content\[contenteditable\]/, 'редактор Arena первым');
assert.match(sendBlock, /\[contenteditable\]:not\(\[contenteditable='false'\]\)/, 'plaintext-only тоже contenteditable');
assert.match(sendBlock, /\.ProseMirror/, 'ProseMirror');
assert.match(sendBlock, /\[role='textbox'\]/, 'role=textbox');
assert.match(sendBlock, /textarea:not\(\[readonly\]\)/, 'запасной textarea');
assert.match(sendBlock, /function elementCovered\(editor\)/, 'проверяем, не накрыт ли элемент');
assert.match(sendBlock, /document\.elementFromPoint\(/, 'оверлей ловится по верхнему элементу');
assert.match(sendBlock, /const SEND_LABEL = \/\^\(send\|submit\|отправ/, 'подпись Send ищется и по-русски, и только с начала подписи');
assert.match(sendBlock, /const STOP_LABEL =/, 'кнопка остановки не путается с отправкой');
assert.match(sendBlock, /const box = composerBox\(editor\);/, 'область поиска кнопки — панель ввода, а не документ');
assert.match(sendBlock, /aria-disabled/, 'заблокированная кнопка не считается');
assert.match(sendBlock, /function writePrompt\(editor, text, attempt = 1\)/, 'вставка текста отдельной функцией');
assert.match(sendBlock, /HTMLTextAreaElement\.prototype/, 'textarea заполняется нативным сеттером');

// 3. Плашка и карточка Skip — оба вида перекрывают чат.
assert.match(sendBlock, /function closeCompletionPanel\(\)/, 'панель завершения закрывается');
assert.match(sendBlock, /function closeCompletionPlaque\(\)/, 'плашка любым способом закрывается');
assert.match(sendBlock, /const PANEL_SELECTORS = \[/, 'панель ищется по стабильной части классов');
assert.match(sendBlock, /border-border-medium\.bg-surface-secondary/, 'стабильная часть классов');
const panelSelectors = sendBlock.slice(sendBlock.indexOf('const PANEL_SELECTORS'), sendBlock.indexOf('];', sendBlock.indexOf('const PANEL_SELECTORS')));
assert.ok(!/shadow/.test(panelSelectors), 'жёсткая привязка к тени убрана: у панели то shadow-sm, то shadow-none');
assert.match(sendBlock, /function completionPanels\(\)/, 'кандидаты в панель собираются и дедуплицируются');
assert.match(sendBlock, /close\|dismiss\|закрыть\|скрыть/, 'кнопка закрытия ищется по подписи');
assert.match(sendBlock, /function skipCardButton\(\)/, 'карточка с кнопкой Skip тоже закрывается');
assert.match(sendBlock, /data-agent-transcript-message/, 'ищем её в транскрипте, как dispatch.user.js');
assert.match(sendBlock, /async function ensureComposer\(/, 'редактор ждём, освобождая чат');
assert.match(sendBlock, /if \(closed < 6 && completionPanels\(\)\.length\)/, 'клик-шторм ограничен: закрытия считаются, панелей может быть несколько');
assert.match(sendBlock, /if \(editor\) return \{ editor, closed, polled, overlay: false \};/, 'карточку не трогаем, если поле ввода есть');
assert.ok(!/composerCovered/.test(src), 'проверка «накрыт» больше не блокирует ввод');
const ensureCall = sendBlock.indexOf('await ensureComposer()');
const writeCall = sendBlock.indexOf('writePrompt(editor, pending.text)');
assert.ok(ensureCall > 0 && ensureCall < writeCall, 'чат освобождается до вставки задания');

// 4. Молчаливых выходов в consumePending не осталось.
const cpStart = sendBlock.indexOf('async function consumePending(');
const cpBody = sendBlock.slice(cpStart);
const bareReturns = [...cpBody.matchAll(/return (true|false);/g)].map((m) => m[0]);
assert.equal(
  bareReturns.filter((r) => r === 'return false;').length,
  2,
  'return false только там, где задания нет или оно чужое',
);
assert.match(cpBody, /return !act;/, 'просрочка продолжает шаг только по нажатию или в автоцикле');
assert.match(cpBody, /const age = Date\.now\(\) - Number\(pending\.at \|\| 0\);/, 'возраст очереди считается до сверки роли');
assert.match(cpBody, /Снял просроченную отправку из очереди/, 'просрочка объясняется');
assert.match(cpBody, /Продолжаю шаг с чистого листа/, 'просрочка не глотает нажатие');
assert.match(cpBody, /Нажмите «Шаг», чтобы начать заново/, 'на загрузке страницы шаг сам не начинается');
assert.match(cpBody, /const ghost = await dropGhostHandoff\("очередь отправки просрочена", \{ ignoreQueue: true \}\);/, 'вместе с очередью снимается ожидание и откатывается карточка');
for (const text of [
  'Агент ещё отвечает: задание из очереди подождёт',
  'Не нашёл поле ввода на странице адресата',
  'Не удалось вставить задание в редактор',
  'символов` +',
]) {
  assert.ok(cpBody.includes(text), `журнал объясняет: ${text}`);
}
assert.match(cpBody, /composerDiagnostics\(\)/, 'при отказе печатается диагностика разметки');
assert.ok(!/В поле ввода уже есть другой текст/.test(src), 'запрета на чужой текст больше нет');
assert.match(cpBody, /очистил перед вставкой задания/, 'видно, что поле очищено перед вставкой');
assert.match(cpBody, /clearComposer\(editor\)/, 'поле чистится перед заданием, а не поверх старого текста');
assert.match(cpBody, /const delivery = await deliver\(editor, pending\.text, pending\.turnId\);/, 'отправка проверяется');
assert.match(cpBody, /if \(!delivery\.ok\)/, 'неудачная отправка — пауза, а не «отправлено»');
assert.match(sendBlock, /async function deliver\(editor, text, turnId = ""\)/, 'доставка отдельной функцией, номер хода — в ключ (1.14.7)');
assert.match(sendBlock, /async function waitForSendReady\(editor, timeoutMs = 4000\)/, 'ждём активную кнопку Send');
assert.match(sendBlock, /активной кнопки Send нет/, 'неактивная кнопка называется причиной');
assert.match(sendBlock, /function sendDiagnostics\(editor\)/, 'при отказе печатаются кандидаты в кнопку Send');
assert.match(sendBlock, /const inPanel = \(b\) => panels\.some/, 'кнопки карточки не считаются Send');
assert.match(sendBlock, /isNearComposer\(b, editor\)/, 'Send обязан быть рядом с редактором');
assert.match(sendBlock, /const nearField = controls\.filter\(\(b\) => \{/, 'без подписи кнопка определяется по месту');
assert.match(sendBlock, /if \(siblings\.length !== 1\) return false;/, 'кнопка должна стоять одна в своей группе');
assert.match(sendBlock, /holder !== holder\.parentElement\?\.lastElementChild/, 'группа должна быть последней в ряду');
assert.match(sendBlock, /return nearField\.at\(-1\) \|\| null;/, 'если ни одна не подошла — пауза, а не догадка');
assert.ok(
  !/parentElement\?\.querySelectorAll/.test(sendBlock),
  'запасного пути «первая попавшаяся кнопка в родителе» больше нет',
);
assert.match(
  sendBlock,
  /if \(!inserted && composerAlive\(live\)\) \{/,
  'textContent — только запасной путь и только в живой узел',
);
assert.match(sendBlock, /composerAlive\(live\) \? composerText\(live\)\.length : 0/, 'отвязанный узел не считается успехом');
assert.match(sendBlock, /via: inserted \? "execCommand" : "textContent"/, 'путь вставки виден в отладке');
assert.match(
  sendBlock,
  /waitSent\(key, known, C\.sendVerifyMs, text, since\)/,
  'доставка подтверждается новым сообщением в чате',
);
assert.match(
  sendBlock,
  /const already = userSaysSince\(key, known, since\);/,
  'старое сообщение с тем же ключом доставкой не считается',
);
assert.match(sendBlock, /своё сообщение в чате не появилось/, 'ложное «отправлено» исключено');
assert.match(cpBody, /setTimeout\(\(\) => tick\(false\), 5000\)/, 'без редактора шаг повторится сам');

// 4.1. Отладка в консоль браузера: включается, переживает переходы, объясняет.
assert.match(src, /debug: "cfn-debug"/, 'флаг отладки хранится в ScriptCat');
assert.match(src, /const debugOn = \(\) => \{/, 'отладка включается по флагу или ?cfn-debug');
assert.match(src, /searchParams\.has\("cfn-debug"\)/, 'параметр ?cfn-debug работает');
assert.match(src, /function dbg\(step, data\)/, 'подробный лог в консоль');
assert.match(src, /console\.log\(line, payload\)/, 'в консоль идут данные, а не только текст');
assert.match(src, /if \(typeof data === "function"\)/, 'снимок считается только при включённой отладке');
assert.match(src, /function debugSnapshot\(\)/, 'снимок состояния для консоли');
assert.match(src, /__relay = debugApi/, 'в консоли доступен пульт __relay');
assert.match(src, /state: \(\) => debugSnapshot\(\)/, '__relay.state()');
assert.match(src, /step: \(\) => tick\(true\)/, '__relay.step()');
assert.match(src, /resend: \(\) => \{/, '__relay.resend() — вернуть задание в очередь');
assert.match(src, /id="\$\{ui\.debug\}"/, 'кнопка 🐞 в панели');
assert.match(src, /Отладка включена: подробности идут в консоль браузера/, 'включение объяснено в журнале');
assert.match(src, /function debugSendButton\(editor\)/, 'отладка показывает кнопку Send: найдена, активна, перекрыта');

// 4.2. Неподтверждённая отправка возвращается в очередь, а не ждёт вечно.
assert.match(src, /function reviveUnverifiedHandoff\(\)/, 'есть возврат неподтверждённой отправки');
assert.match(src, /if \(!waiting \|\| !Number\(waiting\.sentAt\) \|\| waiting\.verified === true\) return "";/, 'проверяется отметка verified');
assert.match(src, /return "revived";/, 'отправленное заново возвращается в очередь');
assert.match(src, /return "dropped";/, 'фантом без текста снимается отдельно');
assert.match(src, /messagesAfter\(waiting\.watermark \|\| "", waiting\.seen\)\.length/, 'дубль исключён: смотрим сообщения после водяного знака');
assert.match(src, /GM_setValue\(K\.pending, \{\s*roleId: waiting\.roleId,[\s\S]{0,120}?text,\s*at: Date\.now\(\),\s*\}\)/, 'задание возвращается в очередь с адресом роли');
assert.match(src, /не подтверждена \(сообщение в чате не появилось\)/, 'причина видна в журнале');
assert.match(tickBody, /reviveUnverifiedHandoff\(\);/, 'тик вызывает возврат до отправки');

// 5. Ожидание без отправки не считается ходом.
assert.match(tickBody, /if \(expect && !Number\(expect\.sentAt\)\)/, 'ожидание без отправки не считается ходом');
const noSendBlock = tickBody.slice(tickBody.indexOf('!Number(expect.sentAt)'), tickBody.indexOf('const waited'));
assert.match(noSendBlock, /const live = GM_getValue\(K\.expect, null\);/, 'D-044: решение по живому состоянию, а не по устаревшему снимку');
assert.match(noSendBlock, /if \(!ghost2 && live && Number\(live\.sentAt\)\) \{\s*expect = live;/, 'восстановленная доставка не стирается');
assert.match(noSendBlock, /GM_setValue\(K\.expect, null\);/, 'настоящий фантом снимается');
assert.match(noSendBlock, /GM_setValue\("cfn-plan-at", 0\);/, 'троттлинг плана сбрасывается');
assert.match(noSendBlock, /снимаю ожидание и начинаю ход заново/, 'причина видна в журнале');
assert.match(noSendBlock, /expect = null;/, 'шаг продолжается без ожидания');
assert.match(src, /const mark = delivery\.msgId \|\| watermark;\s*const sentAt = Date\.now\(\);[\s\S]*?recordDeliveryReceipt\(expect, \{ messageId: delivery\.msgId, sentAt, watermark: mark, seen \}\);\s*GM_setValue\(K\.expect, \{\s*\.\.\.expect, watermark: mark, sentAt, verified: true/, 'отметка и квитанция ставятся только после подтверждённой доставки');
assert.match(src, /pendingTtlMs: 600000/, 'TTL очереди в конфиге');
assert.match(src, /replyWaitMs: 1800000/, 'предел ожидания ответа в конфиге');
assert.match(src, /function dropHandoff\(reason\)/, 'зависшая передача снимается целиком');
assert.match(tickBody, /dropHandoff\(/, 'молчание агента ставит паузу');
assert.match(
  src,
  /async function releaseUndelivered\(expect, why, \{ cause = "undelivered" \} = \{\}\)/,
  'недошедший ход возвращает карточку в Ready',
);
assert.match(cpBody, /await releaseUndelivered\(/, 'отказ отправки и просрочка снимают Running');
assert.match(tickBody, /await releaseUndelivered\(stuck/, 'молчание агента снимает Running, а не ждёт 45 минут');

// 6. Поведение: мини-DOM и заглушки вместо браузера.
const load = ({ pending, editor, send, panels = [], stop = false, now = 1_000_000, expect = undefined, skip = false, overlay = false, stickyOverlay = false, sendCovered = false, deadSend = false, disabledSend = false, rollback = false, captcha = false, captchaAfterClick = false, sentAlready = false }) => {
  // D-044: подтверждённая доставка требует живого ожидания. Старые пробы,
  // не задававшие expect, моделировали штатный ход с ожиданием адресата.
  const expectState = expect === undefined
    ? { roleId: pending?.roleId || 'coordinator', kind: 'plan', ref: 'm1' }
    : expect;
  const out = { logs: [], sets: new Map(), pauses: [], clicks: [], timers: [], rollback: { calls: [], result: rollback } };
  const state = { now };
  const advance = (ms) => { state.now += ms; };
  const el = (tag, props = {}) => ({
    tagName: tag,
    isConnected: true,
    disabled: false,
    innerText: "",
    textContent: props.text || "",
    focus() {},
    getAttribute: (k) => props[k] ?? null,
    getClientRects: () => [{}],
    closest: () => null,
    querySelectorAll: () => [],
    dispatchEvent() {},
    click() { out.clicks.push(props.id || tag); },
    ...props,
  });
  // Свои сообщения в транскрипте: 1.4.20 подтверждает доставку именно ими.
  // У реплики есть id: доставка подтверждается сообщением, которого не было в
  // снимке до отправки, — без id сравнить нечего (1.4.84).
  const sent = sentAlready
    ? [{ id: "chat-message-m0", textContent: pending?.text || "", closest: () => null }]
    : [];
  // Кнопка Send стоит вплотную к полю ввода — как в жизни. Раньше стаб
  // ставил её в стороне, и это скрывало ошибку «клик ушёл в сайдбар».
  const sendBtn = send ? el("BUTTON", {
    "aria-label": "Send", id: "send", contains: () => false, disabled: disabledSend,
    getBoundingClientRect: () => ({ left: 290, top: 46, width: 24, height: 24 }),
  }) : null;
  if (sendBtn) sendBtn.click = () => {
    out.clicks.push("send");
    if (deadSend) return; // клик по кнопке ничего не делает — как в жизни при «сером» Send
    if (editor) {
      sent.push({
        id: `chat-message-m${sent.length + 1}`,
        textContent: editor.innerText || editor.textContent || "",
        closest: () => null,
      });
      editor.innerText = "";
      editor.textContent = "";
    }
  };
  // 1.4.25: кнопка отправки ищется только внутри панели ввода, поэтому у
  // редактора должна быть цепочка предков. Панель — ближайший предок с
  // кнопками, как `div.bg-surface-secondary…rounded-b-none` в живой разметке.
  const box = el("DIV", { id: "composer-box", querySelectorAll: () => (sendBtn ? [sendBtn] : []) });
  if (editor) editor.parentElement = box;
  const messages = [];
  if (skip) {
    const skipBtn = el("BUTTON", { text: "Skip", id: "skip" });
    skipBtn.click = () => { out.clicks.push("skip"); messages.length = 0; };
    messages.push({ querySelectorAll: () => (messages.length ? [skipBtn] : []) });
  }
  // 1.4.40: окно проверки. `captcha` — видна сразу, `captchaAfterClick` —
  // появляется, как в жизни: после клика по Send, вместо отправки.
  const captchaNow = () => captcha || (captchaAfterClick && sent.length > 0);
  const captchaEl = captcha || captchaAfterClick
    ? {
        isConnected: true,
        textContent: "Security Verification",
        getClientRects: () => [{}],
        querySelector: (sel) => (sel.includes("recaptcha") ? { found: true } : null),
        contains: () => false,
        closest: () => null,
      }
    : null;
  const document = {
    querySelector: (sel) => (sel.includes("contenteditable") ? editor : null),
    querySelectorAll: (sel) => {
      if (sel.includes('role="dialog"')) return captchaNow() ? [captchaEl] : [];
      if (sel.includes("data-user-message-layout")) return sent;
      if (sel.includes("data-agent-transcript-message")) return messages.length ? [messages[0]] : [];
      if (sel.includes("border-border-medium")) return panels.length ? panels : [];
      if (sel.includes("contenteditable") || sel.includes("ProseMirror") || sel.includes("textbox")) return editor ? [editor] : [];
      if (sel.includes("button")) return stop ? [el("BUTTON", { "aria-label": "Stop generating" })] : sendBtn ? [sendBtn] : [];
      return [];
    },
    elementFromPoint: (_x, y) => {
      const blocker = { isConnected: true, contains: () => false };
      if (y === 555) return sendCovered ? blocker : sendBtn || editor;  // центр кнопки Send
      if (overlay && (stickyOverlay || panels.length || messages.length)) return blocker;
      return editor;
    },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (_cmd, _ui, text) => {
      if (editor) editor.innerText = text;
      return true;
    },
  };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }), innerWidth: 1200, innerHeight: 800 };
  const FakeDate = { now: () => state.now };

  const fn = new Function(
    "GM_getValue", "GM_setValue", "K", "norm", "roleFromPath", "visible", "lastMessageId",
    "setStatus", "log", "pause", "releaseUndelivered", "sleep", "tick", "location", "document", "window",
    "getComputedStyle", "Date", "setTimeout", "HTMLTextAreaElement", "HTMLInputElement", "InputEvent",
    "busySettled", "busyLabel", "messages", "nodeId", "idTime", "C", "dbg", "debugSendButton", "describe", "autoOn", "flat", "ui",
    "appReady", "roleRows",
    // D-044: уборка фантомов ищет квитанцию/реплику выдачи в чате.
    "isUuid", "userMessages", "messageRaw",
    // 1.4.78: проверка Continue перед отправкой.
    "waitFor", "patience", "mergedFlag",
    `${promptShim}\n${sendBlock}\n${contBlock}\nreturn { consumePending, closeCompletionPlaque, ensureComposer };`,
  );
  const api = fn(
    (k, d) => (out.sets.has(k) ? out.sets.get(k) : k === "cfn-pending" ? pending : k === "cfn-expect" ? expectState : d),
    (k, v) => out.sets.set(k, v),
    { pending: "cfn-pending", expect: "cfn-expect" },
    (x) => String(x || "").replace(/-/g, "").toLowerCase(),
    () => "coordinator",
    (e) => Boolean(e && e.isConnected && e.getClientRects().length),
    () => "m1",
    () => {},
    (text, error, options) => out.logs.push({ text, error: Boolean(error), options }),
    (text, ctx) => out.pauses.push({ text, ctx }),
    async (gone, why) => {
      out.rollback.calls.push({ expect: gone, why });
      return out.rollback.result;
    },
    async (ms) => advance(ms),
    () => {},
    { assign() {} },
    document,
    window,
    () => ({ visibility: "visible", display: "block" }),
    FakeDate,
    (cbFn, ms) => out.timers.push(ms),
    function () {},
    function () {},
    function (type, init) { return { type, ...init }; },
    // Один кадр ничего не доказывает: busySettled подтверждает признак вторым
    // чтением, а busyLabel объясняет, что именно нашлось.
    async () => (stop ? { kind: "stop", label: "Stop generating", where: " в поле ввода" } : null),
    (reason) => (reason ? `кнопка «${reason.label}»${reason.where || ""}` : ""),
    () => [],
    (n) => String(n.id || "").replace("chat-message-", ""),
    // id-время у фейковых сообщений — текущий момент фейковых часов.
    () => state.now,
    { maxLog: 200, pendingTtlMs: 600000, replyWaitMs: 1800000, sendVerifyMs: 6000, sendReadyMs: 20000, clickReadyMs: 8000 },
    () => {},
    (ed) => ({ found: Boolean(ed), covered: sendCovered }),
    (el) => (el ? String(el.tagName || "?").toLowerCase() : "нет"),
    () => false,
    (x) => String(x || "").replace(/[\s\u00a0]+/g, " ").trim().toLowerCase(),
    { panel: "cfn-panel" },
    // 1.4.63: шаг начинается с проверки, что страница отрисована.
    () => ({ ok: true, why: "" }),
    // 1.4.92: доставка рабочей или старой очереди проверяет актуальную роль.
    async () => [{ id: pending?.roleId, name: expectState?.roleName || "Coordinator", fn: expectState?.kind === "dispatch" ? "Executor" : "Coordinator", status: "Активна" }],
    (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || "")),
    () => [],
    (n) => String(n?.textContent || ""),
    // 1.4.78: на фейковой странице Continue нет — проверка проходит вхолостую.
    async (check) => (check() || null),
    (ms) => ms,
    () => false,
  );
  return { api, out };
};

// innerText и textContent у настоящего редактора — одно и то же поле.
const freshEditor = (text = "") => {
  let value = text;
  return {
    tagName: "DIV", isConnected: true,
    get innerText() { return value; },
    set innerText(v) { value = v; },
    get textContent() { return value; },
    set textContent(v) { value = v; },
    focus() {}, getClientRects: () => [{}], closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 300, height: 60 }),
    contains: () => false, querySelectorAll: () => [], dispatchEvent() {},
  };
};

const pending = { roleId: "coordinator", text: "план, пожалуйста", at: 999_000 };

// 6.1. Обычный случай: задание вставлено и отправлено.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true });
  assert.equal(await api.consumePending(true), true, 'pending обработан');
  assert.deepEqual(out.clicks, ["send"], 'нажата именно Send');
  assert.equal(out.sets.get("cfn-pending"), null, 'очередь очищена');
  assert.ok(
    out.logs.some((l) => /^Задание отправлено \(\d+ символов, сообщение m1\)\.$/.test(l.text)),
    'в журнале есть отправка, её длина и id подтвердившего сообщения',
  );
}

// 6.1c. Повторная выдача той же карточки (28.10, 19:38): в чате уже лежит
// прошлое сообщение с тем же ключом, а клик по Send ничего не отправляет.
// До 1.4.84 такая реплика считалась доставкой — журнал писал «Задание
// отправлено», текст оставался в поле, и цикл ждал ответа впустую.
{
  const { api, out } = load({
    pending,
    editor: freshEditor(),
    send: true,
    sentAlready: true,
    deadSend: true,
    rollback: true,
  });
  assert.equal(await api.consumePending(true), true, 'шаг занят отказом отправки');
  assert.ok(out.clicks.length >= 1, 'клик по Send был');
  assert.ok(
    !out.logs.some((l) => /^Задание отправлено/.test(l.text)),
    'старое сообщение в чате не выдано за отправку',
  );
  assert.equal(out.sets.get('cfn-pending')?.undelivered, true, 'задание осталось в очереди');
  assert.ok(
    out.pauses.some((p) => /сообщение не ушло|Send нажат/i.test(p.text)),
    'Мастеру сказано, что сообщение не ушло',
  );
}

// 6.1b. Отправка ставит отметку sentAt — по ней отличают доставленное от фантома.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true, expect: { roleId: "coordinator", kind: "plan" } });
  await api.consumePending(true);
  const saved = out.sets.get("cfn-expect");
  assert.equal(typeof saved?.sentAt, "number", 'sentAt записан в момент Send');
  assert.equal(saved?.kind, "plan", 'остальные поля ожидания сохранены');
}

// Подтверждённая доставка сообщает карточку и роль ровно один раз; мёртвый
// Send не должен создавать ложный пуш о начале работы.
{
  const expect = { kind: 'dispatch', roleId: 'coordinator', roleName: 'Tools', ref: 'card-1', runId: 'run-1', title: 'STAB-1.18 · bundle', text: pending.text };
  const ok = load({ pending, expect, editor: freshEditor(), send: true });
  await ok.api.consumePending(true);
  const delivery = ok.out.logs.filter((row) => row.options?.ntfyKey === 'dispatch-sent:card-1:run-1');
  assert.equal(delivery.length, 1, 'подтверждённая доставка порождает одну веху');
  assert.equal(delivery[0].options.ntfy, 'quiet');
  assert.match(delivery[0].options.ntfyText, /STAB-1\.18.*Tools/);
  const delivered = ok.out.sets.get('cfn-expect');
  assert.ok(delivered.sentAt > 0, 'сначала сохраняется момент доставки');
  assert.equal(delivered.dispatchSentAt, delivered.sentAt, 'для времени работы запомнена первая отправка карточки');

  const reminder = load({ pending, expect: { ...expect, tries: 1, dispatchSentAt: 900_000 }, editor: freshEditor(), send: true });
  await reminder.api.consumePending(true);
  assert.ok(reminder.out.sets.get('cfn-expect').sentAt > 900_000, 'напоминание обновляет свою отметку');
  assert.equal(reminder.out.sets.get('cfn-expect').dispatchSentAt, 900_000, 'начало работы не заменяется временем напоминания');
  assert.ok(!reminder.out.logs.some((row) => row.options?.ntfyKey?.startsWith('dispatch-sent:')),
    'напоминание о маркере не выдаётся за повторную отправку задания');
  const resumedReminder = load({
    pending, expect: { ...expect, tries: 0, isDispatchReminder: true, dispatchSentAt: 900_000 }, editor: freshEditor(), send: true,
  });
  await resumedReminder.api.consumePending(true);
  assert.equal(resumedReminder.out.sets.get('cfn-expect').dispatchSentAt, 900_000, 'сброс счётчика паузой не меняет время');
  assert.ok(!resumedReminder.out.logs.some((row) => row.options?.ntfyKey?.startsWith('dispatch-sent:')),
    'после снятия паузы напоминание всё ещё не задание');
  const mismatched = load({ pending, expect: { ...expect, text: 'чужая очередь' }, editor: freshEditor(), send: true });
  await mismatched.api.consumePending(true);
  assert.ok(!mismatched.out.logs.some((row) => row.options?.ntfyKey?.startsWith('dispatch-sent:')),
    'при несовпадении очереди и ожидания не называем чужую карточку доставленной');
  assert.equal(mismatched.out.sets.get('cfn-expect').dispatchSentAt, undefined,
    'и не приписываем чужому ходу время этой отправки');

  const dead = load({ pending, expect, editor: freshEditor(), send: true, deadSend: true });
  await dead.api.consumePending(true);
  assert.equal(dead.out.logs.filter((row) => row.options?.ntfyKey?.startsWith('dispatch-sent:')).length, 0,
    'неподтверждённая отправка не объявляется доставленной');
}

// 6.2. Плашка завершённой задачи закрывается до вставки.
{
  const panels = [{
    isConnected: true, tagName: "DIV", getClientRects: () => [{}],
    querySelectorAll: () => [{
      isConnected: true, tagName: "BUTTON", getClientRects: () => [{}],
      getAttribute: () => "Close",
      click: () => panels.splice(0),
    }],
    querySelector: () => null,
  }];
  const { api, out } = load({ pending, editor: freshEditor(), send: true, panels, overlay: true });
  await api.consumePending(true);
  assert.ok(!out.logs.some((l) => /Убрал плашку/.test(l.text)), 'карточка не трогается, если поле ввода есть: нет мигания');
  assert.deepEqual(out.clicks, ["send"], 'задание ушло');
}

// 6.2b. Карточка с кнопкой Skip тоже освобождает чат.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true, skip: true, overlay: true });
  await api.consumePending(true);
  assert.ok(!out.clicks.includes("skip"), 'карточка Skip не трогается, если поле ввода есть');
  assert.equal(out.clicks.at(-1), "send", 'задание отправлено');
}

// 6.2c. Редактор накрыт карточкой, но поле и Send доступны: пишем и отправляем.
//      Программный ввод и click() оверлей не замечают — блокировать нечего.
{
  const editor = freshEditor();
  editor.getBoundingClientRect = () => ({ left: 10, top: 10, width: 200, height: 40 });
  editor.contains = () => false;
  const { api, out } = load({ pending, editor, send: true, overlay: true, stickyOverlay: true });
  await api.consumePending(true);
  assert.equal(out.sets.get("cfn-pending"), null, 'задание отправлено, несмотря на карточку');
  assert.deepEqual(out.clicks, ["send"], 'клик по Send сделан');
  assert.equal(out.pauses.length, 0, 'лишней паузы нет');
}

// 6.3. Нет редактора: объяснение с диагностикой и повтор, без зависания.
{
  const { api, out } = load({ pending, editor: null, send: true });
  assert.equal(await api.consumePending(true), true, 'ожидание редактора держит ход');
  const line = out.logs.find((l) => /Не нашёл поле ввода/.test(l.text));
  assert.ok(line, 'сказано, что редактора нет');
  assert.match(line.text, /contenteditable \d+/, 'в строке есть диагностика разметки');
  assert.deepEqual(out.timers, [5000], 'назначен повтор');
}

// 6.4. Агент ещё отвечает: ждём, ничего не нажимаем.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true, stop: true });
  await api.consumePending(true);
  assert.ok(out.logs.some((l) => /Агент ещё отвечает/.test(l.text)), 'ожидание объяснено');
  assert.deepEqual(out.clicks, [], 'ничего не нажато');
}

// 6.5. Редактор есть, Send нет: пауза, а не тишина.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: false });
  await api.consumePending(true);
  assert.equal(out.pauses.length, 1, 'пауза поставлена');
  assert.match(out.pauses[0].text, /Кнопка Send неактивна или не найдена/);
  assert.match(out.pauses[0].text, /в поле \d+ симв/, 'пауза объясняет, что видно на странице');
  assert.match(out.pauses[0].text, /кнопка не найдена/, 'видно, что кнопки Send нет');
}

// 6.5a. В редакторе был текст — чистим поле и отправляем, без ложной паузы.
{
  const { api, out } = load({ pending, editor: freshEditor("черновик Мастера"), send: true });
  await api.consumePending(true);
  assert.equal(out.pauses.length, 0, 'паузы из-за текста больше нет');
  assert.deepEqual(out.clicks, ["send"], 'задание отправлено');
  assert.ok(out.logs.some((l) => /очистил перед вставкой задания/.test(l.text)), 'очистка отмечена в журнале');
}

// 6.5a2. Send остаётся серым: редактор не принял ввод — пауза с точной причиной.
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true, disabledSend: true });
  await api.consumePending(true);
  assert.equal(out.pauses.length, 1, 'пауза');
  assert.match(out.pauses[0].text, /неактивна или не найдена/, 'сказано, что кнопка неактивна');
  assert.deepEqual(out.clicks, [], 'по серой кнопке не кликали');
  assert.equal(out.sets.get("cfn-pending"), undefined, 'задание осталось в очереди');
}

// 6.5b. Клик по Send не сработал: три попытки, затем пауза без ложного «отправлено».
{
  const { api, out } = load({ pending, editor: freshEditor(), send: true, deadSend: true });
  await api.consumePending(true);
  assert.equal(out.pauses.length, 1, 'пауза вместо ложного успеха');
  assert.match(out.pauses[0].text, /своё сообщение в чате не появилось/, 'причина названа');
  assert.match(out.pauses[0].text, /клик 3 без следа/, 'видно, сколько кликов не дало следа');
  assert.equal(out.clicks.filter((c) => c === "send").length, 3, 'было три попытки, ни одна не помогла');
  assert.ok(!out.logs.some((l) => l.text === "Задание отправлено."), 'ложного «отправлено» нет');
  assert.equal(out.sets.get("cfn-pending"), undefined, 'задание осталось в очереди');
}

// 6.5c. Отправка не удалась, карточка возвращена в Ready: очередь и ожидание
//      снимаются вместе со статусом — иначе ответ пришёл бы в карточку, которая
//      уже не Running, и `submitExecutor` отказался бы его записывать.
{
  const { api, out } = load({
    pending,
    editor: freshEditor(),
    send: true,
    deadSend: true,
    expect: { roleId: "coordinator", kind: "dispatch", ref: "c1" },
    rollback: true,
  });
  await api.consumePending(true);
  assert.equal(out.rollback.calls.length, 1, 'неудачная отправка снимает статус карточки');
  assert.match(out.rollback.calls[0].why, /сообщение не ушло/, 'причина записана в журнал попытки');
  // 1.4.63: ход не сбрасывается — текст остаётся в очереди с пометкой, и
  // «Продолжить» отправит его этой же карточке, без нового хода Координатора.
  assert.equal(out.sets.get("cfn-pending").undelivered, true, 'очередь сохранена и помечена');
  assert.equal(out.sets.get("cfn-expect").undelivered, true, 'ожидание сохранено: Run ID нужен для возврата в Running');
  assert.equal(out.pauses.length, 1, 'пауза остаётся: без Мастера цикл не идёт');
  assert.match(out.pauses[0].text, /без нового хода Координатора/, 'Мастеру сказано, что ход не потерян');
  assert.ok(!out.logs.some((l) => l.text === "Задание отправлено."), 'ложного «отправлено» нет');
}

// 6.5d. Капча поверх чата: ничего не нажимаем, задание остаётся в очереди.
{
  const { api, out } = load({
    pending,
    editor: freshEditor(),
    send: true,
    captcha: true,
    expect: { roleId: "coordinator", kind: "plan" },
  });
  await api.consumePending(true);
  assert.equal(out.pauses.length, 1, 'пауза вместо отправки');
  assert.match(out.pauses[0].text, /капча \(Security Verification\)/, 'причина названа прямо');
  assert.match(out.pauses[0].text, /Решите её и нажмите «Продолжить»/, 'Мастеру сказано, что делать');
  assert.equal(out.pauses[0].ctx.notifyTitle, "Relay: капча — нужен человек", 'пуш отличается от обычной паузы');
  assert.deepEqual(out.clicks, [], 'по Send не кликали');
  assert.equal(out.sets.get("cfn-pending"), undefined, 'задание осталось в очереди');
  assert.equal(out.sets.get("cfn-expect"), undefined, 'ожидание не тронуто');
}

// 6.5d2. Капча появилась вместо отправки: откат отметки, а не ложное «отправлено».
{
  const { api, out } = load({
    pending,
    editor: freshEditor(),
    send: true,
    captchaAfterClick: true,
    expect: { roleId: "coordinator", kind: "dispatch", ref: "c1", sentAt: 999_000, verified: true },
  });
  await api.consumePending(true);
  const saved = out.sets.get("cfn-expect");
  assert.equal(saved?.sentAt, null, 'отметка «отправлено» снята — это и есть откат');
  assert.equal(saved?.verified, false, 'подтверждение доставки снято');
  assert.equal(saved?.captcha, true, 'видно, почему ход стоит');
  assert.equal(out.rollback.calls.length, 0, 'карточка остаётся Running: ход ждёт человека, а не потерян');
  assert.ok(!out.logs.some((l) => l.text === "Задание отправлено."), 'ложного «отправлено» нет');
}

// 6.5d3. Капчу решили, сообщение всё-таки в чате: не дублируем, ждём ответа.
{
  const carried = { ...pending, captcha: true, at: 999_000 };
  const { api, out } = load({
    pending: carried,
    editor: freshEditor(),
    send: true,
    sentAlready: true,
    expect: { roleId: "coordinator", kind: "plan", captcha: true },
  });
  assert.equal(await api.consumePending(true), true, 'шаг занят ожиданием ответа');
  assert.equal(out.sets.get("cfn-pending"), null, 'очередь снята');
  const saved = out.sets.get("cfn-expect");
  assert.equal(typeof saved?.sentAt, "number", 'теперь доставка подтверждена');
  assert.equal(saved?.captcha, false, 'признак капчи снят');
  assert.deepEqual(out.clicks, [], 'повторной отправки нет');
  assert.ok(out.logs.some((l) => /После капчи сообщение уже в чате/.test(l.text)), 'видно, почему не отправили заново');
  const dispatched = load({
    pending: carried, editor: freshEditor(), send: true, sentAlready: true,
    expect: { roleId: 'coordinator', roleName: 'Tools', kind: 'dispatch', ref: 'card-1', runId: 'run-1', title: 'STAB-1.18', text: carried.text, captcha: true, seen: [] },
  });
  await dispatched.api.consumePending(true);
  const notice = dispatched.out.logs.find((row) => row.options?.ntfyKey === 'dispatch-sent:card-1:run-1');
  assert.match(notice.options.ntfyText, /STAB-1\.18.*Tools/, 'подтверждённая доставка после капчи тоже сообщает задание и роль');
  assert.equal(dispatched.out.sets.get('cfn-expect').dispatchSentAt, dispatched.out.sets.get('cfn-expect').sentAt);
  assert.deepEqual(dispatched.out.clicks, [], 'дополнительной отправки при этом нет');
  const legacy = load({
    pending: carried, editor: freshEditor(), send: true, sentAlready: true,
    expect: { roleId: 'coordinator', roleName: 'Tools', kind: 'dispatch', ref: 'card-1', runId: 'run-1', title: 'STAB-1.18', text: carried.text, captcha: true },
  });
  await legacy.api.consumePending(true);
  assert.ok(legacy.out.logs.some((row) => /После капчи сообщение уже в чате/.test(row.text)), 'старая совместимость не меняется');
  assert.ok(!legacy.out.logs.some((row) => row.options?.ntfyKey?.startsWith('dispatch-sent:')),
    'без снимка старую реплику не выдаём за достоверный push о доставке');
  assert.equal(legacy.out.sets.get('cfn-expect').dispatchSentAt, 0, 'ненадёжное время не выдаём за начало работы');
}

// 6.5.1. Просроченная очередь: снимаем, объясняем и продолжаем шаг.
{
  const old = { ...pending, at: 1_000_000 - 11 * 60 * 1000 };
  const { api, out } = load({ pending: old, editor: null, send: true, expect: { roleId: "coordinator", at: old.at } });
  assert.equal(await api.consumePending(true), false, 'просрочка не держит ход по нажатию');
  assert.equal(out.sets.get("cfn-pending"), null, 'очередь очищена');
  assert.equal(out.sets.get("cfn-expect"), null, 'ожидание той же роли снято');
  assert.ok(out.logs.some((l) => /Снял просроченную отправку/.test(l.text) && l.error), 'причина видна и помечена как проблема');
  assert.ok(!out.logs.some((l) => /Задание отправлено/.test(l.text)), 'просроченное не отправляется');
  assert.deepEqual(out.clicks, [], 'ничего не нажато');
  assert.deepEqual(out.timers, [], 'повтор не назначается');
}

// 6.5.1a. Просрочка снимает и статус карточки: хода не было ни разу.
{
  const old = { ...pending, at: 1_000_000 - 11 * 60 * 1000 };
  const { api, out } = load({
    pending: old,
    editor: null,
    send: true,
    expect: { roleId: "coordinator", kind: "dispatch", ref: "c1", at: old.at },
    rollback: true,
  });
  await api.consumePending(true);
  assert.equal(out.rollback.calls.length, 1, 'просроченная отправка возвращает карточку в Ready');
  assert.match(out.rollback.calls[0].why, /просрочена/, 'причина названа');
}

// 6.5.1b. Та же просрочка, но без нажатия: убираем и останавливаемся.
{
  const old = { ...pending, at: 1_000_000 - 11 * 60 * 1000 };
  const { api, out } = load({ pending: old, editor: null, send: true });
  assert.equal(await api.consumePending(false), true, 'без нажатия шаг не начинается');
  assert.equal(out.sets.get("cfn-pending"), null, 'но очередь очищена');
  assert.ok(out.logs.some((l) => /Нажмите «Шаг»/.test(l.text)), 'Мастеру сказано, что делать');
}

// 6.5.2. Просроченная очередь чужой роли: снимаем на любой странице.
// 1.4.44: 24.10 карточка NAR-1.12 осталась Running, потому что Мастер стоял не
// на странице адресата. Очередь просрочена — сообщения в чате нет, значит и
// ожиданию держаться не за что, а карточке — тем более.
{
  const old = { ...pending, roleId: "kernel", at: 1_000_000 - 11 * 60 * 1000 };
  const { api, out } = load({
    pending: old,
    editor: null,
    send: true,
    expect: { roleId: "kernel", kind: "dispatch", ref: "c1", at: old.at },
    rollback: true,
  });
  await api.consumePending(true);
  assert.equal(out.sets.get("cfn-pending"), null, 'очередь очищена в любом случае');
  assert.equal(out.sets.get("cfn-expect"), null, 'ожидание снято: это остаток прошлой попытки, а не ход');
  assert.equal(out.rollback.calls.length, 1, 'карточка возвращена в Ready');
}

// 6.5.2b. Ожидание, у которого есть отметка отправки, не снимается.
{
  const old = { ...pending, roleId: "kernel", at: 1_000_000 - 11 * 60 * 1000 };
  const { api, out } = load({
    pending: old,
    editor: null,
    send: true,
    expect: { roleId: "kernel", kind: "dispatch", ref: "c1", at: old.at, sentAt: old.at, verified: true },
  });
  await api.consumePending(true);
  assert.equal(out.sets.get("cfn-pending"), null, 'очередь очищена');
  assert.equal(out.sets.get("cfn-expect"), undefined, 'сообщение в чате есть — ожидание остаётся');
  assert.equal(out.rollback.calls.length, 0, 'карточку не трогали');
}

// 6.6. Чужое задание не трогаем.
{
  const { api, out } = load({ pending: { ...pending, roleId: "kernel" }, editor: null, send: true });
  assert.equal(await api.consumePending(true), false, 'чужой ход не наш');
  assert.equal(out.logs.length, 0, 'и журнал не засоряется');
}

console.log("OK: relay 1.4.44 — «Шаг» с любой страницы, чат освобождается от плашки и Skip, каждый отказ объяснён");
