// Проба краткого регламента: правила приходят агенту вместе с заданием.
//
// Зачем: транспорт отдавал регламент ссылкой, и агент читал ~50 блоков Notion
// каждый ход. Дешевле (и надёжнее — не зависит от квоты и от обрезки ответов)
// вшивать краткую версию в промпт. Опасность одна: вшитая копия устареет молча.
// Поэтому проба сверяет три источника — текст, версию и бандл.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import {
  DIGEST_MAX_CHARS,
  assertDigestVersionMatches,
  digestVersion,
  normalizeDigest,
  readEmbeddedDigest,
} from '../regulation-oracle.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rawDigest = read('../../../docs/regulation-digest.md');
const digest = normalizeDigest(rawDigest);
const regulation = read('../../../docs/REGULATION.md');
const bundle = read('../relay.user.js');

// ── 1. Источники совпадают ──────────────────────────────────────────────────
assert.equal(
  readEmbeddedDigest(bundle),
  digest,
  'вшитый регламент в relay.user.js разошёлся с docs/regulation-digest.md: пересоберите бандл',
);
assertDigestVersionMatches(digest, regulation);
assert.match(digest, /## 1\. Роли/, 'в краткой версии есть раздел ролей');
assert.match(digest, /## 2\. Репозитории и доступы/, 'в краткой версии есть репозитории и доступы D-022');
assert.match(digest, /## 3\. Инструменты/, 'в краткой версии есть раздел про готовые инструменты');
assert.match(digest, /## 4\. Зоны и гейты/, 'в краткой версии есть зоны и гейты');

// 1.0. Агент обязан узнать из промпта, что работа идёт в двух репозиториях и что
//      инструменты уже лежат в репозитории ядра (D-025): иначе он ставит Godot с нуля
//      и ищет файлы платформы, которых его роль не видит.
assert.match(digest, /Creative36711\/synapse\b/, 'названо открытое ядро полным именем');
assert.match(digest, /Creative36711\/synapse-cortex/, 'назван закрытый репозиторий полным именем');
assert.match(digest, /install\.sh --check/, 'указана команда установки готового Godot');
assert.match(digest, /setup_bpy\.sh --check/, 'указана команда установки готового Blender');
assert.match(digest, /setup\.sh --check/, 'указана команда медиа-инструментов');
assert.match(digest, /AGENTS\.md/, 'агент отправлен к инструкции репозитория');
assert.match(digest, /не скачив|не ставить с нуля|ставить с нуля не нужно/i, 'сказано, что ставить с нуля не надо');

// 1.1. Служебные заметки остаются в файле, но в промпт не попадают.
assert.ok(rawDigest.includes('<!-- build:meta -->'), 'в файле есть маркер служебных заметок');
assert.doesNotMatch(digest, /build:meta|Примечание для сопровождающего/, 'служебные заметки не идут в промпт');
assert.doesNotMatch(digest, /Пересоберите|пересоберите бандл/, 'инструкции по сборке не путаются с правилами');

// ── 2. Бюджет объёма ───────────────────────────────────────────────────────
assert.ok(
  digest.length <= DIGEST_MAX_CHARS,
  `краткий регламент ${digest.length} знаков > ${DIGEST_MAX_CHARS}: вход хода обязан оставаться коротким`,
);
const fullLength = regulation.length;
assert.ok(
  digest.length * 2 < fullLength,
  `краткая версия (${digest.length}) должна быть заметно короче полной (${fullLength})`,
);

// ── 3. Промпт роли реально содержит регламент ──────────────────────────────
const src = bundle;
const from = src.indexOf('  /** Правило поведения зависит от функции');
const to = src.indexOf('  /** Порядок работы для того, кто пишет код');
assert.ok(from > 0 && to > from, 'блок roleContext на месте');

const build = (config) =>
  new Function(
    'C',
    `${src.slice(from, to)}
     return roleContext;`,
  )(config);

const withDigest = build({ ...JSON.parse(JSON.stringify({ regulationDigest: digest, pageUrl: 'https://example.test/reg' })) });
const text = withDigest({ name: 'Executor Core', fn: 'Executor', zone: 'game/cli/', gate: 'PR' });

assert.match(text, /=== CF_REGULATION ===/, 'блок регламента размечен');
assert.match(text, /=== \/CF_REGULATION ===/, 'блок регламента закрыт');
assert.ok(text.includes(digest), 'текст регламента попал в промпт целиком');
assert.match(text, /Полная версия по ссылке выше/, 'ссылка на полную версию остаётся');
assert.ok(
  text.indexOf('=== CF_REGULATION ===') < text.indexOf(digest),
  'регламент идёт после открывающей разметки',
);

// 3.1. Без вшитого текста промпт деградирует, но не падает и не выдумывает правила.
const withoutDigest = build({ pageUrl: 'https://example.test/reg' });
const bare = withoutDigest({ name: 'Coordinator', fn: 'Coordinator' });
assert.doesNotMatch(bare, /=== CF_REGULATION ===/, 'без текста блок регламента не подставляется');
assert.match(bare, /Регламент \(полная версия\): https:\/\/example\.test\/reg/, 'ссылка остаётся');

// 3.2. Версия в шапке скрипта соответствует поведению 1.8.x (вшитый регламент менялся).
assert.match(bundle, /\/\/ @version\s+1\.8\.\d+/, 'версия бандла поднята вместе с изменением промпта');

// 3.3. Регламент не должен стоять ПОСЛЕ маркера: агент читает конец задания
// внимательнее, и в первом ходе Координатора служебная строка «потерялась»
// в середине промпта под блоком регламента. Порядок — часть контракта.
const funcBody = (name, endMarker) => {
  const from = bundle.indexOf(`function ${name}(`);
  const to = bundle.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `функция ${name} на месте`);
  return bundle.slice(from, to);
};
const executorFn = funcBody('executorPrompt', 'function answerLogLine');
assert.ok(
  executorFn.indexOf('roleContext(role)') < executorFn.indexOf('executorOrder('),
  'в промпте исполнителя регламент идёт до блока с маркером: маркер остаётся в конце',
);
const orderFn = funcBody('executorOrder', 'function auditorOrder');
assert.match(orderFn, /CF_AGENT_RESULT/, 'маркер исполнителя собирается в его блоке порядка');
const coordinatorFn = funcBody('coordinatorPrompt', '\n})(');
assert.ok(
  coordinatorFn.indexOf('roleContext(role)') < coordinatorFn.indexOf('CF_COORDINATOR_RESULT'),
  'в промпте Координатора регламент идёт до маркера: маркер остаётся в конце',
);
assert.match(digest, /Формат финальной строки всегда стоит в самом конце задания/,
  'правило «формат ответа — в конце задания» вшито в регламент');
assert.equal(digestVersion(digest), digestVersion(regulation), 'версии копий совпадают');

console.log('OK: краткий регламент вшит в промпт, копии и версии совпадают');
