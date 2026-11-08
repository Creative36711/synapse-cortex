// Отпечаток сборки.
//
// D-027 требовал машинную проверку «контент изменился — номер обязан измениться»,
// но проверять её было нечем: метаданные ScriptCat отпечатка кода не содержат
// (`sctl get -o json` даёт version и updatedAt), а под одним номером 1.8.2 уже
// лежали две разные сборки. Поэтому сборка сама пишет в бандл отпечаток: SHA-256
// от склеенного источника. По нему видно, какая именно сборка работает и
// сменилась ли она после установки нового номера.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

/** Плейсхолдер в `src/01-config.js`; сборка заменяет его отпечатком. */
export const FINGERPRINT_PLACEHOLDER = '"@@BUILD_FINGERPRINT@@"';

/** Предел: отпечаток — короткая строка, а не дамп. */
export const FINGERPRINT_LENGTH = 16;

export function buildFingerprint(source) {
  const text = String(source || '');
  assert.ok(text.length > 0, 'отпечаток пустого источника не считается');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

export function inlineFingerprint(source, fingerprint) {
  const count = source.split(FINGERPRINT_PLACEHOLDER).length - 1;
  assert.equal(count, 1, 'в исходниках транспорта должен быть ровно один плейсхолдер отпечатка сборки');
  assert.match(String(fingerprint), new RegExp(`^[0-9a-f]{${FINGERPRINT_LENGTH}}$`), 'отпечаток — hex фиксированной длины');
  return source.replace(FINGERPRINT_PLACEHOLDER, JSON.stringify(fingerprint));
}

/** Прочитать отпечаток обратно из бандла (для проб и сторожа). */
export function readEmbeddedFingerprint(source) {
  const match = String(source || '').match(/buildFingerprint:\s*"([0-9a-f]{8,64})"/);
  assert.ok(match, 'в бандле нет поля buildFingerprint: сборка не вшила отпечаток');
  return match[1];
}
