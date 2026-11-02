import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findPortableNameLeaks} from '../portability-guard.mjs';
const root = mkdtempSync(join(tmpdir(), 'relay-portability-'));
try {
  writeFileSync(join(root, 'ok.md'), 'Переносимое руководство');
  assert.deepEqual(findPortableNameLeaks(root), []);
  const forbidden = ['nar','thex'].join('');
  mkdirSync(join(root, `old-${forbidden.toUpperCase()}`));
  writeFileSync(join(root, 'bad.md'), `A ${forbidden.toUpperCase()} B`);
  const hits = findPortableNameLeaks(root);
  assert(hits.some((hit) => hit.endsWith(': имя')));
  assert(hits.some((hit) => hit === 'bad.md:1: текст'));
} finally { rmSync(root, {recursive:true, force:true}); }
console.log('OK: portability guard detects names and case-insensitive text');
