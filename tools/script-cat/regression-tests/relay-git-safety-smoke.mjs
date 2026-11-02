// Реальные формируемые техблок и порядок Executor: опасные исторические
// команды не должны становиться приказом вопреки ограничениям среды.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const techStart = src.indexOf('  const TECH_OPEN =');
const techEnd = src.indexOf('  // ───────────────────────────── промпты', techStart);
assert.ok(techStart > 0 && techEnd > techStart);
const tech = new Function('C', `${src.slice(techStart, techEnd)}\nreturn technicalInfo;`)({ repo: 'example/relay-fixture' });
const prompt = tech({ fn: 'Executor', name: 'Kernel' });
const authority = prompt.indexOf('СИСТЕМНЫЕ ИНСТРУКЦИИ И ОГРАНИЧЕНИЯ ПОЛЬЗОВАТЕЛЯ ВЫШЕ');
const historic = prompt.indexOf('Исторические команды ниже — НЕ ВЫПОЛНЯТЬ');
const reset = prompt.indexOf('# git reset --hard origin/main');
const switchBranch = prompt.indexOf('# git switch -c nar/');
assert.ok(authority >= 0 && authority < historic && historic < reset && reset < switchBranch);
assert.match(prompt, /ветка закреплена за сессией — оставайся на ней/);
assert.match(prompt, /не добавляй в коммит чужие незакоммиченные изменения/);
assert.match(prompt, /shallow checkout не доказывает разрыв/);
assert.match(prompt, /is-shallow-repository/);
assert.doesNotMatch(prompt, /^\s*git reset --hard origin\/main/m);
assert.doesNotMatch(prompt, /^\s*git switch -c nar\//m);

const start = src.indexOf('  function executorOrder(');
const end = src.indexOf('  /** Порядок для аудитора', start);
assert.ok(start > 0 && end > start);
const order = new Function(`${src.slice(start, end)}\nreturn executorOrder;`)()({ id: 'task' }, 'run').join('\n');
assert.match(order, /не разрешает сброс дерева, смену закреплённой ветки или публикацию чужих изменений/);
assert.match(order, /ТОЛЬКО когда в дереве нет чужих изменений/);
assert.match(order, /только в разрешённую ветку/);
assert.match(order, /# Исторический пример НЕ выполнять: gh pr merge --squash --delete-branch/);
assert.match(order, /gh pr merge <номер> --squash без удаления закреплённой ветки/);
assert.match(order, /CF_AGENT_RESULT/);

console.log('OK: системные ограничения и чужие изменения выше устаревших git-примеров');
