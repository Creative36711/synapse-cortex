# Приёмочный отчёт · ScriptCat 1.10.0 «Provisioning Arena-агентов»

Дата: 2026-11-04. База: `origin/main = b3326b1b573364e16cee4fc1ec8076587052c35c` (PR #43).
Статус: **локальная приёмка пройдена, оракул зелёный**. Живая приёмка D-027 и боевое
создание/замена агентов **не проводились** — только после отдельного подтверждения Мастера.

## Версии
| Компонент | Версия | Изменение |
|---|---|---|
| ScriptCat / Relay | **1.10.0** | `@version` и `SCRIPT_VERSION` синхронны |
| Drive Gateway | **1.7.1** | **не менялся** (`drive-gateway.gs`, `appsscript.json` без diff) |
| regulation-digest / REGULATION | **1.5** | вход регламента не менялся; provisioning — транспортный контур |
| agent-protocol | **1.1** | аддитивно к 1.0: маркер `CF_AGENT_PROVISION_RESULT`, профиль `admin.provision` |
| Публичный `Creative36711/synapse` | — | **не менялся**, внутреннее туда не публиковалось |

## Новые файлы
- `src/31-provision-core.js` — конфиг/кандидаты/админ-право/маркер/состояние/журнал/лимиты.
- `src/32-provision-dom.js` — repo picker, sidebar по UUID, More options, Rename, Archive.
- `src/33-provision-flow.js` — request → approval → job → Notion → activation → archive, `consumeProvision()`.
- `src/34-provision-ui.js` — кнопка «🤖 Агенты» и диалог кандидатов.
- Тесты: `provision-core-smoke`, `provision-dom-smoke`, `provision-flow-smoke`, `provision-prompts-smoke`;
  хелперы `helpers/provision-dom-env.mjs`, `helpers/provision-flow-env.mjs`.

## Изменённые модули
`02-profiles-core` (11 ключей конфига, normalize/valid, namespaces, ui.agents),
`12-notion` (`mapRoleRow` += agentAdmin/agentState/agentJobId/agentCreatedAt/previousAgentUrl),
`prompt-marker-registry`/`prompt-blocks`/`prompt-profiles`/`prompt-compiler` (`admin.provision`, 5 блоков, overhead ≤1800),
`28-cycle` (ранний `consumeProvision()` до auto/pending, без записи `K.pending/K.expect`),
`06-pause-panel` (кнопка), `08-projects-ui` (настройки provisioning, экспорт/импорт),
`build.mjs` (4 новых части), `portability-guard` (запрет проектных имён в provisioning),
`00-header`/`04-notifications` (1.10.0), контракты и docs.

## Notion (аддитивно)
Новые поля «Роли»: `Agent Admin` checkbox default false; `Agent State` select
(не требуется/запрошен/создаётся/создан/ошибка; пусто = не требуется); `Agent Job ID` rich_text;
`Agent Created At` date; `Previous Agent URL` url. Старые поля не переименованы.

ScriptCat пишет: `Agent URL`, `Previous Agent URL`, `Agent State`, `Agent Job ID`,
`Agent Created At`, `Статус=Активна` после проверок. Не пишет: `Роль`, `Функция`,
`Зона записи`, `Гейт`, `Репозиторий`, `Agent Admin`. Страницы через `POST pages` не создаются.
Перед патчем строка перечитывается fresh; conflict не перезаписывается.

## Проверки (exit 0)
```bash
npm run verify          # scriptcat:check + guard + test + regression + tool-limit
npm run test:prompts
npm run test:delivery
npm run test:pilot
npm run test:docs
npm run test:provision
```
Результат: `test` — 82 файла / 106 TAP-проверок, 0 fail; `test:regression` — 15/0;
`test:tool-limit` — 2/0; именованные suites — 0 fail. Coverage-оракул: 16 ruleId.
Тесты не ослаблялись: `docs-smoke` переведён на protocolVersion 1.1 вместе с контрактом;
`relay-roles-cache-smoke` расширен аддитивными полями; счётчик suites обновлён 78→82.

## DOM-фикстуры
Мини-DOM без реального браузера доказывает независимость от `radix-*` id и `nth-child`:
триггер с repo / «Select a repository», открытый picker `cmdk` + «Add repositories…»,
точный option `owner/repo`, sidebar item по UUID (query/hash игнорируются), More options
в том же item, меню Rename/Archive, rename dialog `input[maxlength="100"]` с
disabled→enabled submit. Already-selected repo не кликается; Add repositories не нажимается;
Archive нового агента не нажимается; rename failure не создаёт новую сессию.

## Поведенческие проверки
create/replace-кандидат в запросе; заполненный URL без `Agent State=запрошен` не трогается;
админ не создаётся/заменяется; не-админ не одобряет; чужой `request_id`, job вне кандидатов,
repo вне allowlist отклоняются; URL захватывается до rename/Notion; conflict не перезаписывает;
автоактивация и её блокировка (нет активного Reviewer); «Кому» добавляется аддитивно;
восстановление job из GM; суточный лимит; старт запрещён при активном ходе; `K.pending/K.expect`
не записываются; автоцикл восстанавливается после успеха.

## Локально vs остаток D-027
Локально доказаны: компиляция профиля, маркер-валидация, DOM-контракт, state machine,
Notion-патчи на моках, журнал/лимиты, сборка и переносимость. **Не доказано живьём:**
реальный repo picker Arena, реальная задержка URL/bootstrap, реальный rename/archive,
реальные права Notion-интеграции на patch/select-options, поведение при капче/tool-limit.
Это остаток живой приёмки D-027: create, replace, негативные проверки — только после
отдельного подтверждения Мастера и остановки автоцикла.

## Осознанные решения / расхождения ТЗ
1. **Bootstrap default пуст.** ТЗ одновременно требует точный текст с `Creative36711/test`
   и запрет hardcoded проектных имён. В коде дефолт пуст (provisioning выключен);
   рекомендованный шаблон «Что изображено на картинке test.jpg в репозитории
   https://github.com/OWNER/test?» задаёт Мастер в профиле. Пробник фильтруется на
   CF_/Notion/cortex/REGULATION/WARDEN/DECISIONS, токены и внутренние ссылки.
2. **Auditory/Auditor.** Функция `Auditory` из ТЗ принимается наряду с `Auditor`.
3. **D-031 ≠ Gateway 1.7.1.** Имена артефактов/PNG/подкаталоги из D-031 не совпадают с
   whitelist Gateway 1.7.1. Это отдельный долг; данным PR **не чинится**.

## Инструкция Мастеру
1. Обновить ScriptCat до 1.10.0; Gateway 1.7.1 не трогать. Автоцикл остановить.
2. В профиле включить provisioning, задать allowlist точных `owner/repo`, bootstrap-пробник,
   лимиты, режим manual. В Notion добавить аддитивные поля и отметить `Agent Admin=true`
   у действующего Coordinator/Reviewer.
3. Создать тестовую роль: `Agent State=запрошен`, пустой Agent URL, repo из allowlist.
   Нажать «🤖 Агенты» → запрос → одобрение маркером. Проверить URL/rename/Активна/Кому.
4. Заменить временную роль: заполнить URL, `Agent State=запрошен`; проверить Previous Agent URL
   и архив старого. Негативные: чужой request_id, repo вне allowlist, админ-кандидат, conflict.
5. Откат: выключить provisioning, снять `Agent State`, вернуть прежний URL/Статус вручную;
   старый URL при replace хранится в `Previous Agent URL`. Новая сессия при захваченном URL
   повторно не создаётся.