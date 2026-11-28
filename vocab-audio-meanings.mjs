// 音声付き単語帳の作成に、英和テキスト（ChatGPT などの出力。番号・説明文つきでもよい）を渡すと、日本語の意味・例文訳が付いた単語になる。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');

await sdb.put('sources', { id: 'src1', name: 'unit.m4a', kind: 'audio', size: 5000, blob: new Blob([new Uint8Array(5000)]) });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const B = (id, text, segments, extra = {}) => newBlock('S1', { id, text, segments, aligned: true, sync: 'auto', ...extra });
const blocks = [
  B('h1', 'refer to', [seg(1, 1.6)], { kind: 'word' }), B('e1', 'Please refer to the map.', [seg(2, 4), seg(4.8, 6.8)], { kind: 'example' }),
  B('h2', 'employee', [seg(9, 9.7)], { kind: 'word' }), B('e2', 'All company employees', [seg(10.5, 12), seg(12.8, 14.3)], { kind: 'example' }),
  B('h3', 'invoice', [seg(16, 16.6)], { kind: 'word' }), B('e3', 'Send an invoice.', [seg(17.4, 18.8), seg(19.6, 21)], { kind: 'example' }),
];
const set = { id: 'S1', title: '金フレ', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab' };
await sdb.put('sets', set); await commit(set, '作成', { blocks });

// 解析: ChatGPT の返答そのまま（説明文・番号・コードブロック・例文訳つき。invoice は意味が無い）
const text = `もちろんです。以下がリストです。

\`\`\`
1. refer to – 〜に言及する、参照する
   Please refer to the map. 地図を参照してください。
2. employee：従業員
   All company employees 会社の全従業員
3. invoice
\`\`\`
ご確認ください。`;
const list = P.parseWordList(text);
assert.deepEqual(list.map(x => x.head), ['refer to', 'employee', 'invoice']);
assert.equal(list[0].ja, '〜に言及する / 参照する'); assert.equal(list[1].exampleJa, '会社の全従業員'); assert.equal(list[2].ja, undefined, '意味が書かれていない語は、意味を作らない');
// 従来の形も変わらない
assert.deepEqual(P.parseWordList('figure out\t理解する\nturn down').map(x => [x.head, x.ja]), [['figure out', '理解する'], ['turn down', undefined]]);

const r = await P.runPipeline({ kind: 'studio', id: 'S1' }, { wordList: list }, {});
assert.equal(r.rec.profile, 'kinfure'); assert.equal(r.rec.meaningsApplied, 2);
const items = Object.fromEntries(r.items.map(i => [i.head, i]));
assert.equal(items['refer to'].ja, '〜に言及する / 参照する'); assert.equal(items['refer to'].exampleJa, undefined === 0 ? '' : '地図を参照してください。');
assert.equal(items['employee'].ja, '従業員'); assert.equal(items['employee'].exampleJa, '会社の全従業員');
assert.equal(items['invoice'].ja, '', '意味が無い語は空のまま');
await P.registerRecord('studio', 'S1');
const words = Object.fromEntries((await db.all('words')).map(w => [w.headword, w]));
assert.deepEqual(words['refer to'].senses[0].meanings, ['〜に言及する', '参照する'], '日本語の意味つきの単語になる');
assert.equal(words['refer to'].senses[0].examples[0].ja, '地図を参照してください。');
assert.equal(words['employee'].senses[0].examples[0].ja, '会社の全従業員');
assert.equal(words['refer to'].audio.word.start, 1); assert.equal(words['refer to'].audio.example.start, 2, '音声も付く');
assert.deepEqual(words['invoice'].senses[0].meanings, [], '意味は作らない（あとで付けられる）');
// 同じ教材で、意味を足してもう一度: すでにある意味は変えない（手で直した意味を壊さない）
const r2 = await P.runPipeline({ kind: 'studio', id: 'S1' }, { wordList: P.parseWordList('invoice 請求書\nemployee 社員') }, {});
assert.equal(r2.items.find(i => i.head === 'invoice').ja, '請求書');
console.log('vocab-audio-meanings: a chatty English-Japanese text gives meanings and example translations; audio is attached together; meaning-less rows stay empty');
