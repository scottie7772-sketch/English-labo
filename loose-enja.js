// 英和テキストのゆるい読み取り（純関数）。ChatGPT などが作った「英語と日本語の意味」のテキストを、
// 余計な説明文・番号・記号・表・コードブロックが混ざっていても、ある程度の幅で拾って { headword, meanings, pos, example_en, example_ja } にする。
// 読めた形の例:
//   1. accommodate – 収容する、（要望などに）応える
//   accommodate：収容する（動詞）　　/　　accommodate (v.) 収容する
//   accommodate<TAB>収容する<TAB>動詞<TAB>Accommodate a request.<TAB>要望に応える。      | 表（Markdown の | 区切り）
//   accommodate 収容する  Accommodate a request. 要望に応える。                         （1行に英和英和）
//   accommodate ⏎ 収容する ⏎ Accommodate a request. ⏎ 要望に応える。                    （英語の行と日本語の行が交互）
// 読み飛ばすもの: 「以下に作成しました」などの説明文、見出し行、番号だけの行、区切り線、```、**太字** の記号。
// 外部通信・課金なし。意味を勝手に作ることはしない（書いてあるものだけを使う）。
const JA = '぀-ヿ㐀-鿿ｦ-ﾟ';
const JA_RE = new RegExp(`[${JA}]`), LAT_RE = /[A-Za-zÀ-ÿ]/;
const hasJa = (s) => JA_RE.test(s), hasLat = (s) => LAT_RE.test(s);
const wc = (s) => (s.match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9'’\-]*/g) || []).length;
const HEADER = new Set(['english', 'japanese', 'word', 'words', 'meaning', 'meanings', 'example', 'examples', 'phrase', 'pos', 'no', 'no.', '#', 'headword', 'translation', '英語', '日本語', '単語', '意味', '例文', '例文訳', '品詞', '番号', '見出し語', '訳', '日本語訳', '和訳', '英単語', '熟語', 'タグ']);
const POS_RE = /^(?:\(?\[?)(?:n|v|adj|adv|prep|conj|pron|noun|verb|adjective|adverb|preposition|phrasal verb|phrase|idiom|名詞|動詞|形容詞|副詞|前置詞|接続詞|熟語|句動詞|慣用句|名|動|形|副|他動|自動)\.?(?:\)?\]?)$/i;
const POS_INLINE = /[(（\[【]\s*((?:n|v|adj|adv|prep|conj|pron|noun|verb|adjective|adverb|preposition|phrasal verb|phrase|idiom|名詞|動詞|形容詞|副詞|前置詞|接続詞|熟語|句動詞|慣用句|名|動|形|副|他動詞|自動詞)\.?)\s*[)）\]】]/i;

function clean(raw) {
  let s = String(raw).replace(/[﻿​]/g, '').replace(/\*\*|__|`/g, '').trim();
  // 先頭の記号・番号: 「- 」「• 」「1. 」「1) 」「(1) 」「①」「No.1」「#3」
  for (let i = 0; i < 3; i++) s = s.replace(/^(?:[-*•・●▪■□◆◇▶▷►→]+\s+|\d{1,4}\s*[.)）:：、]\s*|\(\d{1,4}\)\s*|[①-⑳]\s*|(?:No\.?|#)\s*\d{1,4}\s*[.:：)）]?\s*|\d{1,4}\s+(?=[A-Za-z¿¡]))/i, '');
  return s.trim();
}
const isNoise = (s) => !s || /^[\s|:\-–—=_*#>~.]+$/.test(s) || /^```/.test(s) || /^#{1,6}\s/.test(s) || /^\d{1,4}$/.test(s) || /^-{3,}$/.test(s);

// 文字の種類（日本語 / 英字）が切り替わる所で区切る。間の空白・記号は前の塊に付ける。
function runs(s) {
  const out = []; let cur = null;
  for (const ch of s) {
    const k = hasJa(ch) ? 'J' : hasLat(ch) ? 'L' : null;
    if (k && cur && cur.k && cur.k !== k) { out.push(cur); cur = { k, t: ch }; continue; }
    if (!cur) cur = { k, t: ch }; else { cur.t += ch; if (!cur.k && k) cur.k = k; }
  }
  if (cur) out.push(cur);
  const list = out.filter((r) => r.k).map((r) => ({ k: r.k, t: r.t }));
  // 英語の塊の終わりについた「〜」「…」は、続く日本語（意味）の先頭に移す（「refer to … 〜に言及する」「in charge of ～を担当して」）
  for (let i = 0; i + 1 < list.length; i++) if (list[i].k === 'L' && list[i + 1].k === 'J') { const m = list[i].t.match(/[〜～~…・\s]+$/); if (m && /[〜～~]/.test(m[0])) { list[i + 1].t = m[0].replace(/[…・\s]+/g, '') + list[i + 1].t; } }
  return list.map((r) => ({ k: r.k, t: r.t.trim() }));
}
const tidyHead = (t) => t.replace(/[〜～~…・\s]+$/, '').replace(/\/[^/\n]{2,40}\/\s*$/, '').replace(/[(（\[【][^)）\]】]*[)）\]】]\s*$/, '').replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』:：=→,.、;；\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
const tidyJa = (t) => t.replace(/^[\s:：=→\-–—,、・]+/, '').replace(/[\s,、;；]+$/, '').trim();
const splitMeanings = (t) => t.split(/\s*[;；/／]\s*|、(?![^（(]*[）)])/).map((x) => x.trim()).filter(Boolean);
const headLike = (t) => { const w = wc(t); return w >= 1 && w <= 7 && !/[.!?]["”’)]?$/.test(t.trim()) && !/[:：]$/.test(t.trim()); };
const sentenceLike = (t) => wc(t) >= 3 && (/[.!?]["”’)]?$/.test(t.trim()) || wc(t) >= 6);

// 直前の見出し語を使った文なら、句点がなくても例文とみなす（金フレ型の例文は「All company employees」のように句点がない）
const stem = (w) => w.toLowerCase().replace(/[^a-z']/g, '').replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '');
const usesHead = (head, text) => { const hs = (head || '').split(/\s+/).map(stem).filter((w) => w.length >= 3); const ts = new Set(String(text).split(/\s+/).map(stem)); const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))); return hs.length > 0 && hs.every((h) => [...ts].some((t) => same(h, t))) && wc(text) > wc(head); };

// 日本語だけの行が、意味・例文訳ではなく説明文（返答の前置き・結び）かどうか
const PROSE_START = /^(以下|以上|ご確認|ご不明|お知らせ|なお|補足|注意|※|もちろん|はい[、,]|承知|作成しました|こちら|ありがとう|よろしく)/;
const proseJa = (line, { asMeaning = true } = {}) => PROSE_START.test(line.trim()) || /(ご確認ください|お知らせください|ご連絡ください)/.test(line) || (asMeaning && line.trim().length > 8 && /(です|ます|ました|でした|ください)[。.!！]?$/.test(line.trim()) && !/[A-Za-z]/.test(line));

function posOf(...ts) { for (const t of ts) { const m = String(t || '').match(POS_INLINE); if (m) return m[1]; } return ''; }

// セル（タブ・| ・コンマで区切られた行）から読む
function fromCells(cells) {
  const c = cells.map((x) => x.trim()).filter((x) => x !== '');
  if (c.length < 2) return null;
  if (c.every((x) => HEADER.has(x.toLowerCase().replace(/[:：]$/, '')))) return { header: true };
  const out = { headword: '', meanings: [], pos: '', example_en: '', example_ja: '' };
  for (const cell of c) {
    if (/^\d{1,4}$/.test(cell)) continue;
    if (POS_RE.test(cell)) { out.pos ||= cell.replace(/[()\[\]]/g, ''); continue; }
    if (hasJa(cell) && !hasLat(cell.replace(/[（(][^）)]*[）)]/g, ''))) {   // 日本語のセル: 意味 → 例文訳の順
      if (!out.meanings.length && !out.example_en) out.meanings = splitMeanings(tidyJa(cell)); else if (out.example_en && !out.example_ja) out.example_ja = tidyJa(cell);
      else if (!out.meanings.length) out.meanings = splitMeanings(tidyJa(cell));
      continue;
    }
    if (hasLat(cell)) {
      const rs = runs(cell);   // 英語のセルに日本語が続く（「head 意味」）形
      if (!out.headword && rs.length >= 2 && rs[0].k === 'L' && rs[1].k === 'J' && !sentenceLike(rs[0].t)) { out.headword = tidyHead(rs[0].t); out.meanings = splitMeanings(tidyJa(rs.slice(1).filter((r) => r.k === 'J').map((r) => r.t).join(' '))); continue; }
      if (!out.headword && !sentenceLike(cell)) { out.headword = tidyHead(cell); out.pos ||= posOf(cell); continue; }
      if (!out.example_en && sentenceLike(cell)) { out.example_en = cell.trim(); continue; }
      if (!out.headword) out.headword = tidyHead(cell);
    }
  }
  return out.headword ? out : null;
}
const csvCells = (line) => { const out = []; let cell = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; } else if (ch === '"') q = true; else if (ch === ',' || ch === '，') { out.push(cell); cell = ''; } else cell += ch; } out.push(cell); return out; };

// keepBare: 意味のない見出し語だけの行も、そのまま残す（ユーザーが書いた単語リストを読むとき。説明文を拾うおそれは少ない）
export function parseLooseEnJa(text, { keepBare = false } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/ /g, ' '));
  const entries = [], skipped = []; let pending = null, inFence = false;
  const flushPending = () => { pending = null; };
  const last = () => entries.at(-1);
  const push = (e) => { if (!e.headword || !hasLat(e.headword)) return false; entries.push({ headword: e.headword, meanings: e.meanings || [], pos: e.pos || '', example_en: e.example_en || '', example_ja: e.example_ja || '' }); return true; };
  const nonEmpty = lines.filter((l) => l.trim() && !/^```/.test(l.trim()));
  const latOnly = nonEmpty.filter((l) => { const c = clean(l); return hasLat(c) && !hasJa(c) && headLike(c); }).length;
  const listMode = nonEmpty.length >= 3 && latOnly / nonEmpty.length >= 0.6 && !nonEmpty.some((l) => hasJa(l));   // 英単語だけが並ぶリスト（意味なし）
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    let line = clean(raw);
    if (isNoise(line)) { continue; }
    // 表・タブ・コンマ区切り
    let cells = null;
    if (/\t/.test(line)) cells = line.split('\t'); else if (/\|/.test(line)) cells = line.split('|'); else if ((line.match(/[,，]/g) || []).length >= 2 && hasJa(line)) cells = csvCells(line);
    if (cells) {
      const e = fromCells(cells);
      if (e?.header) continue;
      if (e) { flushPending(); push(e); continue; }
    }
    const rs = runs(line);
    if (!rs.length) continue;
    const L = rs.filter((r) => r.k === 'L'), J = rs.filter((r) => r.k === 'J');
    if (!J.length) {   // 英語だけの行: 例文（直前の見出し語の例文）か、見出し語（次の行に日本語が来るかもしれない）
      const t = line.replace(/[\s\-–—:：=→]+$/, '').trim();
      if ((sentenceLike(t) || (pending?.kind === 'afterHead' && last() && usesHead(last().headword, t))) && last() && !last().example_en && (!pending || pending.kind === 'afterHead')) { last().example_en = t; pending = { kind: 'example' }; continue; }
      if (listMode && headLike(t)) { push({ headword: tidyHead(t), meanings: [], pos: posOf(t) }); continue; }
      if (keepBare && headLike(t) && hasLat(t)) { push({ headword: tidyHead(t), meanings: [], pos: posOf(t) }); pending = { kind: 'headEntry' }; continue; }
      if (headLike(t) && !/[:：]$/.test(line)) { pending = { kind: 'head', head: tidyHead(t), pos: posOf(t) }; continue; }
      pending = null; skipped.push(raw.trim()); continue;
    }
    if (!L.length) {   // 日本語だけの行: 直前の英語の行の意味／例文訳。そうでなければ説明文
      const ja = tidyJa(line);
      if (proseJa(line, { asMeaning: pending?.kind === 'head' || pending?.kind === 'headEntry' })) { pending = null; skipped.push(raw.trim()); continue; }
      if (pending?.kind === 'headEntry' && last() && !last().meanings.length) { last().meanings = splitMeanings(ja); pending = { kind: 'afterHead' }; continue; }
      if (pending?.kind === 'head') { push({ headword: pending.head, meanings: splitMeanings(ja), pos: pending.pos || posOf(line) }); pending = { kind: 'afterHead' }; continue; }
      if (pending?.kind === 'example' && last() && !last().example_ja) { last().example_ja = ja; pending = null; continue; }
      if (pending?.kind === 'afterHead' && last() && !last().example_ja && last().example_en) { last().example_ja = ja; pending = null; continue; }
      pending = null; skipped.push(raw.trim()); continue;
    }
    // 英語と日本語が同じ行にある
    if (rs[0].k === 'J') { pending = null; skipped.push(raw.trim()); continue; }   // 日本語から始まる行は説明文として扱う
    const first = rs[0].t;
    if ((sentenceLike(first) || (pending?.kind === 'afterHead' && last() && usesHead(last().headword, first))) && last() && !last().example_en && rs.length === 2) {   // 「例文。 例文訳」: 直前の見出し語の例文
      last().example_en = first.replace(/[\s\-–—:：=→]+$/, ''); last().example_ja = tidyJa(rs[1].t); pending = null; continue;
    }
    const jaParts = [], extraL = [];
    let head = tidyHead(first), pos = posOf(first), meaning = '', exEn = '', exJa = '';
    // 2番目以降の英語の塊が例文（3語以上）なら例文、その直後の日本語が例文訳
    for (let i = 1; i < rs.length; i++) {
      const r = rs[i];
      if (r.k === 'J') { if (exEn && !exJa) exJa = tidyJa(r.t); else if (!exEn) jaParts.push(r.t); }
      else if (!exEn && sentenceLike(r.t)) exEn = r.t.replace(/[\s\-–—:：=→]+$/, ''); else extraL.push(r.t);
    }
    meaning = tidyJa(jaParts.join(' '));
    pos ||= posOf(meaning);
    meaning = meaning.replace(POS_INLINE, '').replace(/^\s*(?:名詞|動詞|形容詞|副詞|熟語|句動詞)\s*[:：]\s*/, '').trim();
    if (!head || !hasLat(head) || sentenceLike(first) && !last()) { pending = null; skipped.push(raw.trim()); continue; }   // 説明文に日本語が混ざった行
    if (wc(head) > 8) { pending = null; skipped.push(raw.trim()); continue; }
    push({ headword: head, meanings: splitMeanings(meaning), pos, example_en: exEn, example_ja: exJa });
    pending = exEn ? null : { kind: 'afterHead' };
  }
  // 見出し語だけで意味のない行（説明文の途中で拾ったもの）は、意味のある行が多いときは捨てる
  const withMeaning = entries.filter((e) => e.meanings.length);
  const kept = !keepBare && withMeaning.length >= Math.max(2, entries.length * 0.5) ? withMeaning : entries;
  const notes = [];
  if (skipped.length) notes.push(`説明文などと判断して読み飛ばした行：${skipped.length}行`);
  return { entries: kept, skipped, notes, dropped: entries.length - kept.length };
}
