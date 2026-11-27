import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const P = await import('../vocab-audio-pipeline.js');
const { newWord, newSense } = await import('../words.js');

const blob = new Blob([new Uint8Array(4000)]);
await sdb.put('sources', { id: 'src1', name: 'kinfre.m4a', kind: 'audio', size: 4000, blob });
const seg = (a, b) => ({ sourceId: 'src1', start: a, end: b });
const B = (id, text, segments, extra = {}) => newBlock('S1', { id, text, segments, ...extra });

// ---- 金フレ型の教材（スタジオ）: 見出し語→例文（2回）。3番目は推定時刻、4番目は聞き間違い（未割当）・例文なし ----
const asrRow = (id, text, a, b) => B(id, text, [seg(a, b)], { asr: true, aligned: false, sync: 'auto' });
const blocks = [
  B('h1', 'allocate', [seg(1, 1.6)], { kind: 'word', aligned: true, sync: 'auto' }),
  B('e1', 'We allocate funds to each team.', [seg(2, 4), seg(4.6, 6.6)], { kind: 'example', aligned: true, sync: 'auto' }),
  B('h2', 'compromise', [seg(8, 8.7)], { kind: 'word', aligned: true, sync: 'auto' }),
  B('e2', 'They reached a compromise.', [], { kind: 'example', script: true }),                 // 例文の音声照合は失敗
  B('h3', 'estimate', [seg(13, 13.6)], { kind: 'word', aligned: false, sync: 'estimated' }),    // 推定
  B('h4', 'dispute', [], { kind: 'word', script: true }),                                         // 未割当（文字起こしは聞き間違い）
  B('h5', 'refund', [seg(20, 20.5)], { kind: 'word', aligned: true, sync: 'auto' }),
  asrRow('r3', 'estimate', 13.02, 13.62), asrRow('r4', 'dis pute', 16, 16.6),
];
let set = { id: 'S1', title: '金フレ Unit 1', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab', folder: '金フレ' };
await sdb.put('sets', set); await commit(set, '作成', { blocks });

// ---- 1回目: 判定・抽出・確信度・局所再照合 ----
const steps = [];
let r = await P.runPipeline({ kind: 'studio', id: 'S1' }, {}, { onStep: (n) => steps.push(n) });
assert.equal(r.rec.profile, 'kinfure');
assert.deepEqual(steps.filter(x => x !== 'load'), ['detect', 'extract', 'grade', 'recheck']);
const byHead = () => Object.fromEntries(r.items.map(i => [i.head, i]));
let H = byHead();
assert.equal(H.allocate.state, 'confirmed');
assert.equal(H.compromise.state, 'confirmed', '例文が失敗しても、見出し語が確定していれば登録できる状態');
assert.equal(H.compromise.refs.example, null);
assert.equal(H.estimate.state, 'confirmed', '推定時刻は、文字起こしが裏付けたときだけ確定に上がる');
assert(H.estimate.refs.word.reasons.includes('文字起こしで裏付け'));
assert.equal(H.dispute.state, 'confirmed', '聞き間違えられた見出し語を、前後の確定済みの音声のあいだから特定する');
assert.equal(H.dispute.refs.word.ref.start, 16);
assert.equal(H.refund.state, 'confirmed');
assert.equal(r.summary.total, 5);
assert.equal(r.summary.wordConfirmed, 5);
assert.equal(r.summary.exampleConfirmed, 1);

// ---- 同じ入力で再実行: 何も再処理しない（結果をそのまま使う） ----
steps.length = 0;
const first = JSON.stringify(r.rec.items);
r = await P.runPipeline({ kind: 'studio', id: 'S1' }, {}, { onStep: (n) => steps.push(n) });
assert.deepEqual(r.reused, ['extract', 'recheck']);
assert.deepEqual(steps, ['load']);
assert.equal(JSON.stringify(r.rec.items), first);

// ---- 設定（モード）が変わったら作り直すが、手で確定した参照・登録済みの印は引き継ぐ ----
await P.reviewConfirm('studio', 'S1', H.estimate.key, 'word', { src: H.estimate.refs.word.ref.src, start: 13.0, end: 13.7 });
r = await P.runPipeline({ kind: 'studio', id: 'S1' }, { mode: 'example' }, {});
H = byHead();
assert.equal(H.estimate.refs.word.manualConfirmed, true);
assert.deepEqual([H.estimate.refs.word.ref.start, H.estimate.refs.word.ref.end], [13.0, 13.7]);
assert(H.estimate.refs.word.ref.manual);
assert.equal(r.summary.complete, 4, '見出し語＋例文: 例文のある項目（compromise）だけは、例文の音声が確定するまで未完了。例文のない項目は見出し語だけで完了');
r = await P.runPipeline({ kind: 'studio', id: 'S1' }, { mode: 'head' }, {});
H = byHead();
assert.equal(r.summary.complete, 5);

// ---- 登録: 確定した音声だけ。既存の単語は音声だけ追加。未確定は登録せず、あとで追加できる ----
const old = newWord({ headword: 'allocate', senses: [newSense({ pos: 'verb', meanings: ['割り当てる'], examples: [{ en: 'We allocate funds to each team.', ja: '元の訳' }] })], tags: ['自分の'] });
await db.put('words', old);
const plan = await P.planRegistration(r.rec);
assert.equal(plan.update.length, 1); assert.equal(plan.add.length, 4);
assert.equal(plan.pending.length, 0);
const done = await P.registerRecord('studio', 'S1');
assert.deepEqual([done.added, done.updated], [4, 1]);
let words = await db.all('words');
assert.equal(words.length, 5);
const al = words.find(w => w.id === old.id);
assert.deepEqual([al.senses[0].examples[0].ja, al.tags], ['元の訳', ['自分の']], '既存の単語の意味・例文・タグは変えない');
assert.equal(al.audio.word.start, 1); assert.equal(al.audio.example.end, 4, '復唱は1回分だけ');
assert(!JSON.stringify(words).includes('"blob"'), '音声は複製しない（参照だけ）');
r = { ...r, rec: await P.loadRecord('studio', 'S1') };
assert(r.rec.items.every(i => i.registeredId && i.state === 'registered'));
// 2回目: 増えない
const again = await P.registerRecord('studio', 'S1');
assert.deepEqual([again.added, again.updated], [0, 0]);
assert.equal((await db.all('words')).length, 5);

// ---- 後から未確定の項目に音声を追加できる ----
await db.clear('words');
const blocks2 = blocks.map(b => b.id === 'h3' ? { ...b, sync: 'estimated' } : b);   // 推定の行は、文字起こしがなければ確定しない
await db.put('words', old);
for (const id of ['r3']) await sdb.put('blocks', { ...(await sdb.get('blocks', id)), deleted: true });   // 裏付けの文字起こしを消す
await P.dropRecord('studio', 'S1');
r = await P.runPipeline({ kind: 'studio', id: 'S1' }, {}, {});
H = byHead();
assert.notEqual(H.estimate.state, 'confirmed', '裏付けがなければ、推定時刻は確定にならない');
let reg = await P.registerRecord('studio', 'S1');
assert.equal((await db.all('words')).find(w => w.headword === 'estimate'), undefined, '未確定の項目は登録しない');
assert(reg.plan.pending.some(x => x.item.head === 'estimate'));
await P.reviewConfirm('studio', 'S1', H.estimate.key, 'word', { src: H.estimate.refs.word.ref.src, start: 13.0, end: 13.6 });
reg = await P.registerRecord('studio', 'S1');
assert.equal(reg.added, 1, '確定したあとにもう一度実行すれば、その1語だけが追加される');
assert.equal((await db.all('words')).filter(w => w.headword === 'estimate').length, 1);

// ---- 中断と再開: 発話の切れ目の調査を途中で止めても、済んだ窓は保たれる ----
await P.dropRecord('studio', 'S1');
const calls = [];
let cancelAfter = 1;
const hooks = { cancelled: () => calls.length >= cancelAfter, regionsFor: async (src, a, b) => { calls.push([a, b]); return [[a + .5, a + 1.2]]; } };
const part = await P.runPipeline({ kind: 'studio', id: 'S1' }, { refine: 'all' }, hooks);
assert.equal(part.stopped, true);
assert.equal(calls.length, 1);
assert.equal((await P.loadRecord('studio', 'S1')).regionDone, 1);
cancelAfter = 99;
const resumed = await P.runPipeline({ kind: 'studio', id: 'S1' }, { refine: 'all' }, hooks);
assert.equal(resumed.stopped, false);
assert(calls.length > 1);
const before = calls.length;
await P.runPipeline({ kind: 'studio', id: 'S1' }, { refine: 'all' }, hooks);
assert.equal(calls.length, before, '完了済みなら、何も調べ直さない');

// ---- 参照切れ ----
const rec = await P.loadRecord('studio', 'S1');
rec.items[0].refs.word.ref.src = { store: 'vblobs', key: 'gone' };
assert.equal(await P.markBroken(rec), 1);
assert.equal(rec.items[0].state, 'broken');

// ---- 単語リスト（会話・朗読の対象フレーズ）の読み取り ----
assert.deepEqual(P.parseWordList('figure out\t理解する\nhand in,提出する\n\ntake over\n  \n'), [{ head: 'figure out', ja: '理解する' }, { head: 'hand in', ja: '提出する' }, { head: 'take over' }]);
// ---- 教材の境界をあとから直したとき: 自動で登録した音声は新しい範囲に合わせる。手で直した音声は変えない ----
await db.clear('words');
const NB = (id, text, segs, x) => newBlock('S2', { id, text, segments: segs, aligned: true, sync: 'auto', ...x });
const b2 = [NB('d1', 'allocate', [seg(1, 1.6)], { kind: 'word' }), NB('d2', 'We allocate funds.', [seg(2, 4)], { kind: 'example' }), NB('d3', 'refund', [seg(8, 8.5)], { kind: 'word' })];
const set2 = { id: 'S2', title: 'Drift', order: b2.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab' };
await sdb.put('sets', set2); await commit(set2, '作成', { blocks: b2 });
await P.runPipeline({ kind: 'studio', id: 'S2' }, {}, {}); await P.registerRecord('studio', 'S2');
const startOf = async head => (await db.all('words')).find(w => w.headword === head).audio.word.start;
assert.equal(await startOf('allocate'), 1);
const move = async (id, a, b) => { const s2 = await sdb.get('sets', 'S2'); const cur = await sdb.get('blocks', id); await commit(s2, '境界を直す', { blocks: [{ ...cur, segments: [seg(a, b)] }] }); };
await move('d1', .9, 1.6);
await P.runPipeline({ kind: 'studio', id: 'S2' }, {}, {});
const again2 = await P.registerRecord('studio', 'S2');
assert.equal(await startOf('allocate'), .9, '教材の境界を直したら、自動で登録した音声も新しい範囲に合わせる');
assert.equal(again2.added, 0);
// 手で直した音声は、教材側の変更で上書きしない
const w9 = (await db.all('words')).find(w => w.headword === 'allocate');
await db.put('words', { ...w9, audio: { ...w9.audio, word: { ...w9.audio.word, start: .95, manual: true } } });
await move('d1', .85, 1.6);
await P.runPipeline({ kind: 'studio', id: 'S2' }, {}, {});
await P.registerRecord('studio', 'S2');
assert.equal(await startOf('allocate'), .95, '手で直した音声は、再登録でも変わらない');
assert.equal(await startOf('refund'), 8, '境界を変えていない語は、そのまま');

console.log('vocab-audio-pipeline: detect / extract / grade / re-check, reuse, resume, hand-confirmed carry-over, head-first registration, idempotent re-registration, later addition, broken refs pass');
