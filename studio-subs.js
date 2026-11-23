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
  // 1.17: JSON made for Englabo ("englabo-script") and one-line-per-item text with [mm:ss.xx] times (LRC style)
  if (/^\s*\{/.test(text)) { const j = parseEnglaboJson(text); if (j) return j; }
  if (text.split('\n').filter((l) => LRC.test(l)).length >= 3) return parseLrc(text);
  if (ext === 'csv' || ext === 'tsv' || /\t/.test(text.split('\n')[0] || '')) return parseTable(text, ext === 'csv' ? ',' : '\t');
  // TXT: one line per item (blank lines ignored)
  const cues = text.split('\n').map((l) => clean(l)).filter(Boolean).map((t) => ({ id: newId('c'), start: null, end: null, text: t }));
  return { format: 'txt', cues, timed: false };
}

// ---------- 1.17: timed one-line text / JSON with sections per audio file, repeat marks, word + example pairs ----------
const LRC = /^\s*\[((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]\s*/;
const REP = /\s*[×xX✕＊*]\s*([2-9]|1\d)\s*$/;                 // "×2" "x2" "X3" at the end of a line = read n times in the audio
const HEAD = /^\s*(?:#+\s*)?(?:file\s*[:：]\s*)?([^\[\]|]*?\.(?:mp3|m4a|wav|aac|mp4|m4v|mov))\s*$/i;
// Plain-text imports may contain file headers and a separated title above the lesson.
export function withoutPlainScriptHeaders(parsed, raw, names) {
  if (parsed.format !== 'txt' || parsed.timed) return parsed;
  const normalize = value => clean(value).toLowerCase();
  const titles = new Set(names.filter(Boolean).map(name =>
    normalize(String(name).split('/').at(-1).replace(/\.(txt|mp3|m4a|wav|aac|mp4|m4v|mov)$/i, ''))));
  const metadata = /^\s*\uFEFF?([^\r\n]+)\r?\n[ \t]*\r?\n/.exec(String(raw));
  const title = metadata && normalize(metadata[1].replace(/^#+\s*/, ''));
  const cues = parsed.cues.filter((cue, index) => !HEAD.test(cue.text) &&
    !(index === 0 && title && titles.has(title) && parsed.cues.length > 1));
  return {...parsed, cues};
}
const tSec = (v) => { if (typeof v === 'number') return v; const m = String(v || '').trim().replace(',', '.'); if (!m) return null; return /:/.test(m) ? toSec(m) : +m; };
const isWordLine = (t) => t.split(/\s+/).length <= 4 && !/[.!?。]["”’)]?$/.test(t);
const stem = (w) => w.toLowerCase().replace(/[^a-z']/g, '').replace(/(ing|ed|es|s)$/, '');
const usesWord = (word, sent) => { const ws = word.toLowerCase().split(/\s+/).map(stem).filter((x) => x.length > 1); const ss = sent.toLowerCase().split(/[\s,.;:!?"“”]+/).map(stem); return ws.length > 0 && ws.every((w) => ss.some((x) => x.startsWith(w.slice(0, Math.max(3, w.length - 1))))); };
// end times: the next line's start (an estimate, marked endEst); word ↔ example pairs
function finishSection(sec) {
  sec.cues.sort((a, b) => a.start - b.start);
  sec.cues.forEach((c, i) => {
    const nx = sec.cues[i + 1];
    if (c.end == null) { c.end = nx ? nx.start : c.start + 30; c.endEst = true; }   // the last line: up to 30 s (cut at the end of the audio file)
    if (!c.kind && c.text) c.kind = isWordLine(c.text) ? 'word' : 'example';
  });
  sec.cues.forEach((c, i) => { const p = sec.cues[i - 1]; if (c.kind === 'example' && p?.kind === 'word' && !c.pair && usesWord(p.text, c.text)) c.pair = p.id; });
  return sec;
}
function result(format, sections, rows) {
  sections = sections.filter((x) => x.cues.length).map(finishSection);
  return { format, timed: true, sections, cues: sections.flatMap((x) => x.cues), rows };
}
function parseLrc(text) {
  const sections = [{ file: '', cues: [] }], rows = [];
  let started = false, last = null;
  text.split('\n').forEach((raw, n) => {
    const line = raw.replace(/\s+$/, ''); if (!line.trim()) return;
    const h = !LRC.test(line) && line.match(HEAD);
    if (h) { started = true; sections.push({ file: h[1].trim().split('/').pop(), cues: [] }); last = null; rows.push({ n, cls: 'head', text: line }); return; }
    const m = line.match(LRC);
    if (!m) {
      const t = clean(line);
      if (!started) rows.push({ n, cls: 'intro', text: t });
      else if (isJa(t) && last && !last.ja) { last.ja = t.replace(REP, ''); rows.push({ n, cls: 'ja', text: t }); }
      else rows.push({ n, cls: 'unknown', text: t });
      return;
    }
    started = true;
    let body = clean(line.slice(m[0].length)), rep = 1;
    const r = body.match(REP); if (r) { rep = +r[1]; body = body.replace(REP, ''); }
    let [en, ja = ''] = body.split(/\s+\|\s+|\s*｜\s*/);
    const r2 = en.match(REP); if (r2) { rep = Math.max(rep, +r2[1]); en = en.replace(REP, ''); }
    if (isJa(en) && !/[A-Za-z]{2}/.test(en)) { ja = en; en = ''; }
    const cue = { id: newId('c'), start: toSec(m[1]), end: null, text: en.trim(), ja: ja.trim(), ...(rep > 1 ? { rep } : {}) };
    sections.at(-1).cues.push(cue); last = cue;
    rows.push({ n, cls: cue.text ? (isWordLine(cue.text) ? 'word' : 'example') : 'ja', text: line, rep });
  });
  return result('lrc', sections, rows);
}
function parseEnglaboJson(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!j || (j.format !== 'englabo-script' && !Array.isArray(j.files))) return null;
  const rows = [];
  const sections = (j.files || []).map((f) => {
    const cues = []; const byNo = {};
    for (const x of f.lines || []) {
      let en = String(x.en || '').trim(), rep = +x.repeat || 1;
      const r = en.match(REP); if (r) { rep = Math.max(rep, +r[1]); en = en.replace(REP, ''); }
      const c = { id: newId('c'), start: tSec(x.t ?? x.start), end: x.end != null ? tSec(x.end) : null, text: en, ja: String(x.ja || '').trim(), ...(rep > 1 ? { rep } : {}), ...(x.type === 'word' || x.type === 'example' ? { kind: x.type } : {}) };
      if (c.start == null || Number.isNaN(c.start)) { rows.push({ cls: 'unknown', text: JSON.stringify(x).slice(0, 80) }); continue; }
      if (x.no != null && c.kind === 'word') byNo[x.no] = c.id;
      if (x.no != null && c.kind === 'example' && byNo[x.no]) c.pair = byNo[x.no];
      cues.push(c); rows.push({ cls: c.kind || (c.text ? 'example' : 'ja'), text: en || c.ja, rep });
    }
    return { file: String(f.audio || f.file || '').split('/').pop(), cues };
  });
  return result('json', sections, rows);
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
