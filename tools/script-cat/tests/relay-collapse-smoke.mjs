// Проба 1.4.84: окно ScriptCat сворачивается.
//
// Просьба Мастера (28.10): «Сделай так, чтобы окно приложения ScriptCat можно
// было сворачивать». Панель висит в углу страницы агента поверх чата: журнал на
// 200px и десяток кнопок закрывают текст, а убрать её совсем нельзя — она нужна
// каждый ход.
//
// Здесь проверяется: в шапке есть кнопка сворачивания, свёрнутое состояние
// прячет журнал и служебные кнопки, оставляет статус, «Стоп» и счётчики
// обратной связи прямо на кнопке, а выбор переживает перезагрузку страницы.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${String(from).trim()}`);
  return src.slice(a, b);
};

// ── 1. Разметка: кнопка есть в шапке ─────────────────────────────────────
assert.match(src, /collapse: "cfn-collapse"/, 'у кнопки свой id');
assert.match(src, /<button id="\$\{ui\.collapse\}" title="Свернуть панель"/, 'кнопка в шапке панели');
assert.match(src, /document\.getElementById\(ui\.collapse\)\.onclick = \(\) => togglePanel\(\);/, 'клик переключает состояние');
assert.match(src, /collapsed: "cfn-panel-collapsed"/, 'состояние хранится в ScriptCat');
assert.match(src, /paintPanelChrome\(\);\n    paintQuestions/, 'свёрнутое окно не теряет счётчик вопросов');

// ── 2. Поведение на поддельном DOM ───────────────────────────────────────
const block = cut('  /**\n   * Свёрнутая панель.', '  function mount() {');

function makeDom() {
  const elements = new Map();
  const make = (id) => {
    const el = {
      id,
      textContent: '',
      title: '',
      style: {},
      classes: new Set(),
      classList: {
        toggle(name, on) {
          if (on) el.classes.add(name);
          else el.classes.delete(name);
        },
      },
    };
    elements.set(id, el);
    return el;
  };
  for (const id of [
    'cfn-panel',
    'cfn-log',
    'cfn-status',
    'cfn-toggle',
    'cfn-stop',
    'cfn-step',
    'cfn-ntfy',
    'cfn-questions',
    'cfn-gh',
    'cfn-debug-toggle',
    'cfn-reset',
    'cfn-clear',
    'cfn-setup',
    'cfn-collapse',
    'cfn-q-badge',
  ]) {
    make(id);
  }
  return {
    elements,
    document: { getElementById: (id) => elements.get(id) || null },
  };
}

function makePanel() {
  const store = new Map();
  const dom = makeDom();
  const ui = {
    panel: 'cfn-panel',
    log: 'cfn-log',
    status: 'cfn-status',
    toggle: 'cfn-toggle',
    step: 'cfn-step',
    ntfy: 'cfn-ntfy',
    questions: 'cfn-questions',
    gh: 'cfn-gh',
    debug: 'cfn-debug-toggle',
    reset: 'cfn-reset',
    clear: 'cfn-clear',
    setup: 'cfn-setup',
    collapse: 'cfn-collapse',
    qBadge: 'cfn-q-badge',
  };
  const api = new Function(
    'document',
    'GM_getValue',
    'GM_setValue',
    'K',
    'ui',
    `${block}\nreturn { panelCollapsed, paintPanelChrome, togglePanel };`,
  )(
    dom.document,
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    { collapsed: 'cfn-panel-collapsed' },
    ui,
  );
  return { ...api, store, el: dom.elements, ui };
}

{
  const p = makePanel();
  assert.equal(p.panelCollapsed(), false, 'по умолчанию панель развёрнута');

  p.paintPanelChrome();
  assert.equal(p.el.get('cfn-panel').style.width, '360px', 'развёрнутая ширина');
  assert.equal(p.el.get('cfn-log').style.display, '', 'журнал виден');
  assert.equal(p.el.get('cfn-step').style.display, '', 'кнопки видны');
  assert.equal(p.el.get('cfn-collapse').textContent, '▾', 'стрелка вниз');

  p.togglePanel();
  assert.equal(p.store.get('cfn-panel-collapsed'), true, 'состояние запомнено');
  assert.equal(p.el.get('cfn-panel').style.width, '208px', 'свёрнутая ширина');
  assert.equal(p.el.get('cfn-log').style.display, 'none', 'журнал скрыт');
  assert.equal(p.el.get('cfn-status').style.maxWidth, '120px', 'статус укорочен, но виден');
  assert.equal(p.el.get('cfn-step').style.display, 'none', 'служебные кнопки скрыты');
  assert.equal(p.el.get('cfn-questions').style.display, 'none', 'кнопка вопросов уходит в счётчик');
  assert.notEqual(p.el.get('cfn-stop').style.display, 'none', '«Стоп» остаётся под рукой');
  assert.notEqual(p.el.get('cfn-toggle').style.display, 'none', '«Включить/Стоп» цикла тоже');
  assert.ok(p.el.get('cfn-panel').classes.has('cfn-panel-collapsed'), 'класс свёрнутого окна выставлен');
  assert.ok(p.el.get('cfn-collapse').textContent.startsWith('▸'), 'стрелка вправо');

  // Счётчики видны прямо на кнопке: свёрнутое окно не прячет работу.
  p.el.get('cfn-q-badge').textContent = '2';
  p.paintPanelChrome();
  assert.match(p.el.get('cfn-collapse').textContent, /💬2/, 'единая обратная связь видна в свёрнутом окне');
  assert.doesNotMatch(p.el.get('cfn-collapse').textContent, /⚖/, 'отдельного счётчика ADR нет');
  assert.match(p.el.get('cfn-collapse').title, /Развернуть панель/, 'подсказка говорит, что делать');

  p.togglePanel();
  assert.equal(p.store.get('cfn-panel-collapsed'), false, 'разворачивание тоже помнится');
  assert.equal(p.el.get('cfn-log').style.display, '', 'журнал вернулся');
  assert.equal(p.el.get('cfn-collapse').textContent, '▾', 'стрелка снова вниз');
}

// ── 3. Состояние переживает перезагрузку страницы ─────────────────────────
{
  const store = new Map([['cfn-panel-collapsed', true]]);
  const dom = makeDom();
  const ui = {
    panel: 'cfn-panel',
    log: 'cfn-log',
    status: 'cfn-status',
    toggle: 'cfn-toggle',
    step: 'cfn-step',
    ntfy: 'cfn-ntfy',
    questions: 'cfn-questions',
    gh: 'cfn-gh',
    debug: 'cfn-debug-toggle',
    reset: 'cfn-reset',
    clear: 'cfn-clear',
    setup: 'cfn-setup',
    collapse: 'cfn-collapse',
    qBadge: 'cfn-q-badge',
  };
  const api = new Function(
    'document',
    'GM_getValue',
    'GM_setValue',
    'K',
    'ui',
    `${block}\nreturn { panelCollapsed, paintPanelChrome };`,
  )(
    dom.document,
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    { collapsed: 'cfn-panel-collapsed' },
    ui,
  );
  assert.equal(api.panelCollapsed(), true, 'свёрнутое состояние прочитано');
  api.paintPanelChrome();
  assert.equal(dom.elements.get('cfn-log').style.display, 'none', 'после перезагрузки журнал скрыт');
}

console.log('collapse: 24 проверки — ok');
