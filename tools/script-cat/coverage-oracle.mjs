// Coverage-оракул регламента: ruleId → block → profiles.
// Гарантирует, что каждое правило регламента (contracts/agent-protocol.json)
// покрыто хотя бы одним блоком, а каждый основной ролевой профиль несёт все
// правила, обязательные для его роли (requiredFor). Сборка падает, если правило
// потерялось при сжатии блоков — «стало короче» не значит «стало правильно».
import { strict as assert } from 'node:assert';

const arr = (spec, key) => {
  const m = spec.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

export function parseBlocks(source) {
  const blocks = {};
  const team = ['Executor', 'Auditor', 'Coordinator', 'Reviewer'];
  for (const m of source.matchAll(/def\("([^"]+)",\s*\{([\s\S]*?)\brender:/g)) {
    const audience = arr(m[2], 'audience');
    blocks[m[1]] = { ruleIds: arr(m[2], 'ruleIds'), audience: audience.length ? audience : team };
  }
  return blocks;
}

export function parseProfiles(source) {
  const profiles = {};
  for (const m of source.matchAll(/def\("([^"]+)",\s*\{([\s\S]*?)\n {4}\}\);/g)) {
    profiles[m[1]] = { blocks: arr(m[2], 'blocks'), audience: arr(m[2], 'audience') };
  }
  return profiles;
}

// Основной профиль, которым роль получает полную выдачу/план/приёмку.
export const ROLE_PROFILE = {
  Executor: 'executor.card',
  Auditor: 'auditor.card',
  Coordinator: 'coordinator.plan',
  Reviewer: 'reviewer.mission',
};

export function buildCoverage({ blocksSource, profilesSource, contract }) {
  const blocks = parseBlocks(blocksSource);
  const profiles = parseProfiles(profilesSource);
  const rules = contract.rules || contract.ruleIds || {};
  const ruleToBlocks = {};
  for (const [id, b] of Object.entries(blocks)) {
    for (const r of b.ruleIds) (ruleToBlocks[r] ||= []).push(id);
  }
  const profileRules = {};
  const profileGitWrite = {};
  const profileAudience = {};
  for (const [id, p] of Object.entries(profiles)) {
    const set = new Set();
    for (const bid of p.blocks) {
      assert.ok(blocks[bid], `профиль ${id} ссылается на несуществующий блок ${bid}`);
      for (const r of blocks[bid].ruleIds) set.add(r);
    }
    profileRules[id] = [...set].sort();
    // Git-границы профиля, а не только маркер: compact/recovery/continuation не
    // должны нести блок записи в git (коммит/push/merge) чужой роли.
    profileGitWrite[id] = p.blocks.filter((bid) => GIT_WRITE_BLOCKS.includes(bid));
    profileAudience[id] = p.audience;
  }
  return { blocks, profiles, rules, ruleToBlocks, profileRules, profileGitWrite, profileAudience };
}

// Блоки, дающие право писать в git (коммит/push/merge). git.auditor — read-only
// проверка, сюда не входит. Полное задание — блоки, запрещённые в continuation.
export const GIT_WRITE_BLOCKS = ['git.executor'];
export const FULL_TASK_BLOCKS = ['task.assignment', 'task.acceptance', 'task.scope', 'task.invariants', 'task.intent', 'task.freedom'];
export const NO_GIT_WRITE_PROFILES = ['delivery.compact', 'coordinator.recovery',
  'continuation.dispatch', 'continuation.plan', 'continuation.review', 'continuation.answer', 'continuation.pilot'];

export function assertPromptCoverage(input) {
  const cov = buildCoverage(input);
  const { rules, ruleToBlocks, profileRules, blocks } = cov;

  // 1. Ни одно правило регламента не осталось без блока.
  for (const ruleId of Object.keys(rules)) {
    assert.ok(ruleToBlocks[ruleId]?.length, `правило ${ruleId} не покрыто ни одним блоком`);
  }
  // 2. Каждый блок ссылается только на известные правила.
  for (const [bid, b] of Object.entries(blocks)) {
    for (const r of b.ruleIds) assert.ok(rules[r], `блок ${bid} ссылается на неизвестное правило ${r}`);
  }
  // 3. Основной ролевой профиль несёт все обязательные для роли правила,
  //    и покрывающий блок действительно адресован этой роли.
  for (const [role, profileId] of Object.entries(ROLE_PROFILE)) {
    const covered = new Set(profileRules[profileId] || []);
    for (const [ruleId, meta] of Object.entries(rules)) {
      if (!(meta.requiredFor || []).includes(role)) continue;
      assert.ok(covered.has(ruleId), `профиль ${profileId} (${role}) не несёт обязательное правило ${ruleId}`);
      const carriers = (ruleToBlocks[ruleId] || []).filter((bid) => (blocks[bid].audience || []).includes(role));
      assert.ok(carriers.length, `правило ${ruleId} для ${role} не покрыто блоком с его аудиторией`);
    }
  }
  // 4. Git-границы compact/recovery/continuation: никакой блок записи в git.
  for (const pid of NO_GIT_WRITE_PROFILES) {
    const p = cov.profiles[pid];
    if (!p) continue;
    const gw = p.blocks.filter((bid) => GIT_WRITE_BLOCKS.includes(bid));
    assert.equal(gw.length, 0, `профиль ${pid} не должен содержать git-write блок: ${gw.join(', ')}`);
  }
  // 5. Continuation не несёт блоков полного задания/очереди/регламента.
  for (const pid of ['continuation.dispatch', 'continuation.plan', 'continuation.review', 'continuation.answer']) {
    const p = cov.profiles[pid];
    if (!p) continue;
    const ft = p.blocks.filter((bid) => FULL_TASK_BLOCKS.includes(bid));
    assert.equal(ft.length, 0, `continuation ${pid} не должен содержать блок полного задания: ${ft.join(', ')}`);
  }
  return cov;
}
