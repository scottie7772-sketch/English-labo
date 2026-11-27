// 音声付き単語帳の共通コア（純関数だけ。画面・DB・音声には触れない）。Studio / Video Lab / 単語帳から同じものを使う。
//
//   detectProfile(rows)            教材の構造を判定（金フレ型 / 一般単語型 / 会話型 / 朗読型）
//   extractItems(rows, profile)    見出し語・例文・文全体の音声参照を独立に持つ項目を作る
//   gradeItems(items, ctx)         参照ごとの確信度（high / mid / low）。推定・未確認は high にならない
//   recheckItems(items, ctx)       中・低確信度の項目だけを、前後の確定済み音声の間（局所）で再照合
//   summarize / isRegistrable      登録前の件数と、モードごとの登録条件
//
// 行(row)の形: { id, text, ja, role?, group?, asr?, estimated?, manual?, confirmed, rep?, wordTimings?,
//                segments: [{ store, key, sourceKey, size, start, end }] }
//   - confirmed … スタジオで照合済み（または手で確定）。推定時刻・文字起こしのままの行は false。
// 外部通信・課金なし。認識アルゴリズムは置き換えず、既存の照合結果と文字起こしを「証拠」として使う。
import { words } from './studio-align.js';
import { similarity } from './studio-import-align.js';
import { pickReading, limitsFor, makeRef, sameText } from './audio-ref-model.js';

const round = t => Math.round(t * 1000) / 1000;
export const keyOf = text => words(text).map(w => w.w).join(' ');
const wc = text => words(text).length;
const stripNo = t => String(t || '').replace(/^\s*(?:no\.?\s*|#\s*)?\d{1,4}\s*[.)．、:：]\s*/i, '').trim();
const headLike = t => { const s = stripNo(t); return wc(s) >= 1 && wc(s) <= 4 && !/[.!?。]["”’)]?$/.test(s.trim()); };
const sentenceLike = t => wc(t) >= 5 || /[.!?。]["”’)]?$/.test(String(t).trim());

export const PROFILES = {
  kinfure: '金フレ型（番号・見出し語・例文・復唱）',
  wordlist: '一般の単語・熟語',
  dialogue: '会話（発話単位）',
  prose: '朗読（本文・章）',
};
export const MODES = {
  head: '見出し語・対象フレーズ優先（標準）',
  example: '見出し語＋例文',
  sentence: '文章・発話全体',
};
export const STATE = { pending: '未処理', running: '処理中', confirmed: '音声確定', candidates: '候補あり', unresolved: '未特定', broken: '参照切れ', registered: '登録済み' };

// ================= 1. 教材タイプの自動判定 =================
export function detectProfile(rows, { materialType = '', name = '' } = {}) {
  const script = rows.filter(r => !r.asr && /[A-Za-z]/.test(r.text || ''));
  const n = script.length;
  if (!n) return { profile: 'prose', scores: {}, confidence: 0, reasons: ['英文の行がありません'], auto: true };
  const lens = script.map(r => wc(stripNo(r.text)));
  const heads = script.filter(r => r.role === 'word' || (r.role !== 'example' && headLike(r.text)));
  const headRate = heads.length / n, avg = lens.reduce((a, b) => a + b, 0) / n;
  // 見出し語の直後に文が来る回数（見出し語1つあたり）
  let alt = 0;
  script.forEach((r, i) => { if ((r.role === 'word' || (r.role !== 'example' && headLike(r.text))) && script[i + 1] && sentenceLike(script[i + 1].text)) alt++; });
  const altern = heads.length ? alt / heads.length : 0;
  const roles = script.filter(r => r.role).length / n;
  const repeats = script.filter(r => sentenceLike(r.text) && (r.rep > 1 || r.segments?.length > 1)).length / Math.max(1, script.filter(r => sentenceLike(r.text)).length);
  const numbered = script.filter(r => /^\s*(?:no\.?\s*|#\s*)?\d{1,4}\s*[.)．、:：]\s*\S/i.test(r.text)).length / n;
  const speaker = script.filter(r => /^\s*(?:[A-D]|Speaker\s*\d|Man|Woman|Boy|Girl|[A-Z][a-z]{1,12})\s*[:：]\s*\S/.test(r.text)).length / n;
  const chapters = script.filter(r => /^\s*(?:chapter\s+(?:\d+|[a-z-]+)|第\s*\d+\s*章|before)\s*[.:]?\s*$/i.test(r.text.trim())).length;
  const manyHeads = heads.length >= 3;   // 見出し行が1〜2個（章タイトルなど）では、見出し語と例文の並びとは見なさない
  const cap = (v, m) => Math.min(m, v);
  const type = String(materialType);
  const scores = {
    kinfure: cap((roles >= .5 ? .4 : 0) + (type === 'vocab' ? .3 : 0) + (manyHeads ? cap(altern * .45, .3) : 0) + cap(repeats * .6, .25) + (manyHeads ? cap(numbered * .3, .15) : 0) + (manyHeads && headRate >= .15 && headRate <= .65 ? .1 : 0), 1),
    wordlist: cap((headRate >= .7 ? .6 : headRate * .6) + (altern < .15 ? .25 : 0) + (avg <= 2.6 ? .15 : 0) - (repeats > .1 ? .2 : 0), 1),
    dialogue: cap(cap(speaker * 1.3, .6) + (/conversation|dialogue|toeic-dialogue|toeic-response/.test(type) ? .3 : 0) + (avg >= 3 && avg <= 14 && headRate < .3 ? .2 : 0), 1),
    prose: cap((type === 'prose' ? .35 : 0) + (avg >= 11 ? .3 : avg >= 8 ? .15 : 0) + (chapters ? .2 : 0) + (headRate < .1 ? .15 : 0) + (speaker < .1 ? .1 : 0), 1),
  };
  const order = ['kinfure', 'wordlist', 'dialogue', 'prose'];
  const ranked = order.slice().sort((a, b) => scores[b] - scores[a] || order.indexOf(a) - order.indexOf(b));
  const reasons = [];
  if (roles >= .5) reasons.push('見出し語・例文の区別が付いています');
  if (headRate >= .7) reasons.push(`短い単語・熟語の行が${Math.round(headRate * 100)}%`);
  if (altern >= .5) reasons.push('見出し語のあとに例文が続きます');
  if (repeats >= .2) reasons.push('例文が複数回読まれています');
  if (speaker >= .25) reasons.push('話者ラベルがあります');
  if (avg >= 11) reasons.push(`1行の平均が${avg.toFixed(0)}語（長い文）`);
  if (chapters) reasons.push('章の見出しがあります');
  const top = ranked[0];
  return { profile: scores[top] >= .3 ? top : 'prose', scores, confidence: +(scores[top] - scores[ranked[1]]).toFixed(2), reasons, auto: true,
    stats: { rows: n, headRate: +headRate.toFixed(2), avgWords: +avg.toFixed(1), altern: +altern.toFixed(2), speaker: +speaker.toFixed(2) } };
}

// ================= 2. 項目の抽出（見出し語・例文・文全体の参照を独立に持つ） =================
// 参照 RI = { ref, rowId, tier, score, reasons[], repeats, est }  ref は audio-refs の参照（state は確信度で決まる）
function refInfo(row, kind, item, all, { from, materialId, title }) {
  const pick = pickReading(row.segments);
  if (!pick) return null;
  const g = pick.seg;
  const origin = { from, materialId, ...(from === 'lab' ? { cueId: row.id } : {}), ...(row.itemId || from === 'studio' ? { itemId: row.itemId || row.id } : {}), text: row.text, ...(title ? { title } : {}) };
  const ref = makeRef({ store: g.store, key: g.key, size: g.size, start: g.start, end: g.end, limit: limitsFor(g, all), origin, state: 'unconfirmed' });
  return { ref, rowId: row.id, tier: 'low', score: 0, reasons: [], repeats: pick.of, unsure: pick.unsure, kind };
}
const allSegments = rows => rows.flatMap(r => (r.segments || []).map(g => ({ sourceKey: g.sourceKey, start: g.start, end: g.end, rowId: r.id })));
const itemOf = (profile, head, example, extra = {}) => ({ key: `${profile}|${keyOf(head)}|${keyOf(example || '')}`, profile, head, example: example || '', ja: '', exampleJa: '',
  rows: { word: null, example: null, sentence: null }, refs: { word: null, example: null, sentence: null }, issues: [], ...extra });

// 見出し語に対応する文中の位置（連続した語）。語尾変化（-s -ed -ing）は同じ語として扱う。
// 語尾変化（-s -es -ed -ing、語末の e）をそろえるだけの簡易な語幹。不規則変化（took）は同じ語として扱わない。
const stem = w => w.length > 3 ? w.replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '') : w;
export function findPhrase(rowText, head) {
  const hs = words(head).map(w => stem(w.w)), ts = words(rowText).map(w => stem(w.w));
  if (!hs.length) return -1;
  for (let i = 0; i + hs.length <= ts.length; i++) if (hs.every((h, k) => ts[i + k] === h)) return i;
  return -1;
}
// wordTimings（語ごとの時刻）があれば、見出し語の範囲だけを取り出す
export function phraseRange(row, head) {
  const wt = row.wordTimings;
  if (!Array.isArray(wt) || !wt.length) return null;
  const hs = words(head).map(w => stem(w.w)), ts = wt.map(w => stem(words(w.text)[0]?.w || ''));
  for (let i = 0; i + hs.length <= ts.length; i++) if (hs.every((h, k) => ts[i + k] === h)) return { start: wt[i].start, end: wt[i + hs.length - 1].end };
  return null;
}

// 見出し語・例文の区別が教材に書かれていないとき、文の構造から付ける（短く文末記号のない行 = 見出し語、その後ろの文 = 例文）。
export function assignRoles(rows) {
  let group = '', n = 0;
  return rows.map(r => {
    const head = r.role === 'word' || (r.role !== 'example' && headLike(r.text));
    if (head) group = 'auto' + (++n);
    return { ...r, role: head ? 'word' : 'example', group: group || null };
  });
}

export function extractItems(rows, profile, { mode = 'head', wordList = [], from = 'studio', materialId = '', title = '' } = {}) {
  const ctx = { from, materialId, title }, all = allSegments(rows);
  let script = rows.filter(r => !r.asr && (r.text || '').trim());
  if (profile === 'kinfure' && mode !== 'sentence' && !script.some(r => r.group)) script = assignRoles(script);
  const notes = [];
  let items = [];
  if (mode === 'sentence') {
    items = script.filter(r => /[A-Za-z]/.test(r.text)).map(r => {
      const it = itemOf('sentence', r.text.trim(), '', { ja: r.ja || '' });
      it.rows.sentence = r.id; it.refs.sentence = refInfo(r, 'sentence', it, all, ctx);
      if (!it.refs.sentence) it.issues.push('文の音声が未割当');
      return it;
    });
  } else if (profile === 'kinfure') {
    const groups = new Map();
    for (const r of script) {
      if (!r.group) continue;
      if (!groups.has(r.group)) groups.set(r.group, { word: null, examples: [] });
      const g = groups.get(r.group);
      if (r.role === 'word' && !g.word) g.word = r; else if (r.role === 'example') g.examples.push(r);
    }
    for (const g of groups.values()) {
      if (!g.word) continue;
      const ex = g.examples.find(r => r.text?.trim()) || null;
      const it = itemOf('kinfure', g.word.text.trim(), ex?.text?.trim(), { ja: g.word.ja || '', exampleJa: ex?.ja || '' });
      it.rows.word = g.word.id; it.refs.word = refInfo(g.word, 'word', it, all, ctx);
      if (ex) { it.rows.example = ex.id; it.refs.example = refInfo(ex, 'example', it, all, ctx); }
      if (!it.refs.word) it.issues.push('見出し語の音声が未割当');
      if (ex && !it.refs.example) it.issues.push('例文の音声が未割当');
      items.push(it);
    }
  } else if (profile === 'wordlist') {
    script.forEach((r, i) => {
      if (r.role === 'example' || !headLike(r.text)) return;
      const head = stripNo(r.text);
      // 次の見出し語までの間にある、その語を含む文を例文にする
      let ex = null;
      for (let k = i + 1; k < script.length && k <= i + 3; k++) {
        if (headLike(script[k].text) && script[k].role !== 'example') break;
        if (sentenceLike(script[k].text) && findPhrase(script[k].text, head) >= 0) { ex = script[k]; break; }
      }
      const it = itemOf('wordlist', head, ex?.text?.trim(), { ja: r.ja || '', exampleJa: ex?.ja || '' });
      it.rows.word = r.id; it.refs.word = refInfo(r, 'word', it, all, ctx);
      if (ex) { it.rows.example = ex.id; it.refs.example = refInfo(ex, 'example', it, all, ctx); }
      if (!it.refs.word) it.issues.push('見出し語の音声が未割当');
      items.push(it);
    });
  } else {   // dialogue / prose: 単語リスト（対象フレーズ）が必要
    const targets = (wordList || []).map(t => typeof t === 'string' ? { head: t } : t).filter(t => keyOf(t.head));
    if (!targets.length) notes.push('この教材は単語リスト（対象フレーズ）を指定すると、文中のフレーズを登録できます。リストなしで文や発話をそのまま登録するには「文章・発話全体」を選んでください');
    const used = new Set();
    for (const t of targets) {
      const row = script.find(r => !used.has(r.id) && findPhrase(r.text, t.head) >= 0);
      const it = itemOf(profile, stripNo(t.head), row?.text?.trim(), { ja: t.ja || '', exampleJa: row?.ja || '' });
      if (!row) { it.issues.push('教材の中にこのフレーズが見つかりません'); items.push(it); continue; }
      used.add(row.id);
      it.rows.sentence = row.id; it.rows.example = row.id;
      const sentence = refInfo(row, 'sentence', it, all, ctx);
      it.refs.sentence = sentence;
      if (sentence) it.refs.example = { ...sentence, kind: 'example' };
      else it.issues.push('発話の音声が未割当');
      const sub = phraseRange(row, t.head), g = pickReading(row.segments)?.seg;
      if (sub && g && sub.start >= g.start - .05 && sub.end <= g.end + .05) {
        const ref = makeRef({ store: g.store, key: g.key, size: g.size, start: sub.start, end: sub.end, limit: { min: g.start, max: g.end }, origin: { ...sentence.ref.origin, text: it.head }, state: 'unconfirmed' });
        it.rows.word = row.id; it.refs.word = { ref, rowId: row.id, tier: 'low', score: 0, reasons: [], repeats: 1, kind: 'word', fromTimings: true };
      } else if (g) {
        // 語ごとの時刻がない: 位置は文字数からの推定にすぎない。候補として示すだけで、確定にはしない。
        const k = findPhrase(row.text, t.head), ts = words(row.text), n = ts.length, hn = words(t.head).length;
        const d = g.end - g.start;
        it.candidates = [{ start: round(g.start + d * k / n), end: round(g.start + d * (k + hn) / n), score: .3, source: 'estimate', est: true, text: it.head, src: { store: g.store, key: g.key, size: g.size }, sourceKey: g.sourceKey }];
        it.issues.push('文中の位置は推定のみ（試聴して確定してください）');
      }
      items.push(it);
    }
  }
  // 同じ鍵の項目（同じ単語が複数回出る教材）は別の項目として残す
  const seen = new Map();
  items.forEach((it, i) => { it.order = i; const n = (seen.get(it.key) || 0) + 1; seen.set(it.key, n); if (n > 1) it.key += '#' + n; });
  return { items, notes };
}

// ================= 3. 確信度 =================
// 点数の内訳（根拠は reasons に残す）。推定時刻・未確認の行は、他の条件が良くても mid を超えない。
export const TIER = { high: .72, mid: .45 };
function regionsFor(ctx, sourceKey) { return ctx.regions?.get?.(sourceKey) || ctx.regions?.[sourceKey] || null; }
export function gradeRef(ri, row, item, ctx = {}) {
  if (!ri) return null;
  const { ref } = ri, reasons = [];
  const kind = ri.kind, d = ref.end - ref.start;
  let s = row?.confirmed ? (row.manual ? .95 : .70) : row?.estimated ? .15 : row?.asr ? .2 : .3;
  reasons.push(row?.confirmed ? (row.manual ? '手で確定' : '照合済み') : row?.estimated ? '時刻は推定' : '未確認');
  const word = kind === 'word', okDur = word ? d >= .15 && d <= 3.5 : d >= .5 && d <= 20, badDur = word ? d < .1 || d > 6 : d < .3 || d > 30;
  if (okDur) s += .05; else if (badDur) { s -= .3; reasons.push(`長さが不自然（${d.toFixed(2)}秒）`); }
  // 他の行の音声との重なり
  const own = new Set([ri.rowId]);
  const key = (ctx.sourceKeyOf?.(ref)) ?? `${ref.src.store === 'studio' ? 'src' : 'vblobs'}:${ref.src.key}`;
  let overlaps = 0;
  for (const o of ctx.all || []) {
    if (own.has(o.rowId) || o.sourceKey !== key) continue;
    if (Math.min(o.end, ref.end) - Math.max(o.start, ref.start) > .05) overlaps++;
  }
  if (overlaps) { s -= Math.min(.5, .35 * overlaps); reasons.push(`ほかの行の音声と${overlaps}か所重なる`); }
  // 復唱の揃い
  if (kind === 'example' && ri.repeats > 1) { if (ri.unsure) { s -= .25; reasons.push('復唱の長さが揃わない'); } else { s += .05; reasons.push(`復唱${ri.repeats}回が揃う`); } }
  // 並び順（見出し語は前の項目より後ろにあるはず）
  const prev = ctx.prevEnd?.get?.(item.key);
  if (prev && (kind === 'word' || kind === 'example') && prev.sourceKey === key) {
    if (ref.start >= prev.end - .05) { s += .05; } else { s -= .25; reasons.push('前の項目より前にある（並びが逆）'); }
  }
  // 無音・発話の境界
  const regs = regionsFor(ctx, key);
  if (regs?.length) {
    const hit = regs.filter(([a, z]) => Math.min(z, ref.end) - Math.max(a, ref.start) > .03);
    if (hit.length) {
      const [a0] = hit[0], z1 = hit.at(-1)[1];
      if (ref.start > a0 + .25) { s -= .2; reasons.push('語頭が欠けている可能性'); } else s += .03;
      if (ref.end < z1 - .3) { s -= .2; reasons.push('語尾が欠けている可能性'); } else s += .03;
      if (word && hit.length >= 2) { s -= .2; reasons.push('見出し語に別の発話が混ざる'); }
    }
  }
  // 文字起こしとの照合: その範囲を聞き取った結果が見出し語と食い違えば確信度を下げる（一致すれば上げる）
  if (ctx.evidence?.length && (kind === 'word' || kind === 'sentence')) {
    const over = ctx.evidence.filter(e => e.sourceKey === key && Math.min(e.end, ref.end) - Math.max(e.start, ref.start) >= .5 * Math.min(e.end - e.start, ref.end - ref.start));
    if (over.length) {
      const best = Math.max(...over.map(e => matchCue(item.head, e).score));
      if (best >= .85) { s += .1; reasons.push('文字起こしと一致'); } else if (best < .3) { s -= .3; reasons.push('文字起こしと食い違う'); }
    }
  }
  if (!row?.confirmed) s = Math.min(s, TIER.mid - .01);
  s = Math.max(0, Math.min(1, s));
  const tier = s >= TIER.high ? 'high' : s >= TIER.mid ? 'mid' : 'low';
  return { ...ri, score: +s.toFixed(2), tier, reasons, ref: { ...ref, state: tier === 'high' ? 'confirmed' : 'unconfirmed' } };
}
export function gradeItems(items, rows, ctx = {}) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const all = allSegments(rows);
  const prevEnd = new Map();
  let last = null;
  const sourceKeyOf = ref => (ref.src.store === 'studio' ? 'src:' : 'vblobs:') + ref.src.key;
  for (const it of items) {
    const first = it.refs.word || it.refs.sentence;
    if (first) { const k = sourceKeyOf(first.ref); if (last && last.sourceKey === k) prevEnd.set(it.key, last); }
    const tail = it.refs.example || first;
    if (tail) last = { sourceKey: sourceKeyOf(tail.ref), end: tail.ref.end };
  }
  const gctx = { ...ctx, all, prevEnd, sourceKeyOf };
  for (const it of items) {
    for (const kind of ['word', 'example', 'sentence']) {
      const ri = it.refs[kind];
      if (!ri || ri.manualConfirmed) continue;   // 手で確定した参照は、再計算で変えない
      it.refs[kind] = gradeRef(ri, byId.get(ri.rowId), it, gctx);
    }
    if (it.refs.sentence && it.refs.example && it.rows.sentence === it.rows.example) it.refs.example = { ...it.refs.sentence, kind: 'example' };
    it.state = deriveState(it);
  }
  return items;
}

// ================= 4. 状態 =================
export function primaryKind(item, mode) { return mode === 'sentence' ? 'sentence' : 'word'; }
export function deriveState(item, mode = null) {
  if (item.registeredId && item.state !== 'broken') return 'registered';
  if (item.state === 'running') return 'running';
  const kind = mode ? primaryKind(item, mode) : (item.profile === 'sentence' ? 'sentence' : 'word');
  const ri = item.refs[kind];
  if (ri?.broken) return 'broken';
  if (ri && ri.tier === 'high') return 'confirmed';
  if (ri || item.candidates?.length) return 'candidates';
  return 'unresolved';
}
export const isRegistrable = (item, mode) => {
  const ri = item.refs[mode === 'sentence' ? 'sentence' : 'word'];
  return Boolean(ri && ri.ref.state === 'confirmed' && !ri.broken);
};
export function summarize(items, mode = 'head') {
  const s = { total: items.length, wordConfirmed: 0, exampleConfirmed: 0, sentenceConfirmed: 0, candidates: 0, unresolved: 0, broken: 0, registered: 0, registrable: 0, complete: 0 };
  for (const it of items) {
    const st = it.state || deriveState(it, mode), k = mode === 'sentence' ? 'sentence' : 'word';
    if (it.refs.word?.ref.state === 'confirmed') s.wordConfirmed++;
    if (it.refs.example?.ref.state === 'confirmed') s.exampleConfirmed++;
    if (it.refs.sentence?.ref.state === 'confirmed') s.sentenceConfirmed++;
    if (st === 'candidates') s.candidates++; else if (st === 'unresolved') s.unresolved++; else if (st === 'broken') s.broken++; else if (st === 'registered') s.registered++;
    if (isRegistrable(it, mode)) s.registrable++;
    const wantEx = mode === 'example' && Boolean(it.example);   // 例文のある項目は、例文の音声まで確定して完了
    if (isRegistrable(it, mode) && (!wantEx || it.refs.example?.ref.state === 'confirmed')) s.complete++;
  }
  return s;
}

// ================= 5. 局所的な再照合 =================
// 音韻の骨格（母音を落とし、有声・無声の対を同じ扱いにする）。聞き間違い（allocate → a locate）を同じ語として扱うため。
export function phoneticKey(text) {
  let s = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/^kn/, 'n').replace(/^gn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/tch/g, 'x').replace(/dge/g, 'j')
    .replace(/sch/g, 'sk').replace(/gh(?!$)/g, '').replace(/gh$/, 'f').replace(/[sc]h/g, 'x').replace(/th/g, 't').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/q/g, 'k').replace(/x(?!$)/g, 'x').replace(/z/g, 's').replace(/mb$/, 'm');
  const first = s[0];
  const map = { b: 'p', p: 'p', d: 't', t: 't', g: 'k', k: 'k', v: 'f', f: 'f', s: 's', j: 'x', x: 'x', l: 'l', r: 'r', m: 'm', n: 'n', w: '', h: '', y: '' };
  let out = /[aeiouy]/.test(first) ? 'a' : '';
  for (const ch of s) { const c = /[aeiou]/.test(ch) ? '' : map[ch] ?? ''; if (c && out.at(-1) !== c) out += c; }
  return out;
}
const editDistance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const charSim = (a, b) => { a = a.replace(/\s/g, ''); b = b.replace(/\s/g, ''); return !a || !b ? 0 : 1 - editDistance(a, b) / Math.max(a.length, b.length); };
export function phoneticSim(a, b) {
  const x = phoneticKey(a), y = phoneticKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return x.length >= 3 && y.length >= 3 ? Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length) * 1.4) : 0;
}
// 見出し語 head と、文字起こし1件 cue の一致度（0〜1）と、その中で見出し語にあたる範囲
export function matchCue(head, cue) {
  const H = keyOf(head), C = keyOf(cue.text);
  if (!H || !C) return { score: 0 };
  if (H === C) return { score: 1, range: { start: cue.start, end: cue.end }, why: '一致' };
  const hs = words(head).map(w => stem(w.w)), cs = words(cue.text).map(w => stem(w.w));
  for (let i = 0; i + hs.length <= cs.length; i++) if (hs.every((h, k) => cs[i + k] === h)) {
    const r = Array.isArray(cue.wordTimings) ? phraseRange({ wordTimings: cue.wordTimings }, head) : null;
    if (r) return { score: .95, range: r, why: '文中に一致（語ごとの時刻）' };
    return { score: .6, range: null, why: '文中に一致（位置は推定）', est: true };
  }
  const text = Math.max(similarity(H, C), charSim(H, C));
  const phon = phoneticSim(H, C);
  const score = Math.max(.9 * text, .85 * phon);
  return { score: +score.toFixed(3), range: { start: cue.start, end: cue.end }, why: phon > text ? '発音が近い' : '字面が近い' };
}
// 発話の境界に合わせる: 語頭・語尾の欠けを広げ、別の発話の混入は落とす。前後の行の音声には入らない。
export function snapRange(range, regions, { limit = null, kind = 'word', padBefore = .06, padAfter = .14, joinGap = .6 } = {}) {
  if (!regions?.length) return { ...range, snapped: false };
  const hit = regions.filter(([a, z]) => Math.min(z, range.end) - Math.max(a, range.start) > .03);
  if (!hit.length) return { ...range, snapped: false };
  let use = hit, trimmed = false;
  if (kind === 'word' && hit.length > 1) {
    // 見出し語は、割り当ての「始まり」が合っていて終わりが次の発話に伸びていることが多い: 重なりがほぼ同じなら前の発話を取る
    const ov = r => Math.min(r[1], range.end) - Math.max(r[0], range.start), top = Math.max(...hit.map(ov));
    use = [hit.find(r => ov(r) >= top - .1)];
    trimmed = true;
  } else if (hit.length > 1) {
    const joined = [hit[0]];
    for (const r of hit.slice(1)) { if (r[0] - joined.at(-1)[1] <= joinGap) joined.at(-1)[1] = r[1]; else joined.push(r); }
    use = joined.length === 1 ? joined : [joined.reduce((b, r) => (r[1] - r[0] > b[1] - b[0] ? r : b))];
  }
  const a = use[0][0], z = use.at(-1)[1];
  const start = Math.max(limit?.min ?? 0, a - padBefore), end = Math.min(limit?.max ?? Infinity, z + padAfter);
  if (!(end > start)) return { ...range, snapped: false };
  return { start: round(start), end: round(end), snapped: true, trimmed, extendedHead: start < range.start - .02, extendedTail: end > range.end + .02 };
}
const iou = (a, b) => { const i = Math.min(a.end, b.end) - Math.max(a.start, b.start); return i <= 0 ? 0 : i / (Math.max(a.end, b.end) - Math.min(a.start, b.start)); };

// 確定済みの参照を発話の境界に合わせる（語頭・語尾の欠けを広げ、別の発話の混入を落とす）。行そのものは変えず、参照（単語に保存する範囲）だけを調整する。
// 元の範囲は ref.orig に残す。調整幅は語頭 0.3 秒・語尾 0.4 秒まで（それ以上ずれるものは候補として人が確認する）。
export function refineRefs(items, regions, { mode = 'head', maxHead = .3, maxTail = .4 } = {}) {
  let n = 0;
  const sk = ref => (ref.src.store === 'studio' ? 'src:' : 'vblobs:') + ref.src.key;
  for (const it of items) for (const kind of ['word', 'example', 'sentence']) {
    const ri = it.refs[kind];
    if (!ri || ri.ref.state !== 'confirmed' || ri.ref.snapped || ri.ref.manual) continue;
    const regs = regionsFor({ regions }, sk(ri.ref));
    if (!regs?.length) continue;
    const { start, end, limit } = ri.ref;
    const sn = snapRange({ start, end }, regs, { limit, kind: kind === 'word' ? 'word' : 'sentence' });
    if (!sn.snapped || Math.abs(sn.start - start) > maxHead || Math.abs(sn.end - end) > maxTail || (sn.start === start && sn.end === end)) continue;
    it.refs[kind] = { ...ri, reasons: [...ri.reasons, '発話の境界に合わせた'], ref: { ...ri.ref, start: sn.start, end: sn.end, snapped: true, orig: { start, end } } };
    n++;
  }
  return n;
}

// items は教材の順序どおり。確定済み(high)の音声を「錨」にして、錨と錨のあいだ（ギャップ）だけを調べる。
// ギャップの中の未確定の項目は、教材の順序のまま、窓の中の音声に1対1で対応づける（順序を保つ割り当て）。
// ctx: { evidence:[{id,text,start,end,sourceKey,store,key,size,wordTimings?}], regions, mode, maxWindow, origin }
export function recheckItems(items, ctx = {}) {
  const { evidence = [], mode = 'head', maxWindow = 60 } = ctx;
  const sk = ref => (ref.src.store === 'studio' ? 'src:' : 'vblobs:') + ref.src.key;
  const kind = mode === 'sentence' ? 'sentence' : 'word';
  // 錨 = 確定済みの見出し語（確定した例文があれば、その終わりまで）
  const spanOf = it => {
    const w = it.refs[kind], e = it.refs.example;
    if (w?.tier !== 'high') return null;
    const tail = e && e.tier === 'high' && sk(e.ref) === sk(w.ref) && e.ref.start >= w.ref.start ? e.ref.end : w.ref.end;
    return { sourceKey: sk(w.ref), start: w.ref.start, end: tail };
  };
  const anchors = items.map(spanOf);
  const taken = anchors.filter(Boolean);
  const free = evidence.filter(e => !taken.some(t => t.sourceKey === e.sourceKey && Math.min(t.end, e.end) - Math.max(t.start, e.start) > .1));
  const result = [];
  const standaloneOf = it => e => !(kind === 'word' && (it.profile === 'kinfure' || it.profile === 'wordlist')) || wc(e.text) <= Math.max(3, wc(it.head) + 2);
  for (let i = 0; i < items.length;) {
    if (anchors[i]) { i++; continue; }
    let j = i; while (j < items.length && !anchors[j]) j++;
    const gap = items.slice(i, j), prev = i > 0 ? anchors[i - 1] : null, next = j < items.length ? anchors[j] : null;
    const own = gap.map(it => it.refs[kind]).find(Boolean);
    const source = prev?.sourceKey ?? next?.sourceKey ?? (own ? sk(own.ref) : free[0]?.sourceKey);
    if (!source) { gap.forEach(it => result.push({ key: it.key, skipped: 'no-source' })); i = j; continue; }
    const lo = prev && prev.sourceKey === source ? prev.end - .05 : next && next.sourceKey === source ? next.start - maxWindow : 0;
    const hi = next && next.sourceKey === source ? next.start + .05 : prev && prev.sourceKey === source ? prev.end + maxWindow : Infinity;
    const cues = free.filter(e => e.sourceKey === source && e.start >= lo && e.end <= hi).sort((a, b) => a.start - b.start);
    const regs = regionsFor(ctx, source);
    // 項目×音声の一致度
    // 金フレ型・単語型では、例文の中に見出し語がある発話（「Let's try anyway.」の anyway）は、見出し語の発話ではない（例文の音声）。見出し語の確定には使わない
    const M = gap.map(it => cues.map(c => { const x = matchCue(it.head, c), inSentence = (it.profile === 'kinfure' || it.profile === 'wordlist') && kind === 'word' && /^文中/.test(x.why || ''); return { ...x, standalone: standaloneOf(it)(c) && !inSentence }; }));
    // 順序を保つ割り当て（DP）: 一致度0.6以上の組だけ。1つの音声は1項目まで。項目の順序と音声の時間順が一致する。
    const n = gap.length, m = cues.length, dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1)), how = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    for (let a = 1; a <= n; a++) for (let c = 1; c <= m; c++) {
      const x = M[a - 1][c - 1], w = x.standalone && x.score >= .6 ? x.score : -1;
      let best = dp[a - 1][c], h = 1;                       // この項目は音声を取らない
      if (dp[a][c - 1] > best) { best = dp[a][c - 1]; h = 2; }   // この音声は使わない
      if (w > 0 && dp[a - 1][c - 1] + w > best) { best = dp[a - 1][c - 1] + w; h = 3; }
      dp[a][c] = best; how[a][c] = h;
    }
    const assigned = new Array(n).fill(-1);
    for (let a = n, c = m; a > 0 && c > 0;) { const h = how[a][c]; if (h === 3) { assigned[a - 1] = c - 1; a--; c--; } else if (h === 2) c--; else a--; }
    gap.forEach((it, gi) => {
      const cur = it.refs[kind];
      const rank = M[gi].map((x, ci) => ({ x, ci, cue: cues[ci] })).filter(r => r.x.score >= .35);
      const ai = assigned[gi], mine = ai >= 0 ? M[gi][ai] : null;
      const others = rank.filter(r => r.ci !== ai && !assigned.includes(r.ci) && r.x.standalone);
      // 候補（確定には使わない）: 割り当てた音声を先頭に、一致度の高い順
      const toCand = ({ x, ci, cue }) => {
        let range = x.range, est = Boolean(x.est) || !x.standalone, boundary = .5;
        if (range && regs?.length) { const sn = snapRange(range, regs, { kind: kind === 'sentence' ? 'sentence' : 'word' }); if (sn.snapped) { range = { start: sn.start, end: sn.end }; boundary = sn.trimmed ? .6 : 1; } else boundary = .3; }
        if (!range) { range = { start: cue.start, end: cue.end }; est = true; }
        const structure = ci === ai ? 1 : .4, around = (idx, ref) => (cues[idx] && ref ? matchCue(ref, cues[idx]).score : 0);
        const context = Math.min(1, (around(ci - 1, items[i + gi - 1]?.head) >= .6 ? .5 : 0) + (around(ci + 1, items[i + gi + 1]?.head) >= .6 ? .5 : 0));
        const score = x.score < .4 ? Math.min(.3, .5 * x.score) : .45 * x.score + .2 * structure + .15 * context + .1 * boundary + .1 * (ci === ai ? 1 : .5);
        return { start: round(range.start), end: round(range.end), score: +score.toFixed(3), textScore: x.score, structure, source: 'asr', est, why: x.why, text: cue.text, cueId: cue.id, src: { store: cue.store, key: cue.key, size: cue.size }, sourceKey: cue.sourceKey };
      };
      const top = rank.sort((p, q) => (q.ci === ai) - (p.ci === ai) || q.x.score - p.x.score).slice(0, 3).map(toCand);
      const best = top[0];
      const unique = best && (!others.length || others.every(o => o.x.score < (mine?.score ?? best.textScore) - .05));
      let outcome = 'none';
      if (cur) {
        const near = top.find(c => iou({ start: cur.ref.start, end: cur.ref.end }, c) >= .5);
        const manyHits = rank.filter(r => r.x.standalone && r.x.score >= .85).length > 1;
        outcome = near && near.textScore >= .85 && !manyHits ? 'agree' : best && !near ? 'differs' : 'no-support';
      } else if (best) outcome = mine && best.cueId === cues[ai].id && unique && best.textScore >= .85 && !best.est ? 'found' : 'candidates';
      result.push({ key: it.key, outcome, candidates: top });
      // 抽出のときに付いた「文字数からの推定」の候補は、再照合で消さない（文中の位置を試聴して確定するための唯一の手がかり）
      const estimates = (it.candidates || []).filter(c => c.source === 'estimate');
      it.candidates = [...estimates, ...top.filter(c => !cur || iou({ start: cur.ref.start, end: cur.ref.end }, c) < .5)];
      it.recheck = { at: ctx.now ?? 0, outcome, windowed: [round(Math.max(0, lo)), Number.isFinite(hi) ? round(hi) : null], cues: cues.length, pending: n };
      if (outcome === 'agree' && cur) {
        // 既存の範囲を文字起こしが裏付けた。発話の境界があれば欠け・混入も直す。
        let { start, end } = cur.ref, snapped = false;
        if (regs?.length) { const sn = snapRange({ start, end }, regs, { limit: cur.ref.limit, kind: kind === 'sentence' ? 'sentence' : 'word' }); if (sn.snapped && Math.abs(sn.start - start) <= .3 && Math.abs(sn.end - end) <= .4) { start = sn.start; end = sn.end; snapped = true; } }
        it.refs[kind] = { ...cur, tier: 'high', score: Math.max(cur.score, .8), reasons: [...cur.reasons, '文字起こしで裏付け'], ref: { ...cur.ref, start, end, state: 'confirmed', ...(snapped ? { snapped: true } : {}) } };
        if (cur.ref.state !== 'confirmed') it.recheck.promoted = true;
      } else if (outcome === 'found') {
        const c = cues.find(x => x.id === best.cueId);
        let { start, end } = best;
        const ref = makeRef({ store: c.store, key: c.key, size: c.size, start, end, limit: null, origin: { ...(ctx.origin || {}), text: it.head, ...(it.rows[kind] ? { itemId: it.rows[kind] } : {}) }, state: 'confirmed' });
        it.refs[kind] = { ref, rowId: it.rows[kind], tier: 'high', score: best.score, reasons: ['文字起こしの一致から特定（順序・前後の語と整合）'], repeats: 1, kind, fromRecheck: true };
        it.candidates = top.slice(1);
      }
      it.state = deriveState(it, mode);
    });
    i = j;
  }
  return result;
}
// ================= 5a. 構造からの救済（見出し語 → 例文 → 例文の繰り返し → 無音） =================
// 文字起こしが見出し語を拾えなくても、確定済みの前後の見出し語（錨）にはさまれたギャップを「発話区間の並び」から数えて対応づける。
// 固定の秒数や件数には依存しない。区間の長さの相似（例文の繰り返し）と、ギャップ内の項目数と区間の組数の一致だけを使う。
// 組数が合わない・複数の読み方が成り立つ場合は何も確定しない（候補どまり）。
const rdur = r => r[1] - r[0];
const similarDur = (a, b, tol = .25) => Math.abs(rdur(a) - rdur(b)) <= tol * Math.max(rdur(a), rdur(b));
// 発話区間を「見出し語＋例文（＋同じ長さの繰り返し）」の組に分ける。繰り返しが欠けても、次の組で元に戻る（1組ずつ貪欲に読む）。
export function parseEntryGroups(regs, { tol = .25 } = {}) {
  const out = [];
  for (let i = 0; i < regs.length;) {
    if (i + 1 >= regs.length) { out.push({ head: regs[i], example: null, repeat: null, partial: true }); break; }
    const trip = i + 2 < regs.length && similarDur(regs[i + 1], regs[i + 2], tol);
    out.push({ head: regs[i], example: regs[i + 1], repeat: trip ? regs[i + 2] : null });
    i += trip ? 3 : 2;
  }
  return out;
}
// 区間 regs（錨と錨のあいだ）を n 組に読む。先頭に前の項目の例文・繰り返しが残っていることがあるので、先頭の0〜2区間を読み飛ばす読み方を試し、成り立つ読み方が1つだけのときに採る。
export function readGap(regs, n, { prevExample = null, hasPrev = true } = {}) {
  const fits = [];
  for (const lead of hasPrev ? [0, 1, 2] : [0]) {
    if (lead > regs.length) break;
    if (lead && prevExample && lead > 1) continue;                                           // 前の例文が確定している: 残りは繰り返しの1区間だけ
    if (lead === 1 && prevExample && !similarDur(regs[0], prevExample)) continue;           // 繰り返しなら、前の例文と同じ長さ
    if (lead === 2 && !similarDur(regs[0], regs[1])) continue;                              // 例文＋繰り返しなら、2つは同じ長さ
    const g = parseEntryGroups(regs.slice(lead));
    // 組はすべて「繰り返しあり」か、すべて「繰り返しなし」のどちらか。混ざる読み方は、区間の欠落や雑音で組がずれている疑いがあるので採らない。
    // 繰り返しなしの組なのに、見出し語と例文が同じ長さ = 前の項目の「例文と繰り返し」を見出し語と例文に読んでいる疑いも採らない
    const tr = g.filter(x => x.repeat).length;
    if (g.length === n && !g.some(x => x.partial) && (tr === 0 || tr === n) && !g.some(x => !x.repeat && similarDur(x.head, x.example))) fits.push({ lead, groups: g, triples: g.filter(x => x.repeat).length });
  }
  if (!fits.length) return { ok: false, why: 'count-mismatch', fits: 0 };
  fits.sort((a, b) => b.triples - a.triples || a.lead - b.lead);
  if (fits.length > 1 && fits[0].triples === fits[1].triples) return { ok: false, why: 'ambiguous', fits: fits.length };
  return { ok: true, ...fits[0], fits: fits.length };
}
// 発話区間の前後に余白を足す（語頭・語尾が切れないように）。余白は隣の発話までの無音の半分まで。
// 発話区間の検出は語尾の小さい音を落としやすい（実音声で終わりが 0.05〜0.27 秒早かった）ので、語尾は語頭より広く取る。
const padRange = (r, before, after) => {
  const gb = before == null ? .2 : Math.max(0, r[0] - before), ga = after == null ? .6 : Math.max(0, after - r[1]);
  return { start: round(Math.max(0, r[0] - Math.min(.08, gb / 2))), end: round(r[1] + Math.min(.3, ga / 2)) };
};
// 文の途中の短い息継ぎで1つの発話が2つの区間に割れることがある。無音の中央値（組と組のあいだ・見出し語と例文のあいだ）より十分短い切れ目だけをつなぐ。
export function joinShortGaps(regs) {
  if (regs.length < 6) return regs;
  const gaps = regs.slice(1).map((r, i) => r[0] - regs[i][1]).sort((a, b) => a - b);
  const lim = Math.min(.45, Math.max(.15, .4 * gaps[Math.floor(gaps.length / 2)]));
  const out = [[...regs[0]]];
  for (const r of regs.slice(1)) { if (r[0] - out.at(-1)[1] < lim) out.at(-1)[1] = r[1]; else out.push([...r]); }
  return out;
}
export function structureRescue(items, ctx = {}) {
  const { evidence = [], mode = 'head' } = ctx, out = [];
  if (mode === 'sentence') return out;
  const sk = ref => (ref.src.store === 'studio' ? 'src:' : 'vblobs:') + ref.src.key;
  const head = it => it.refs.word, isHigh = ri => ri?.tier === 'high' && ri.ref.state === 'confirmed';
  const anchorOf = it => {
    const w = head(it), e = it.refs.example;
    if (!isHigh(w)) return null;
    const ex = isHigh(e) && sk(e.ref) === sk(w.ref) && e.ref.start >= w.ref.start ? e.ref : null;
    return { sourceKey: sk(w.ref), src: w.ref.src, start: w.ref.start, end: ex ? ex.end : w.ref.end, example: ex ? [ex.start, ex.end] : null };
  };
  const anchors = items.map(anchorOf);
  for (let i = 0; i < items.length;) {
    if (anchors[i] || items[i].profile !== 'kinfure' || items[i].refs.word?.manualConfirmed) { i++; continue; }
    let j = i; while (j < items.length && !anchors[j] && items[j].profile === 'kinfure') j++;
    const gap = items.slice(i, j), prev = i > 0 ? anchors[i - 1] : null, next = j < items.length ? anchors[j] : null;
    const source = prev?.sourceKey ?? next?.sourceKey;
    const regsAll = source ? regionsFor(ctx, source) : null;
    if (!regsAll?.length || (prev && next && prev.sourceKey !== next.sourceKey)) { out.push(...gap.map(it => ({ key: it.key, outcome: 'none', why: !regsAll?.length ? 'no-regions' : 'sources-differ' }))); i = j; continue; }
    const lo = prev ? prev.end - .02 : 0, hi = next ? next.start + .02 : Infinity;
    let regs = joinShortGaps(regsAll.filter(r => r[0] >= lo && r[1] <= hi));
    const bounded = Boolean(next);
    const src = (prev || next).src;
    const rd = readGap(regs, gap.length, { prevExample: prev?.example || null, hasPrev: Boolean(prev) });
    const srcInfo = { store: src.store, key: src.key, size: src.size };
    const conflicts = (it, g) => evidence.some(e => e.sourceKey === source && Math.min(e.end, g.head[1]) - Math.max(e.start, g.head[0]) > .1 && items.some(o => o !== it && o.profile === 'kinfure' && matchCue(o.head, e).score >= .85) && matchCue(it.head, e).score < .5);
    if (rd.ok && bounded) {
      // 前後が確定した見出し語で、件数が一致: 順序のとおりに対応づけて確定する
      const leadRegs = rd.lead ? regs.slice(0, rd.lead) : [];
      gap.forEach((it, k) => {
        const g = rd.groups[k], before = k ? (rd.groups[k - 1].repeat || rd.groups[k - 1].example)[1] : (leadRegs.at(-1)?.[1] ?? prev?.end ?? null);
        const after = k + 1 < gap.length ? rd.groups[k + 1].head[0] : next?.start ?? null;
        if (conflicts(it, g)) { out.push({ key: it.key, outcome: 'conflict' }); return; }
        const hr = padRange(g.head, before, g.example[0]), er = padRange(g.example, g.head[1], g.repeat ? g.repeat[0] : after);
        const origin = { ...(ctx.origin || {}), text: it.head, ...(it.rows.word ? { itemId: it.rows.word } : {}) };
        it.refs.word = { ref: makeRef({ ...srcInfo, ...hr, limit: null, origin, state: 'confirmed' }), rowId: it.rows.word, tier: 'high', score: .76, reasons: ['無音区間と発話順序から特定（前後の確定した見出し語と件数が一致）'], repeats: 1, kind: 'word', fromStructure: true };
        if (it.example && !isHigh(it.refs.example) && !it.refs.example?.manualConfirmed) {
          const eo = { ...(ctx.origin || {}), text: it.example, ...(it.rows.example ? { itemId: it.rows.example } : {}) };
          it.refs.example = { ref: makeRef({ ...srcInfo, ...er, limit: null, origin: eo, state: 'confirmed' }), rowId: it.rows.example, tier: 'high', score: .74, reasons: ['無音区間と発話順序から特定（繰り返しの1回目）'], repeats: g.repeat ? 2 : 1, kind: 'example', fromStructure: true };
        }
        it.structure = { group: k, repeat: Boolean(g.repeat), lead: rd.lead, head: g.head.map(round), example: g.example.map(round), repeatRegion: g.repeat ? g.repeat.map(round) : null };
        it.candidates = [];
        it.state = deriveState(it, mode);
        out.push({ key: it.key, outcome: 'structure', group: k });
      });
    } else {
      // 確定しない: 前の確定語から順に読める範囲を候補にするだけ（人が試聴して選ぶ）
      const g = parseEntryGroups(regs.slice(prev?.example && regs[0] && similarDur(regs[0], prev.example) ? 1 : 0)).filter(x => !x.partial);
      gap.forEach((it, k) => {
        out.push({ key: it.key, outcome: 'none', why: rd.why || 'open-ended' });
        const x = g[k];
        if (!x || !prev || next) return;
        const r = padRange(x.head, k ? (g[k - 1].repeat || g[k - 1].example)[1] : prev.end, x.example?.[0] ?? null);
        it.candidates = [...(it.candidates || []).filter(c => c.source !== 'structure'), { start: r.start, end: r.end, score: .5, source: 'structure', est: false, why: '発話の並びから推定（確定ではありません）', text: it.head, src: srcInfo, sourceKey: source, textScore: 0 }];
        it.state = deriveState(it, mode);
      });
    }
    i = j;
  }
  return out;
}
// ================= 5b. 人が確定する（候補の選択・開始終了の修正） =================
// 手で確定した参照は ref.manual = true。自動の再照合・再登録・差し替えで上書きしない。
export function confirmRef(item, kind, { src, start, end }, { origin = null, mode = 'head' } = {}) {
  const base = item.refs[kind]?.ref;
  const from = src || base?.src;
  if (!from?.key || !(end > start)) throw new Error('音声の範囲を確認してください');
  const ref = makeRef({ store: from.store, key: from.key, size: from.size, start, end, limit: base?.limit || null,
    origin: origin || base?.origin || { text: item.head }, state: 'confirmed' });
  ref.manual = true;
  item.refs[kind] = { ref, rowId: item.rows[kind] ?? base?.rowId ?? null, tier: 'high', score: 1, reasons: ['手で確定'], repeats: 1, kind, manualConfirmed: true };
  if (kind === 'sentence' && item.refs.example && item.rows.example === item.rows.sentence) item.refs.example = { ...item.refs[kind], kind: 'example' };
  item.state = deriveState(item, mode);
  return item;
}
export function clearRef(item, kind, mode = 'head') {
  item.refs[kind] = null;
  if (kind === 'sentence' && item.refs.example && item.rows.example === item.rows.sentence) item.refs.example = null;
  item.state = deriveState(item, mode);
  return item;
}
// 再実行しても、手で確定した参照と登録済みの印は引き継ぐ（項目は key で対応づける）
export function carryOver(oldItems, newItems, mode = 'head') {
  const old = new Map((oldItems || []).map(i => [i.key, i]));
  for (const it of newItems) {
    const o = old.get(it.key);
    if (!o) continue;
    for (const kind of ['word', 'example', 'sentence']) if (o.refs[kind]?.manualConfirmed) it.refs[kind] = o.refs[kind];
    if (o.registeredId) it.registeredId = o.registeredId;
    if (o.tries) it.tries = o.tries;
    it.state = deriveState(it, mode);
  }
  return newItems;
}

// ================= 6. 登録・既存形式への橋渡し =================
// 項目 → 登録計画（audio-refs.planAudioWords）が受け取る形。確定した音声だけを ref.state 'confirmed' として渡す。
export function toRegistration(items, mode = 'head') {
  return items.map(it => ({
    key: it.key, head: it.head, ja: it.ja, example: it.example, exampleJa: it.exampleJa,
    word: mode === 'sentence' ? null : it.refs.word?.ref || null,
    ex: mode === 'sentence' ? null : it.refs.example?.ref || null,
    sentence: it.profile === 'sentence' || mode === 'sentence' || it.profile === 'dialogue' || it.profile === 'prose' ? it.refs.sentence?.ref || null : null,
    repeats: it.refs.example?.repeats || 0, issues: it.issues,
  }));
}
// 旧形式（金フレ型の1教材を、確信度の判定つきで項目にする）。画面と登録の入口が1つになるまでの互換用。
export function vocabItems(rows, { from, materialId, title = '', regions = null, evidence = null }) {
  const { items } = extractItems(rows, 'kinfure', { from, materialId, title });
  gradeItems(items, rows, { regions, evidence });
  return toRegistration(items, 'head').map((r, i) => ({ ...r, group: items[i].key, issues: items[i].issues.concat(items[i].refs.word && items[i].refs.word.tier !== 'high' ? [`単語の音声位置が未確定（${items[i].refs.word.reasons.join('・')}）`] : []) }));
}
export { sameText };
