// Текущий контракт appendToJournal в relay.user.js.
//
// История (NAR-2.13, 25.10.2026, 15:59Z): Runtime Auditor создал папку
// Arena/reports, положил туда отчёт и вписал его id в поле карточки
// «Output Drive File ID» — туда, где лежит ссылка на журнал попытки. Шлюз
// отказал по делу: «Запись разрешена только в текстовые файлы Arena/logs».
// Скрипт назвал это «Шлюз Drive не ответил» и встал на паузу: Мастер пошёл
// проверять развёртывание Apps Script, хотя шлюз был жив и прав.
//
// Что проверяется здесь:
//   1) обычная запись не трогает карточку;
//   2) отказ «не та папка» → журнал этой выдачи (createLog идемпотентен) →
//      запись в него → ссылка возвращается в карточку;
//   3) отказ по другой причине (ключ) не лечится журналом;
//   4) если журнал не открылся, наружу идёт исходный отказ, а не ошибка createLog;
//   5) submitExecutor пишет ответ только через appendToJournal;
//   6) карточка обновляется только для всё ещё Running и того же Run ID;
//   7) агенту прямо сказано: поля карточки ставит скрипт.
//
// Это изолированная проба с подменёнными границами Notion/Drive, не live-проверка.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const version = versionMatch[1];
assert.match(src, new RegExp(`@version\\s+${version.replace(/\./g, '\\.')}`), `версия ${version}`);

const from = src.indexOf('  async function appendToJournal(');
const to = src.indexOf('  async function submitExecutor(');
assert.ok(from > 0 && to > from, 'appendToJournal на месте');
const helperLines = ['const norm =', 'const rt =', 'const sel =', 'const taskState ='];
const runtimeHelpers = helperLines.map((prefix) => {
  const line = src.split('\n').find((candidate) => candidate.trimStart().startsWith(prefix));
  assert.ok(line, `production helper exists: ${prefix}`);
  return line;
}).join('\n');

const page = ({ state = 'Running', runId = 'r-1' } = {}) => ({
  properties: {
    'Dispatch State': { select: { name: state } },
    'Run ID': { rich_text: [{ plain_text: runId }] },
  },
});

const load = ({ append, createLog, freshPage = page(), driveFolder = '' }) => {
  const calls = { append: [], createLog: 0, notion: [], patch: [], log: [] };
  const api = new Function(
    'gateway', 'notion', 'patch', 'log', 'C',
    `${runtimeHelpers}\n${src.slice(from, to)}\nreturn appendToJournal;`,
  )(
    async (action, fileId, extra) => {
      if (action === 'createLog') {
        calls.createLog += 1;
        return createLog();
      }
      calls.append.push(fileId);
      return append(fileId, extra);
    },
    async (method, path) => {
      calls.notion.push({ method, path });
      assert.equal(method, 'GET', 'guard reads the fresh Notion page');
      assert.equal(path, 'pages/d-1', 'guard rereads the dispatch being recovered');
      return freshPage;
    },
    async (id, props) => { calls.patch.push({ id, props }); },
    (text) => { calls.log.push(String(text)); },
    { driveFolder },
  );
  return { api, calls };
};

const refusal = (reason) => {
  const e = new Error(`шлюз Drive отказал: ${reason}`);
  e.relay = 'gateway';
  e.refused = true;
  e.reason = reason;
  return e;
};
const FOLDER = 'Запись разрешена только в текстовые файлы Arena/logs.';
const logCreated = () => ({ ok: true, fileId: 'log-1', name: 'd-1_r-1.md', result: { fileId: 'log-1' } });

// 1. Обычный путь: поле в карточке верное, лишних движений нет.
{
  const { api, calls } = load({
    append: async () => ({ ok: true, result: 'appended' }),
    createLog: () => { throw new Error('createLog не должен вызываться'); },
  });
  const out = await api('d-1', 'r-1', 'log-1', '<!-- CF_DISPATCH d-1:r-1 -->', '\n\n…\n');
  assert.equal(out.logId, 'log-1', 'журнал тот же');
  assert.equal(out.wrote.result, 'appended', 'запись сделана');
  assert.equal(calls.createLog, 0, 'журнал не переоткрывали');
  assert.equal(calls.notion.length, 0, 'свежую карточку читают только для восстановления ссылки');
  assert.equal(calls.patch.length, 0, 'карточку не трогали');
}

// Проектный отказ не направляет пользователя в legacy-папку Relay.
{
  const { api, calls } = load({
    driveFolder: 'synapse',
    append: async (id) => {
      if (id === 'report-1') throw refusal('Запись разрешена только в текстовые файлы logs этого проекта.');
      return { ok: true, result: 'appended' };
    },
    createLog: logCreated,
  });
  await api('d-1', 'r-1', 'report-1', 'marker', 'entry');
  assert.ok(calls.log.some((line) => line.includes('Arena/synapse/logs')));
  assert.ok(calls.log.every((line) => !line.includes('только в Arena/logs')));
}

// 2. Поле переписано на отчёт: журнал берётся из выдачи, ссылка возвращается.
{
  const { api, calls } = load({
    append: async (fileId) => {
      if (fileId === 'report-1') throw refusal(FOLDER);
      return { ok: true, result: 'appended' };
    },
    createLog: logCreated,
  });
  const out = await api('d-1', 'r-1', 'report-1', '<!-- CF_DISPATCH d-1:r-1 -->', '\n\n…\n');
  assert.equal(out.logId, 'log-1', 'пишем в журнал выдачи');
  assert.deepEqual(calls.append, ['report-1', 'log-1'], 'сначала попытка в поле, потом журнал');
  assert.equal(calls.createLog, 1, 'идемпотентный журнал запрошен один раз');
  assert.deepEqual(calls.notion, [{ method: 'GET', path: 'pages/d-1' }], 'перед patch заново прочитана карточка');
  const patched = calls.patch[0];
  assert.ok(patched, 'ссылка возвращена после проверки актуальной выдачи');
  assert.equal(patched.id, 'd-1', 'правится своя карточка');
  assert.equal(
    patched.props['Output Drive File ID'].rich_text[0].text.content,
    'log-1',
    'ссылка на журнал вернулась в карточку',
  );
  assert.ok(calls.log.some((t) => /указывает не на журнал/.test(t)), 'в журнале скрипта сказано словами');
}

// 3. Отказ по другой причине — не повод искать журнал.
{
  const { api, calls } = load({
    append: async () => { throw refusal('Неверный ключ шлюза.'); },
    createLog: () => { throw new Error('createLog не должен вызываться'); },
  });
  await assert.rejects(
    () => api('d-1', 'r-1', 'log-1', 'm', 'e'),
    /Неверный ключ шлюза/,
    'чужой отказ уходит наверх как есть',
  );
  assert.equal(calls.createLog, 0, 'журнал не запрашивался');
  assert.equal(calls.notion.length, 0, 'карточку не перечитывали');
  assert.equal(calls.patch.length, 0, 'карточка не тронута');
}

// 4. Журнал не открылся: наружу — исходный отказ, а не ошибка шлюза на createLog.
{
  const { api } = load({
    append: async () => { throw refusal(FOLDER); },
    createLog: () => { throw new Error('Apps Script недоступен'); },
  });
  await assert.rejects(
    () => api('d-1', 'r-1', 'report-1', 'm', 'e'),
    (e) => {
      assert.equal(e.refused, true, 'остался отказ шлюза');
      assert.match(e.reason, /Arena\/logs/, 'с причиной про папку');
      return true;
    },
  );
}

// 5. Журнал создаётся, но карточка уже не принадлежит этой выдаче — не patch.
for (const stalePage of [page({ state: 'Ready', runId: 'r-1' }), page({ state: 'Running', runId: 'r-2' })]) {
  const { api, calls } = load({
    append: async (fileId) => {
      if (fileId === 'report-1') throw refusal(FOLDER);
      return { ok: true, result: 'appended' };
    },
    createLog: logCreated,
    freshPage: stalePage,
  });
  const out = await api('d-1', 'r-1', 'report-1', 'm', 'e');
  assert.equal(out.logId, 'log-1', 'ответ всё равно сохраняется в журнале своей выдачи');
  assert.equal(calls.notion.length, 1, 'состояние проверено после создания журнала');
  assert.equal(calls.patch.length, 0, 'не перезаписываем карточку Ready или другого Run ID');
  assert.ok(calls.log.some((text) => /Ссылка на журнал не вернулась/.test(text)), 'гонка отражена в диагностике');
  assert.deepEqual(calls.append, ['report-1', 'log-1'], 'тело ответа сохранено несмотря на гонку карточки');
}

// 6. submitExecutor: ответ идёт через appendToJournal, а не в id из карточки.
{
  const submit = src.slice(src.indexOf('async function submitExecutor'), src.indexOf('async function releaseStalled'));
  assert.match(submit, /const declaredLog = rt\(page\.properties\["Output Drive File ID"\]\)/, 'поле читается');
  assert.match(submit, /await appendToJournal\(/, 'пишем через журнал выдачи');
  assert.doesNotMatch(submit, /gateway\("append",\s*declaredLog/, 'в поле напрямую не пишем');
}

// 7. Правило для агентов: поля карточки ставит скрипт.
{
  const rule = src.slice(src.indexOf('const CARD_FIELDS_RULE'), src.indexOf('const EXECUTOR_TECH'));
  assert.match(rule, /Output Drive File ID/, 'поле названо');
  assert.match(rule, /report/, 'сказано, куда девать отчёт');
  const executor = src.slice(src.indexOf('const executorTech'), src.indexOf('const auditorTech'));
  const auditor = src.slice(src.indexOf('const auditorTech'), src.indexOf('const COORDINATOR_TECH'));
  assert.match(executor, /CARD_FIELDS_RULE/, 'исполнителю сказано');
  assert.match(auditor, /CARD_FIELDS_RULE/, 'аудитору сказано');
}

console.log(`OK: relay ${version} — журнал выдачи восстанавливается без перезаписи чужого Run ID`);
