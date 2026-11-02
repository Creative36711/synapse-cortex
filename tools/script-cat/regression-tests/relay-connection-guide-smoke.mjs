// Документация подключения остаётся доступной после переноса/переименования папки.
// Это проверка ссылок и названий UI, а не запуск внешних сервисов.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const guide = read('README-авторизация.md');
const docs = ['README.md', 'INSTALL.md', 'AGENT-SETUP.md', 'README-авторизация.md'];

for (const service of ['Notion', 'GitHub', 'Google Drive', 'Gateway']) {
  assert.ok(guide.includes(service), `в руководстве описан ${service}`);
}
for (const entry of docs.slice(0, 3)) {
  assert.ok(read(entry).includes('./README-авторизация.md'), `${entry} ссылается на руководство`);
}
for (const entry of docs) {
  const contents = read(entry);
  assert.ok(!contents.includes('_tools/ScriptCat/'), `${entry} не зависит от имени родительского каталога`);
  const base = new URL(entry, root);
  for (const hit of contents.matchAll(/\[[^\]]+\]\((\.\/[\w.\-/а-яё]+)(?:#[^)]*)?\)/giu)) {
    assert.ok(statSync(new URL(hit[1], base)).isFile(), `${entry}: ссылка ${hit[1]} доступна`);
  }
}

const projectUi = read('src/08-projects-ui.js');
const connectionUi = read('src/07-connections-ui.js');
for (const label of ['Новый профиль', 'Найти ID источников по ссылкам', 'Создать профиль',
  'Открыть выбранный проект', 'Проверить подключения и разрешить работу']) {
  assert.ok(projectUi.includes(label), `кнопка «${label}» есть в UI`);
  assert.ok(guide.includes(label), `кнопка «${label}» описана в руководстве`);
}
for (const label of ['Управление проектами', 'Проверить всё', 'Сохранить', 'Ключ шлюза']) {
  assert.ok(connectionUi.includes(label), `поле или кнопка «${label}» есть в UI`);
  assert.ok(guide.includes(label), `поле или кнопка «${label}» описана в руководстве`);
}
const gateway = read('drive-gateway.gs');
for (const name of ['CF_SETUP_PROJECT_ID', 'CF_SETUP_PROJECT_FOLDER', 'setupProjectGateway', 'CF_GATEWAY_KEY']) {
  assert.ok(gateway.includes(name), `${name} есть в коде шлюза`);
  assert.ok(guide.includes(name), `${name} описан в руководстве`);
}
assert.ok(guide.includes('Read content') && guide.includes('Update content') && guide.includes('Insert content'));
assert.ok(guide.includes('Contents: Read-only') && guide.includes('Pull requests: Read-only'));
assert.ok(guide.toLowerCase().includes('не передавайте') && guide.includes('в чат'));
console.log('OK: руководство подключений, ссылки, названия интерфейса и настройки Gateway согласованы.');
