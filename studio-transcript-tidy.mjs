// 照合済みの行と同じ内容の、未確定の文字起こしを整理する（duplicateTranscripts）。
import assert from 'node:assert/strict';
const { duplicateTranscripts } = await import('../studio-transcript-tidy.js');
const seg = (a, b) => ({ sourceId: 's', start: a, end: b });
const S = (id, text, segments, extra = {}) => ({ id, text, segments, aligned: true, sync: 'auto', ...extra });
const A = (id, text, segments = [], extra = {}) => ({ id, text, asr: true, aligned: false, sync: 'auto', segments, ...extra });
const blocks = [
  S('h1', 'expertise', [seg(42.2, 43.5)]), S('e1', 'An area of expertise', [seg(44.2, 46.2), seg(47.1, 49.1)]),
  // 見出し語＋例文×2 がまとまった文字起こしが、時刻なし・推定のまま残っている
  A('a1', 'An area of expertise renowned a renowned artist', [], { sync: 'estimated' }),
  S('h2', 'renowned', [seg(50.4, 51.6)]), S('e2', 'A renowned artist', [seg(52.2, 53.9), seg(54.7, 56.4)]),
  A('a2', 'A renowned artist prototype develop a prototype develop a prototype', []),
  S('h3', 'prototype', [seg(57.7, 58.6)]), S('e3', 'Develop a prototype', [seg(59.4, 61.1), seg(62, 63.7)]),
  // 時刻つき: 照合済みの行の音声と重なる（見出し語だけの文字起こし）
  A('a3', 'Verify.', [seg(95.6, 96.7)]),
  S('h4', 'verify', [seg(95.6, 96.7)]),
  // 消さないもの: 内容が別（スクリプトにない発話）／日本語訳つき／手動／照合済み
  A('k1', 'Welcome to the training session today everyone', [seg(120, 124)]),
  A('k2', 'An area of expertise', [], { ja: '専門分野' }),
  A('k3', 'An area of expertise renowned', [], { sync: 'manual' }),
  A('k4', 'Verify an email address', [], { aligned: true }),
];
const out = duplicateTranscripts(blocks);
assert.deepEqual(out.map(x => x.block.id).sort(), ['a1', 'a2', 'a3'], '重複した文字起こしだけを選ぶ');
assert.equal(out.find(x => x.block.id === 'a3').why, '照合済みの行の音声と重なる');
assert.equal(out.find(x => x.block.id === 'a1').why, '前後の照合済みの行と同じ内容');
// 今回割り当てた範囲（保存前）と重なる文字起こしも対象
const b2 = [A('x', 'Hello there', [seg(10, 11)])];
assert.equal(duplicateTranscripts(b2, { assigned: [seg(10, 11.1)] }).length, 1);
assert.equal(duplicateTranscripts(b2).length, 0, '照合済みの行が無ければ消さない');
console.log('studio-transcript-tidy: only untouched transcript rows that duplicate nearby aligned script rows are selected');
