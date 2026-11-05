// Строка-шим для старых тестов, которые вырезают куски relay.user.js и
// вычисляют их: добавляет декларативный конструктор и адаптерные хелперы,
// чтобы executorPrompt/coordinatorPrompt/answerPrompt работали в песочнице.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');
const modules = ['prompt-marker-registry.js', 'prompt-blocks.js', 'prompt-profiles.js', 'prompt-compiler.js']
  .map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');

export const promptShim = `${modules}
  const promptRole = (r) => ({ id: r?.id || "", name: r?.name || "", fn: r?.fn || "", repo: r?.repo || "", zone: r?.zone || "", gate: r?.gate || "" });
  const promptTarget = (ctx = {}) => ({ repo: ctx.repo || (typeof C !== "undefined" && C.repo) || "", baseBranch: ctx.branch || (typeof C !== "undefined" && C.branch) || "main", startSha: ctx.startSha || "" });
  function compileOrPause(req, label) { const r = PromptCompiler.compile(req); if (r.ok) return r; if (typeof pause === "function") pause((r.error && r.error.message) || label); return null; }
  function recordPromptAttempt() {}
  function journalDelivery() {}
  function recordDeliveryReceipt() {}
  function forgetDeliveryReceipt() {}
  function classifyArenaFailure() { return "unknown"; }
`;
