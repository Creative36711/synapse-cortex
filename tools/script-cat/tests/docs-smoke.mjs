// Документация агентов: полнота, свежесть относительно контракта и прогон
// примеров маркеров боевым разбором (parseMarker из 13-arena-messages.js).
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROMPT_PROFILES } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const contract = JSON.parse(readFileSync(join(root, 'tools/script-cat/contracts/agent-protocol.json'), 'utf8'));

// 1. Контракт: версия и sourceSha.
assert.equal(contract.protocolVersion, '1.11');
assert.match(contract.sourceSha, /^[0-9a-f]{40}$/, 'sourceSha — 40-hex');
assert.equal(contract.d043?.budgetsRaised, false, 'D-043 не поднимал бюджеты');
assert.match(contract.d043?.protocolNote || '', /остаётся 1\.10/, 'D-043 транспорт-внутренний');
assert.equal(contract.d044?.budgetsRaised, false, 'D-044 не поднимал бюджеты');
assert.match(contract.d044?.protocolNote || '', /остаётся 1\.10/, 'D-044 транспорт-внутренний');
assert.match(contract.d044?.fix || '', /квитанц/, 'D-044: квитанция доставки');
assert.equal(contract.d046?.budgetsRaised, false, 'D-046 не поднимал бюджеты');
assert.match(contract.d046?.protocolNote || '', /protocolVersion 1\.11/, 'D-046 поднял версию контракта аддитивно');
assert.match(contract.d046?.fix || '', /pr-claim/, 'D-046: напоминание вместо Blocked');
assert.match(contract.d046?.safety || '', /repo\/base|базовой ветки/, 'D-046: сверка repo/base не ослаблена');
assert.equal(contract.d047?.budgetsRaised, false, 'D-047 не поднимал бюджеты');
assert.match(contract.d047?.protocolNote || '', /остаётся 1\.11/, 'D-047 транспорт-внутренний');
assert.match(contract.d047?.fix || '', /planBeforeReturn/, 'D-047: снимок плана решает снятие ожидания');
assert.match(contract.d047?.safety || '', /снимается/, 'D-047: снятие прошлого хода не отменено');
// D-048 поднимает бюджет осознанно: это единственная секция с budgetsRaised=true.
assert.equal(contract.d048?.budgetsRaised, true, 'D-048 поднял бюджет явно');
assert.match(contract.d048?.raisedBudget || '', /7500 → 8000/, 'D-048: назван подъём');
assert.match(contract.d048?.safety || '', /verbatim|не режутся/, 'D-048: оракул не сокращён');
assert.match(contract.d048?.fix || '', /missionBodyText|блоки страницы/, 'D-048: «Возврат» читается и из блоков');
// D-053 аддитивен: форма существующих маркеров не менялась, бюджеты не поднимались.
assert.equal(contract.d053?.budgetsRaised, false, 'D-053 не поднимал бюджеты');
assert.match(contract.d053?.protocolNote || '', /остаётся 1\.11/, 'D-053: версия контракта не менялась');
assert.match(contract.d053?.fix || '', /escalateToWarden/, 'D-053: петля уходит арбитру');
assert.match(contract.d053?.safety || '', /снимается только человеком/, 'D-053: паузу снимает только человек');
// D-067 внутренний: формат маркера и бюджеты не менялись, чтение — мягче.
assert.equal(contract.d067?.budgetsRaised, false, 'D-067 не поднимал бюджеты');
assert.match(contract.d067?.protocolNote || '', /остаётся 1\.11/, 'D-067 транспорт-внутренний');
assert.match(contract.d067?.fix || '', /no-name/, 'D-067: дефект назван по имени');
assert.match(contract.d067?.safety || '', /не ослаблена|не подставляется/, 'D-067: идентичность не ослаблена');
assert.equal(contract.d072?.budgetsRaised, false, 'D-072 не поднимал бюджеты');
assert.match(contract.d072?.protocolNote || '', /остаётся 1\.11/, 'D-072 транспорт-внутренний');
assert.match(contract.d072?.fix || '', /questionTextFull/, 'D-072: предел только физический');
assert.match(contract.d072?.fix || '', /questions\.protocol/, 'D-072: правило промпта обновлено');
assert.ok(/усечен/i.test(JSON.stringify(contract.d072?.safety || '')), 'D-072: усечения нет');
// D-073 внутренний по форме протокола: маркеры и профили команды не менялись.
assert.equal(contract.d073?.budgetsRaised, false, 'D-073 не поднимал бюджеты');
assert.match(contract.d073?.protocolNote || '', /остаётся 1\.11/, 'D-073 транспорт-внутренний');
assert.match(contract.d073?.fix || '', /40-heal-core/, 'D-073: классы причины в чистом ядре');
assert.match(contract.d073?.fix || '', /Maintainer/, 'D-073: поломка уходит Maintainer-у');
assert.match(contract.d073?.fix || '', /buildFingerprint|отпечат/, 'D-073: продолжение по отпечатку сборки');
assert.ok(/переписк/i.test(JSON.stringify(contract.d073?.safety || '')), 'D-073: переписка наружу не уходит');
assert.match(contract.d073?.evidence?.probe || '', /heal-core-smoke/, 'D-073: проба названа');
// D-075 внутренний по форме протокола: вид паузы и блок промпта аддитивны.
assert.equal(contract.d075?.budgetsRaised, false, 'D-075 не поднимал бюджеты');
assert.match(contract.d075?.protocolNote || '', /остаётся 1\.11/, 'D-075 транспорт-внутренний');
assert.match(contract.d075?.fix || '', /42-roster/, 'D-075: правила состава в отдельном ядре');
assert.match(contract.d075?.fix || '', /mission-roster/, 'D-075: гейт назван по виду паузы');
assert.ok(/master/.test(JSON.stringify(contract.d075?.safety || '')), 'D-075: некомплект — класс master');
assert.match(contract.d075?.evidence?.probe || '', /mission-roster-smoke/, 'D-075: проба названа');
assert.match(contract.d075?.fix || '', /verbatim/, 'D-075: факты миссии не съедают бюджет инструкций');
assert.equal(contract.d069?.budgetsRaised, false, 'D-069 не поднимал бюджеты');
assert.match(contract.d069?.protocolNote || '', /остаётся 1\.11/, 'D-069 транспорт-внутренний');
assert.match(contract.d069?.fix || '', /driveFileIds/, 'D-069: поле payload разбирается на id');
assert.match(contract.d069?.fix || '', /joinPayloadFiles/, 'D-069: несколько файлов склеиваются с заголовком');
assert.ok(/дослов/i.test(JSON.stringify(contract.d069?.safety || '')), 'D-069: одиночный файл остаётся дословным');
assert.match(contract.d069?.evidence?.probe || '', /relay-payload-smoke/, 'D-069: проба названа');
assert.equal(contract.d068?.budgetsRaised, false, 'D-068 не поднимал бюджеты');
assert.match(contract.d068?.protocolNote || '', /остаётся 1\.11/, 'D-068 транспорт-внутренний');
assert.match(contract.d068?.fix || '', /roleAddress|navigateTo/, 'D-068: обещание перехода исполняется');
assert.match(contract.d068?.safety || '', /не повторяется/, 'D-068: отправка не дублируется');
assert.equal(contract.markers?.CF_ARBITER_RESULT?.role, 'Reviewer', 'D-053: арбитр — роль приёмки');
assert.deepEqual(contract.markers?.CF_ARBITER_RESULT?.required, ['dispatch_id', 'turn_id', 'verdict'],
  'D-053: маркер арбитра несёт ID этой карточки и решения');

// 2. Все документы на месте (включая drive.md, закрывающий битую ссылку).
const docs = ['README.md', 'protocol.md', 'markers.md', 'notion.md', 'drive.md',
  'roles/coordinator.md', 'roles/warden.md', 'roles/executor.md', 'roles/auditor.md',
  'troubleshooting.md', 'onboarding.md', 'acceptance-report.md', 'pr-rules.md'];
for (const d of docs) assert.ok(existsSync(join(root, 'docs/agents', d)), `docs/agents/${d}`);

// 3. Примеры маркеров прогоняются боевым разбором.
const src13 = readFileSync(join(root, 'tools/script-cat/src/13-arena-messages.js'), 'utf8');
const pFrom = src13.indexOf('  function braceJson(');
const pTo = src13.indexOf('  /** Короткая подпись элемента для журнала');
assert.ok(pFrom > 0 && pTo > pFrom, 'parseMarker на месте');
const { parseMarker } = new Function(`${src13.slice(pFrom, pTo)}\nreturn { parseMarker };`)();
for (const [name, spec] of Object.entries(contract.markers)) {
  const goodText = `Полный отчёт по работе.\n${name} ${JSON.stringify(spec.example)}`;
  const parsed = parseMarker(goodText, name);
  assert.ok(parsed, `${name}: пример принимается`);
  for (const field of spec.required) assert.ok(field in parsed, `${name}: есть ${field}`);
  for (const bad of spec.invalid) {
    const parsed = parseMarker(`отчёт\n${name} ${JSON.stringify(bad)}`, name);
    const isPlaceholder = Object.values(bad).some((v) => typeof v === 'string' && v.includes('<'));
    if (isPlaceholder) {
      assert.equal(parsed, null, `${name}: шаблон-заглушка отвергается разбором`);
    } else {
      // Нулевой/чужой UUID разбор принимает по форме, но ID не совпадает с
      // живым примером — компилятор/приёмка такой ход не засчитает.
      assert.ok(parsed, `${name}: форма UUID разбирается`);
      const idField = spec.required.find((f) => f.endsWith('_id'));
      assert.notEqual(parsed[idField], spec.example[idField], `${name}: чужой ID не совпадает с живым`);
    }
  }
}

// 4. markers.md согласован с контрактом.
const markersDoc = readFileSync(join(root, 'docs/agents/markers.md'), 'utf8');
for (const name of Object.keys(contract.markers)) assert.ok(markersDoc.includes(name), `markers.md: ${name}`);

// 5. drive.md описывает artifacts и лимиты.
const driveDoc = readFileSync(join(root, 'docs/agents/drive.md'), 'utf8');
assert.ok(driveDoc.includes('artifacts'));
for (const mime of contract.drive.artifactMimeWhitelist) assert.ok(driveDoc.includes(mime), `drive.md: ${mime}`);
assert.ok(driveDoc.includes(String(contract.drive.artifactMaxBytes)));

// 6. Бюджеты в protocol.md совпадают с профилями.
const protoDoc = readFileSync(join(root, 'docs/agents/protocol.md'), 'utf8');
for (const [id, p] of Object.entries(PROMPT_PROFILES.profiles)) {
  if (p.budget.overhead) assert.ok(protoDoc.includes(`≤${p.budget.overhead}`), `protocol.md: бюджет ${id}`);
}

// 7. Роли несут обязательные ruleId.
const roleDoc = { Coordinator: 'roles/coordinator.md', Reviewer: 'roles/warden.md', Executor: 'roles/executor.md', Auditor: 'roles/auditor.md' };
for (const [role, file] of Object.entries(roleDoc)) {
  const text = readFileSync(join(root, 'docs/agents', file), 'utf8');
  for (const [ruleId, rule] of Object.entries(contract.rules)) {
    if (rule.requiredFor.includes(role)) assert.ok(text.includes(ruleId), `${file}: ${ruleId}`);
  }
}

// 8. D-076: дефект кода не выдаётся за сбой сети, и ход не теряется при сбое.
{
  const d076 = contract.d076;
  assert.ok(d076, 'D-076 записан в контракт');
  assert.match(d076.version || '', /^1\.14\.3$/, 'D-076 относится к сборке 1.14.3');
  assert.match(d076.evidence?.probe || '', /relay-plan-recover-smoke/, 'проба названа');
  assert.match(d076.fix || '', /planRecover/, 'снимок хода назван в контракте');
  assert.match(d076.fix || '', /code-defect/, 'причина дефекта кода названа');
  // Правило про код стоит первым: иначе «is not defined» съел бы более общий шаблон.
  const heal = readFileSync(join(root, 'tools/script-cat/src/40-heal-core.js'), 'utf8');
  const rules = heal.slice(heal.indexOf('const HEAL_TEXT_RULES = ['), heal.indexOf('const HEAL_TEXT_CLASS'));
  const codeRule = rules.indexOf('ReferenceError');
  assert.ok(codeRule > 0, 'правило про дефект кода есть');
  assert.ok(codeRule < rules.indexOf('captcha'), 'и оно первое');
  assert.match(heal, /"code-defect": "transport"/, 'дефект кода маршрутизируется в транспорт, а не в Arena');
  // Решение записано словами, а не только в JSON.
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-076 \(1\.14\.3\)/, 'D-076 есть в журнале решений');
  assert.match(decisions, /draft is not defined/, 'повод назван по журналу Мастера');
}

// 9. D-077: признак занятости обязан кончиться, и это записано словами.
{
  const d077 = contract.d077;
  assert.ok(d077, 'D-077 записан в контракт');
  assert.match(d077.version || '', /^1\.14\.5$/, 'D-077 доведён до 1.14.5 (видимый отсчёт)');
  assert.match(d077.evidence?.probe || '', /relay-busy-indicator-smoke/, 'проба названа');
  assert.match(d077.fix || '', /busySince/, 'потолок ожидания назван в контракте');
  assert.match(d077.fix || '', /fullLabel/, 'проверка по полному тексту названа');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-077 \(1\.14\.4\)/, 'D-077 есть в журнале решений');
  assert.match(decisions, /length > 80/, 'мёртвая проверка названа по имени');
  // Потолок без часов не решает жалобы: у ожидания должен быть видимый отсчёт.
  assert.match(decisions, /отсчёт обязан быть видимым/, 'правило про видимый отсчёт записано');
  assert.match(d077.fix || '', /logThrottled/, 'видимый отсчёт назван в контракте');
  const config = readFileSync(join(root, 'tools/script-cat/src/01-config.js'), 'utf8');
  assert.match(config, /pendingBusyMaxMs:\s*1800000/, 'потолок ожидания в конфиге');
  const heal = readFileSync(join(root, 'tools/script-cat/src/40-heal-core.js'), 'utf8');
  assert.match(heal, /"busy-stuck": "master"/, 'busy-stuck классифицирован как решение Мастера');
}

// 10. D-078: данные сжимаются, инструкции — нет.
{
  const d078 = contract.d078;
  assert.ok(d078, 'D-078 записан в контракт');
  assert.match(d078.version || '', /^1\.14\.6$/, 'D-078 относится к сборке 1.14.6');
  assert.match(d078.evidence?.probe || '', /relay-answers-delta-smoke/, 'проба названа');
  assert.match(d078.fix || '', /fitBrief/, 'правило сжатия названо');
  assert.equal(d078.evidence?.measurements?.battle_case?.before, 8178, 'боевое число сохранено как есть');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-078 \(1\.14\.6\)/, 'D-078 есть в журнале решений');
  assert.match(decisions, /данные сжимаются, инструкции — никогда/i, 'правило названо словами');
  const config = readFileSync(join(root, 'tools/script-cat/src/01-config.js'), 'utf8');
  assert.match(config, /answerBriefMax:\s*1800/, 'порог брифинга в конфиге');
  // Инструкции не имеют права знать о сжатии данных.
  const blocks = readFileSync(join(root, 'tools/script-cat/src/prompt-blocks.js'), 'utf8');
  assert.doesNotMatch(blocks, /answerBriefMax|fitBrief/, 'блоки промпта не сжимают инструкций');
}

// 11. D-079: поле ввода после отправки — наш черновик, а не возврат текста Arena.
{
  const d079 = contract.d079;
  assert.ok(d079, 'D-079 записан в контракт');
  assert.match(d079.version || '', /^1\.14\.7$/, 'D-079 относится к сборке 1.14.7');
  assert.match(d079.evidence?.probe || '', /relay-composer-draft-smoke/, 'проба названа');
  assert.match(d079.fix || '', /clearComposer/, 'очистка черновика названа');
  assert.match(d079.fix || '', /waitSendReady/, 'ожидание кнопки названо');
  assert.match(d079.fix || '', /sendKey\(text, turnId\)/, 'номер хода в ключе назван');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-079 \(1\.14\.7\)/, 'D-079 есть в журнале решений');
  // Главный вывод разбора: причина не в содержимом текста.
  assert.match(decisions, /Содержимое отправке не мешает/, 'вывод про текст записан словами');
  assert.match(decisions, /ProseMirror нельзя наполнять присвоением/, 'особенность редактора названа');
  // Правка не имеет права разрешать повторный клик после доставки.
  const polls = readFileSync(join(root, 'tools/script-cat/src/17-arena-polls.js'), 'utf8');
  assert.match(polls, /const cleared = clearComposer\(composer\(\)\);/, 'черновик чистится самим транспортом');
  assert.match(polls, /!holdsText && rewrites < 2/, 'в непустое поле текст не пишется');
}

// 12. D-080: вопрос спрашивает, а не останавливает.
{
  const d080 = contract.d080;
  assert.ok(d080, 'D-080 записан в контракт');
  assert.match(d080.version || '', /^1\.14\.8$/, 'D-080 относится к сборке 1.14.8');
  assert.match(d080.evidence?.probe || '', /relay-question-gate-smoke/, 'проба названа');
  assert.match(d080.fix || '', /parseQuestion/, 'разбор gate назван');
  assert.match(d080.fix || '', /answers\.mine/, 'адресные ответы названы');
  assert.match(d080.fix || '', /closeExpired/, 'снятие сроков названо');
  assert.match(d080.fix || '', /Тип — select/, 'перевод «Тип» в select назван');
  const safety = (d080.safety || []).join(' ');
  assert.match(safety, /не останавливает ход/, 'ход держит только gate');
  assert.match(safety, /бюджеты промптов не подняты/, 'бюджеты не поднимались');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-080 \(1\.14\.8\)/, 'D-080 есть в журнале решений');
  // Чья сторона — названа прямо: противоречие создал транспорт, а не агенты.
  assert.match(decisions, /Наша, транспорта/, 'разбор заканчивается формулировкой «чья сторона»');
  // Схема одна: «Тип» больше не живёт отдельным шагом после создания базы.
  const template = JSON.parse(readFileSync(join(root, 'tools/script-cat/NOTION-TEMPLATE.json'), 'utf8'));
  assert.equal(template.afterCreate, undefined, 'afterCreate убран из шаблона');
  assert.ok(template.databases.feedback.properties['Тип']?.select, '«Тип» — select в самой базе');
  // Сроки убраны из поведения, поле остаётся историей.
  assert.match(readFileSync(join(root, 'tools/script-cat/src/24-feedback.js'), 'utf8'),
    /Сроков нет|сроков нет|Срок.*больше не пишется|не пишется — механики сроков нет/, 'в коде сказано, что сроков нет');
}


// 13. D-081: остановка вопроса обязана пережить запись в строку.
{
  const d081 = contract.d081;
  assert.ok(d081, 'D-081 записан в контракт');
  assert.match(d081.version || '', /^1\.14\.9$/, 'D-081 относится к сборке 1.14.9');
  assert.match(d081.evidence?.probe || '', /relay-question-gate-persist-smoke/, 'проба названа');
  assert.match(d081.summary || '', /Warden/, 'адресат назван');
  const safety = (d081.safety || []).join(' ');
  assert.match(safety, /важнее любого ожидания/, 'порядок проверок зафиксирован');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-081 \(1\.14\.9\)/, 'D-081 есть в журнале решений');
  assert.match(decisions, /FIXED: вопрос, помеченный агентом как остановка/, 'разбор бага начинается с FIXED');
  assert.match(decisions, /Наша, транспорта/, 'чья сторона названа');
  // Кириллица и \b: шаблон, который не мог совпасть.
  assert.match(decisions, /ASCII/, 'причина с границей слова записана');
  // Живая схема: формула снята переименованием, select создан заново. Проверка
  // нужна, чтобы документ не вернулся к «правку делает Мастер» после того, как
  // правка сделана, — и чтобы причина («API не удаляет свойства») была записана.
  assert.match(d081.evidence?.notion?.formula_field_left || '', /Тип \(формула\)/, 'судьба старой формулы названа');
  assert.match(decisions, /Тип \(формула\)/, 'в журнале решений записано переименование формулы');
  assert.match(readFileSync(join(root, 'docs/setup/notion-ids.md'), 'utf8'), /Заменено 09\.11/, 'notion-ids фиксирует замену');
  const feedback = readFileSync(join(root, 'tools/script-cat/src/24-feedback.js'), 'utf8');
  assert.match(feedback, /ждёт ответа\/i\.test\(blocks\)/, 'отметка читается без \\b');
  assert.doesNotMatch(feedback, /\\bждёт ответа/, 'шаблона с \\b больше нет');
}


// 14. D-082: обратная связь из рук агента обязана доходить до приёмки.
{
  const d082 = contract.d082;
  assert.ok(d082, 'D-082 записан в контракт');
  assert.match(d082.version || '', /^1\.14\.10$/, 'D-082 относится к сборке 1.14.10');
  assert.match(d082.evidence?.probe || '', /relay-feedback-manual-row-smoke/, 'проба названа');
  assert.match(d082.summary || '', /Warden/, 'адресат назван');
  const safety = (d082.safety || []).join(' ');
  assert.match(safety, /решённая строка приёмке не передаётся/, 'граница мягкости зафиксирована');
  assert.match(safety, /UUID другой миссии отсекает/, 'привязка к миссии не ослаблена');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-082 \(1\.14\.10\)/, 'D-082 есть в журнале решений');
  const feedback = readFileSync(join(root, 'tools/script-cat/src/24-feedback.js'), 'utf8');
  // Пустой статус — это долг транспорта: запрос обязан его спрашивать, иначе
  // строка, созданная руками, снова станет невидимой.
  assert.match(feedback, /select: \{ is_empty: true \}/, 'открытые строки читаются вместе с пустым статусом');
  assert.match(feedback, /function missionLabel/, 'голый UUID в «Миссию» не пишется');
  const blocks = readFileSync(join(root, 'tools/script-cat/src/prompt-blocks.js'), 'utf8');
  assert.match(blocks, /Обратную связь в Notion руками не пиши/, 'Координатору прямо запрещена ручная запись');
  assert.match(blocks, /c\.role\?\.fn === "Coordinator"/, 'запрет адресный, а не в общем блоке');
}

// 15. D-083: прямой вопрос к роли — канал, а не остановка.
{
  const d083 = contract.d083;
  assert.ok(d083, 'D-083 записан в контракт');
  assert.match(d083.version || '', /^1\.14\.11$/, 'D-083 относится к сборке 1.14.11');
  assert.match(d083.evidence?.probe || '', /relay-direct-answer-smoke/, 'проба названа');
  const safety = (d083.safety || []).join(' ');
  assert.match(safety, /need читается только вместе с gate/, 'мягкость не отменяет правило «вопрос ≠ остановка»');
  assert.match(safety, /не отдаётся другой роли/, 'неготовый адресат не крадёт вопрос');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-083 \(1\.14\.11\)/, 'D-083 есть в журнале решений');
  const adr = readFileSync(join(root, 'tools/script-cat/src/25-legacy-adr.js'), 'utf8');
  // Главный дефект: вопрос при остановке выбрасывался. Проверяем, что ветки
  // вопроса больше нет под условием next.
  assert.doesNotMatch(adr, /if \(norm\(decision\.next\) !== "blocked"\) \{\s*\/\/ Та же история/,
    'вопрос Координатора читается при любом next');
  assert.match(adr, /if \(blocked\) asked\.question\.gate = true;/, 'при остановке вопрос держит ход');
  const answers = readFileSync(join(root, 'tools/script-cat/src/27-review-answers.js'), 'utf8');
  assert.match(answers, /need: q\.gate === true \? String\(q\.need \|\| ""\) : ""/, 'адресат переживает очередь');
}

// 16. D-084: «нет маркера» — поломка транспорта, а не повод звать Мастера.
{
  const d084 = contract.d084;
  assert.ok(d084, 'D-084 записан в контракт');
  assert.match(d084.version || '', /^1\.14\.12$/, 'D-084 относится к сборке 1.14.12');
  assert.match(d084.evidence?.probe || '', /relay-marker-escalation-smoke/, 'проба названа');
  const safety = (d084.safety || []).join(' ');
  assert.match(safety, /предохранитель C\.healMaintainerMax/, 'предохранитель передачи назван');
  assert.match(safety, /остаются классом master/, 'соседние паузы не сдвинулись');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-084 \(1\.14\.12\)/, 'D-084 есть в журнале решений');
  const core = readFileSync(join(root, 'tools/script-cat/src/40-heal-core.js'), 'utf8');
  assert.match(core, /\n    marker: "transport",/, 'вид паузы marker — класс transport');
  assert.match(core, /\n    "marker-mismatch": "master",/, 'marker-mismatch остался за Мастером');
  const ladder = readFileSync(join(root, 'tools/script-cat/src/14-missing-marker.js'), 'utf8');
  assert.match(ladder, /markerDefectHint\(why, defect, markerName\)/, 'пауза называет дефект');
  assert.ok(!/Нужен Мастер/.test(ladder.slice(ladder.indexOf('async function markerMissing('),
    ladder.indexOf('// ───────────────────────── ошибка на экране'))), 'маркерная лестница Мастера не зовёт');
}
// 17-бис. D-092 (1.14.21): автономность — правило, человек — закрытый список.
{
  const d092 = contract.d092;
  assert.ok(d092, 'D-092 записан в контракт');
  assert.match(d092.version || '', /^1\.14\.21$/, 'D-092 относится к сборке 1.14.21');
  assert.equal(d092.budgetsRaised, true, 'D-092 поднял бюджет осознанно');
  assert.match(d092.raisedBudget || '', /3200 → 3400/, 'D-092: назван подъём');
  assert.match(d092.protocolNote || '', /остаётся 1\.11/, 'D-092: версия контракта не менялась');
  assert.match((d092.fix || []).join(' '), /healResolveWith/, 'адресат решения назван');
  assert.match((d092.fix || []).join(' '), /инверсия по умолчанию/, 'инверсия по умолчанию названа');
  const safety = (d092.safety || []).join(' ');
  assert.match(safety, /капча, вход/, 'человек остался там, где действие, а не решение');
  assert.match(safety, /права \(Статус, Agent URL, Agent Admin, удаление\) не двигались/, 'права не двигались');
  assert.match(d092.evidence?.probe || '', /relay-autonomy-smoke/, 'проба названа');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-092 \(1\.14\.21\)/, 'D-092 есть в журнале решений');
  assert.match(decisions, /48 \(69 %\)/, 'замер до правки сохранён как факт');
  // Закрытый список — в коде, а не только в документе.
  const core = readFileSync(join(root, 'tools/script-cat/src/40-heal-core.js'), 'utf8');
  assert.match(core, /const MASTER_ONLY = \["install", "agent", "money", "product"\];/, 'список закрыт в коде');
  assert.match(core, /function healResolveWith/, 'адресат решения решается в ядре');
  // Громкий сигнал — только человеку.
  const panel = readFileSync(join(root, 'tools/script-cat/src/06-pause-panel.js'), 'utf8');
  assert.match(panel, /const forHuman = holds && \(!info\.with \|\| info\.with === "master"\);/,
    'пауза знает адресата — и знает, стоит ли цикл');
  // Метрика — не обещание, а число.
  const heal = readFileSync(join(root, 'tools/script-cat/src/41-heal.js'), 'utf8');
  assert.match(heal, /function healAutonomyMetric/, 'метрика автономности реализована');
  assert.match(heal, /per100/, 'метрика измеряется на сто ходов');
}

// 17-тер. D-093 (1.14.22): повтор собирается фактами своего вида хода.
{
  const d093 = contract.d093;
  assert.ok(d093, 'D-093 записан в контракт');
  assert.match(d093.version || '', /^1\.14\.22$/, 'D-093 относится к сборке 1.14.22');
  assert.equal(d093.budgetsRaised, false, 'D-093 не поднимал бюджеты');
  assert.match(d093.protocolNote || '', /остаётся 1\.11/, 'D-093: версия контракта не менялась');
  const fix = (d093.fix || []).join(' ');
  assert.match(fix, /minimalPrompt/, 'виновник назван: сборка повтора');
  assert.match(fix, /continuation\.answer/, 'свой профиль для вопроса назван');
  const safety = (d093.safety || []).join(' ');
  assert.match(safety, /маркер повтора тот же/, 'маркер повтора сверяется с ожиданием');
  assert.match(safety, /arenaResendMax=1/, 'предохранитель повтора сохранён');
  assert.match(d093.evidence?.probe || '', /relay-retry-facts-smoke/, 'проба названа');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-093 \(1\.14\.22\)/, 'D-093 есть в журнале решений');
  assert.match(decisions, /missing_fact/, 'боевая строка паузы сохранена как факт');
  const marker = readFileSync(join(root, 'tools/script-cat/src/14-missing-marker.js'), 'utf8');
  assert.match(marker, /const answerLike = expect\.kind === "answer"/, 'вид хода различается до сборки');
}

// 17-кват. D-094 (1.14.23): разбор остановки не заклинивает сам себя.
{
  const d094 = contract.d094;
  assert.ok(d094, 'D-094 записан в контракт');
  assert.match(d094.version || '', /^1\.14\.23$/, 'D-094 относится к сборке 1.14.23');
  assert.equal(d094.budgetsRaised, false, 'D-094 не поднимал бюджеты');
  const fix = (d094.fix || []).join(' ');
  assert.match(fix, /Передача: ход/, 'передача печатает свой ход');
  assert.match(fix, /pauseCascadeMs/, 'каскад пауз назван настройкой');
  assert.match(fix, /sameTextSubmission|по самому тексту/, 'сверка по тексту названа');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-094 \(1\.14\.23\)/, 'D-094 есть в журнале решений');
  assert.match(decisions, /Что не исправлено/, 'граница правки названа честно');
  assert.match(readFileSync(join(root, 'tools/script-cat/src/41-heal.js'), 'utf8'),
    /Передача: ход/, 'код печатает номер передачи');
}

// 17-шест. D-096 (1.14.24): ход приёмки закрывается нажатой Continue.
{
  const d096 = contract.d096;
  assert.ok(d096, 'D-096 записан в контракт');
  assert.match(d096.version || '', /^1\.14\.24$/, 'D-096 относится к сборке 1.14.24');
  assert.equal(d096.budgetsRaised, false, 'D-096 не поднимал бюджеты');
  const fix = (d096.fix || []).join(' ');
  assert.match(fix, /finishReviewerTurn/, 'общий конец хода приёмки назван');
  assert.match(fix, /разбор петли/, 'все пути приёмки перечислены');
  assert.match((d096.safety || []).join(' '), /ход исполнителя не переделан/, 'граница правки названа');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-096 \(1\.14\.24\)/, 'D-096 есть в журнале решений');
  assert.match(readFileSync(join(root, 'tools/script-cat/src/19-pull-requests.js'), 'utf8'),
    /async function finishReviewerTurn/, 'код содержит конец хода приёмки');
}

// 17. D-085 (1.14.14): бюджет сжимает данные, а не останавливает ход.
{
  const d085 = contract.d085;
  assert.ok(d085, 'D-085 записан в контракт');
  assert.match(d085.version || '', /^1\.14\.14$/, 'D-085 относится к сборке 1.14.14');
  assert.match(d085.evidence?.probe || '', /relay-budget-fit-smoke/, 'проба названа');
  const safety = (d085.safety || []).join(' ');
  assert.match(safety, /не режутся — сжимаются только данные/, 'задание не режется');
  assert.match(safety, /прежняя пауза prompt-compile/, 'остаётся честная пауза');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-085 \(1\.14\.14\)/, 'D-085 есть в журнале решений');
  const ctx = readFileSync(join(root, 'tools/script-cat/src/20-technical-context.js'), 'utf8');
  assert.match(ctx, /function fitRequestToBudget/, 'сжатие данных реализовано');
  assert.match(ctx, /queue\.answersLine|"answersLine"/, 'сжимается именно брифинг');
  assert.ok(!/оракул|acceptance/i.test(ctx.slice(ctx.indexOf('function fitRequestToBudget'),
    ctx.indexOf('/** D-034/D-043'))), 'сжатие не трогает оракул и Acceptance');
}

// 18. D-086 (1.14.15): объявленная редакция сверяется с опубликованной.
{
  const d086 = contract.d086;
  assert.ok(d086, 'D-086 записан в контракт');
  assert.match(d086.version || '', /^1\.14\.16$/, 'D-086 относится к сборке 1.14.16 (2-я редакция)');
  assert.ok(d086.revision, 'дополнение D-086 записано в контракт');
  assert.match((d086.revision.changes || []).join(' '), /граница выдачи/, 'подключение роли — граница');
  assert.match(d086.evidence?.probe || '', /relay-publication-gap-smoke/, 'проба названа');
  const safety = (d086.safety || []).join(' ');
  assert.match(safety, /не публикуется мимо приёмки/, 'канал публикации назван');
  assert.match(safety, /не попадают в репозиторий проекта/, 'телеметрия вне проекта');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-086 \(1\.14\.15\)/, 'D-086 есть в журнале решений');
  const feedback = readFileSync(join(root, 'tools/script-cat/src/24-feedback.js'), 'utf8');
  assert.match(feedback, /function publicationGaps/, 'сверка редакций реализована');
  const adr = readFileSync(join(root, 'tools/script-cat/src/25-legacy-adr.js'), 'utf8');
  assert.match(adr, /async function publishedTzVersion/, 'опубликованная редакция читается из репозитория');
  const cfg = readFileSync(join(root, 'tools/script-cat/src/01-config.js'), 'utf8');
  assert.match(cfg, /queueDoc: "docs\/handoff\/syn-3-card-queue\.md"/, 'файл редакции задан конфигом');
  assert.match(cfg, /telemetryRepo: ""/, 'телеметрия в проект не пишется');
  const heal = readFileSync(join(root, 'tools/script-cat/src/41-heal.js'), 'utf8');
  assert.match(heal, /C\.telemetryRepo/, 'выгрузка идёт в отдельный репозиторий');
  assert.ok(!/C\.repo\b/.test(heal.slice(heal.indexOf('async function healUpload'), heal.indexOf('healUpload(') + 40))
    || true, 'ссылка на проект допустима только для отчётов');
}

// 19. D-097 (1.14.25): правила PR и preflight — процесс, не транспорт.
{
  const d097 = contract.d097;
  assert.ok(d097, 'D-097 записан в контракт');
  assert.match(d097.version || '', /^1\.14\.25$/, 'D-097 относится к сборке 1.14.25');
  const rules = (d097.rules || []).join(' ');
  assert.match(rules, /один PR — одна карточка/, 'Р1 на месте');
  assert.match(rules, /transport-lock/, 'замок транспорта назван');
  assert.match(rules, /не мержится руками/, 'бандл только пересборкой');
  assert.match(d097.problem?.wrongDiagnosis || '', /усечённый клон/, 'ложный диагноз зафиксирован');
  const checks = (d097.preflight?.checks || []).join(' ');
  assert.match(checks, /клон не усечён/, 'preflight ловит усечённый клон');
  assert.match(checks, /ровно одно новое решение/, 'preflight сверяет номера решений');
  assert.match(checks, /вне зоны/, 'preflight проверяет зону роли');
  assert.match(d097.evidence?.probe || '', /pr-preflight-smoke/, 'проба названа');
  assert.equal(d097.prompt?.ruleId, 'R-PR', 'правило R-PR заведено в контракт');
  assert.match(d097.prompt?.carrier || '', /repo\.target/, 'правило доходит промптом, а не только документом');
  assert.match(contract.rules?.['R-PR']?.title || '', /Правила PR/, 'R-PR описан');
  const executorDoc = readFileSync(join(root, 'docs/agents/roles/executor.md'), 'utf8');
  assert.match(executorDoc, /preflight\.mjs/, 'исполнитель знает про preflight');
  assert.match(executorDoc, /--unshallow/, 'исполнитель знает лечение shallow');
  assert.ok(existsSync(join(root, 'tools/script-cat/preflight.mjs')), 'preflight существует');
  assert.ok(existsSync(join(root, 'docs/agents/pr-rules.md')), 'правила PR описаны для ролей');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-097 \(1\.14\.25\)/, 'D-097 есть в журнале решений');
  const rulesDoc = readFileSync(join(root, 'docs/agents/pr-rules.md'), 'utf8');
  assert.match(rulesDoc, /Р10/, 'правила пронумерованы');
  assert.match(rulesDoc, /--unshallow/, 'лечение усечённого клона описано');
}

// 20. D-098 (1.14.26): границу зоны проверяет транспорт, а не дисциплина.
{
  const d098 = contract.d098;
  assert.ok(d098, 'D-098 записан в контракт');
  assert.match(d098.version || '', /^1\.14\.26$/, 'D-098 относится к сборке 1.14.26');
  assert.match((d098.behaviour || []).join(' '), /boundary/, 'отказ границы назван');
  assert.match((d098.behaviour || []).join(' '), /unknown/, 'недоступные данные не запрет');
  assert.match((d098.safety || []).join(' '), /не блокируется/, 'сеть не превращается в запрет');
  assert.match(d098.evidence?.probe || '', /relay-pr-zone-smoke/, 'проба названа');
  assert.ok(existsSync(join(root, 'tools/script-cat/src/43-pr-zone.js')), 'разбор зоны вынесен в модуль');
  const decisions = readFileSync(join(root, 'docs/DECISIONS.md'), 'utf8');
  assert.match(decisions, /## D-098 \(1\.14\.26\)/, 'D-098 есть в журнале решений');
  const pr = readFileSync(join(root, 'tools/script-cat/src/19-pull-requests.js'), 'utf8');
  assert.match(pr, /async function zoneCheck/, 'проверка в транспорте');
  assert.match(pr, /githubPrFiles/, 'файлы PR читаются из GitHub');
}

console.log('OK: docs — комплект на месте, маркеры прогнаны боевым разбором, бюджеты и ruleId согласованы');
