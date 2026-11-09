// Проверка переносимого шаблона схем Notion; не создаёт базы и не вызывает API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const template = JSON.parse(await readFile(new URL('../NOTION-TEMPLATE.json', import.meta.url), 'utf8'));
const minimal = JSON.parse(await readFile(new URL('./fixtures/notion-schema-minimal.json', import.meta.url), 'utf8'));
const names = { roles: 'Роли', missions: 'Миссии', requests: 'Запросы', questions: 'Обратная связь' };
for (const [key, title] of Object.entries(names)) {
  const database = template.databases[key === 'questions' ? 'feedback' : key];
  assert.equal(database.title, title);
  const spec = database.properties;
  for (const [field, type] of Object.entries(minimal[key].fields)) {
    assert.ok(spec[field], `${title}: есть ${field}`);
    assert.deepEqual(Object.keys(spec[field]), [type], `${title}.${field}: тип ${type}`);
  }
  for (const [field, required] of Object.entries(minimal[key].options)) {
    // Имена ролей задаются для конкретного проекта, а не копируются из фикстуры.
    if (key === 'requests' && field === 'Кому') continue;
    const options = spec[field].select.options.map(option => option.name);
    for (const option of required) assert.ok(options.includes(option), `${title}.${field}: есть ${option}`);
  }
}
const db = template.databases;
assert.deepEqual(db.requests.properties['Кому'].select.options, [], 'получателей задаёт новый проект');
assert.ok(db.roles.properties['Устав'].url);
assert.ok(db.missions.properties['ТЗ SHA'].rich_text);
assert.ok(db.missions.properties['Координатор'].rich_text);
assert.ok(db.requests.properties.Dependency.rich_text);
assert.ok(db.requests.properties.Repository.rich_text, 'карточки нового проекта явно указывают целевой repo');
assert.ok(db.requests.properties['Проверка'].rich_text);
for (const option of ['Ждёт', 'Отключена']) {
  assert.ok(db.roles.properties['Статус'].select.options.some(x => x.name === option));
}
for (const option of ['Черновик', 'Пауза']) {
  assert.ok(db.missions.properties['Состояние'].select.options.some(x => x.name === option));
}
assert.ok(db.requests.properties.Check.select.options.some(x => x.name === 'none'));
// D-080: `Тип` — такой же select, как остальные поля: его пишет транспорт
// (`questionProps`), а не формула. Раньше поле жило только в afterCreate, и
// схема базы его не знала — проверка подключения о нём молчала.
const typ = db.feedback.properties['Тип'];
assert.ok(typ && typ.select, 'Тип — select в самой базе, а не формула в afterCreate');
for (const option of ['Вопрос', 'Предложение']) {
  assert.ok(typ.select.options.some((x) => x.name === option), `Тип: есть вариант «${option}»`);
}
assert.equal(template.afterCreate, undefined, 'отдельных шагов после создания не осталось');
assert.equal(db.feedback.properties['Срок'].date !== undefined, true, 'Срок остаётся в схеме как история');
assert.doesNotMatch(JSON.stringify(template), /ed076bfe|c84a3f11|11b41fcc|54ac1a79/, 'старые ID не копируются');
console.log('relay-notion-template-integration: ok (контракт и дополнительные поля; без Notion API)');
