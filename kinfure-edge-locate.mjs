// 先頭と末尾だけの文字起こしから、全体スクリプトの中の範囲を推定する（locateByEdges）の検証。
// スクリプトは擬似データ（実教材ではない）: 見出し語は珍しい語、例文はよく出る400語から5〜8語。文字起こしの語は一部聞き間違える。
import assert from 'node:assert/strict';
import { parseKinfureScript, locateByEdges } from '../studio-kinfure-range.js';
const rnd = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const r = rnd(7);
const COMMON = Array.from({ length: 400 }, (_, i) => 'c' + (i * 7919 % 6469).toString(36) + 'e');
const HEAD = i => 'h' + (i * 104729 % 99991).toString(36) + 'x';
const N = 2000, rows = [], entry = [];
for (let i = 0; i < N; i++) {
  rows.push({ text: HEAD(i), kind: 'word' });
  const n = 1 + (i % 3 === 0 ? 1 : 0);
  for (let k = 0; k < n; k++) { const ws = [HEAD(i), ...Array.from({ length: 4 + Math.floor(r() * 4) }, () => COMMON[Math.floor(r() * COMMON.length)])]; rows.push({ text: ws.sort(() => r() - .5).join(' ') + '.', kind: 'example' }); }
}
const script = parseKinfureScript(rows);
assert.equal(script.groups.length, N);
// ある範囲 [g0, g1] の音声を読んだ想定の文字起こし: 先頭 edge 秒ぶん・末尾 edge 秒ぶん（1項目 ≈ 10秒）
const say = (g, noise) => { const out = []; for (let i = g.i0; i < g.i1; i++) { const t = script.lines[i].text.split(' ').map(w => (r() < noise ? 'zz' + Math.floor(r() * 999) : w)).join(' '); out.push(script.lines[i].kind === 'example' ? t + ' ' + t : t); } return out.join(' '); };
const cuesFor = (groups, noise) => groups.map(g => ({ text: say(g, noise) }));
const results = [];
for (const [label, noise, edgeGroups] of [['先頭・末尾 各3項目（約30秒）・誤り15%', .15, 3], ['各3項目・誤り30%', .3, 3], ['各2項目（約20秒）・誤り30%', .3, 2]]) {
  let exact = 0, near = 0, wrong = 0, low = 0; const total = 40;
  for (let t = 0; t < total; t++) {
    const a = Math.floor(r() * (N - 260)), b = a + 60 + Math.floor(r() * 150);   // 60〜210項目の音声
    const head = cuesFor(script.groups.slice(a, a + edgeGroups), noise), tail = cuesFor(script.groups.slice(b - edgeGroups + 1, b + 1), noise);
    const res = locateByEdges(script, head, tail, {});
    if (!res.ok) { low++; continue; }
    const da = Math.abs(res.startN - script.groups[a].n), db = Math.abs(res.endN - script.groups[b].n);
    if (da === 0 && db === 0) exact++; else if (da <= 1 && db <= 1) near++; else { wrong++; if (process.env.DBG) console.log('wrong', label, 'truth', a, b, 'got', res.startN - 1, res.endN - 1, res.headShare, res.tailShare); }
  }
  results.push({ label, exact, near, wrong, low });
  assert.equal(wrong, 0, label + ': 確定した範囲が大きくずれない（' + wrong + '件）');
  assert(exact + near >= total * (noise > .2 ? .75 : .9), label + ': ' + (exact + near) + '/' + total);
}
// 手がかりが無い・でたらめなときは確定しない
assert.equal(locateByEdges(script, [], [{ text: 'a' }]).ok, false);
const junk = locateByEdges(script, [{ text: 'qqq www eee rrr ttt' }], [{ text: 'yyy uuu iii ooo ppp' }]);
assert.equal(junk.ok, false);
// 長さの手がかり: 期待される行数と大きく違えば確定しない
{ const a = 100, b = 600, res = locateByEdges(script, cuesFor(script.groups.slice(a, a + 3), .1), cuesFor(script.groups.slice(b - 2, b + 1), .1), { expectedLines: 40 }); assert.equal(res.ok, false); assert(/目安/.test(res.reason)); }
console.log('kinfure-edge-locate:', results.map(x => `${x.label} 完全一致${x.exact} ±1件${x.near} 誤り${x.wrong} 未確定${x.low}`).join(' | '));
