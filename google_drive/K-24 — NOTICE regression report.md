# SYN-1 · K-24 · Регресс NOTICE: npm-префикс, хэши и integrity после ратификации

- Dispatch: `40f6f0cf-5705-81ca-b623-f7a15715964e`
- Run: `e0eb2362-b116-4e6d-8f27-b97cc8784406`
- Mission: `40c6f0cf-5705-8128-ad44-fba3d8090400`
- Целевой репозиторий: `Creative36711/synapse`
- Целевой PR #9: https://github.com/Creative36711/synapse/pull/9 — `MERGED` 2026-11-05T16:32:12Z
- SHA всех проверок текущего main: `f85ee3470835b779e45aaa44c7a41cd488166188`
- Tree этого SHA: `5ffc5c1fa92aad5556bd8cca0083d41ccffb5806`
- PR #9 head: `88cebb860cf94d736b1c7e1a37fb09e86a1fd739`; merge SHA подтверждён `gh pr view 9`.
- Проверки проведены в полном чистом клоне (не shallow), detached на SHA выше. Репозиторий и его файлы не изменены; исправлений не потребовалось, отдельный PR не нужен.

## Репозиторная база и история

В исходном закреплённом checkout ветка `arena/22ac933c-synapse` была на K-21 (`654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1`), `origin/main` был на K-22. До получения полной истории `git merge-base HEAD origin/main` завершился `rc=1` при `--is-shallow-repository=true`; это не интерпретировалось как отсутствие общего предка. После `git fetch --unshallow origin`: `shallow=false`, merge-base найден (`654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1`, rc=0). Начальный `git status --short` был пуст. Рабочая ветка была fast-forward до `origin/main` без локальных правок и осталась `arena/22ac933c-synapse`.

PR #9 реально изменил `docs/contracts/localization.md` и `docs/decisions/SYN-1.md`; его merge-дерево имеет SHA `5ffc5c1fa92aad5556bd8cca0083d41ccffb5806`. PR #9 не менял `.gitignore`: diff `.gitignore` между K-21 и K-22 пуст. Строка `node_modules/` уже присутствовала в K-21; история репозитория указывает на более ранний K-2 коммит `d4e496f`.

## NOTICE и npm-префикс относительно K-21

Сравнение `NOTICE` в K-21 (`654dfdfedccdcf7d8fe48e375aaf0bcd5443b0d1`) и K-22 (проверяемый SHA) побайтово идентично:

- `git diff --no-ext-diff --unified=0 K21:NOTICE K22:NOTICE` — пустой diff, `rc=0`; удалённых/добавленных строк нет.
- Оба файла: 2,750 строк, 121,243 байта, SHA-256 `d1d730fb8c073f7dcc6efa147d5a3c2bd4d35e0939aaa44e91eaee5f86e6e24e`.
- npm-префикс до `## Godot Engine`: одинаков; 151 строка, 7,417 байт, SHA-256 `a0524f78d2d224edf60a73225709bd43ead779e51a3abb1bb16e0b1faced5318`.
- Состав заголовков атрибуций совпадает: 6 npm-разделов (`ajv`, `fast-deep-equal`, `fast-uri`, `json-schema-traverse`, `require-from-string`, `yaml`) и неизменённые разделы Godot Engine, SwiftShader и external tools; всего 9 заголовков `##`.
- `NOTICE` не изменялся; проверка верификатора подтверждает npm-блок, собранный из tarball.

## Офлайн-установка и проверка отсутствия сетевых обращений

Полный чистый клон `/tmp/k24-clean.tSFnme` был создан с `git clone --no-hardlinks`, затем detached на `f85ee3470835b779e45aaa44c7a41cd488166188`; clone tree `5ffc5c1fa92aad5556bd8cca0083d41ccffb5806`, `shallow=false`, начальный tracked status чистый. До запуска `node_modules` отсутствовал. Выделенный npm cache `/tmp/k24-npm-cache.CUcGsa` проверен пустым; после offline-установки он также остался пустым.

Команда `./tools/deps/offline-install.sh` запускалась в чистом клоне с Python socket tripwire (`socket.connect`, `connect_ex`, `send*`, `create_connection`, `getaddrinfo`): **RC=0**, верифицировано/установлено 6 lockfile-пакетов, суммарно 391,357 байт; audit-файл отсутствовал — ноль вызовов отслеживаемых Python сетевых API. Исходный скрипт также прямо указывает, что вызывает только `vendor.py`, не запускает npm и не имеет сетевого fallback; проверка использует только локальные `vendor/npm/**` и lockfile.

Ограничение доказательства: системный network namespace недоступен в sandbox (`unshare -n true` вернул EPERM), а `strace` не установлен. Поэтому не заявляется изоляция на уровне ядра; подтверждены нулевые обращения через сетевые API Python в процессе установщика и локальный путь выполнения скрипта. Полный вывод команды и коды возврата — в приложенном `K-24 — Verification Logs.txt`.

Прямой запуск `python3 -B tools/deps/vendor.py verify` на том же SHA: **RC=0**, `verified 6 packages, 391357 tarball bytes; SHA-256 and lockfile SRI match`.

## Контрольные негативные пробы

Каждая проба выполнена в том же временном клоне/SHA; изменённое содержимое после проверки восстановлено побайтово (`cmp rc=0`). В лог включены путь, ожидаемое и фактическое значения; верификатор завершился ненулевым кодом для каждой пробы.

1. **Изменён один байт** `vendor/npm/ajv-8.20.0.tgz`:
   - ожидаемый SHA-256: `b2f0b3a893bbb8cc5efb6814f08b1499e19e31d5dd73683f5893382f48f6e7b3`
   - фактический SHA-256 после мутации: `8119bba763bee622f3748d3bc847e727e9fcf97840d01af876e2f218e152a76c`
   - диагностирован файл `npm/ajv-8.20.0.tgz`, `SHA-256 mismatch`; **RC=1**.
2. **Изменён один символ** integrity для `node_modules/ajv` в временной копии `package-lock.json`:
   - изменённое ожидаемое lockfile значение: `sha512-Uhbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==`
   - фактический SRI tarball: `sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==`
   - диагностирован путь `node_modules/ajv`, integrity mismatch (sha512); **RC=1**.
3. **Удалена строка Ajv** из временной копии `vendor/SHA256SUMS`:
   - ожидаемый SHA-256 записи: `b2f0b3a893bbb8cc5efb6814f08b1499e19e31d5dd73683f5893382f48f6e7b3`
   - фактическая запись: отсутствует (`MISSING`)
   - диагностирован отсутствующий путь `npm/ajv-8.20.0.tgz`; **RC=1**.

После восстановления прямой verifier снова дал `RC=0`. `cmp` для tarball, lockfile и SHA256SUMS — `RC=0` для каждого; `git diff --exit-code` этих путей — `RC=0`. Никаких изменений в целевой репозиторий не внесено.

## `.gitignore` и контрольные пути

На том же SHA:

- `git check-ignore -v node_modules/` — совпадение `.gitignore:4:node_modules/`, **RC=0**.
- `git check-ignore -v vendor/npm/ajv-8.20.0.tgz` — не игнорируется, **RC=1** (ожидаемое отсутствие совпадения).
- `git check-ignore -v tools/deps/vendor.py` — не игнорируется, **RC=1**.
- `git check-ignore -v .gitignore` — не игнорируется, **RC=1**.
- `git ls-files --error-unmatch` для tarball, `tools/deps/vendor.py` и `.gitignore` — каждый путь tracked, **RC=0**.

Итого `node_modules/` скрыт как предназначено, vendored npm tarball и verifier не скрыты. Сам `.gitignore` между K-21 и K-22 не менялся.

## Оракул миссии на одном итоговом SHA

Перед тестами в чистом клоне установлен bundled Godot без пересборки: `tools/godot/install.sh --check` — **RC=0**, Godot `4.7.2.stable.custom_build.ed1daf0bf`, `SMOKE TEST OK`. Созданные скриншоты не открывались.

Все команды ниже запущены в чистом клоне на SHA `f85ee3470835b779e45aaa44c7a41cd488166188`, после офлайн-установки:

| Команда | Результат |
|---|---|
| `npm run check:contracts` | **RC=0**, 82/82, files=6 |
| `npm run test:validation` | **RC=0**, 16/16 |
| `npm run test:modules` | **RC=0**, 12/12 |
| `npm run test:i18n` | **RC=0**, 11/11 |
| `npm run i18n-check` (дополнительная проверка) | **RC=0**, 8 локалей, 17/17 ключей каждая |
| `git diff --check` | **RC=0**, вывод пуст |

После установщика и тестов tracked worktree чистый, HEAD/tree остались целевыми; `node_modules` — игнорируемый временный каталог.

## Вывод / границы

Регресс не обнаружен: npm NOTICE префикс/атрибуции не менялись, SHA-256 и SRI проверки блокируют все три негативные пробы, `.gitignore` не скрывает vendor или verifier, все объёмы оракула пройдены на одном SHA. Правки не требуются; PR не создавался (`pr:null`, `merged:false`). K-15 не изменялась и этой карточкой не подменялась.
