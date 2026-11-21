// 1.17.10: words and example sentences play the ORIGINAL recording when the same text exists in a matched material
// (教材スタジオ: lines matched to the script / 動画ラボ: subtitles). Nothing is copied: only the place in the recording
// (file + start/end) is looked up, by the text itself, so a word plays the same sound wherever it was added from.
// No match → the caller falls back to the synthetic voice (TTS).
import { db } from './db.js';

export const norm = (t) => String(t || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”"]/g, '').replace(/\s*[×x✕*]\s*\d+\s*$/i, '')
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
  index = m; builtAt = Date.now(); return m;
}
// load (again) — called when a card session starts; cheap enough to rebuild each time (text only)
export function prepare(force = false) {
  if (!force && index && Date.now() - builtAt < 60000) return Promise.resolve(index);
  return (loading ||= build().finally(() => { loading = null; }));
}
export const has = (text) => !!index?.get(norm(text));
export const find = (text) => index?.get(norm(text)) || null;

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
  const e = find(text); if (!e) return false;
  try {
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
