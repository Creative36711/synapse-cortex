// Оракул краткой версии регламента.
//
// Зачем: с 1.8.0 транспорт вшивает краткий регламент прямо в промпт, чтобы агент
// получал правила вместе с заданием, а не отдельным чтением страницы Notion.
// Вшитый текст — копия `docs/regulation-digest.md`, и копия обязана совпадать с
// источником: устаревшая копия в бандле опаснее её отсутствия, потому что агент
// читает правила и не знает, что они старые.
//
// Три источника сверяются между собой:
//   1. `docs/regulation-digest.md` — источник текста;
//   2. `docs/REGULATION.md` — источник версии (шапка «Версия 1.2»);
//   3. `relay.user.js` — то, что реально достанется агенту.

import { strict as assert } from 'node:assert';

/** Плейсхолдер в `src/01-config.js`; сборка заменяет его текстом регламента. */
export const DIGEST_PLACEHOLDER = '"@@REGULATION_DIGEST@@"';

/** Предел объёма: краткая версия — вход хода, а не справочник. */
export const DIGEST_MAX_CHARS = 9000;

const VERSION_LINE = /Версия\s+(\d+\.\d+)/;

/** Маркер, после которого начинаются служебные заметки: в промпт они не идут. */
export const DIGEST_META_MARKER = '<!-- build:meta -->';

/** Текст для промпта: всё до маркера служебных заметок. */
export function promptDigest(markdown) {
  const source = String(markdown || '').replace(/\r\n/g, '\n');
  const at = source.indexOf(DIGEST_META_MARKER);
  return (at === -1 ? source : source.slice(0, at)).trim();
}

export function normalizeDigest(markdown) {
  const text = promptDigest(markdown);
  assert.ok(text.length > 0, 'краткая версия регламента не может быть пустой');
  assert.ok(
    text.length <= DIGEST_MAX_CHARS,
    `краткая версия регламента ${text.length} знаков при пределе ${DIGEST_MAX_CHARS}: вход хода обязан оставаться коротким`,
  );
  return text;
}

export function digestVersion(markdown) {
  const match = String(markdown || '').match(VERSION_LINE);
  assert.ok(match, 'в тексте регламента нет строки «Версия N.N»');
  return match[1];
}

/** Версия краткой копии должна совпадать с версией полного регламента. */
export function assertDigestVersionMatches(digest, regulation) {
  const short = digestVersion(digest);
  const full = digestVersion(regulation);
  assert.equal(
    short,
    full,
    `краткая версия регламента (${short}) отстала от полной (${full}): обновите docs/regulation-digest.md`,
  );
  return short;
}

/** Подставить текст регламента в исходник транспорта вместо плейсхолдера. */
export function inlineDigest(source, markdown) {
  const count = source.split(DIGEST_PLACEHOLDER).length - 1;
  assert.equal(count, 1, 'в исходниках транспорта должен быть ровно один плейсхолдер краткого регламента');
  return source.replace(DIGEST_PLACEHOLDER, JSON.stringify(normalizeDigest(markdown)));
}

/** Прочитать вшитый текст обратно из бандла (для проверок и проб). */
export function readEmbeddedDigest(source) {
  const match = String(source || '').match(/regulationDigest:\s*("(?:[^"\\]|\\.)*")/);
  assert.ok(match, 'в бандле нет поля regulationDigest: сборка не вшила краткий регламент');
  return JSON.parse(match[1]);
}
