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
