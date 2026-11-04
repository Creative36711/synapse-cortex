// DOM provisioning: фикстуры без radix-* id и nth-child. Проверяем repo picker,
// sidebar по UUID, More options, Rename/Archive и отказ при неоднозначности.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFixture, loadDom, makeLocation, CLICKS } from './helpers/provision-dom-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', '32-provision-dom.js'), 'utf8');

test('селекторы не зависят от radix-* id и nth-child', () => {
  assert.ok(!/radix-:/.test(src), 'нет radix-* id в селекторах');
  assert.ok(!/nth-child\(/.test(src), 'нет nth-child(');
  assert.match(src, /data-sidebar="menu-button"/);
  assert.match(src, /cmdk-item/);
});

test('уже выбранный repo не кликается повторно', async () => {
  const fx = buildFixture({ selected: true });
  const api = loadDom({ doc: fx.doc, location: makeLocation('/agent'), composerReady: fx.composerReady });
  const result = await api.provisionSelectRepository(fx.repo, { agentRenameAttempts: 3 });
  assert.equal(result.alreadySelected, true);
  assert.equal(CLICKS.length, 0, 'триггер и Add repositories не нажимались');
});

test('Select a repository открывает picker и выбирает точный owner/repo', async () => {
  const fx = buildFixture({ selected: false });
  const api = loadDom({ doc: fx.doc, location: makeLocation('/agent'), composerReady: fx.composerReady });
  const result = await api.provisionSelectRepository(fx.repo, {});
  assert.equal(result.alreadySelected, false);
  assert.equal(fx.triggerSpan.textContent, fx.repo);
  assert.ok(CLICKS.includes(fx.trigger));
  assert.ok(CLICKS.includes(fx.option));
  assert.ok(!CLICKS.includes(fx.addRepo), 'Add repositories не нажимается');
  assert.equal(fx.pickerWrap._visible, false);
});

test('неоднозначный repo trigger — ошибка, а не первый подходящий', async () => {
  const fx = buildFixture({ selected: false });
  fx.main.appendChild(Object.assign(new (fx.trigger.constructor)('button', { 'aria-haspopup': 'dialog', 'aria-controls': 'x' }), {}));
  const second = fx.main.children.at(-1);
  second.appendChild(new (fx.triggerSpan.constructor)('span', {}, 'Select a repository'));
  const api = loadDom({ doc: fx.doc, location: makeLocation('/agent'), composerReady: fx.composerReady });
  await assert.rejects(() => api.provisionSelectRepository(fx.repo, {}), (e) => e.code === 'provision_repo_trigger_ambiguous');
});

test('option с чужим repo не выбирается', () => {
  const fx = buildFixture({ selected: false });
  fx.option.children[0].textContent = 'other/repo';
  const api = loadDom({ doc: fx.doc, location: makeLocation('/agent'), composerReady: fx.composerReady });
  fx.pickerWrap._visible = true;
  assert.throws(() => api.provisionRepoOption(fx.picker, fx.repo), (e) => e.code === 'provision_repo_option_missing');
});

test('sidebar item находится по UUID, query/hash игнорируются', () => {
  const fx = buildFixture();
  const api = loadDom({ doc: fx.doc, location: makeLocation(`/agent/${fx.agentUuid}`), composerReady: fx.composerReady });
  assert.equal(api.provisionAgentUuid(`/agent/${fx.agentUuid}?x=1#y`), fx.agentUuid);
  assert.equal(api.provisionFindSidebarItem(fx.agentUuid), fx.link);
  assert.equal(api.provisionFindSidebarItem('22222222-2222-4222-8222-222222222222'), null);
});

test('Rename: disabled submit становится enabled, sidebar переименован, тост не нужен', async () => {
  const fx = buildFixture({ roleName: 'Old Name' });
  const api = loadDom({ doc: fx.doc, location: makeLocation(`/agent/${fx.agentUuid}`), composerReady: fx.composerReady });
  assert.equal(fx.submit.disabled, true);
  const result = await api.provisionRenameAgent(fx.agentUuid, 'Executor Core', { agentRenameAttempts: 3 });
  assert.ok(result.attempts >= 1);
  assert.equal(fx.link.textContent, 'Executor Core');
  assert.equal(fx.dialog._visible, false);
  assert.ok(CLICKS.includes(fx.more));
  assert.ok(CLICKS.includes(fx.renameItem));
  assert.ok(CLICKS.includes(fx.submit));
  assert.ok(!CLICKS.includes(fx.archiveItem), 'Archive нового агента не нажимается');
});

test('Rename failure не создаёт новую сессию и не трогает URL', async () => {
  const fx = buildFixture({ roleName: 'Old Name' });
  fx.renameInput.oninput = () => { fx.submit.disabled = true; };
  const location = makeLocation(`/agent/${fx.agentUuid}`);
  const api = loadDom({ doc: fx.doc, location, composerReady: fx.composerReady });
  await assert.rejects(() => api.provisionRenameAgent(fx.agentUuid, 'Executor Core', { agentRenameAttempts: 1 }), (e) => e.code === 'provision_rename_failed');
  assert.equal(location.pathname, `/agent/${fx.agentUuid}`);
  assert.equal(fx.link.textContent, 'Old Name');
});

test('Archive старого агента: исчезновение подтверждено; отсутствующий item — unverified', async () => {
  const fx = buildFixture();
  const api = loadDom({ doc: fx.doc, location: makeLocation(`/agent/${fx.agentUuid}`), composerReady: fx.composerReady });
  const ok = await api.provisionArchiveAgent(fx.agentUuid);
  assert.equal(ok.archived, true);
  assert.equal(api.provisionFindSidebarItem(fx.agentUuid), null);
  const missing = await api.provisionArchiveAgent(fx.agentUuid);
  assert.equal(missing.unverified, true);
});
