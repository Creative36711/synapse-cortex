# SYN-1 · K-21 · Исправить offline NOTICE verifier без потери атрибуций

- Dispatch: `40f6f0cf-5705-819d-9d69-d72e71734f83`
- Run: `e79c6297-2649-471c-b2ae-8e2c42c9a327`
- Миссия: `40c6f0cf-5705-8128-ad44-fba3d8090400`
- Исполнитель: Executor Core
- Решение Мастера / рамка: https://app.notion.com/p/ADR-GameSpec-https-github-com-Creative36711-syna-40f6f0cf570581bcbc72caff21714b77
- Диагностическая база: `BASE_SHA=0b680a38188c55d07dca0b9d88843972880cf7f5`, tree `81b955fcb784b6c4af003336c2acae8520ae18e8`
- Проверенный PR head: `2eeaab5727485aec9d364646b8ab39500a1c2cae`, tree `0b4a3dbde44c9b9857826e6a7e9ef3f351ea0afc`
- Squash merge: `654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1`, tree `0b4a3dbde44c9b9857826e6a7e9ef3f351ea0afc`
- PR: https://github.com/Creative36711/synapse/pull/8 — `MERGED`
- Изменения только в `tools/deps/vendor.py`, `tests/deps/test_vendor.py`, `package.json` (добавлена команда теста). `NOTICE`, `LICENSE`, `README.md`, `package-lock.json`, архивы и SHA256SUMS не менялись.

## Предварительная проверка и проверка отсутствия незавершённой попытки

Перед правками: `git fetch origin`; текущая ветка `arena/be4435c0-synapse`, чистая; `HEAD` и `origin/main` совпадали с BASE_SHA/tree выше; `git merge-base HEAD origin/main` вернул этот SHA, rc=0. `git rev-parse --is-shallow-repository` вернул `true`; общий предок существовал, поэтому пустой merge-base не трактовался как отсутствие истории.

`gh pr list --state all` до начала работы показал только уже merged PR #1–#7; открытого или незавершённого K-21 PR не было. В target main не было K-21 изменений. Начальный `git status --short` был пуст. Целевой SHA воспроизводили в полном временном клоне (не shallow), чтобы доступна была история K-15.

До первой правки прочитан `AGENTS.md`, выполнена команда `tools/godot/install.sh --check`. Полный вывод и rc=0 в `K-21 — Verification Logs.txt`; результат включает Godot `4.7.2.stable.custom_build.ed1daf0bf` и `SMOKE TEST OK`. Скриншоты не открывались по запрету открывать файлы для показа.

## Исходный регресс на BASE_SHA и причина

В чистом временном worktree BASE_SHA/tree команды воспроизвели регресс:

```text
$ python3 tools/deps/vendor.py verify
offline-vendor: ERROR: NOTICE does not match the license texts bundled in the verified tarballs
rc=1

$ ./tools/deps/offline-install.sh
offline-vendor: ERROR: NOTICE does not match the license texts bundled in the verified tarballs
rc=1
```

До/после отказа base worktree оставался чистым; `node_modules` не появился.

Механизм: прежний `expected_notice()` в `tools/deps/vendor.py` собирал npm-заголовки и лицензии из шести tarball, после чего сравнивал весь root `NOTICE` на точное равенство (`actual_notice != expected`). K-11 сохранил этот npm-блок в начале `NOTICE` и дописал после него notices Godot/SwiftShader и внешних инструментов. Поэтому исходные архивы и их лицензионный блок были в порядке, но весь файл отличался от генерируемого npm-only текста. `offline-install.sh` использует `set -euo pipefail` и вызывает `vendor.py verify` прежде создания staging и замены `node_modules`; ошибка блокировала установку fail-closed.

## Исправление

`verify_snapshot()` теперь читает `NOTICE` как bytes, сохраняет требование валидного UTF-8 и требует `actual_notice.startswith(expected_notice.encode("utf-8"))`. Значит npm-блок в начале файла по-прежнему должен совпасть byte-for-byte целиком; append-only дополнительные разделы допускаются. SHA256SUMS, lockfile SRI, package name/version/license, множество tarball, безопасность извлечения и порядок install не ослаблялись.

Добавлен stdlib-only regression suite `tests/deps/test_vendor.py` и команда `npm run test:deps`. Тесты проходят для корректного npm-блока с дополнительным NOTICE-разделом; отдельно подтверждают fail-closed для отсутствующего файла/блока, усечения, изменения байта блока, не-UTF-8 и для invalid tarball, SHA256SUMS/hash mismatch и lockfile SRI mismatch. Тесты используют только временные fixture-каталоги.

Команды на рабочем candidate до merge:

- `python3 tools/deps/vendor.py verify` — **rc=0**, `offline-vendor: verified 6 packages, 391357 tarball bytes; SHA-256 and lockfile SRI match`.
- `npm run test:deps` — **rc=0**, 8 тестов `OK`.
- `git diff --check` — **rc=0**.
- Изменения не включают зависимости и их версии; `package-lock.json` не изменён.

## PR, merge и финальный тест на merge SHA

Commit candidate: `2eeaab5727485aec9d364646b8ab39500a1c2cae`. PR создан командой `gh pr create --fill --base main`, затем PR #8 смержен командой `gh pr merge 8 --squash`. GitHub i18n checks завершились success; сами CI checks не использовались вместо прямых acceptance-команд.

Merge SHA `654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1` имеет тот же tree, что проверенный PR head (`0b4a3dbde44c9b9857826e6a7e9ef3f351ea0afc`). Для прямого post-merge оракула создан новый чистый полный клон, checkout именно merge SHA; в нём shallow=false, исходный статус пуст. После тестов дерево осталось тем же, `git status --short` пуст.

В новом клоне создан отдельный npm cache, и до команды проверено `find "$CACHE" -mindepth 1 -print -quit` — пустой вывод, `NPM_CACHE_EMPTY_BEFORE=yes`. На каждой команде выставлены `npm_config_cache="$CACHE"`, `npm_config_registry=http://127.0.0.1:1`, `HTTP_PROXY=http://127.0.0.1:1`, `HTTPS_PROXY=http://127.0.0.1:1`, `npm_config_offline=true`. В `PATH` добавлен `/tmp/synapse-godot/bin` по AGENTS.md для запуска валидатора.

Итоги на merge SHA:

| Команда | Результат |
|---|---|
| `./tools/deps/offline-install.sh` | **rc=0**; `verified 6 packages, 391357 tarball bytes; SHA-256 and lockfile SRI match`; `installed 6 lockfile packages`; installer подтвердил установку без сети |
| `npm run test:deps` | **rc=0**, 8 tests, OK |
| `npm run test:validation` | **rc=0**, tests 16, pass 16, fail 0 |
| `npm run check:contracts` | **rc=0**, `files=6 tests=82 pass=82 fail=0`, `contract-check: ok` |
| `git diff --check` | **rc=0**, без вывода |

### Прозрачное замечание о первом post-merge запуске

Первый временный clone тоже прошёл offline installer и test:deps, но `npm run test:validation` был запущен без Godot в `PATH` и завершился **rc=1**, все 16 тестов получили `spawnSync godot ENOENT`. Исправления кода не делались: был создан второй чистый clone того же merge SHA, cache создан заново и подтверждён пустым, `PATH=/tmp/synapse-godot/bin:$PATH` выставлен по AGENTS.md. В этом корректно подготовленном окружении все 16/16 прошли с rc=0, как указано выше. Полный первый ошибочный лог и полные логи успешного повторения приложены; неудачный запуск не скрыт и не выдан за pass.

После npm-команд cache содержит только npm `_logs` и `_update-notifier-last-checked` (около 6.6 KB); он был пуст до начала последовательности. Настройки мёртвого прокси и `npm_config_offline=true` не являются доказательством полной сетевой изоляции, и такой вывод здесь не делается. `npm ci` не запускался.

## Конечное состояние и границы

Ветка `arena/be4435c0-synapse` осталась активной и чистой. Проверенные и merge деревья совпали. `NOTICE`, LICENSE и все сторонние attribution не изменялись; `package-lock.json`, список/версии зависимостей, архивы и SHA256SUMS не менялись. Не менялись K-15/K-11 состояния или их hold/acceptance; никаких правок цикла не было. Это исправление verifier и диагностика регресса, не юридическое заключение, не приёмка K-15 и не снятие транспортного hold.

Полные выводы команд, rc, identity-контроль, regression fixture output, logs первоначального PATH-ошибочного запуска и post-merge чистого клона находятся в соседнем `K-21 — Verification Logs.txt` в папке `Arena/synapse/artifacts`.
