// Proper-noun correction: find places where a name was probably mis-heard, for the user to confirm one by one.
// Nothing is replaced automatically: candidates are listed, the user checks them (with the sound) and applies.
import { STOP, BASIC } from './studio-words.js';

const lower = (w) => w.toLowerCase().replace(/[’]/g, "'");
// rough sound key: first letter + consonant skeleton (similar sounds merged)
export function soundKey(w) {
  let s = lower(w).replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/ph/g, 'f').replace(/gh/g, 'g').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/x/g, 'ks').replace(/th/g, 't').replace(/sh/g, 's').replace(/ch/g, 'k');
  const head = s[0].replace(/[aeiouy]/, 'a');
  const body = s.slice(1).replace(/[cqk]/g, 'k').replace(/[sz]/g, 's').replace(/[dt]/g, 't').replace(/[bp]/g, 'p').replace(/[fv]/g, 'f').replace(/[gj]/g, 'g').replace(/[mn]/g, 'n').replace(/[aeiouyhw]/g, '');
  return (head + body).replace(/(.)\1+/g, '$1');
}
export function editDistance(a, b) {
  a = lower(a); b = lower(b);
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// is word w a plausible mis-hearing of name?
export function looksLike(w, name) {
  const a = lower(w).replace(/[^a-z]/g, ''), b = lower(name).replace(/[^a-z]/g, '');
  if (!a || !b || a === b) return false;
  if (a.length < 3 && b.length > 3) return false;
  const dist = editDistance(a, b), L = Math.max(a.length, b.length);
  if (dist / L <= 0.34) return true;
  const ka = soundKey(a), kb = soundKey(b);
  return ka.length >= 2 && ka === kb && Math.abs(a.length - b.length) <= 3;
}
const WORD = /[A-Za-z][A-Za-z'’-]*/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// items: [{ id, text }], name: correct spelling, variants: known wrong spellings (may be several words)
// returns [{ id, s, e, word, kind: 'variant'|'similar', checked }]   (s/e: character positions in text)
export function findCandidates(items, name, variants = []) {
  name = name.trim(); if (!name) return [];
  const vs = [...new Set(variants.map((v) => v.trim()).filter((v) => v && lower(v) !== lower(name)))];
  const nameWords = name.split(/\s+/).length;
  const out = [];
  for (const it of items) {
    const text = it.text || ''; const taken = [];
    const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
    // 1) registered wrong spellings (whole words, any case)
    for (const v of vs) {
      const re = new RegExp(`(?<![A-Za-z'’])${esc(v).replace(/\s+/g, '\\s+')}(?![A-Za-z])`, 'gi');
      for (const m of text.matchAll(re)) { const s = m.index, e = s + m[0].length; if (overlaps(s, e)) continue; taken.push([s, e]); out.push({ id: it.id, s, e, word: m[0], kind: 'variant', checked: true }); }
    }
    // 2) similar-looking / sounding single words (only for one-word names)
    if (nameWords === 1) {
      for (const m of text.matchAll(WORD)) {
        let w = m[0].replace(/['’]s$/i, '').replace(/[-'’]+$/, ''); const s = m.index, e = s + w.length;
        if (!w || overlaps(s, e) || !looksLike(w, name)) continue;
        const lw = lower(w), cap = /^[A-Z]/.test(w);
        const startOfSentence = /(^|[.!?]["”’)]?\s+)$/.test(text.slice(0, s));
        const common = STOP.has(lw) || BASIC.has(lw);
        // checked by default only when it looks like a name (capitalised mid-sentence, or capitalised and not a common word)
        const checked = cap && !common && (!startOfSentence || lw.length > 2);
        taken.push([s, e]); out.push({ id: it.id, s, e, word: w, kind: 'similar', checked });
      }
    }
  }
  return out;
}
// replace the chosen spans (of one text) with name
export function applySpans(text, spans, name) {
  return [...spans].sort((a, b) => b.s - a.s).reduce((t, x) => t.slice(0, x.s) + name + t.slice(x.e), text);
}
