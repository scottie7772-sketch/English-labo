// Spaced repetition (simplified SM-2). One schedule per learning item (wordId / puzzle id ...),
// separate from mastery. Stored in the existing `reviews` store (no DB migration).
import { db } from './db.js';

const DAY = 86400000;
export const SRS_RULES = {
  firstGood: 1, secondGood: 3,   // days
  againDays: 0.007,              // ~10 min: again in the same day
  hardFactor: 1.2, easyBonus: 1.3,
  easeMin: 1.3, easeStart: 2.5, maxDays: 180,
};
export const QUALITY_JA = { again: 'もう一度', hard: '難しい', good: '正解', easy: '簡単' };

export function emptyReview(id, extra = {}) {
  return { id, wordId: id, due: Date.now(), intervalDays: 0, ease: SRS_RULES.easeStart, reps: 0, lapses: 0, lastAt: null, lastQuality: null, lastFormat: null, manualDue: false, ...extra };
}

// quality: 'again' | 'hard' | 'good' | 'easy'
export function schedule(r, quality, at = Date.now(), format = null) {
  const R = SRS_RULES;
  let iv = r.intervalDays || 0;
  if (quality === 'again') {
    r.lapses = (r.lapses || 0) + (r.reps ? 1 : 0); r.reps = 0; iv = R.againDays; r.ease = Math.max(R.easeMin, r.ease - 0.2);
  } else {
    r.reps = (r.reps || 0) + 1;
    if (quality === 'hard') { iv = r.reps === 1 ? R.firstGood : Math.max(1, iv * R.hardFactor); r.ease = Math.max(R.easeMin, r.ease - 0.15); }
    else {
      iv = r.reps === 1 ? R.firstGood : r.reps === 2 ? R.secondGood : iv * r.ease;
      if (quality === 'easy') { iv *= R.easyBonus; r.ease += 0.15; }
    }
  }
  r.intervalDays = Math.min(R.maxDays, Math.round(iv * 1000) / 1000);
  r.due = at + r.intervalDays * DAY;
  r.lastAt = at; r.lastQuality = quality; r.manualDue = false;
  if (format) r.lastFormat = format;
  return r;
}

// quality from one answer (same answer data that mastery uses)
export function qualityOf(results, { ms = 0, self = false, grade = null, near = false } = {}) {
  if (grade === 'dont' || results.some((r) => !r.correct)) return 'again';
  if (grade === 'vague' || near || results.some((r) => r.hint)) return 'hard';
  if (!self && ms && ms < 3500) return 'easy';
  return 'good';
}

export async function dueList({ lang = null, kinds = null, at = Date.now() } = {}) {
  return (await db.all('reviews')).filter((r) => r.reps != null && r.due <= at && (!lang || (r.lang || 'en') === lang) && (!kinds || kinds.includes(r.kind || 'word')));
}
export async function setDue(id, ts, extra = {}) {
  const r = (await db.get('reviews', id)) || emptyReview(id, extra);
  r.due = ts; r.manualDue = true; await db.put('reviews', r); return r;
}
