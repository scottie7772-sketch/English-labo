// Small progress figures for the home screen (kept apart from lesson.js so the home screen loads less code)
import { db, attemptDays } from './db.js';
import { curLang, langOf } from './langs.js';

export async function lessonStats(lang = curLang()) {
  const [words, revs] = await Promise.all([db.all('words'), db.all('reviews')]);
  const ids = new Set(words.filter((w) => langOf(w) === lang).map((w) => w.id));
  const now = Date.now();
  const mine = revs.filter((r) => (r.lang || 'en') === lang && (r.kind === 'word' || !r.kind ? ids.has(r.id) : true) && r.kind !== 'speaking' && r.kind !== 'listening');
  return { due: mine.filter((r) => r.due <= now).length, scheduled: mine.length, fresh: (() => { const has = new Set(revs.map((r) => r.id)); return [...ids].filter((id) => !has.has(id)).length; })() };
}
export async function streakDays() {
  const { days } = await attemptDays();
  let n = 0; const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);   // today not yet studied: count up to yesterday
  while (days.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1); }
  return { n, today: days.has(new Date().toDateString()) };
}
