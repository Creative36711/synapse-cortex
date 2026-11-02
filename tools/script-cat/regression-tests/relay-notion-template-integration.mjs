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
assert.ok(db.requests.properties['Проверка'].rich_text);
for (const option of ['Ждёт', 'Отключена']) {
  assert.ok(db.roles.properties['Статус'].select.options.some(x => x.name === option));
}
for (const option of ['Черновик', 'Пауза']) {
  assert.ok(db.missions.properties['Состояние'].select.options.some(x => x.name === option));
}
assert.ok(db.requests.properties.Check.select.options.some(x => x.name === 'none'));
assert.equal(db.feedback.properties['Тип'], undefined, 'зависимая формула создаётся отдельным шагом');
const expression = template.afterCreate.feedback['Тип'].formula.expression;
assert.match(expression, /prop\("Вопрос"\)/);
assert.match(expression, /prop\("Материал"\)/);
assert.match(expression, /Предложение/);
assert.match(expression, /Вопрос/);
assert.doesNotMatch(JSON.stringify(template), /ed076bfe|c84a3f11|11b41fcc|54ac1a79/, 'старые ID не копируются');
console.log('relay-notion-template-integration: ok (контракт и дополнительные поля; без Notion API)');
