// スタジオの単語リスト → CSV で単語帳に追加した単語に、その教材の確定した音声（見出し語・例文）が付くこと。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');
const { analyzeCSV, registerEntries } = await import('../words.js');
const { resolveAudio } = await import('../word-audio-resolve.js');

await sdb.put('sources', { id: 'src1', name: 'unit.m4a', kind: 'audio', size: 5000, blob: new Blob([new Uint8Array(5000)]) });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const B = (id, text, segments, extra = {}) => newBlock('S1', { id, text, segments, ...extra });
const blocks = [
  B('h1', 'refer to', [seg(1, 1.6)], { kind: 'word', aligned: true, sync: 'auto' }),
  B('e1', 'Please refer to the map.', [seg(2, 4), seg(4.8, 6.8)], { kind: 'example', aligned: true, sync: 'auto' }),
  B('h2', 'employee', [seg(9, 9.7)], { kind: 'word', aligned: true, sync: 'auto' }),
  B('e2', 'All company employees', [seg(10.5, 12), seg(12.8, 14.3)], { kind: 'example', aligned: true, sync: 'auto' }),
  B('h3', 'invoice', [], { kind: 'word', script: true }),   // 音声が未確定の語
  B('e3', 'Send an invoice.', [], { kind: 'example', script: true }),
];
const set = { id: 'S1', title: '金フレ Unit', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab', folder: '金フレ' };
await sdb.put('sets', set); await commit(set, '作成', { blocks });

// ChatGPT が返したテキスト（番号・説明文つき）。2つ目は例文を言い換えている
const text = `以下に単語帳用のリストを作成しました。

1. refer to – 〜に言及する、参照する
   Please refer to the map. 地図を参照してください。
2. employee – 従業員
   Every employee must attend. 全従業員が出席しなければならない。
3. invoice – 請求書
以上です。`;
const a = analyzeCSV(text);
assert.equal(a.how, 'loose'); assert.deepEqual(a.entries.map(e => e.headword), ['refer to', 'employee', 'invoice']);
assert.equal(a.entries[0].example_ja, '地図を参照してください。');
const r = await registerEntries(a.entries, { type: 'studio', note: '金フレ Unit', setId: 'S1' }, { tags: [], deckIds: [] });
assert.equal(r.added, 3);
assert((await db.all('words')).every(w => !w.audio), '追加しただけでは、音声は付かない（これが以前の動き）');

const out = await P.attachAudioFromSet('studio', 'S1', { heads: new Set(a.entries.map(e => P.keyOfHead(e.headword))) });
const words = Object.fromEntries((await db.all('words')).map(w => [w.headword, w]));
assert.equal(out.updated, 2, '確定した音声のある2語に付く');
assert.deepEqual([words['refer to'].audio.word.start, words['refer to'].audio.word.end], [1, 1.6], '見出し語の音声');
assert.equal(words['refer to'].audio.example.start, 2, '例文が教材と同じなら、例文の音声も付く（反復の1回目）');
assert.equal(words['employee'].audio.word.start, 9);
assert.equal(words['employee'].audio.example, undefined, '例文が言い換えられていたら、別の例文の音声を付けない');
assert.equal(words['invoice'].audio, undefined, '音声が未確定の語には付けない');
assert.equal(resolveAudio(words['refer to']).via, 'ref');
// もう一度実行しても、変わらない（重複しない）
const again = await P.attachAudioFromSet('studio', 'S1', {});
assert.equal(again.updated, 0); assert.equal((await db.all('words')).length, 3);
console.log('studio-csv-audio: words added from a chatty English-Japanese text get the set\'s confirmed head/example audio; paraphrased examples and unconfirmed rows get none');
