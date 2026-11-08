# Маркеры

Маркер — последняя строка ответа, обычным текстом (не HTML-комментарий и не
вместо отчёта). Ровно один маркер на ход. ID копируются из текущего промпта;
шаблоны-заглушки (`<миссия>`, нулевые UUID) разбор отвергает. Если агент забыл
имя маркера, транспорт читает его JSON по лестнице (см. «Чтение маркера» ниже):
решение не теряется, а ID всё равно сверяются с этой выдачей.

## Матрица «ход → роль → маркер»
| Ход | Роль | Маркер | ID |
|---|---|---|---|
| план/очередь | Coordinator | CF_COORDINATOR_RESULT | mission_id, turn_id |
| рабочая карточка | Executor | CF_AGENT_RESULT | dispatch_id, run_id |
| проверка карточки | Auditor | CF_AGENT_RESULT | dispatch_id, run_id |
| приёмка миссии | Warden/Reviewer | CF_REVIEW_RESULT | mission_id, turn_id |
| ответ на вопрос | Warden/Reviewer | CF_ANSWER_RESULT | question_id, turn_id |
| арбитраж петли (D-053) | Warden/Reviewer | CF_ARBITER_RESULT | dispatch_id, turn_id |
| историческая карточка Reviewer | Reviewer | CF_AGENT_RESULT (+CF_REVIEW_RESULT по оракулу) | dispatch_id, run_id |
| provisioning агентов | Coordinator/Reviewer (Agent Admin=true) | CF_AGENT_PROVISION_RESULT | request_id |

## Примеры (прогоняются боевым разбором в test:docs)
```
CF_COORDINATOR_RESULT {"mission_id":"40c6f0cf-5705-81ae-ab6c-efac6bad62f0","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","status":"completed","next":"Executor Core"}
CF_AGENT_RESULT {"dispatch_id":"a709d6df-4698-4a98-b111-90d22de42894","run_id":"8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d","status":"submitted","check":0,"report":"docs/reports/syn-1.md","pr":"https://github.com/Creative36711/synapse/pull/41","merged":true}
CF_REVIEW_RESULT {"mission_id":"40c6f0cf-5705-81ae-ab6c-efac6bad62f0","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","verdict":"rework","remarks":"1) оракул не закрыт: npm run verify даёт fail 2"}
CF_ANSWER_RESULT {"question_id":"46208c7d-7c36-41df-ac99-2a38d79dbcf2","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","verdict":"answer","answer":"Оставить контракт как есть."}
CF_ARBITER_RESULT {"dispatch_id":"a709d6df-4698-4a98-b111-90d22de42894","turn_id":"7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f","verdict":"resolve","action":"ready","reason":"постановка требовала работу вне зоны карточки","fix":"убрать --input из оракула"}
CF_AGENT_PROVISION_RESULT {"request_id":"8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d","jobs":[],"reason":"кандидатов нет"}
```

## Необязательные поля
- CF_AGENT_RESULT: `check`, `report`, `pr`, `merged`, `question`, `artifacts`.
  `artifacts` — массив ссылок на файлы в `Arena/<project>/artifacts` (см. drive.md).
- CF_COORDINATOR_RESULT: `question`, `need`.
- CF_REVIEW_RESULT: `summary`, `remarks`, `reason`, `dispatch_id`, `run_id`.
- CF_ANSWER_RESULT: `answer`, `reason`.
- CF_ARBITER_RESULT: `action` (`ready`/`rework`/`accepted`/`blocked`), `reason`, `fix`, `summary`.
  `verdict:master` (обязателен `reason`) останавливает цикл — это право арбитра, но
  паузу снимает только человек. Для `verdict:resolve` обязательны `action` и
  `reason`: решение без причины не применяется.
- CF_AGENT_PROVISION_RESULT: `reason`. Обязательные: `request_id`, `jobs`.
  Каждый job: `role_page_id`, `role_name`, `repo`, `action` (`create|replace`).
  `role_page_id` — только из кандидатов, отправленных в запросе; `role_name` и
  `repo` сверяются со свежей строкой Notion. Отдельные команды
  `archive/delete/activate/admin` запрещены. Пустой `jobs` — корректный отказ.

## Чтение маркера: лестница транспорта (D-067)

Формат маркера не менялся. Меняется **чтение**: агенты пишут ответ по делу, но
последнюю строку оформляют по-своему — без имени, в другом регистре, с
одинарными кавычками. Прежний разбор требовал литерал имени и в таких ответах
видел «маркера нет»: цикл слал напоминания «не хватило последней строки», агент
повторял тот же JSON, и ход вставал на паузу при готовом решении (SYN-3,
07.11.2026, пауза 17:01:24).

Транспорт читает маркер по ступеням, от строгой к мягкой:

| Ступень | Что читается | Когда |
|---|---|---|
| 1 | литерал имени + JSON | всегда первой, поведение прежнее |
| 2 | имя иначе: `cf-coordinator-result`, `CF COORDINATOR RESULT` | регистр, `-`/`_`/пробелы |
| 3 | последний JSON верхнего уровня без имени | у объекта есть подпись маркера (см. ниже) |
| 4 | «почти JSON»: одинарные/типографские кавычки, висячая запятая | после 1–3 |

Подписи для ступени 3 — по ним JSON узнаётся без имени:

| Маркер | Ключи подписи |
|---|---|
| CF_COORDINATOR_RESULT | `next` |
| CF_AGENT_RESULT | `dispatch_id`+`status`, `dispatch_id`+`run_id`, `run_id`+`status` |
| CF_REVIEW_RESULT | `verdict` |
| CF_ANSWER_RESULT | `question_id` |
| CF_ARBITER_RESULT | `verdict`+`action`, `action`+`fix` |
| CF_AGENT_PROVISION_RESULT | `request_id`, `jobs` |

Правила, которые лестница **не** отменяет:

- **Идентичность сверяет вызывающий, а не разбор.** `dispatch_id`/`run_id` этой
  выдачи, `mission_id` этой миссии, `next` — существующая роль: чужие ID,
  чужая миссия и пустой `next` по-прежнему дают паузу. Лестница только даёт
  разбору увидеть объект, который агент и так прислал.
- **Шаблоны из наших же промптов не засчитываются**: `<роль|done>`, `<путь>`,
  `<миссия>`, кириллические описания в угловых скобках — на любой ступени.
- **Чужой JSON не подменяет ожидание**: сдача карточки не считается вердиктом
  приёмки, вердикт не считается сдачей работы, арбитраж не считается ответом.
  В журнале это названо: «последний JSON в ответе — CF_AGENT_RESULT».
- **Примеры и цитаты не считаются ответом**: если в тексте маркер упомянут, но
  это наша же строка-образец, разбор её отвергает (ступень 1, как раньше).

Что видно в журнале: причина отказа называется точно — `no-name` («JSON без
имени»), `placeholder` («шаблон из задания»), `foreign-json` («чужой JSON»),
`loose-name` («имя иначе»). Напоминание по `no-name` просит поставить имя в
начало последней строки и не переписывать ответ; после лимита пауза говорит
Мастеру, что не хватает только имени маркера. Бюджет напоминания не поднят
(`reminder.marker` 700, общий 900).
