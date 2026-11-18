// Word data operations, parsing (bulk / CSV), seed data
import { db, uid, getMeta, setMeta } from './db.js';
import { SKILLS, setManual, mid } from './mastery.js';

export const normHead = (s) => String(s || '').replace(/[　\s]+/g, ' ').trim();
export const headKey = (s) => normHead(s).toLowerCase();
export const splitList = (s) => String(s || '').split(/\s*[\/／;；、,，]\s*/).map((x) => x.trim()).filter(Boolean);

export function newSense({ pos = '', meanings = [], accepted = [], context = '', examples = [] } = {}) {
  return { id: uid('s_'), pos, meanings, accepted, context, examples };
}

export function newWord({ headword, senses, tags = [], deckIds = [], bookmarked = false, ipa = '', source = { type: 'manual' } }) {
  const h = normHead(headword);
  const now = Date.now();
  return {
    id: uid('w_'), headword: h, isPhrase: /\s/.test(h), ipa,
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
    t.objectStore('words').delete(id);
    for (const s of SKILLS) { t.objectStore('mastery').delete(mid(id, s)); t.objectStore('reviews').delete(mid(id, s)); }
  });
}

export async function existingHeadMap() {
  const map = new Map();
  for (const w of await db.all('words')) map.set(headKey(w.headword), w);
  return map;
}

// ---- bulk text: one per line "headword, 意味1/意味2" or "headword<TAB>意味" ----
export function parseBulk(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s*(?:\t|,|，|:|：|=|\s-\s)\s*(.*)$/);
    const head = m ? m[1] : line;
    out.push({ headword: normHead(head), meanings: m ? splitList(m[2]) : [] });
  }
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
  headword: ['headword', 'word', 'english', 'en', 'term', '英語', '単語', '英単語', '見出し語'],
  meanings: ['meanings', 'meaning', 'japanese', 'ja', 'translation', '意味', '日本語', '日本語訳', '訳'],
  pos: ['pos', 'part of speech', '品詞'],
  example_en: ['example_en', 'example', 'sentence', '例文', '英文例'],
  example_ja: ['example_ja', 'example translation', '例文訳', '例文の日本語訳'],
  tags: ['tags', 'tag', 'タグ', 'カテゴリ'],
  bookmarked: ['bookmarked', 'bookmark', 'ブックマーク'],
  accepted: ['accepted', '別解', '許容解答'],
  ipa: ['ipa', '発音記号'],
};

// Returns [{headword, meanings, pos, example_en, example_ja, tags, bookmarked, accepted, ipa}]
export function csvToEntries(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex((h) => names.includes(h));
  const hasHeader = idx.headword >= 0;
  if (!hasHeader) { idx.headword = 0; idx.meanings = 1; idx.example_en = 2; idx.example_ja = 3; }
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
  return rows.slice(hasHeader ? 1 : 0).map((r) => ({
    headword: normHead(get(r, 'headword')),
    meanings: splitList(get(r, 'meanings')),
    pos: get(r, 'pos'), example_en: get(r, 'example_en'), example_ja: get(r, 'example_ja'),
    tags: splitList(get(r, 'tags')), accepted: splitList(get(r, 'accepted')), ipa: get(r, 'ipa'),
    bookmarked: /^(1|true|yes|y|済|○|★)$/i.test(get(r, 'bookmarked')),
  })).filter((e) => e.headword);
}

export function entryToWord(e, source, extra = {}) {
  return newWord({
    headword: e.headword, ipa: e.ipa || '',
    senses: [newSense({ pos: e.pos || '', meanings: e.meanings || [], accepted: e.accepted || [], examples: e.example_en ? [{ en: e.example_en, ja: e.example_ja || '' }] : [] })],
    tags: [...new Set([...(e.tags || []), ...(extra.tags || [])])], deckIds: extra.deckIds || [],
    bookmarked: e.bookmarked || extra.bookmarked || false, source,
  });
}

// Register entries; duplicates (same headword) are skipped. Returns {added, skipped, ids}
export async function registerEntries(entries, source, extra = {}) {
  const exist = await existingHeadMap();
  const seen = new Set(); const words = []; let skipped = 0;
  for (const e of entries) {
    const k = headKey(e.headword);
    if (!k || exist.has(k) || seen.has(k)) { skipped++; continue; }
    seen.add(k); words.push(entryToWord(e, source, extra));
  }
  if (words.length) await db.putMany('words', words);
  return { added: words.length, skipped, ids: words.map((w) => w.id) };
}

// ---- Seed: initial words from the user's previous app (all marked 苦手 there) ----
export async function seedIfNeeded() {
  if (await getMeta('seed:v1', false)) return 0;
  const { SEED_V1 } = await import('./seed.js');
  const { ids } = await registerEntries(csvToEntries(SEED_V1), { type: 'seed', note: '元アプリから移行' });
  for (const id of ids) await setManual(id, SKILLS, 2, { lock: false, reason: 'import' });
  await setMeta('seed:v1', Date.now());
  return ids.length;
}
