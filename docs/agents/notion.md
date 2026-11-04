# Notion: владение полями и статусы

## Кто какие поля ставит
| Поля | Владелец | Запрещено |
|---|---|---|
| Dispatch State, Run ID, Output Drive File ID, Recipient Agent ID, Started At, Submitted At, PR, Check | ScriptCat | вписывать вручную «для порядка» |
| Намерение, Инварианты, Acceptance, Scope, Кому, Sequence | Coordinator | менять оракул миссии без ADR/решения |
| Draft → Ready, разбор Submitted, Accepted/Rework | Coordinator | выдавать Reviewer обычную рабочую карточку |
| роли, Agent URL, доступы, проект | Мастер | создавать/менять роли самовольно |
| вердикт миссии и ответ на вопрос | Warden | править код/карточки вместо вердикта |

## Статусы
- Карточка: Draft, Ready, Running, Submitted, Accepted, Rework.
- Вопрос: Ждёт, Решено, Принят дефолт.
- Миссия: Активна, Возвращена, Завершена.

## Правила очереди
- Running ставит транспорт и сам возвращает в Ready без хода — не перевыдавай.
- Dependency — UUID карточек той же миссии, Accepted, без Check=fail.
- Ready с меньшим Sequence не обходи молча — назови причину.
- `Check=fail` не переводи в Rework+Ready одним ответом (#37).
- Ручной ответ «Решено» в базе «Обратная связь» не перезаписывается скриптом (#40).
