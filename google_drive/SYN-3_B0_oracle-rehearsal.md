# SYN-3 · B0 — репетиция оракула: исполнимость до выдачи карточек

**Дата:** 2026-11-02 (UTC)  
**Режим:** read-only audit; repository не изменялся, commit/push/PR не выполнялись.  
**Стартовый SHA:** `6cff12a1d5a0135bb38ee1de64720797136d51e9`  
**Tree:** `67f325d04788a6edd14782638729de68a7459f93`  
**Итог B0:** **не сходится; `check:1`**. Карточки B1+ нельзя выдавать до устранения перечисленных формулировочных и измерительных блокеров.

## 1. Provenance и метод

Создан новый полный clone `Creative36711/synapse`; `git fetch origin --prune` — RC=0; `git rev-parse --is-shallow-repository` — `false`; `origin/main` и detached `HEAD` равны `6cff12a1d5a0135bb38ee1de64720797136d51e9`.

B0 не засчитывает отсутствие будущей фичи как дефект исполнения будущего оракула. Проверяется другое: можно ли выполнить формулировку буквально сейчас, существуют ли нужные команды/пути либо есть ли явная карточка-создатель со Scope, измеримы ли числа, задан ли отрицательный вход и не ломает ли цепочку `git clean -xdf` восстановление требуемых инструментов.

Финально target clone чист:

```text
$ git status --porcelain                         -> RC=0, stdout empty
$ git status --ignored --short                   -> RC=0, stdout empty
$ git diff --exit-code && git diff --cached --exit-code -> RC=0
```

## 2. Измеренные базовые числа

Подготовка выполнима для существующего baseline:

```text
./tools/godot/install.sh --check                                         RC=0
npm_config_offline=true npm_config_registry=http://127.0.0.1:1 \
  ./tools/deps/offline-install.sh                                        RC=0
```

Фактические результаты на `6cff12a`:

| Команда | RC | Измерение |
|---|---:|---|
| `npm run check:contracts` | 0 | `files=7 tests=99 pass=99 fail=0` |
| `npm run test:contracts` | 0 | 99/99 |
| `npm run test:validation` | 0 | 16/16 |
| `npm run test:modules` | 0 | 18/18 |
| `npm run test:i18n` | 0 | 24/24 |
| `npm run test:runtime` | 0 | 1/1 |
| `npm run test:deps` | 0 | 8/8 |
| `npm run test:cli` | 0 | 20/20 |
| `npm run i18n-check` | 0 | 8 locales × 30/30, `overall ok` |
| `npm run i18n-no-literals` | 0 | `scanned=19 user-facing-literals=0` |

Число «контракты выросли» в V-1 не имеет начального значения, порога или точного будущего count. При известном baseline `99` это пока не проверяемый критерий: любое число больше 99 формально подходит, но не доказывает требуемое покрытие.

## 3. Блокирующие расхождения V-1…V-11

### B0-01 — V-1: отсутствуют обязательные пути и registration mechanism

**Вердикт: не подтверждено; блокер формулировки.**

```text
$ ls docs/contracts/world-state.md
RC=2: No such file or directory

$ ls schema/world-state.*.schema.json
RC=2: No such file or directory

$ grep -n world-state tests/contracts/lib/contracts.mjs
RC=1

$ grep -nE 'ref.unresolved|actions.file.missing' docs/contracts/scene-binding.md
RC=1
```

`tests/contracts/lib/contracts.mjs:17` содержит только `gamespec`, `module-manifest`, `error-registry` в `CASE_SETS`; world-state набор не зарегистрирован. В V-1 сказано «создана», но не названо «создаётся карточкой X» и Scope X. Поэтому отсутствие на старте не является product failure, но делает B0-criterion о покрытии пути/механизма непроверяемым.

**Нужная конкретизация до выдачи:** назвать карточку-создатель и Scope для `docs/contracts/world-state.md`, двух schema files, fixture/case sets и registration в `tests/contracts/lib/contracts.mjs:17`; зафиксировать точный новый count вместо «выросло».

### B0-02 — V-2: literal command не исполним, v2/slices и negative fixtures не назначены

**Вердикт: не подтверждено; блокер.**

V-2 требует `--frames 0/60/120`, однако parser на стартовом SHA разрешает только `1…3600` (`game/cli/main.gd:109–129`). Полная public invocation для указанного `0`:

```text
$ godot … run examples/arena.game.yaml --frames 0 --shot <absolute> --state <absolute>
{"code":"cli.run.frames.invalid","params":{"actual":0,"expected":{"maximum":3600,"minimum":1,"type":"integer"},"path":"/--frames"}}
RC=2
```

Также текущий эмиттер фиксирован как `synapse.world-state.v1` (`game/cli/main.gd:7`), а не V-2 с `rules`, `presentation`, `artifact`, `fingerprintScope`. Поиск V-2 terminology в README/AGENTS дал RC=1; README и AGENTS описывают V-1 fingerprint. Пункты V-2 используют `…`, не задают обязательный `--shot`, абсолютные output paths, точный формат двух negative fixtures или card/Scope, создающий их.

### B0-03 — V-3: input scenario не задан и текущий механизм не является InputEvent/button-channel

**Вердикт: не подтверждено; блокер.**

```text
$ test -f tests/fixtures/input/ui-script.json
RC=1

$ git grep -n '_unhandled_input' HEAD -- game/runtime/scenes tests
RC=1

$ git grep -n 'pressed.connect' HEAD -- game/runtime/scenes tests
RC=1
```

`game/runtime/scenes/arena.gd:67–68` только создаёт `PauseButton` и `RestartButton`. Existing `game/cli/main.gd:257–291` читает JSON массив действий `move_up/move_down/move_left/move_right`; он не задаёт формат `InputEvent`, не маршрутизирует UI button events и не описывает pause/restart state transition. В V-3 нет полного запускаемого command и байтового содержания `ui-script.json` — следовательно, невозможно доказать, что новая проверка падает на сломанной реализации.

### B0-04 — V-4: неполные invocations и contradiction diagnostics/path

**Вердикт: не подтверждено; блокер.**

V-4 использует `run … --state` / `run … --input`, то есть не указывает обязательные `--frames` и абсолютный `--shot`. Canonical completed invocations на baseline показывают также буквенное расхождение ожидаемых diagnostics:

```text
$ godot … run examples/arena.game.yaml --frames 1 --shot <absolute> \
  --state /proc/nope/state.json
RC=1
Top-level code=runtime.engine.missing, params.path=/--state
Nested renderer_record.code=cli.run.state.write_failed

$ godot … run examples/arena.game.yaml --frames 1 --shot <absolute> \
  --input /tmp/nope.json
RC=1
code=actions.file.missing, params.path=/--input, actual=/tmp/nope.json

$ env PATH=/usr/local/bin:/usr/bin:/bin <absolute-godot> … run …
RC=1
code=runtime.engine.missing, params.path=/run
```

V-4 требует top-level `cli.run.state.write_failed` и `params.path` равный переданному filesystem path, «никакого `/--state`». Current source has literal `/--state` at `game/cli/main.gd:404,414` and literal `/--input` at `:263,267`. Нужен ответственный Scope, который меняет этот contract, плюс полные commands и ожидаемый exact JSON.

### B0-05 — V-5: два обязательных negative inputs дают ложную зелень; unavailable-parser mechanism не существует

**Вердикт: не подтверждено; блокер INV-16.**

Временные external projects были созданы только в `/tmp`; команда и ввод для каждого задокументированы в artifact. Результат current parser:

| Временный `.gd` input | `node tools/i18n/no-literals.mjs --root <tmp>` |
|---|---:|
| multiline visible string | RC=0, `user-facing-literals=0` — ложная зелень |
| concat visible string | RC=1 |
| `chr(72) + chr(105)` | RC=0, `user-facing-literals=0` — ложная зелень |
| plain visible string | RC=1 |

V-5 не задаёт содержимое four named inputs, поэтому сами слова `multiline`, `concat`, `chr`, `plain` не являются воспроизводимыми fixtures. Existing `tests/i18n/no-literals.test.mjs` содержит `withProject` (`:13–31`), но именованных four cases в нём нет; `node --test tests/i18n/no-literals.test.mjs` проходит 8/8 (RC=0), не покрывая требуемые inputs.

`tools/i18n/no-literals.mjs` — встроенный tokenizer; поиск `setup-parser|parser|spawn|exec` даёт RC=1. `tools/i18n/setup-parser.mjs` отсутствует. Команда с предполагаемым parser switch:

```text
$ node tools/i18n/no-literals.mjs --parser /tmp/missing-parser
RC=1
stderr: i18n-no-literals: ERROR Unknown or incomplete argument: --parser
```

Это не «parser unavailable» test и не machine record. Отсутствуют механизм отключения parser, установленный parser и expected machine schema.

### B0-06 — V-6: B6 Scope и CI implementation отсутствуют в задании

**Вердикт: не подтверждено; блокер scope mapping.**

В assignment единственное упоминание B6 — строка V-6. Нет `### B6`, нет Scope B6 и нет mapping будущих V-2/V-5 mechanisms на B6. Поиск в assignment:

```text
$ grep -nE '^### B[1-9]|Scope.*B6|карточк[а-я]* B6' assignment.md
74: | V-6 | CI на PR карточки B6; ... |
RC=0
```

Current CI не содержит V-2/V-5 implementation markers:

```text
$ git show origin/main:.github/workflows/ci.yml | \
  grep -nE 'world-state|fingerprint|no-literals.test|--root|setup-parser'
RC=1
```

Положительная часть V-6 уже осуществима: V-9 zero-match guard существует и падает. Но PR B6, изменения workflow и Scope не заданы, поэтому B0 не может доказать покрытие новых CI steps.

### B0-07 — V-7: доступность module scene есть, но команда и full-set comparison не определены

**Вердикт: частично подтверждено, но пункт не готов как oracle command.**

`examples/module-scene.game.yaml` существует, registry/errors table есть; audited exact registry-vs-`docs/contracts/errors.md` comparison показал `missing_in_docs=[]` (RC=0). Но table V-7 содержит fragment `… -- run examples/module-scene.game.yaml`, который буквально не runnable: mandatory flags пропущены.

```text
$ godot --headless --path game --script res://cli/main.gd -- run examples/module-scene.game.yaml
{"code":"cli.run.frames.invalid","params":{"actual":-1,...}}
RC=2
```

Также «grep по docs на коды» не сравнивает множества. До выдачи нужен полный invocation с `--frames`/`--shot` и конкретная comparison command/script, аналогичная audited Python comparison registry→docs.

### B0-08 — V-8: documentation target не покрыт карточкой и текущий текст описывает V-1

**Вердикт: не подтверждено; блокер scope/mapping.**

README:45 и AGENTS:76–83 описывают `synapse.world-state.v1`, locale-independent fingerprint и исключение display text. Требуемые V-2 `fingerprintScope`, `rules`, `presentation`, V-2 и условие «не только locale» отсутствуют:

```text
$ git show origin/main:README.md | grep -nE 'world-state.v2|fingerprintScope|presentation|rules'
RC=1

$ git show origin/main:AGENTS.md | grep -nE 'world-state.v2|fingerprintScope|presentation|rules'
RC=1
```

V-8 не называет card X/Scope, который меняет `README.md` и `AGENTS.md`; B0 Scope этого не покрывает.

### B0-09 — V-9: nonempty guard работает, но no-Godot output не имеет явной причины

**Вердикт: не подтверждено полностью.**

```text
$ SYNAPSE_CLI_TEST_PATTERN='^__syn3_b0_zero_match__$' \
  node tools/ci/run-cli-tests.mjs
RC=1
stdout: test:cli pattern matched zero tests: ^__syn3_b0_zero_match__$
```

Это соответствует INV-16. Однако без `godot`:

```text
$ env PATH=/usr/local/bin:/usr/bin:/bin \
  SYNAPSE_CLI_TEST_PATTERN='run validates' node tools/ci/run-cli-tests.mjs
RC=1
```

Вывод — generic assertion `undefined … null !== 0`, а не явное сообщение об отсутствующем Godot. V-9 требует explicit message, поэтому второй half oracle не проходит буквально.

Кроме того, `tools/ci/run-cli-tests.mjs:27–30` фиксирует ровно 20 top-level CLI tests. Чтобы добавить новые V-2/V-3/V-4 tests, будущая карточка обязана назвать этот `file:line` и заменить check на обновлённый точный count либо manifest-backed exact count, **не удаляя zero-match/nonempty guard**. Такой способ замены в assignment не назван.

### B0-10 — V-10: исполнимо и подтверждено

**Вердикт: подтверждено.**

```text
$ grep -rniI 'закрытый репозиторий управления' . --exclude-dir=.git
RC=1  (ожидаемый no-match)

$ grep -rn 'repository is private' AGENTS.md
RC=1  (ожидаемый no-match)

$ git diff --check
RC=0
```

### B0-11 — V-11: clean recovery chain ломается на отсутствующем setup script

**Вердикт: не подтверждено; прямой блокер.**

Точная требуемая chain была выполнена в disposable clone:

```text
$ git clean -xdf && ./tools/deps/offline-install.sh && \
  tools/godot/install.sh --check && node tools/i18n/setup-parser.mjs
RC=1
```

Первые три части завершились успешно; финал:

```text
Error: Cannot find module '/tmp/synapse-syn3-b0-audit/tools/i18n/setup-parser.mjs'
code: 'MODULE_NOT_FOUND'
```

`test -f tools/i18n/setup-parser.mjs` также RC=1. Таким образом V-11 не восстанавливает заявленный parser после `git clean -xdf` и не способен повторить V-5 в требуемом режиме.

## 4. Literal-scope/D-065 check

Assignment упоминает D-065/D-066, но не содержит самой таблицы D-065 и не содержит Scope будущих cards, которые создают V-1…V-8/V-11 artifacts. Это не архитектурное замечание, а механическая причина, по которой невозможно проверить требование B0: «каждый путь/механизм покрыт Scope card X».

Нужны до выдачи:

1. явная таблица mapping `V requirement → card ID → Scope paths → mechanism`;
2. точные card Scopes для B1…B6 и карточки parser setup;
3. exact commands без `…`, со всеми required flags, absolute paths и expected exit semantics;
4. точные byte fixtures и known-failing negative inputs для V-2/V-3/V-5;
5. named `file:line` test updates с replacement, сохраняющим/увеличивающим проверочный count.

## 5. D-022

**Вердикт: defect не подтверждён.**

Проверены все 215 tracked blobs на SHA `6cff12a`; actual HTTP(S)/SSH URL scan дал:

```text
tracked_files=215 cortex_url_hits=0
RC=0
```

Dependency/config scan также пуст:

```text
$ git grep -nEi 'cortex' HEAD -- package.json package-lock.json tools/deps .github
RC=1
```

Допущение: вводная строка пользовательского сообщения называет `Creative36711/synapse-cortex@main`, но Scope и обязательный SHA явно задают `Creative36711/synapse@6cff12a`; аудит выполнен на `synapse`, где `origin/main` совпадает с указанным SHA.

## Итог

B0 **не принят**. Блокеры — B0-01…B0-09 и B0-11. V-10 подтверждён; в V-6/V-7/V-9 имеются отдельные готовые механизмы, но они не закрывают полные формулировки. Это не оценка будущей реализации фич; это доказанный перечень пунктов, которые нельзя проверить/выполнить буквально и обратимо по выданному oracle без недостающих card Scopes, concrete inputs, exact commands и recovery mechanism.

## Drive deliverables

- `Arena/synapse/logs/SYN-3_B0_oracle-rehearsal.md` — этот отчёт.
- `Arena/synapse/artifacts/SYN-3_B0_baseline-measurements.out` — базовые numeric measurements.
- `Arena/synapse/artifacts/SYN-3_B0_oracle-feasibility-probes.out` — V-1/V-2/V-3/V-4/V-5/V-7/V-9/V-10/V-11 raw commands and outputs.
- `Arena/synapse/artifacts/SYN-3_B0_source-scope-d022-evidence.out` — source, Scope/D-065, D-022 и clean status evidence.
