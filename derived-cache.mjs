// 解析データ・キャッシュの一括削除: 作り直せるものだけを消し、音声・字幕・手動の修正・全体スクリプト・版・単語は残す。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb } = await import('../studio-db.js');
const { scanDerived, clearDerived, CATEGORIES } = await import('../derived-cache.js');

await sdb.put('sources', { id: 'src1', name: 'a.m4a', kind: 'audio', size: 10, blob: new Blob([new Uint8Array(10)]) });
await sdb.put('blocks', { id: 'b1', setId: 'S1', rev: 3, text: 'hello', segments: [{ sourceId: 'src1', start: 0, end: 1 }], deleted: false, manual: true });
await sdb.put('blockRevs', { id: 'b1@3' }); await sdb.put('blockRevs', { id: 'b1@1' }); await sdb.put('blockRevs', { id: 'b1@2' });
await sdb.put('oplog', { id: 'op1', blocks: [] }); await sdb.put('oplog', { id: 'op2', blocks: [] });
await sdb.put('sets', { id: 'S1', title: 't', order: ['b1'], undo: ['op1'], redo: ['op2'], speechFirstDraft: [{ blockId: 'b1' }], structureAlignReceipt: { at: 1 }, kfRange: { startN: 1 } });
await sdb.put('versions', { id: 'v1', setId: 'S1', revs: { b1: 'b1@2' } });
for (const k of ['edge-cues:S1', 'sa-ckpt:S1:src1', 'sa-ckpt:S1:src2', 'speech-first:S1']) await sdb.put('meta', { key: k, data: 'x'.repeat(100) });
await sdb.put('meta', { key: 'studio-folder-kf:fold1', rows: [{ text: 'whole script' }] });
await sdb.put('meta', { key: 'studio-folders', folders: [] });
await db.put('settings', { key: 'wap:studio:S1', value: { items: [] } }); await db.put('settings', { key: 'wap:lab:v1', value: { items: [] } });
await db.put('settings', { key: 'theme', value: 'dark' });
await db.put('words', { id: 'w1', headword: 'keep', senses: [], audio: {} });

const scan = await scanDerived();
assert.equal(scan.edge.count, 1); assert.equal(scan.saCkpt.count, 2); assert.equal(scan.speechFirst.count, 2, 'meta 1 + 未保存の候補 1');
assert.equal(scan.receipts.count, 1); assert.equal(scan.vocabRecords.count, 2); assert.equal(scan.history.count, 1);
assert(scan.saCkpt.bytes > 200);

// 履歴を除く既定の分類だけを消す
const done = await clearDerived(CATEGORIES.filter(c => !c.optIn).map(c => c.id));
assert.equal(done.saCkpt, 2); assert.equal(done.vocabRecords, 2);
const keys = (await sdb.all('meta')).map(m => m.key).sort();
assert.deepEqual(keys, ['studio-folder-kf:fold1', 'studio-folders'], '全体スクリプト・フォルダの情報は残る');
const set = await sdb.get('sets', 'S1');
assert(!set.speechFirstDraft && !set.structureAlignReceipt); assert.deepEqual(set.undo, ['op1']); assert.deepEqual(set.kfRange, { startN: 1 }, '確認した範囲は残る');
assert.equal((await db.get('settings', 'theme')).value, 'dark'); assert.equal((await db.all('settings')).filter(r => /^wap:/.test(r.key)).length, 0);
assert((await db.get('words', 'w1')).headword === 'keep', '単語は残る');
assert((await sdb.get('blocks', 'b1')).manual === true && (await sdb.get('sources', 'src1')).name === 'a.m4a', '音声・字幕・手動の修正は残る');
// 履歴: 操作を消し、保存した版と現在の行が使う過去の状態は残す
await clearDerived(['history']);
const after = await sdb.get('sets', 'S1'); assert.deepEqual([after.undo, after.redo], [[], []]);
assert.equal((await sdb.all('oplog')).length, 0);
assert.deepEqual((await sdb.all('blockRevs')).map(r => r.id).sort(), ['b1@2', 'b1@3'], '版が使う b1@2 と現在の b1@3 は残り、不要な b1@1 だけ消える');
assert.equal((await sdb.all('versions')).length, 1);
console.log('derived-cache: scan and selective clear keep audio, rows, manual edits, whole script, versions, words; history removal keeps what saved versions need');
