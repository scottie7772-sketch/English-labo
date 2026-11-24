import assert from 'node:assert/strict';
import { parseKinfureScript, locateRange, locateAll, coverageReport, tagRowsToScript, nameHint, rangeFromNumbers, kfKey } from '../studio-kinfure-range.js';
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const syl = ['ba','ko','ri','mel','tan','sur','vo','fen','dil','ark','pon','lu','mir','ted','gra','wen'];
const word = () => { let w = ''; const n = 2 + Math.floor(rnd() * 2); for (let i = 0; i < n; i++) w += syl[Math.floor(rnd() * syl.length)]; return w; };
const common = ['the','we','you','to','a','is','it'];
// 金フレ型: 番号 + 見出し語(1〜2語) + 例文2〜3(繰り返しあり)
const N = 2000, rows = [];
const heads = [];
for (let n = 1; n <= N; n++) {
  // 見出し語は意図的に重複させる（同じ見出し語が別の番号にも出る）
  const h = n % 7 === 0 && n > 7 ? heads[n - 8] : word() + (rnd() < .4 ? ' ' + word() : '');
  heads.push(h);
  rows.push({ text: `${n}. ${h}`, ja: '訳' + n });
  const ex = 2 + Math.floor(rnd() * 2);
  for (let e = 0; e < ex; e++) rows.push({ text: [common[Math.floor(rnd()*7)], h.split(' ')[0], ...Array.from({length: 4 + Math.floor(rnd()*4)}, word)].join(' ') + '.', ja: '例' + n, rep: e === 0 && rnd() < .3 ? 2 : 0 });
}
const script = parseKinfureScript(rows);
assert.equal(script.numbered, true);
assert.equal(script.groups.length, N);
assert.equal(script.groups[119].n, 120);
assert.equal(script.groups[119].label, heads[119]);
assert(script.lines.every((l) => !/^\d+\./.test(l.text)), '番号は本文から外れる');
// 音声の文字起こしを作る: 番号 a〜b の語を順に読み、例文は聞き間違いを混ぜ、末尾の一部は取りこぼす
const noisy = (t, p) => t.split(' ').map((w) => rnd() < p ? w.slice(0, -1) + 'x' : w).join(' ');
const cuesFor = (a, b, { drop = .1, err = .15, skipTail = 0 } = {}) => {
  const out = []; let t = 1;
  for (let gi = a - 1; gi < b - skipTail; gi++) {
    const g = script.groups[gi];
    for (let i = g.i0; i < g.i1; i++) {
      const l = script.lines[i], reps = l.rep || 1;
      for (let r = 0; r < reps; r++) { if (rnd() < drop) { t += 2; continue; } out.push({ text: l.kind === 'word' ? l.text : noisy(l.text, err), start: t, end: t + 2 }); t += 2.5; }
    }
  }
  return out;
};
// 1. 通常: 範囲が正しく、確信度が高い
{
  const r = locateRange(script, cuesFor(1201, 1250));
  assert(r.ok, JSON.stringify(r)); assert.equal(r.level, 'high');
  assert(Math.abs(r.startN - 1201) <= 1 && Math.abs(r.endN - 1250) <= 1, `${r.startN}-${r.endN}`);
  assert(r.strong >= 10 && r.thirds === 3);
}
// 2. 重複した見出し語（番号7の倍数）だけでは範囲を確定しない
{
  const only = []; let t = 1;
  for (const n of [14, 21, 28]) only.push({ text: heads[n - 1], start: t, end: t += 1.5 });
  const r = locateRange(script, only);
  assert.equal(r.ok, false, '見出し語だけでは確定しない'); assert(['low','none'].includes(r.level));
}
// 3. 1つの文だけ一致しても確定しない
{
  const one = [{ text: script.lines[900].text, start: 0, end: 3 }, { text: 'completely unrelated words here today', start: 4, end: 6 }];
  assert.equal(locateRange(script, one).ok, false);
}
// 4. 範囲外のノイズ（別の場所の例文が1つ混ざる）に引っ張られない
{
  const c = cuesFor(500, 540); c.splice(10, 0, { text: script.lines[6000].text, start: 30, end: 32 });
  const r = locateRange(script, c);
  assert(r.ok && Math.abs(r.startN - 500) <= 1 && Math.abs(r.endN - 540) <= 1, `${r.startN}-${r.endN}`);
}
// 5. 末尾を取りこぼしても開始は正しく、終了は取りこぼし分だけ手前
{
  const r = locateRange(script, cuesFor(100, 150, { skipTail: 5 }));
  assert(r.ok && Math.abs(r.startN - 100) <= 1 && r.endN >= 143 && r.endN <= 146, `${r.startN}-${r.endN}`);
}
// 6. 反復（×2）で同じ行が連続しても順序は壊れない
{
  const r = locateRange(script, cuesFor(300, 330, { drop: 0 }));
  assert(r.ok && r.startN === 300 && r.endN === 330);
}
// 7. フォルダ: 4本（うち2本は意図的に重なる、1か所欠落）
{
  const items = [
    { id: 'a', name: '金フレ_0001-0050.mp3', cues: cuesFor(1, 50) },
    { id: 'b', name: 'b.mp3', cues: cuesFor(51, 100) },
    { id: 'c', name: 'c.mp3', cues: cuesFor(120, 170) },        // 101〜119が欠落
    { id: 'd', name: 'd.mp3', cues: cuesFor(160, 200) },        // 160〜170が意図的に重複
  ];
  const t0 = performance.now();
  const rep = locateAll(script, items);
  const ms = performance.now() - t0;
  assert.equal(rep.results.length, 4); assert(rep.results.every((x) => x.ok));
  assert(rep.overlaps.some((o) => o.a === 'c' && o.b === 'd'), JSON.stringify(rep.overlaps));
  assert(rep.gaps.length === 1 && rep.gaps[0].fromN >= 99 && rep.gaps[0].toN <= 121, JSON.stringify(rep.gaps));
  assert(ms < 3000, `4本の特定 ${ms | 0}ms`);
  // 手動で範囲を直したあとの報告（重複を強制修正しない）
  const rr = coverageReport(script, rep.results, { d: { startLine: script.lines.findIndex((l) => l.n === 150), endLine: script.lines.findLastIndex((l) => l.n === 200) } });
  assert(rr.overlaps.length >= 1);
}
// 8. 全体スクリプトの行を教材内の行に対応づける（同じ文が複数あっても順序で）
{
  const sub = script.lines.slice(300, 330).map((l) => ({ text: l.text }));
  const idx = tagRowsToScript(sub, script);
  assert.deepEqual(idx, Array.from({ length: 30 }, (_, k) => 300 + k));
  assert.deepEqual(tagRowsToScript([{ text: 'zzz nothing' }], script), [null]);
}
// 9. 番号の書き方いろいろ・番号なし
{
  const a = parseKinfureScript([{ text: 'No.12 put off' }, { text: 'We put off the meeting.' }, { text: '13' }, { text: 'put on' }, { text: 'Put on your coat.' }, { text: '14　get up' }]);
  assert.deepEqual(a.groups.map((g) => g.n), [12, 13, 14]);
  assert.equal(a.lines[0].text, 'put off');
  const b = parseKinfureScript([{ text: 'put off' }, { text: 'We put off the meeting.' }, { text: 'put on' }, { text: 'Put on your coat.' }]);
  assert.equal(b.numbered, false); assert.deepEqual(b.groups.map((g) => g.n), [1, 2]);
  const c = parseKinfureScript([{ text: 'put off' }, { text: '3 people came to the party.' }]);   // 例文の先頭の数字は番号にしない
  assert.equal(c.lines[1].text, '3 people came to the party.');
}
{
  const j = parseKinfureScript([{ text: '1. put off' }, { text: '延期する' }, { text: 'We put off the meeting.' }, { text: '私たちは会議を延期した。' }, { text: '2. put on' }, { text: '着る' }]);
  assert.equal(j.groups.length, 2); assert.equal(j.lines.length, 3);
  assert.equal(j.lines[0].ja, '延期する'); assert.equal(j.lines[1].ja, '私たちは会議を延期した。');
}
assert.deepEqual(nameHint('金フレ_0101-0150.mp3'), { a: 101, b: 150 }); assert.equal(nameHint('001_CD1_001.mp3'), null);
const rg = rangeFromNumbers(script, 100, 120); assert(rg.startN === 100 && rg.endN === 120 && rg.groups === 21);
console.log('kinfure range passed: 範囲特定(高確信)・見出し語だけ/単発一致は確定しない・外れ値耐性・取りこぼし・反復・フォルダ4本の重複/欠落・行の対応づけ・番号の書き方');
