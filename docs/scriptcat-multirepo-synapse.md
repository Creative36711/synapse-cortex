# Отчёт: поддержка нескольких репозиториев в профиле ScriptCat (Synapse)

Ветка: `arena/96f1c455-synapse-cortex` (от `main` f732a154cba7ee786bbe3bf81206ae636e469f68).
Дата: 2026-11-02. Исполняющая среда: Node v22.22.3.

## 1. Версия и сборка

- ScriptCat/Relay userscript — версия **1.7.0** (`@version 1.7.0`, `SCRIPT_VERSION`, проверка `version-oracle.mjs`).
- SHA-256 собранного `tools/script-cat/relay.user.js`:
  `e6b1fce67d19acfbe8cfe7b288a6811778401acbd0dabd351b710bb5be00b4ea`
- Бандл собирается из 30 исходных файлов `src/` через `npm run scriptcat:build` (`node build.mjs`); `relay.user.js` сверен с исходниками (`npm run scriptcat:build` / `build.mjs --check` — OK).

## 2. Что изменилось

Один профиль ScriptCat теперь обслуживает несколько GitHub-репозиториев без смены UUID и без повторной регистрации в Gateway. Четыре источника Notion, очередь, история ответов, журнал и Gateway остаются на профиль.

**Код транспорта (`src/`):**
- `02-profiles-core.js` — профиль хранит `repos` (список `{repo, branch, main}`, ровно один главный) и `roleRepos` (карта `roleId → repo`). `normalizeProfile()`, `profileMainEntry()`, `profileRepoBranch(repo)`, `profileSessionRepo(roleId)`; `validProfile()` валидирует уникальность репозиториев, имена/ветки, ровно один главный и связь `roleId → существующий репозиторий`. `C.repos` / `C.roleRepos` заполняются из активного профиля; `ACTIVE_PROFILE` замораживается.
- `17-arena-polls.js` — `sendToRole()` пишет в снимок ожидания (`K.expect`) поля `sessionRepo`, `targetRepo`, `targetBranch` (цель выдачи из явного контекста карточки, иначе репозиторий сессии роли, иначе глобальный `C.repo`).
- `19-pull-requests.js` — `prUrl(pr, repo)`, `prRef(result, targetRepo)`, `projectPrBoundary(result, targetRepo)`, `verifyMergeClaim(result, token, target)`, `dispatchTarget()`; проверка мержа привязана к цели выдачи (базовый репозиторий и базовая ветка из снимка), а не всегда к `C.repo`/`C.branch`. Полный URL PR называет свой репозиторий; числовой PR проверяется в зафиксированном репозитории. Подтверждение статуса через GitHub API; `merged: true` или бейдж Arena не являются доказательством; ошибка доступа/API — «не удалось подтвердить», карточка не уходит в Rework за 404 без токена.
- `20-technical-context.js` — техблок собирается из контекста цели выдачи (`executorTech(repo, branch)`, `auditorTech(repo, branch)`): репозиторий, `origin/<базовая ветка>`, команды `gh` и измерение «46 файлов» — только для главной ветки, чтобы снимок одного проекта не принимался за факт другого.
- `21-prompts.js` — `executorOrder`/`auditorOrder`/`coordinatorPrompt`/`executorPrompt` принимают `ctx = {repo, branch}`; базовая ветка и команды gh берутся из цели выдачи.
- `22-executor.js` — `K.lastResult` хранит снимок цели выдачи (`sessionRepo`, `targetRepo`, `targetBranch`, `prRepo`, `prNumber`) вместе с `dispatch_id`/`run_id`; ссылка PR в Notion собирается по целевому репозиторию; причина Rework называет целевую ветку.
- `27-review-answers.js` — `dispatchTask()` берет цель выдачи из `profileSessionRepo(role.id)` и `profileRepoBranch()`, передаёт её в промпт и в `sendToRole` (`targetRepo`/`targetBranch`).
- `08-projects-ui.js` — окно профиля: редактирование списка репозиториев (ровно один главный, дублирует поля «Репозиторий»/«Ветка») и маршрутов ролей (`roleId → репозиторий`); при сохранении текущего профиля автоцикл останавливается, ставится удержание, реестр перезаписывается и вкладка перезагружается; UUID, состояние (очередь, ожидание, ответы, история, ключи `cfn-*`) не сбрасываются.

**Тесты:**
- Обновлены пробы под новый контракт (без ослабления): `relay-pr-claim`, `relay-continue-claim`, `relay-merge-verify`, `relay-closed-state`, `relay-no-pr`, `relay-journal-recover`, `relay-payload`, `relay-prompt`, `relay-review-dispatch-integration`, `relay-tech-info` (+ стабы `dispatchTarget`, `profileSessionRepo`, `profileRepoBranch`, `prRef` там, где пробы вызовут код транспорта изолированно).
- Регрессионные пробы адаптированы: `relay-project-profiles-integration` (сигнатуры `prRef`/`verifyMergeClaim`, снимок `ACTIVE_PROFILE` замораживается), `relay-reviewer-task-guard` (стабы `profileSessionRepo`/`profileRepoBranch`).

## 3. Проверки

```
npm run verify
```
эквивалентно:
`npm run scriptcat:check && npm run scriptcat:guard && npm test && npm run test:regression`

Результаты на 2026-11-02:
- `build.mjs --check` — бандл соответствует 30 исходным файлам: OK
- `portability-guard.mjs` — запрещённых имён нет: OK
- `npm test` — 72/72 smoke-пробы: OK
- `npm run test:regression` — 15/15 интеграционных проб: OK

## 4. Путь установки userscript

Установить `tools/script-cat/relay.user.js` в расширение пользовательских скриптов (Tampermonkey/Violentmonkey) на страницу агента Arena. Затем в ScriptCat: «Проекты» → создать/открыть профиль Synapse с четырьмя UUID **data source** Notion (не view), страницей регламента, репозиторием и базовой веткой, папкой Drive `synapse`.

## 5. Порядок обновления профиля Synapse (мульти-репо)

1. Остановить автоцикл («Подключения» / панель паузы).
2. «Проекты» → «Исправить текущий до первого допуска» (до первого допуска профиль корректируется без смены UUID).
3. В разделе «Репозитории профиля» добавить второй репозиторий `synapse` (ветка `main`); главный оставить `synapse-cortex/main`.
4. В разделе «Маршрутизация ролей к репозиториям» добавить маршруты: Executor Core → `synapse`, Executor Cortex → `synapse-cortex` (ID роли — UUID страницы в базе «Роли», а не имя). Роли без маршрута работают в главном репозитории.
5. Сохранить — автоцикл останавливается, ставится удержание вкладки, реестр профилей перезаписывается, вкладка перезагружается. UUID профиля не меняется, повторной регистрации в Gateway не требуется; очередь, ожидание, ответы, история и ключи `cfn-*` не стираются.
6. После перезагрузки отдельно согласовать с владельцем: «Проверить всё» → «Сохранить» → «Проверить подключения и разрешить работу», затем «Шаг» на подготовленной миссии.

## 7. Соответствие требованиям

- Один профиль — одна история, очередь, Gateway, четыре источника Notion; экспектор Core → synapse, кортекс → synapse-cortex, аудит synapse из сессии кортекса задаётся явно (поле маршрута карточки или полная ссылка на PR).
- Цель каждой выдачи фиксируется (`dispatch_id`, `run_id`, репозиторий сессии роли, целевой репозиторий, базовая ветка) и используется в задании, ожидании, ответе, журнале и восстановлении.
- PR проверяется относительно цели выдачи; `pr: null` для работы без PR; кэши и восстановление разделены по репозиторию/ветке/PR.
- Техблок и команды из явного контекста выдачи, без замены глобального `main`. ADR watcher остаётся в `synapse-cortex/main`; одинаковые имена ADR не смешиваются, старые вопросы не дублируются, default не заменяет решение.
- Миграция без смены UUID и повторной регистрации Gateway, отдельная настройка маршрутизации, без стирания `cfn-*`, очереди, ожиданий, ответов, истории; при изменении настроек цикл останавливается, профиль на удержании после сохранения.
