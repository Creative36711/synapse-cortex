# Протокол ходов и доставка

## Виды ходов (kind)
`dispatch` (рабочая карточка), `plan` (очередь Координатора), `review` (приёмка
миссии), `answer` (ответ на вопрос), `reminder` (напоминание о маркере),
`retry` (компактный повтор), `pilot` (эфемерный прогон SYN-P1),
`provision` (административный запрос создания/замены Arena-агентов, не миссия и
не рабочая карточка). Контракт: `protocolVersion 1.2` (1.1 — provisioning,
1.2 — drive-контракт Gateway 1.8.0/D-033; аддитивно к 1.0).

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

## Компиляция
`compilePrompt(request)` выбирает профиль, проверяет обязательные факты
(`missing_fact`), запрещённые блоки/аудитории (`forbidden_block`), маркер
(`marker_mismatch`), бюджет (`budget_exceeded`) и неизвестный профиль
(`unknown_profile`). Ошибка компиляции → локальная пауза, отправки нет.

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
