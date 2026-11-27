// 金フレ型の構造割り当て（発話区間の構造 + 粗い文字起こし）の検証。
// 区間の長さの分布は、実際の金フレ音声1ユニット（100項目）の無音検出の結果（時刻のみ。音声は含まない）。見出し語1つに例文が1〜3つ付く構造も作って試す。
// 文字起こしは模擬: 実際の診断データと同じく、時刻は1秒刻みで幅が広く（見出し語と例文が1行に混ざる）、見出し語は聞き間違いが多く、行が欠けることもある。
// 正解は構造から求めた仮のもの（聞いて確認したものではない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { alignByStructure, parseUnits } = await import('../kinfure-structure-align.js');
const REG = JSON.parse(fs.readFileSync(new URL('../vocab-audio-structure-fixture.txt', import.meta.url)));
const SY = ['ka', 'mo', 'ti', 'ru', 'se', 'po', 'la', 'ni'];
const nm = i => [...(i + 512).toString(8)].map(c => SY[+c]).join('');   // 母音を落とした音の骨格が項目ごとに異なる擬似単語
const rnd = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const grid = t => Math.round(t) + .14;

// 台本と音声を作る。nEx(e) = 項目 e の例文の数。音声の長さは実音声の分布から（見出し語 = 実際の見出し語の長さ、例文 = 実際の例文の長さ）
function make(nEntries, nEx, seed = 1) {
  const r = rnd(seed), script = [], audio = [], regions = [];
  let t = 0.6;
  for (let e = 0; e < nEntries; e++) {
    const hd = REG[3 * (e % 100)], hdur = hd[1] - hd[0];
    script.push({ text: nm(e), kind: 'head', entry: e }); audio.push({ row: script.length - 1, reads: 1, start: t, end: t + hdur }); regions.push([t, t + hdur]); t += hdur + 1 + r() * .5;
    for (let k = 0; k < nEx(e); k++) {
      const ex = REG[3 * ((e + k * 7) % 100) + 1], edur = ex[1] - ex[0];
      script.push({ text: `Please ${nm(e)} the ${nm(e + 700 + k)} report today.`, kind: 'example', entry: e }); audio.push({ row: script.length - 1, reads: 2, start: t, end: t + edur });
      regions.push([t, t + edur]); t += edur + 1.2; regions.push([t, t + edur]); t += edur + 1 + r() * .5;
    }
  }
  return { script, audio, regions };
}
// 模擬の文字起こし: 発話を順に並べ、約4〜5秒ごとの窓に詰めて1行にする。窓の時刻は1秒刻みに丸める。
const mkHints = (data, { headMiss = .4, dropRate = .15, exNoise = 0, seed = 5 } = {}) => {
  const r = rnd(seed), rows = []; let cur = null;
  const flush = () => { if (cur && r() >= dropRate) rows.push({ text: cur.text.trim(), start: grid(cur.start - .3), end: grid(cur.end + .3) }); cur = null; };
  for (const a of data.audio) {
    const row = data.script[a.row]; let text = row.text;
    if (row.kind === 'head' && r() < headMiss) text = 'garbled' + a.row;
    if (exNoise) text = text.split(' ').map(w => (r() < exNoise ? 'xq' + Math.floor(r() * 1e4) : w)).join(' ');
    const said = Array(a.reads).fill(text).join(' ');
    if (cur && a.end - cur.start > 4.5) flush();
    cur = cur ? { text: cur.text + ' ' + said, start: cur.start, end: a.end } : { text: said, start: a.start, end: a.end };
  }
  flush(); return rows;
};
// 台本を offset 行ずらして（前後に余計な行がある）評価する。正解 = 音声の発話 k が台本の行 a.row（+offset）
const evaluate = (res, data, offset) => {
  const truthOf = new Map(); let u = 0;
  for (const a of data.audio) truthOf.set(u++, a);
  let ok = 0, wrong = 0, clip = 0, repOk = 0;
  for (const p of res.pairs) {
    const a = truthOf.get(p.unit);
    if (!a || p.row !== a.row + offset) { wrong++; continue; }
    const seg = p.segments[0];
    if (seg.start <= a.start && seg.end >= a.end && seg.end - a.end < .35 && a.start - seg.start < .12) ok++; else clip++;
    if (p.segments.length === a.reads) repOk++;
  }
  return { pairs: res.pairs.length, ok, wrong, clip, repOk, supported: res.supported, inferred: res.inferred };
};
const out = [];
const cases = [
  ['例文1つ・標準', (e) => 1, {}],
  ['例文1〜3つ・標準', (e) => 1 + (e * 7) % 3, {}],
  ['例文1〜3つ・見出し語の聞き間違い70%', (e) => 1 + (e * 7) % 3, { headMiss: .7 }],
  ['例文1〜3つ・行の欠け35%', (e) => 1 + (e * 7) % 3, { dropRate: .35, seed: 9 }],
  ['例文1〜3つ・例文の語も30%聞き間違い', (e) => 1 + (e * 7) % 3, { exNoise: .3, headMiss: .5, seed: 11 }],
];
for (const [label, nEx, opts] of cases) {
  const data = make(60, nEx);
  // 台本の前に25行、後ろに30行の余計な行がある（音声は台本の途中だけ）
  const pre = Array.from({ length: 25 }, (_, i) => ({ text: i % 3 ? `Extra ${nm(900 + i)} sentence here today.` : nm(900 + i), kind: i % 3 ? 'example' : 'head' }));
  const post = Array.from({ length: 30 }, (_, i) => ({ text: i % 3 ? `After ${nm(950 + i)} sentence there today.` : nm(950 + i), kind: i % 3 ? 'example' : 'head' }));
  const rows = [...pre, ...data.script, ...post];
  const res = alignByStructure(rows, data.regions, mkHints(data, opts));
  assert(res.ok, label + ' ' + res.why);
  const c = evaluate(res, data, 25); out.push({ label, ...c });
  if (c.wrong && process.env.DBG) { const tm = new Map(); let uu = 0; for (const a of data.audio) tm.set(uu++, a); console.log(label, res.pairs.filter(p => p.row !== tm.get(p.unit).row + 25).map(p => [p.unit, p.row - 25, tm.get(p.unit).row, p.kind, p.sim].join(':')).join(' ')); }
  // 例文の語を30%聞き間違えた模擬では、同じ見出し語の例文どうしを取り違えることがある（区別する語が聞き間違えられた場合）。それ以外は誤り0
  assert(c.wrong <= (opts.exNoise ? Math.ceil(c.pairs * .03) : 0), label + ': 別の行への割り当て ' + c.wrong);
  assert.equal(c.clip, 0, label + ': 語頭・語尾が欠けない');
  assert(c.repOk >= c.pairs - c.wrong, label + ': 例文の繰り返しの回数を保つ');
  assert(c.pairs >= data.audio.length * (opts.dropRate || opts.exNoise ? .45 : .75), label + ': ' + c.pairs + '/' + data.audio.length);
}
// 例文だけを文字起こしした場合（見出し語・繰り返しは文字起こししない。時刻は発話区間そのもの、語は一部聞き間違い）: 見出し語も順序から補われる
for (const [label, noise] of [['例文だけ文字起こし（語の誤り15%）', .15], ['例文だけ文字起こし（語の誤り30%）', .3]]) {
  const data = make(60, e => 1 + (e * 7) % 3), r = rnd(21);
  const hints = data.audio.filter(a => a.reads === 2).map(a => ({ text: data.script[a.row].text.split(' ').map(w => (r() < noise ? 'xq' + Math.floor(r() * 1e4) : w)).join(' '), start: a.start, end: a.end }));
  const pre = Array.from({ length: 10 }, (_, i) => ({ text: i % 3 ? `Extra ${nm(900 + i)} sentence here today.` : nm(900 + i), kind: i % 3 ? 'example' : 'head' }));
  const res = alignByStructure([...pre, ...data.script], data.regions, hints);
  assert(res.ok, label + ' ' + res.why);
  const c = evaluate(res, data, 10); out.push({ label, ...c });
  const heads = res.pairs.filter(p => data.script[p.row - 10]?.kind === 'head').length;
  assert(c.wrong <= Math.ceil(c.pairs * .03), label + ': 誤り ' + c.wrong);
  assert.equal(c.clip, 0, label + ': 語頭・語尾が欠けない');
  assert(c.pairs >= data.audio.length * (noise > .2 ? .55 : .8), label + ': ' + c.pairs + '/' + data.audio.length);
  assert(heads >= (noise > .2 ? 5 : 25), label + ': 見出し語も順序から補われる ' + heads);
}
// 台本が音声と同じ範囲
{ const data = make(40, e => 1 + e % 2), res = alignByStructure(data.script, data.regions, mkHints(data)); const c = evaluate(res, data, 0); out.push({ label: '同じ範囲', ...c }); assert.equal(c.wrong, 0); assert(c.pairs >= 60); }
// 台本にない発話が音声の途中に入っている（台本の1行が音声にない）→ 後続がずれない
{
  const data = make(40, e => 2), skip = 31;
  const rows = data.script.filter((_, i) => i !== skip), hints = mkHints(data);
  const res = alignByStructure(rows, data.regions, hints);
  assert(res.ok);
  for (const p of res.pairs) { const a = [...data.audio][p.unit]; const expected = a.row < skip ? a.row : a.row - 1; assert(a.row !== skip, '音声にだけある発話を台本に割り当てた'); assert.equal(p.row, expected, '台本の欠けがあっても後続がずれない'); }
}
// 手がかりなし／でたらめ／繰り返しのない音声 → 何も確定しない
{
  const data = make(40, e => 1);
  assert.equal(alignByStructure(data.script, data.regions, []).ok, false);
  const junk = mkHints(data).map((h, i) => ({ ...h, text: `zzq${i} yyx${i} wwv${i} uut${i}` }));
  const res = alignByStructure(data.script, data.regions, junk); assert.equal(res.ok, false); assert.equal(res.pairs.length, 0);
  const single = data.regions.filter((_, i) => i % 3 !== 2 && !(i % 3 === 1 && false));   // 繰り返しの片方を除く = 繰り返しのない構造
  const noRep = make(40, e => 1).audio.map(a => [a.start, a.end]);
  assert.equal(alignByStructure(data.script, noRep, mkHints(data)).ok, false, '例文が繰り返されない音声には使わない');
}
// 繰り返しの検出: 実音声の長さの分布で、見出し語と例文を取り違えない
{ const u = parseUnits(REG); assert.equal(u.length, 200, '100項目 → 見出し語100 + 例文(繰り返しまとめ)100'); assert.equal(u.filter(x => x.reads.length === 2).length, 100); }
console.log('kinfure-structure-align:', out.map(r => `${r.label} 割当${r.pairs} 正${r.ok} 誤${r.wrong}(確実${r.supported}/補完${r.inferred})`).join(' | '));
