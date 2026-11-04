# Подключение роли и первый ход

## Предварительные условия
- Мастер создал Arena-агента и заполнил в базе «Роли»: Имя, Функция
  (Executor/Auditor/Coordinator/Reviewer), Статус «Активна», Agent URL.
  ScriptCat роли не создаёт и не клонирует.
- Настроен Drive Gateway ≥1.7 и проект в реестре `CF_GATEWAY_PROJECTS_V1`
  (logs/payloads/artifacts).
- Выбран профиль проекта в ScriptCat; обновление скрипта — только в окно D-027
  после подтверждения Мастера.

## Первый ход
1. Мастер создаёт миссию и черновики карточек (Намерение/Инварианты/Оракул/Scope).
2. Coordinator разбирает очередь и выдаёт Ready/Draft → Ready.
3. Транспорт ставит Running, отправляет промпт профиля роли, ждёт маркер.
4. Executor/Auditor отвечает отчётом + маркером; ScriptCat пишет журнал в logs.
5. Coordinator принимает Submitted → Accepted/Rework; по завершении — приёмка
   Warden (`CF_REVIEW_RESULT`).

## Пилот SYN-P1 (отдельно)
Мастер вручную даёт URL эфемерного агента и публичный бриф A/B/C + SHA synapse.
`registerPilotAgent` проверяет изоляцию; `sendToEphemeralAgent` шлёт только бриф
(без CF_*/Notion/cortex/REGULATION/WARDEN/DECISIONS). Завершение — по фактам
(idle + финальный отчёт), сырой транскрипт сохраняется; вопросы уходят Мастеру.

## Проверка
`npm run verify` и наборы `test:prompts`, `test:delivery`, `test:pilot`,
`test:docs` должны быть зелёными до боевого запуска.

## Provisioning Arena-агентов (1.10.0)
1. В профиле ScriptCat включите provisioning только после согласия Мастера: задайте allowlist точных `owner/repo`, bootstrap-пробник без внутренних токенов, лимиты и режим manual/auto. По умолчанию всё выключено.
2. В Notion «Роли» добавьте аддитивные поля: Agent Admin (checkbox), Agent State (select), Agent Job ID, Agent Created At, Previous Agent URL. Отметьте `Agent Admin=true` у действующего Coordinator или Reviewer.
3. Для создания тестовой роли поставьте `Agent State=запрошен`, пустой Agent URL, допустимую функцию и repo из allowlist. Для замены — заполненный URL и `Agent State=запрошен`.
4. Нажмите «🤖 Агенты», проверьте кандидатов и выдайте запрос. Создание начнётся только после маркера одобрения админ-роли. Во время provisioning автоцикл выключен.
5. Живую приёмку D-027 (create/replace/негативные проверки) проводите только после отдельного подтверждения Мастера и паузы цикла. Откат: выключить provisioning, снять Agent State, вернуть прежний Agent URL/Статус вручную; старый URL при replace хранится в Previous Agent URL.
