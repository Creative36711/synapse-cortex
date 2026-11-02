#!/usr/bin/env node
// Проверка переносимого комплекта: имена файлов и тексты, без исключений для истории проекта.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {resolve, relative, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const forbidden = ['nar', 'thex'].join('');
const ignoredDirs = new Set(['node_modules', '.git']);

export function findPortableNameLeaks(root, extraFiles = []) {
  const leaks = [];
  const inspect = (path, label, directory = false) => {
    if (label.toLowerCase().includes(forbidden)) leaks.push(`${label}: имя`);
    if (directory) {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const stat = statSync(child);
        if (stat.isDirectory() && ignoredDirs.has(name)) continue;
        inspect(child, `${label}/${name}`, stat.isDirectory());
      }
      return;
    }
    const text = readFileSync(path, 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.toLowerCase().includes(forbidden)) leaks.push(`${label}:${index + 1}: текст`);
    });
  };
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = statSync(path);
    if (stat.isDirectory() && ignoredDirs.has(name)) continue;
    inspect(path, name, stat.isDirectory());
  }
  for (const path of extraFiles) inspect(path, relative(process.cwd(), path), false);
  return leaks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const extra = fileURLToPath(new URL('../../docs/scriptcat-update.md', import.meta.url));
  const leaks = findPortableNameLeaks(root, [extra]);
  if (leaks.length) {
    console.error(`Запрещённые названия в переносимом комплекте:\n${leaks.join('\n')}`);
    process.exitCode = 1;
  } else console.log('OK: переносимый ScriptCat и его руководство не содержат прежнее имя проекта');
}
