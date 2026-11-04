# Маркеры

Маркер — последняя строка ответа, обычным текстом (не HTML-комментарий и не
вместо отчёта). Ровно один маркер на ход. ID копируются из текущего промпта;
шаблоны-заглушки (`<миссия>`, нулевые UUID) разбор отвергает.

## Матрица «ход → роль → маркер»
| Ход | Роль | Маркер | ID |
|---|---|---|---|
| план/очередь | Coordinator | CF_COORDINATOR_RESULT | mission_id, turn_id |
| рабочая карточка | Executor | CF_AGENT_RESULT | dispatch_id, run_id |
| проверка карточки | Auditor | CF_AGENT_RESULT | dispatch_id, run_id |
| приёмка миссии | Warden/Reviewer | CF_REVIEW_RESULT | mission_id, turn_id |
| ответ на вопрос | Warden/Reviewer | CF_ANSWER_RESULT | question_id, turn_id |
| историческая карточка Reviewer | Reviewer | CF_AGENT_RESULT (+CF_REVIEW_RESULT по оракулу) | dispatch_id, run_id |

## Примеры (прогоняются боевым разбором в test:docs)
```
CF_COORDINATOR_RESULT {"mission_id":"40c6f0cf-5705-81ae-ab6c-efac6bad62f0","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","status":"completed","next":"Executor Core"}
CF_AGENT_RESULT {"dispatch_id":"a709d6df-4698-4a98-b111-90d22de42894","run_id":"8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d","status":"submitted","check":0,"report":"docs/reports/syn-1.md","pr":"https://github.com/Creative36711/synapse/pull/41","merged":true}
CF_REVIEW_RESULT {"mission_id":"40c6f0cf-5705-81ae-ab6c-efac6bad62f0","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","verdict":"rework","remarks":"1) оракул не закрыт: npm run verify даёт fail 2"}
CF_ANSWER_RESULT {"question_id":"46208c7d-7c36-41df-ac99-2a38d79dbcf2","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","verdict":"answer","answer":"Оставить контракт как есть."}
```

## Необязательные поля
- CF_AGENT_RESULT: `check`, `report`, `pr`, `merged`, `question`, `artifacts`.
  `artifacts` — массив ссылок на файлы в `Arena/<project>/artifacts` (см. drive.md).
- CF_COORDINATOR_RESULT: `question`, `need`.
- CF_REVIEW_RESULT: `summary`, `remarks`, `reason`, `dispatch_id`, `run_id`.
- CF_ANSWER_RESULT: `answer`, `reason`.
