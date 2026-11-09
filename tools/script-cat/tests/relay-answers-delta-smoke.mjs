// Проба 1.14.6: боевой план Координатора не влезал в свой предел из-за ответов
// Мастера, а не из-за инструкций.
//
// Инцидент транспорта 11.01 (сборка 1.14.5 @ fe02c9d3b5ea6486):
//
//   Промпт не собран (plan 4126f0cf-…): budget_exceeded — total 8178 >
//   жёсткого лимита 7500. Размер блоков: answers.delta 3346, queue.snapshot 1191,
//   queue.coordinator 901, marker.coordinator 392. Отправка не выполнялась.
//
// Отказ был честный (D-034: не режем молча), но цена неверная: ход встал
// из-за РАЗМЕРА ответов Мастера, а не из-за их содержания. Длину ответа
// транспорт не ограничивает (D-072: «пиши целиком, длина не ограничена»), и
// блок `answers.delta` (verbatim) рос без потолка, пока не упёрся.
//
// Проверяется:
//   • инструкции не режутся и не сжимаются ни при каком размере данных;
//   • брифинг сжимается ТОЛЬКО когда не влезает, и говорит об этом сам;
//   • сжатие называет источник полного текста (Notion), а не просто обрезает;
//   • боевой случай 11.01 (3346 → план) теперь собирается с запасом;
//   • худший случай (три ответа по 12000) влезает так же;
//   • короткий брифинг идёт байт-в-байт как раньше — сжатие не срабатывает зря.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler, planRequest } from './helpers/prompt-env.mjs';

const here = new URL('.', import.meta.url);
const feedback = readFileSync(new URL('../src/24-feedback.js', import.meta.url), 'utf8');

// ── 1. fitBrief: правило сжатия, исполняется как есть ──────────────────────
const fitSrc = feedback.slice(feedback.indexOf('  function fitBrief('), feedback.indexOf('  /** Свойства строки базы «Вопросы». */'));
const makeFit = (max) => new Function('C', `${fitSrc}; return fitBrief;`)({ answerBriefMax: max });
const fitBrief = makeFit(1800);
const HEAD = 'Ответы на обратную связь от Мастера и приёмки — учти их в этом ходе: ';
const reply = (name, n) => `«${name}» → ${'ж'.repeat(n)}`;

// Короткий брифинг не трогаем вовсе: сжатие — исключение, а не обычный путь.
{
  const lines = [reply('Вопрос', 40), reply('Другой', 25)];
  assert.equal(fitBrief(lines, '', HEAD, 2), `${lines.join('; ')}.`, 'короткий брифинг идёт целиком, без отметок');
}

// Длинный — сжимается, но с отметкой и адресом.
{
  const lines = [reply('Локали', 690), reply('Глоссарий', 690), reply('Парсер', 690)];
  const out = fitBrief(lines, '', HEAD, 3);
  const total = HEAD.length + out.length;
  // Порог — C.answerBriefMax для одного блока; заголовок строки идёт сверху и
  // в порог не входит, поэтому допуск — длина заголовка.
  assert.ok(total <= 1800 + 90, `сжатый брифинг влезает в порог: ${total}`);
  assert.match(out, /сжато до 1800 знаков/, 'сказано, что текст сжат, и до какого размера');
  assert.match(out, /«Вопросах» Notion/, 'назван источник полного текста');
  assert.match(out, /Полных ответов 3, показаны все 3/, 'видно, сколько их всего и что показаны все');
  assert.match(out, /кратко/, 'каждая сжатая строка помечена');
  // Бюджет строки ~240 знаков: остаток от 690 должен быть видимо короче.
  // Бюджет строки при трёх ответах ~528 знаков: остаток от 690 должен быть
  // видимо короче, а от 12000 — тем же по размеру (порог, а не пропорция).
  assert.doesNotMatch(out, /ж{700}/, 'длинный «хвост» действительно снят');
  // Последняя строка несёт отметку о сжатии — считаем её без отметки.
  const bodies = out.split('; ').slice(0, 3).map((part) => part.split('. Полных ответов')[0]);
  const longest = Math.max(...bodies.map((part) => part.length));
  assert.ok(longest <= 600, `каждая строка сжата до читаемого начала: самая длинная ${longest}`);
  // Начало каждого ответа сохранено: агент видит, о чём речь, а не «…».
  for (const name of ['Локали', 'Глоссарий', 'Парсер']) assert.match(out, new RegExp(`«${name}» → ж`), `начало ответа «${name}» на месте`);
}

// Ответов больше, чем помещается: лишние считаются, а не теряются молча.
{
  const lines = [reply('A', 900), reply('B', 900), reply('C', 900)];
  const out = fitBrief(lines, '; и ещё 4', HEAD, 7);
  assert.match(out, /и ещё 4/, 'счётчик непоказанных сохранён');
  assert.match(out, /Полных ответов 7, показаны все 3/, 'и общее число названо отдельно от показанных');
}

// Худший случай D-072: ответ не ограничен в длине, значит и брифинг тоже.
{
  const lines = [0, 1, 2].map((i) => reply(`Вопрос ${i}`, 12000));
  const out = fitBrief(lines, '', HEAD, 3);
  assert.ok(HEAD.length + out.length <= 1800 + 90, `36 000 знаков сжимаются до ${HEAD.length + out.length}`);
  assert.match(out, /сжато до 1800 знаков/, 'и это тоже названо');
}

// Порог ноль/пустой — сжатия нет: правило не должно включаться само по себе.
{
  const lines = [reply('X', 5000)];
  const off = makeFit(0);
  assert.equal(off(lines, '', HEAD, 1), `${lines.join('; ')}.`, 'без порога брифинг не сжимается');
}

// ── 2. Боевой случай 11.01: план собирается с запасом ─────────────────────
const briefingFor = (lines) => HEAD + fitBrief(lines, '', HEAD, lines.length);
const queueContext = (answersLine) => ({
  summary: '0 Submitted, 0 Running, 2 Ready, 0 Rework, 6 Draft, 0 Blocked',
  ready: 'Готовы к выдаче: ' + [
    'B0-r1 · Повтор репетиции V-2 (Spec Auditor, Sequence 10)',
    'B5 · Анализатор литералов fail-closed (Locale Auditor, Sequence 11)',
  ].join('; '),
  draft: 'Черновики: ' + [
    'B6 · Локали en/ru (Locale Auditor, Sequence 20)',
    'B7 · Глоссарий (Locale Auditor, Sequence 21)',
    'B8 · Парсер недоступен (Spec Auditor, Sequence 22)',
    'B9 · Восстановление (Spec Auditor, Sequence 23)',
    'B10 · Отчёт (Warden, Sequence 24)',
    'B11 · Хвост (Locale Auditor, Sequence 25)',
  ].join('; ') + '.',
  answerLine: 'Журнал ответа Kernel (NAR-1.2): https://drive.google.com/file/d/LOG2/view — прочитай, если нужны детали ответа.',
  answersLine,
});

{
  // Тот же состав, что дал 8178 в бою (три ответа по ~700 знаков).
  const briefing = briefingFor([reply('Вопрос о локалях', 690), reply('Вопрос о глоссарии', 690), reply('Вопрос о парсере', 690)]);
  const r = PromptCompiler.compile(planRequest({ queue: queueContext(briefing) }));
  assert.equal(r.ok, true, `боевой план собирается, а не падает: ${r.error?.message || ''}`);
  assert.ok(r.metrics.chars <= 7500, `план влезает в предел Coordinator 7500: ${r.metrics.chars}`);
  const delta = r.blocks.find((b) => b.id === 'answers.delta');
  // Три части брифинга вместе: половина порога ответам, половина открытым.
  assert.ok(delta.chars <= 2300, `answers.delta больше не раздувается: ${delta.chars}`);
  assert.ok(r.metrics.overheadChars < 3500, `инструкции не выросли: overhead ${r.metrics.overheadChars}`);
  // Инструкции на месте: сжатие не имеет права тронуть их.
  for (const text of ['Running/Submitted — движок', 'CF_COORDINATOR_RESULT', 'Оракул', 'next — имя роли']) {
    assert.ok(r.text.includes(text), `инструкция «${text}» на месте`);
  }
}

// Худший случай: три ответа по 12000 знаков (D-072 не ограничивает).
{
  const briefing = briefingFor([0, 1, 2].map((i) => reply(`Вопрос ${i}`, 12000)));
  const r = PromptCompiler.compile(planRequest({ queue: queueContext(briefing) }));
  assert.equal(r.ok, true, 'даже 36 000 знаков ответов не роняют план');
  assert.ok(r.metrics.chars <= 7500, `и влезают в предел: ${r.metrics.chars}`);
}

// Короткий брифинг — плана не касается, отметки о сжатии нет.
{
  const briefing = briefingFor([reply('Вопрос', 30)]);
  const r = PromptCompiler.compile(planRequest({ queue: queueContext(briefing) }));
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /сжато до/, 'нет ложной отметки о сжатии там, где его не было');
  assert.match(r.text, /«Вопрос» → ж/, 'ответ дошёл целиком');
}

// ── 3. Связи в коде: порог в конфиге, оба блока через одно правило ─────────
{
  const config = readFileSync(new URL('../src/01-config.js', import.meta.url), 'utf8');
  assert.match(config, /answerBriefMax:\s*1800/, 'порог брифинга — в конфиге, а не в блоке');
  // И открытые вопросы, и ответы идут через fitBrief: иначе один блок останется
  // неограниченным и однажды снова упрётся в предел профиля.
  const answersFn = feedback.slice(feedback.indexOf('  function answersLine('), feedback.indexOf('  function fitBrief('));
  assert.match(answersFn, /fitBrief\(/, 'ответы сжимаются через общее правило');
  const openFn = feedback.slice(feedback.indexOf('  function openQuestionsLine('), feedback.indexOf('  function answersLine('));
  assert.match(openFn, /fitBrief\(/, 'открытые вопросы — тем же правилом');
  // Инструкции не должны знать о сжатии: оно живёт в данных.
  const blocks = readFileSync(new URL('../src/prompt-blocks.js', import.meta.url), 'utf8');
  assert.doesNotMatch(blocks, /answerBriefMax/, 'блоки промпта не режут инструкций ради данных');
}
