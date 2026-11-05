# Протокол ходов и доставка

## Виды ходов (kind)
`dispatch` (рабочая карточка), `plan` (очередь Координатора), `review` (приёмка
миссии), `answer` (ответ на вопрос), `reminder` (напоминание о маркере),
`retry` (компактный повтор), `pilot` (эфемерный прогон SYN-P1),
`provision` (административный запрос создания/замены Arena-агентов, не миссия и
не рабочая карточка). Контракт: `protocolVersion 1.5` (1.1 — provisioning,
1.2 — drive-контракт Gateway 1.8.0/D-033, 1.3 — бюджет overhead и payload-канал
D-034, 1.4 — прайм маркера Координатора и адрес артефактов D-035, 1.5 — хотфикс
длинной зоны роли D-036; аддитивно к 1.0).

## Профили и бюджеты overhead
| Профиль | Роль | Маркер | Overhead |
|---|---|---|---|
| executor.card | Executor | CF_AGENT_RESULT | ≤2800 |
| auditor.card | Auditor | CF_AGENT_RESULT | ≤2200 |
| coordinator.plan | Coordinator | CF_COORDINATOR_RESULT | ≤3200 |
| coordinator.recovery | Coordinator | CF_COORDINATOR_RESULT | ≤1500 |
| reviewer.mission | Reviewer | CF_REVIEW_RESULT | ≤2400 |
| reviewer.answer | Reviewer | CF_ANSWER_RESULT | ≤1800 |
| reviewer.card | Reviewer | CF_AGENT_RESULT | ≤2000 |
| reminder.marker | любая | по виду хода | ≤700 |
| delivery.compact | Executor/Auditor | CF_AGENT_RESULT | ≤1500 |
| pilot.synapse | pilot | нет | ≤250 сверх брифа |
| continuation.dispatch | Executor/Auditor | CF_AGENT_RESULT | ≤700 |
| continuation.plan | Coordinator | CF_COORDINATOR_RESULT | ≤700 |
| continuation.review | Reviewer | CF_REVIEW_RESULT | ≤700 |
| continuation.answer | Reviewer | CF_ANSWER_RESULT | ≤700 |
| continuation.pilot | pilot | нет | ≤250 |
| admin.provision | Coordinator/Reviewer (Agent Admin=true) | CF_AGENT_PROVISION_RESULT | ≤1800 |

Total-лимиты: Executor ≤6500, Auditor ≤5500, Coordinator ≤7500, Review ≤7000,
Answer ≤6000, reminder ≤900. Доставка: мягкий 6000, жёсткий 9000. Acceptance,
Scope, инварианты и ID не режутся молча: при превышении — пауза с причиной.
D-034: total-лимиты выдачи по ролям соблюдает и боевой путь (`DISPATCH_TOTAL`),
а не только оракулы; бюджеты overhead при этом **не подняты** — скелет промпта
стал компактнее (дедупликация base-ветки в git-блоках, короче `repo.target` и
заглушка `task.assignment`). Реальная карточка с длинным заголовком/зоной/веткой
(K-17) влезает в `auditor.card` ≤2200 без подъёма бюджета.

## Компиляция
`compilePrompt(request)` выбирает профиль, проверяет обязательные факты
(`missing_fact`), запрещённые блоки/аудитории (`forbidden_block`), маркер
(`marker_mismatch`), бюджет (`budget_exceeded`) и неизвестный профиль
(`unknown_profile`). Ошибка компиляции → локальная пауза, отправки нет.
D-034: `budget_exceeded` несёт разбивку по блокам (`id/chars/overhead/verbatim`),
и пауза называет топ блоков, съевших overhead, — причина диагностируема, а не
«overhead N > лимита».

## Payload-канал (D-034)
Папка `Arena/<project>/payloads` больше не простаивает. Большое задание
(длиннее `payloadInlineMax`, по умолчанию 1500 символов) не инлайнится в промпт:
на каждый прогон транспорт фиксирует снимок через Gateway `savePayload`
(`<dispatch_id>_<run_id>__assignment.md`, как журнал в `logs`) и доставляет
короткий **verbatim-указатель** на него. Снимок стабилен, даже если исходный
payload отредактируют во время хода. Стратегия доставки:
`full → payload-указатель → compact → pause`.

- **Оракул и Scope остаются inline** в промпте; payload-файл их не заменяет и не
  ослабляет. Указатель лишь отсылает к развёрнутому заданию.
- Малое задание остаётся инлайном (`full`), файл не создаётся.
- Отказ `savePayload`/`read` — явная ошибка/пауза, а не тихий инлайн.
- Указатель — verbatim-блок `task.assignment`, поэтому overhead он не увеличивает.

## Маркер Координатора и адрес артефактов (D-035)
Два дефекта боевого хода SYN-1 и их исправление (бюджеты **не подняты**):

- **Прайм маркера.** Маркер стоит только в конце длинного `coordinator.plan`, и
  после десятка tool-вызовов Координатор его «не видел» и честно отказывался
  выдать («формат не виден, по памяти не восстанавливаю»). Теперь
  `coordinator.plan`/`coordinator.recovery` открывает короткий блок
  `coordinator.prime`: «заверши ход маркером последней строки, формат и IDs — в
  конце промпта». Авторитетный маркер с IDs остаётся последним блоком. Блок
  прайма не несёт литерал маркера и не называется `marker.*` — инвариант «ровно
  один маркер, и он последний» не нарушается.
- **Адрес артефактов.** Раньше раскладку Drive (`drive.layout`) получал только
  Координатор, поэтому исполнитель/аудитор не знали папку `artifacts` и клали
  отчёты в корень Диска. Теперь `executor.card`/`auditor.card`/`reviewer.card`
  несут короткий блок `drive.artifacts`: «Артефакты в `Arena/<project>/artifacts`,
  не корень Диска; ссылки в поле `artifacts`». Имя проекта берётся из профиля
  (`driveFolder`), не зашито. Блок влезает в бюджет `auditor.card` ≤2200 без его
  подъёма (K-17-подобная карточка проходит). Отчёты, уже лежавшие в корне,
  перенесены в `artifacts` (перенос не меняет ID/URL; ретро-переименование
  запрещено D-031).

**Хотфикс D-036 (1.12.1).** Блоки D-035 съели запас бюджета, а боевая зона роли
оказалась длинной (~150 зн. против ~35 в фикстуре K-17): карточка K-20 дала
overhead 2209 > 2200 (`auditor.card`), план Координатора — 3202 > 3200. Лечение
без подъёма бюджетов: `coordinator.prime` и `drive.artifacts` урезаны;
`marker.agent` аудитора больше не объясняет `pr/merged` — этих полей нет в его
маркере. Регрессия закрыта пробой K-20 с длинной зоной (`prompts-smoke` §14–15).

## Доставка и повтор
Классы отказов: `editor_not_found`/`send_disabled`, `captcha`, `auth`/
`agent_unavailable`, `tool_call_limit`, `rate_limit`, `arena_generic_error`,
`network`, `budget_exceeded`, `unknown`. Только `arena_generic_error` даёт один
компактный повтор того же хода (plan → coordinator.recovery, dispatch →
delivery.compact). Капча/auth/rate_limit — пауза до человека. Журнал попытки хранит
профиль, блоки и их версии/хеши, метрики, попытку и исход (кольцо 200).

Compact-retry ролевой: `delivery.compact` для Auditor содержит read-only границу
(без коммитов, push и PR merge); Reviewer рабочую выдачу через compact не получает
(guard); Executor мержит сам. Coverage-карта проверяет git-границы compact/recovery
и continuation по роли, а не только по маркеру.

## Tool-call limit: продолжение хода
Состояние Arena «The agent reached the tool-call limit for this turn. Send a
message to continue where it left off.» — отдельный класс `tool_call_limit`
(определяется раньше `budget_exceeded`/`rate_limit`/`arena_generic_error`). Ход уже
начался, часть работы могла быть сделана. Действие — короткое сообщение-продолжение
в тот же чат (`continuation.*`), а не повтор задания, не compact-retry и не
напоминание о маркере.

- Детект: `role=status`/`alert` в транскрипте (amber — доп. признак), не в
  pre/code/diff/textarea/редакторе; привязка к ближнему `chat-message`; дедуп по
  `tool-limit:<messageId>` (без id — хеш текста+позиция).
- Продолжение сохраняет исходные IDs (dispatch/run, mission/turn, question/turn) и
  маркер вида хода; маркер — только после фактического завершения. Overhead ≤700
  (pilot ≤250). Запрещены блоки полного задания, очереди, регламента и pilot-блоки
  в командных профилях. Ошибка компиляции continuation → пауза, не отправка.
- Лимит `toolLimitContinueMax = 2`: исходный ход → 1-е продолжение → 2-е → пауза и
  Мастер. Пауза раньше лимита: нет прогресса после продолжения, провал отправки,
  несовпадение страницы/роли, ход уже завершён маркером.
- Состояние: `toolLimitContinuations`, `lastToolLimitMessageId`, `lastToolLimitAt`,
  `toolLimitNoProgress`, `continuationWatermark`. Не смешивается с `arenaResend`,
  `tries`, `branchResend`. Карточка Notion, PR, Check, Submitted At, Output Drive
  File ID и Run/turn/question IDs не меняются; новый Run ID не создаётся.
- Журнал: `tool_limit_continued`/`tool_limit_paused`/`tool_limit_no_progress`,
  `errorClass: tool_call_limit`, `profileId: continuation.*`, attempt, messageId,
  chars/utf8Bytes. Исходный watermark не сдвигается: финальный отчёт собирает части
  до лимита и после; continuation-сообщение ScriptCat не становится частью отчёта.
- Pilot SYN-P1: `continuation.pilot` без CF_* и внутренних ссылок, свой namespace.

## Provisioning Arena-агентов (1.10.0)
`admin.provision` — отдельный административный профиль. Аудитория: активная роль
с `Agent Admin=true` (предпочтительно Coordinator, иначе Reviewer). Обязательные
факты: `provision.requestId`, `provision.candidates`. Блоки: `identity.provision`,
`authority.provision`, `provision.candidates`, `provision.policy`,
`marker.provision`. Запрещены mission/queue/git/pilot-блоки и обычные маркеры
ходов. Overhead ≤1800. Ответ завершается одним `CF_AGENT_PROVISION_RESULT` с
тем же `request_id`; `jobs` содержит только `role_page_id` из отправленных
кандидатов, `action` только `create|replace`. Пустой `jobs` допустим. Команды
`archive/delete/activate/admin` как отдельные команды запрещены; архивация
старого агента — внутреннее следствие `replace`, а не команда маркера.

Provisioning не пишет `K.pending/K.expect`, не создаёт страницы Notion и не
запускает рабочий цикл. Во время запроса/job автоцикл выключен; после успеха
восстанавливается, если не было паузы. Право одобрения проверяется по свежей
строке Notion, а не по имени роли.

## Инварианты
- #37: `Check=fail` не выдаётся как Rework+Ready одним ответом.
- #38: recovery Координатора — не новый dispatch.
- #40: `verdict:master` сохраняет question_id/turn_id; поздний маркер принимается
  только для того же вопроса; ручной ответ «Решено» не перезаписывается.
