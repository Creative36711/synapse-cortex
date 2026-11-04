// ==UserScript==
// @name         Relay — передача хода между агентами
// @namespace    https://arena.ai/
// @version      1.9.0
// @description  Цикл Координатор → исполнитель → Координатор: агент сам коммитит, пушит и мержит PR; ScriptCat ждёт мерж и нажимает Continue.
// @match        https://arena.ai/*
// @match        https://www.arena.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @connect      api.notion.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      ntfy.sh
// @connect      api.github.com
// ==/UserScript==

/**
 * Relay dispatch — тонкий транспорт.
 *
 * Разделение труда (важно, иначе всё ломается):
 *  - АГЕНТ сам делает `git commit`, `git push`, `gh pr create`, `gh pr merge`
 *    и заканчивает ответ маркером результата.
 *  - SCRIPT ждёт состояние «PR merged», нажимает Continue и пишет ветку.
 *    Кнопки Create/Merge — только запасной путь, если агент не справился сам:
 *    каждая кнопка порождает ответ агента, то есть новый chat-message.
 *  - РЕШЕНИЯ о работе (какая задача, принята ли карточка) принимает
 *    Координатор. Конец миссии — не его решение: next:"done" передаёт миссию
 *    приёмке (роль с функцией Reviewer), и только её `accept` останавливает
 *    цикл. Больше трёх доработок не бывает: четвёртый возврат будит Мастера.
 *
 * Состояния PR, которые скрипт различает:
 *   Merged   — бейдж «Pull request merged»; мерж подтверждён интерфейсом.
 *   Closed   — бейдж «Pull request closed». Так выглядит и PR, слитый через
 *              GitHub, и PR, закрытый без мержа; что именно — решает маркер
 *              исполнителя (`merged: true`). Без заявки о мерже карточка
 *              уходит в Rework с причиной, а цикл продолжается.
 *   Timeout  — за prWaitMs мерж не появился: пауза, решение за человеком.
 *
 * Требует совместимого шлюза Drive с CF_DISPATCH, Notion-токена с доступом
 * к источникам и GitHub-токена на чтение PR: приватный репозиторий отвечает 404.
 */
