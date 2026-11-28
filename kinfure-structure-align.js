// 金フレ型の音声を、発話区間の構造で台本に割り当てる。純関数（画面・DB・音声には触れない）。
// 音声は「見出し語（1回）→ 例文（2回、同じ録音の繰り返し）→ （別の例文が続くことも）→ 無音」。台本は1行ずつ、見出し語または例文。
// 文字起こしの時刻は1秒前後の幅があり、見出し語（0.5秒ほど）の境界には使えない。そこで境界は発話区間そのものから取り、
// 文字起こしは「この発話はどの行か」を決める位置合わせの手がかりにだけ使う（時刻は粗くてよい）。
//   rows    : 台本の行を順に [{ text, kind: 'head' | 'example' }]
//   regions : 音声全体の発話区間 [[開始,終了],…]（時刻順）
//   hints   : 文字起こし [{ text, start, end }]（粗い時刻でよい。空でもよい）
// 行の並びと発話の並びを、順序を保つDP（挿入・欠落あり）で対応づける。手がかりが弱いときは何も確定しない。
import { joinShortGaps, padRange, phoneticSim } from './vocab-audio-core.js';
import { words } from './studio-align.js';

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'it', 'that', 'this', 'with', 'by', 'as', 'from', 'we', 'you', 'i', 'he', 'she', 'they', 'my', 'your', 'our', 'his', 'her', 'their', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'not', 'what', 'where', 'who', 'how']);
const stem = w => w.length > 3 ? w.replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '') : w;
const toks = text => words(text).map(w => stem(w.w.toLowerCase())).filter(Boolean);
const content = text => { const all = toks(text), c = all.filter(t => !STOP.has(t)); return c.length ? c : all; };
// 聞き間違いは、母音を落とした音の骨格が同じ語だけ同じ語とみなす（allocate / a locate）。似ているだけの語は同じにしない
const has = (bag, t) => bag.has(t) || (t.length >= 4 && [...bag].some(b => b.length >= 4 && phoneticSim(b, t) === 1));
const recall = (need, bag) => need.length ? need.filter(t => has(bag, t)).length / need.length : 0;

// 例文の繰り返しは同じ録音で、長さが数%以内で一致する（実音声: 差の最大 2.2%、許容 5%）。見出し語と例文・次の発話との差は 20% 以上。繰り返しは2回まで読む。
// 長い発話（1.5秒以上）は、発話区間の検出の誤差（末尾の小さい音）が長さの1割近くになることがあるので、許容を広げる。
const similarDur = (a, b, tol) => { const m = Math.max(a[1] - a[0], b[1] - b[0]); return Math.abs((a[1] - a[0]) - (b[1] - b[0])) <= (m >= 1.5 ? Math.max(tol, .12) : tol) * m; };
// 発話区間 → 発話（繰り返しは1つにまとめる）。units[k] = { span: 1回目, reads: [1回目, 2回目, …] }
export function parseUnits(regions, { tol = .05, maxReads = 2 } = {}) {
  const units = [];
  for (let i = 0; i < regions.length;) {
    const reads = [regions[i]];
    while (reads.length < maxReads && i + reads.length < regions.length && similarDur(reads[0], regions[i + reads.length], tol) && regions[i + reads.length][0] - reads.at(-1)[1] < 6) reads.push(regions[i + reads.length]);
    units.push({ span: reads[0], reads });
    i += reads.length;
  }
  return units;
}
// 発話 u の近くにある文字起こしの語。粗い時刻でも、自分の発話とは大きく重なり、隣の発話（1秒以上の無音）とはほとんど重ならない。
// 重なりが「文字起こしの行か発話の短いほう」の半分以上のものだけを使う（隣の文字を拾って別の行に割り当てないため）。
function bagFor(unit, hints, slack) {
  const a = unit.span[0] - slack, z = unit.reads.at(-1)[1] + slack, bag = new Set();
  for (const h of hints) {
    const overlap = Math.min(h.end, z) - Math.max(h.start, a);
    if (overlap > .25 && overlap >= .5 * Math.min(z - a, h.end - h.start)) for (const t of toks(h.text)) bag.add(t);
  }
  return bag;
}
export const similarityOf = (text, bag) => recall(content(text), bag);

// 見出し語は1回、例文は繰り返し（2回以上）という構造に合うかの、小さな加点・減点
const prior = (row, unit) => (row.kind === 'head') === (unit.reads.length === 1) ? .3 : (row.kind === 'head' ? -.8 : -.3);

export function alignByStructure(rows, regions, hints = [], { slack = .15, minSupport = .45, gap = .6, minSupported = 3, minShare = .25, tol = .05 } = {}) {
  const units = parseUnits(joinShortGaps(regions || []), { tol });
  const M = rows.length, K = units.length, out = { ok: false, why: '', units: K, rows: M, pairs: [], supported: 0, inferred: 0, repeated: units.filter(u => u.reads.length > 1).length };
  if (!M || K < 3) { out.why = 'no-structure'; return out; }
  if (out.repeated < Math.max(2, Math.floor(K * .2))) { out.why = 'no-repeat-structure'; return out; }   // 例文が繰り返される構造がない音声には使わない
  if (!hints.length) { out.why = 'no-hints'; return out; }
  const bags = units.map(u => bagFor(u, hints, slack));
  const S = Array.from({ length: M }, (_, i) => bags.map(b => similarityOf(rows[i].text, b)));
  const m = (i, j) => { const s = S[i][j]; return (s >= .3 ? 3 * s - .5 : -1) + prior(rows[i], units[j]); };
  const dp = Array.from({ length: M + 1 }, () => new Float64Array(K + 1)), how = Array.from({ length: M + 1 }, () => new Int8Array(K + 1));
  for (let j = 1; j <= K; j++) { dp[0][j] = dp[0][j - 1] - gap; how[0][j] = 3; }
  for (let i = 1; i <= M; i++) {
    dp[i][0] = 0; how[i][0] = 2;                                   // 先頭の台本の余りは無料
    for (let j = 1; j <= K; j++) {
      let best = dp[i - 1][j - 1] + m(i - 1, j - 1), h = 1;
      const skipRow = dp[i - 1][j] - gap, skipUnit = dp[i][j - 1] - gap;
      if (skipRow > best) { best = skipRow; h = 2; }
      if (skipUnit > best) { best = skipUnit; h = 3; }
      dp[i][j] = best; how[i][j] = h;
    }
  }
  let bi = 0; for (let i = 0; i <= M; i++) if (dp[i][K] > dp[bi][K]) bi = i;   // 末尾の台本の余りは無料
  const pairs = [];
  for (let i = bi, j = K; j > 0 && i > 0;) {
    const h = how[i][j];
    if (h === 1) { pairs.push({ row: i - 1, unit: j - 1, sim: S[i - 1][j - 1] }); i--; j--; } else if (h === 2) i--; else j--;
  }
  pairs.reverse();
  // 手がかりがあっても、隣り合う行（同じ見出し語の例文どうし）や隣り合う発話と区別できないもの（一致度の差が小さい）は「確実」にしない
  // （文字起こしの1行は複数の発話にまたがるので、隣の発話との比較はしない。同じ発話に対する、隣り合う行との比較だけを見る。構造の加点・減点を含めて比べる）
  const margin = p => {
    let rival = -Infinity;
    for (let d = -2; d <= 2; d++) if (d && S[p.row + d]?.[p.unit] != null) rival = Math.max(rival, S[p.row + d][p.unit] + prior(rows[p.row + d], units[p.unit]));
    return Number.isFinite(rival) ? p.sim + prior(rows[p.row], units[p.unit]) - rival : 1;
  };
  pairs.forEach(p => { p.kind = p.sim >= minSupport && margin(p) >= .12 ? 'supported' : 'weak'; });
  // 手がかりの薄い組は、前後の組がどちらも「手がかりあり」で隣り合っている（行も発話も連続）ときだけ、順序から補う
  pairs.forEach((p, k) => {
    if (p.kind !== 'weak') return;
    const a = pairs[k - 1], b = pairs[k + 1];
    if (a && b && a.kind === 'supported' && b.kind === 'supported' && a.row + 1 === p.row && p.row + 1 === b.row && a.unit + 1 === p.unit && p.unit + 1 === b.unit) p.kind = 'inferred';
  });
  out.supported = pairs.filter(p => p.kind === 'supported').length; out.inferred = pairs.filter(p => p.kind === 'inferred').length;
  if (out.supported < Math.max(minSupported, Math.floor(minShare * Math.min(M, K)))) { out.why = 'weak-evidence'; return out; }
  out.pairs = pairs.filter(p => p.kind !== 'weak').map(p => {
    const u = units[p.unit], prev = units[p.unit - 1], next = units[p.unit + 1];
    const before = prev ? prev.reads.at(-1)[1] : null, after = next ? next.span[0] : null;
    const segs = u.reads.map((r, k) => padRange(r, k ? u.reads[k - 1][1] : before, k + 1 < u.reads.length ? u.reads[k + 1][0] : after));
    return { row: p.row, unit: p.unit, kind: p.kind, sim: +p.sim.toFixed(3), segments: segs };
  });
  out.unitList = units.map(u => ({ span: u.span, reads: u.reads }));
  out.ok = true;
  return out;
}

// 音声にはあるのに台本の行に割り当てられなかった発話（台本に行が足りない所）を探す。
// 割り当てた2つの行のあいだにある未割当の発話を、次の順で説明する。
//   1) その間に未割当の台本行があり、数と種類（見出し語＝1回、例文＝繰り返し）が合う → 順序どおりに割り当てる（'rows'）
//   2) 台本の行がなく、全体スクリプトの上で前後の行のあいだにある行の数と種類が合う → その行を追加する（'script'）
//   3) 説明できない → 発話の時刻だけを知らせる（'unknown'）
// rows: 台本の行 [{ text, kind, scriptIndex? }]（scriptIndex = 全体スクリプト上の行番号。分からなければ省略）
// pairs / unitList: alignByStructure の結果（pairs は割り当て済み）。script: 全体スクリプトの行 [{ text, kind }]（任意）
export function planMissing(rows, pairs, unitList, script = null) {
  const sorted = [...pairs].sort((a, b) => a.unit - b.unit), paired = new Set(sorted.map(p => p.unit)), out = [];
  const compat = (kind, unit) => (kind === 'head') === (unit.reads.length === 1);
  const unitsBetween = (a, z) => { const list = []; for (let k = a + 1; k < z; k++) if (!paired.has(k)) list.push(k); return list; };
  for (let k = 0; k + 1 < sorted.length; k++) {
    const A = sorted[k], B = sorted[k + 1], us = unitsBetween(A.unit, B.unit);
    if (!us.length) continue;
    const between = []; for (let r = A.row + 1; r < B.row; r++) between.push(r);
    const segs = u => { const x = unitList[u]; return x.reads.map(r => ({ start: r[0], end: r[1] })); };
    const ok = (kinds) => kinds.length === us.length && kinds.every((kd, i) => compat(kd, unitList[us[i]]));
    const ia = rows[A.row]?.scriptIndex, ib = rows[B.row]?.scriptIndex;
    const lines = script && ia != null && ib != null && ib > ia ? script.slice(ia + 1, ib) : null;
    if (lines && ok(lines.map(l => l.kind))) {
      // 全体スクリプトの上で前後の行のあいだにある行の数・種類が、未割当の発話と合う: 順序どおりに対応づける。教材に行があればそれを、無ければ行を追加する。
      const rowAt = new Map(between.map(r => [rows[r].scriptIndex, r]));
      const items = us.map((u, i) => { const r = rowAt.get(ia + 1 + i); return r != null ? { row: r, unit: u, segments: segs(u) } : { text: lines[i].text, kind: lines[i].kind, unit: u, segments: segs(u) }; });
      out.push({ type: items.some(x => x.text != null) ? 'script' : 'rows', after: A.row, items });
    } else if (between.length === us.length && ok(between.map(r => rows[r].kind))) {
      out.push({ type: 'rows', after: A.row, items: us.map((u, i) => ({ row: between[i], unit: u, segments: segs(u) })) });
    } else out.push({ type: 'unknown', after: A.row, items: us.map(u => ({ unit: u, segments: segs(u) })), why: lines ? `全体スクリプトの上では${lines.length}行（発話は${us.length}件）で、数か種類が合いません` : `台本の行（${between.length}）と発話（${us.length}）が合いません` });
  }
  // 先頭・末尾（最初の割り当ての前・最後の割り当ての後）の未割当の発話: 最初の見出し語などが、台本に無いことがある。
  // 数は4件まで。教材に未割当の行があればそれを、無ければ全体スクリプトの上で最初（最後）の行のすぐ前（後）の行を、数と種類が合うときだけ補う。
  if (sorted.length) {
    const first = sorted[0], last = sorted.at(-1), LIMIT = 4;
    const segsOf = u => unitList[u].reads.map(r => ({ start: r[0], end: r[1] }));
    const edge = (us, side) => {
      if (!us.length || us.length > LIMIT) { if (us.length) out.push({ type: 'unknown', after: side === 'after' ? last.row : -1, items: us.map(u => ({ unit: u, segments: segsOf(u) })), why: `${side === 'after' ? '末尾' : '先頭'}の未割当の発話が${us.length}件あります` }); return; }
      const anchor = side === 'before' ? first : last, kindsOk = kinds => kinds.length === us.length && kinds.every((kd, i) => compat(kd, unitList[us[i]]));
      const rowIdx = side === 'before' ? Array.from({ length: us.length }, (_, i) => anchor.row - us.length + i) : Array.from({ length: us.length }, (_, i) => anchor.row + 1 + i);
      if (rowIdx.every(r => r >= 0 && r < rows.length) && kindsOk(rowIdx.map(r => rows[r].kind))) { out.push({ type: 'rows', after: side === 'before' ? -1 : anchor.row, items: us.map((u, i) => ({ row: rowIdx[i], unit: u, segments: segsOf(u) })) }); return; }
      const ia = rows[anchor.row]?.scriptIndex;
      if (script && ia != null) {
        const lines = side === 'before' ? script.slice(Math.max(0, ia - us.length), ia) : script.slice(ia + 1, ia + 1 + us.length);
        if (kindsOk(lines.map(l => l.kind))) { out.push({ type: 'script', ...(side === 'before' ? { before: anchor.row } : { after: anchor.row }), items: us.map((u, i) => ({ text: lines[i].text, kind: lines[i].kind, unit: u, segments: segsOf(u) })) }); return; }
      }
      out.push({ type: 'unknown', after: side === 'after' ? last.row : -1, items: us.map(u => ({ unit: u, segments: segsOf(u) })), why: `${side === 'after' ? '末尾' : '先頭'}の未割当の発話${us.length}件に合う行が、台本・全体スクリプトに見つかりません` });
    };
    edge(Array.from({ length: first.unit }, (_, k) => k).filter(k => !paired.has(k)), 'before');
    edge(Array.from({ length: unitList.length - last.unit - 1 }, (_, k) => last.unit + 1 + k).filter(k => !paired.has(k)), 'after');
  }
  return out;
}
