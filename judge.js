// Answer recording + automatic mastery judgment (explicit, adjustable rules)
import { db } from './db.js';
import { emptyMastery, effLevel, mid } from './mastery.js';

// All thresholds in one place (Phase 4 will expose these in Settings)
export const RULES = {
  minAttempts: 3,          // fewer answers -> 判定保留 (autoLevel 0)
  window: 10,              // recent answers used for accuracy
  hintWeight: 0.5,         // correct with hint counts as 0.5
  slowWeight: 0.75,        // correct but slow counts as 0.75
  slowMs: { typing: 12000, choice: 7000, flash: 8000, swipe: 6000 },
  spacedDays: 7,           // Level 5 needs a correct answer after a gap of >= 7 days
  selfRevealedWeight: 0.8, // 答えを見てから「わかる」(記録は区別。重みは同じ：答え合わせは通常の使い方なので減点しない。ここで調整可)
  vagueWeight: 0.4,        // 「曖昧」= 部分的に正解扱い（連続正答はリセット）
  selfWeight: 0.8,         // self-report "覚えている" (Quick Flashcards) counts as 0.8 -> self-report alone tops out at Level 4
  levels: [                // checked top to bottom
    { level: 5, minP: 0.9, minStreak: 4, needSpaced: true },
    { level: 4, minP: 0.8, minStreak: 3 },
    { level: 3, minP: 0.6 },
    { level: 2, minP: 0.3 },
    { level: 1, minP: 0 },
  ],
};

export function judge(stats) {
  if ((stats.attempts || 0) < RULES.minAttempts) return 0;
  const r = stats.recent || [];
  const p = r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 1000) / 1000 : 0;
  for (const rule of RULES.levels) {
    if (p < rule.minP) continue;
    if (rule.minStreak && (stats.streak || 0) < rule.minStreak) continue;
    if (rule.needSpaced && !stats.spacedOK) continue;
    return rule.level;
  }
  return 1;
}

// Update one skill record with one answer. Returns {before, after}
function applyAnswer(m, { correct, hint, ms, format, at, self, revealed, grade }) {
  const s = m.stats;
  const before = effLevel(m);
  const gapDays = s.lastAt ? (at - s.lastAt) / 86400000 : 0;
  const slow = ms > (RULES.slowMs[format] || 10000);
  let w = correct ? (hint ? RULES.hintWeight : slow ? RULES.slowWeight : 1) : 0;
  if (self && correct) w = Math.min(w, revealed ? RULES.selfRevealedWeight : RULES.selfWeight);
  if (grade === 'vague') w = RULES.vagueWeight;
  s.attempts = (s.attempts || 0) + 1;
  if (correct && grade !== 'vague') s.correct = (s.correct || 0) + 1;
  if (grade === 'vague') s.vague = (s.vague || 0) + 1;
  s.streak = correct && !hint ? (s.streak || 0) + 1 : 0;
  s.recent = [...(s.recent || []), w].slice(-RULES.window);
  s.avgMs = s.avgMs ? Math.round(s.avgMs * 0.7 + ms * 0.3) : ms;
  if (hint) s.hints = (s.hints || 0) + 1;
  if (self) s.selfCount = (s.selfCount || 0) + 1;
  if (correct && !hint && gapDays >= RULES.spacedDays) s.spacedOK = true;
  if (!correct) s.spacedOK = false;
  s.lastAt = at;
  const lv = judge(s);
  if (lv !== m.autoLevel) { m.autoLevel = lv; m.autoAt = at; }
  else if (lv) m.autoAt = at; // re-confirmed by data: auto value is newest again
  return { before, after: effLevel(m) };
}

// results: [{skill, correct, hint}] for one question. Writes mastery + attempts atomically.
export async function recordAnswer({ sessionId, qid, wordId, direction, format, prompt, answer, ms, results, mode = 'vocab-test', self = false, revealed = null, grade = null }) {
  const at = Date.now();
  const out = {}, recs = [], atts = [];
  // read first, then write synchronously in one transaction (safe on iOS Safari)
  for (const r of results) {
    const rec = (await db.get('mastery', mid(wordId, r.skill))) || emptyMastery(wordId, r.skill);
    const { before, after } = applyAnswer(rec, { correct: r.correct, hint: r.hint, ms, format, at, self, revealed, grade });
    recs.push(rec);
    atts.push({ sessionId, qid, wordId, skill: r.skill, direction, format, mode, self, revealed, grade, prompt, answer, correct: r.correct, ms, hint: !!r.hint, levelBefore: before, levelAfter: after, at });
    out[r.skill] = { before, after };
  }
  const attemptIds = [];
  await db.tx(['mastery', 'attempts'], 'readwrite', (t) => {
    recs.forEach((r) => t.objectStore('mastery').put(r));
    atts.forEach((a) => { const q = t.objectStore('attempts').add(a); q.onsuccess = () => attemptIds.push(q.result); });
  });
  Object.defineProperty(out, '_attemptIds', { value: attemptIds });
  return out;
}

// Undo support: restore mastery snapshots and remove the attempts written for one answer
export async function snapshotMastery(wordId, skills) {
  const snap = {};
  for (const s of skills) snap[s] = (await db.get('mastery', mid(wordId, s))) || null;
  return structuredClone(snap);
}
export async function undoAnswer(wordId, snap, attemptIds) {
  await db.tx(['mastery', 'attempts'], 'readwrite', (t) => {
    for (const [skill, rec] of Object.entries(snap)) {
      if (rec) t.objectStore('mastery').put(rec); else t.objectStore('mastery').delete(mid(wordId, skill));
    }
    for (const id of attemptIds || []) t.objectStore('attempts').delete(id);
  });
}
