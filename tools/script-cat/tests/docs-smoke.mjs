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
// D-049 аддитивен: форма существующих маркеров не менялась, бюджеты не поднимались.
assert.equal(contract.d049?.budgetsRaised, false, 'D-049 не поднимал бюджеты');
assert.match(contract.d049?.protocolNote || '', /остаётся 1\.11/, 'D-049: версия контракта не менялась');
assert.match(contract.d049?.fix || '', /escalateToWarden/, 'D-049: петля уходит арбитру');
assert.match(contract.d049?.safety || '', /снимается только человеком/, 'D-049: паузу снимает только человек');
assert.equal(contract.markers?.CF_ARBITER_RESULT?.role, 'Reviewer', 'D-049: арбитр — роль приёмки');
assert.deepEqual(contract.markers?.CF_ARBITER_RESULT?.required, ['dispatch_id', 'turn_id', 'verdict'],
  'D-049: маркер арбитра несёт ID этой карточки и решения');

// 2. Все документы на месте (включая drive.md, закрывающий битую ссылку).
const docs = ['README.md', 'protocol.md', 'markers.md', 'notion.md', 'drive.md',
  'roles/coordinator.md', 'roles/warden.md', 'roles/executor.md', 'roles/auditor.md',
  'troubleshooting.md', 'onboarding.md', 'acceptance-report.md'];
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

console.log('OK: docs — комплект на месте, маркеры прогнаны боевым разбором, бюджеты и ruleId согласованы');
