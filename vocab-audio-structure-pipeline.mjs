// 構造からの救済を、パイプライン全体（教材の読み込み → 発話区間 → 再照合 → 構造の救済 → 登録）で通して確認する。
// 区間の時刻は金フレ音声1ユニットの無音検出の結果（時刻のみ）。文字起こしが拾えなかった見出し語は、教材に音声の割り当てがない行として置く。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');
const REG = JSON.parse(fs.readFileSync(new URL('../vocab-audio-structure-fixture.json', import.meta.url)));

await sdb.put('sources', { id: 'src1', name: 'unit1.m4a', kind: 'audio', size: 4000, blob: new Blob([new Uint8Array(4000)]) });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const N = 24, lost = new Set([3, 4, 5, 11, 17]);   // 文字起こしが見出し語を拾えなかった項目
const nm = i => 'w' + [...String(i + 100)].map(c => 'abcdefghij'[+c]).join('');
const blocks = [];
for (let i = 0; i < N; i++) {
  const [h, e1, e2] = [REG[3 * i], REG[3 * i + 1], REG[3 * i + 2]];
  blocks.push(newBlock('K1', { id: 'h' + i, text: nm(i), kind: 'word', ...(lost.has(i) ? { script: true, segments: [] } : { segments: [seg(h[0] - .05, h[1] + .1)], aligned: true, sync: 'auto' }) }));
  // 例文: 1回目と繰り返し（2回目）は同じ行の2つの区間（金フレの照合結果の形）
  blocks.push(newBlock('K1', { id: 'e' + i, text: 'This is a sample sentence with ' + nm(i) + ' in it.', kind: 'example', segments: lost.has(i) ? [] : [seg(e1[0] - .05, e1[1] + .1), seg(e2[0] - .05, e2[1] + .1)], ...(lost.has(i) ? { script: true } : { aligned: true, sync: 'auto' }) }));
}
const set = { id: 'K1', title: '金フレ Unit 1', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab', folder: '金フレ' };
await sdb.put('sets', set); await commit(set, '作成', { blocks });

// 発話区間: フックが、指定された窓の中の区間だけを返す（実機では音声を部分的に読んで調べる）
const asked = [];
const regionsFor = async (src, a, b) => { asked.push([a, b]); return REG.slice(0, 3 * N).filter(([s, z]) => z > a && s < b).map(r => [...r]); };
let r = await P.runPipeline({ kind: 'studio', id: 'K1' }, {}, { regionsFor });
assert.equal(r.rec.profile, 'kinfure');
const byIdx = Object.fromEntries(r.items.map((it, i) => [i, it]));
for (const i of lost) {
  const it = byIdx[i], w = it.refs.word;
  assert.equal(it.state, 'confirmed', `項目${i}は構造から確定`);
  assert(w.fromStructure, '根拠は構造'); assert(w.reasons[0].includes('件数が一致'));
  assert(w.ref.start <= REG[3 * i][0] && w.ref.end >= REG[3 * i][1], '語頭・語尾が切れない');
  assert(w.ref.start >= REG[3 * i][0] - .2 && w.ref.end <= REG[3 * i][1] + .3, '別の発話を含まない');
  const e = it.refs.example.ref;
  assert(e.start <= REG[3 * i + 1][0] && e.end >= REG[3 * i + 1][1] && e.end < REG[3 * i + 2][0], '例文は1回目だけ（繰り返しを含まない）');
  assert.equal(it.refs.example.repeats, 2);
}
assert.equal(r.summary.wordConfirmed, N); assert.equal(r.summary.exampleConfirmed, N);
// 錨だった項目は変わらない
assert.equal(byIdx[0].refs.word.fromStructure, undefined);
// 発話区間の調査は、確定していない項目のあいだだけ（全体は調べない）
const asked0 = asked.reduce((s, [a, b]) => s + (b - a), 0);
assert(asked0 < REG[3 * N - 1][1], '調べた秒数 ' + asked0.toFixed(1) + ' < 全体');
// 登録: 見出し語と例文1回分が単語に入る
const reg = await P.registerRecord('studio', 'K1');
assert.equal(reg.added, N);
const w4 = (await db.all('words')).find(x => x.headword === nm(4));
assert(w4.audio.word.start <= REG[12][0] && w4.audio.example.end < REG[14][0]);
// 同じ入力で再実行 → 再処理なし
const again = await P.runPipeline({ kind: 'studio', id: 'K1' }, {}, { regionsFor });
assert.deepEqual(again.reused.sort(), ['extract', 'recheck']);
// 診断データ（JSON）: 認識文字列・時刻・発話区間・割り当て先・確信度・構造からの救済が入り、音声は入らない
const diag = await P.buildDiagnostics('studio', 'K1');
assert.equal(diag.format, 'englabo-vocab-audio-diagnostics'); assert.equal(diag.profile, 'kinfure');
assert.equal(diag.items.length, N); assert(Object.values(diag.regions)[0].length > 0);
const d4 = diag.items[4]; assert.equal(d4.word.fromStructure, true); assert.equal(d4.structure.repeat, true); assert.equal(d4.exampleRef.repeats, 2);
assert(diag.structure.filter(x => x.outcome === 'structure').length === lost.size);
assert(!JSON.stringify(diag).includes('blob'), '音声は含まない'); JSON.parse(JSON.stringify(diag));
console.log('vocab-audio-structure-pipeline: ' + lost.size + ' lost heads recovered from silence structure, registered with first example repeat only');
