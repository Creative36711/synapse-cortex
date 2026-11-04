# Отчёт Warden — приёмка пакета ScriptCat 1.9.0

Дата среза: 2026-11-04. База: `origin/main` = `7bed48d`. Ветка:
`arena/c016c5f8-synapse-cortex`. Пакет: «Prompt Composer + Compact Delivery +
Agent Protocol Docs + Ephemeral Pilots» + Gateway 1.7 (artifacts).

Версии: **ScriptCat 1.9.0** (`@version` и runtime fallback совпадают, оракул
версий зелёный), **Drive Gateway 1.7**, digest регламента 1.5, protocolVersion
контракта 1.0.

## 1. Что проверено локально (зелёный оракул)

`npm run verify` = `scriptcat:check` + portability-guard + `test` + `test:regression`:

- Основные тесты: **77 pass / 0 fail**.
- Регрессии: **14 pass / 0 fail**.
- Сборка: бандл соответствует 35 исходным файлам; `--check` защищает от устаревшего
  `relay.user.js` и от устаревшей карты coverage.
- Coverage-оракул: **16 ruleId** покрыты блоками; каждый основной ролевой профиль
  (`executor.card`, `auditor.card`, `coordinator.plan`, `reviewer.mission`) несёт
  все обязательные для роли правила (`rules[*].requiredFor`). Карта зафиксирована
  в `tools/script-cat/contracts/prompt-coverage.json`.

Новые наборы (все зелёные): `test:prompts`, `test:delivery`, `test:pilot`,
`test:docs`.

### Инварианты прошлых PR сохранены и проверены боевым разбором
- **#37** — `Check=fail` без Rework не выдаётся; пропущенный `pr` ведёт в Rework
  (`relay-no-pr`, `relay-rework-return`, `relay-stale-plan`).
- **#38** — Coordinator recovery ≠ dispatch: recovery-профиль не содержит
  `task.assignment`/`git.executor`, маркер `CF_COORDINATOR_RESULT`
  (`relay-arena-swallow`, `relay-coordinator-authority`).
- **#40** — `verdict: master` сохраняет `question_id`/`turn_id`/`masterEscalated`;
  поздний маркер принимается только для того же вопроса; ручной ответ Notion
  «Решено» не перезаписывается (`relay-answer`, `relay-feedback-integration`).

### Gateway 1.7 (artifacts) — локальный harness, live Drive не затронут
- `drive-gateway-arena-smoke`: `Arena/{logs,payloads,artifacts}`, `saveArtifact`
  только в `artifacts`, имя `<dispatch>_<run>__<slug>.<md|txt|json|csv>`,
  идемпотентность по имени, лимит 262144 байт, `verifyArtifactPlacement`
  отклоняет файл в корне, `read` из artifacts разрешён, `append` в artifacts запрещён.
- `drive-gateway-projects-integration`: два проекта, разные ключи, граница
  чтения/записи, **миграция 1.6 → 1.7 усыновляет существующую `artifacts` без смены
  ключа**, несколько одноимённых папок → ошибка ручного разбора.
- `scriptcat-gateway-smoke`: порог проектного шлюза поднят до 1.7 (требуется
  подтверждённая папка `artifacts`), ограниченный транспорт, явные отказы.

### Пилоты SYN-P1 — изоляция проверена локально
- `test:pilot`: регистрация только по URL Мастера (автосоздание агентов НЕ
  реализовано), проверка изоляции/свежести, только публичный бриф + `Creative36711/synapse`
  + SHA, без CF_*/Notion/cortex/REGULATION/WARDEN/DECISIONS, отдельный namespace
  ожиданий, завершение по фактам, а не по маркеру.

## 2. Бюджеты overhead (замеры компилятора, не превышены)

| Профиль | Лимит | Факт |
|---|---|---|
| executor.card | ≤2800 | ~2758 |
| auditor.card | ≤2200 | ~2118 |
| coordinator.plan | ≤3200 | ~2700 |
| coordinator.recovery | ≤1500 | ~936 |
| reviewer.mission | ≤2400 | ~1900 |
| reviewer.answer | ≤1800 | ~1037 |
| reminder.marker | ≤700 | <700 |
| pilot.synapse | ≤250 | ~250 |

Доставка: мягкий 6000 / жёсткий 9000; Acceptance/Scope/инварианты/IDs не режутся
(`test:delivery`: full → compact → payload → pause, журнал-кольцо 200 записей без
секретов, один compact-повтор того же хода на `arena_generic_error`).

## 3. Живая приёмка — ВЫПОЛНИТЬ В ОКНО D-027 (ожидает подтверждения Мастера)

Локальные оракулы зелёные, но боевой цикл автоматически НЕ запускался (запрет вне
окна D-027/D-028; обращения к Notion/Drive в этом пакете — только чтение).
Чек-лист живой приёмки, который Warden прогоняет после подтверждения Мастера:

- [ ] ≥10 доставок, успешных ≥95% (журнал `cfn-prompt-journal-v1`).
- [ ] Coordinator recovery после обрыва — без повторного dispatch.
- [ ] Вопрос после `verdict: master` — поздний маркер только того же вопроса,
      ручной ответ «Решено» не перезаписан.
- [ ] `saveArtifact` в бою: файл строго в `Arena/<project>/artifacts`, имя по
      контракту, `artifacts` в `CF_AGENT_RESULT` читается.
- [ ] Пилот SYN-P1 по URL Мастера: изоляция, сырой транскрипт, завершение по фактам.
- [ ] Обновление ScriptCat до 1.9.0 и Gateway до 1.7 — только в окно D-027.

## 4. Расхождения и границы

- Создание/клонирование Arena-агентов НЕ реализовано (отдельное ТЗ); пилотный URL
  предоставляет Мастер.
- Внутренние инструкции не публикуются в публичный `synapse`; границы D-022 сохранены.
- Фазовые запреты, инварианты, оракулы, D-022…D-030 не менялись по смыслу; K-11/LICENSE
  после D-030 не переоткрывались.
- «Стало короче» ≠ «стало правильно»: полномочия, границы репозиториев, оракул,
  scope, IDs и протокол ответа сохранены — это проверено coverage-оракулом и
  legacy-наборами, а не только длиной строк.

**Статус передачи:** код + тесты + сборка + `docs/agents` готовы, локальный оракул
зелёный. Живая приёмка и приёмка Warden в бою завершаются в окно D-027 после
подтверждения Мастера.
