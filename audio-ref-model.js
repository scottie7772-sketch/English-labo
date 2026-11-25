// 単語に付ける音声参照のモデル（DBに触れない葉のモジュール）。audio-refs.js（保存・解決）と vocab-audio-core.js（判定・抽出）の両方が使う。
// ref = { v: 1, src: { store: 'vblobs' | 'studio', key, size }, start, end, limit: { min, max },
//         origin: { from, materialId, cueId?, itemId?, text, title? }, state: 'confirmed' | 'unconfirmed', at, manual?, snapped?, orig? }
export const REF_VERSION = 1;
export const round = t => Math.round(t * 1000) / 1000;
export const normEn = t => String(t || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
// A word's sound by kind. word = the headword, example = one of its example sentences, sentence = a whole sentence / utterance.
// The three are independent: each one can be missing without affecting the others.
export const wordAudio = (w, kind) => {
  const ref = w?.audio?.[kind];
  if (!usableRef(ref)) return null;
  const has = (text) => (w.senses || []).some(s => (s.examples || []).some(x => sameText(x.en, text)));
  // the example sound belongs to one example: it is used only while that example is still the word's example
  if (kind === 'example' && !has(ref.origin?.text)) return null;
  if (kind === 'sentence' && !(sameText(w.headword, ref.origin?.text) || has(ref.origin?.text))) return null;
  return ref;
};
// One rule for every screen (cards, detail, list): which stored reference plays for this word and kind.
//   word     -> audio.word, or the sentence sound when the headword IS that sentence (文章・発話全体 mode)
//   example  -> audio.example, or the sentence sound of one of its examples (会話・朗読)
// Returns { ref, via } or null (the caller decides what to say; it never searches other materials here).
export function resolveRef(w, kind = 'word') {
  const direct = wordAudio(w, kind);
  if (direct) return { ref: direct, via: kind };
  const sentence = wordAudio(w, 'sentence');
  if (sentence && (kind === 'word' ? sameText(w.headword, sentence.origin?.text) : kind === 'example')) return { ref: sentence, via: 'sentence' };
  return null;
}
