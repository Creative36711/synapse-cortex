// Мини-фикстуры DOM для provisioning: без реального браузера и без radix-* id.
// Селекторы исполняются из src/32-provision-dom.js; фикстуры доказывают, что
// код опирается на data-sidebar/cmdk/role/aria, а не на случайные id.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');

export class MockElement {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this._text = text;
    this._visible = true;
    this._value = '';
    this.disabled = false;
    this.events = [];
    this.onclick = null;
    this.style = {};
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  contains(other) {
    let node = other;
    while (node) { if (node === this) return true; node = node.parentElement; }
    return false;
  }
  closest(selector) {
    let node = this;
    while (node) { if (matchesSelector(node, selector)) return node; node = node.parentElement; }
    return null;
  }
  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  dispatchEvent(event) { this.events.push(event); if (event.type === 'input' && this.oninput) this.oninput(event); return true; }
  click() { CLICKS.push(this); if (this.onclick) this.onclick({ target: this }); }
  getBoundingClientRect() { return { width: this._visible ? 100 : 0, height: this._visible ? 20 : 0, left: 0, top: 0 }; }
}
export const CLICKS = [];

function parseCompound(part) {
  const out = { tag: null, attrs: [], id: null, classes: [] };
  const re = /([a-zA-Z][\w-]*)|\[([\w-]+)(?:([~|^$*]?=)"([^"]*)")?\]|#([\w-]+)|\.([\w-]+)/g;
  let m;
  while ((m = re.exec(part))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.attrs.push({ name: m[2], op: m[3] || '', value: m[4] });
    else if (m[5]) out.id = m[5];
    else if (m[6]) out.classes.push(m[6]);
  }
  return out;
}
function matchesCompound(el, part) {
  const spec = parseCompound(part.trim());
  if (spec.tag && el.tagName !== spec.tag) return false;
  if (spec.id && el.id !== spec.id) return false;
  for (const a of spec.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (!a.op) continue;
    const value = el.getAttribute(a.name);
    if (a.op === '=' && value !== a.value) return false;
    if (a.op === '^=' && !value.startsWith(a.value)) return false;
    if (a.op === '$=' && !value.endsWith(a.value)) return false;
    if (a.op === '*=' && !value.includes(a.value)) return false;
  }
  return true;
}
export function matchesSelector(el, selector) {
  return String(selector).split(',').some((group) => {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    if (!matchesCompound(el, parts.at(-1))) return false;
    let node = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      let found = false;
      while (node) {
        if (matchesCompound(node, parts[i])) { found = true; node = node.parentElement; break; }
        node = node.parentElement;
      }
      if (!found) return false;
    }
    return true;
  });
}
function queryAll(root, selector) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}
export function visible(el) {
  let node = el;
  while (node) {
    if (node._visible === false) return false;
    if (node.attrs?.['aria-hidden'] === 'true' || node.attrs?.hidden !== undefined) return false;
    node = node.parentElement;
  }
  return true;
}
export class HTMLInputElement { get value() { return this._value || ''; } set value(v) { this._value = String(v); } }
export class HTMLTextAreaElement { get value() { return this._value || ''; } set value(v) { this._value = String(v); } }
export class Event { constructor(type, opts = {}) { this.type = type; this.bubbles = Boolean(opts.bubbles); } }

export function makeDocument() {
  const root = new MockElement('html');
  const body = root.appendChild(new MockElement('body'));
  const doc = {
    readyState: 'complete',
    documentElement: root,
    body,
    createElement: (tag) => new MockElement(tag),
    querySelectorAll: (selector) => queryAll(root, selector),
    querySelector: (selector) => queryAll(root, selector)[0] || null,
    getElementById: (id) => queryAll(root, `#${id}`)[0] || null,
  };
  return { doc, root, body };
}

export function loadDom({ doc, location, cfg = {}, composerReady = () => true, clock = { now: 0 } } = {}) {
  CLICKS.length = 0;
  const source = readFileSync(join(srcDir, '32-provision-dom.js'), 'utf8');
  const normalizeProvisionRepo = (value) => {
    let s = String(value || '').trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && !s.includes('..') ? s.toLowerCase() : '';
  };
  const sleep = async () => { clock.now += 1000; };
  const DateMock = { now: () => clock.now };
  const api = new Function(
    'document', 'location', 'visible', 'sleep', 'Date', 'Event', 'HTMLInputElement', 'HTMLTextAreaElement',
    'PROVISION_UUID', 'normalizeProvisionRepo', 'provisionConfig', 'composer', 'sendButton',
    `${source}\nreturn { provisionAgentUuid, provisionCurrentAgentUuid, provisionRepoTriggers, provisionTriggerRepo, provisionPicker, provisionRepoOption, provisionSelectRepository, provisionFindSidebarItem, provisionWaitSidebarItem, provisionOpenItemMenu, provisionMenuButton, provisionRenameDialog, provisionRenameSubmit, provisionRenameAgent, provisionArchiveAgent, ProvisionDomError, PROVISION_SEL };`,
  )(doc, location, visible, sleep, DateMock, Event, HTMLInputElement, HTMLTextAreaElement,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, normalizeProvisionRepo, () => cfg,
    () => (composerReady() ? {} : null), () => (composerReady() ? {} : null));
  return api;
}

export function makeLocation(pathname = '/') {
  const loc = {
    origin: 'https://arena.ai', pathname, search: '', hash: '',
    get href() { return this.origin + this.pathname + this.search + this.hash; },
    assign(url) { const u = new URL(url, this.origin); this.pathname = u.pathname; this.search = u.search; this.hash = u.hash; },
  };
  return loc;
}

// Строит composer + sidebar + picker. Radix-id случайные и не используются кодом.
export function buildFixture({ repo = 'owner/repo', selected = false, agentUuid = '11111111-1111-4111-8111-111111111111', roleName = 'Executor Core' } = {}) {
  const { doc, body } = makeDocument();
  const main = body.appendChild(new MockElement('main'));
  const composer = main.appendChild(new MockElement('div', { class: 'editor-content' }));
  const trigger = composer.appendChild(new MockElement('button', { 'aria-haspopup': 'dialog', 'aria-controls': 'radix-:r1:', id: 'radix-:r2:' }));
  const triggerSpan = trigger.appendChild(new MockElement('span', {}, selected ? repo : 'Select a repository'));
  const sidebar = body.appendChild(new MockElement('div', { 'data-sidebar': 'sidebar', id: 'radix-:r3:' }));
  const item = sidebar.appendChild(new MockElement('li', { 'data-sidebar': 'menu-item' }));
  const link = item.appendChild(new MockElement('a', { 'data-sidebar': 'menu-button', href: `/agent/${agentUuid}?x=1#y` }, roleName));
  const more = item.appendChild(new MockElement('button', { 'data-sidebar': 'menu-action', 'aria-haspopup': 'menu' }, 'More options'));
  const pickerWrap = body.appendChild(new MockElement('div', { 'data-radix-popper-content-wrapper': '' }));
  const pickerDialog = pickerWrap.appendChild(new MockElement('div', { role: 'dialog', 'data-state': 'open', id: 'radix-:r4:' }));
  const picker = pickerDialog.appendChild(new MockElement('div', { 'cmdk-root': '' }));
  const input = picker.appendChild(new MockElement('input', { 'cmdk-input': '', role: 'combobox' }));
  const list = picker.appendChild(new MockElement('div', { 'cmdk-list': '', role: 'listbox' }));
  const option = list.appendChild(new MockElement('div', { 'cmdk-item': '', role: 'option', 'data-value': repo }));
  option.appendChild(new MockElement('span', {}, repo));
  const addRepo = list.appendChild(new MockElement('button', {}, 'Add repositories…'));
  pickerWrap._visible = false;
  const menu = body.appendChild(new MockElement('div', { role: 'menu', 'data-state': 'open', id: 'radix-:r5:' }));
  menu._visible = false;
  const renameItem = menu.appendChild(new MockElement('div', { role: 'menuitem' }, 'Rename'));
  const archiveItem = menu.appendChild(new MockElement('div', { role: 'menuitem' }, 'Archive'));
  const dialog = body.appendChild(new MockElement('div', { role: 'dialog', 'data-state': 'open' }));
  dialog._visible = false;
  dialog.appendChild(new MockElement('h2', {}, 'Rename chat'));
  const renameInput = dialog.appendChild(new MockElement('input', { maxlength: '100' }));
  const submit = dialog.appendChild(new MockElement('button', { type: 'submit' }, 'Rename'));
  submit.disabled = true;
  let composerReady = true;
  trigger.onclick = () => { pickerWrap._visible = true; };
  option.onclick = () => { triggerSpan.textContent = repo; pickerWrap._visible = false; composerReady = true; };
  more.onclick = () => { menu._visible = true; };
  renameItem.onclick = () => { menu._visible = false; dialog._visible = true; };
  renameInput.oninput = () => { submit.disabled = renameInput.value.trim().length === 0; };
  submit.onclick = () => { link.textContent = renameInput.value.trim(); dialog._visible = false; };
  archiveItem.onclick = () => { item.remove(); menu._visible = false; };
  return { doc, body, main, trigger, triggerSpan, sidebar, item, link, more, pickerWrap, picker, input, list, option, addRepo, menu, renameItem, archiveItem, dialog, renameInput, submit, agentUuid, repo, roleName, composerReady: () => composerReady };
}
