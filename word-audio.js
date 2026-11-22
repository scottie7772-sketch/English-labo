// 1.17.10: words and example sentences play the ORIGINAL recording when the same text exists in a matched material
// (教材スタジオ: lines matched to the script / 動画ラボ: subtitles). Nothing is copied: only the place in the recording
// (file + start/end) is looked up, by the text itself, so a word plays the same sound wherever it was added from.
// No match → the caller falls back to the synthetic voice (TTS).
import { db } from './db.js';

export const norm = (t) => String(t || '').toLowerCase().replace(/^\s*(no\.?\s*)?\d+[.):：]?\s+/, '').replace(/[’‘`]/g, "'").replace(/[“”"]/g, '').replace(/\s*[×x✕*]\s*\d+\s*$/i, '')
  .replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');

let index = null, loading = null, builtAt = 0;
// text → { from: 'studio'|'lab', id: file id, start, end, kind }
async function build() {
  const m = new Map();
  const put = (text, e) => { const k = norm(text); if (!k || k.length > 300) return; const o = m.get(k);
    // prefer: a line made for the word (kind word) > matched to a script > a subtitle
    const score = (x) => (x.kind === 'word' ? 3 : 0) + (x.aligned ? 2 : 0) + (x.from === 'studio' ? 1 : 0);
    if (!o || score(e) > score(o)) m.set(k, e); };
  try {
    const { sdb } = await import('./studio-db.js');
    const raw = (n) => sdb.all(n);
    const sets = await raw('sets'); const live = new Set(sets.flatMap((s) => s.order || []));
    for (const b of await raw('blocks')) {
      if (b.deleted || !live.has(b.id) || !b.text || b.segments?.length !== 1) continue;
      if (b.asr && !b.aligned) continue;   // a rough transcript is not the right text
      if (b.sync === 'estimated' && !b.kind) continue;   // time only guessed
      const g = b.segments[0]; if (!(g.end > g.start)) continue;
      put(b.text, { from: 'studio', id: g.sourceId, start: g.start, end: g.end, kind: b.kind || '', aligned: !!b.aligned });
    }
  } catch { /* no studio data */ }
  try {
    const vids = new Set((await db.all('videos')).map((v) => v.id));
    for (const c of await db.all('cues')) if (vids.has(c.videoId) && c.text && c.end > c.start) put(c.text, { from: 'lab', id: c.videoId, start: c.start, end: c.end, kind: c.kind || '' });
  } catch { /* no lab data */ }
  index = m; near.clear(); builtAt = Date.now(); return m;
}
// load (again) — called when a card session starts; cheap enough to rebuild each time (text only)
export function prepare(force = false) {
  if (!force && index && Date.now() - builtAt < 60000) return Promise.resolve(index);
  return (loading ||= build().finally(() => { loading = null; }));
}
// 1.18.5: not only whole lines. A word line joined with its example ("anyway Let's try anyway.") or an example inside a longer
// line is found too; the part is timed by its share of the letters (marked est)
const near = new Map();
function lookup(text) {
  const k = norm(text); if (!k || !index) return null;
  const hit = index.get(k); if (hit) return hit;
  if (near.has(k)) return near.get(k);
  const multi = k.split(' ').length >= 3; let best = null, bl = Infinity;
  for (const [key, e] of index) {
    if (key.length <= k.length) continue;
    let at = -1;
    if (key.startsWith(k + ' ')) at = 0;
    else if (multi) { const i = (' ' + key + ' ').indexOf(' ' + k + ' '); if (i >= 0) at = i; }
    if (at < 0 || key.length >= bl) continue;
    best = { e, at, key }; bl = key.length;
  }
  let r = null;
  if (best) { const { e, at, key } = best, d = e.end - e.start; r = { ...e, start: +(e.start + (d * at) / key.length).toFixed(2), end: +(e.start + (d * Math.min(key.length, at + k.length + 1)) / key.length).toFixed(2), est: true, line: { start: e.start, end: e.end, at, len: k.length, keyLen: key.length, head: at === 0 } }; }
  near.set(k, r); return r;
}
export const ready = () => !!index;
export const has = (text) => !!lookup(text);
export const find = (text) => lookup(text);

// ---- playback: one shared <audio>; one object URL per file (the 2 most recent are kept) ----
const PAD0 = 0.06, PAD1 = 0.14;   // a little before / after so the first and last sounds are not clipped
let el = null, timer = 0;
const urls = new Map();
const audioEl = () => { if (!el) { el = new Audio(); el.preload = 'auto'; el.playsInline = true; } return el; };
async function fileOf(e) {
  const key = e.from + ':' + e.id;
  if (urls.has(key)) { const u = urls.get(key); urls.delete(key); urls.set(key, u); return u; }
  let blob = null;
  if (e.from === 'studio') { const { sdb } = await import('./studio-db.js'); blob = (await sdb.get('sources', e.id))?.blob || null; }
  else { blob = (await db.get('vblobs', e.id))?.blob || (await db.get('videos', e.id))?.blob || null; }
  if (!blob) return null;
  const u = URL.createObjectURL(blob); urls.set(key, u);
  while (urls.size > 2) { const [k, v] = urls.entries().next().value; urls.delete(k); try { URL.revokeObjectURL(v); } catch {} }
  return u;
}
// the first touch on a card screen: play nothing once so later plays (after a swipe) are allowed on the iPhone
export function unlock() {
  const a = audioEl(); if (a.dataset.ok) return; a.dataset.ok = '1';
  try { a.muted = true; a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; a.play().then(() => { a.pause(); a.muted = false; }).catch(() => { a.muted = false; delete a.dataset.ok; }); } catch {}
}
export function stop() { clearTimeout(timer); try { el?.pause(); } catch {} }
// play the original sound of `text`; resolves true when it plays, false when there is none (use TTS then)
export async function play(text) {
  let e = find(text); if (!e) return false;
  try {
    if (e.line) e = await refine(e);
    const u = await fileOf(e); if (!u) return false;
    const a = audioEl(); stop();
    if (a.src !== u) { a.src = u; await new Promise((ok, ng) => { a.onloadedmetadata = ok; a.onerror = ng; setTimeout(ok, 1500); }); }
    const s = Math.max(0, e.start - PAD0), t = e.end + PAD1;
    a.currentTime = s; a.muted = false; await a.play();
    const end = () => { if (a.currentTime >= t - 0.02) { a.pause(); return; } timer = setTimeout(end, Math.max(15, ((t - a.currentTime) * 1000) / (a.playbackRate || 1) - 10)); };
    timer = setTimeout(end, ((t - s) * 1000) / (a.playbackRate || 1));
    return true;
  } catch { return false; }
}

// ---- 1.18.6: a word / example that is only part of a line is cut at the PAUSES in the real sound ----
// The line's sound is decoded once (only that line: a few seconds), split where it is quiet, and the result is remembered.
// word at the start of the line → the first spoken part; example → the part where its letters fall (first reading only).
const REF_KEY = 'wa-parts1';
const refMem = (() => { try { return JSON.parse(localStorage.getItem(REF_KEY) || '{}'); } catch { return {}; } })();
const refSave = () => { try { const ks = Object.keys(refMem); if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete refMem[k]; localStorage.setItem(REF_KEY, JSON.stringify(refMem)); } catch {} };
async function lineBlob(e) {
  let blob = null;
  if (e.from === 'studio') { const { sdb } = await import('./studio-db.js'); blob = (await sdb.get('sources', e.id))?.blob || null; }
  else blob = (await db.get('vblobs', e.id))?.blob || (await db.get('videos', e.id))?.blob || null;
  if (!blob) return null;
  const { cutAac } = await import('./compress.js');
  try { return { blob: (await cutAac(blob, e.line.start, e.line.end, 'line')).file, off: 0 }; } catch { /* not AAC */ }
  if (blob.size <= 25e6) return { blob, off: e.line.start };   // small file: decode it whole, then look at the line only
  return null;
}
async function partsOf(e) {
  const key = `${e.from}:${e.id}@${e.line.start}-${e.line.end}`;
  if (refMem[key]) return refMem[key];
  const lb = await lineBlob(e); if (!lb) return null;
  const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
  let buf; try { buf = await ac.decodeAudioData(await lb.blob.arrayBuffer()); } finally { try { ac.close(); } catch {} }
  const sr = buf.sampleRate, ch = buf.getChannelData(0), from = Math.floor(lb.off * sr), to = Math.min(ch.length, Math.floor((lb.off + (e.line.end - e.line.start)) * sr));
  const hop = Math.round(sr * 0.02), rms = [];
  for (let i = from; i + hop <= to; i += hop) { let a = 0; for (let j = i; j < i + hop; j++) a += ch[j] * ch[j]; rms.push(Math.sqrt(a / hop)); }
  if (!rms.length) return null;
  const sorted = rms.slice().sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)], peak = sorted[Math.floor(sorted.length * 0.95)];
  const th = floor + (peak - floor) * 0.12;
  // spoken parts separated by quiet of at least 0.25 s
  const parts = []; let on = -1, quiet = 0;
  rms.forEach((v, i) => { if (v > th) { if (on < 0) on = i; quiet = 0; } else if (on >= 0 && ++quiet >= 13) { parts.push([on, i - quiet + 1]); on = -1; quiet = 0; } });
  if (on >= 0) parts.push([on, rms.length]);
  const out = parts.filter(([a, b]) => b - a >= 4).map(([a, b]) => [+(e.line.start + a * 0.02).toFixed(2), +(e.line.start + b * 0.02).toFixed(2)]);
  refMem[key] = out; refSave(); return out;
}
async function refine(e) {
  try {
    const parts = await partsOf(e); if (!parts || !parts.length) return e;
    if (e.line.head) return { ...e, start: parts[0][0], end: parts[0][1] };   // the word said first, before the pause
    // an example: the parts after the first one (the word) are joined while the pauses are short (one reading), up to the next long pause
    const rest = parts.length > 1 ? parts.slice(1) : parts;
    const want = e.line.start + ((e.line.end - e.line.start) * e.line.at) / e.line.keyLen;
    let i = rest.findIndex((p) => p[1] > want); if (i < 0) i = 0;
    let a = rest[i][0], b = rest[i][1];
    for (let k = i + 1; k < rest.length && rest[k][0] - b < 0.6; k++) b = rest[k][1];
    return { ...e, start: a, end: b };
  } catch { return e; }
}
