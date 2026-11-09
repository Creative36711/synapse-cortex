// Проба 1.14.15 (D-086): объявленная редакция ТЗ против того, что лежит в main.
//
// Мастер (09.11): «работу просто невозможно делать из-за остановок» — и отдельно
// вопрос, почему ТЗ 1.6/1.7 и очередь 1.8/1.9 так и не доехали до `main`.
//
// Разбор показал: правка родилась в переписке приёмки. В `main` при этом лежали
// ТЗ 1.5 и редакция очереди 1.7, а веток, кроме `main`, в репозитории не было ни
// одной. Исполнителю нечего взять, а признака «опубликовано» в системе не было
// нигде: документ живёт в Notion и в git, сверять их было некому.
//
// Проверяется механика, а не текст:
//   • номер редакции из ответа приёмки читается и сравнивается с файлом на main;
//   • «ТЗ 1.6 при опубликованном 1.5» и «очередь 1.9 при 1.7» — блокируют ответ;
//   • «ТЗ 1.5 при 1.5» и «без номеров вовсе» — не блокируют;
//   • редакция читается из шапки документа в репозитории, а не из текста ответа;
//   • пауза «answer-unpublished» — транспорт, а не Мастер: правят приёмка и PR.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

const sliceBetween = (start, end) => {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  assert.ok(from > 0 && to > from, `блок ${start.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

// ── 1. Сверка редакций ────────────────────────────────────────────────────────
const published = {
  version: '1.5',
  queue: '1.7',
  file: 'docs/handoff/syn-3-card-queue.md',
};

// Границы берём по задачам, а не по комментариям: границы блоков — якоря сборки,
// и предыдущий комментарий прилипает к следующему блоку.
const bodyOf = (name, next) => src.slice(src.indexOf(`function ${name}(`), src.indexOf(`async function ${next}(`));
const { publicationGaps } = new Function(`${bodyOf('publicationGaps', 'questionBriefing')}\nreturn { publicationGaps };`)();

const gapTz = publicationGaps('Делай по ТЗ 1.6, карточки те же.', published);
assert.match(gapTz, /ТЗ 1\.6/, 'новый номер ТЗ замечен');
assert.match(gapTz, /ТЗ 1\.5/, 'опубликованный номер назван');
assert.match(gapTz, /не опубликована/, 'причина названа прямо');
assert.match(gapTz, /PR/, 'выход назван: PR с новой редакцией');

const gapQueue = publicationGaps('Редакция очереди 1.9, бери B0-r1.', published);
assert.match(gapQueue, /редакция очереди 1\.9/, 'новая редакция очереди замечена');

const gapBoth = publicationGaps('ТЗ 1.6 и редакция 1.8 — работай по ним.', published);
assert.match(gapBoth, /ТЗ 1\.6 и редакция очереди 1\.8/, 'обе части названы вместе');

// ── 2. Нет номера — нет повода останавливать ─────────────────────────────────
assert.equal(publicationGaps('Продолжай с B1, без изменений.', published), '', 'без номеров — тишина');
assert.equal(publicationGaps('', published), '', 'пустой ответ — тишина');
assert.equal(publicationGaps('ТЗ 1.5 + очередь 1.7, как в репозитории.', published), '', 'равное — не новее');
assert.equal(publicationGaps('ТЗ 1.4 — уже устарело?', published), '', 'старое не блокирует');
assert.equal(publicationGaps('ТЗ 1.6, но опубликованного не прочитали', null), '', 'нечего сверять — не блокируем');

// ── 3. Редакция читается из репозитория ──────────────────────────────────────
// `publishedTzVersion` собирается позже `publicationGaps`, поэтому границу берём
// не по соседу, а по следующему блоку документации.
const tzFrom = src.indexOf('async function publishedTzVersion(');
const readTz = src.slice(tzFrom, src.indexOf('\n  /**', tzFrom + 10));
assert.ok(readTz.length > 400, 'блок чтения редакции найден');
assert.match(readTz, /api\.github\.com\/repos\/\$\{repo\}\/contents\//, 'читается файл репозитория, а не Notion');
assert.match(readTz, /ref=\$\{encodeURIComponent\(C\.branch \|\| "main"\)\}/, 'ветка по умолчанию — main');
assert.match(readTz, /редакция\\s\*\\\*\*\\s\*\(\\d\+\\\.\\d\+\)/, 'номер редакции очереди разбирается из шапки');
assert.match(readTz, /cfn-tz-published/, 'результат кешируется, чтобы не долбить API');
assert.match(readTz, /return cache && cache\.file === file \? cache : null;/, 'сбой чтения не выдумывает версию');

// ── 4. Шапка очереди действительно в таком виде ──────────────────────────────
const doc = readFileSync(new URL('../../../docs/handoff/syn-3-card-queue.md', import.meta.url), 'utf8');
const head = doc.split('\n').slice(0, 6).join('\n');
assert.match(head, /редакция\s*1\.\d+/, 'в шапке очереди есть номер редакции');
assert.match(head, /ТЗ\s*1\.\d+/, 'в шапке очереди есть номер ТЗ');

// ── 5. Гейт подключён к приёмке и классифицирован ────────────────────────────
assert.match(
  src,
  /if \(typeof publicationGaps === "function" && typeof publishedTzVersion === "function"\)/,
  'ответ приёмки сверяется перед записью',
);
assert.match(src, /kind: "answer-unpublished"/, 'пауза названа своим видом');
assert.match(src, /"answer-unpublished": "transport",/, 'пауза транспорта, а не Мастера');

// ── 6. Канал публикации существует, а не подразумевается ─────────────────────
assert.match(src, /queueDoc: "docs\/handoff\/syn-3-card-queue\.md"/, 'место редакции задано конфигом');
assert.match(src, /telemetryRepo: ""/, 'служебные коммиты в проект не пишутся (D-086)');

console.log('ok 1 - tests/relay-publication-gap-smoke.mjs');
