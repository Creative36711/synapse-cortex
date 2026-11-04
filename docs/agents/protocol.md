# Протокол ходов и доставка

## Виды ходов (kind)
`dispatch` (рабочая карточка), `plan` (очередь Координатора), `review` (приёмка
миссии), `answer` (ответ на вопрос), `reminder` (напоминание о маркере),
`retry` (компактный повтор), `pilot` (эфемерный прогон SYN-P1).

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
`agent_unavailable`, `rate_limit`, `arena_generic_error`, `network`,
`budget_exceeded`, `unknown`. Только `arena_generic_error` даёт один компактный
повтор того же хода (plan → coordinator.recovery, dispatch → delivery.compact).
Капча/auth/rate_limit — пауза до человека. Журнал попытки хранит профиль, блоки и
их версии/хеши, метрики, попытку и исход (кольцо 200).

## Инварианты
- #37: `Check=fail` не выдаётся как Rework+Ready одним ответом.
- #38: recovery Координатора — не новый dispatch.
- #40: `verdict:master` сохраняет question_id/turn_id; поздний маркер принимается
  только для того же вопроса; ручной ответ «Решено» не перезаписывается.
