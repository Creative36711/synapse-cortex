// Общая среда для тестов конструктора промптов: грузит исходные модули
// (реестр маркеров, блоки, профили, компилятор) БЕЗ браузерного кода и даёт
// готовые фикстуры. Источник истины — src/, а не собранный relay.user.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');
// D-073: правила самовосстановления — чистое ядро, исполняется пробами.
const files = ['prompt-marker-registry.js', 'prompt-blocks.js', 'prompt-profiles.js', 'prompt-compiler.js'];
const healFiles = ['40-heal-core.js'];
const source = files.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');

export const promptApi = new Function(`${source}\nreturn { PromptCompiler, PROMPT_PROFILES, PROMPT_BLOCKS, PROMPT_MARKER_REGISTRY };`)();
export const { PromptCompiler, PROMPT_PROFILES, PROMPT_BLOCKS, PROMPT_MARKER_REGISTRY } = promptApi;

// Чистое ядро самовосстановления: классификация остановок, предохранители,
// телеметрия, гейт версии. Без DOM, без GM, без сети — поэтому исполняется здесь.
const healSource = healFiles.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');
export const healApi = new Function(`${healSource}\nreturn {
  HEAL_RULES_VERSION, HEAL_CLASS_INFO, HEAL_PAUSE_CLASS, healVerdict, classifyPause,
  healIncidentKey, healBackoff, decideHeal, healRedact, healRedactTree, healByteLength,
  buildHealTelemetry, decideVersionGate, heartbeatLine, parseHeartbeat };`)();

export const UUID = {
  dispatch: 'a709d6df-4698-4a98-b111-90d22de42894',
  run: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d',
  mission: '40c6f0cf-5705-81ae-ab6c-efac6bad62f0',
  turn: '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  question: '46208c7d-7c36-41df-ac99-2a38d79dbcf2',
};

export const task = (over = {}) => ({
  id: UUID.dispatch, runId: UUID.run, title: 'SYN-1.1 · Карта ядра',
  intent: 'Понять состав GameEngine и его публичный контракт.',
  invariants: 'В таблице ровно 253 строки; поведение не меняется.',
  acceptance: "grep -cE '^  (async )?[a-zA-Z_]+\\(' src/core/engine.ts = 253",
  scope: 'docs/design/core-map.md', freedom: 'Формат таблицы на усмотрение исполнителя.',
  payload: '', ...over,
});
export const role = (fn, over = {}) => ({ name: `${fn} Core`, fn, zone: 'game/**', ...over });
export const target = (over = {}) => ({ repo: 'Creative36711/synapse', baseBranch: 'main', ...over });

export const dispatchRequest = (fn = 'Executor', over = {}) => ({
  kind: 'dispatch', role: role(fn), target: target(), task: task(),
  mission: { id: UUID.mission }, drive: { project: 'synapse' }, delivery: { tier: 'full' }, ...over,
});
export const planRequest = (over = {}) => ({
  kind: 'plan', role: role('Coordinator'),
  mission: { id: UUID.mission, name: 'SYN-1', round: 0, reworkLimit: 3, tzUrl: 'https://notion.so/tz' },
  turnId: UUID.turn, queue: { summary: '0 Submitted, 0 Running, 1 Ready' },
  delivery: { tier: 'full' }, ...over,
});
export const reviewRequest = (over = {}) => ({
  kind: 'review', role: role('Reviewer', { name: 'Warden' }),
  mission: { id: UUID.mission, name: 'SYN-1', round: 0, reworkLimit: 3, result: 'Сделано.' },
  turnId: UUID.turn, queue: { summary: '2 Accepted', acceptedCount: 2, accepted: '- SYN-1.1' },
  delivery: { tier: 'full' }, ...over,
});
export const answerRequest = (over = {}) => ({
  kind: 'answer', role: role('Reviewer', { name: 'Warden' }), mission: { id: UUID.mission },
  turnId: UUID.turn,
  question: { id: UUID.question, turnId: UUID.turn, text: 'Расширить зону?', fullText: 'Можно ли расширить зону на schema/?', options: ['A', 'B'], fallback: 'A', role: 'Executor Core' },
  delivery: { tier: 'full' }, ...over,
});
export const reminderRequest = (fn = 'Executor', markerName = 'CF_AGENT_RESULT', over = {}) => ({
  kind: 'reminder', role: role(fn), task: task(), turnId: UUID.turn,
  mission: { id: UUID.mission }, question: { id: UUID.question, turnId: UUID.turn },
  reminder: { markerName, attempt: 1, max: 2 }, delivery: { tier: 'full' }, ...over,
});
export const pilotRequest = (over = {}) => ({
  kind: 'pilot', role: { fn: 'pilot' },
  pilot: { brief: 'A. Ты — ИИ-разработчик игр. Сделай 2D выживание на canvas.', repo: 'Creative36711/synapse', startSha: 'a'.repeat(40) },
  delivery: { tier: 'full' }, ...over,
});
