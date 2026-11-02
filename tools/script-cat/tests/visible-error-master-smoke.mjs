// Current visible-error → Master-pause contract in relay.user.js.
// The former dispatch.user.js automation model is retired; recovery, Drive
// logging, Coordinator markers, and send safety are exercised by their current
// focused tests in the same 71-file suite.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const userScript = new URL('../relay.user.js', import.meta.url);
assert.equal(existsSync(new URL('../dispatch.user.js', import.meta.url)), false, 'legacy dispatch.user.js stays absent');
const source = readFileSync(userScript, 'utf8');
const version = source.match(/^\/\/ @version\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version, 'active userscript declares a valid version');
assert.match(source, /^\/\/ @match\s+https:\/\/arena\.ai\/\*/m, 'error monitor belongs to the Arena userscript');

const objectSource = (name) => {
  const start = source.indexOf(`  const ${name} = {`);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `${name} configuration exists`);
  return source.slice(start, end + '\n  };'.length);
};
const keys = new Function(`${objectSource('K')}\nreturn K;`)();

// Execute the production visible-error monitor with its Notion/DOM edges
// injected. This preserves retry, duplicate-alert, UI-card, and Master-pause
// negative cases without emulating live Arena.
const monitorStart = source.indexOf('  function monitorVisibleErrors() {');
const monitorEnd = source.indexOf('\n\n  // ───────────────────────────── отправка', monitorStart);
assert.ok(monitorStart > 0 && monitorEnd > monitorStart, 'monitorVisibleErrors is present');
const monitorSource = source.slice(monitorStart, monitorEnd);
assert.doesNotMatch(monitorSource, /\.click\(|sendButton|location\.reload\(\)/, 'the error monitor never clicks, resends, or reloads');
const makeMonitor = ({ alert = null, card = '', expect = null, retryResult = false, initiallySeen = [] } = {}) => {
  const seen = new Set(initiallySeen);
  const calls = { marked: [], retry: [], pause: [] };
  const monitor = new Function(
    'K', 'latestUserMessageAlert', 'alreadyReported', 'markReported', 'GM_getValue',
    'retryRejectedHandoff', 'pause', 'detectVisibleErrorCard',
    `${monitorSource}\nreturn monitorVisibleErrors;`,
  )(
    keys,
    () => alert,
    (key) => seen.has(key),
    (key) => { seen.add(key); calls.marked.push(key); },
    (key, fallback) => (key === keys.expect ? expect : fallback),
    (...args) => { calls.retry.push(args); return retryResult; },
    (...args) => calls.pause.push(args),
    () => card,
  );
  return { monitor, calls };
};

// 1. First Arena refusal can use the one bounded current retry; it is not
//    reported as a Master pause before the retry is attempted.
{
  const alert = { messageId: 'message-1', text: 'Something went wrong. Please try again.' };
  const { monitor, calls } = makeMonitor({
    alert,
    expect: { roleId: 'agent-7', runId: 'run-1', arenaResend: 0, sentAt: Date.now() },
    retryResult: true,
  });
  assert.equal(monitor(), true, 'the alert is handled');
  assert.equal(calls.retry.length, 1, 'bounded resend is consulted once');
  assert.equal(calls.pause.length, 0, 'a successful first retry does not wake the Master');
  assert.deepEqual(calls.marked, ['alert:message-1'], 'alert is deduplicated before the next tick');
}

// 2. A second rejection after the bounded retry stops and preserves the exact
//    live dispatch/run context for the Master to inspect.
{
  const alert = { messageId: 'message-2', text: 'Request blocked by policy.' };
  const { monitor, calls } = makeMonitor({
    alert,
    expect: { roleId: 'agent-7', runId: 'run-2', arenaResend: 1, sentAt: Date.now(), title: 'STAB-1.17' },
  });
  assert.equal(monitor(), true, 'second refusal is handled');
  assert.equal(calls.pause.length, 1, 'second refusal pauses for a person');
  assert.match(calls.pause[0][0], /Arena второй раз не приняла задание/);
  assert.deepEqual(calls.pause[0][1], { kind: 'arena-error', ref: 'message-2', runId: 'run-2' });
}

// 3. An unassociated/first visible refusal pauses with its text, rather than
//    claiming a retry or silently advancing the queue.
{
  const { monitor, calls } = makeMonitor({
    alert: { messageId: 'message-3', text: 'Access denied.' },
    expect: null,
  });
  assert.equal(monitor(), true);
  assert.equal(calls.pause.length, 1);
  assert.match(calls.pause[0][0], /Видимая ошибка Arena.*Access denied/);
  assert.equal(calls.pause[0][1].kind, 'arena-error');
}

// 4. Repeated alert is not re-announced or retried; an unrelated red UI card
//    is separately deduplicated and escalated.
{
  const repeated = makeMonitor({
    alert: { messageId: 'message-4', text: 'Access denied.' },
    initiallySeen: ['alert:message-4'],
  });
  assert.equal(repeated.monitor(), false, 'already reported alert is ignored');
  assert.equal(repeated.calls.retry.length, 0);
  assert.equal(repeated.calls.pause.length, 0);

  const ui = makeMonitor({ card: 'Unexpected UI error card' });
  assert.equal(ui.monitor(), true, 'visible UI card is handled');
  assert.equal(ui.calls.pause.length, 1);
  assert.deepEqual(ui.calls.pause[0], [
    'Необработанная ошибка интерфейса: Unexpected UI error card.',
    { kind: 'ui-error' },
  ]);
  assert.equal(ui.monitor(), false, 'same UI card does not cause a second pause');
  assert.equal(ui.calls.pause.length, 1);
}

// 5. A clear page is a no-op: no false pause, retry, or Master notification.
{
  const { monitor, calls } = makeMonitor();
  assert.equal(monitor(), false);
  assert.equal(calls.retry.length, 0);
  assert.equal(calls.pause.length, 0);
}

// Pause the current cycle without editing Dispatch State, releasing the run,
// or dropping a live expectation. A real visible error is loud; quiet pauses
// remain explicitly non-urgent.
const pauseStart = source.indexOf('  function pause(reason, context = {}) {');
const pauseEnd = source.indexOf('\n\n  /**', pauseStart);
assert.ok(pauseStart > 0 && pauseEnd > pauseStart, 'pause function is present');
const pauseFn = new Function(
  'K', 'GM_setValue', 'autoOn', 'log', 'notifyNtfy', 'playAlert', 'setStatus',
  `${source.slice(pauseStart, pauseEnd)}\nreturn pause;`,
);
{
  const store = new Map();
  const pending = { roleId: 'agent-7', text: 'read the card' };
  const expectation = { kind: 'dispatch', ref: 'dispatch-5', runId: 'run-5', sentAt: 123 };
  store.set(keys.pending, pending);
  store.set(keys.expect, expectation);
  const calls = { log: [], notify: [], alert: 0, status: 0 };
  const pause = pauseFn(
    keys,
    (key, value) => store.set(key, value),
    () => true,
    (...args) => calls.log.push(args),
    (...args) => calls.notify.push(args),
    () => { calls.alert += 1; },
    () => { calls.status += 1; },
  );
  pause('Arena rejected the live run', { kind: 'arena-error', ref: 'message-5', runId: 'run-5' });
  assert.equal(store.get(keys.paused), 'Arena rejected the live run');
  assert.deepEqual(store.get(keys.pause), {
    kind: 'arena-error', reason: 'Arena rejected the live run', at: store.get(keys.pause).at,
    ref: 'message-5', runId: 'run-5', turnId: '', tries: null, wasAuto: true,
  });
  assert.equal(calls.notify[0][1].priority, '5', 'Master pause is urgent');
  assert.equal(calls.notify[0][1].cycleStopped, true, 'a real pause marks the cycle stopped');
  assert.equal(calls.log[0][0], 'ПАУЗА: Arena rejected the live run');
  assert.equal(calls.alert, 1, 'Master pause plays the local alert');
  assert.equal(calls.status, 1, 'panel status is refreshed');
  assert.equal(store.get(keys.pending), pending, 'pause itself leaves the handoff queue intact');
  assert.equal(store.get(keys.expect), expectation, 'pause itself leaves live-run expectation intact');
}
{
  const store = new Map();
  const notifications = [];
  let alerts = 0;
  const pause = pauseFn(keys, (key, value) => store.set(key, value), () => false, () => {}, (...args) => notifications.push(args), () => { alerts += 1; }, () => {});
  pause('Reviewer will decide this', { quiet: true, kind: 'reviewer', notifyTitle: 'Relay: review' });
  assert.equal(notifications[0][1].priority, '2', 'quiet pause does not become a loud Master alert');
  assert.equal(notifications[0][1].cycleStopped, true, 'quiet pause is still an essential stop');
  assert.equal(alerts, 0, 'quiet pause has no local alarm');
}

// An error is checked before setup and any subsequent dispatch processing.
const tickStart = source.indexOf('  async function tick(fromToggle = false) {');
const tickEnd = source.indexOf('      await setup(false);', tickStart);
assert.ok(tickStart > 0 && tickEnd > tickStart, 'tick entry is present');
const tickBeforeSetup = source.slice(tickStart, tickEnd);
const captchaCheck = tickBeforeSetup.indexOf('if (captchaDialog()) {');
const errorCheck = tickBeforeSetup.indexOf('if (monitorVisibleErrors()) return;');
assert.ok(captchaCheck >= 0 && errorCheck > captchaCheck, 'visible errors are checked after captcha, before setup');
assert.ok(errorCheck < tickBeforeSetup.length, 'visible error returns before normal dispatch work');
const pauseSource = source.slice(pauseStart, pauseEnd);
assert.doesNotMatch(pauseSource, /patch\(|releaseUndelivered\(|dropHandoff\(/, 'pause helper does not release or rewrite the current dispatch');

// Ntfy remains split: routine is silent, progress is quiet, and a Master stop
// is loud. The production classifier is executed, not merely source-matched.
const ntfyStart = source.indexOf('  const QUIET_NTFY = [');
const ntfyEnd = source.indexOf('\n\n  /**', source.indexOf('  function classifyNtfy(', ntfyStart));
assert.ok(ntfyStart >= 0 && ntfyEnd > ntfyStart, 'ntfy classifier block is present');
const classifyNtfy = new Function(`${source.slice(ntfyStart, ntfyEnd)}\nreturn classifyNtfy;`)();
assert.equal(classifyNtfy('Проверяю роль и очередь…', false), null);
assert.equal(classifyNtfy('Выдан ход Builder: STAB-1.17', false), null, 'ожидается подтверждённая доставка');
assert.equal(classifyNtfy('Ответ записан → Submitted', false)?.priority, '2');
assert.equal(classifyNtfy('ПАУЗА: видимая ошибка Arena', true), null, 'строка журнала не подменяет событие остановки');
assert.equal(classifyNtfy('Цикл остановлен', true, { ntfy: 'loud', cycleStopped: true })?.priority, '5');
assert.equal(classifyNtfy('Скрыто', true, { skip: true }), null);
assert.equal(classifyNtfy('Напоминание', true, { ntfy: 'quiet' })?.priority, '2');

assert.doesNotMatch(source, /chatTimeoutRecovery/, 'retired timeout recovery state is not consulted');
assert.doesNotMatch(source, /function coordinatorMarkerResetEligible\(/, 'retired campaign/dispatch reset helper is not treated as current behavior');

console.log(`OK: relay ${version} — visible Arena errors dedupe, preserve the live run, and alert the Master`);
