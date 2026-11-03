// Проба 1.4.63: «слит» в маркере — заявка, а не факт; 404 без токена — не «PR нет».
//
// 24.10 на странице Build/Release висела активная «Create PR»: Arena не знает
// о PR, который агент слил через `gh`. Тогда транспорт верил маркеру на слово.
// 1.4.48 стала спрашивать GitHub — и в тот же день отправила готовый PR #37 в
// Rework. Причина не в маркере: `example/relay-fixture` приватный, и анонимный
// запрос к API отвечает на него 404 — ровно как на несуществующий PR. Отличить
// «нет PR» от «не видно репозитория» может только токен.
//
// Здесь проверяется:
//   • номер PR берётся и числом, и ссылкой, и с чужим репозиторием;
//   • состояние спрашивается у GitHub с токеном и без;
//   • 404 без токена = «не проверили», и 404 с токеном — тоже не «нет PR»;
//   • 401/403 — тоже «не проверили», а не отказ в работе;
//   • ложная заявка (open / closed) не принимается и даёт Rework;
//   • в журнале сказано, подтвердил GitHub мерж или нет.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Версия и разрешение хоста ───────────────────────────────────────────
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
assert.match(src, /\/\/ @connect\s+api\.github\.com/, 'api.github.com разрешён в @connect');

// ── 2. Номер и репозиторий PR ──────────────────────────────────────────────
const refFrom = src.indexOf('  function prRef(result,');
// До конца githubPr: он нужен проверке и живёт между prRef и verifyMergeClaim.
const refTo = src.indexOf('  /**\n   * Проверка «PR слит» из маркера.');
assert.ok(refFrom > 0 && refTo > refFrom, 'prRef на месте');
const refApi = new Function(
  'C', 'rt', 'ACTIVE_PROFILE',
  `${src.slice(refFrom, refTo)}\nreturn { prRef, taskTargetRepository, canonicalTargetRepository };`,
)({ repo: 'example/relay-fixture' }, (p) => (p?.rich_text || []).map((x) => x.plain_text || '').join(''), {
  legacy: false, repos: [
    { repo: 'Creative36711/synapse-cortex', branch: 'main' },
    { repo: 'Creative36711/synapse', branch: 'main' },
  ],
});
const { prRef, taskTargetRepository } = refApi;

assert.deepEqual(prRef({ pr: 37 }), { repo: 'example/relay-fixture', number: 37 }, 'число');
assert.deepEqual(prRef({ pr: '#37' }), { repo: 'example/relay-fixture', number: 37 }, 'решётка');
assert.deepEqual(
  prRef({ pr: 'https://github.com/example/relay-fixture/pull/37' }),
  { repo: 'example/relay-fixture', number: 37 },
  'ссылка',
);
assert.deepEqual(
  prRef({ pr: 'https://github.com/Creative36711/synapse/pull/5' }),
  { repo: 'Creative36711/synapse', number: 5 },
  'чужой репозиторий берётся из ссылки',
);
assert.equal(prRef({ pr: null }), null, 'без PR — нечего проверять');
assert.equal(prRef({ pr: 'none' }), null, '«none» — тоже');
assert.equal(prRef(null), null, 'без ответа — тоже');
assert.equal(taskTargetRepository({ properties: { Repository: { rich_text: [{ plain_text: 'Creative36711/synapse' }] } }, }, 'Creative36711/synapse-cortex'), 'Creative36711/synapse', 'явный repo карточки приоритетнее профиля');
assert.equal(taskTargetRepository({ properties: {} }, 'Creative36711/synapse'), 'Creative36711/synapse', 'старые карточки наследуют repo роли');
assert.equal(taskTargetRepository({ properties: { Repository: { rich_text: [{ plain_text: 'synapse' }] } }, }, 'Creative36711/synapse-cortex'), 'Creative36711/synapse', 'bare slug карточки разрешается в единственный репозиторий профиля');
assert.equal(taskTargetRepository({ properties: {} }, 'synapse'), 'Creative36711/synapse', 'bare slug роли разрешается в репозиторий профиля');

// ensureMerged calls this fast boundary guard before verifyMergeClaim. It must
// resolve the same configured cross-repository URL, or it masks the later fix.
{
  const boundaryFrom = src.indexOf('  function projectPrBoundary(result, targetRepo = null) {');
  const boundaryTo = src.indexOf('  /** Заголовки GitHub API.', boundaryFrom);
  assert.ok(boundaryFrom > 0 && boundaryTo > boundaryFrom, 'projectPrBoundary на месте');
  const boundary = new Function(
    'C', 'ACTIVE_PROFILE', 'hasMergedClaim',
    `${src.slice(refFrom, refTo)}\n${src.slice(boundaryFrom, boundaryTo)}\nreturn { projectPrBoundary };`,
  )(
    { repo: 'Creative36711/synapse-cortex' },
    { legacy: false, repos: [
      { repo: 'Creative36711/synapse-cortex', branch: 'main' },
      { repo: 'Creative36711/synapse', branch: 'main' },
    ] },
    (result) => result?.merged === true,
  ).projectPrBoundary;
  assert.equal(
    boundary({ pr: 'https://github.com/Creative36711/synapse/pull/5' }, 'Creative36711/synapse-cortex'),
    '',
    'configured synapse PR is not stopped by the early boundary check',
  );
  assert.match(
    boundary({ pr: 'https://github.com/unknown/repo/pull/5' }, 'Creative36711/synapse-cortex'),
    /PR относится к unknown\/repo/,
    'unconfigured repo remains a boundary',
  );
}

// GM_xmlhttpRequest must use its anonymous mode on the fallback: omitting an
// Authorization header alone may still send cookies from the browser session.
{
  const requestFrom = src.indexOf('  function requestOnce(method, url, headers, body, timeout = 45000, opts = {}) {');
  const requestTo = src.indexOf('  /**\n   * Запрос с одним повтором', requestFrom);
  assert.ok(requestFrom > 0 && requestTo > requestFrom, 'requestOnce поддерживает анонимный запрос');
  let observed;
  const requestOnce = new Function('GM_xmlhttpRequest',
    `${src.slice(requestFrom, requestTo)}\nreturn requestOnce;`,
  )((options) => {
    observed = options;
    options.onload({ status: 200, responseText: '{"ok":true}' });
  });
  await requestOnce('GET', 'https://api.github.com/repos/example/repo/pulls/1', {}, undefined, 1000, { anonymous: true });
  assert.equal(observed.anonymous, true, 'fallback explicitly suppresses browser cookies');
  assert.equal(observed.withCredentials, false, 'fallback disables credentialed transport');
}

// ── 3. Состояние PR по GitHub ──────────────────────────────────────────────
const verifyFrom = src.indexOf('  async function verifyMergeClaim(result, token = "",');
// Границей служит следующая функция, а не её докблок: слова «вернуть карточку»
// встречаются раньше, в комментарии про Ready.
const verifyTo = src.indexOf('  async function recoverLastClaim(adopt = true) {');
assert.ok(verifyFrom > 0 && verifyTo > verifyFrom, 'verifyMergeClaim на месте');

function makeVerify(answer, repoAnswer = { full_name: 'example/relay-fixture', private: true }, profile = { legacy: true }) {
  const block = `${src.slice(refFrom, refTo)}\n${src.slice(verifyFrom, verifyTo)}\nreturn { verifyMergeClaim };`;
  const calls = [];
  const fn = new Function('C', 'request', 'ACTIVE_PROFILE', block);
  const api = fn({ repo: 'example/relay-fixture' }, async (method, url, headers, body, options) => {
    calls.push({ method, url, headers, body, options });
    if (/\/pulls\//.test(url)) {
      const response = typeof answer === 'function' ? answer({ method, url, headers }) : answer;
      if (response instanceof Error) throw response;
      return response;
    }
    // Сам repo проверяется отдельным запросом в строго анонимном режиме.
    if (repoAnswer instanceof Error) throw repoAnswer;
    return repoAnswer;
  }, profile);
  return { ...api, calls };
}

const merged = await makeVerify({ merged: true, merged_at: '2026-10-24T16:16:10Z', state: 'closed' })
  .verifyMergeClaim({ pr: 37 }, 'ghp_token');
assert.equal(merged.status, 'merged', 'слитый PR подтверждается');
assert.match(merged.why, /PR #37 слит/, 'в причине номер и факт');

const open = await makeVerify({ merged: false, state: 'open' }).verifyMergeClaim({ pr: 37 }, 'ghp_token');
assert.equal(open.status, 'open', 'открытый PR — не мерж');

const closed = await makeVerify({ merged: false, state: 'closed' }).verifyMergeClaim({ pr: 37 }, 'ghp_token');
assert.equal(closed.status, 'closed', 'закрытый без мержа — тоже не мерж');

// Полная ссылка может задавать другой репозиторий только если тот входит в
// whitelist профиля; базовый репозиторий и ветка всё равно проверяются.
{
  const crossRepoUrl = 'https://github.com/Creative36711/synapse/pull/5';
  const api = makeVerify({
    merged: true,
    merged_at: '2026-11-03T11:40:26Z',
    base: { repo: { full_name: 'Creative36711/synapse' }, ref: 'main' },
  }, undefined, { legacy: false, repos: [
    { repo: 'example/relay-fixture', branch: 'main' },
    { repo: 'Creative36711/synapse', branch: 'main' },
  ] });
  const check = await api.verifyMergeClaim({ pr: crossRepoUrl }, 'ghp_token', { repo: 'example/relay-fixture', branch: 'main' });
  assert.equal(check.status, 'merged', 'разрешённый URL repo переопределяет неверный repo ожидания');
  assert.match(api.calls[0].url, /repos\/Creative36711\/synapse\/pulls\/5/, 'GitHub запрошен по репозиторию URL');
}
{
  const api = makeVerify({
    merged: true,
    merged_at: '2026-11-03T11:40:26Z',
    base: { repo: { full_name: 'Creative36711/synapse' }, ref: 'main' },
  }, undefined, { legacy: false, repos: [
    { repo: 'Creative36711/synapse-cortex', branch: 'main' },
    { repo: 'Creative36711/synapse', branch: 'main' },
  ] });
  const check = await api.verifyMergeClaim({ pr: 5 }, 'ghp_token', { repo: 'synapse', branch: 'main' });
  assert.equal(check.status, 'merged', 'старое targetRepo со slug нормализуется перед проверкой');
  assert.match(api.calls[0].url, /repos\/Creative36711\/synapse\/pulls\/5/, 'slug никогда не уходит в GitHub API как owner/repo');
}
{
  const api = makeVerify({ merged: true }, undefined, { legacy: false, repos: [{ repo: 'Creative36711/synapse-cortex', branch: 'main' }] });
  const check = await api.verifyMergeClaim({ pr: 5 }, '', { repo: 'synapse', branch: 'main' });
  assert.equal(check.status, 'boundary', 'неразрешимый bare slug отвергается до сети');
  assert.equal(api.calls.length, 0, 'не отправляется ошибочный /repos/synapse запрос');
}
{
  const api = makeVerify({ merged: true, base: { repo: { full_name: 'unknown/repo' }, ref: 'main' } }, undefined, { legacy: false, repos: [
    { repo: 'example/relay-fixture', branch: 'main' },
    { repo: 'Creative36711/synapse', branch: 'main' },
  ] });
  const check = await api.verifyMergeClaim({ pr: 'https://github.com/unknown/repo/pull/5' }, 'ghp_token', { repo: 'example/relay-fixture', branch: 'main' });
  assert.equal(check.status, 'boundary', 'неизвестный репозиторий не принимается');
  assert.equal(api.calls.length, 0, 'не делаем GitHub запрос по постороннему адресу');
}

// Токен есть, репозиторий виден, а PR не читается. Это всё равно не «нет PR»:
// 24.10 на таком ответе слитый PR #37 уехал в Rework, поэтому статус — unknown.
const missingApi = makeVerify(new Error('HTTP 404: Not Found'), { full_name: 'example/relay-fixture', private: false });
const missing = await missingApi.verifyMergeClaim({ pr: 37 }, 'ghp_token');
assert.equal(missing.status, 'unknown', '404 на PR не доказывает, что PR нет');
assert.equal(missing.notFound, true, 'но это названо: PR не читается');
assert.equal(missing.needsToken, false, 'публично читаемый repo не помечается как проблема токена');
assert.doesNotMatch(missing.why, /нужен токен|приватным/i, 'видимый публичный repo не объявляется проблемой токена');
assert.ok(missingApi.calls[2].url.endsWith('/repos/example/relay-fixture'), 'после PR-404 проверяется repo endpoint отдельно');
assert.equal(missingApi.calls[2].options.anonymous, true, 'диагностический repo-запрос тоже строго анонимный');

// Если сохранённый токен получает 404, публичный PR должен проверяться
// анонимным повтором. Это покрывает PR #5 в Creative36711/synapse: merged.
{
  const api = makeVerify(({ headers }) => {
    if (headers.Authorization) return Object.assign(new Error('HTTP 404: Not Found'), { status: 404 });
    return {
      merged: true,
      merged_at: '2026-11-03T11:40:26Z',
      base: { repo: { full_name: 'example/relay-fixture' }, ref: 'main' },
    };
  });
  const check = await api.verifyMergeClaim({ pr: 37 }, 'ghp_token');
  assert.equal(check.status, 'merged', 'анонимный fallback подтверждает публичный PR');
  assert.equal(api.calls.length, 2, 'сделана одна безопасная повторная проверка');
  assert.equal(api.calls[1].headers.Authorization, undefined, 'второй запрос не отправляет токен');
  assert.equal(api.calls[1].options.anonymous, true, 'ScriptCat отключает cookies/credentials на анонимном повторе');
}

// Токена нет — тот же 404 значит «приватный репозиторий не виден».
const hidden = await makeVerify(new Error('HTTP 404: Not Found'), new Error('HTTP 404: Not Found')).verifyMergeClaim({ pr: 37 });
assert.equal(hidden.status, 'unknown', 'без токена 404 — не «PR нет», а «не проверили»');
assert.equal(hidden.needsToken, true, 'и это прямо названо нехваткой токена');
assert.match(hidden.why, /анонимный GitHub API|доступ/i, 'оба endpoint 404 диагностируются без утверждения, что repo точно приватный');

// Токен есть, но и репозиторий ему не виден: это «нет доступа», а не «нет PR».
{
  const noAccess = await makeVerify(new Error('HTTP 404: Not Found'), new Error('HTTP 404: Not Found'))
    .verifyMergeClaim({ pr: 37 }, 'ghp_nowhere');
  assert.equal(noAccess.status, 'unknown', 'невидимый репозиторий — не отказ работе');
  assert.equal(noAccess.needsToken, true, 'и снова повод проверить доступ');
  assert.match(noAccess.why, /доступ|токен|приватным/i, 'сказано, что проверить');
}

// Код в ошибке важнее текста: ScriptCat не всегда кладёт «HTTP 404» в message.
const byStatus = Object.assign(new Error('Not Found'), { status: 404 });
{
  const byCode = await makeVerify(byStatus).verifyMergeClaim({ pr: 37 }, 'ghp_token');
  assert.equal(byCode.status, 'unknown', 'код берётся из e.status, а не только из текста');
  assert.equal(byCode.notFound, true, 'и 404 по коду — тоже «не читается», а не «нет»');
}

for (const code of [401, 403]) {
  const denied = Object.assign(new Error(`HTTP ${code}: Bad credentials`), { status: code });
  const check = await makeVerify(denied).verifyMergeClaim({ pr: 37 }, 'ghp_bad');
  assert.equal(check.status, 'unknown', `${code} — не приговор работе`);
  assert.equal(check.needsToken, false, `${code} на обоих запросах без подтверждения приватности не доказывает, что нужен токен`);
}

const offline = await makeVerify(new Error('таймаут запроса')).verifyMergeClaim({ pr: 37 }, 'ghp_token');
assert.equal(offline.status, 'unknown', 'сеть — «проверить не удалось»');

const noPr = await makeVerify({ merged: true }).verifyMergeClaim({ pr: null });
assert.equal(noPr.status, 'unknown', 'без номера проверять нечего');

// Токен уходит заголовком, а без токена запрос остаётся анонимным.
{
  const api = makeVerify({ merged: true, merged_at: '2026-10-24T16:16:10Z' });
  await api.verifyMergeClaim({ pr: 37 }, 'ghp_secret');
  assert.equal(api.calls[0].headers.Authorization, 'Bearer ghp_secret', 'токен в заголовке');
  assert.match(api.calls[0].url, /api\.github\.com\/repos\/example\/relay-fixture\/pulls\/37/, 'адрес PR');
}
{
  const api = makeVerify({ merged: true, merged_at: '2026-10-24T16:16:10Z' });
  await api.verifyMergeClaim({ pr: 37 });
  assert.equal(api.calls[0].headers.Authorization, undefined, 'без токена — без заголовка');
}

// Unknown PR verification is a terminal Blocked state, not a destructive reset
// or an implicit re-dispatch. Evidence remains attached to the current Run.
{
  const executor = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
  const from = executor.indexOf('    if (merged === "boundary") {');
  const to = executor.indexOf('    if (merged === "claim-rejected") {', from);
  assert.ok(from > 0 && to > from, 'unconfirmed branch in submitExecutor');
  const branch = executor.slice(from, to);
  assert.match(branch, /"Dispatch State": \{ select: \{ name: "Blocked" \} \}/, 'неподтверждённая выдача блокируется');
  assert.match(branch, /"Check": \{ select: typeof result\.check === "number"/, 'проверка сохраняет pass/fail или очищается как unconfirmed');
  assert.match(branch, /Run ID и ссылка сохранены|Run ID/, 'Run ID сохраняется, выдача не перезапускается');
  assert.match(branch, /if \(currentDispatch\(expect\)\) GM_setValue\(K\.expect, null\)/, 'завершённая выдача снимает только собственное ожидание');
  assert.doesNotMatch(branch, /"Submitted At": \{ date: null \}|"Run ID": \{ rich_text: \[] \}/, 'терминальные следы не стираются');
}

// ── 4. claimMerge: сначала проверка, потом вера ────────────────────────────
const claimFrom = src.indexOf('  async function claimMerge(task, result, key, note = "") {');
const claimTo = src.indexOf('  /**\n   * PR закрыт.', claimFrom);
assert.ok(claimFrom > 0 && claimTo > claimFrom, 'claimMerge на месте');
const claimBlock = src.slice(claimFrom, claimTo);
assert.ok(
  claimBlock.indexOf('verifyMergeClaim(result') < claimBlock.indexOf('GM_setValue(key, true)'),
  'проверка идёт раньше, чем заявка принимается',
);

async function runClaim(check) {
  const store = new Map();
  const logged = [];
  const fn = new Function(
    'C', 'GM_getValue', 'GM_setValue', 'log', 'waitFor', 'mergedFlag', 'continueButton',
    'finishMerge', 'patience', 'prLabelOf', 'verifyMergeClaim', 'ghToken', 'dispatchTarget', 'sleep',
    `${claimBlock}\nreturn { claimMerge };`,
  );
  const api = fn(
    { mergeGraceMs: 90000 },
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    (text, error, options) => logged.push({ text, error, options }),
    async () => null, // бейджа Merged и Continue на странице нет
    () => null,
    () => null,
    async () => 'merged',
    (ms) => Math.min(ms, 0),
    (r) => `PR #${r.pr}`,
    async () => check,
    () => 'ghp_secret',
    // dispatchTarget: цель выдачи в этой пробии не развёрнута — глобальный конфиг.
    () => null,
    async () => {},
  );
  const result = await api.claimMerge({ id: 'card-1' }, { pr: 37 }, 'cfn-merged:card-1');
  return { result, store, logged };
}

{
  const { result, store, logged } = await runClaim({ status: 'merged', why: 'PR #37 слит 2026-10-24T16:16:10Z' });
  assert.equal(result, 'claimed', 'подтверждённый мерж принимается без бейджа');
  assert.equal(store.get('cfn-merged:card-1'), true, 'карточка помечена слитой');
  assert.ok(logged.some((l) => /GitHub подтвердил/.test(l.text)), 'в журнале сказано, кто подтвердил');
}
{
  const { result, store, logged } = await runClaim({ status: 'open', why: 'PR #37 ещё открыт' });
  assert.equal(result, 'claim-rejected', 'ложная заявка не принимается');
  assert.equal(store.get('cfn-merged:card-1'), undefined, 'карточка не помечена слитой');
  assert.ok(logged.some((l) => l.error && /не подтвердилась/.test(l.text)), 'ошибка названа в журнале');
}
{
  const { result, logged } = await runClaim({ status: 'unknown', why: 'GitHub не ответил: таймаут запроса' });
  assert.equal(result, 'claimed', 'без проверки остаётся прежнее правило');
  assert.ok(
    logged.some((l) => /проверить по GitHub не удалось/.test(l.text)),
    'и об этом сказано прямо, а не молча',
  );
}
{
  // Приватный репозиторий без токена: это не повод для Rework, но и не тишина.
  const { result, logged } = await runClaim({
    status: 'unknown',
    needsToken: true,
    why: 'PR #37 анонимно не виден: example/relay-fixture приватный — нужен токен GitHub в «⚙ Подключения»',
  });
  assert.equal(result, 'claimed', 'без токена заявка не отклоняется');
  assert.ok(logged.some((l) => /откройте «⚙ Подключения» и сохраните токен/.test(l.text)), 'сказано, как включить проверку');
}

// ── 5. Ложная заявка возвращает карточку в Rework ──────────────────────────
const submitFrom = src.indexOf('  async function submitExecutor(role, expect, manual = false) {');
const submitBlock = src.slice(submitFrom, src.indexOf('  // ───────────────────────────── цикл ─────────────────────────────', submitFrom));
assert.match(submitBlock, /if \(merged === "claim-rejected"\) \{/, 'ветка ложной заявки на месте');
const rejectedAt = submitBlock.indexOf('if (merged === "claim-rejected") {');
const rework = submitBlock.slice(rejectedAt, rejectedAt + 1600);
assert.match(rework, /"Dispatch State": \{ select: \{ name: "Rework" \} \}/, 'карточка уходит в Rework');
assert.match(rework, /claim-rejected -->/, 'причина пишется в журнал попытки отдельным маркером');
assert.match(rework, /нужна повторная выдача/, 'в причине сказано, что делать');
assert.ok(
  rejectedAt < submitBlock.indexOf('if ((merged === "closed" || merged === "unconfirmed")'),
  'проверяется раньше прежней ветки «PR закрыт»',
);

// ── 6. Заявка запоминается для возврата карточки ───────────────────────────
assert.match(submitBlock, /GM_setValue\(K\.lastResult, \{/, 'выдача запоминается до записи в Notion');
assert.ok(
  submitBlock.indexOf('GM_setValue(K.lastResult') < rejectedAt,
  'запомненное состояние есть уже к моменту отказа',
);
assert.match(src, /K\.ghAsk/, 'после нехватки токена скрипт сам показывает, где его взять');

console.log('OK: relay 1.4.63 — заявка о мерже проверяется по GitHub, 404 без токена не считается отказом');
