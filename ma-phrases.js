// Local MA phrase data and matching. The vocabulary record is the source of truth.
import { db, getSetting } from './db.js';
import { newWord, newSense, parseCSV } from './words.js';
import { zipRead } from './common-pack.js';
import { labRows, makeRef } from './audio-refs.js';

export const priorities = [1, 2, 3];
export const tokens = text => [...String(text ?? '').matchAll(/[\p{L}\p{N}]+(?:['’‘ʼ`][\p{L}\p{N}]+)*/gu)].map(m => ({
  key: m[0].normalize('NFKC').toLowerCase().replace(/[’‘ʼ`]/g, "'"),
  start: m.index, end: m.index + m[0].length,
}));
const keyOf = text => tokens(text).map(t => t.key).join(' ');
const matches = (list, start, keys) => keys.length > 0 && keys.every((k, i) => list[start + i]?.key === k);
const append = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};
const exampleKey = e => JSON.stringify([e.chapter, e.position, keyOf(e.en), keyOf(e.before), keyOf(e.after)]);

export function parseMA(csv, english = '', japanese = '') {
  const [headers = [], ...rows] = parseCSV(csv);
  const column = (...aliases) => headers.findIndex(h => aliases.includes(h.trim().toLowerCase()));
  const phrase = column('phrase', 'expression', 'フレーズ', '英語表現', '英語フレーズ', '表現');
  const meaning = column('meaning', 'meaning_ja', '意味', '和訳', '日本語訳');
  const priority = column('priority', '優先度', '重要度');
  if ([phrase, meaning, priority].includes(-1)) throw new Error('CSVにフレーズ・意味・優先度の列が必要です');
  const paragraphs = text => text.trim() ? text.trim().split(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/) : [];
  const en = paragraphs(english), ja = paragraphs(japanese);
  if (ja.length && en.length !== ja.length) throw new Error('英文と和訳のTXTを同じ段落数・同じ順序にしてください');
  const paragraphIds = new Map(), paragraphTokens = en.map(tokens), paragraphWords = new Map();
  en.forEach((part, i) => {
    append(paragraphIds, keyOf(part), i);
    for (const t of new Set(paragraphTokens[i].map(x => x.key))) append(paragraphWords, t, i);
  });
  const input = new Map();
  rows.forEach((row, i) => {
    const get = (...aliases) => row[column(...aliases)]?.trim() || '';
    const headword = row[phrase]?.trim(), gloss = row[meaning]?.trim();
    const p = ({ a: 1, b: 2, c: 3, high: 1, medium: 2, low: 3, 高: 1, 中: 2, 低: 3 })[row[priority]?.trim().toLowerCase()] ?? Number(row[priority]?.trim().normalize('NFKC'));
    const id = get('id', 'フレーズid') || keyOf(headword);
    if (!keyOf(headword) || !gloss || !priorities.includes(p)) throw new Error(`CSVのデータ行 ${i + 1} のフレーズ・意味・優先度を確認してください`);
    const item = input.get(id) || { id, headword, gloss, priority: p, examples: [], variants: [] };
    if (keyOf(item.headword) !== keyOf(headword) || item.priority !== p || item.gloss !== gloss) throw new Error(`CSVのID ${id} に異なる項目があります`);
    const source = get('source', '出典');
    const locator = parseSource(source);
    const chapter = get('chapter', '出典章', '章') || locator.chapter;
    const position = get('position', '本文内の位置', '位置') || locator.position;
    const paragraph = get('paragraph', '段落番号');
    const text = get('example_en', '例文（英語）', '英文例', '使用例');
    const hits = paragraphIds.get(keyOf(text)) || [];
    const n = paragraph ? Number(paragraph) - 1 : hits.length === 1 ? hits[0] : -1;
    if (paragraph && (!Number.isInteger(n) || !en[n])) throw new Error(`CSVのデータ行 ${i + 1} の段落番号に対応する英文がありません`);
    const translation = get('example_ja', '例文（日本語）', '例文訳', '対応和訳') || (n >= 0 && (!text || keyOf(text) === keyOf(en[n])) ? ja[n] : '') || '';
    const example = { en: text || (paragraph ? en[n] : ''), ja: translation, chapter, position: position || (n >= 0 ? String(n + 1) : ''),
      before: get('before', '前文'), after: get('after', '後文'), ...(source ? { source } : {}) };
    if (example.en || chapter || position) {
      const k = exampleKey(example);
      const old = item.examples.findIndex(x => exampleKey(x) === k);
      if (old < 0) item.examples.push(example);
      else if (example.ja) item.examples[old] = example;
    }
    item.variants.push(...get('variants', '異形', '本文での形').split('|').map(x => x.trim()).filter(Boolean));
    input.set(id, item);
  });
  if (!input.size) throw new Error('CSVにフレーズがありません');
  // A TXT pair also supports a CSV containing only the glossary. Keep every matching paragraph.
  for (const item of input.values()) if (!item.examples.some(e => e.en)) {
    const locations = new Set();
    for (const keys of patterns({ headword: item.headword, ma: item })) {
      for (const i of paragraphWords.get(keys[0]) || []) {
        if (paragraphTokens[i].some((_, j) => matches(paragraphTokens[i], j, keys))) locations.add(i);
      }
    }
    const chapter = item.examples.length === 1 ? item.examples[0].chapter : '';
    if (locations.size) item.examples = [...locations].sort((a, b) => a - b).map(i => ({
      ...item.examples[0], en: en[i], ja: ja[i] || '', position: item.examples[0]?.position || String(i + 1), chapter, before: '', after: '',
    }));
  }
  return [...input.values()];
}

function parseSource(source) {
  const match = /^(第\d+章|BEFORE_AFTER_CHAPTER_\d+|BEFORE_\d+)(?:（[^）]*）)?\s*(?:\[(\d+)\]|行(\d+))(?:（[^）]*）)?$/i.exec(source);
  return { chapter: match?.[1] || '', position: match?.[2] || match?.[3] || '' };
}

export async function readMAStudyZip(file) {
  const zip = await zipRead(file);
  const paths = ['00_Phrase_List.csv', ...priorities.map(p => `0${p}_English_Japanese.txt`)].map(name => {
    const matches = zip.names.filter(path => path.split('/').at(-1) === name && !path.startsWith('__MACOSX/'));
    if (matches.length !== 1 || zip.entrySize(matches[0]) > 4 * 1024 * 1024) throw Error(`ZIP内の ${name} を確認してください`);
    return matches[0];
  });
  const [csv, ...texts] = await Promise.all(paths.map(path => zip.text(path)));
  const items = parseMA(csv);
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set();
  for (const [i, text] of texts.entries()) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let ln = 0; ln < lines.length; ln++) {
      const id = /^(\d+-\d+)\s/.exec(lines[ln])?.[1];
      if (!id) continue;
      const [variant, en, ja, source] = ['本文の形', '英', '日', '出典'].map((label, j) =>
        new RegExp(`^${label}[\\t 　]+(.+)$`).exec(lines[ln + j + 1])?.[1].trim());
      const item = byId.get(id);
      if (!item || item.priority !== i + 1 || seen.has(id) || !variant || !en || !ja || !source) {
        throw Error(`英日TXTのID ${id} に重複・欠落・優先度の不一致があります`);
      }
      seen.add(id);
      const csvSource = item.examples[0]?.source;
      const locator = parseSource(source);
      item.variants.push(variant);
      item.examples = [{ en, ja, ...locator, before: '', after: '', source,
        ...(csvSource && csvSource !== source ? { csvSource } : {}) }];
      ln += 4;
    }
  }
  if (seen.size !== items.length) throw Error('CSVの全IDに対応する英日TXTの使用例がありません');
  return items;
}

const deckId = p => p ? 'ma-phrases-' + p : 'ma-phrases';
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
export async function importMA(items) {
  return db.tx(['words', 'decks'], 'readwrite', async tx => {
    const words = tx.objectStore('words'), decks = tx.objectStore('decks');
    const groups = [0, ...priorities];
    for (const p of groups) {
      const id = deckId(p);
      if (!await request(decks.get(id))) decks.put({ id, name: p ? `MAフレーズ（優先度${p}）` : 'MAフレーズ', createdAt: Date.now() });
    }
    for (const item of items) {
      // A fixed-width encoding keeps source IDs safe in existing attribute and route consumers.
      const id = 'ma_' + Array.from(new TextEncoder().encode(item.id), b => b.toString(16).padStart(2, '0')).join('');
      const old = await request(words.get(id));
      const examples = new Map((old?.ma?.examples || []).map(e => [exampleKey(e), e]));
      for (const e of item.examples) examples.set(exampleKey(e), e);
      const all = [...examples.values()];
      const sense = newSense({ pos: 'phrase', meanings: [item.gloss], examples: all.filter(e => e.en) });
      const w = old || newWord({ lang: 'en', headword: item.headword, senses: [sense], source: { type: 'ma', note: 'MAフレーズ' } });
      const saved = new Map((w.senses[0]?.examples || []).map(e => [keyOf(e.en), e]));
      w.senses[0] ||= sense;
      for (const e of sense.examples) if (!saved.has(keyOf(e.en)) || !saved.get(keyOf(e.en)).ja) saved.set(keyOf(e.en), e);
      w.senses[0].examples = [...saved.values()];
      w.deckIds = [...new Set([...(w.deckIds || []).filter(d => !groups.some(p => deckId(p) === d)), deckId(), deckId(item.priority)])];
      w.ma = { ...w.ma, priority: item.priority, examples: all, variants: [...new Set([...(w.ma?.variants || []), ...item.variants])] };
      words.put({ ...w, id, isPhrase: true });
    }
    return items.length;
  });
}

export const maMaterial = v => v && (v.lang || 'en') === 'en' &&
  (v.materialType === 'prose' || (!v.materialType && looksLikeMA(v)));
export const looksLikeMA = v => /\bmaster\s+(?:(?:and|[&＆])\s+)?apprentice\b|マスター[＆&と・ ]*アプレンティス/i.test([v.name, v.folder].join(' '));
export async function chapterFor(v) {
  const saved = await getSetting('ma.chapter.' + v.id, null);
  if (saved != null) return saved;
  if (!looksLikeMA(v)) return null;
  return /(?:chapter|ch|第)[. _-]*0*(\d+)/i.exec(v.name)?.[1] || v.name;
}
export const chapterKey = text => keyOf(text).replace(/\b(?:chapter|ch) 0*(\d+)\b|第\s*0*(\d+)\s*章/g, (_, en, ja) => en || ja)
  .replace(/^0+(?=\d)/, '');
const patterns = w => [...new Set([w.headword, ...w.ma.variants].map(keyOf))].filter(Boolean).map(x => x.split(' '));
export function phraseIndex(words) {
  const index = new Map();
  index.maxLength = 0;
  for (const w of words) if (w.ma) for (const keys of patterns(w)) {
    append(index, keys[0], { w, keys });
    index.maxLength = Math.max(index.maxLength, keys.length);
  }
  return index;
}

const joinable = (left, right) => left && right && left.part === right.part &&
  right.start >= left.start && right.start - left.end <= 2;

export function highlightRanges(cues, first, last, index, allowed) {
  const lookaround = Math.max(0, index.maxLength - 1);
  const begin = Math.max(0, first - lookaround), finish = Math.min(cues.length, last + lookaround);
  const stream = [], hits = [];
  for (let i = begin; i < finish; i++) {
    if (i > begin && !joinable(cues[i - 1], cues[i])) stream.push({ key: null });
    stream.push(...tokens(cues[i].en).map(t => ({ ...t, line: i })));
  }
  stream.forEach((t, start) => {
    for (const { w, keys } of index.get(t.key) || []) {
      if (allowed.includes(w.ma.priority) && matches(stream, start, keys)) hits.push({ start, length: keys.length, w });
    }
  });
  hits.sort((a, b) => b.length - a.length || a.start - b.start || a.w.ma.priority - b.w.ma.priority);
  const occupied = new Set(), result = new Map();
  for (const { start, length, w } of hits) {
    const indices = Array.from({ length }, (_, i) => start + i);
    if (indices.some(i => occupied.has(i))) continue;
    indices.forEach(i => occupied.add(i));
    const lines = new Map();
    for (const i of indices) {
      const t = stream[i], r = lines.get(t.line);
      if (r) r.end = t.end;
      else lines.set(t.line, { start: t.start, end: t.end, id: w.id });
    }
    for (const [line, range] of lines) if (line >= first && line < last) append(result, cues[line].id, range);
  }
  for (const ranges of result.values()) ranges.sort((a, b) => a.start - b.start);
  return result;
}

export function cueIndex(cues) {
  const stream = [], starts = new Map();
  for (const [line, cue] of cues.entries()) {
    if (line && !joinable(cues[line - 1], cue)) stream.push({ key: null });
    for (const t of tokens(cue.en)) {
      append(starts, t.key, stream.length);
      stream.push({ ...t, line });
    }
  }
  return { stream, starts };
}

function matchingStarts(stream, starts, keys) {
  let anchor = 0;
  for (let i = 1; i < keys.length; i++) {
    if ((starts.get(keys[i])?.length || 0) < (starts.get(keys[anchor])?.length || 0)) anchor = i;
  }
  return (starts.get(keys[anchor]) || []).map(i => i - anchor).filter(i => matches(stream, i, keys));
}
const stamp = c => [c.id, c.en, c.start, c.end, c.part, Boolean(c.maAligned), c.wordTimings || null, c.sync || null, Boolean(c.timeEdited)];
function boundary(cue, token, edge, segment) {
  const line = tokens(cue.en);
  const at = line.findIndex(t => t.start === token.start);
  const words = cue.wordTimings;
  if (words?.length === line.length && words.every((w, i) => keyOf(w.text) === line[i].key &&
      Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= cue.start - .002 &&
      w.end <= cue.end + .002 && w.end > w.start && (!i || w.start >= words[i - 1].end - .002))) {
    return +Math.max(segment.start, Math.min(segment.end, words[at][edge] + segment.start - cue.start)).toFixed(3);
  }
  if (edge === 'start' && at === 0) return segment.start;
  if (edge === 'end' && at === line.length - 1) return segment.end;
  return null;
}
export function linkChapter(words, cues, video, rows, chapter) {
  const { stream, starts } = cueIndex(cues);
  const byId = new Map(rows.map(r => [r.id, r]));
  return words.map(w => {
    const examples = w.ma.examples.filter(e => !e.chapter || chapterKey(e.chapter) === chapterKey(chapter));
    const variants = patterns(w);
    const found = [], candidates = [];
    for (const e of examples) {
      const keys = keyOf(e.en).split(' ').filter(Boolean);
      if (!keys.length) continue;
      const before = keyOf(e.before).split(' ').filter(Boolean), after = keyOf(e.after).split(' ').filter(Boolean);
      const occurrences = matchingStarts(stream, starts, keys).filter(i =>
        (!before.length || matches(stream, i - before.length, before)) &&
        (!after.length || matches(stream, i + keys.length, after)));
      if (occurrences.length !== 1) {
        if (occurrences.length) candidates.push(exampleKey(e));
        continue;
      }
      const i = occurrences[0], first = stream[i], last = stream[i + keys.length - 1];
      const slice = cues.slice(first.line, last.line + 1);
      const segments = slice.map(c => byId.get(c.id));
      const media = segments[0]?.segments[0];
      if (!media || !segments.every((r, j) => r?.confirmed && r.segments.length === 1 && r.segments[0].key === media.key &&
            r.segments[0].start >= 0 && r.segments[0].end > r.segments[0].start && r.segments[0].size &&
            (!j || r.segments[0].start >= segments[j - 1].segments[0].end - .08))) {
        candidates.push(exampleKey(e));
        continue;
      }
      const start = boundary(slice[0], first, 'start', media);
      const end = boundary(slice.at(-1), last, 'end', segments.at(-1).segments[0]);
      if (start == null || end == null || end - start < .08) {
        candidates.push(exampleKey(e));
        continue;
      }
      const ref = makeRef({ ...media, start, end, limit: { min: start, max: end }, state: 'confirmed',
        origin: { from: 'lab', materialId: video.id, cueId: slice[0].id, title: video.name, text: e.en } });
      const occurrencesInExample = [];
      for (let offset = 0; offset < keys.length; offset++) for (const variant of variants) {
        if (offset + variant.length <= keys.length && matches(stream, i + offset, variant)) occurrencesInExample.push([offset, variant.length]);
      }
      // A cue boundary is sufficient when the matched phrase covers that cue (or entire cues).
      let phrase = null;
      if (occurrencesInExample.length === 1) {
        const [offset, length] = occurrencesInExample[0];
        const startToken = stream[i + offset], endToken = stream[i + offset + length - 1];
        const a = cues[startToken.line], b = cues[endToken.line];
        const start = boundary(a, startToken, 'start', byId.get(a.id).segments[0]);
        const finish = boundary(b, endToken, 'end', byId.get(b.id).segments[0]);
        if (start != null && finish != null && finish - start >= .08) {
          const origin = { ...ref.origin, cueId: a.id };
          phrase = { ...ref, origin, start, end: finish, limit: { min: start, max: finish } };
        }
      }
      found.push({ key: exampleKey(e), ref, phrase, cues: slice.map(stamp) });
    }
    if ((!w.ma.examples.length || examples.length) && !found.length && variants.some(keys => matchingStarts(stream, starts, keys).length)) candidates.push('');
    return { id: w.id, found, candidates };
  });
}

export async function indexChapter(videoId, chapter) {
  const { loadLabMaterial } = await import('./audio-words-ui.js');
  const { video, cues, rows } = await loadLabMaterial(videoId);
  if (!maMaterial(video)) return null;
  const cuesById = new Map(cues.map(c => [c.id, c]));
  for (const row of rows) {
    const cue = cuesById.get(row.id);
    if (cue?.maAligned && cue.sync !== 'estimated') row.confirmed = true;
  }
  const words = (await db.all('words')).filter(w => w.ma);
  await new Promise(resolve => setTimeout(resolve, 0));
  const plan = linkChapter(words, cues, video, rows, chapter);
  const snapshots = new Map(words.map(w => [w.id, w]));
  await db.tx(['words'], 'readwrite', async tx => {
    const store = tx.objectStore('words');
    for (const item of plan) {
      const previous = snapshots.get(item.id);
      if (!item.found.length && !item.candidates.length && !previous.ma.chapters?.[video.id]) continue;
      const w = await request(store.get(item.id));
      if (!w?.ma || JSON.stringify(w.ma.examples) !== JSON.stringify(previous.ma.examples) ||
          JSON.stringify(patterns(w)) !== JSON.stringify(patterns(previous))) continue;
      const old = w.ma.chapters?.[video.id];
      for (const link of item.found) {
        const existing = old?.found.find(l => l.key === link.key && JSON.stringify(l.cues) === JSON.stringify(link.cues) &&
          l.ref.src.key === link.ref.src.key && l.ref.src.size === link.ref.src.size);
        if (existing) {
          link.ref.at = existing.ref.at;
          if (link.phrase && existing.phrase) link.phrase.at = existing.phrase.at;
          if (existing.manual) link.manual = existing.manual;
        }
      }
      const entry = { found: item.found, candidates: item.candidates, stale: Boolean(old?.stale || old?.found.length) && !item.found.length };
      if (JSON.stringify(old) === JSON.stringify(entry)) continue;
      w.ma.chapters = { ...w.ma.chapters, [video.id]: entry };
      store.put(w);
    }
  });
  return plan.reduce((n, x) => n + x.found.length, 0);
}

export function maLinks(w, videoId = null, allowAmbiguous = false) {
  const entries = Object.entries(w.ma?.chapters || {}).filter(([id]) => !videoId || id === videoId);
  const grouped = new Map();
  for (const [, entry] of entries) for (const link of entry.found) {
    const same = grouped.get(link.key)?.some(l => l.ref.src.key === link.ref.src.key && l.ref.start === link.ref.start && l.ref.end === link.ref.end);
    if (!same) append(grouped, link.key, link);
  }
  // The same body example discovered in several assets requires a material choice.
  return [...grouped.values()].flatMap(links => !videoId && !allowAmbiguous && links.length > 1 ? [] : links);
}

export async function validMALink(link) {
  const v = await db.get('videos', link.ref.origin.materialId);
  if (!v) return false;
  const part = link.cues[0][4];
  const asset = v.kind === 'multi' && v.parts?.some(p => p.videoId === part) ? await db.get('videos', part) : v.kind === 'multi' ? null : v;
  if (!asset || (asset.mediaRef || asset.id) !== link.ref.src.key) return false;
  const rows = await Promise.all(link.cues.map(([id]) => db.get('cues', id)));
  if (rows.some((c, i) => !c || JSON.stringify(stamp(c)) !== JSON.stringify(link.cues[i]))) return false;
  const blob = await db.get('vblobs', link.ref.src.key);
  return Boolean(blob?.blob && blob.blob.size === link.ref.src.size);
}

export async function playMA(w, kind = 'word', { link = null, onEnd = null, active = () => true } = {}) {
  link ||= maLinks(w).find(l => kind === 'example' || l.manual?.state === 'confirmed' || l.phrase);
  const ref = kind === 'example' ? link?.ref : link?.manual?.state === 'confirmed' ? link.manual : link?.phrase;
  if (!ref || !await validMALink(link) || !active()) { onEnd?.(); return false; }
  const { playRef } = await import('./word-audio.js');
  if (!active()) { onEnd?.(); return false; }
  return playRef(ref, { onEnd });
}

export async function saveMABoundary(wordId, link, start, end, confirmed) {
  const { ref } = link;
  if (start < ref.start || end > ref.end || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.08) {
    throw new Error('使用例の範囲内で、終了を開始より0.08秒以上あとに設定してください');
  }
  if (!await validMALink(link)) throw new Error('参照切れです。教材を再照合してください');
  await db.tx(['words'], 'readwrite', async tx => {
    const store = tx.objectStore('words'), w = await request(store.get(wordId));
    const live = w?.ma?.chapters?.[ref.origin.materialId]?.found.find(l => l.key === link.key && JSON.stringify(l.cues) === JSON.stringify(link.cues));
    if (!live) throw new Error('参照が変わりました。画面を開き直してください');
    live.manual = { ...ref, start, end, limit: { min: start, max: end }, state: confirmed ? 'confirmed' : 'unconfirmed' };
    store.put(w);
  });
}
