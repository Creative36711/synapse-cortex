#!/usr/bin/env node
// Сторож молчания: отдельный процесс, который переживает браузер.
//
// Зачем отдельный процесс. Все прежние сторожа жили в самой вкладке: таймер,
// visibilitychange, busy-блокировка. Если userscript упал, вкладку закрыли или
// браузер уснул, замолкал и сторож — ровно тогда, когда он нужен. Поэтому
// транспорт раз в 10 минут публикует строку пульса в топик `<топик>-hb`, а этот
// процесс читает её с ntfy и молчит, пока пульс свежий.
//
// Что он делает:
//   • свежий пульс (не старше --max-silence) → тишина, код 0;
//   • пульса нет дольше предела → одно громкое уведомление в основной топик,
//     код 2, и повтор не раньше --repeat;
//   • пульс говорит `paused` — это не молчание: цикл стоит на паузе осознанно,
//     Мастер уже получил пуш от самой паузы.
//
// Запуск:
//   node tools/relay-watchdog.mjs --topic <проект> [--once]
//   RELAY_NTFY_TOKEN=... node tools/relay-watchdog.mjs --topic <проект> --loop 300
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NTFY = 'https://ntfy.sh';

/** Разбор строки пульса. Формат задаёт сборка: `hb 1 <версия> <state> <время> <отпечаток> <seq>`. */
export function parseHeartbeat(text) {
  const m = String(text || '').trim().match(/^hb\s+(\d+)\s+(\S*)\s+(running|paused)\s+(\S*)\s+(\S*)\s+(\d+)$/);
  if (!m) return null;
  return { schema: Number(m[1]), version: m[2], state: m[3], at: m[4], fingerprint: m[5], seq: Number(m[6]) || 0 };
}

/** Топик пульса: тот же, что у проекта, с суффиксом `-hb`. */
export function heartbeatTopic(topic) {
  const clean = String(topic || '').trim().replace(/^https?:\/\//i, '').replace(/^ntfy\.sh\//i, '')
    .split(/[?#]/)[0].replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) throw new Error('топик проекта не разобран: нужен <topic> или ссылка ntfy.sh/<topic>');
  return `${clean}-hb`;
}

/**
 * Решение сторожа по последнему пульсу.
 *
 * Отдельная функция, потому что её проверяет проба: «свежий пульс — молчание»,
 * «пульс кончился — тревога», «пауза — не тревога», «повтор не чаще предела».
 */
export function watchdogDecision({ now, last, maxSilenceMs, lastAlertAt = 0, repeatMs = 3600000 }) {
  if (!last) {
    const due = now - Number(lastAlertAt || 0) >= repeatMs;
    return {
      alert: due, reason: 'пульса нет ни одного',
      text: 'Relay молчит: пульса нет ни одного. Транспорт не начинал работу или не доходит до ntfy.',
    };
  }
  const beat = parseHeartbeat(last.message);
  if (!beat) {
    return { alert: false, reason: 'последнее сообщение в топике пульса не разобрано', text: '' };
  }
  const age = now - Date.parse(beat.at);
  if (!Number.isFinite(age)) {
    // Часы пульса недоступны — считаем по времени публикации ntfy.
    const byServer = now - Number(last.time || 0) * 1000;
    if (byServer > maxSilenceMs) {
      return { alert: true, beat, text: `Relay молчит ${Math.round(byServer / 60000)} мин (по времени ntfy). Сборка ${beat.version}.` };
    }
    return { alert: false, beat, text: '' };
  }
  if (age > maxSilenceMs) {
    return {
      alert: true, beat, age,
      text: `Relay молчит ${Math.round(age / 60000)} мин: последний пульс ${beat.at}, сборка ${beat.version} @ ${beat.fingerprint}. ` +
        'Браузер или вкладка могли закрыться — проверьте и нажмите «Продолжить».',
    };
  }
  if (beat.state === 'paused') return { alert: false, beat, reason: 'цикл на паузе', text: '' };
  return { alert: false, beat, age, text: '' };
}

async function ntfyGet(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`ntfy GET HTTP ${res.status}`);
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).filter((item) => item.event === 'message');
}

async function ntfyPost(topic, message, { title, priority = 5, tags = 'warning,rotating_light', token } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${NTFY}/`, {
    method: 'POST', headers,
    body: JSON.stringify({ topic, message, title, priority, tags: String(tags).split(',') }),
  });
  if (!res.ok) throw new Error(`ntfy POST HTTP ${res.status}`);
  return res.status;
}

function parseArgs(argv) {
  const out = { topic: process.env.RELAY_NTFY_TOPIC || '', token: process.env.RELAY_NTFY_TOKEN || '',
    maxSilence: 30, repeat: 60, loop: 0, once: false, state: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--topic') out.topic = next();
    else if (arg === '--token') out.token = next();
    else if (arg === '--max-silence') out.maxSilence = Number(next());
    else if (arg === '--repeat') out.repeat = Number(next());
    else if (arg === '--loop') out.loop = Number(next()) || 300;
    else if (arg === '--once') out.once = true;
    else if (arg === '--state') out.state = next();
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const STATE_DEFAULT = join(process.env.HOME || process.cwd(), '.relay-watchdog.json');

async function check(args) {
  const topic = heartbeatTopic(args.topic);
  const maxSilenceMs = Math.max(60, Number(args.maxSilence) || 30) * 60000;
  const repeatMs = Math.max(600, Number(args.repeat) || 60) * 60000;
  const statePath = args.state || STATE_DEFAULT;
  let state = { lastAlertAt: 0 };
  try { if (existsSync(statePath)) state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* пустое состояние */ }

  let messages = [];
  try {
    messages = await ntfyGet(`${NTFY}/${topic}/json?poll=1&since=2d`, args.token);
  } catch (e) {
    // Сеть до ntfy недоступна — это не повод кричать в тот же ntfy.
    return { ok: false, code: 3, error: String(e.message || e), decision: { alert: false, text: '' } };
  }
  const last = messages.length ? messages[messages.length - 1] : null;
  const decision = watchdogDecision({ now: Date.now(), last, maxSilenceMs, lastAlertAt: state.lastAlertAt, repeatMs });
  if (decision.alert) {
    await ntfyPost(args.topic, decision.text, { title: 'Relay: цикл молчит', token: args.token });
    state.lastAlertAt = Date.now();
  }
  state.lastCheckAt = Date.now();
  state.lastBeatAt = decision.beat?.at || '';
  state.lastState = decision.beat?.state || '';
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch { /* состояние — удобство, не обязанность */ }
  return { ok: true, code: decision.alert ? 2 : 0, decision, topic };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node tools/relay-watchdog.mjs --topic <проект> [--once | --loop <сек>] [--max-silence <мин>] [--repeat <мин>]');
    console.log('Коды: 0 — тишина (пульс свежий), 2 — тревога отправлена, 3 — сеть до ntfy недоступна.');
    return 0;
  }
  if (!args.topic) {
    console.error('Нужен --topic <проект> или RELAY_NTFY_TOPIC: без топика сторож не знает, что слушать.');
    return 1;
  }
  const runOnce = async () => {
    const result = await check(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) console.error(`сторож: ${result.error}`);
    else if (result.decision.alert) console.error(`тревога: ${result.decision.text}`);
    else console.log(`тишина: ${result.decision.reason || 'пульс свежий'}`);
    return result.code;
  };
  if (args.once) return runOnce();
  // Бесконечный режим: сторож не должен умирать от одной сетевой ошибки.
  for (;;) {
    const code = await runOnce();
    if (code === 1) return code;
    await new Promise((resolve) => setTimeout(resolve, Math.max(60, args.loop) * 1000));
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`сторож упал: ${e && e.message}`);
    process.exitCode = 3;
  });
}
