// 1.17.10: words and example sentences play the ORIGINAL recording when the same text exists in a matched material
// (教材スタジオ: lines matched to the script / 動画ラボ: subtitles). Nothing is copied: only the place in the recording
// (file + start/end) is looked up, by the text itself, so a word plays the same sound wherever it was added from.
// No match → the caller falls back to the synthetic voice (TTS).
import { db } from './db.js';

export const norm = (t) => String(t || '').toLowerCase().replace(/^\s*(no\.?\s*)?\d+[.):：]?\s+/, '').replace(/[’‘`]/g, "'").replace(/[“”"]/g, '').replace(/\s*[×x✕*]\s*\d+\s*$/i, '')
  .replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');

let index = null, loading = null, builtAt = 0, soft = new Set();   // soft: text that exists only as a guessed / unconfirmed range
// text → { from: 'studio'|'lab', id: file id, start, end, kind }
async function build() {
  const m = new Map(), srcOk = new Set(), sf = new Set();
  let labKeys = new Set(); try { labKeys = new Set(await db.keys('vblobs')); } catch {}
  const put = (text, e) => { const k = norm(text); if (!k || k.length > 300) return; const o = m.get(k);
    // prefer: a line made for the word (kind word) > matched to a script > a subtitle
    const score = (x) => (x.ok ? 8 : 0) + (x.kind === 'word' ? 3 : 0) + (x.aligned ? 2 : 0) + (x.from === 'studio' ? 1 : 0);
    if (!o || score(e) > score(o)) m.set(k, e); };
  try {
    const { sdb } = await import('./studio-db.js');
    const raw = (n) => sdb.all(n);
    for (const x of await raw('sources')) if (x.blob || (x.labRef && labKeys.has(x.labRef))) srcOk.add(x.id);
    const sets = await raw('sets'); const live = new Set(sets.flatMap((s) => s.order || []));
    for (const b of await raw('blocks')) {
      if (b.deleted || !live.has(b.id) || !b.text || !b.segments?.length) continue;   // 1.19.36: a repeated example (several segments) plays its first reading
      if (b.asr && !b.aligned) { sf.add(norm(b.text)); continue; }   // a rough transcript is not the right text
      if (b.unconfirmed || b.sync === 'estimated') { sf.add(norm(b.text)); continue; }   // time only guessed
      const g = b.segments[0]; if (!(g.end > g.start)) continue;
      put(b.text, { from: 'studio', id: g.sourceId, start: g.start, end: g.end, kind: b.kind || '', aligned: !!b.aligned, ok: srcOk.has(g.sourceId) });
    }
  } catch { /* no studio data */ }
  try {
    // 1.19.31 fix: Lab subtitles keep their English in c.en (c.text was never set, so Lab recordings were never found)
    const byId = new Map((await db.all('videos')).map((v) => [v.id, v]));
    for (const c of await db.all('cues')) {
      const v = byId.get(c.videoId), text = c.en || c.text;
      if (!v || v.kind === 'multi' || !text) continue;
      if (c.sync === 'estimated') { sf.add(norm(text)); continue; }   // a guessed time is not used
      const g = c.segments?.[0] || c; if (!(g.end > g.start)) continue;   // repeats: the first reading
      const key = [v.id, v.mediaRef].find((k) => k && labKeys.has(k)) || (v.blob ? v.id : null);
      put(text, { from: 'lab', id: key || v.mediaRef || v.id, start: g.start, end: g.end, kind: c.role || c.kind || '', ok: !!key });
    }
  } catch { /* no lab data */ }
  for (const k of sf) if (m.has(k)) sf.delete(k);
  soft = sf; index = m; near.clear(); builtAt = Date.now(); return m;
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
// 1.19.31: every request takes a token; a request that finishes loading after a newer one started never plays
// (fast swipes cannot make two words sound at once). The range end is watched every frame, so the next word in the
// same recording is not heard; the padding never goes past the neighbouring line (ref.limit).
const PAD0 = 0.06, PAD1 = 0.14;   // a little before / after so the first and last sounds are not clipped
let el = null, timer = 0, raf = 0, token = 0, endAt = null, onDone = null;
const urls = new Map();
const audioEl = () => { if (!el) { el = new Audio(); el.preload = 'auto'; el.playsInline = true; } return el; };
async function urlFor(key, load) {
  if (urls.has(key)) { const u = urls.get(key); urls.delete(key); urls.set(key, u); return u; }
  const blob = await load(); if (!blob) return null;
  if (urls.has(key)) return urls.get(key);
  const u = URL.createObjectURL(blob); urls.set(key, u);
  while (urls.size > 2) {
    const [k, v] = urls.entries().next().value; urls.delete(k);
    if (el?.src !== v) try { URL.revokeObjectURL(v); } catch {}
  }
  return u;
}
// the first touch on a card screen: play nothing once so later plays (after a swipe) are allowed on the iPhone
export function unlock() {
  const a = audioEl(); if (a.dataset.ok) return; a.dataset.ok = '1';
  if (a.src) return;   // already playing something: the element is unlocked
  try { a.muted = true; a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; a.play().then(() => { a.pause(); a.muted = false; }).catch(() => { a.muted = false; delete a.dataset.ok; }); } catch {}
}
function finish(my) {
  if (my !== token) return;
  clearTimeout(timer); cancelAnimationFrame?.(raf); endAt = null;
  try { el?.pause(); } catch {}
  const done = onDone; onDone = null; done?.();
}
export function stop() { token++; clearTimeout(timer); try { cancelAnimationFrame(raf); } catch {} endAt = null; try { el?.pause(); } catch {} const done = onDone; onDone = null; done?.(); }
export const playing = () => endAt != null;
// play [start, end) of a file; resolves true when it started. `until` resolves when it ended or was stopped.
async function playRange(key, load, start, end, limit = null) {
  stop();
  const my = token;
  const u = await urlFor(key, load);
  if (!u || my !== token) return false;
  const a = audioEl();
  if (a.src !== u) {
    a.src = u;
    await new Promise((ok) => { const t = setTimeout(ok, 2000); a.onloadedmetadata = () => { clearTimeout(t); ok(); }; a.onerror = () => { clearTimeout(t); ok(); }; });
    if (my !== token) return false;
  }
  const s = Math.max(limit?.min ?? 0, start - PAD0, 0);
  const t = Math.min(limit?.max ?? Infinity, end + PAD1);
  a.muted = false;
  try { a.currentTime = s; } catch { return false; }
  endAt = t;
  try { await a.play(); } catch { if (my === token) endAt = null; return false; }
  if (my !== token) { try { a.pause(); } catch {} return false; }
  const watch = () => { if (my !== token) return; if (a.currentTime >= t - 0.015 || a.ended) return finish(my); raf = requestAnimationFrame(watch); };
  raf = requestAnimationFrame(watch);
  // backup for when frames are not drawn (screen locked / background)
  const backup = () => { if (my !== token) return; if (a.currentTime >= t - 0.03 || a.ended || a.paused) return finish(my); timer = setTimeout(backup, Math.max(20, ((t - a.currentTime) * 1000) / (a.playbackRate || 1) - 15)); };
  timer = setTimeout(backup, ((t - s) * 1000) / (a.playbackRate || 1));
  return true;
}
// a stored reference (audio-refs.js); false when the recording is not there (the caller falls back)
export async function playRef(ref, { onEnd = null } = {}) {
  if (!ref?.src?.key) return false;
  const { refBlob } = await import('./audio-refs.js');
  const ok = await playRange(`${ref.src.store}:${ref.src.key}`, () => refBlob(ref.src), ref.start, ref.end, ref.limit);
  if (ok) onDone = onEnd; else onEnd?.();
  return ok;
}
// several references one after the other (word, then example); stops with the next request
export async function playRefs(refs, { gap = 0.35, onEnd = null } = {}) {
  const list = refs.filter(Boolean);
  for (let i = 0; i < list.length; i++) {
    let ended; const done = new Promise((r) => { ended = r; });
    const ok = await playRef(list[i], { onEnd: ended });
    if (!ok) { onEnd?.(); return i > 0; }
    const mine = token;
    await done;
    if (token !== mine) return true;   // stopped, or another request took over
    if (i < list.length - 1) { await new Promise((r) => setTimeout(r, gap * 1000)); if (token !== mine) return true; }
  }
  onEnd?.();
  return true;
}
// a word's registered sound (word.audio). Resolves false when it has none (the caller keeps its old voice).
export async function playWord(w, kind = 'word', opts = {}) {
  const { wordAudio } = await import('./audio-refs.js');
  const ref = wordAudio(w, kind);
  return ref ? playRef(ref, opts) : false;
}
async function entryBlob(e) {
  if (e.from === 'studio') {
    const { sdb } = await import('./studio-db.js'); const src = await sdb.get('sources', e.id);
    return src?.blob || (src?.labRef ? (await db.get('vblobs', src.labRef))?.blob : null) || null;   // a studio file shared with the Lab is kept once, in vblobs
  }
  return (await db.get('vblobs', e.id))?.blob || (await db.get('videos', e.id))?.blob || null;
}
// Why a word has / has not an original sound (never switch to the synthetic voice without a reason the person can see)
export const STATE_LABEL = { orig: '元音声あり', tts: '合成音声のみ', broken: '音声参照切れ', unsure: '音声区間未確定' };
export function status(text, w = null) {
  const r = w?.audio?.word || w?.audio?.example;
  if (r && r.state !== 'confirmed') return 'unsure';
  const e = lookup(text);
  if (!e) return r ? 'broken' : soft.has(norm(text)) ? 'unsure' : 'tts';
  return e.ok === false ? 'broken' : 'orig';
}
export const note = (text, failed = false) => {
  const st = failed ? 'broken' : status(text); return st === 'orig' || st === 'tts' && !failed ? '' : STATE_LABEL[st] + '：合成音声で読み上げます';
};
// play the original sound of `text`; resolves true when it plays, false when there is none (use TTS then)
export async function play(text, { onEnd = null } = {}) {
  let e = find(text); if (!e || e.ok === false) return false;   // the recording is gone: the caller says so and uses the synthetic voice
  try {
    if (e.line) e = await refine(e);
    const ok = await playRange(e.from + ':' + e.id, () => entryBlob(e), e.start, e.end);
    if (ok) onDone = onEnd;
    return ok;
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
  // 1.19.31: only a small file is decoded whole (a long recording is never expanded to PCM: ~10x its size in memory)
  if (blob.size <= 6e6) return { blob, off: e.line.start };
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
