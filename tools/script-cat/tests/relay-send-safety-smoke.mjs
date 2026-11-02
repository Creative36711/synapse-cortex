// Проба 1.4.25: кнопки ищутся только внутри панели ввода.
//
// Разметка — по факту со страницы агента (прислал Мастер 23.10):
//
//   div.group/sidebar-wrapper
//   ├ div[class*="sidebar"] … > ul > button        ← аккаунт Мастера
//   └ main
//     └ div.relative.flex.min-w-0.flex-1.flex-col
//       ├ … кнопки Merge PR, ветка (выше панели)
//       └ div.bg-surface-secondary…rounded-b-none   ← панель ввода
//         ├ div.editor-content > div.tiptap.ProseMirror[contenteditable] > p
//         └ div.flex.justify-between.gap-4
//           ├ div:nth-child(1) > button             ← скрепка / модель
//           └ div:nth-child(2) > button             ← Send
//
// Правило: кнопка отправки — только внутри панели ввода. Аккаунт в сайдбаре,
// «Merge PR» и что угодно ещё вне панели не рассматриваются даже как запасной
// путь: 23.10 в 22:02 «первая доступная кнопка» оказалась аккаунтом, и три
// клика ушли туда.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 40)}`);
  return src.slice(a, b);
};

// ── Мини-дерево ───────────────────────────────────────────────────────────
function makeNode({ tag = 'DIV', cls = '', label = '', text = '', disabled = false, box = null, sidebar = false, children = [] } = {}) {
  const el = {
    tagName: tag,
    isConnected: true,
    alive: true,
    className: cls,
    textContent: text,
    disabled,
    sidebar,
    children,
    parentElement: null,
    focus() {},
    dispatchEvent() {},
    getBoundingClientRect: () => box || { left: 0, top: 0, width: 0, height: 0 },
    getAttribute(name) {
      if (name === 'aria-label') return label || null;
      if (name === 'aria-disabled' || name === 'data-disabled') return null;
      if (name === 'type') return tag === 'INPUT' ? 'submit' : null;
      return null;
    },
    classList: { contains: () => false },
    get lastElementChild() {
      return children.length ? children[children.length - 1] : null;
    },
  };
  const walk = (predicate) => {
    const out = [];
    const stack = [...children];
    while (stack.length) {
      const n = stack.shift();
      if (predicate(n)) out.push(n);
      stack.unshift(...(n.children || []));
    }
    return out;
  };
  el.querySelectorAll = (sel) => {
    if (sel === 'main') return walk((n) => n.tagName === 'MAIN');
    if (/button|role="button"/.test(sel)) return walk((n) => n.tagName === 'BUTTON');
    return [];
  };
  el.contains = (n) => walk((x) => x === n).length > 0;
  el.querySelector = (sel) => (sel === 'main' ? walk((n) => n.tagName === 'MAIN')[0] || null : null);
  el.closest = (sel) => {
    let cur = el;
    while (cur) {
      if (/sidebar/.test(sel) && cur.sidebar === true) return cur;
      if (/sidebar/.test(sel) && /sidebar/.test(cur.className || '')) return cur;
      if (/captcha/.test(sel) && /captcha/.test(cur.className)) return cur;
      if (/^nav|aside/.test(sel) && /nav|aside/.test(cur.tagName.toLowerCase())) return cur;
      if (sel === `#cfn-panel` && cur.id === 'cfn-panel') return cur;
      if (sel === 'form' && cur.tagName === 'FORM') return cur;
      if (/\[class\*="captcha"\]|g-recaptcha/.test(sel) && /captcha/.test(cur.className)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  for (const child of children) child.parentElement = el;
  return el;
}

const R = {
  editor: { left: 340, top: 700, width: 720, height: 60 },
  send: { left: 1020, top: 720, width: 28, height: 28 },
  attach: { left: 360, top: 720, width: 24, height: 24 },
  account: { left: 10, top: 640, width: 220, height: 40 },
  merge: { left: 900, top: 200, width: 120, height: 32 },
};

const visible = () => true;
const completionPanels = () => [];
const ui = { panel: 'cfn-panel' };

const buildPage = ({ sendLabel = 'Send', sendDisabled = false, withStop = false, noSend = false } = {}) => {
  const account = makeNode({ tag: 'BUTTON', label: 'kreative36711@gmail.com', box: R.account });
  const sidebar = makeNode({ cls: 'group/sidebar-wrapper fixed sidebar', box: { left: 0, top: 0, width: 260, height: 900 }, children: [account] });
  sidebar.sidebar = true;

  const send = makeNode({
    tag: 'BUTTON',
    label: sendLabel,
    box: R.send,
    disabled: sendDisabled,
  });
  const attach = makeNode({ tag: 'BUTTON', label: 'Attach', box: R.attach });
  const stop = makeNode({ tag: 'BUTTON', label: 'Stop generating', box: R.send });

  const rightGroup = makeNode({ children: noSend ? (withStop ? [stop] : []) : [send] });
  const toolbar = makeNode({
    cls: 'flex justify-between gap-4',
    children: [makeNode({ children: [attach] }), rightGroup],
  });
  const paragraph = makeNode({ tag: 'P', cls: 'is-editor-empty', box: R.editor });
  const editor = makeNode({ cls: 'tiptap ProseMirror prose', box: R.editor, children: [paragraph] });
  const editorContent = makeNode({ cls: 'editor-content max-h-[40vh]', children: [editor] });
  const box = makeNode({ cls: 'bg-surface-secondary rounded-[14px] rounded-b-none', box: { left: 320, top: 680, width: 760, height: 120 }, children: [editorContent, toolbar] });
  const merge = makeNode({ tag: 'BUTTON', label: 'Merge PR', box: R.merge });

  const chat = makeNode({ children: [merge] });
  const column = makeNode({ cls: 'relative flex min-w-0 flex-1 flex-col', children: [chat, box] });
  const main = makeNode({ tag: 'MAIN', children: [column] });
  // Вся страница обёрнута в `div.group/sidebar-wrapper` — в классе тоже
  // «sidebar». На этом 1.4.25 и сломался: фильтр выбросил вместе с сайдбаром
  // и main с полем ввода.
  const root = makeNode({ cls: 'group/sidebar-wrapper has-[[data-variant=inset]]:bg-sidebar flex min-h-svh w-full', children: [sidebar, main] });

  const all = (sel) => {
    if (sel.includes('button')) {
      return [account, send, attach, stop, merge].filter((b) => (b === stop ? withStop : true));
    }
    return [];
  };
  const document = {
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable') || sel.includes('ProseMirror') || sel.includes('textbox') || sel.includes('editor-content')) {
        return [editor];
      }
      return all(sel);
    },
    querySelector: () => null,
    contains: (n) => Boolean(n) && n.alive !== false,
  };
  const api = new Function(
    'document', 'visible', 'completionPanels', 'ui',
    `${cut('  /** Свой пульт ScriptCat', '  function writePrompt(')}; return { sendButton, composerBox, composer, inSidebar };`,
  )(document, visible, completionPanels, ui);
  return { ...api, editor, send, account, attach, merge, box, stop, root, document };
};

// ── 1. Панель ввода найдена: это контейнер, а не main ────────────────────
{
  const p = buildPage();
  const box = p.composerBox(p.editor);
  assert.equal(box, p.box, 'панель ввода — ближайший предок с кнопками');
  assert.equal(p.sendButton(p.editor), p.send, 'выбрана кнопка отправки');
}

// ── 2. Аккаунт в сайдбаре не выбирается никогда ─────────────────────────
{
  const p = buildPage({ noSend: true });
  assert.equal(p.sendButton(p.editor), null, 'нет Send — не нажимаем ничего, а не аккаунт');
  assert.notEqual(p.sendButton(p.editor), p.account, 'аккаунт исключён');
  assert.equal(p.inSidebar(p.account), true, 'аккаунт распознан как сайдбар');
}

// ── 3. «Merge PR» вне панели не участвует, даже если это единственная кнопка ──
{
  const p = buildPage({ noSend: true });
  assert.notEqual(p.sendButton(p.editor), p.merge, 'кнопка Merge PR не считается отправкой');
}

// ── 4. Кнопка без подписи (одна иконка) — последняя в ряду панели ────────
{
  const p = buildPage({ sendLabel: '' });
  assert.equal(p.sendButton(p.editor), p.send, 'иконка без подписи тоже находится');
}

// ── 5. Серая кнопка (пустое поле) не выбирается ──────────────────────────
{
  const p = buildPage({ sendDisabled: true });
  assert.equal(p.sendButton(p.editor), null, 'неактивная Send — не кнопка');
}

// ── 6. Stop на месте Send не нажимается ─────────────────────────────────
{
  const p = buildPage({ noSend: true, withStop: true });
  assert.equal(p.sendButton(p.editor), null, 'Stop не путается с отправкой');
}

// ── 7. Поле в сайдбаре не считается полем ввода ─────────────────────────
{
  const p = buildPage();
  assert.equal(p.composer(), p.editor, 'поле ввода — редактор в main');
}

// ── 8. В коде не осталось поиска кнопок по всему документу ──────────────
const sendSrc = cut('  function sendButton(editor) {', '  /**\n   * Вставка текста в редактор.');
assert.ok(!/document\.querySelectorAll\('button/.test(sendSrc), 'кнопки не ищутся по всему документу');
assert.match(sendSrc, /const box = composerBox\(editor\);/, 'область поиска — панель ввода');
assert.match(sendSrc, /const scope = box \|\| \(editor\.closest\?\.\("form"\) \|\| null\);/, 'без панели — только форма поля');
assert.match(sendSrc, /if \(!scope\) return null;/, 'без области поиска кнопку не ищем вовсе');
assert.match(sendSrc, /!STOP_LABEL\.test/, 'Stop исключён из кандидатов');
assert.match(src, /const inSidebar = \(el\) =>/, 'сайдбар определяется по классу, а не по догадке');

// ── 9. Отвязанный редактор: кнопку не ищем вовсе ────────────────────────
{
  const p = buildPage();
  const dead = { ...p.editor, isConnected: false };
  assert.equal(p.sendButton(dead), null, 'для мёртвого поля кнопку не ищем');
}

// ── 10. Вставка в отвязанный узел не даёт успеха ────────────────────────
{
  const writeSrc =
    cut('  function composerAlive(', '  function composer() {') +
    cut('  function writePrompt(', '  const composerText =');
  const composerTextCode = src.slice(
    src.indexOf('  const composerText ='),
    src.indexOf('\n', src.indexOf('  const composerText =')) + 1,
  );
  const calls = { focus: [] };
  const mk = (name) => ({
    name, tagName: 'DIV', isConnected: true, innerText: '', textContent: '',
    focus() { calls.focus.push(name); }, dispatchEvent() {},
  });
  const live = mk('live');
  const dead = { ...mk('dead'), isConnected: false };
  const document = {
    contains: (n) => Boolean(n) && n.isConnected !== false,
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (_c, _u, text) => {
      live.innerText = text;
      live.textContent = text;
      return true;
    },
  };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  const api = new Function(
    'document', 'window', 'composer', 'visible', 'ui', 'dbg', 'log',
    'InputEvent', 'HTMLTextAreaElement', 'HTMLInputElement',
    `${writeSrc}\n${composerTextCode}; return { writePrompt, composerAlive };`,
  )(document, window, () => live, visible, ui, () => {}, () => {}, function (t, i) { return { type: t, ...i }; }, function () {}, function () {});

  assert.equal(api.writePrompt(dead, 'ЗАДАНИЕ'), true, 'вставка ушла в перечитанное поле');
  assert.equal(calls.focus.at(-1), 'live', 'фокус у живого поля');
  assert.equal(dead.textContent, '', 'в отвязанный узел ничего не пишем');
  assert.equal(live.innerText, 'ЗАДАНИЕ', 'текст в живом поле');
}

// ── 11. Обёртка страницы с «sidebar» в классе не считается сайдбаром ────
{
  const p = buildPage();
  assert.equal(p.inSidebar(p.account), true, 'аккаунт в сайдбаре — исключён');
  assert.equal(p.inSidebar(p.editor), false, 'поле ввода в main сайдбаром не считается');
  assert.equal(p.inSidebar(p.box), false, 'панель ввода сайдбаром не считается');
  assert.equal(p.composer(), p.editor, 'поле ввода находится, несмотря на sidebar-wrapper');
}

// ── 12. Диагностика говорит, почему кандидат отброшен ───────────────────
assert.match(src, /droppedSidebar \? `в сайдбаре \$\{droppedSidebar\}`/, 'в диагностике видно, сколько отброшено как «сайдбар»');
assert.match(src, /droppedHidden \? `скрытых \$\{droppedHidden\}`/, 'и сколько скрытых');

// ── 13. Запас: единственное видимое поле не теряется ────────────────────
assert.match(src, /if \(shown\.length === 1\) \{/, 'единственное видимое поле берётся запасным правилом');
assert.match(src, /composer: единственное видимое поле взято запасным правилом/, 'это видно в отладке');

console.log('OK: relay 1.4.63 — кнопки только в панели ввода, обёртка страницы не считается сайдбаром');
