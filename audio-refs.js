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

export * from './audio-ref-model.js';
import { round, normEn, sameText, pickReading, limitsFor, makeRef } from './audio-ref-model.js';

// ---------- registration plan (no writes) ----------
// items: { key, head, ja, example, exampleJa, word, ex, sentence }  (word / ex / sentence = ref | null; see vocab-audio-core toRegistration)
// mode 'merge': existing entries get the audio, missing ones are added; 'audio': only existing entries get audio.
// onlyConfirmed (default): an item whose headword sound is not confirmed yet is NOT registered; run it again later and the
// audio is added to the entry that exists by then. onlyConfirmed:false registers the entry with the unconfirmed sound kept aside.
// An entry is "the same" when the headword matches and either a meaning or the example sentence matches;
// the same headword with another meaning and another example is a different entry (added separately).
// A reference that a person adjusted or confirmed by hand (ref.manual) is never replaced.
const KINDS = [['word', 'word'], ['example', 'ex'], ['sentence', 'sentence']];
const sameOrigin = (a, b) => Boolean(a.origin && b.origin && a.origin.materialId === b.origin.materialId && (a.origin.cueId ?? a.origin.itemId) === (b.origin.cueId ?? b.origin.itemId));
export function planAudioWords(items, existing, { mode = 'merge', replace = false, lang = 'en', tags = [], source = {}, onlyConfirmed = true, primary = 'word', headOnly = false } = {}) {
  const byHead = new Map();
  for (const w of existing) { if ((w.lang || 'en') !== lang) continue; const k = headKey(w.headword); if (!byHead.has(k)) byHead.set(k, []); byHead.get(k).push(w); }
  const exOf = w => (w.senses || []).flatMap(s => s.examples || []).map(x => x.en);
  const out = { add: [], update: [], skip: [], pending: [], dupes: [], counts: { items: items.length, wordAudio: 0, exampleAudio: 0, sentenceAudio: 0, unconfirmed: 0, missing: 0 } };
  const seen = new Map();
  for (const it of items) {
    const c = out.counts, main = primary === 'sentence' ? it.sentence : it.word;
    if (it.word?.state === 'confirmed') c.wordAudio++;
    if (it.ex?.state === 'confirmed') c.exampleAudio++;
    if (it.sentence?.state === 'confirmed') c.sentenceAudio++;
    if ([it.word, it.ex, it.sentence].some(r => r?.state === 'unconfirmed')) c.unconfirmed++;
    if (!main || (it.example && !it.ex && primary !== 'sentence')) c.missing++;
    const meanings = splitList(it.ja);
    const key = headKey(it.head) + '\u0001' + normEn(it.example);
    if (seen.has(key)) { out.skip.push({ item: it, reason: '同じ教材内で重複' }); continue; }
    seen.set(key, it);
    let same = (byHead.get(headKey(it.head)) || []).filter(w =>
      (it.example && exOf(w).some(en => sameText(en, it.example))) || (meanings.length && meaningsOf(w).some(m => meanings.includes(m))) ||
      (!meaningsOf(w).length && !exOf(w).length));
    // 見出し語が1つしかない単語なら、意味・例文が違っていても同じ語とみなす（headOnly: 別の経路で追加した単語に音声を付けるとき）
    if (!same.length && headOnly) { const only = byHead.get(headKey(it.head)); if (only?.length === 1) same = only; }
    if (same.length > 1) out.dupes.push({ item: it, words: same });
    // 登録に使う音声は、確定したものだけ（onlyConfirmed:false のときは未確定も手元に残す）
    const usable = ref => ref && (ref.state === 'confirmed' || !onlyConfirmed) ? ref : null;
    if (same.length) {
      const target = same.find(w => !w.audio?.word && !w.audio?.example && !w.audio?.sentence) || same[0];
      const audio = { ...(target.audio || {}) };
      let changed = false;
      for (const [kind, field] of KINDS) {
        const ref = usable(it[field]);
        if (!ref) continue;
        const old = audio[kind];
        if (old?.manual) continue;                                                    // 手で直した・確定した音声は置き換えない
        // 同じ教材の同じ行の境界があとから直されたときは、自動で登録した音声を新しい範囲に合わせる（手で直したものは対象外）
        const moved = old && sameOrigin(old, ref) && ref.state === 'confirmed' && (Math.abs(old.start - ref.start) > .05 || Math.abs(old.end - ref.end) > .05 || old.src.key !== ref.src.key);
        if (old && !replace && !moved && !(old.state !== 'confirmed' && ref.state === 'confirmed')) continue;
        if (kind === 'example' && !exOf(target).some(en => sameText(en, ref.origin.text))) continue;   // only the example the entry has
        audio[kind] = ref; changed = true;
      }
      if (changed) out.update.push({ item: it, word: target, audio }); else out.skip.push({ item: it, reason: '音声は登録済み', wordId: target.id });
      continue;
    }
    if (mode === 'audio') { out.skip.push({ item: it, reason: '単語帳にない語（音声だけ追加の対象外）' }); continue; }
    if (onlyConfirmed && !(main && main.state === 'confirmed')) { out.pending.push({ item: it, reason: '音声が未確定のため登録しません（確定後にもう一度実行すると追加されます）' }); continue; }
    const w = newWord({ lang, headword: it.head, tags, source, senses: [newSense({ meanings, examples: it.example ? [{ en: it.example, ja: it.exampleJa || '' }] : [] })] });
    const audio = {};
    for (const [kind, field] of KINDS) { const ref = usable(it[field]); if (ref) audio[kind] = ref; }
    if (Object.keys(audio).length) w.audio = audio;
    out.add.push({ item: it, word: w });
  }
  return out;
}
// one transaction per call (callers run materials one by one, so memory stays small).
// Returns which word each item became (item.key -> word id), so a later run can tell "registered" from "still to do".
export async function applyAudioWords(plan) {
  const now = Date.now();
  await db.tx(['words'], 'readwrite', t => {
    const os = t.objectStore('words');
    for (const { word } of plan.add) os.put({ ...word, createdAt: word.createdAt || now, updatedAt: now });
    for (const { word, audio } of plan.update) os.put({ ...word, audio, updatedAt: now });
  });
  const ids = new Map();
  for (const { item, word } of [...plan.add, ...plan.update]) if (item.key) ids.set(item.key, word.id);
  for (const x of plan.skip) if (x.item?.key && x.wordId) ids.set(x.item.key, x.wordId);
  return { added: plan.add.length, updated: plan.update.length, ids };
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
    // 1.19.42: a Studio→Lab transfer now carries "confirmed" (aligned script line) / "asr" (raw recognition) with each cue.
    const confirmed = block ? studioConfirmed(block) : c.confirmed === true || c.maAligned === true || c.sync === 'manual' || Boolean(c.timeEdited);
    return { id: c.id, itemId: c.itemId, text: c.en, ja: jaOf(c), role: c.role, group: c.studySet, segments: segs, confirmed,
      estimated: c.sync === 'estimated', manual: c.sync === 'manual' || Boolean(c.timeEdited), asr: c.asr === true && !confirmed, rep: c.role === 'example' && c.segments?.length > 1 ? c.segments.length : undefined,
      wordTimings: c.wordTimings };
  });
}
export const studioConfirmed = b => Boolean(b.segments?.length) && !b.unconfirmed && b.sync !== 'estimated' && (b.aligned || b.sync === 'manual') && !(b.asr && !b.aligned);
// Studio blocks -> rows (金フレ: a head line starts a group, the following lines are its examples; same rule as the Lab export)
// explicitRoles: only a material that declares its structure (金フレ型: materialType vocab / kind word|example) gets roles and groups;
// for the others the structure is read from the text itself (vocab-audio-core), so every line does not look like it "has a role".
export function studioRows(blocks, sources, { isHead, jaOf = b => b.ja || '', explicitRoles = true }) {
  let group = '';
  return blocks.filter(b => b.text && !b.asr).map(b => {
    const head = explicitRoles && isHead(b);
    if (head) group = b.id;
    const segs = (b.segments || []).map(g => {
      const s = sources[g.sourceId];
      const lab = s?.labRef?.videoId;
      return { store: lab ? 'vblobs' : 'studio', key: lab || g.sourceId, sourceKey: lab ? 'vblobs:' + lab : 'src:' + g.sourceId, size: s?.size || s?.blob?.size || null, start: g.start, end: g.end };   // sourceKey = the recording itself, whichever store holds it
    });
    return { id: b.id, itemId: b.id, text: b.text, ja: jaOf(b), ...(explicitRoles ? { role: head ? 'word' : 'example', group: group || null } : {}), segments: segs, confirmed: studioConfirmed(b),
      estimated: b.sync === 'estimated', manual: b.sync === 'manual', rep: b.rep, wordTimings: b.wordTimings,
      ...(b.lineage?.op === 'structure-assign' ? { structure: true } : {}) };   // 発話区間の構造から割り当てた行（文字起こしの時刻は粗いので、文字起こしとの食い違いでは確信度を下げない）
  });
}
// Raw recognition lines (文字起こし) of a Studio set: the evidence for the local re-check. Never script text.
export function studioEvidence(blocks, sources) {
  return blocks.filter(b => b.asr && !b.aligned && b.text?.trim() && b.segments?.length === 1 && b.sync !== 'manual').map(b => {
    const g = b.segments[0], s = sources[g.sourceId], lab = s?.labRef?.videoId;
    return { id: b.id, text: b.text, start: g.start, end: g.end, sourceKey: lab ? 'vblobs:' + lab : 'src:' + g.sourceId, store: lab ? 'vblobs' : 'studio', key: lab || g.sourceId, size: s?.size || s?.blob?.size || null,
      ...(Array.isArray(b.wordTimings) ? { wordTimings: b.wordTimings } : {}) };
  });
}
// The same for a Lab material (only cues that the transfer marked as raw recognition; older transfers carry no such mark).
export function labEvidence(video, cues, { sizes = new Map() } = {}) {
  const key = video.mediaRef || video.id;
  return cues.filter(c => c.asr === true && c.confirmed !== true && c.en?.trim() && video.kind !== 'multi').map(c => ({ id: c.id, text: c.en, start: c.start, end: c.end, sourceKey: 'vblobs:' + key, store: 'vblobs', key, size: sizes.get(key) || null }));
}

// ---------- which recordings are used by the word book ----------
export async function referencedMedia(words = null) {
  words ||= await db.all('words');
  const vblobs = new Map(), studio = new Map();
  for (const w of words) for (const kind of ['word', 'example', 'sentence']) {
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
