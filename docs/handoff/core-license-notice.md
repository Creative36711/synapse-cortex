# Черновик передачи в `synapse`: LICENSE, NOTICE, раздел README

Это **черновик для переноса** агентом, у которого есть доступ к `Creative36711/synapse`.
Warden не пишет в открытый репозиторий. Перенос выполняется отдельной карточкой миссии
SYN-1 с проверкой: файлы на месте, README явно называет лицензионную модель, `NOTICE`
покрывает все фактические зависимости.

## 1. `LICENSE` (корень `synapse`)

```text
MIT License

Copyright (c) 2026 Synapse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Год и правообладателя подтверждает Мастер; до подтверждения формулировка не публикуется.

## 2. `NOTICE` — сторонние компоненты и лицензии

Заполняется по фактическому содержимому на момент переноса. Уже известное:

| Компонент | Версия | Лицензия | Как используется |
|---|---|---|---|
| Godot Engine | 4.7.2-stable + 3 патча проекта | MIT | движок; пропатченная сборка лежит в `tools/godot/dist/` |
| SwiftShader (Vulkan на CPU) | из `@sparticuz/chromium@153.0.0` | Apache-2.0 | программный Vulkan для offscreen-рендера |
| Python / Pillow | системный python 3.11 / Pillow | PSF / HPND (MIT-подобная) | медиа-инструменты, venv в `/tmp`, не распространяется |
| Blender (`bpy` wheel) | 4.5.3 LTS | GPL-2.0-or-later (Blender), bpy распространяется как есть | инструмент генерации ассетов, **не** входит в поставку игр и ядра |
| Node.js (тесты) | ≥ 20 | MIT | только проверки, не рантайм игр |

Правило: при добавлении любой зависимости строка в `NOTICE` с именем, версией и лицензией —
часть той же карточки, а не «потом». GPL-инструмент (Blender) нельзя встраивать в поставку
ядра так, чтобы он становился производной работой; он остаётся внешним инструментом.

## 3. Раздел README про лицензию (вставить в `synapse/README.md`)

```markdown
## Лицензия

Ядро, CLI, редактор, система модулей, валидатор, GameSpec, официальные модули и рецепты —
под лицензией **MIT** (см. [LICENSE](LICENSE)). Сторонние компоненты и их лицензии —
в [NOTICE](NOTICE).

Вы можете использовать это для любых целей, включая коммерческие, и **экспортировать свою игру
и продавать её где угодно** — в Steam, itch.io, на своём сайте — без участия платформы и без
комиссий.

Сервисы платформы мастерской (каталог, публикация, платежи) — отдельный проприетарный продукт;
они не требуются для сборки, запуска и экспорта игры. Права на ваш контент остаются у вас.
```

## 4. Границы

- `TOS_DRAFT` платформы готовится в `synapse-cortex` (`docs/handoff/TOS_DRAFT.md`), не в `synapse`.
- Нельзя копировать в `synapse` код из `synapse-cortex`, кроме случаев, когда это сознательное
  открытие функции под MIT — такое решение принимает Мастер и фиксирует в `DECISIONS.md`.
