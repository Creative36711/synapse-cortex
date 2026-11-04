# Протокол агентов Synapse (ScriptCat)

Этот каталог — человекочитаемая выжимка машинного контракта
`tools/script-cat/contracts/agent-protocol.json` (protocolVersion 1.0).
Контракт — источник истины; при расхождении текста и кода фиксируйте расхождение
и предлагайте исправление, а не меняйте правило молча.

## Состав
- [protocol.md](protocol.md) — виды ходов, профили промптов, бюджеты, доставка.
- [markers.md](markers.md) — четыре маркера, матрица «ход → роль → маркер», примеры.
- [notion.md](notion.md) — владение полями баз и статусы.
- [drive.md](drive.md) — раскладка `Arena/<project>/{logs,payloads,artifacts}`.
- [roles/coordinator.md](roles/coordinator.md), [roles/warden.md](roles/warden.md),
  [roles/executor.md](roles/executor.md), [roles/auditor.md](roles/auditor.md).
- [troubleshooting.md](troubleshooting.md) — классы отказов доставки и что делать.
- [onboarding.md](onboarding.md) — как подключить роль и запустить первый ход.
- [acceptance-report.md](acceptance-report.md) — отчёт Warden о приёмке пакета 1.9.0.

## Границы репозиториев (D-022)
- `Creative36711/synapse` — публичное ядро (MIT). Его пишут роли ядра.
- `Creative36711/synapse-cortex` — закрытый контур управления. Роли ядра его не
  видят; ссылка на cortex внутри synapse — дефект.
- Внутренние инструкции не публикуются в публичный synapse.

## Регламент
Версии блоков промптов и версия регламента живут раздельно (K-14). Карта
`ruleId → block → profiles` проверяется coverage-оракулом сборки
(`coverage-oracle.mjs`) и фиксируется в машинном артефакте
`tools/script-cat/contracts/prompt-coverage.json`; обязательные для роли ruleId
перечислены в контракте (`rules[*].requiredFor`). Сборка падает, если правило
регламента потерялось при сжатии блоков или профиль не несёт обязательное правило.

Версии пакета: ScriptCat **1.10.0**, Drive Gateway **1.8.0** (папка `artifacts`,
миграция без смены ключа; имена D-031, PNG/base64, подкаталог миссии по явному
запросу; размер артефакта в байтах, конфликт дубликата по содержимому). Состояние Arena «tool-call limit» обрабатывается продолжением того же
хода (`continuation.*`, класс `tool_call_limit`) — см. [protocol.md](protocol.md) и
[troubleshooting.md](troubleshooting.md). Обновление боевого скрипта — только в
окно D-027 после подтверждения Мастера.
