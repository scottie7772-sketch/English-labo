// Answer recording + automatic mastery judgment (explicit, adjustable rules)
import { db } from './db.js';
import { emptyMastery, effLevel, mid } from './mastery.js';

// All thresholds in one place (Phase 4 will expose these in Settings)
export const RULES = {
  minAttempts: 3,          // fewer answers -> 判定保留 (autoLevel 0)
  window: 10,              // recent answers used for accuracy
  hintWeight: 0.5,         // correct with hint counts as 0.5
  slowWeight: 0.75,        // correct but slow counts as 0.75
  slowMs: { typing: 12000, choice: 7000, flash: 8000 },
  spacedDays: 7,           // Level 5 needs a correct answer after a gap of >= 7 days
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
  const p = r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0;
  for (const rule of RULES.levels) {
    if (p < rule.minP) continue;
    if (rule.minStreak && (stats.streak || 0) < rule.minStreak) continue;
    if (rule.needSpaced && !stats.spacedOK) continue;
    return rule.level;
  }
  return 1;
}

// Update one skill record with one answer. Returns {before, after}
function applyAnswer(m, { correct, hint, ms, format, at }) {
  const s = m.stats;
  const before = effLevel(m);
  const gapDays = s.lastAt ? (at - s.lastAt) / 86400000 : 0;
  const slow = ms > (RULES.slowMs[format] || 10000);
  const w = correct ? (hint ? RULES.hintWeight : slow ? RULES.slowWeight : 1) : 0;
  s.attempts = (s.attempts || 0) + 1;
  if (correct) s.correct = (s.correct || 0) + 1;
  s.streak = correct && !hint ? (s.streak || 0) + 1 : 0;
  s.recent = [...(s.recent || []), w].slice(-RULES.window);
  s.avgMs = s.avgMs ? Math.round(s.avgMs * 0.7 + ms * 0.3) : ms;
  if (hint) s.hints = (s.hints || 0) + 1;
  if (correct && !hint && gapDays >= RULES.spacedDays) s.spacedOK = true;
  if (!correct) s.spacedOK = false;
  s.lastAt = at;
  const lv = judge(s);
  if (lv !== m.autoLevel) { m.autoLevel = lv; m.autoAt = at; }
  else if (lv) m.autoAt = at; // re-confirmed by data: auto value is newest again
  return { before, after: effLevel(m) };
}

// results: [{skill, correct, hint}] for one question. Writes mastery + attempts atomically.
export async function recordAnswer({ sessionId, qid, wordId, direction, format, prompt, answer, ms, results }) {
  const at = Date.now();
  const out = {}, recs = [], atts = [];
  // read first, then write synchronously in one transaction (safe on iOS Safari)
  for (const r of results) {
    const rec = (await db.get('mastery', mid(wordId, r.skill))) || emptyMastery(wordId, r.skill);
    const { before, after } = applyAnswer(rec, { correct: r.correct, hint: r.hint, ms, format, at });
    recs.push(rec);
    atts.push({ sessionId, qid, wordId, skill: r.skill, direction, format, mode: 'vocab-test', prompt, answer, correct: r.correct, ms, hint: !!r.hint, levelBefore: before, levelAfter: after, at });
    out[r.skill] = { before, after };
  }
  await db.tx(['mastery', 'attempts'], 'readwrite', (t) => {
    recs.forEach((r) => t.objectStore('mastery').put(r));
    atts.forEach((a) => t.objectStore('attempts').add(a));
  });
  return out;
}
