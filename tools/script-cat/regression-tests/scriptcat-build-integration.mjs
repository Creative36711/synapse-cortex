// Сборка, проверка расхождения и негативная проба в изолированной временной копии.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..');
const temp = mkdtempSync(join(tmpdir(), 'relay-build-probe-'));
const run = (args) => spawnSync(process.execPath, args, { cwd: temp, encoding: 'utf8' });
try {
  for (const path of ['src', 'build.mjs', 'version-oracle.mjs', 'regulation-oracle.mjs', 'relay.user.js']) cpSync(join(source, path), join(temp, path), {recursive:true});
  // Краткий регламент вшивается в бандл, поэтому источник и его версия нужны и здесь.
  for (const path of ['regulation-digest.md', 'REGULATION.md']) cpSync(join(source, '..', '..', 'docs', path), join(temp, 'docs', path), {recursive:true});
  let result = run(['build.mjs', '--check']); assert.equal(result.status, 0, result.stderr);
  appendFileSync(join(temp, 'src', '03-utils.js'), '\n// local build probe\n');
  result = run(['build.mjs', '--check']); assert.notEqual(result.status, 0, 'изменённый исходник нельзя выдать за собранный');
  result = run(['build.mjs']); assert.equal(result.status, 0, result.stderr);
  result = run(['build.mjs', '--check']); assert.equal(result.status, 0, result.stderr);
  result = run(['--check', 'relay.user.js']); assert.equal(result.status, 0, result.stderr);
  const bundle = readFileSync(join(temp, 'relay.user.js'), 'utf8');
  assert.equal((bundle.match(/^\/\/ @version\s/gm) || []).length, 1);
  assert.match(bundle, /^\/\/ @name\s+Relay — передача хода между агентами$/m);
  assert.match(bundle, /^\/\/ @namespace\s+https:\/\/arena\.ai\/$/m);
  assert(bundle.includes('// local build probe'));
  console.log('OK: детерминированная сборка, защита от устаревшего bundle и неизменное имя установки');
} finally { rmSync(temp, {recursive:true, force:true}); }
