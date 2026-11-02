// Склеивает части в одну closure. Изменение метаданных может создать новую
// установку и новое хранилище; см. порядок переноса в INSTALL.md.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUserscriptVersionContract } from './version-oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const header = '00-header.js';
const parts = [
  '01-config.js', '02-profiles-core.js', '03-utils.js', '04-notifications.js', '05-debug.js',
  '06-pause-panel.js', '07-connections-ui.js', '08-projects-ui.js', '09-ntfy-ui.js', '10-github-ui.js',
  '11-http-gateway.js', '12-notion.js', '13-arena-messages.js', '14-missing-marker.js', '15-visible-errors.js',
  '16-arena-send.js', '17-arena-polls.js', '18-state-recovery.js', '19-pull-requests.js',
  '20-technical-context.js', '21-prompts.js', '22-executor.js', '23-coordinator.js', '24-feedback.js',
  '25-legacy-adr.js', '26-review.js', '27-review-answers.js', '28-cycle.js', '29-boot.js',
];
const read = (name) => readFile(join(here, 'src', name), 'utf8');
const source = (await read(header)) + '\n((GM_getValue, GM_setValue) => {\n  "use strict";\n\n' +
  (await Promise.all(parts.map(read))).join('\n') + '})(GM_getValue, GM_setValue);\n';
assertUserscriptVersionContract(source);
const output = join(here, 'relay.user.js');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node build.mjs [--check]');
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (source !== current) {
    console.error('relay.user.js устарел: выполните node _tools/ScriptCat/build.mjs');
    process.exitCode = 1;
  } else console.log(`ScriptCat bundle соответствует ${parts.length + 1} исходным файлам.`);
} else {
  await writeFile(output, source, 'utf8');
  console.log(`Собран ${output} из ${parts.length + 1} исходных файлов.`);
}
