// Проба 1.14.17 (D-087): почему Warden объявил редакцию и не опубликовал её.
//
// Вопрос Мастера (09.11): «нужно выяснить причину, почему он не стал этого делать».
// Причина нашлась в промпте, и она механическая, а не про мотивацию:
//
//   1. `authority.reviewer` — властный блок — говорил «ничего не правь — ни код,
//      ни карточки, ни документы». Безусловно.
//   2. `role.zone` — описательный блок с его же полем «Зона записи» из «Ролей»:
//      «ТЗ миссий, база «Роли», решения ADR, docs/ в cortex, приёмка миссий.
//      Пишет только в synapse-cortex и только в своей ветке». Разрешает.
//   3. У приёмки не было НИ ОДНОГО блока о том, как публиковать: `git.executor` —
//      только Executor, `git.auditor` — только Auditor. То есть ветка, PR и мерж —
//      единственный способ «опубликовать» — приёмке не описывались никогда.
//
// Два правила об одном предмете, где запрет стоит в блоке власти, а разрешение —
// в описании зоны, и вдобавок нет порядка действий. Поведение «объявил в ответе и
// остановился» — не сбой модели, а точное исполнение промпта.
//
// Проверяется:
//   • запрет у приёмки сужен до чужой работы, документы процесса разрешены явно;
//   • документы названы по путям, а не «документы» без границы;
//   • у приёмки есть порядок публикации: ветка → PR → мерж, без direct push;
//   • правило R-DOCS существует и обязательно для Reviewer;
//   • у арбитра запрет остаётся полным (там править правда нельзя);
//   • профиль reviewer.mission и reviewer.answer несут git.docs.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

const blocks = readFileSync(new URL('../src/prompt-blocks.js', import.meta.url), 'utf8');
const profiles = readFileSync(new URL('../src/prompt-profiles.js', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../contracts/agent-protocol.json', import.meta.url), 'utf8'));

// ── 1. Запрет сужен: чужая работа — нет, документы процесса — да ─────────────
const reviewerBlock = blocks.slice(
  blocks.indexOf('def("authority.reviewer"'),
  blocks.indexOf('def("git.executor"'),
);
assert.ok(!/ничего не правь — ни код, ни карточки, ни документы(?! процесса)/.test(reviewerBlock),
  'безусловного запрета на документы у приёмки больше нет');
assert.match(reviewerBlock, /не правь чужую работу — ни код, ни карточки, ни постановку/,
  'запрет назван по предмету: чужая работа');
assert.match(reviewerBlock, /Документы процесса в репозитории своей роли/, 'документы процесса — разрешены');
assert.match(reviewerBlock, /docs\/missions\/\*\*/, 'граница названа путями, а не словом «документы»');
assert.match(reviewerBlock, /docs\/handoff\/\*\*/, 'очередь входит в ту же границу');
assert.match(reviewerBlock, /опубликуй её отдельным PR до выдачи карточек/, 'сказано, что объявление ≠ публикация');

// Арбитр по-прежнему не правит ничего: там задача — решение, а не правка.
assert.match(reviewerBlock, /сейчас арбитр: не правь чужую работу[\s\S]{0,120}документы процесса/,
  'у арбитра запрет остался полным');
assert.match(reviewerBlock, /Твой выход — решение по карточке или остановка цикла/, 'выход арбитра не изменился');

// ── 2. Порядок публикации существует ────────────────────────────────────────
assert.match(blocks, /def\("git\.docs"/, 'блок публикации для приёмки появился');
const gitDocs = blocks.slice(blocks.indexOf('def("git.docs"'), blocks.indexOf('def("git.auditor"'));
assert.match(gitDocs, /ветка от origin\/\$\{base\}/, 'ветка — от базовой, а не «как получится»');
assert.match(gitDocs, /gh pr create --fill --base/, 'PR создаётся явно');
assert.match(gitDocs, /gh pr merge <N> --merge/, 'мерж назван');
assert.match(gitDocs, /Direct push в \$\{base\} запрещён/, 'прямой пуш запрещён и здесь');
assert.match(gitDocs, /подними номер в шапке файла/, 'версия-ключ названа частью публикации');
assert.match(gitDocs, /docs\/missions\/\*\*, docs\/handoff\/\*\*/, 'править можно только документы');
assert.match(gitDocs, /Карточки по неопубликованной редакции не выдаются/, 'связь с гейтом выдачи названа');
assert.ok(!/annotations|код\b/.test(gitDocs.replace(/документы/g, '')), 'блок не открывает приёмке правку кода');

// ── 3. Правило R-DOCS в контракте ───────────────────────────────────────────
assert.ok(contract.rules?.['R-DOCS'], 'правило R-DOCS записано в контракт');
assert.deepEqual(contract.rules['R-DOCS'].requiredFor, ['Reviewer'], 'оно обязательно именно приёмке');
assert.deepEqual(contract.rules['R-GIT'].requiredFor, ['Executor', 'Auditor', 'Reviewer'],
  'git-ритуал теперь обязателен и приёмке — раньше не был');
assert.match(src, /"R-DOCS"/, 'правило доехало до сборки');

// ── 4. Профили приёмки несут блок публикации ────────────────────────────────
const mission = profiles.slice(profiles.indexOf('def("reviewer.mission"'), profiles.indexOf('def("reviewer.answer"'));
assert.match(mission, /"git\.docs"/, 'приёмка миссии знает, как публиковать');
const answer = profiles.slice(profiles.indexOf('def("reviewer.answer"'), profiles.indexOf('def("reviewer.answer"') + 400);
assert.match(answer, /"git\.docs"/, 'ответ на вопрос — тоже (именно там рождаются объявления редакций)');

// ── 5. Версия и решение ─────────────────────────────────────────────────────
assert.match(src, /@version\s+1\.14\.1[7-9]/, 'сборка не старее 1.14.17');
const decisions = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');
assert.match(decisions, /## D-087/, 'решение D-087 записано');

console.log('ok 1 - tests/relay-reviewer-docs-authority-smoke.mjs');
