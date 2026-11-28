// 金フレ型の Studio 教材は、教材の種類が未設定でも MA の本文として照合しない（金フレの音声を割り当てたあと、MA の単語に金フレの音声が紐づいていた）。
// MA の教材（名前・フォルダが MA）は、従来どおり照合する。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb } = await import('../studio-db.js');
const { parseMA, importMA, indexStudioChapter, maLinks, vocabLikeStudioSet } = await import('../ma-phrases.js');

const wav = new Blob([new Uint8Array(2000)], { type: 'audio/wav' });
const sentence = 'Please refer to the map.';
await importMA(parseMA(['id,phrase,meaning,priority,example_en,example_ja,chapter', `a,refer to,言及する,1,${sentence},地図を参照してください。,1`].join('\n'), sentence, '地図を参照してください。'));
const word = (await db.all('words')).find(w => w.ma);
assert(word);
await sdb.put('sources', { id: 'au', blob: wav });
const mkSet = async (id, title, extra = {}, rows = []) => {
  const order = rows.map((r, i) => id + i);
  await sdb.tx(['sets', 'blocks'], 'readwrite', tx => {
    tx.objectStore('sets').put({ id, title, order, ...extra });
    rows.forEach((r, i) => tx.objectStore('blocks').put({ id: id + i, setId: id, rev: 1, text: r.text, kind: r.kind, aligned: true, segments: [{ sourceId: 'au', start: i * 4 + 1, end: i * 4 + 3 }] }));
  });
  return await sdb.get('sets', id);
};
// 金フレ型: 見出し語と例文が交互（種類は未設定）。例文が MA の例文と同じ
const kin = await mkSet('kin', 'TOEIC_kin_kaitei_en15', {}, Array.from({ length: 8 }, (_, i) => i % 2 === 0 ? { text: ['refer', 'employee', 'offer', 'likely'][i / 2], kind: 'word' } : { text: i === 1 ? sentence : 'All company employees ' + i, kind: 'example' }));
assert.equal(await indexStudioChapter(kin), null, '金フレ型の教材は MA として照合しない');
assert.equal(maLinks(await db.get('words', word.id)).length, 0, 'MA の単語に金フレの音声が紐づかない');
// 種類も名前も未設定でも、見出し語・例文の印が付いた行が多ければ金フレ型
const marked = await mkSet('kin2', '教材A', {}, Array.from({ length: 12 }, (_, i) => ({ text: i % 2 ? 'Please refer to the map.' : 'word' + i, kind: i % 2 ? 'example' : 'word' })));
assert.equal(vocabLikeStudioSet(marked, await sdb.byIndex('blocks', 'setId', 'kin2')), true);
// すでに紐づいてしまった分は、次の照合で外れる
await db.put('words', { ...word, ma: { ...word.ma, chapters: { 'studio:kin': { found: [], candidates: [], stale: false } } } });
await indexStudioChapter(kin);
assert.equal((await db.get('words', word.id)).ma.chapters?.['studio:kin'], undefined, '金フレ型の教材に紐づいた記録を外す');
// MA の教材（名前が MA）・種類が未設定の普通の本文は、従来どおり照合する
const ma = await mkSet('ma1', 'Master and Apprentice Chapter 1', {}, [{ text: sentence, kind: undefined }]);
assert.equal((await indexStudioChapter(ma)).count, 1, 'MA の教材は照合する');
assert.equal(maLinks(await db.get('words', word.id)).length, 1);
console.log('ma-kinfure-exclusion: kinfure-like Studio sets are never indexed as MA text (even with no material type); MA sets still are; stale links are removed');
