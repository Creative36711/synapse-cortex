# Drive: раскладка и артефакты

Корень проекта: `Arena/<project>`. Три служебные папки, файлы в корне Диска не
являются ни журналом, ни payload, ни валидным артефактом хода.

| Папка | Назначение | Имя | Создатель |
|---|---|---|---|
| logs | машинный журнал попытки, append-only | `<dispatch_id>_<run_id>.md` | ScriptCat через Gateway |
| payloads | входные большие задания | свободное безопасное имя | Gateway |
| artifacts | свободные результаты агентов | `<dispatch_id>_<run_id>__<slug>.<ext>` | агент через Gateway / Drive-коннектор с проверкой ScriptCat |

Ручной артефакт: `manual__<project>__<slug>.<ext>`.

## Артефакты (Gateway 1.7)
- MIME-whitelist: `text/plain`, `text/markdown`, `application/json`, `text/csv`.
- Максимум 262144 байт.
- `saveArtifact` кладёт файл строго в `artifacts`; файл в корне отклоняется
  (`verifyArtifactPlacement`). Идемпотентная миграция усыновляет существующую
  папку `artifacts`, не пересоздаёт её и не меняет ключ проекта.
- Необязательное поле `artifacts` в `CF_AGENT_RESULT` — массив ссылок на эти файлы.

## Реестр
`CF_GATEWAY_PROJECTS_V1` хранит `logsId`, `payloadsId`, `artifactsId` на проект.
Миграция 1.6 → 1.7 добавляет `artifactsId` без смены ключа и без потери истории.
