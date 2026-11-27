// 精度評価（合成データ）。実教材ではありません。正解の時刻が分かる教材を乱数で作り、
//   ベースライン = 現行の処理（planVocabAlignment の文字列一致 + 照合済みの行をそのまま確定扱い）
//   新方式       = 同じ照合のあとに、確信度の判定 → 前後の確定音声の間での局所再照合
// を比べる。評価は「割当率」ではなく、確定とされた見出し語の音声が正しいか・欠けていないか・余分が混ざっていないか。
import assert from 'node:assert/strict';
const { planVocabAlignment } = await import('../studio-vocab-align.js');
const core = await import('../vocab-audio-core.js');
const { extractItems, gradeItems, recheckItems, refineRefs } = core;

const rng = seed => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
const WORDS = 'allocate compromise estimate dispute refund invoice negotiate approve decline deliver confirm postpone reduce increase submit receive arrange consider recommend prepare require suggest measure maintain include provide support replace release reserve schedule supply survey transfer upgrade verify warrant account balance budget capital contract customer deadline discount expense feedback finance inventory investment margin merchant objective payment penalty policy profit proposal purchase quality quota recruit revenue salary shipment strategy tariff vendor warehouse'.split(' ');
const TEMPLATES = [w => `We need to ${w} the report before the end of the week.`, w => `She decided to ${w} it after a long discussion.`, w => `Please ${w} the details with the whole team tomorrow.`, w => `They plan to ${w} everything by the middle of the month.`];
const VOWELS = /[aeiou]/g;
function mishear(word, r) {
  const t = r();
  if (t < .12) return WORDS[Math.floor(r() * WORDS.length)];                             // まったく違う語
  if (t < .45) { const i = 1 + Math.floor(r() * Math.max(1, word.length - 2)); return word.slice(0, i) + ' ' + word.slice(i); }   // a locate
  if (t < .7) return word.replace(/c/g, 'k').replace(/ph/g, 'f').replace(/s(?=[aeiou])/g, 'z');
  if (t < .9) { const m = [...word.matchAll(VOWELS)].filter(x => x.index > 0); if (!m.length) return word; const x = m[Math.floor(r() * m.length)]; return word.slice(0, x.index) + word.slice(x.index + 1); }
  return word.slice(0, -1);                                                              // 語尾が落ちる
}
const garble = (text, r, p = .12) => text.split(' ').map(w => (r() < p ? WORDS[Math.floor(r() * WORDS.length)] : w)).join(' ');

export function makeMaterial(seed, { groups = 60, pMis = .3, pMerge = .1, pMiss = .06, pLate = .12 } = {}) {
  const r = rng(seed), unit = (a, b) => a + (b - a) * r();
  const words = [...WORDS].sort(() => r() - .5).slice(0, groups);
  let t = 2;
  const truth = [], cues = [], rows = [];
  words.forEach((w, g) => {
    const dh = unit(.4, .8), head = { start: t, end: t + dh };
    t += dh + unit(.5, 1.0);
    const text = TEMPLATES[g % TEMPLATES.length](w), n = text.split(' ').length;
    const d1 = n * unit(.28, .34), ex1 = { start: t, end: t + d1 };
    t += d1 + unit(.4, .7);
    const d2 = d1 * unit(.9, 1.1), ex2 = { start: t, end: t + d2 };
    t += d2 + unit(.9, 1.5);
    truth.push({ g, w, head, ex: [ex1, ex2], text });
    rows.push({ id: 'h' + g, text: w, kind: 'word', role: 'word', group: 'g' + g }, { id: 'e' + g, text, kind: 'example', role: 'example', group: 'g' + g, rep: 2 });
  });
  const jit = (a, late) => ({ start: Math.max(0, a.start + (r() - .5) * .12 + (late && r() < pLate ? unit(.15, .3) : 0)), end: a.end + (r() - .5) * .12 });
  truth.forEach(u => {
    const asr = [];
    const headCue = jit(u.head, true);
    const heardHead = r() < pMis ? mishear(u.w, r) : u.w;
    if (r() < pMerge) asr.push({ ...jit({ start: u.head.start, end: u.ex[0].end }, false), text: `${heardHead} ${garble(u.text, r)}` });   // 見出し語と例文が1つの認識結果に
    else {
      if (r() >= pMiss) asr.push({ ...headCue, text: heardHead });
      if (r() >= pMiss) asr.push({ ...jit(u.ex[0], false), text: garble(u.text, r) });
    }
    if (r() >= pMiss) asr.push({ ...jit(u.ex[1], false), text: garble(u.text, r) });
    cues.push(...asr);
  });
  cues.sort((a, b) => a.start - b.start);
  const evidence = cues.map((c, i) => ({ id: 'c' + i, ...c, sourceId: 's', sourceKey: 'vblobs:vk', store: 'vblobs', key: 'vk', size: 1000 }));
  // 発話のまとまり（VAD相当）: 実際の発話の区間から作る。近接する発話は1つにまとまる。
  const spans = truth.flatMap(u => [u.head, ...u.ex]).sort((a, b) => a.start - b.start).map(x => [x.start - .02 + (r() - .5) * .04, x.end + .02 + (r() - .5) * .04]);
  const regions = [];
  for (const s of spans) { if (regions.length && s[0] - regions.at(-1)[1] < .25) regions.at(-1)[1] = s[1]; else regions.push([...s]); }
  return { truth, rows, evidence, regions, cues };
}

const iou = (a, b) => { const i = Math.min(a.end, b.end) - Math.max(a.start, b.start); return i <= 0 ? 0 : i / (Math.max(a.end, b.end) - Math.min(a.start, b.start)); };
const seg = (start, end) => ({ store: 'vblobs', key: 'vk', sourceKey: 'vblobs:vk', size: 1000, start, end });

// 事前に割り当て済みの行（標準の照合が先に走った状態を模す）: 一部は正しく、一部はずれた場所に確定されている。
function preassign(material, seed, { pRight = .45, pWrong = .15 } = {}) {
  const r = rng(seed * 7 + 1);
  const heads = material.truth.map(u => u.g);
  const near = g => material.evidence.filter(c => Math.abs(c.start - material.truth[g].head.start) < .4)[0];
  return new Map(heads.flatMap(g => {
    const x = r();
    if (x < pRight && near(g)) return [[g, { start: near(g).start, end: near(g).end, correct: true }]];
    if (x < pRight + pWrong) { const other = material.truth[(g + 1) % material.truth.length].head, c = material.evidence.filter(e => Math.abs(e.start - other.start) < .4)[0]; if (c) return [[g, { start: c.start, end: c.end, correct: false }]]; }
    return [];
  }));
}

export function evaluate(material, { scenario, seed, regionsOn = true, evidenceOn = true, refine = false }) {
  const pre = scenario === 'preassigned' ? preassign(material, seed) : new Map();
  const rowsIn = material.rows.map(r => ({ ...r, segments: [], aligned: false }));
  const occupied = [];
  rowsIn.forEach(r => { if (r.kind !== 'word') return; const g = +r.id.slice(1), p = pre.get(g); if (p) { r.segments = [{ sourceId: 's', start: p.start, end: p.end }]; r.aligned = true; occupied.push(r.segments[0]); } });
  // 既存の文字列一致の照合（両方式で共通の第1段階）
  const targets = rowsIn.filter(r => !r.segments.length);
  const proposals = planVocabAlignment(rowsIn.map(r => ({ ...r, segments: r.segments })), material.evidence.map(e => ({ sourceId: 's', start: e.start, end: e.end, text: e.text })), occupied);
  for (const p of proposals) {
    const row = rowsIn.find(r => r.id === p.row.id);
    if (row && !row.segments.length && !p.estimated) { row.segments = p.cues.map(c => ({ sourceId: 's', start: c.start, end: c.end })); row.aligned = true; }
  }
  const heads = rowsIn.filter(r => r.kind === 'word');
  const T = new Map(material.truth.map(u => [u.g, u]));
  const score = (g, range) => {
    const t = T.get(g).head, others = material.truth.filter(u => u.g !== g);
    const own = iou(range, t);
    const mixed = others.some(u => iou(range, u.head) > .1 || u.ex.some(e => Math.min(e.end, range.end) - Math.max(e.start, range.start) > .1));
    return { correct: own >= .5 && !mixed, wrong: own < .1 || mixed, clipped: own >= .5 && (range.start > t.start + .12 || range.end < t.end - .12), extra: own >= .5 && (range.start < t.start - .25 || range.end > t.end + .25) };
  };
  // ベースライン: 照合済みの見出し語をそのまま確定として扱う（現行の動作）
  const base = { confirmed: 0, correct: 0, wrong: 0, clipped: 0, extra: 0 };
  for (const r of heads) if (r.aligned && r.segments.length) { const s = score(+r.id.slice(1), r.segments[0]); base.confirmed++; for (const k of ['correct', 'wrong', 'clipped', 'extra']) base[k] += s[k] ? 1 : 0; }
  // 新方式
  const rows = rowsIn.map(r => ({ id: r.id, text: r.text, role: r.role, group: r.group, ja: '', confirmed: Boolean(r.aligned && r.segments.length), rep: r.rep,
    segments: r.segments.map(g => seg(g.start, g.end)) }));
  const { items } = extractItems(rows, 'kinfure', { from: 'lab', materialId: 'm' });
  const ctx = { regions: regionsOn ? new Map([['vblobs:vk', material.regions]]) : null, evidence: evidenceOn ? material.evidence : [] };
  gradeItems(items, rows, ctx);
  recheckItems(items, { evidence: ctx.evidence, regions: ctx.regions, origin: { from: 'lab', materialId: 'm' } });
  if (refine && ctx.regions) refineRefs(items, ctx.regions);
  const now = { confirmed: 0, correct: 0, wrong: 0, clipped: 0, extra: 0 };
  for (const it of items) { const ri = it.refs.word; if (!ri || ri.ref.state !== 'confirmed') continue; const s = score(+it.rows.word.slice(1), ri.ref); now.confirmed++; for (const k of ['correct', 'wrong', 'clipped', 'extra']) now[k] += s[k] ? 1 : 0; }
  return { total: heads.length, base, now, wrongPre: [...pre.values()].filter(p => !p.correct).length };
}
const add = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]]));
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '-') + '%';
const sum = (rs, key) => rs.reduce((a, r) => add(a, r[key]), { confirmed: 0, correct: 0, wrong: 0, clipped: 0, extra: 0 });
const out = {}, variants = { 'regions なし': { regionsOn: false }, 'regions あり': {}, 'regions あり＋境界の調整': { refine: true } };
for (const scenario of ['fresh', 'preassigned']) {
  const per = Object.fromEntries(Object.keys(variants).map(k => [k, []]));
  const rs = [];
  for (let seed = 1; seed <= 8; seed++) { const m = makeMaterial(seed); rs.push(evaluate(m, { scenario, seed })); for (const [k, v] of Object.entries(variants)) per[k].push(evaluate(m, { scenario, seed, ...v })); }
  const total = rs.reduce((a, r) => a + r.total, 0), b = sum(rs, 'base');
  out[scenario] = { total, b, n: sum(per['regions あり＋境界の調整'], 'now'), plain: sum(per['regions なし'], 'now') };
  const line = (name, x) => `  ${name.padEnd(16)} 確定 ${pct(x.confirmed, total).padStart(6)} / 正しい確定 ${pct(x.correct, total).padStart(6)}（確定のうち ${pct(x.correct, x.confirmed)}）/ 誤った確定 ${pct(x.wrong, total).padStart(5)} / 語頭語尾の欠け ${pct(x.clipped, x.correct)} / 余分な音声 ${pct(x.extra, x.correct)}`;
  console.log(`[合成データ・${scenario}・8教材×60語] 照合の入力: ${scenario === 'fresh' ? '割当なし' : '一部は正しく・一部はずれた場所に確定済み'}\n${line('現行', b)}\n${Object.entries(per).map(([k, v]) => line('新方式 ' + k, sum(v, 'now'))).join('\n')}`);
}
// 向きの確認（数値の目標ではなく、悪化していないこと）。実教材の精度を示すものではない。
for (const [scenario, { total, b, n, plain }] of Object.entries(out)) {
  // 確定のうち正しい割合（確定数が増えても、質が下がっていないこと）。発話の境界のデータがない場合は、文字起こしの時刻の粗さがそのまま残るため 1.5 ポイントまで許容する。
  const rate = x => x.correct / Math.max(1, x.confirmed);
  for (const [name, x, tol] of [['regionsあり', n, 0], ['regionsなし', plain, .015]]) {
    assert(x.correct >= b.correct, `${scenario}/${name}: 正しい確定が減っていない`);
    assert(x.wrong <= b.wrong, `${scenario}/${name}: 誤った確定が増えていない`);
    assert(rate(x) >= rate(b) - tol, `${scenario}/${name}: 確定のうち正しい割合が下がっていない（${(100 * rate(x)).toFixed(1)}% ≥ ${(100 * rate(b)).toFixed(1)}%）`);
  }
  assert(n.clipped <= b.clipped * (n.correct / Math.max(1, b.correct)), `${scenario}: 境界の調整で欠けが増えていない`);
}
assert(out.preassigned.n.wrong < out.preassigned.b.wrong, 'ずれて確定されていた行を、新方式は確定のまま残さない');
assert(out.fresh.n.correct > out.fresh.b.correct, '割当なしの状態から、現行より多くの見出し語を正しく特定できる');
console.log('vocab-audio-eval: ok（合成データ）');
