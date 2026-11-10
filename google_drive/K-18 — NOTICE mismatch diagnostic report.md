# SYN-1 · K-18 · Диагностика несовпадения NOTICE и offline-проверки

- Dispatch: `40e6f0cf-5705-8109-b073-e1e059bd6887`
- Run: `a6cb071c-581c-44b4-a510-fa2864e4a6ba`
- Миссия: `40c6f0cf-5705-8128-ad44-fba3d8090400`
- Дата диагностики: 2026-11-04
- Целевое состояние: `Creative36711/synapse@0b680a38188c55d07dca0b9d88843972880cf7f5`
- PR/commit в рамках K-18: не создавались; в основном репозитории нет изменений.
- Папка отчёта: Google Drive `Arena/synapse/artifacts`.

## Вывод

Наблюдение воспроизведено в отдельном полном чистом клоне целевого SHA: `vendor.py verify` и offline installer завершаются `rc=1` с одним и тем же сообщением `NOTICE does not match the license texts bundled in the verified tarballs`. Причина установлена: `vendor.py` формирует ожидаемый корневой `NOTICE` как ровно две вводные строки плюс шесть npm-лицензий из lockfile-архивов, а затем требует побайтного/текстового равенства всего файла с этим результатом. В K-11 в корневой `NOTICE` после прежнего npm-текста были добавлены лицензии/атрибуции Godot и SwiftShader и блок внешних инструментов. Первые 147 строк (7 281 байт) текущего `NOTICE` в точности совпадают с генерируемым npm-уведомлением; проверка падает на добавленном суффиксе, начинающемся с `NOTICE:149`.

Это объясняет точное диагностированное несовпадение. Это **не** повреждение архива и само по себе **не** доказывает юридический дефект лицензий или атрибуций. Проверка fail-closed: offline installer прекращает работу на первом `verify`, до создания staging-каталога и до изменения `node_modules`. Исправления не вносились.

## Исходное состояние, shallow-история и среда

В назначенной ветке `arena/be4435c0-synapse` перед диагностикой после `git fetch origin`:

- `HEAD = 0b680a38188c55d07dca0b9d88843972880cf7f5`
- `HEAD^{tree} = 81b955fcb784b6c4af003336c2acae8520ae18e8`
- `origin/main` имел тот же SHA и tree.
- `git merge-base HEAD origin/main` вернул `0b680a38188c55d07dca0b9d88843972880cf7f5` (ненулевой общий предок).
- `git rev-parse --is-shallow-repository` вернул `true`; исходный checkout shallow. Поэтому пустой merge-base здесь не использовался как доказательство отсутствия истории.
- `git status --short` был пуст до диагностики и остался пуст; `git diff --check` — без вывода, rc=0.

До дальнейшего исследования выполнены начальная Godot-проверка и чтение `AGENTS.md`. Полный вывод Godot и все команды с результатами/rc находятся в приложенном к отчёту файле логов. Godot сообщил версию `4.7.2.stable.custom_build.ed1daf0bf` и `SMOKE TEST OK`, rc=0. Скриншоты smoke test не открывались по прямому запрету открывать файлы для показа; визуальную проверку этим отчётом не заявляю.

Для воспроизведения создан отдельный полный клон `/tmp/k18-triage.0W842q/synapse` командой `git clone https://github.com/Creative36711/synapse.git ...`, затем `git checkout --detach 0b680a38188c55d07dca0b9d88843972880cf7f5`. В нём `--is-shallow-repository=false`, HEAD/tree совпали с целевыми значениями, исходный статус был чистым. Все команды install/verify ниже запускались в этом временном клоне или во временном worktree под `/tmp`, не в основном checkout.

Версии среды: Python 3.11.2; Git 2.39.5; Node.js v22.22.3; npm 10.9.8; Linux x86_64 (`6.1.158+`). `tools/godot/install.sh --check` сообщил Godot `4.7.2.stable.custom_build.ed1daf0bf`.

## Точные проверки и результаты

### Целевой SHA `0b680a38188c55d07dca0b9d88843972880cf7f5`

1. `python3 tools/deps/vendor.py verify` — **rc=1**:

   ```text
   offline-vendor: ERROR: NOTICE does not match the license texts bundled in the verified tarballs
   ```

2. `./tools/deps/offline-install.sh` — **rc=1**, тот же вывод. Временный clone после отказа: `git status --short` пуст, `node_modules` отсутствует, `.k15-node-modules.*` staging-каталога нет. Значит installer остановился до staging/install/replace, как предписывает `set -euo pipefail`; обхода отказа не было.

3. `(cd vendor && sha256sum -c SHA256SUMS)` — все шесть архивов `OK`, **rc=0**.

4. Read-only аудит lockfile/архивов (точная команда, скрипт и полный вывод — в `K-18 — Verification Logs.txt`) вызвал функции текущего `tools/deps/vendor.py`: построил package set из `package-lock.json`, сверил пути `SHA256SUMS` и каталог `vendor/npm`, вызвал `verify_package_tarball` для каждого архива (SHA-256 + lockfile SRI + внутренние name/version/license) и извлёк license text тем же `license_text`. Результат — 6/6 ожидаемых записей, 6/6 архивов, все метаданные и тексты соответствуют lockfile и tarball; затем ожидаемый `NOTICE` был собран функцией `expected_notice`. Этот скрипт не пишет в репозиторий; **rc=0**. Полные хэши ниже.

### Точечная сверка с K-15 merge `e19a8d3f8b51c536155bcc80f911e962b4360ea5`

В полном клоне K-15 SHA доступен; дерево: `918d3f0fbf1ed1c9095123dbc222f7d755d31b54`. Для него создан отдельный временный worktree, чистый до проверок.

- `python3 tools/deps/vendor.py verify` — **rc=0**: `offline-vendor: verified 6 packages, 391357 tarball bytes; SHA-256 and lockfile SRI match`.
- `./tools/deps/offline-install.sh` — **rc=0**: проверил 6 пакетов, установил 6 из локальных архивов, затем вывел `offline-install: installed package-lock.json tree without network access`. Это две точечные проверки K-15 snapshot, **не** K-15 acceptance, не переоткрытие K-15 и не снятие транспортного hold.
- `(cd vendor && sha256sum -c SHA256SUMS)` — все шесть архивов `OK`, **rc=0**.
- `git show e19a8d3f8b51c536155bcc80f911e962b4360ea5:NOTICE` побайтно совпал с результатом генератора `expected_notice`; `cmp` rc=0; SHA-256 обоих файлов `10b0bc224c17f93270df3c64f02ad7112c121d895d00189395c65e14f04abc28`.

### Минимальное конкретное несовпадение

| Объект | Размер/строки | SHA-256 |
|---|---:|---|
| `NOTICE`, результат `expected_notice()` из проверенных архивов | 7 281 байт, 147 строк | `10b0bc224c17f93270df3c64f02ad7112c121d895d00189395c65e14f04abc28` |
| `NOTICE` на целевом SHA | 121 243 байта, 2 750 строк | `d1d730fb8c073f7dcc6efa147d5a3c2bd4d35e0939aaa44e91eaee5f86e6e24e` |
| Добавленный суффикс `NOTICE` после сгенерированного префикса | 113 962 байта | `702288f02ff52f79bac05c29a5ee49cc4f2e9685708140d5e57c9858e38f2699` |

`ACTUAL_STARTS_WITH_GENERATED_EXPECTED=True`. Ожидаемый текст заканчивается после строки 147. Текущий `NOTICE:148` — пустая строка, `NOTICE:149` — `Additional notices for third-party components redistributed with the repository follow.`, `NOTICE:152` — секция Godot Engine 4.7.2. В этой строке находится первая отличающаяся часть полного файла; дальше добавлены upstream copyright inventory Godot, SwiftShader Apache-2.0 и внешние tool notes. Сам генераторный npm-префикс не повреждён.

Лицензионные тексты из шести проверенных tarball имеют следующие SHA-256; они включены в генераторный префикс:

| Lockfile package | License | SHA-256 текста лицензии |
|---|---|---|
| `ajv@8.20.0` | MIT | `f2fde84e6c1f177681e152a4459f025a87e855c0aa374238ba79b2e72a15b57c` |
| `fast-deep-equal@3.1.3` | MIT | `aa407ee69b3f646286f5162d0679256a0fe5b7fcc51f104ffb647efe167715ea` |
| `fast-uri@3.1.9` | BSD-3-Clause | `b010b0dfdfdb23d7396e03b82cd4621fc9bb8f95d6b0aea70b9c24e12074c786` |
| `json-schema-traverse@1.0.0` | MIT | `aa407ee69b3f646286f5162d0679256a0fe5b7fcc51f104ffb647efe167715ea` |
| `require-from-string@2.0.2` | MIT | `937e8ea6d28e259cb0a3703148f6b292c50708013888372feae61e3520b18100` |
| `yaml@2.9.1` | ISC | `cf12d35c36bad4b21582e8549d43283d304574764c28fe0b93f25f475c5e832c` |

### Сравнение релевантных файлов K-15 → целевой SHA

`git diff --numstat e19a8d3f8b51c536155bcc80f911e962b4360ea5 0b680a38188c55d07dca0b9d88843972880cf7f5 -- NOTICE LICENSE README.md package.json package-lock.json vendor tools/deps`:

```text
21  0  LICENSE
2603 0  NOTICE
4   0  README.md
4   1  package.json
```

- K-11 добавил root `LICENSE`, лицензирующий абзац в `README.md` и дописал сторонние notices в корневой `NOTICE`.
- `package.json` между этими SHA меняет только три i18n script entries; devDependencies не меняются.
- `git diff --quiet e19a... 0b680... -- package-lock.json vendor tools/deps/vendor.py tools/deps/offline-install.sh` — rc=0. То есть lockfile, архивы, их SHA manifest и обе команды offline verifier/install одинаковы на двух снимках. Отличие результатов точечных проверок объясняется `NOTICE`, а не изменением K-15 verifier, lockfile или архивов.
- K-15 `NOTICE` совпадает с generated notice; целевой `NOTICE` сохраняет его ровно как префикс и добавляет внешний материал.

## Механизм в исходниках

- `tools/deps/vendor.py:168–180`: `expected_notice()` создаёт две npm-вводные строки, затем для каждого пакета из lockfile — заголовок name/version/license и текст первого найденного `package/LICENSE*` из tarball. Возвращается один точный текст с завершающим `\n`.
- `tools/deps/vendor.py:220–232`: до проверки NOTICE валидируются package set, `SHA256SUMS`, фактическое множество архивов, SHA-256, lockfile SRI и внутренние метаданные пакета; затем выполняется `if actual_notice != expected: fail(...)` — сравнение всего корневого `NOTICE`, не только npm-секции.
- `tools/deps/offline-install.sh:4,9–16`: `set -euo pipefail`; сначала запускается `vendor.py verify`, только после успеха создаётся stage, затем вызывается `install` и заменяется `node_modules`. Поэтому текущая ошибка корректно блокирует offline-install без сети и без частичной установки.
- `tools/deps/README.md:65–72` описывает `snapshot` как операцию, которая «rebuilds root NOTICE from the bundled license texts»; это соответствует наблюдаемому контракту генератора.

## Безопасные варианты для последующего решения Warden

Ничего из перечисленного здесь не реализовано; текущий K-18 read-only.

1. **Оставить один root NOTICE как детерминированный aggregate:** в отдельной разрешённой карточке расширить `vendor.py`/его fixtures так, чтобы expected output собирался из lockfile-архивов и отдельно зафиксированных upstream-notice inputs/хэшей Godot и SwiftShader. Проверять aggregate строгим равенством, не разрешать произвольный хвост.
2. **Развести generated и curated notices:** выделить отдельный точный файл для npm-генератора, а root `NOTICE` оставить агрегирующим документом; изменить verifier на проверку generated-файла и добавить проверку наличия/ссылок всех redistributed component notices при упаковке. Решение должно гарантировать, что при распространении сохраняются все исходные атрибуции и лицензии.

Для любого варианта необходимы регрессии: `vendor.py verify` и offline installer проходят без сети на текущем snapshot; точный mismatch/подменённый license text или отсутствующий/лишний/повреждённый tarball по-прежнему даёт ненулевой rc до установки; lockfile SHA/SRI/name/version/license проверяются; K-15 snapshot продолжает проходить свои прежние точечные проверки; отсутствие `npm ci` не подменяет offline-проверку. Любая правка требует отдельного решения и оракула; K-18 не меняет файлы и не снимает hold.

## Ограничения и состояние

- Диагностирован только конкретный NOTICE mismatch и его fail-closed распространение в offline installer. Не делалось правовое заключение, оценка качества upstream лицензий, полный offline-гейт или финальная приёмка SYN-1.
- `npm ci` не запускался; сеть не использовалась для установки npm-зависимостей.
- K-15 и K-11 не переиздавались и их состояния не менялись. K-6/K-15 результаты и hold не затронуты.
- После анализа рабочий checkout `arena/be4435c0-synapse` остался на `0b680a38188c55d07dca0b9d88843972880cf7f5`, clean; PR/commit не создавались.
- Полные команды и выводы, включая required Godot log, воспроизведения на двух SHA, checksum checks и read-only notice audit, лежат в соседнем файле `K-18 — Verification Logs.txt` в той же папке Drive.
