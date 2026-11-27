import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');
const { resolveAudio } = await import('../word-audio-resolve.js');

await sdb.put('sources', { id: 'src1', name: 'talk.m4a', kind: 'audio', size: 5000, blob: new Blob([new Uint8Array(5000)]) });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const T = (text, start, end) => ({ text, start, end });
const talk = [
  ['A: I need to figure out the budget.', [0, 3], [T('A:', 0, .2), T('I', .3, .4), T('need', .4, .7), T('to', .7, .8), T('figure', .9, 1.3), T('out', 1.3, 1.6), T('the', 1.7, 1.8), T('budget.', 1.9, 2.5)]],
  ['B: We should take over the project.', [4, 7], null],
  ['A: Could you hand in the report by Friday?', [8, 11], null],
  ['B: Sure, I will send it tomorrow morning.', [12, 15], null],
  ['A: Thank you so much for your help.', [16, 19], null],
  ['B: You are welcome, any time at all.', [20, 23], null],
];
const blocks = talk.map(([text, [a, b], wt], i) => newBlock('T1', { id: 'u' + i, text, segments: [seg(a, b)], aligned: true, sync: 'auto', ...(wt ? { wordTimings: wt } : {}) }));
const set = { id: 'T1', title: '会話 Unit 1', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1 };
await sdb.put('sets', set); await commit(set, '作成', { blocks });

// ---- 会話型: 単語リストの語が入った発話。語ごとの時刻がある語だけ、見出し語の音声（文中の範囲）が確定する ----
const wordList = P.parseWordList('figure out\t理解する\ntake over\t引き継ぐ\nhand in\t提出する\nturn down');
let r = await P.runPipeline({ kind: 'studio', id: 'T1' }, { wordList }, {});
assert.equal(r.rec.profile, 'dialogue');
const H = Object.fromEntries(r.items.map(i => [i.head, i]));
assert.equal(H['figure out'].state, 'confirmed');
assert.deepEqual([H['figure out'].refs.word.ref.start, H['figure out'].refs.word.ref.end], [.9, 1.6], '文中のフレーズの範囲だけ');
assert.deepEqual([H['figure out'].refs.sentence.ref.start, H['figure out'].refs.sentence.ref.end], [0, 3], '文全体の音声は別に持つ');
assert.equal(H['take over'].refs.word, null, '語ごとの時刻がなければ、文全体を見出し語の音声にしない');
assert.equal(H['take over'].state, 'candidates'); assert.equal(H['take over'].candidates[0].est, true);
assert.equal(H['turn down'].state, 'unresolved');
assert(r.rec.items.every(i => !i.registeredId));
// 見出し語優先（標準）の登録: 確定した1語だけ。文の音声・例文の音声も一緒に付く
let reg = await P.registerRecord('studio', 'T1');
assert.equal(reg.added, 1);
let words = await db.all('words');
assert.deepEqual(words.map(w => w.headword), ['figure out']);
const fo = words[0];
assert.deepEqual([fo.senses[0].meanings, fo.senses[0].examples[0].en], [['理解する'], 'A: I need to figure out the budget.']);
assert.equal(fo.audio.word.start, .9); assert.equal(fo.audio.sentence.end, 3); assert.equal(fo.audio.example.start, 0);
assert.equal(resolveAudio(fo).ref.start, .9, '見出し語は語の範囲で鳴る');
assert.equal(resolveAudio(fo, 'A: I need to figure out the budget.').ref.end, 3, '例文は文全体の音声で鳴る');
// 推定の範囲を試聴して確定 → 1語追加される（人が確認した範囲は手動確定として保存）
const take = H['take over'];
await P.reviewConfirm('studio', 'T1', take.key, 'word', { src: take.candidates[0].src, start: 5.0, end: 5.6 });
reg = await P.registerRecord('studio', 'T1');
assert.equal(reg.added, 1);
const to = (await db.all('words')).find(w => w.headword === 'take over');
assert.equal(to.audio.word.manual, true); assert.equal(to.audio.word.start, 5.0);
assert.equal(resolveAudio(to).via, 'ref');

// ---- 文章・発話全体: 発話そのものを単語帳へ。見出し語の音声ではなく「文の音声」として持つ ----
await db.clear('words');
await P.dropRecord('studio', 'T1');
r = await P.runPipeline({ kind: 'studio', id: 'T1' }, { mode: 'sentence' }, {});
assert.equal(r.summary.total, 6); assert.equal(r.summary.sentenceConfirmed, 6);
assert(r.items.every(i => i.refs.word === null && i.refs.sentence.tier === 'high'));
reg = await P.registerRecord('studio', 'T1');
assert.equal(reg.added, 6);
const sw = (await db.all('words')).find(w => w.headword.startsWith('B: We should'));
assert.equal(sw.audio.word, undefined, '文を見出し語の音声として登録しない');
const res = resolveAudio(sw);
assert.deepEqual([res.via, res.ref.start, res.ref.end], ['sentence', 4, 7], '見出し語が文そのものの単語は、文の音声で鳴る');
assert.equal((await P.registerRecord('studio', 'T1')).added, 0, '2回目は増えない');

// ---- 朗読型・一般単語型・金フレ型の判定が、同じ入口で切り替わる ----
const wl = ['allocate', 'compromise', 'estimate', 'dispute', 'refund', 'invoice'].map((t, i) => newBlock('W1', { id: 'w' + i, text: `${i + 1}. ${t}`, segments: [seg(30 + i * 2, 30 + i * 2 + .6)], aligned: true, sync: 'auto' }));
const w1 = { id: 'W1', title: '単語集', order: wl.map(b => b.id), undo: [], redo: [], updatedAt: 1 };
await sdb.put('sets', w1); await commit(w1, '作成', { blocks: wl });
r = await P.runPipeline({ kind: 'studio', id: 'W1' }, {}, {});
assert.equal(r.rec.profile, 'wordlist');
assert.deepEqual(r.items.map(i => i.head), ['allocate', 'compromise', 'estimate', 'dispute', 'refund', 'invoice'], '番号は見出し語に含めない');
assert.equal(r.summary.wordConfirmed, 6);
r = await P.runPipeline({ kind: 'studio', id: 'W1' }, { profile: 'prose' }, {});
assert.equal(r.rec.profile, 'prose'); assert.equal(r.rec.detect.auto, false, '手動で指定した種類が優先される');
console.log('vocab-audio-modes: conversation phrases with word timings, estimate-only candidates, sentence mode, word-list profile, manual profile override pass');
