// Mastery: one record per (word, skill). Bookmark is NOT here (it lives on the word).
import { db } from './db.js';

export const SKILLS = ['recognition', 'recall', 'listening', 'spelling'];
export const SKILL_LABELS = { recognition: '英→日', recall: '日→英', listening: '音声→意味', spelling: 'スペル' };
export const LEVEL_LABELS = { 1: '未習得', 2: '苦手', 3: '学習中', 4: 'ほぼ習得', 5: '習得済み' };

export const mid = (wordId, skill) => `${wordId}:${skill}`;

export function emptyMastery(wordId, skill) {
  return {
    id: mid(wordId, skill), wordId, skill,
    autoLevel: 0, autoAt: null,          // 0 = 未評価/判定保留
    manualLevel: null, manualAt: null, locked: false,
    stats: { attempts: 0, correct: 0, streak: 0, recent: [], avgMs: null, hints: 0, lastAt: null },
  };
}

// Effective level of one skill record.
// - locked manual always wins
// - otherwise the newer of manual / auto wins; a "pending" auto (0) never overrides a manual value
export function effLevel(m) {
  if (!m) return 0;
  if (m.manualLevel != null) {
    if (m.locked) return m.manualLevel;
    if (!m.autoLevel || (m.manualAt || 0) > (m.autoAt || 0)) return m.manualLevel;
  }
  return m.autoLevel || 0;
}

// status: 'unrated' (no attempts) | 'pending' (1-2 attempts, no auto yet) | 'rated'
export function status(m) {
  if (!m || !m.stats?.attempts) return 'unrated';
  return m.autoLevel ? 'rated' : 'pending';
}

export function source(m) {
  if (!m) return 'none';
  if (m.manualLevel != null) {
    if (m.locked) return 'locked';
    if (!m.autoLevel || (m.manualAt || 0) > (m.autoAt || 0)) return 'manual';
  }
  return m.autoLevel ? 'auto' : 'none';
}

// Overall = the LOWEST effective level among skills that have a level (no averaging).
export function overall(records) {
  const lv = SKILLS.map((s) => effLevel(records?.[s])).filter((x) => x > 0);
  if (!lv.length) return { level: 0, min: 0, avg: null };
  return { level: Math.min(...lv), min: Math.min(...lv), avg: lv.reduce((a, b) => a + b, 0) / lv.length };
}

// For filters: level 0 (未評価・判定保留) is treated as 1 (未習得)
export const filterLevel = (lv) => (lv > 0 ? lv : 1);

export function levelText(lv, recordsOrStatus) {
  if (lv > 0) return LEVEL_LABELS[lv];
  const st = typeof recordsOrStatus === 'string' ? recordsOrStatus : anyAttempts(recordsOrStatus) ? 'pending' : 'unrated';
  return st === 'pending' ? '判定保留' : '未評価';
}
function anyAttempts(records) { return SKILLS.some((s) => records?.[s]?.stats?.attempts > 0); }

// Map: wordId -> { skill: record }
export async function loadAllMastery() {
  const map = {};
  for (const m of await db.all('mastery')) (map[m.wordId] ||= {})[m.skill] = m;
  return map;
}
export async function loadWordMastery(wordId) {
  const out = {};
  for (const m of await db.byIndex('mastery', 'wordId', wordId)) out[m.skill] = m;
  return out;
}

// Manual change (keeps history). lock: true = 手動固定, false = 次の自動判定で上書きされる
export async function setManual(wordId, skills, level, { lock = false, reason = 'manual' } = {}) {
  const now = Date.now();
  const recs = [], hist = [];
  for (const skill of skills) {
    const m = (await db.get('mastery', mid(wordId, skill))) || emptyMastery(wordId, skill);
    const from = effLevel(m);
    m.manualLevel = level; m.manualAt = now; m.locked = !!lock;
    recs.push(m);
    hist.push({ wordId, skill, from, to: level, locked: !!lock, reason, at: now });
  }
  await db.putMany('mastery', recs);
  await db.putMany('masteryChanges', hist);
}

export async function setLock(wordId, skill, locked) {
  const m = (await db.get('mastery', mid(wordId, skill))) || emptyMastery(wordId, skill);
  if (locked && m.manualLevel == null) { m.manualLevel = effLevel(m) || 1; m.manualAt = Date.now(); }
  m.locked = locked;
  await db.put('mastery', m);
  await db.put('masteryChanges', { wordId, skill, from: effLevel(m), to: m.manualLevel, locked, reason: locked ? 'lock' : 'unlock', at: Date.now() });
}

export async function resetToAuto(wordId, skill) {
  const m = await db.get('mastery', mid(wordId, skill));
  if (!m) return;
  const from = effLevel(m);
  m.manualLevel = null; m.manualAt = null; m.locked = false;
  await db.put('mastery', m);
  await db.put('masteryChanges', { wordId, skill, from, to: m.autoLevel || 0, locked: false, reason: 'auto', at: Date.now() });
}
