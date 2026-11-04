# Приёмочный отчёт · ScriptCat 1.12.0 «Маркер Координатора + адрес артефактов» (D-035)

Дата: 2026-11-04. База: `origin/main = db9cc9f` (PR #45, пакет 1.11.0/D-034). Статус:
**локальная приёмка пройдена, оракул зелёный**. Живая приёмка D-027 и боевое
обновление скрипта **не проводились** — только после отдельного подтверждения Мастера.
Перенос двух уже созданных отчётов аудитора из корня Drive в `artifacts` выполнен
отдельным разрешением Мастера («если это безопасно — перенеси»). Ниже сохранены
базовые отчёты D-034 и 1.10.0; изменения D-035 — в этой секции.

## Версии
| Компонент | Версия | Изменение |
|---|---|---|
| ScriptCat / Relay | **1.12.0** | `@version` и `SCRIPT_VERSION` синхронны; D-035 |
| Drive Gateway | **1.8.0** | не менялся |
| regulation-digest / REGULATION | **1.5** | вход регламента не менялся |
| agent-protocol | **1.4** | аддитивно: 1.3 — бюджет overhead + payload-канал D-034; 1.4 — прайм маркера + адрес артефактов D-035 |
| Публичный `Creative36711/synapse` | — | **не менялся**, внутреннее туда не публиковалось |

## D-035 (1.12.0): маркер Координатора с первого раза + артефакты не в корне
Два дефекта боевой миссии SYN-1. Что сделано (бюджеты **не подняты**):

- **Прайм маркера Координатора.** Маркер стоял только в конце длинного
  `coordinator.plan`, и после десятка tool-вызовов Координатор его «не видел»,
  честно отказываясь выдать («формат не виден, по памяти не восстанавливаю»).
  Теперь `coordinator.plan`/`coordinator.recovery` открывает блок `coordinator.prime`
  («заверши ход маркером последней строки; формат и IDs — в конце»). Авторитетный
  маркер остаётся последним блоком; прайм не несёт литерал маркера и не `marker.*`,
  инвариант «ровно один маркер» сохранён.
- **Адрес артефактов в промпте.** Раскладку Drive видел только Координатор, поэтому
  аудитор клал отчёты то в `artifacts`, то в корень. Теперь
  `executor.card`/`auditor.card`/`reviewer.card` несут блок `drive.artifacts`
  («Артефакты в `Arena/<project>/artifacts`, не корень Диска; ссылки в поле
  `artifacts`»); проект из профиля (`driveFolder`). Блок влезает в `auditor.card`
  ≤2200 без подъёма бюджета (K-17 проходит, скелет ≤2050).
- **Уборка в Drive.** Отчёты «SYN-1 K-17 O-4…» и «SYN-1 K-19 O-5…» перенесены из
  корня Диска в `artifacts` (`1fXMP8Fj…`). Перенос не меняет ID/URL (ссылки в
  журналах/карточках валидны), имена сохранены (ретро-переименование запрещено D-031).

Новые пробы: `prompts-smoke` §12 (прайм маркера: первый блок, маркер последний, без
литерала в прайме), §13 (адрес артефактов у Executor/Auditor/Reviewer, проект из ctx,
`drive.layout` не утекает исполнителю). `docs-smoke` переведён на protocolVersion 1.4.
Тесты не ослаблялись. Gateway и digest не менялись.

## D-034 (1.11.0): бюджет overhead + payload-канал
Инцидент K-17 → Spec Auditor: пауза `budget_exceeded` (overhead 2290 > 2200,
`auditor.card`). Причина — фиксированный скелет промпта съедал почти весь бюджет;
координатор регламент не нарушал. Что сделано:

- **Overhead-диета без подъёма бюджетов.** Дедупликация base-ветки в
  `git.executor`/`git.auditor`, короче `repo.target` и заглушка `task.assignment`.
  K-17-подобная карточка компилируется в `auditor.card` ≤2200 (регрессия в
  `prompts-smoke`). Версии изменённых блоков подняты до 2.
- **Диагностируемая пауза.** `budget_exceeded` несёт разбивку по блокам; пауза
  называет топ блоков, съевших overhead (`budgetBreakdownLine`).
- **Payload-канал.** Большое задание (> `payloadInlineMax`=1500 зн.) фиксируется
  снимком `savePayload` на прогон (`<dispatch>_<run>__assignment.md`) и доставляется
  verbatim-указателем; оракул/Scope остаются inline. Стратегия
  `full → payload-указатель → compact → pause`. Отказ шлюза — явная ошибка.
- **Total-лимиты в боевом пути.** `DISPATCH_TOTAL` (Executor 6500 / Auditor 5500 /
  Reviewer 7000) соблюдается доставкой.

Новые/обновлённые пробы: `prompts-smoke` §9–11 (K-17, указатель, разбивка),
`delivery-smoke` §2b (payload-стратегия), новая интеграционная
`regression-tests/relay-payload-channel-integration.mjs` (снимок+указатель, отказ
шлюза, малое задание инлайном). `docs-smoke` переведён на protocolVersion 1.3.
Тесты не ослаблялись. Живой Drive/боевые Notion не затронуты.

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

## Gateway 1.8.0 / D-033 (долг D-031 закрыт в этом же PR)
По команде Мастера долг «D-031 ≠ Gateway 1.7.1» закрыт в PR #44:
- `saveArtifact` принимает имена D-031 `<МИССИЯ>__<КАРТОЧКА>__<вид>__<дата|SHA>`
  (опционально `__supplement-N`) наряду с legacy UUID и `manual__`.
- PNG (`image/png`) в base64; лимит 262144 по декодированным байтам, текст — UTF-8.
- Подкаталог `artifacts/<МИССИЯ>` только по явному `subdir`, равному миссии,
  один уровень; legacy/manual — плоско. Решение о подкаталоге остаётся за Warden/Мастером.
- Дубликат побайтово, конфликт явный; `verifyArtifactPlacement` и проектное чтение
  допускают подкаталог; `read` текстовый. Ключ/папки/история не меняются,
  ретро-переименование запрещено.
- Тесты: `drive-gateway-arena-smoke` (D-031/PNG/подкаталог/негативные),
  `drive-gateway-projects-integration` (границы проектов, PNG не пересекает проекты).
Живой Drive не затронут; развёртывание Gateway 1.8.0 — отдельное действие Мастера.

## Границы работ
Живые Arena-агенты не создавались/не заменялись; боевые Notion/Drive/карточки не
менялись; живой Drive не затронут. Публичный `synapse` не тронут. Gateway изменён
в репозитории (1.8.0), но боевое развёртывание Apps Script не выполнялось.
Живая приёмка D-027 — только после отдельного подтверждения Мастера.

## Осознанные решения / расхождения ТЗ
1. **Bootstrap default пуст.** ТЗ одновременно требует точный текст с `Creative36711/test`
   и запрет hardcoded проектных имён. В коде дефолт пуст (provisioning выключен);
   рекомендованный шаблон «Что изображено на картинке test.jpg в репозитории
   https://github.com/OWNER/test?» задаёт Мастер в профиле. Пробник фильтруется на
   CF_/Notion/cortex/REGULATION/WARDEN/DECISIONS, токены и внутренние ссылки.
2. **Auditory/Auditor.** Функция `Auditory` из ТЗ принимается наряду с `Auditor`.
3. **D-031 ≠ Gateway 1.7.1** — закрыт решением D-033 (Gateway 1.8.0) в этом же PR
   по явной команде Мастера; исходное ограничение 1.10.0 «Gateway не менять»
   снято только для этого долга.

## Инструкция Мастеру
1. Обновить ScriptCat до 1.10.0; развернуть Gateway 1.8.0 тем же ключом (папки и
   история сохраняются). Автоцикл остановить.
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