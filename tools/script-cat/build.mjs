// Склеивает части в одну closure. Изменение метаданных может создать новую
// установку и новое хранилище; см. порядок переноса в INSTALL.md.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUserscriptVersionContract } from './version-oracle.mjs';
import { assertDigestVersionMatches, inlineDigest, normalizeDigest } from './regulation-oracle.mjs';
import { assertPromptCoverage } from './coverage-oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const header = '00-header.js';
const parts = [
  '01-config.js', '02-profiles-core.js', '03-utils.js', '04-notifications.js', '05-debug.js',
  '06-pause-panel.js', '07-connections-ui.js', '08-projects-ui.js', '09-ntfy-ui.js', '10-github-ui.js',
  '11-http-gateway.js', '12-notion.js', '13-arena-messages.js', '14-missing-marker.js', '15-visible-errors.js',
  '16-arena-send.js', '17-arena-polls.js', '18-state-recovery.js', '19-pull-requests.js',
  'prompt-marker-registry.js', 'prompt-blocks.js', 'prompt-profiles.js', 'prompt-compiler.js',
  '20-technical-context.js', '21-prompts.js', '22-executor.js', '23-coordinator.js', '24-feedback.js',
  '25-legacy-adr.js', '26-review.js', '26b-arbiter.js', '27-review-answers.js', 'pilot-transport.js', '30-tool-limit.js',
  '31-provision-core.js', '32-provision-dom.js', '33-provision-flow.js', '34-provision-ui.js',
  '28-cycle.js', '29-boot.js',
];
const read = (name) => readFile(join(here, 'src', name), 'utf8');
// Каталог docs ищем вверх от комплекта: так сборка работает и в репозитории,
// и в изолированной временной копии, где docs лежит рядом с build.mjs.
const findDocs = () => {
  let dir = here;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'docs');
    if (existsSync(join(candidate, 'regulation-digest.md'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('docs/regulation-digest.md не найден: сборка без краткого регламента невозможна');
};
const docs = findDocs();
const digest = normalizeDigest(await readFile(join(docs, 'regulation-digest.md'), 'utf8'));
assertDigestVersionMatches(digest, await readFile(join(docs, 'REGULATION.md'), 'utf8'));
const source = inlineDigest(
  (await read(header)) + '\n((GM_getValue, GM_setValue) => {\n  "use strict";\n\n' +
    (await Promise.all(parts.map(read))).join('\n') + '})(GM_getValue, GM_setValue);\n',
  digest,
);
assertUserscriptVersionContract(source);

// Coverage-оракул: ruleId → block → profiles. Падает, если правило регламента
// потерялось при сжатии блоков или профиль не несёт обязательное для роли правило.
const contract = JSON.parse(await readFile(join(here, 'contracts', 'agent-protocol.json'), 'utf8'));
const coverage = assertPromptCoverage({
  blocksSource: await read('prompt-blocks.js'),
  profilesSource: await read('prompt-profiles.js'),
  contract,
});
const coverageMap = {
  protocolVersion: contract.protocolVersion,
  roleProfile: coverage.roleProfile || { Executor: 'executor.card', Auditor: 'auditor.card', Coordinator: 'coordinator.plan', Reviewer: 'reviewer.mission' },
  ruleToBlocks: Object.fromEntries(Object.entries(coverage.ruleToBlocks).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()])),
  profileRules: Object.fromEntries(Object.entries(coverage.profileRules).sort(([a], [b]) => a.localeCompare(b))),
  // Git-границы и аудитория профилей: compact/recovery/continuation проверяются
  // не только по маркеру, но и по отсутствию git-write блоков и по роли.
  profileAudience: Object.fromEntries(Object.entries(coverage.profileAudience).sort(([a], [b]) => a.localeCompare(b))),
  profileGitWrite: Object.fromEntries(Object.entries(coverage.profileGitWrite).sort(([a], [b]) => a.localeCompare(b))),
};
const coverageJson = JSON.stringify(coverageMap, null, 2) + '\n';
const coveragePath = join(here, 'contracts', 'prompt-coverage.json');

const output = join(here, 'relay.user.js');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node build.mjs [--check]');
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (source !== current) {
    console.error('relay.user.js устарел: выполните node _tools/ScriptCat/build.mjs');
    process.exitCode = 1;
  } else console.log(`ScriptCat bundle соответствует ${parts.length + 1} исходным файлам.`);
  const currentCoverage = existsSync(coveragePath) ? await readFile(coveragePath, 'utf8') : '';
  if (coverageJson !== currentCoverage) {
    console.error('contracts/prompt-coverage.json устарел: выполните node build.mjs');
    process.exitCode = 1;
  } else console.log(`Coverage: ${Object.keys(coverageMap.ruleToBlocks).length} ruleId покрыты блоками и профилями.`);
} else {
  await writeFile(output, source, 'utf8');
  await writeFile(coveragePath, coverageJson, 'utf8');
  console.log(`Собран ${output} из ${parts.length + 1} исходных файлов.`);
  console.log(`Coverage: ${Object.keys(coverageMap.ruleToBlocks).length} ruleId → blocks → profiles записан в contracts/prompt-coverage.json.`);
}
