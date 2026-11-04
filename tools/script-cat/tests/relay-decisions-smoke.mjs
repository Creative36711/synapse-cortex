// ADR proposed может появиться без question: сторож передаёт его в единую
// обратную связь, не рисуя отдельную кнопку и не отправляя второй пуш.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const version = assertUserscriptVersionContract(src)[1];
assert.match(src, new RegExp(`@version\\s+${version.replace(/\./g, '\\.')}`));
const has = (needle) => assert.ok(src.includes(needle), `в скрипте нет: ${needle}`);
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `не найден блок ${from}`);
  return src.slice(a, b);
};

// Одна точка входа; сторож остаётся активным и при свёрнутой панели.
has('💬 Обратная связь<span id="${ui.qBadge}"');
has('document.getElementById(ui.questions).onclick = () => window.open(C.questionsUrl');
has('adrCheckMs: 600000');
has('watchDecisions();');
assert.match(src, /setInterval\(\(\) => \{[\s\S]*?refreshDecisions\(\)/, 'фоновый сторож по-прежнему обновляет ADR');
assert.doesNotMatch(src, /ui\.adrBadge|ui\.adr\b/, 'отдельной кнопки и счётчика ADR нет');
assert.doesNotMatch(src, /function announceDecisions\(/, 'нет второго уведомления про тот же ADR');

// Разбор статуса и base64 сохранился и после удаления отдельной панели.
const adrBlock = cut('  const ADR_FOLDER = "docs/decisions";', '  async function refreshDecisions(');
const store = new Map();
const { adrStatusOf, openDecisions, b64Text } = new Function(
  'GM_getValue', `${adrBlock}\nreturn { adrStatusOf, openDecisions, b64Text };`,
)((key, fallback) => store.has(key) ? store.get(key) : fallback);
assert.equal(adrStatusOf('Статус: proposed\n# NAR-2.15'), 'proposed');
assert.equal(adrStatusOf('Статус: accepted'), 'accepted');
assert.equal(adrStatusOf('Статус: `proposed`'), 'proposed');
assert.equal(adrStatusOf('**Статус:** proposed'), '');
assert.equal(adrStatusOf('# нет статуса'), '');
assert.equal(adrStatusOf(''), '');
assert.match(b64Text(Buffer.from('Статус: proposed\n# NAR-2.16', 'utf8').toString('base64')), /Статус: proposed/);
assert.equal(b64Text(''), '');
assert.equal(b64Text('не base64!'), '');

// Реальный refreshDecisions: pending идёт в общую очередь, принятое не
// пересылается, сбой истории не выдаётся за пустую историю и не создаёт строк.
const refresh = cut('  async function refreshDecisions(force = false) {', '  let decisionsWatch = 0;');
const files = [
  { name: 'A.md', sha: 'a'.repeat(40), type: 'file', url: 'url-a', html_url: 'https://github.com/example/A.md' },
  { name: 'B.md', sha: 'b'.repeat(40), type: 'file', url: 'url-b' },
  { name: 'C.md', sha: 'c'.repeat(40), type: 'file', url: 'url-c' },
  { name: 'ignored.txt', sha: 'x', type: 'file', url: 'url-x' },
];
const content = { 'url-a': 'Статус: proposed', 'url-b': 'Статус: proposed', 'url-c': 'Статус: accepted' };
const deliveries = [], logs = [];
let requests = 0, history = new Set(['b']), failed = false;
const run = new Function(
  'openDecisions', 'GM_getValue', 'GM_setValue', 'C', 'K', 'request', 'githubHeaders', 'ADR_FOLDER',
  'adrStatusOf', 'b64Text', 'ADR_PROPOSED', 'decidedAdrNames', 'adrKeyOf', 'deliverProposals', 'logThrottled', 'dbg',
  `${refresh}\nreturn refreshDecisions;`,
)(
  openDecisions,
  (key, fallback) => store.has(key) ? store.get(key) : fallback,
  (key, value) => store.set(key, value),
  { repo: 'example/repo', adrCheckMs: 600000 }, { ghToken: 'token' },
  async (_method, url) => {
    requests++;
    if (failed) throw new Error('GitHub недоступен');
    if (url.includes('/contents/docs/decisions?')) return files;
    const name = decodeURIComponent(url.match(/\/([^/?]+)\?ref=/)?.[1] || '');
    const fixture = { 'A.md': content['url-a'], 'B.md': content['url-b'], 'C.md': content['url-c'] }[name];
    assert.ok(fixture, `неожиданный файл ${url}`);
    return { content: Buffer.from(fixture).toString('base64'), sha: ({'A.md':'a','B.md':'b','C.md':'c'})[name].repeat(40) };
  },
  () => ({}), 'docs/decisions', adrStatusOf, b64Text, 'proposed',
  async () => history, (file) => file.replace(/\.md$/i, '').toLowerCase(),
  async (rows) => deliveries.push(rows.map((row) => row.file)),
  (...args) => logs.push(args), () => {},
);
const first = await run(true);
assert.deepEqual(first.map((r) => r.file), ['A.md']);
assert.deepEqual(deliveries, [['A.md']], 'только нерешённое уходит в общую очередь');
assert.equal(logs.length, 1, 'принятый ответ ожидает изменения файла исполнителем');
assert.equal(openDecisions().rows[0].file, 'A.md');
const afterFirst = requests;
await run();
assert.equal(requests, afterFirst, 'кэш ограничивает запросы к GitHub');
assert.equal(deliveries.length, 1, 'повтор из кэша не создаёт вторую доставку');
history = null;
assert.deepEqual((await run(true)).map((r) => r.file), ['A.md']);
assert.equal(deliveries.length, 1, 'при сбое истории нет создания вслепую');
history = new Set(['b']);
failed = true;
assert.deepEqual((await run(true)).map((r) => r.file), ['A.md']);
assert.equal(deliveries.length, 1, 'при сбое GitHub сохранён прежний снимок');

// Инварианты ADR в декларативном промпте: вопрос по существу, default, proposed.
const { PromptCompiler, planRequest, dispatchRequest } = await import('./helpers/prompt-env.mjs');
const coord = PromptCompiler.compile(planRequest()).text;
const exec = PromptCompiler.compile(dispatchRequest('Executor')).text;
for (const t of [coord, exec]) {
  assert.match(t, /question «ADR:»/, 'ADR только через question');
  assert.match(t, /оставить как есть/, 'default = оставить как есть');
  assert.match(t, /proposed/, 'proposed-файл не теряется');
}
assert.match(exec, /статус accepted\/rejected после ответа/, 'после ответа proposed не оставляют');
console.log('relay-decisions-smoke: ok');
