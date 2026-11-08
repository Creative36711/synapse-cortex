// Сторож молчания вне браузера (D-073, пункт 4).
//
// Сторож — отдельный процесс: то, что живёт во вкладке, умирает вместе с ней, а
// нужен он именно тогда, когда вкладка замолчала. Здесь проверяется решение,
// а не сеть:
//   • свежий пульс → молчание (нормальная работа не звонит);
//   • пульс старше предела → тревога с числами (сколько минут, какая сборка);
//   • пульс `paused` → не тревога: цикл стоит осознанно, Мастер уже уведомлён;
//   • повторы ограничены, иначе сторож сам станет источником шума;
//   • разбор строки пульса совпадает с тем, что пишет транспорт.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHeartbeat as watchParse, heartbeatTopic, watchdogDecision } from '../../relay-watchdog.mjs';
import { healApi } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '..', 'relay.user.js'), 'utf8');
const runner = readFileSync(join(here, '..', '..', 'relay-watchdog.mjs'), 'utf8');

// ── 1. Сторож в репозитории, отдельно от сборки ────────────────────────────
assert.ok(runner.includes('watchdogDecision'), 'сторож — отдельный процесс, а не часть бандла');
assert.doesNotMatch(bundle, /watchdogDecision/, 'в бандле сторожа нет: он не умирает вместе с вкладкой');

// ── 2. Топик пульса: производный, а не новый секрет ───────────────────────
assert.equal(heartbeatTopic('project'), 'project-hb');
assert.equal(heartbeatTopic('https://ntfy.sh/project?x=1'), 'project-hb');
assert.throws(() => heartbeatTopic('плохой топик!'), /не разобран/, 'кривой топик отвергается, а не угадывается');

// ── 3. Формат пульса совпадает у транспорта и сторожа ─────────────────────
{
  const line = healApi.heartbeatLine({
    version: '1.13.0', fingerprint: 'deadbeefdeadbeef', state: 'running', at: '2026-11-08T20:00:00.000Z', seq: 12,
  });
  assert.deepEqual(watchParse(line), healApi.parseHeartbeat(line), 'оба разбора читают одну строку одинаково');
  assert.equal(watchParse(line).state, 'running');
  assert.equal(watchParse(line).version, '1.13.0');
  // Транспорт пишет пульс через ntfy в топик с суффиксом -hb.
  assert.match(bundle, /ntfyPublish\(`\$\{base\}-hb`/, 'пульс уходит в отдельный топик');
  assert.match(bundle, /heartbeatLine\(\{/, 'строка пульса строится общей функцией');
  assert.match(bundle, /setInterval\(beat, Math\.max\(60000, Number\(C\.heartbeatMs\) \|\| 600000\)\)/,
    'пульс не чаще раза в минуту и по умолчанию раз в 10 минут: это квота, а не каждый тик');
}

// ── 4. Решение: свежий пульс — молчание ───────────────────────────────────
{
  const now = Date.parse('2026-11-08T20:10:00.000Z');
  const beat = { event: 'message', time: Math.floor(Date.parse('2026-11-08T20:08:00.000Z') / 1000),
    message: 'hb 1 1.13.0 running 2026-11-08T20:08:00.000Z fp 8' };
  const d = watchdogDecision({ now, last: beat, maxSilenceMs: 30 * 60000 });
  assert.equal(d.alert, false, 'нормальная работа — молчание');
  assert.equal(d.beat.state, 'running');
}

// ── 5. Решение: пульс кончился — тревога с числами ────────────────────────
{
  const now = Date.parse('2026-11-08T21:00:00.000Z');
  const beat = { event: 'message', time: Math.floor(Date.parse('2026-11-08T20:08:00.000Z') / 1000),
    message: 'hb 1 1.13.0 running 2026-11-08T20:08:00.000Z deadbeef 8' };
  const d = watchdogDecision({ now, last: beat, maxSilenceMs: 30 * 60000 });
  assert.equal(d.alert, true, 'принудительная остановка видна сторожу');
  assert.match(d.text, /молчит 52 мин/, 'в тревоге названо, сколько молчит');
  assert.match(d.text, /1\.13\.0/, 'и какая сборка');
  assert.match(d.text, /«Продолжить»/, 'и что делать');
}

// ── 6. Решение: пауза — не тревога, повторы ограничены ────────────────────
{
  const now = Date.parse('2026-11-08T20:40:00.000Z');
  const paused = { event: 'message', time: Math.floor(now / 1000), message: 'hb 1 1.13.0 paused 2026-11-08T20:35:00.000Z fp 3' };
  const d = watchdogDecision({ now, last: paused, maxSilenceMs: 30 * 60000 });
  assert.equal(d.alert, false, 'осознанная пауза не будит второй раз');
  assert.equal(d.reason, 'цикл на паузе');

  const none = watchdogDecision({ now, last: null, maxSilenceMs: 30 * 60000, lastAlertAt: 0, repeatMs: 60 * 60000 });
  assert.equal(none.alert, true, 'пульса нет ни одного — тревога');
  assert.match(none.text, /ни одного/);
  const quiet = watchdogDecision({ now, last: null, maxSilenceMs: 30 * 60000, lastAlertAt: now - 5 * 60000, repeatMs: 60 * 60000 });
  assert.equal(quiet.alert, false, 'повтор не чаще предела: сторож не превращается в источник шума');
  const again = watchdogDecision({ now, last: null, maxSilenceMs: 30 * 60000, lastAlertAt: now - 61 * 60000, repeatMs: 60 * 60000 });
  assert.equal(again.alert, true, 'после предела повтор разрешён');

  const garbage = watchdogDecision({ now, last: { event: 'message', message: 'просто текст' }, maxSilenceMs: 60000 });
  assert.equal(garbage.alert, false, 'нечитаемое сообщение в топике пульса не считается пульсом');
}

// ── 7. Коды возврата задокументированы: 0/2/3 ─────────────────────────────
assert.match(runner, /Коды: 0 — тишина \(пульс свежий\), 2 — тревога отправлена, 3 — сеть до ntfy недоступна/,
  'коды возврата названы: «локально работает» не выдаётся за проверку');
assert.match(runner, /--max-silence/, 'предел молчания настраивается');
assert.match(runner, /--once/, 'одноразовый прогон для cron/Планировщика');
// Сеть до ntfy недоступна — код 3, а не тревога в тот же ntfy.
assert.match(runner, /code: 3/, 'сеть недоступна — отдельный код');

console.log('OK: relay-watchdog — свежий пульс молчит, остановка тревожит один раз, пауза не будит, коды возврата названы');
