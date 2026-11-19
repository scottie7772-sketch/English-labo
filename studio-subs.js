// Studio: subtitle/script parsing, language detection, automatic pairing of media + subtitle files.
import { newId } from './common-idb.js';

const TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const toSec = (t) => { const p = t.replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const clean = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();

export const SUB_EXT = /\.(srt|vtt|txt|csv|tsv)$/i;
export const isJa = (s) => /[぀-ヿ]/.test(s);

// returns { format, cues: [{ id, start, end, text }], timed }
export function parseScript(text, fileName = '') {
  text = String(text).replace(/^﻿/, '').replace(/\r/g, '');
  const ext = (fileName.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  if (TIME.test(text)) {
    const cues = [];
    for (const b of text.split(/\n{2,}/)) {
      const lines = b.split('\n'); const i = lines.findIndex((l) => TIME.test(l)); if (i < 0) continue;
      const m = lines[i].match(TIME); const t = clean(lines.slice(i + 1).join(' '));
      if (t) cues.push({ id: newId('c'), start: toSec(m[1]), end: toSec(m[2]), text: t });
    }
    cues.sort((a, b) => a.start - b.start);
    return { format: ext === 'vtt' || /^WEBVTT/.test(text) ? 'vtt' : 'srt', cues, timed: true };
  }
  if (ext === 'csv' || ext === 'tsv' || /\t/.test(text.split('\n')[0] || '')) return parseTable(text, ext === 'csv' ? ',' : '\t');
  // TXT: one line per item (blank lines ignored)
  const cues = text.split('\n').map((l) => clean(l)).filter(Boolean).map((t) => ({ id: newId('c'), start: null, end: null, text: t }));
  return { format: 'txt', cues, timed: false };
}

function splitCSVLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out.map((x) => x.trim());
}
// CSV/TSV: columns detected by header (en/english/英語, ja/japanese/日本語, start/開始, end/終了) or by content
function parseTable(text, sep) {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => splitCSVLine(l, sep));
  const head = rows[0].map((h) => h.toLowerCase());
  const find = (names) => head.findIndex((h) => names.includes(h));
  let ci = { en: find(['en', 'english', 'text', '英語', '英文', 'script']), ja: find(['ja', 'japanese', '日本語', '和訳', '訳']), start: find(['start', '開始', 'begin', 'in']), end: find(['end', '終了', 'out']) };
  const hasHeader = Object.values(ci).some((i) => i >= 0);
  const body = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) {
    const w = Math.max(...body.map((r) => r.length));
    ci = { en: -1, ja: -1, start: -1, end: -1 };
    for (let c = 0; c < w; c++) {
      const vals = body.map((r) => r[c] || '').filter(Boolean);
      if (vals.every((v) => /^[\d:.,]+$/.test(v))) { if (ci.start < 0) ci.start = c; else if (ci.end < 0) ci.end = c; }
      else if (vals.filter(isJa).length > vals.length / 2) { if (ci.ja < 0) ci.ja = c; }
      else if (ci.en < 0) ci.en = c;
    }
  }
  const t = (v) => (v == null || v === '' ? null : /:/.test(v) ? toSec(v.includes(',') || v.includes('.') ? v : v + '.0') : +v);
  const cues = body.map((r) => ({ id: newId('c'), start: ci.start >= 0 ? t(r[ci.start]) : null, end: ci.end >= 0 ? t(r[ci.end]) : null, text: clean(r[ci.en] || ''), ja: ci.ja >= 0 ? clean(r[ci.ja] || '') : '' })).filter((c) => c.text || c.ja);
  return { format: 'csv', cues, timed: cues.every((c) => c.start != null && c.end != null), hasJaColumn: ci.ja >= 0 };
}

// ---------- language & base name ----------
const LANG_TOKENS = [
  [/(^|[._\-\s\[(])(en|eng|english|英語|英)(?=$|[._\-\s\])])/i, 'en'],
  [/(^|[._\-\s\[(])(ja|jp|jpn|japanese|日本語|和訳|日)(?=$|[._\-\s\])])/i, 'ja'],
];
export function langFromName(name) { const b = name.replace(/\.[^.]+$/, ''); for (const [re, l] of LANG_TOKENS) if (re.test(b)) return l; return null; }
export function baseKey(name) {
  let b = name.replace(/\.[^.]+$/, '').toLowerCase();
  for (const [re] of LANG_TOKENS) b = b.replace(new RegExp(re.source, 'gi'), '$1');
  return b.replace(/[\[\]()（）]/g, '').replace(/(字幕|subtitles?|subs?|caption|script)/g, '').replace(/[._\-\s]+/g, ' ').trim();
}

// media: [{ key, name, duration }], subs: [{ key, name, lang, lastEnd }]
// returns sets: [{ media, en, ja, reason, confidence }]
export function autoPair(media, subs) {
  const sets = []; const used = new Set();
  for (const m of media) {
    const k = baseKey(m.name);
    const cand = subs.filter((s) => !used.has(s) && baseKey(s.name) === k);
    const set = { media: m, en: null, ja: null, reasons: [] };
    for (const s of cand) { if (s.lang === 'en' && !set.en) { set.en = s; used.add(s); } else if (s.lang === 'ja' && !set.ja) { set.ja = s; used.add(s); } }
    if (set.en || set.ja) set.reasons.push('名前が一致');
    sets.push(set);
  }
  // remaining subtitles: match by duration (last cue end within ±10% of media duration)
  for (const s of subs.filter((x) => !used.has(x))) {
    if (!s.lastEnd) continue;
    const fit = sets.filter((x) => x.media && !x[s.lang] && Math.abs(x.media.duration - s.lastEnd) <= x.media.duration * 0.1)
      .sort((a, b) => Math.abs(a.media.duration - s.lastEnd) - Math.abs(b.media.duration - s.lastEnd));
    if (fit.length === 1 || (fit.length > 1 && Math.abs(fit[0].media.duration - s.lastEnd) * 2 < Math.abs(fit[1].media.duration - s.lastEnd))) {
      fit[0][s.lang] = s; used.add(s); fit[0].reasons.push('長さが一致');
    }
  }
  // subtitles still alone: their own set (media can be added later)
  for (const s of subs.filter((x) => !used.has(x))) sets.push({ media: null, en: s.lang === 'en' ? s : null, ja: s.lang === 'ja' ? s : null, reasons: ['字幕だけ'] });
  for (const st of sets) {
    st.confidence = !st.media || (!st.en && !st.ja) ? 'low' : st.reasons.includes('名前が一致') ? 'high' : 'mid';
    st.title = (st.media?.name || st.en?.name || st.ja?.name || '').replace(/\.[^.]+$/, '').replace(new RegExp(LANG_TOKENS[0][0].source, 'i'), '$1').replace(new RegExp(LANG_TOKENS[1][0].source, 'i'), '$1').replace(/[._\-]+$/, '');
  }
  return sets;
}

// attach Japanese cues to English cues by time overlap → [{ jaIds, ja }] per English cue; unmatched Japanese cues returned separately
export function alignJa(enCues, jaCues) {
  const map = new Map(enCues.map((c) => [c.id, []])); const extra = [];
  for (const j of jaCues) {
    let best = null, ov = 0;
    for (const c of enCues) { const o = Math.min(c.end, j.end) - Math.max(c.start, j.start); if (o > ov) { ov = o; best = c; } }
    if (best && ov > 0) map.get(best.id).push(j); else extra.push(j);
  }
  return { map, extra };
}
