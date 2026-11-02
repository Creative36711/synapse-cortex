# Настройка: ID баз Notion, профиль ScriptCat, Drive Gateway

Создано Warden 2026-11-02. Здесь только идентификаторы ресурсов, **никаких секретов**.

## 1. Notion

Родительская страница: **«Synapse — разработка платформы»**
`https://app.notion.com/p/Synapse-40c6f0cf57058133b5fedf05f4273d45`
page_id: `40c6f0cf-5705-8133-b5fe-df05f4273d45`

| База | database_id | **data source id (нужен профилю)** |
|---|---|---|
| Роли | `95798dcb-c381-4ed1-aa58-9417bb8983f3` | `5b897c87-7827-4224-be4f-c43b3d09a19b` |
| Миссии | `1d4237c9-e45e-4924-8e90-31ceb7438ab5` | `2fbdec31-6ce8-4c68-914b-a92ada6e8b63` |
| Запросы | `a709d6df-4698-4a98-b111-90d22de42894` | `1b5861b0-b52a-4bda-ad7a-10366f5d2046` |
| Обратная связь | `46208c7d-7c36-41df-ac99-2a38d79dbcf2` | `3d8efcea-19d9-48d3-8c3f-a4cfb7186f89` |

Ссылки для формы профиля (если удобнее вставлять URL, а не UUID):

- Роли: `https://app.notion.com/p/95798dcbc3814ed1aa589417bb8983f3`
- Миссии: `https://app.notion.com/p/1d4237c9e45e49248e9031ceb7438ab5`
- Запросы: `https://app.notion.com/p/a709d6df46984a98b11190d22de42894`
- Обратная связь: `https://app.notion.com/p/46208c7d7c3641dfac992a38d79dbcf2`

Схема сверена с `tools/script-cat/NOTION-TEMPLATE.json` через `get_data_source`: типы и
значения `select` совпадают, `Статус` и `Dispatch State` — именно `select`, не Notion Status.

Осталось: заполнить «Роли» реальными Agent URL и добавить опции `Кому` в «Запросы»
(ровно те же написания, что `Роль`). `Кому` намеренно создан без опций — иначе туда попали бы
несуществующие роли.

## 2. Профиль ScriptCat

| Поле профиля | Значение |
|---|---|
| Имя проекта | `Synapse` |
| Notion: 4 источника | см. таблицу выше (data source id) |
| Страница регламента (HTTPS) | `https://app.notion.com/p/Synapse-40c6f0cf570581fa8583ffc54f7029ba` (page_id `40c6f0cf-5705-81fa-8583-ffc54f7029ba`) |
| База обратной связи (HTTPS) | `https://app.notion.com/p/46208c7d7c3641dfac992a38d79dbcf2` |
| GitHub | `Creative36711/synapse-cortex` |
| Базовая ветка | `main` |
| Папка Drive | `synapse` |
| ID профиля | появится в строке «ID:» после создания — нужен для Gateway |

## 3. Drive Gateway (действия Мастера, один раз)

Порядок важен: **сначала профиль ScriptCat, потом Gateway**, потому что `CF_SETUP_PROJECT_ID` —
это UUID профиля.

1. Папку `Arena/synapse` **не создавать вручную**: `setupProjectGateway()` откажется
   регистрировать проект, если папка уже существует, и не присоединяет её.
2. Открыть существующий Apps Script `Arena/Gateway` (или новый проект, если решено разделять).
   Код — `tools/script-cat/drive-gateway.gs`, манифест — `tools/script-cat/appsscript.json`.
3. Project Settings → Script Properties:
   - `CF_SETUP_PROJECT_ID` = UUID профиля ScriptCat (из строки «ID:»)
   - `CF_SETUP_PROJECT_FOLDER` = `synapse`
4. Запустить функцию `setupProjectGateway()` один раз. Она создаст
   `Arena/synapse/{logs,payloads}`, зарегистрирует проект и выпустит **проектный** ключ
   в журнале выполнения. Ключ переносится только в поле «Ключ шлюза» в ScriptCat.
5. Deploy → Manage deployments → текущее развёртывание → Edit → New version → Deploy,
   если код обновлялся. URL нужен вида `https://script.google.com/macros/s/…/exec`.
6. В ScriptCat: «Проверить всё» → «Сохранить» → «Проверить подключения и разрешить работу».
   Профиль остаётся на удержании; «Шаг»/«Включить» — только по отдельному согласию.

Если при регистрации была ошибка — не запускать функцию повторно вслепую и не удалять папки:
сначала разобрать состояние реестра.

## 4. Приватный репозиторий и GitHub-токен

`synapse-cortex` приватный, поэтому ScriptCat нужен отдельный токен **чтения** (fine-grained,
Contents: Read-only, Pull requests: Read-only) — его вводит Мастер в поле GitHub.
Этот токен не даёт агенту прав на push/merge; доступ агентов к репозиториям идёт через
коннектор Arena, а не через токен userscript.

## 5. Что уже лежит в базах

### «Роли» — 5 строк, `Статус = Ждёт` (агенты ещё не привязаны)

| Роль | Функция | Agent URL |
|---|---|---|
| Coordinator | Coordinator | заполняет Мастер |
| Executor Core | Executor | заполняет Мастер (доступ к `synapse`) |
| Executor Cortex | Executor | заполняет Мастер (доступ к `synapse-cortex`) |
| Auditor | Auditor | заполняет Мастер |
| Warden | Reviewer | заполняет Мастер (этот агент) |

Опции `Кому` в «Запросах»: `Executor Core`, `Executor Cortex`, `Auditor` — ровно как `Роль`.
Все строки в статусе `Ждёт`, пока нет реальных URL: цикл не должен стартовать на
недонастроенных ролях (D-008).

### «Миссии» — 1 строка, `Состояние = Черновик`

`SYN-1 · Фаза 1 — локальный каркас ядра`, `Круг = 0`.
ТЗ: https://app.notion.com/p/SYN-1-1-40c6f0cf570581aeab6cefac6bad62f0
Копия в репозитории: `docs/missions/SYN-1.md`.

### «Обратная связь»

Свойство `Тип` (формула: «Предложение» / «Вопрос») добавлено поверх полей шаблона — это
подсказка интерфейса, на решение цикла не влияет.

## 6. Чек-лист Мастера (по порядку)

1. Создать агентов Arena под роли, вписать их `Agent URL` в «Роли», перевести в `Активна`.
2. Включить `Executor Core` доступ к GitHub-репозиторию `Creative36711/synapse`.
3. Установить `tools/script-cat/relay.user.js`, создать профиль (ID из §2).
4. Зарегистрировать проект в Gateway (§3), получить проектный ключ, вставить в ScriptCat.
5. «Проверить всё» → «Сохранить» → «Проверить подключения и разрешить работу».
6. Сказать Warden: «роли активны, профиль зелёный» — тогда миссия SYN-1 переводится в `Активна`.
