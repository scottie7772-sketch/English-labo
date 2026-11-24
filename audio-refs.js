// 1.19.31: audio for word cards = a REFERENCE to a range of a recording that is already stored (never a copy).
// word.audio = { word: ref | null, example: ref | null }
// ref = { v: 1, src: { store: 'vblobs' | 'studio', key, size }, start, end, limit: { min, max },
//         origin: { from: 'lab' | 'studio', materialId, cueId?, itemId?, text, title? }, state: 'confirmed' | 'unconfirmed', at }
//  - src.key is the storage id of the recording (Lab: the vblobs record = video.mediaRef || video.id; Studio: the source id),
//    never a file name. src.size is kept to notice a replaced file.
//  - limit = where the neighbouring line starts / ends in the same recording: playback padding never enters it.
//  - 'unconfirmed' (estimated time, unchecked bulk assignment, ambiguous repeat) is kept but not used on cards.
import { db } from './db.js';
import { headKey, splitList, newWord, newSense, meaningsOf } from './words.js';

export const REF_VERSION = 1;
const round = t => Math.round(t * 1000) / 1000;
const normEn = t => String(t || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const sameText = (a, b) => normEn(a) === normEn(b) && Boolean(normEn(a));

// ---------- one reading out of several (an example read 2-3 times) ----------
// The reading closest to the typical length is used; a reading much shorter (cut) or longer (runs into the next line)
// than the others is avoided. Two readings that disagree -> the first one, marked unsure (stays unconfirmed).
export function pickReading(segments) {
  const ok = (segments || []).filter(g => g && Number.isFinite(g.start) && Number.isFinite(g.end) && g.end - g.start >= 0.08);
  if (!ok.length) return null;
  if (ok.length === 1) return { seg: ok[0], index: 0, of: 1, unsure: false };
  const lengths = ok.map(g => g.end - g.start), sorted = lengths.slice().sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const fits = d => d >= mid * 0.8 && d <= mid * 1.25;
  const index = lengths.findIndex(fits);
  if (ok.length === 2) {
    const ratio = Math.max(...lengths) / Math.min(...lengths);
    return { seg: ok[0], index: 0, of: 2, unsure: ratio > 1.25 };
  }
  return index < 0 ? { seg: ok[0], index: 0, of: ok.length, unsure: true } : { seg: ok[index], index, of: ok.length, unsure: false };
}

// neighbouring speech in the same recording (for the padding limit)
export function limitsFor(range, others) {
  let min = 0, max = null;
  for (const o of others) {
    if (o.sourceKey !== range.sourceKey || (o.start === range.start && o.end === range.end)) continue;
    if (o.end <= range.start + 0.02 && o.end > min) min = o.end;
    if (o.start >= range.end - 0.02 && (max == null || o.start < max)) max = o.start;
  }
  return { min: round(min), max: max == null ? null : round(max) };
}
export function makeRef({ store, key, size = null, start, end, limit = null, origin, state }) {
  return { v: REF_VERSION, src: { store, key, ...(size ? { size } : {}) }, start: round(start), end: round(end),
    ...(limit ? { limit } : {}), origin, state, at: Date.now() };
}
export const usableRef = ref => Boolean(ref && ref.src?.key && ref.end > ref.start && ref.state === 'confirmed');
export const wordAudio = (w, kind) => {
  const ref = w?.audio?.[kind];
  if (!usableRef(ref)) return null;
  // the example sound belongs to one example: it is used only while that example is still the word's example
  if (kind === 'example' && !(w.senses || []).some(s => (s.examples || []).some(x => sameText(x.en, ref.origin?.text)))) return null;
  return ref;
};

// ---------- 金フレ型 material -> items { head, ja, example, exampleJa, word: ref|null, ex: ref|null, issues[] } ----------
// rows: [{ id, text, ja, role: 'word'|'example', group, segments: [{ sourceKey, store, size, start, end }], confirmed }]
// (Studio blocks and Lab cues are both brought to this shape by the callers below.)
export function vocabItems(rows, { from, materialId, title = '' }) {
  const all = rows.flatMap(r => r.segments.map(g => ({ sourceKey: g.sourceKey, start: g.start, end: g.end })));
  const groups = new Map();
  for (const row of rows) {
    if (!row.group) continue;
    if (!groups.has(row.group)) groups.set(row.group, { word: null, examples: [] });
    const g = groups.get(row.group);
    if (row.role === 'word' && !g.word) g.word = row; else if (row.role === 'example') g.examples.push(row);
  }
  const refFor = (row, kind) => {
    const pick = pickReading(row.segments);
    if (!pick) return { ref: null, issue: kind === 'word' ? '単語の音声が未割当' : '例文の音声が未割当' };
    const g = pick.seg;
    const state = row.confirmed && !pick.unsure ? 'confirmed' : 'unconfirmed';
    const origin = { from, materialId, ...(from === 'lab' ? { cueId: row.id } : {}), ...(row.itemId || from === 'studio' ? { itemId: row.itemId || row.id } : {}), text: row.text, ...(title ? { title } : {}) };
    const ref = makeRef({ store: g.store, key: g.key, size: g.size, start: g.start, end: g.end, limit: limitsFor(g, all), origin, state });
    const issue = !row.confirmed ? `${kind === 'word' ? '単語' : '例文'}の音声位置が未確定（推定・未確認）` : pick.unsure ? `例文の${pick.of}回の読み上げの長さが揃わないため未確定` : '';
    return { ref, issue, repeats: pick.of };
  };
  const items = [];
  for (const [group, g] of groups) {
    if (!g.word || !g.word.text?.trim()) continue;
    const ex = g.examples.find(r => r.text?.trim()) || null;
    const w = refFor(g.word, 'word'), e = ex ? refFor(ex, 'example') : { ref: null, issue: '' };
    items.push({ group, head: g.word.text.trim(), ja: g.word.ja || '', example: ex?.text?.trim() || '', exampleJa: ex?.ja || '',
      word: w.ref, ex: e.ref, repeats: e.repeats || 0, issues: [w.issue, e.issue].filter(Boolean) });
  }
  return items;
}

// ---------- registration plan (no writes) ----------
// mode 'merge': existing entries get the audio, missing ones are added; 'audio': only existing entries get audio.
// An entry is "the same" when the headword matches and either a meaning or the example sentence matches;
// the same headword with another meaning and another example is a different entry (added separately).
export function planAudioWords(items, existing, { mode = 'merge', replace = false, lang = 'en', tags = [], source = {} } = {}) {
  const byHead = new Map();
  for (const w of existing) { if ((w.lang || 'en') !== lang) continue; const k = headKey(w.headword); if (!byHead.has(k)) byHead.set(k, []); byHead.get(k).push(w); }
  const exOf = w => (w.senses || []).flatMap(s => s.examples || []).map(x => x.en);
  const out = { add: [], update: [], skip: [], dupes: [], counts: { items: items.length, wordAudio: 0, exampleAudio: 0, unconfirmed: 0, missing: 0 } };
  const seen = new Map();
  for (const it of items) {
    const c = out.counts;
    if (it.word?.state === 'confirmed') c.wordAudio++;
    if (it.ex?.state === 'confirmed') c.exampleAudio++;
    if (it.word?.state === 'unconfirmed' || it.ex?.state === 'unconfirmed') c.unconfirmed++;
    if (!it.word || (it.example && !it.ex)) c.missing++;
    const meanings = splitList(it.ja);
    const key = headKey(it.head) + '\u0001' + normEn(it.example);
    if (seen.has(key)) { out.skip.push({ item: it, reason: '同じ教材内で重複' }); continue; }
    seen.set(key, it);
    const same = (byHead.get(headKey(it.head)) || []).filter(w =>
      (it.example && exOf(w).some(en => sameText(en, it.example))) || (meanings.length && meaningsOf(w).some(m => meanings.includes(m))) ||
      (!meaningsOf(w).length && !exOf(w).length));
    if (same.length > 1) out.dupes.push({ item: it, words: same });
    if (same.length) {
      const target = same.find(w => !w.audio?.word && !w.audio?.example) || same[0];
      const audio = { ...(target.audio || {}) };
      let changed = false;
      for (const [kind, ref] of [['word', it.word], ['example', it.ex]]) {
        if (!ref) continue;
        if (audio[kind] && !replace && !(audio[kind].state !== 'confirmed' && ref.state === 'confirmed')) continue;
        if (kind === 'example' && !exOf(target).some(en => sameText(en, ref.origin.text))) continue;   // only the example the entry has
        audio[kind] = ref; changed = true;
      }
      if (changed) out.update.push({ item: it, word: target, audio }); else out.skip.push({ item: it, reason: '音声は登録済み' });
      continue;
    }
    if (mode === 'audio') { out.skip.push({ item: it, reason: '単語帳にない語（音声だけ追加の対象外）' }); continue; }
    const w = newWord({ lang, headword: it.head, tags, source, senses: [newSense({ meanings, examples: it.example ? [{ en: it.example, ja: it.exampleJa || '' }] : [] })] });
    w.audio = { ...(it.word ? { word: it.word } : {}), ...(it.ex ? { example: it.ex } : {}) };
    out.add.push({ item: it, word: w });
  }
  return out;
}
// one transaction per call (callers run materials one by one, so memory stays small)
export async function applyAudioWords(plan) {
  const now = Date.now();
  await db.tx(['words'], 'readwrite', t => {
    const os = t.objectStore('words');
    for (const { word } of plan.add) os.put({ ...word, createdAt: word.createdAt || now, updatedAt: now });
    for (const { word, audio } of plan.update) os.put({ ...word, audio, updatedAt: now });
  });
  return { added: plan.add.length, updated: plan.update.length };
}
// bytes the registration adds: the references only (the recordings are not copied)
export const refBytes = plan => new Blob([JSON.stringify([...plan.add.map(x => x.word), ...plan.update.map(x => x.audio)])]).size;

// ---------- Lab / Studio rows ----------
// Lab cue -> row. A cue of a joined material (kind 'multi') lives on the timeline of all parts: it is mapped back to
// the part's own recording (vblobs key of that part) and to that recording's time.
export function labRows(video, cues, { parts = new Map(), sizes = new Map(), studio = null, jaOf = c => c.ja || '' } = {}) {
  const keyOf = vid => vid ? vid.mediaRef || vid.id : null;
  return cues.filter(c => c.en).map(c => {
    let key = keyOf(video), offset = 0;
    if (video.kind === 'multi') {
      const part = (video.parts || []).find(p => p.videoId === c.part);
      key = keyOf(parts.get(c.part)); offset = part?.offset || 0;
    }
    const size = sizes.get(key) || null;
    const segs = key ? (c.role === 'example' && c.segments?.length ? c.segments : [{ start: c.start, end: c.end }])
      .map(g => ({ store: 'vblobs', key, sourceKey: 'vblobs:' + key, size, start: round(g.start - offset), end: round(g.end - offset) })) : [];
    const block = studio?.get(c.itemId);
    // Lab alone cannot tell a matched line from a guessed one: only the Studio line (or a hand-fixed time) confirms it.
    const confirmed = block ? studioConfirmed(block) : c.sync === 'manual' || Boolean(c.timeEdited);
    return { id: c.id, itemId: c.itemId, text: c.en, ja: jaOf(c), role: c.role, group: c.studySet, segments: segs, confirmed };
  });
}
export const studioConfirmed = b => Boolean(b.segments?.length) && !b.unconfirmed && b.sync !== 'estimated' && (b.aligned || b.sync === 'manual') && !(b.asr && !b.aligned);
// Studio blocks -> rows (金フレ: a head line starts a group, the following lines are its examples; same rule as the Lab export)
export function studioRows(blocks, sources, { isHead, jaOf = b => b.ja || '' }) {
  let group = '';
  return blocks.filter(b => b.text && !b.asr).map(b => {
    const head = isHead(b);
    if (head) group = b.id;
    const segs = (b.segments || []).map(g => {
      const s = sources[g.sourceId];
      const lab = s?.labRef?.videoId;
      return { store: lab ? 'vblobs' : 'studio', key: lab || g.sourceId, sourceKey: 'src:' + g.sourceId, size: s?.size || s?.blob?.size || null, start: g.start, end: g.end };
    });
    return { id: b.id, itemId: b.id, text: b.text, ja: jaOf(b), role: head ? 'word' : 'example', group: group || null, segments: segs, confirmed: studioConfirmed(b) };
  });
}

// ---------- which recordings are used by the word book ----------
export async function referencedMedia(words = null) {
  words ||= await db.all('words');
  const vblobs = new Map(), studio = new Map();
  for (const w of words) for (const kind of ['word', 'example']) {
    const ref = w.audio?.[kind]; if (!ref?.src?.key) continue;
    const m = ref.src.store === 'studio' ? studio : vblobs;
    if (!m.has(ref.src.key)) m.set(ref.src.key, new Set());
    m.get(ref.src.key).add(w.id);
  }
  return { vblobs, studio };
}
// A recording that a word still uses is never deleted with its material: it stays as "単語帳の音声".
export async function protectReferenced(keys, store = 'vblobs') {
  const used = (await referencedMedia())[store];
  return { remove: keys.filter(k => !used.has(k)), kept: keys.filter(k => used.has(k)) };
}
// vblobs records that no material and no word uses
export async function unusedRecordings() {
  const [videos, files, refs] = await Promise.all([db.all('videos'), db.keys('vblobs'), referencedMedia()]);
  const used = new Set(videos.flatMap(v => [v.id, v.mediaRef].filter(Boolean)));
  const kept = [], unused = [];
  for (const key of files) {
    if (used.has(key)) continue;
    (refs.vblobs.has(key) ? kept : unused).push(key);
  }
  return { kept, unused, refs };
}
// Load the recording behind a reference (null = not found -> the card plays without it)
export async function refBlob(src) {
  if (!src?.key) return null;
  try {
    if (src.store === 'studio') { const { sdb } = await import('./studio-db.js'); const x = await sdb.get('sources', src.key); return x?.blob || (x?.labRef ? (await db.get('vblobs', x.labRef))?.blob : null) || null; }
    return (await db.get('vblobs', src.key))?.blob || null;
  } catch { return null; }
}
