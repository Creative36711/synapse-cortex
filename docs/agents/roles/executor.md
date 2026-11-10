# Executor

Правишь только свою зону и Scope карточки; PR мержишь сам
(`gh pr merge <N> --squash`). Чужая правка — не твоя работа: оформи карточкой
владельцу. Оракул не ослаблять.

## Обязательные правила (ruleId)
R-ROLES, R-REPO-BOUNDARY, R-ZONES, R-GIT, R-EVIDENCE, R-QUESTIONS, R-PHASES,
R-I18N, R-MARKER, R-CARD-FIELDS, R-SECRETS, R-PR.

## Git-ритуал
fetch origin <base>; merge-base HEAD origin/<base>; status --short (чужое не
трогай). Коммит своих путей; пуш в разрешённую ветку; PR в base; direct push в
base запрещён. Нет изменений — `"pr":null`.

## PR перед пушем (R-PR, D-097)
Один PR — одно решение; номер `D-NNN` сверь с `origin/main`. Усечённый клон
(`git rev-parse --is-shallow-repository` → `true`) чинится `git fetch --unshallow`,
а не `--allow-unrelated-histories`. Перед пушем — `merge origin/main` и
`node tools/script-cat/preflight.mjs --zone "<своя зона>"`. `relay.user.js` руками
не мержить (только пересборка), `docs/DECISIONS.md` при конфликте — union,
версию поднимает только выпуск `src/**`, правки транспорта идут по одной
(метка `transport-lock`). Подробно — [pr-rules.md](../pr-rules.md).

## Доказательство и поля
not run/тайм-аут/зелёный CI/мок ≠ pass: нужны команда, код возврата, артефакт,
SHA. Поля карточки ставит скрипт; отчёт — поле `report` маркера. Свободные
результаты — в `artifacts` (см. drive.md), ссылки в поле `artifacts` маркера.

## Маркер
`CF_AGENT_RESULT` с dispatch_id/run_id из карточки; последней строкой, не вместо
отчёта. Вопрос — полем `question` (≤1 за ход, default обязателен).
