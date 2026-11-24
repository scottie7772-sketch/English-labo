// 金フレ型教材: 全体スクリプト（数千行）の中から、1本の音声が収めている範囲を自動で特定する純関数群。
// 画面・保存・音声には一切触れない（テストしやすいように分けてある）。外部通信・課金なし。
//
//  parseKinfureScript(rows)            全体スクリプト → 行(lines)と見出し語グループ(groups)
//  locateRange(script, cues, opts)     文字起こしの並び → 最も確からしい範囲（と別候補・確信度）
//  locateAll(script, items)            フォルダ内の音声を順に特定し、重複・欠落も報告
//  tagRowsToScript(rows, script)       すでに教材に入っている全体スクリプト行 → 全体スクリプトの行番号
//
// 単一の単語の一致だけでは範囲を決めない: 「出現順に並ぶ複数の一致」が、冒頭・中間・末尾の
// それぞれにあるかを見て確信度を決める。
import { words } from './studio-align.js';
import { similarity } from './studio-import-align.js';

export const kfKey = (text) => words(text).map((w) => w.w).join(' ');
const wc = (key) => (key ? key.split(' ').length : 0);

// ---------- 全体スクリプトの構造化 ----------
const NUM_MARK = /^\s*(?:(?:no\.?|#|№)\s*(\d{1,4})\s*[.)．、:：]?|(\d{1,4})\s*(?:[.)．、:：]|\t))\s*(?=\S)/i;
const NUM_BARE = /^\s*(\d{1,4})\s+(?=\S)/;
const NUM_ONLY = /^\s*(?:(?:No\.?|#|№)\s*)?(\d{1,4})\s*[.)．、:：]?\s*$/i;
const headLike = (t) => t.trim().split(/\s+/).length <= 4 && !/[.!?。]["”’)]?$/.test(t.trim());

// rows: [{text, ja?, rep?, kind?}]。番号つきの見出し語があれば(60%以上)その番号を使い、無ければ1から連番。
export function parseKinfureScript(rows) {
  const items = [];
  let pendingNum = null;
  for (const r of rows) {
    const raw = String(r.text ?? '').trim();
    if (!raw) continue;
    if (/[぀-ヿ一-鿿]/.test(raw) && !/[A-Za-z]{2}/.test(raw)) {   // 日本語だけの行は直前の英語行の訳として扱う（見出し語・例文にしない）
      if (items.length && !items.at(-1).ja) items.at(-1).ja = raw;
      continue;
    }
    const only = raw.match(NUM_ONLY);
    if (only && r.kind !== 'example') { pendingNum = +only[1]; continue; }
    let num = pendingNum, text = raw; pendingNum = null;
    let m = raw.match(NUM_MARK);
    if (m) { num = +(m[1] ?? m[2]); text = raw.slice(m[0].length).trim(); }
    else if ((m = raw.match(NUM_BARE)) && headLike(raw.slice(m[0].length)) && r.kind !== 'example') { num = +m[1]; text = raw.slice(m[0].length).trim(); }
    if (!text) continue;
    const head = r.kind === 'word' || (r.kind !== 'example' && headLike(text));
    items.push({ text, ja: r.ja || '', rep: r.rep || 0, kind: head ? 'word' : 'example', num: head ? num : null, was: raw });
  }
  const heads = items.filter((x) => x.kind === 'word');
  const numbered = heads.filter((x) => x.num != null);
  const useNumbers = heads.length > 0 && numbered.length >= heads.length * 0.6;
  const lines = [], groups = [];
  let g = null, seq = 0;
  const open = (head, n, synthetic) => { g = { n, label: head, i0: lines.length, i1: lines.length, synthetic }; groups.push(g); };
  items.forEach((x) => {
    if (x.kind === 'word' || !g) {
      seq++;
      open(x.kind === 'word' ? x.text : '', useNumbers && x.num != null ? x.num : seq, !(useNumbers && x.num != null));
    }
    lines.push({ i: lines.length, n: g.n, text: x.text, ja: x.ja, rep: x.rep, kind: x.kind, key: kfKey(x.text) });
    g.i1 = lines.length;
  });
  return { lines, groups, numbered: useNumbers, count: lines.length };
}

// 行番号 → グループ
export const groupOfLine = (script, i) => {
  const gs = script.groups; let lo = 0, hi = gs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (gs[mid].i0 <= i) lo = mid; else hi = mid - 1; }
  return gs[lo];
};
// 番号 → グループの位置（番号が重複・飛びのときは最初のもの）
export const groupIndexByNumber = (script, n) => script.groups.findIndex((g) => g.n === n);

// ---------- 索引（全体スクリプトごとに1回） ----------
export function indexScript(script) {
  if (script._index) return script._index;
  const exact = new Map(), byWord = new Map();
  for (const l of script.lines) {
    if (!l.key) continue;
    if (!exact.has(l.key)) exact.set(l.key, []);
    exact.get(l.key).push(l.i);
    if (l.kind === 'example') for (const w of new Set(l.key.split(' '))) if (w.length >= 4) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(l.i);
    }
  }
  for (const [w, list] of byWord) if (list.length > 40) byWord.delete(w);   // ありふれた語は手がかりにしない
  return (script._index = { exact, byWord });
}

// 1つの文字起こし行に合う全体スクリプトの行（重み付き）
function candidatesFor(script, cue) {
  const { exact, byWord } = indexScript(script);
  const key = kfKey(cue.text), n = wc(key);
  if (!n) return [];
  const out = new Map();
  const hit = exact.get(key);
  if (hit) {
    const base = n >= 5 ? 1 : n >= 3 ? 0.8 : 0.35;                 // 短い見出し語は弱い手がかり
    if (hit.length <= 4) for (const i of hit) out.set(i, base / Math.sqrt(hit.length));
  }
  if (n >= 4 && !out.size) {                                        // 聞き間違いを含む例文: 共通の語が多い行だけを比べる
    const votes = new Map();
    for (const w of new Set(key.split(' '))) for (const i of byWord.get(w) || []) votes.set(i, (votes.get(i) || 0) + 1);
    const need = Math.max(2, Math.ceil(n * 0.5));
    const top = [...votes].filter(([, v]) => v >= need).sort((a, b) => b[1] - a[1]).slice(0, 25);
    for (const [i] of top) {
      const l = script.lines[i];
      if (Math.abs(wc(l.key) - n) > 3) continue;
      const s = similarity(l.key, key);
      if (s >= 0.8) out.set(i, s * 0.9);
    }
    if (out.size > 3) out.clear();                                  // あいまいすぎる
  }
  return [...out].map(([i, w]) => ({ i, w }));
}

// ---------- 範囲の特定 ----------
// cues: [{text, start, end}] 時間順。opts.hint = {a,b} 番号の補助情報、opts.after = 前の音声の終わりの行番号（弱い手がかり）
export function locateRange(script, cues, opts = {}) {
  const maxJump = opts.maxJump ?? 60;
  const list = cues.filter((c) => kfKey(c.text));
  const total = list.length;
  const t0 = list.length ? Math.min(...list.map((c) => c.start ?? 0)) : 0;
  const t1 = list.length ? Math.max(...list.map((c) => c.end ?? c.start ?? 0)) : 0;
  const nodes = [];
  list.forEach((c, ci) => { for (const k of candidatesFor(script, c)) nodes.push({ ci, i: k.i, w: k.w, t: ((c.start ?? 0) + (c.end ?? c.start ?? 0)) / 2 }); });
  const empty = { ok: false, confidence: 0, level: 'none', reason: total ? '全体スクリプトと一致する行が見つかりません' : '文字起こしがありません', total, alternatives: [] };
  if (!nodes.length) return empty;

  // 順序を保つ最良の連なり（行番号は単調に増える。同じ行の繰り返し読みは許す）。nodesはcue順→行順に並んでいる。
  const best = (usable) => {
    const N = nodes.length, score = new Float64Array(N), prev = new Int32Array(N).fill(-1);
    let top = -1;
    for (let a = 0; a < N; a++) {
      if (!usable(nodes[a])) { score[a] = -1; continue; }
      score[a] = nodes[a].w;
      for (let b = 0; b < a; b++) {
        if (score[b] < 0 || nodes[b].ci >= nodes[a].ci) continue;
        const jump = nodes[a].i - nodes[b].i;
        if (jump < 0 || jump > maxJump) continue;
        const s = score[b] + nodes[a].w - 0.02 * Math.max(0, jump - 3);
        if (s > score[a]) { score[a] = s; prev[a] = b; }
      }
      if (top < 0 || score[a] > score[top]) top = a;
    }
    if (top < 0) return null;
    const chain = []; for (let k = top; k >= 0; k = prev[k]) chain.push(nodes[k]);
    return chain.reverse();
  };
  const describe = (chain) => {
    // 両端の弱い・離れた一致を落とす
    let a = 0, z = chain.length - 1;
    while (a < z && chain[a].w < 0.5 && chain[a + 1].i - chain[a].i > 12) a++;
    while (z > a && chain[z].w < 0.5 && chain[z].i - chain[z - 1].i > 12) z--;
    const c = chain.slice(a, z + 1);
    const lines = new Set(c.map((x) => x.i));
    const strong = [...new Map(c.filter((x) => x.w >= 0.7).map((x) => [x.i, x])).values()];
    const i0 = c[0].i, i1 = c.at(-1).i;
    const g0 = groupOfLine(script, i0), g1 = groupOfLine(script, i1);
    const span = Math.max(1, t1 - t0), third = (x) => Math.min(2, Math.floor(((x.t - t0) / span) * 3));
    const thirds = new Set(strong.map(third));
    const sum = c.reduce((s, x) => s + x.w, 0);
    const matchedCues = new Set(c.map((x) => x.ci)).size;
    return { chain: c, i0: g0.i0, i1: g1.i1 - 1, firstLine: i0, lastLine: i1, g0, g1, strong: strong.length, thirds: thirds.size,
      lines: lines.size, sum, coverage: total ? matchedCues / total : 0 };
  };
  const first = best(() => true);
  if (!first) return empty;
  const d = describe(first);
  // 別候補: 最良の範囲(前後に余裕を持たせて)を除いた連なり
  const alts = [];
  let blocked = [[d.i0 - 20, d.i1 + 20]];
  for (let k = 0; k < 2; k++) {
    const ch = best((n) => !blocked.some(([a, b]) => n.i >= a && n.i <= b));
    if (!ch) break;
    const e = describe(ch);
    if (e.strong < 2) break;
    alts.push(e); blocked = [...blocked, [e.i0 - 20, e.i1 + 20]];
  }
  // 確信度: 強い一致の数・冒頭中間末尾への分布・文字起こし行の説明率・2位との差
  let conf = 0;
  conf += Math.min(0.4, d.strong * 0.04);
  conf += d.thirds >= 3 ? 0.25 : d.thirds === 2 ? 0.1 : 0;
  conf += Math.min(0.25, d.coverage * 0.35);
  const rival = alts[0] ? alts[0].sum / d.sum : 0;
  conf += rival < 0.4 ? 0.1 : rival < 0.6 ? 0.03 : -0.15;
  if (opts.hint && d.g0 && d.g1 && opts.hint.a <= d.g1.n && opts.hint.b >= d.g0.n) conf += 0.05;
  conf = Math.max(0, Math.min(1, conf));
  const needStrong = d.strong >= 3 && d.thirds >= 2;               // 単独・少数の一致では確定しない
  const level = !needStrong ? 'low' : conf >= 0.75 ? 'high' : conf >= 0.5 ? 'mid' : 'low';
  const shape = (e) => ({ startN: e.g0.n, endN: e.g1.n, startLine: e.i0, endLine: e.i1, startLabel: e.g0.label, endLabel: e.g1.label,
    groups: groupIndexSpan(script, e), lines: e.i1 - e.i0 + 1, strong: e.strong, thirds: e.thirds });
  return { ok: needStrong, ...shape(d), confidence: +conf.toFixed(2), level, total, matched: d.lines, coverage: +d.coverage.toFixed(2),
    reason: needStrong ? '' : '一致が少ない／偏っているため確定できません', alternatives: alts.map((e) => shape(e)) };
}
const groupIndexSpan = (script, e) => script.groups.indexOf(e.g1) - script.groups.indexOf(e.g0) + 1;

// ファイル名から「0101-0150」のような番号範囲（補助情報）。確かな形のときだけ返す。
export function nameHint(name, max = 9999) {
  const m = String(name || '').replace(/\.[^.]+$/, '').match(/(?:^|\D)(\d{1,4})\s*[-~〜–_]\s*(\d{1,4})(?:\D|$)/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return a < b && b <= max && b - a >= 5 ? { a, b } : null;
}

// ---------- フォルダ内の複数音声 ----------
// items: [{id, name, cues}] を並び順に。前の音声の終わりの次から始まる、という弱い期待は確信度にだけ使う。
export function locateAll(script, items) {
  const results = items.map((it) => ({ id: it.id, name: it.name, ...locateRange(script, it.cues, { hint: nameHint(it.name) }) }));
  return { results, ...coverageReport(script, results) };
}
// 重複・欠落の報告。意図的な重複は誤りとして扱わない（報告のみ）。
export function coverageReport(script, results, override = {}) {
  const spans = results.map((r) => {
    const o = override[r.id];
    return o || (r.startLine != null ? { startLine: r.startLine, endLine: r.endLine, startN: r.startN, endN: r.endN } : null);
  });
  const overlaps = [], covered = new Uint8Array(script.lines.length);
  const have = results.map((r, k) => ({ r, s: spans[k] })).filter((x) => x.s);
  for (const { s } of have) covered.fill(1, s.startLine, s.endLine + 1);
  for (let a = 0; a < have.length; a++) for (let b = a + 1; b < have.length; b++) {
    const lo = Math.max(have[a].s.startLine, have[b].s.startLine), hi = Math.min(have[a].s.endLine, have[b].s.endLine);
    if (lo <= hi) overlaps.push({ a: have[a].r.id, b: have[b].r.id, fromN: groupOfLine(script, lo).n, toN: groupOfLine(script, hi).n, lines: hi - lo + 1 });
  }
  const gaps = [];
  if (have.length) {
    const min = Math.min(...have.map((x) => x.s.startLine)), max = Math.max(...have.map((x) => x.s.endLine));
    let run = null;
    for (let i = min; i <= max; i++) {
      if (!covered[i]) { if (!run) run = i; }
      else if (run != null) { gaps.push({ fromN: groupOfLine(script, run).n, toN: groupOfLine(script, i - 1).n, lines: i - run }); run = null; }
    }
  }
  return { overlaps, gaps, unresolved: results.filter((r, k) => !spans[k]).map((r) => r.id) };
}

// ---------- すでに教材にある全体スクリプトの行 → 全体スクリプトの行番号 ----------
// rows: 教材のスクリプト行（表示順）。前から順に、同じ文を持つ次の行を探す（同じ文が複数あっても順序で対応）。
export function tagRowsToScript(rows, script) {
  const pos = new Map();
  script.lines.forEach((l) => { if (!pos.has(l.key)) pos.set(l.key, []); pos.get(l.key).push(l.i); });
  const used = new Map(), out = [];
  let floor = -1;
  for (const r of rows) {
    const key = kfKey(r.text), ps = pos.get(key);
    if (!ps) { out.push(null); continue; }
    const k = used.get(key) || 0;
    let i = ps.find((x) => x > floor);
    if (i == null) i = ps[Math.min(k, ps.length - 1)];
    if (i > floor) floor = i;
    used.set(key, k + 1);
    out.push(i);
  }
  return out;
}

// 範囲を (開始番号, 終了番号) から行番号へ。番号が見つからなければ null。
export function rangeFromNumbers(script, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let g0 = script.groups.findIndex((g) => g.n >= lo);
  let g1 = -1;
  for (let k = script.groups.length - 1; k >= 0; k--) if (script.groups[k].n <= hi) { g1 = k; break; }
  if (g0 < 0 || g1 < 0 || g1 < g0) return null;
  return { startLine: script.groups[g0].i0, endLine: script.groups[g1].i1 - 1, startN: script.groups[g0].n, endN: script.groups[g1].n,
    startLabel: script.groups[g0].label, endLabel: script.groups[g1].label, groups: g1 - g0 + 1, lines: script.groups[g1].i1 - script.groups[g0].i0 };
}
