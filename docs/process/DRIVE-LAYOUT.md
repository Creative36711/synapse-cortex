# Раскладка Google Drive — Synapse

## 1. Папка шлюза (создаёт шлюз, не вручную)

```text
Arena/
└── synapse/            ← создаётся setupProjectGateway(), имя строго lowercase
    ├── logs/           ← журналы хода ScriptCat
    └── payloads/       ← полезные нагрузки
```

**Не создавать `Arena/synapse` вручную.** Шлюз отказывается регистрировать проект, если папка уже
существует, и не «усыновляет» существующие каталоги. Имя приводится к нижнему регистру, поэтому
`Synapse` и `synapse` конфликтуют.

## 2. Папка общих документов (создаёт Warden)

```text
Synapse/                 ← корень Диска, отдельно от Arena
├── docs/                ← ROADMAP, DECISIONS, METRICS, COST_MODEL, RISK_REGISTER, регламент
├── reports/             ← отчёты миссий и аудитов
├── decisions/           ← журналы решений по миссиям (docs/decisions)
└── assets/              ← артефакты: скриншоты, проверочные изображения, экспорты
```

### Фактические идентификаторы

| Папка | Drive ID |
|---|---|
| `Synapse` | `1frm1IMUrRbDYH3fLFLvTipcUFiCMWSTZ` |
| `Synapse/docs` | `1S5SupACHHvnwGuP6e7SxfaRkbTMh6jck` |
| `Synapse/reports` | `1fscBXZhnzSOF2qhXGRsG4mW2Or2auHYz` |
| `Synapse/decisions` | `1gkCoBDcNe0kVDhnGK8uT1HDBOMQIs4rD` |
| `Synapse/assets` | `1KJvAiUMjcgucrIM0p5Mea69zv0Ns-KED` |

Загруженные документы в `Synapse/docs`:

| Файл | Drive ID |
|---|---|
| `ROADMAP.md` | `185X7PSEPIL_JiBA3u2RWVMnj2o1ikElH` |
| `DECISIONS.md` | `1HIzpoxk8WXdg7yH6nU2anE75TRx_Ezu5` |
| `RISK_REGISTER.md` | `1e4FDiPrQiFJu1K6oD9twCu_R-HzGBY0v` |
| `COST_MODEL.md` | `1OtEM8_MsLrVKYXFFKhjzB9dI9yo-5or5` |
| `METRICS.md` | `1TqafVZf88A53Oz2EX7bqAkc4REtfUpGm` |
| `SYN-REGLAMENT.md` | `1COYK5METhKiZkm4rpxvY3aNXf8Hb6xF3` |

Диск — вспомогательный канал. Источник истины для текстов — закрытый репозиторий
`Creative36711/synapse-cortex`; копии на Диске нужны агентам, у которых нет доступа к этому
репозиторию. При расхождении правилен репозиторий.

Это рабочая папка для людей и агентов. Она **не** является хранилищем платформы: файловая основа
мастерской — управляемое объектное хранилище (см. Решение 8 в DECISIONS.md). Google Drive здесь —
инструмент совместной работы, а не инфраструктура публикации.

## 3. Изоляция от Narthex

| Проект | Папка шлюза | Папка документов |
|---|---|---|
| Narthex | `Arena/narthex` (если зарегистрирована) | `Narthex/` |
| Synapse | `Arena/synapse` | `Synapse/` |

Не использовать папки, ключи и файлы одного проекта в работе другого.
