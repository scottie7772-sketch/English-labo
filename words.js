// Word data operations, parsing (bulk / CSV), seed data
import { db, uid, getMeta, setMeta } from './db.js';
import { SKILLS, setManual, mid } from './mastery.js';
import { curLang, langOf, isZh } from './langs.js';

// words of one learning language (words without lang = English)
export async function allWords(lang = curLang()) { return (await db.all('words')).filter((w) => langOf(w) === lang); }

export const normHead = (s) => String(s || '').replace(/[　\s]+/g, ' ').trim();
export const headKey = (s) => normHead(s).toLowerCase();
export const splitList = (s) => String(s || '').split(/\s*[\/／;；、,，]\s*/).map((x) => x.trim()).filter(Boolean);

export function newSense({ pos = '', meanings = [], accepted = [], context = '', examples = [] } = {}) {
  return { id: uid('s_'), pos, meanings, accepted, context, examples };
}

export function newWord({ headword, senses, tags = [], deckIds = [], bookmarked = false, ipa = '', source = { type: 'manual' }, lang = null }) {
  const h = normHead(headword);
  const now = Date.now();
  return {
    id: uid('w_'), lang: lang || curLang(), headword: h, isPhrase: /\s/.test(h), ipa,
    senses: senses?.length ? senses : [newSense()],
    tags, deckIds, bookmarked: !!bookmarked, bookmarkedNum: bookmarked ? 1 : 0,
    source, createdAt: now, updatedAt: now,
  };
}

export async function saveWord(w) {
  w.headword = normHead(w.headword);
  w.isPhrase = /\s/.test(w.headword);
  w.bookmarkedNum = w.bookmarked ? 1 : 0;
  w.updatedAt = Date.now();
  await db.put('words', w);
  return w;
}

export async function toggleBookmark(id) {
  const w = await db.get('words', id);
  if (!w) return null;
  w.bookmarked = !w.bookmarked;
  await saveWord(w);
  return w.bookmarked;
}

// Learning history (attempts, masteryChanges) is kept; per-word mastery & schedule are removed.
export async function deleteWord(id) {
  await db.tx(['words', 'mastery', 'reviews'], 'readwrite', (t) => {
    t.objectStore('words').delete(id); t.objectStore('reviews').delete(id);
    for (const s of SKILLS) { t.objectStore('mastery').delete(mid(id, s)); t.objectStore('reviews').delete(mid(id, s)); }
  });
}

export async function existingHeadMap() {
  const map = new Map();
  for (const w of await allWords()) map.set(headKey(w.headword), w);
  return map;
}

// ---- bulk text: one per line "headword, 意味1/意味2" / "headword<TAB>意味" / "headword 意味"（英語のあとに日本語） ----
// A leading number ("1.", "12)", "3 ") before the word is treated as numbering and removed.
const JA_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
export const hasJa = (s) => JA_RE.test(String(s || ''));
export const hasKana = (s) => /[぀-ヿ]/.test(String(s || ''));
const isNumOnly = (s) => /^\s*[#No.\s]*\d+\s*[.)）:：]?\s*$/i.test(String(s || ''));
export function parseBulk(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1 && isNumOnly(parts[0])) parts.shift();         // "12<TAB>word<TAB>意味"
    line = parts.join('\t');
    line = line.replace(/^\d+\s*[.)）:：]\s*/, '').replace(/^\d+\s+(?=[A-Za-z¿¡])/, '');   // "12. word" / "12 word"
    let m = line.match(/^(.+?)\s*(?:\t|,|，|:|：|=|\s-\s|\s–\s)\s*(.*)$/);
    if (!m) {   // "put off 延期する": split where Japanese starts (Latin-script words only)
      const k = line.search(JA_RE);
      if (k > 0 && !hasJa(line.slice(0, k))) m = [line, line.slice(0, k).trim(), line.slice(k).trim()];
    }
    const head = m ? m[1] : line;
    out.push({ headword: normHead(head), meanings: m ? splitList(m[2].replace(/\t/g, '/')) : [] });
  }
  return out.filter((e) => e.headword);
}

// Problems of one entry / word (used by the import preview and the data check). Nothing is filled in automatically.
export function entryIssues(e, lang = 'en') {
  const out = [];
  const head = e.headword || '', ms = e.meanings || [];
  const ex = e.example_en ?? '';
  if (!head.trim()) out.push('見出し語がありません');
  else if (isNumOnly(head)) out.push('見出し語が数字だけです（番号の列を読んだ可能性）');
  else if (/^(no|番号|id|headword|word|英語|単語|英単語|熟語|句動詞|meaning|意味)$/i.test(head.trim())) out.push('見出し行（列名）を単語として読んだ可能性');
  if (!isZh(lang) && hasJa(head)) out.push('見出し語に日本語が入っています');
  if (ms.length && !ms.some(hasJa)) out.push('意味に日本語がありません');
  if (ex && hasKana(ex) && !isZh(lang)) out.push('例文の欄に日本語が入っています');
  return out;
}

// ---- CSV ----
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLS = {
  headword: ['headword', 'word', 'english', 'en', 'term', 'phrase', 'phrasal verb', 'phrasal', 'expression', 'idiom', 'vocabulary', 'vocab', 'spanish', 'chinese', 'hanzi', '英語', '単語', '英単語', '見出し語', '見出し', '熟語', '英熟語', '句動詞', 'イディオム', '表現', '英語表現', '単語・熟語', 'スペイン語', '華語', '中国語', '漢字'],
  meanings: ['meanings', 'meaning', 'japanese', 'ja', 'translation', 'definition', '意味', '日本語', '日本語訳', '訳', '和訳', '日本語の意味'],
  pos: ['pos', 'part of speech', '品詞'],
  example_en: ['example_en', 'example', 'sentence', '例文', '英文例'],
  example_ja: ['example_ja', 'example translation', '例文訳', '例文の日本語訳', '例文（日本語）', '和訳例文'],
  tags: ['tags', 'tag', 'タグ', 'カテゴリ'],
  bookmarked: ['bookmarked', 'bookmark', 'ブックマーク'],
  accepted: ['accepted', '別解', '許容解答'],
  ipa: ['ipa', '発音記号', 'pinyin', 'ピンイン', 'reading', '読み'],
  lang: ['lang', 'language', '言語'],
  gender: ['gender', '性'],
};

// CSV analysis: header detection, number column detection, content-based fallback.
// Returns { entries, columns: [{name, sample}], map: {field: colIndex}, header: bool, indexCols: [i], notes: [] }
export function analyzeCSV(text, overrideMap = null) {
  const rows = parseCSV(text);
  const res = { entries: [], columns: [], map: {}, header: false, indexCols: [], notes: [], rows: rows.length };
  if (!rows.length) { res.notes.push('ファイルに読み取れる行がありません（空、またはCSVではない形式）'); return res; }
  const width = Math.max(...rows.map((r) => r.length));
  const head = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex((h) => names.includes(h));
  // header row = any recognised column name, or a first row whose cells are all non-numeric while a column below is numeric
  const body0 = rows.slice(1);
  const numericCol = (c, list) => list.length > 0 && list.every((r) => /^\s*\d+\s*$/.test(r[c] || ''));
  let header = Object.values(idx).some((i) => i >= 0);
  if (!header && rows.length > 1) for (let c = 0; c < width; c++) if (numericCol(c, body0) && !/^\s*\d+\s*$/.test(rows[0][c] || '')) header = true;
  const body = header ? body0 : rows;
  res.header = header;
  for (let c = 0; c < width; c++) if (numericCol(c, body) && idx.headword !== c) res.indexCols.push(c);
  const col = (c) => body.map((r) => String(r[c] || '').trim()).filter(Boolean);
  const share = (c, f) => { const v = col(c); return v.length ? v.filter(f).length / v.length : 0; };
  const free = () => [...Array(width).keys()].filter((c) => !res.indexCols.includes(c) && !Object.values(map).includes(c));
  const map = {};
  for (const [k, i] of Object.entries(idx)) if (i >= 0 && !res.indexCols.includes(i)) map[k] = i;
  // content-based guess for missing headword / meanings / examples
  const latin = (x) => /[A-Za-zÀ-ÿ]/.test(x) && !hasKana(x);
  const sentence = (x) => x.split(/\s+/).length >= 4;
  if (map.headword == null) { const c = free().find((c) => share(c, (x) => latin(x) && !sentence(x)) >= 0.6) ?? free().find((c) => share(c, latin) >= 0.6) ?? free()[0]; if (c != null) map.headword = c; }
  if (map.meanings == null) { const c = free().find((c) => share(c, hasJa) >= 0.6 && share(c, (x) => x.length <= 40) >= 0.6); if (c != null) map.meanings = c; }
  if (map.example_en == null) { const c = free().find((c) => share(c, (x) => latin(x) && sentence(x)) >= 0.5); if (c != null) map.example_en = c; }
  if (map.example_ja == null && map.example_en != null) { const c = free().find((c) => share(c, hasJa) >= 0.5); if (c != null) map.example_ja = c; }
  if (overrideMap) { for (const k of Object.keys(map)) delete map[k]; for (const [k, v] of Object.entries(overrideMap)) if (v != null && v !== '' && v >= 0) map[k] = +v; }
  res.map = map;
  res.columns = [...Array(width).keys()].map((c) => ({ name: header ? rows[0][c] || `列${c + 1}` : `列${c + 1}`, sample: col(c).slice(0, 2).join(' / ') }));
  if (res.indexCols.length) res.notes.push(`番号の列（${res.indexCols.map((c) => res.columns[c].name).join('・')}）は読み飛ばしました`);
  if (!header) res.notes.push('1行目に列名がないため、中身から列を判断しました');
  const get = (r, k) => (map[k] != null ? String(r[map[k]] || '').trim() : '');
  res.entries = body.map((r) => ({
    headword: normHead(get(r, 'headword')),
    meanings: splitList(get(r, 'meanings')),
    pos: get(r, 'pos'), example_en: get(r, 'example_en'), example_ja: get(r, 'example_ja'),
    tags: splitList(get(r, 'tags')), accepted: splitList(get(r, 'accepted')), ipa: get(r, 'ipa'), lang: normLangCode(get(r, 'lang')), gender: get(r, 'gender'),
    bookmarked: /^(1|true|yes|y|済|○|★)$/i.test(get(r, 'bookmarked')),
  })).filter((e) => e.headword);
  if (!res.entries.length) res.notes.push(map.headword == null ? '英語の列が見つかりませんでした' : '英語の列が空です');
  return res;
}
export function csvToEntries(text) { return analyzeCSV(text).entries; }

const normLangCode = (s) => { s = String(s || '').trim().toLowerCase(); if (!s) return ''; if (/^(es|spa|spanish|スペイン語|西)/.test(s)) return 'es'; if (/^(zh-cn|zh-hans|cn$|普通|中国語|中文|简体|簡体|中$)/.test(s)) return 'zh-CN'; if (/^(zh|華|台湾|繁体|chinese|mandarin)/.test(s)) return 'zh-TW'; if (/^(en|英)/.test(s)) return 'en'; return ''; };
export function entryToWord(e, source, extra = {}) {
  const sense = newSense({ pos: e.pos || '', context: e.context || '', meanings: e.meanings || [], accepted: e.accepted || [], examples: e.example_en ? [{ en: e.example_en, ja: e.example_ja || '', ...(e.answer ? { answer: e.answer } : {}) }] : [] });
  if (e.gender) sense.gender = e.gender;
  const w = newWord({
    lang: e.lang || extra.lang || curLang(),
    headword: e.headword, ipa: e.ipa || '',
    senses: [sense],
    tags: [...new Set([...(e.tags || []), ...(extra.tags || [])])], deckIds: extra.deckIds || [],
    bookmarked: e.bookmarked || extra.bookmarked || false, source,
  });
  for (const k of ['kind', 'phrasal', 'swipe', 'origin', 'review']) if (e[k] != null) w[k] = e[k];
  return w;
}

// ---- One item = headword + ONE meaning group (similar translations may share an item) ----
// Same headword with a different meaning = a separate item. Duplicate = same headword and an overlapping meaning.
export const meaningsOf = (w) => (w.senses || []).flatMap((s) => s.meanings || []);
const normM = (m) => String(m).replace(/[\s　（）()〜~・、,]/g, '');
export function meaningsOverlap(a, b) {
  if (!a.length || !b.length) return true;            // no meaning given -> treat as the same item
  const B = new Set(b.map(normM));
  return a.some((m) => B.has(normM(m)));
}
export async function wordsByHead(lang = curLang()) {
  const map = new Map();
  for (const w of await allWords(lang)) { const k = headKey(w.headword); if (!map.has(k)) map.set(k, []); map.get(k).push(w); }
  return map;
}
// returns the existing item that duplicates (headword, meanings), or null
export function findDuplicate(byHead, headword, meanings, exceptId = null) {
  return (byHead.get(headKey(headword)) || []).find((w) => w.id !== exceptId && meaningsOverlap(meanings, meaningsOf(w))) || null;
}

// Register entries; duplicates (same headword AND overlapping meaning) are skipped. Returns {added, skipped, ids}
export async function registerEntries(entries, source, extra = {}) {
  const heads = {};
  const byHeadOf = async (lang) => (heads[lang] ||= await wordsByHead(lang));
  const words = [], linked = []; let skipped = 0; const base = Date.now();
  for (const e of entries) {
    const k = headKey(e.headword);
    const byHead = await byHeadOf(e.lang || extra.lang || curLang());
    const dup = k ? findDuplicate(byHead, e.headword, e.meanings || []) : null;
    if (!k || dup) {
      skipped++;
      // already registered: put it into the deck(s) of this import as well (the same word in several source lists)
      if (dup && extra.deckIds?.length && dup.id !== '_' && !words.includes(dup)) { const add = extra.deckIds.filter((d) => !(dup.deckIds || []).includes(d)); if (add.length) { dup.deckIds = [...(dup.deckIds || []), ...add]; linked.push(dup); } }
      continue;
    }
    const w = entryToWord(e, source, extra);
    w.createdAt = base + words.length;   // keeps the order of the list (used for 「何番〜何番」 in a deck)
    if (!byHead.has(k)) byHead.set(k, []);
    byHead.get(k).push(w); words.push(w);
  }
  if (words.length) await db.putMany('words', words);
  for (const w of linked) { const cur = await db.get('words', w.id); if (cur) { cur.deckIds = w.deckIds; await db.put('words', cur); } }
  return { added: words.length, skipped, linked: linked.length, ids: words.map((w) => w.id) };
}

// ---- Seed: initial words from the user's previous app (all marked 苦手 there) ----
export async function seedIfNeeded() {
  if (await getMeta('seed:v1', false)) return 0;
  const { SEED_V1 } = await import('./seed.js');
  const { ids } = await registerEntries(csvToEntries(SEED_V1), { type: 'seed', note: '元アプリから移行' }, { lang: 'en' });
  for (const id of ids) await setManual(id, SKILLS, 2, { lock: false, reason: 'import' });
  await setMeta('seed:v1', Date.now());
  return ids.length;
}

// ---- Split one item into several meaning groups (keeps the original item, its history and examples) ----
// groups: [[meanings for the original], [meanings for new item 1], ...]; newExamples[i] optional [{en, ja}]
export async function splitWord(wordId, groups, { newExamples = [], note = '意味ごとに分割' } = {}) {
  const { SKILLS, mid, effLevel } = await import('./mastery.js');
  const w = await db.get('words', wordId);
  if (!w || groups.length < 2) return [];
  const pos = w.senses?.[0]?.pos || '';
  w.senses = [{ ...(w.senses?.[0] || newSense()), meanings: groups[0] }];
  w.updatedAt = Date.now();
  const created = [];
  const now = Date.now();
  for (let i = 1; i < groups.length; i++) {
    const nw = newWord({ lang: langOf(w), headword: w.headword, senses: [newSense({ pos, meanings: groups[i], examples: newExamples[i] || [] })],
      tags: [...(w.tags || [])], deckIds: [...(w.deckIds || [])], bookmarked: w.bookmarked, source: { ...(w.source || {}), note } });
    nw.splitFrom = w.id;
    created.push(nw);
  }
  // new items start from the same level as the original (manual, not locked: the next auto judgment replaces it)
  const recs = [], hist = [];
  for (const s of SKILLS) {
    const m = await db.get('mastery', mid(w.id, s));
    const lv = effLevel(m);
    if (!lv) continue;
    for (const nw of created) {
      recs.push({ id: mid(nw.id, s), wordId: nw.id, skill: s, autoLevel: 0, autoAt: null, manualLevel: lv, manualAt: now, locked: false,
        stats: { attempts: 0, correct: 0, streak: 0, recent: [], avgMs: null, hints: 0, lastAt: null } });
      hist.push({ wordId: nw.id, skill: s, from: 0, to: lv, locked: false, reason: 'split', at: now });
    }
  }
  await db.tx(['words', 'mastery', 'masteryChanges'], 'readwrite', (t) => {
    t.objectStore('words').put(w);
    created.forEach((x) => t.objectStore('words').put(x));
    recs.forEach((r) => t.objectStore('mastery').put(r));
    hist.forEach((h) => t.objectStore('masteryChanges').add(h));
  });
  return created;
}

// One-time split of the initial words that mixed different meanings (only if the user has not edited their meanings)
const SEED_SPLITS = [
  ['modest', '控えめな / 適度の / 質素な', [['適度の'], ['控えめな'], ['質素な']], [null,
    [{ en: 'He was modest about his achievements.', ja: '彼は自分の業績について控えめだった。' }],
    [{ en: 'They live in a modest house near the station.', ja: '彼らは駅の近くの質素な家に住んでいる。' }]]],
  ['correspond', 'やり取りする / 一致する / 相当する', [['一致する', '相当する'], ['やり取りする']], [null,
    [{ en: 'I have corresponded with her by email for years.', ja: '彼女とは何年もメールでやり取りしている。' }]]],
  ['compromise', '損なう / 危険にさらす / 妥協する', [['損なう', '危険にさらす'], ['妥協する']], [null,
    [{ en: 'Both sides agreed to compromise on the price.', ja: '双方は価格について妥協することに合意した。' }]]],
  ['straightforward', '簡単な / わかりやすい / 正直な', [['簡単な', 'わかりやすい'], ['正直な']], [null,
    [{ en: 'He is a straightforward person who says what he thinks.', ja: '彼は思ったことをそのまま言う正直な人だ。' }]]],
  ['distraction', '邪魔 / 気を散らすもの / 気晴らし', [['邪魔', '気を散らすもの'], ['気晴らし']], [null,
    [{ en: 'Reading is a welcome distraction from work.', ja: '読書は仕事からのありがたい気晴らしだ。' }]]],
  ['trustee', '理事 / 管財人 / 受託者', [['理事'], ['管財人', '受託者']], [null,
    [{ en: 'The bank acts as trustee for the fund.', ja: 'その銀行が基金の受託者を務めている。' }]]],
  ['acquaintance', '知人 / 面識', [['知人'], ['面識']], [null,
    [{ en: 'I made his acquaintance at a conference.', ja: '私はある会議で彼と面識を得た。' }]]],
  ['dispatch', '派遣する / 発送する', [['発送する'], ['派遣する']], [null,
    [{ en: 'The company dispatched an engineer to repair the machine.', ja: '会社は機械の修理に技術者を派遣した。' }]]],
];
export async function splitSeedIfNeeded() {
  if (await getMeta('split:v1', false)) return 0;
  let n = 0;
  const byHead = await wordsByHead();
  for (const [head, orig, groups, ex] of SEED_SPLITS) {
    const w = (byHead.get(head) || []).find((x) => x.source?.type === 'seed' && meaningsOf(x).join(' / ') === orig);
    if (!w) continue;                                   // edited or deleted by the user -> leave it alone
    const created = await splitWord(w.id, groups, { newExamples: ex, note: '初期語を意味ごとに分割（例文はAI作成・未検証）' });
    n += created.length;
  }
  await setMeta('split:v1', Date.now());
  return n;
}

// ---- Content packs (static JSON in /content, AI-made = 未検証). Imported once per pack id. ----
export async function importPackWords(url, metaKey) {
  if (await getMeta(metaKey, false)) return 0;
  let pack; try { pack = await (await fetch(url)).json(); } catch { return 0; }
  const entries = (pack.items || []).map((i) => ({
    lang: i.lang || pack.lang || 'en', headword: i.headword, meanings: i.meanings || [], pos: i.pos || '', ipa: i.pinyin || i.ipa || '',
    gender: i.gender || '', accepted: i.accepted || [], context: [i.note, i.measure ? `量詞：${i.measure}` : ''].filter(Boolean).join('／'), tags: [...(i.tags || []), 'AI作成・未検証'],
    example_en: i.examples?.[0]?.en || i.examples?.[0]?.text || '', example_ja: i.examples?.[0]?.ja || '', answer: i.examples?.[0]?.answer,
    kind: i.kind, phrasal: i.phrasal, swipe: i.swipe, origin: i.origin || 'ai', review: i.review || 'unverified',
  }));
  const r = await registerEntries(entries, { type: 'seed', note: pack.title || metaKey });
  // phrasal data on already-existing items (e.g. registered earlier from CSV)
  const byHead = await wordsByHead('en');
  for (const i of pack.items || []) {
    if (!i.phrasal) continue;
    const ex = findDuplicate(byHead, i.headword, i.meanings || []);
    if (ex && !ex.phrasal) { ex.kind = 'phrasal'; ex.phrasal = i.phrasal; if (i.swipe) ex.swipe = i.swipe; await saveWord(ex); }
  }
  await setMeta(metaKey, Date.now());
  return r.added;
}
