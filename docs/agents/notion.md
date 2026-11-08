# Notion: владение полями и статусы

## Ссылки: только рабочий адрес, не публичный
В документах, карточках, отчётах и вопросах используются ссылки вида
`https://app.notion.com/p/<page_id>` (тот адрес, который отдаёт коннектор) либо голый
`page_id`/`database_id`. **Публичные ссылки `https://<workspace>.notion.site/...` не применяются:**
они отстают от правок и отключаются Мастером в любой момент, после чего документ ссылается в пустоту.
Публикация страницы наружу — решение Мастера, а не способ передать ссылку роли.

## Кто какие поля ставит
| Поля | Владелец | Запрещено |
|---|---|---|
| Dispatch State, Run ID, Output Drive File ID, Recipient Agent ID, Started At, Submitted At, PR, Check | ScriptCat | вписывать вручную «для порядка» |
| Намерение, Инварианты, Acceptance, Scope, Кому, Sequence | Coordinator | менять оракул миссии без ADR/решения |
| Draft → Ready, разбор Submitted, Accepted/Rework | Coordinator | выдавать Reviewer обычную рабочую карточку |
| роли, Agent URL, доступы, проект | Мастер | создавать/менять роли самовольно (исключение — разовое поручение Мастера записать вариант `Функция = Maintainer` и строку `Transport Maintainer`, D-074) |
| вердикт миссии и ответ на вопрос | Warden | править код/карточки вместо вердикта |

## Статусы
- Карточка: Draft, Ready, Running, Submitted, Accepted, Rework.
- Вопрос: Ждёт, Решено, Принят дефолт.
- Миссия: Активна, Возвращена, Завершена.

## Provisioning Arena-агентов (1.10.0)
Аддитивные поля базы «Роли» (старые поля не переименовываются):

| Поле | Тип | Значение | Кто пишет |
|---|---|---|---|
| Agent Admin | checkbox | право одобрения provisioning; default false | Мастер |
| Agent State | select | не требуется / запрошен / создаётся / создан / ошибка; пусто = не требуется | Мастер ставит «запрошен», ScriptCat ведёт состояние |
| Agent Job ID | rich_text | UUID job provisioning | ScriptCat |
| Agent Created At | date | момент создания новой сессии | ScriptCat |
| Previous Agent URL | url | старый Agent URL при replace | ScriptCat |

ScriptCat при provisioning пишет только: `Agent URL`, `Previous Agent URL`,
`Agent State`, `Agent Job ID`, `Agent Created At`, `Статус=Активна` после
проверок. ScriptCat не пишет: `Роль`, `Функция`, `Зона записи`, `Гейт`,
`Репозиторий`, `Agent Admin`. Страницы через `POST pages` не создаются — только
`patch(pageId, properties)`.

Кандидат: `Agent State=запрошен`, имя роли ≤100, функция
Coordinator/Executor/Auditor/Reviewer (в Notion встречается и `Auditory` —
совместимо), repo нормализуется в точный `owner/repo` и есть в allowlist профиля,
роль не админ, нет Running/Submitted и активного хода. Пустой `Agent URL` →
`create`, заполненный → `replace`. Заполненный URL без `Agent State=запрошен` не
трогается. Админ-роли не создаются/заменяются/архивируются provisioning.

Перед патчем строка перечитывается fresh: тот же URL — идемпотентно; другой новый
URL или активная роль с другим URL — пауза `provision-conflict` без перезаписи;
строка исчезла — пауза. Автоактивация требует валидный URL, совпадение repo и
имени sidebar, вариант в «Запросы → Кому» для Executor/Auditor (добавляется
аддитивно), отсутствие второго активного Coordinator, сохранение активного
Reviewer и отсутствие активной работы по роли.

## Правила очереди
- Running ставит транспорт и сам возвращает в Ready без хода — не перевыдавай.
- Dependency — UUID карточек той же миссии, Accepted, без Check=fail.
- Ready с меньшим Sequence не обходи молча — назови причину.
- `Check=fail` не переводи в Rework+Ready одним ответом (#37).
- Ручной ответ «Решено» в базе «Обратная связь» не перезаписывается скриптом (#40).
