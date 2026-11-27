// 金フレ型の構造（見出し語 → 例文 → 例文の繰り返し → 無音）を使った救済の検証。
// 区間の時刻は、実際の金フレ音声1ユニット（100項目）を無音検出した結果（時刻のみ。音声そのものは含まない）。
// 認識結果（確定した見出し語＝錨）は、欠け方を決めて作った「模擬」。区間の正解は、構造から求めた仮の正解（人が聞いて確認したものではない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractItems, confirmRef, structureRescue, parseEntryGroups, readGap, summarize, deriveState } from '../vocab-audio-core.js';

const REG = JSON.parse(fs.readFileSync(new URL('../vocab-audio-structure-fixture.json', import.meta.url)));
assert.equal(REG.length, 300);
const SRC = { store: 'vblobs', key: 'unit1', size: 6e6 }, KEY = 'vblobs:unit1';
const name = i => 'w' + [...String(i + 100)].map(c => 'abcdefghij'[+c]).join('');   // 重ならない擬似単語
const mk = (n = 100) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ id: 'h' + i, text: name(i), role: 'word', group: 'g' + i, segments: [], confirmed: false });
    rows.push({ id: 'e' + i, text: 'This is a sample sentence with ' + name(i) + ' in it.', role: 'example', group: 'g' + i, segments: [], confirmed: false });
  }
  return extractItems(rows, 'kinfure', { from: 'studio', materialId: 'S1' }).items;
};
const truth = i => ({ head: REG[3 * i], ex: REG[3 * i + 1], rep: REG[3 * i + 2] });
const anchorAt = (items, i, withExample) => {
  confirmRef(items[i], 'word', { src: SRC, start: truth(i).head[0] - .06, end: truth(i).head[1] + .14 });
  if (withExample) confirmRef(items[i], 'example', { src: SRC, start: truth(i).ex[0] - .06, end: truth(i).ex[1] + .14 });
};
const rnd = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// ---- 組の読み取り: 3組(見出し語・例文・繰り返し)として読めること。繰り返しが欠けても次の組で戻ること ----
const g = parseEntryGroups(REG);
assert.equal(g.length, 100); assert(g.every(x => x.repeat && !x.partial), '100組すべてが3区間の組');
const dropRep = REG.filter((_, k) => k !== 3 * 10 + 2);   // 10番目の繰り返しだけ欠けた
const g2 = parseEntryGroups(dropRep);
assert.equal(g2.length, 100); assert.equal(g2[10].repeat, null); assert(g2.slice(11).every(x => x.repeat), '1か所欠けても、次の組から元に戻る');

// ---- 評価: 錨（認識できた見出し語）を様々に欠いて、構造だけでギャップを埋める ----
const evalCase = (label, missing, { withExample = true, n = 100 } = {}) => {
  const items = mk(n);
  for (let i = 0; i < n; i++) if (!missing.has(i)) anchorAt(items, i, withExample);
  const res = structureRescue(items, { regions: new Map([[KEY, REG.slice(0, 3 * n)]]), mode: 'head', origin: { from: 'studio', materialId: 'S1' } });
  let headOk = 0, exOk = 0, wrong = 0, clip = 0, extra = 0, shifted = 0, tried = 0;
  for (const i of missing) {
    const w = items[i].refs.word, e = items[i].refs.example, t = truth(i);
    if (!w || !w.fromStructure) continue;
    tried++;
    const hit = (r, ref) => ref.start <= r[0] + .01 && ref.end >= r[1] - .01 && ref.start >= r[0] - .2 && ref.end <= r[1] + .35;
    if (hit(t.head, w.ref)) headOk++; else { wrong++; if (REG.slice(0, 3 * n).some((r, k) => k % 3 === 0 && k !== 3 * i && hit(r, w.ref))) shifted++; else if (w.ref.start > t.head[0] + .01 || w.ref.end < t.head[1] - .01) clip++; else extra++; }
    if (e) { if (hit(t.ex, e.ref) && e.ref.end < t.rep[0]) exOk++; else wrong++; }
  }
  return { label, missing: missing.size, tried, headOk, exOk, wrong, clip, extra, shifted, items };
};
const some = (frac, seed) => { const r = rnd(seed), s = new Set(); for (let i = 0; i < 100; i++) if (r() < frac) s.add(i); return s; };
const run = [
  evalCase('ランダムに30%欠け', some(.3, 7)),
  evalCase('ランダムに30%欠け（例文は未確定）', some(.3, 11), { withExample: false }),
  evalCase('連続10件欠け', new Set(Array.from({ length: 10 }, (_, k) => 40 + k))),
  evalCase('先頭5件と末尾の途中が欠け', new Set([0, 1, 2, 3, 4, 50])),
  evalCase('1件おきに欠け', new Set(Array.from({ length: 50 }, (_, k) => 2 * k + 1))),
];
for (const r of run) {
  assert.equal(r.wrong, 0, r.label + ': 誤った割り当てがない');
  assert.equal(r.headOk, r.tried, r.label + ': 割り当てた見出し語は、すべて正しい区間（語頭・語尾も欠けない）');
  assert.equal(r.exOk, r.tried, r.label + ': 例文は1回目だけ（繰り返しを含まない）');
}
// 先頭の未確定が「ファイルの先頭から数えて一致」するときだけ確定し、末尾の途中（開いたギャップ）は候補止まり
const [r1, r2, r3, r4, r5] = run;
assert(r1.tried >= r1.missing - 5 && r1.tried > 0, '錨にはさまれたものはほぼすべて救済: ' + r1.tried + '/' + r1.missing);
assert.equal(r5.tried, 49, '1件おきでも、錨にはさまれた49件を救済（最後の1件は開いたギャップなので候補止まり）');
assert(r5.items[99].candidates.some(c => c.source === 'structure') && !r5.items[99].refs.word, '末尾（開いたギャップ）は確定せず候補だけ');
assert.equal(r4.tried, 6, '先頭5件も、ファイルの先頭から数えて件数が合えば確定（' + r4.tried + '）');
// 繰り返しを後続の見出し語と取り違えない: 錨の次の見出し語は、1つずれていない
const check = run[2].items.slice(40, 50);
check.forEach((it, k) => assert.deepEqual(it.structure.head, truth(40 + k).head.map(x => Math.round(x * 1000) / 1000), '連続欠けでも、順序どおり（後続へのずれなし）'));

// ---- 誤った強制割り当てを避ける ----
// (a) 区間が1つ欠けた（ギャップの組数が項目数と合わない）→ 確定しない
{
  const items = mk(30); const missing = new Set([10, 11, 12]);
  for (let i = 0; i < 30; i++) if (!missing.has(i)) anchorAt(items, i, true);
  const regs = REG.slice(0, 90).filter((_, k) => k !== 3 * 11);   // 11番目の見出し語の区間が音声から消えた
  structureRescue(items, { regions: new Map([[KEY, regs]]), mode: 'head' });
  assert([10, 11, 12].every(i => !items[i].refs.word), '組数が合わない: 何も確定しない');
}
// (b) 台本に音声にない項目が1つ入っている → その項目は確定しない。ずれのないギャップは正しく救済
{
  const items = mk(31), skip = new Set([10, 11, 15]);   // 台本15番目は音声にない。音声は30組
  items.forEach((it, i) => { if (skip.has(i)) return; const a = i < 15 ? i : i - 1; confirmRef(it, 'word', { src: SRC, start: truth(a).head[0] - .06, end: truth(a).head[1] + .14 }); });
  structureRescue(items, { regions: new Map([[KEY, REG.slice(0, 90)]]), mode: 'head' });
  assert(!items[15].refs.word, '音声にない項目は、件数が合わないので確定しない');
  assert(items[10].refs.word?.fromStructure && items[11].refs.word?.fromStructure, 'ずれのないギャップは救済する');
  assert(items[10].refs.word.ref.start <= truth(10).head[0] && items[10].refs.word.ref.end >= truth(10).head[1]);
}
// (c) 繰り返しのない構造（見出し語 → 例文だけ）でも、件数が合えば順序どおりに対応づける。繰り返しは付けない
{
  const pairs = []; for (let k = 0; k < 20; k++) pairs.push([k * 5, k * 5 + .6 + (k % 3) * .1], [k * 5 + 1.5, k * 5 + 3 + (k % 4) * .17]);
  const items = mk(20);
  for (let i = 0; i < 20; i++) if (![6, 7, 8].includes(i)) confirmRef(items[i], 'word', { src: SRC, start: pairs[2 * i][0] - .06, end: pairs[2 * i][1] + .14 });
  structureRescue(items, { regions: new Map([[KEY, pairs]]), mode: 'head' });
  [6, 7, 8].forEach(i => { assert(items[i].refs.word?.fromStructure, 'pair ' + i); assert.equal(items[i].structure.repeat, false); assert(items[i].refs.word.ref.start <= pairs[2 * i][0] && items[i].refs.word.ref.end >= pairs[2 * i][1]); });
}
// (c2) 区間の数が組として読めない（余分な発話が混じる）→ 確定しない
{
  const items = mk(20), regs = REG.slice(0, 60).concat([]); regs.splice(3 * 6 + 3, 0, [REG[3 * 6 + 2][1] + .5, REG[3 * 6 + 2][1] + .7]);   // 6番目の繰り返しと7番目の見出し語のあいだに短い雑音
  for (let i = 0; i < 20; i++) if (![6, 7].includes(i)) anchorAt(items, i, true);
  structureRescue(items, { regions: new Map([[KEY, regs]]), mode: 'head' });
  assert([6, 7].every(i => !items[i].refs.word), '余分な区間が混じって組数が合わない: 確定しない');
}
// (d) 確定した項目・手で確定した項目には触れない
{
  const items = mk(10); anchorAt(items, 0, true); anchorAt(items, 3, true);
  const before = JSON.stringify(items[0].refs);
  structureRescue(items, { regions: new Map([[KEY, REG.slice(0, 30)]]), mode: 'head' });
  assert.equal(JSON.stringify(items[0].refs), before);
  assert(items[1].refs.word.fromStructure && items[2].refs.word.fromStructure);
}
// (e) 金フレ型以外・文章モードでは何もしない
{
  const items = mk(5); items.forEach(i => { i.profile = 'wordlist'; });
  assert.deepEqual(structureRescue(items, { regions: new Map([[KEY, REG]]), mode: 'head' }).filter(r => r.outcome === 'structure'), []);
  assert.deepEqual(structureRescue(mk(5), { regions: new Map([[KEY, REG]]), mode: 'sentence' }), []);
}
console.log('vocab-audio-structure:', run.map(r => `${r.label} 救済${r.tried}/${r.missing} 見出し語${r.headOk} 例文${r.exOk} 誤${r.wrong}`).join(' | '));

// ---- 例文の中に見出し語がある発話を、見出し語の音声として確定しない（Let's try anyway. の anyway） ----
{
  const { recheckItems } = await import('../vocab-audio-core.js');
  const rows = [['h0', 'before', 'word'], ['e0', 'Please do it before noon.', 'example'], ['h1', 'anyway', 'word'], ['e1', "Let's try anyway.", 'example'], ['h2', 'after', 'word'], ['e2', 'Come back after lunch.', 'example']]
    .map(([id, text, role], k) => ({ id, text, role, group: 'g' + (k >> 1), segments: [], confirmed: false }));
  const items = extractItems(rows, 'kinfure', { from: 'studio', materialId: 'S' }).items;
  const at = (it, a, b) => confirmRef(it, 'word', { src: SRC, start: a, end: b });
  at(items[0], 0, .6); at(items[2], 9, 9.5);
  const ev = [{ id: 'c1', text: "Let's try anyway.", start: 4, end: 5.4, sourceKey: KEY, store: 'vblobs', key: 'unit1', size: 6e6, wordTimings: [{ text: "Let's", start: 4, end: 4.3 }, { text: 'try', start: 4.35, end: 4.6 }, { text: 'anyway.', start: 4.7, end: 5.4 }] }];
  recheckItems(items, { evidence: ev, mode: 'head', regions: null });
  assert(!items[1].refs.word || items[1].refs.word.tier !== 'high' || !items[1].refs.word.fromRecheck, '例文の中の語を、見出し語の音声として確定しない');
}
