// 発話区間の構造から割り当てた行は、粗い文字起こしが見出し語を聞き間違えていても「候補あり」に落ちない。
// 従来の照合（structure-assign でない行）は、文字起こしと食い違えば確信度を下げる（変わらない）。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');

await sdb.put('sources', { id: 'src1', name: 'unit.m4a', kind: 'audio', size: 5000, blob: new Blob([new Uint8Array(5000)]) });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const mk = (setId, op) => {
  const lineage = { op, from: [], at: 1 };
  const B = (id, text, segments, extra = {}) => newBlock(setId, { id: setId + id, text, segments, aligned: true, sync: 'auto', lineage, ...extra });
  return [
    B('h1', 'free', [seg(1, 1.6)], { kind: 'word' }), B('e1', 'Feel free to ask.', [seg(2, 4), seg(4.8, 6.8)], { kind: 'example' }),
    B('h2', 'bid', [seg(9, 9.7)], { kind: 'word' }), B('e2', 'Make a bid.', [seg(10.5, 12), seg(12.8, 14.3)], { kind: 'example' }),
    // 文字起こし（生）: 見出し語を聞き間違えている（free → xylophone、bid → quartz）
    newBlock(setId, { id: setId + 'a1', text: 'xylophone', asr: true, aligned: false, sync: 'auto', segments: [seg(1, 1.6)] }),
    newBlock(setId, { id: setId + 'a2', text: 'quartz', asr: true, aligned: false, sync: 'auto', segments: [seg(9, 9.7)] }),
  ];
};
for (const [setId, op] of [['SA', 'structure-assign'], ['SB', 'align']]) {
  const blocks = mk(setId, op);
  const set = { id: setId, title: setId, order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab' };
  await sdb.put('sets', set); await commit(set, '作成', { blocks });
}
const a = await P.runPipeline({ kind: 'studio', id: 'SA' }, {}, {});
assert(a.items.every(i => i.state === 'confirmed'), '構造から割り当てた行は、文字起こしの聞き間違いで候補に落ちない: ' + a.items.map(i => i.state));
assert(a.items[0].refs.word.reasons.some(r => /構造から割り当て/.test(r)));
const b = await P.runPipeline({ kind: 'studio', id: 'SB' }, {}, {});
assert(b.items.every(i => i.state === 'candidates') && b.items[0].refs.word.reasons.includes('文字起こしと食い違う'), '従来の照合は、食い違えば候補に落とす（変わらない）');
console.log('vocab-audio-structure-trust: rows assigned by the speech structure stay confirmed when the coarse transcript mishears the head; ordinary aligned rows are still demoted');
