// Проба 1.4.74: пауза «blocked» объясняет факт, а не шаблон.
//
// Случай Мастера (2026-10-25, пауза 19:43:32). Координатор вернул
// next:"blocked" без need, и транспорт написал:
//   «нужна роль, которой нет в «Ролях». Создайте агента в Arena…»
// Проверка Notion показала обратное: роль Tools в базе есть — «Статус» =
// «Ждёт», «Agent URL» пуст. Мастер по такой строке пошёл бы создавать нового
// агента. Здесь проверяется, что текст паузы собирается по фактам:
//
//   • роль названа — видно её настоящий статус и что именно дозаполнить;
//   • роль не названа — причина видна по очереди (какой черновик ждёт роль);
//   • активная роль с Agent URL — отдельная причина (Координатор её не увидел);
//   • Rework назван своим словом, а не «нет роли»;
//   • уже открытый вопрос Мастера не теряется;
//   • пустой список ролей не превращается в ложное «роли нет».

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];

assert.equal((src.split('\n').find((line) => line.startsWith('// @version')) || '').trim(), '// @version      ' + V, `версия ${V}`);

const from = src.indexOf('  function blockedReason(');
const to = src.indexOf('\n  }\n', from);
assert.ok(from > 0 && to > from, 'blockedReason на месте');

const blockedReason = new Function(
  'norm', 'rt', 'taskTitle', 'taskRole',
  `${src.slice(from, to + 4)}; return blockedReason;`,
)(
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (card) => card.properties['Запрос'].title[0].text.content,
  (card) => card.properties['Кому']?.select?.name || '',
);

const card = (title, who) => ({
  properties: {
    'Запрос': { title: [{ text: { content: title } }] },
    'Кому': { select: who ? { name: who } : null },
  },
});

const roleRow = (name, status, url) => ({ name, status, url });
const tools = roleRow('Tools', 'Ждёт', '');
const turn = roleRow('Turn Runtime', 'Активна', 'https://arena.ai/agent/01a16f4e-7185-7da7-8289-92f86b85a467');
const directory = [tools, turn];

const queue = {
  summary: '0 Submitted, 0 Running, 0 Ready, 2 Rework, 1 Draft',
  draft: [card('NAR-2.15 · черновик: кит-среда для пака', 'Tools')],
  rework: [card('NAR-2.3 · Первый настоящий пак: narrative', 'Turn Runtime'), card('NAR-2.12 · Перенос', 'Turn Runtime')],
};

const openRow = {
  properties: {
    'Вопрос': { title: [{ plain_text: 'Роль Tools в статусе «Ждёт» без Agent URL' }] },
    'По умолчанию': { rich_text: [{ plain_text: 'Активировать Tools и выдать NAR-2.15' }] },
    'Срок': { date: { start: '2026-10-26T16:17:00.000Z' } },
  },
};

// ── 1. Роль не названа — причина видна по очереди ──────────────────────────
const blind = blockedReason({ need: '', directory, queue, open: [openRow] });
assert.match(blind, /Координатор остановил цикл, но роль не назвал/, 'честно сказано, что роль не названа');
assert.doesNotMatch(blind, /которой нет в «Ролях»/, 'прежней ложной фразы нет');
assert.match(blind, /черновик «NAR-2\.15 · черновик: кит-среда для пака» ждёт роль Tools/, 'назван черновик и его роль');
assert.match(blind, /«Статус» = «Ждёт», «Agent URL» пуст/, 'назван настоящий статус роли');
assert.match(blind, /Новый агент нужен только если роли правда нет/, 'создавать агента не предлагается по умолчанию');
assert.match(blind, /Очередь: 0 Submitted, 0 Running, 0 Ready, 2 Rework, 1 Draft/, 'очередь цитируется как есть');
assert.match(blind, /Rework — это не «нет роли»/, 'Rework назван причиной карточки, а не ролью');
assert.match(blind, /Вопрос об этом уже задан: «Роль Tools в статусе «Ждёт» без Agent URL»/, 'открытый вопрос виден');
assert.match(blind, /по умолчанию: Активировать Tools и выдать NAR-2\.15/, 'вариант по умолчанию назван');
assert.match(blind, /26\.10, 19:17/, 'срок вопроса в московском времени');
assert.doesNotMatch(blind, /Других поводов останавливать цикл у Координатора нет/, 'прежней категоричной фразы нет');
assert.match(blind, /Право на остановку у Координатора одно/, 'граница права названа как правило');

// ── 2. Роль названа и она есть, но не активна ──────────────────────────────
const named = blockedReason({ need: 'Tools', directory, queue });
assert.match(named, /нужна роль «Tools»/, 'роль названа по имени');
assert.match(named, /Роль «Tools» в «Ролях» есть, но «Статус» = «Ждёт», «Agent URL» пуст/, 'статус назван');
assert.match(named, /создавать агента не нужно/, 'сказано прямо: новый агент не нужен');
assert.match(named, /заполните «Agent URL» и поставьте «Статус» = «Активна»/, 'названо точное действие');

// ── 3. Роль названа, но её нет в базе ──────────────────────────────────────
const absent = blockedReason({ need: 'Kernel', directory, queue });
assert.match(absent, /Роли «Kernel» в базе «Роли» нет — создайте агента в Arena/, 'отсутствующая роль отличается от неактивной');

// ── 4. Роль активна и Agent URL заполнен — виноват не Мастер ───────────────
const active = blockedReason({ need: 'Turn Runtime', directory, queue });
assert.match(active, /Роль «Turn Runtime» активна и «Agent URL» заполнен/, 'факт назван');
assert.match(active, /проверьте «Функцию» и «Зону записи»/, 'сказано, что смотреть');
assert.doesNotMatch(active, /заполните «Agent URL»/, 'заполнять нечего');

// ── 5. Роль не названа, черновиков под неактивную роль нет ─────────────────
const empty = blockedReason({
  need: '',
  directory,
  queue: { summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 1 Draft', draft: [card('NAR-1.1 · Раз', 'Turn Runtime')], rework: [] },
});
assert.match(empty, /Rework пуст — по очереди причину не видно/, 'при отсутствии следов не выдумываем причину');
assert.doesNotMatch(empty, /ждёт роль Tools/, 'чужие роли не приписываются');

// ── 6. Пустая база ролей не превращается в ложное «роли нет» ───────────────
const noDirectory = blockedReason({ need: 'Tools', directory: [] });
assert.match(noDirectory, /Роли «Tools» в базе «Роли» нет/, 'без данных — так и говорим');

// ── 7. Вопрос при остановке виден в паузе ──────────────────────────────────
const withAsk = blockedReason({ need: 'Tools', directory, queue, ask: 'Принять ли ADR 2.14?', asked: true });
assert.match(withAsk, /Координатор спрашивает: «Принять ли ADR 2\.14\?»/, 'суть вопроса в тексте паузы');
assert.match(withAsk, /Вопрос записан в базу «Обратная связь»/, 'сказано, что он уже в базе');

const lostAsk = blockedReason({ need: '', directory, queue, ask: 'Принять ли ADR 2.14?', asked: false });
assert.match(lostAsk, /Вопрос в «Обратную связь» не записался — он есть только в этом сообщении/, 'не потеряли и при сбое записи');

console.log(
  `OK: relay ${V} — пауза «blocked» называет настоящую причину: статус роли, ` +
    'её Agent URL, очередь и уже заданный вопрос, а не «роли нет в «Ролях»»',
);
