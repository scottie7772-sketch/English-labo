import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './fake-idb.mjs';
const { zipWrite } = await import('./common-pack.js').catch(() => import('../common-pack.js'));
const { db } = await import('./db.js').catch(() => import('../db.js'));
const { parseMA, readMAStudyZip, importMA, linkChapter, phraseIndex, highlightRanges, indexChapter, maLinks, validMALink, saveMABoundary, playMA } =
  await import('./ma-phrases.js').catch(() => import('../ma-phrases.js'));

installFakeIndexedDB();
const zipEntries = [
  { name: 'MA_Phrase_Study/00_Phrase_List.csv', data: 'ID,優先度,英語フレーズ,意味,本文での形,出典\n1-001,1,walk in,入る,walked in,BEFORE_1 行12' },
  { name: 'MA_Phrase_Study/01_English_Japanese.txt', data: '1-001  walk in\n本文の形　walked in\n英　She walked in.\n日　彼女が入った。\n出典　BEFORE_1 行12（注記）' },
  { name: 'MA_Phrase_Study/02_English_Japanese.txt', data: '' },
  { name: 'MA_Phrase_Study/03_English_Japanese.txt', data: '' },
];
const [fromZip] = await readMAStudyZip(new Blob([await zipWrite(zipEntries)]));
assert.equal(fromZip.id, '1-001');
assert.equal(fromZip.examples[0].position, '12');
assert.equal(fromZip.examples[0].csvSource, 'BEFORE_1 行12');
assert.equal(fromZip.examples[0].ja, '彼女が入った。');
await assert.rejects(readMAStudyZip(new Blob([await zipWrite(zipEntries.slice(0, 3))])));

const csv = ['id,phrase,meaning,priority,example_en,example_ja,chapter,before,after,variants',
  'a,turned away,拒んだ,1,She turned me away.,彼女は私を拒んだ。,1,He knocked.,,turned me away',
  'a,turned away,拒んだ,1,They turned away.,彼らは引き返した。,2,,,',
  'b,away,離れて,2,She turned me away.,,1,,,',
  'c,we can’t,できない,3,We can\'t wait.,,1,,,',
  'd,wait,待つ,2,We can\'t wait.,,1,,,',
  'e,come in,入る,3,Come in now.,,1,,,',
].join('\n');
const parsed = parseMA(csv, "We can't wait.", '待ちきれない。');
assert.equal(parsed[0].examples.length, 2);
const glossary = parseMA('phrase,meaning,priority\nCome in,入る,2', 'Come in now.\n\nPlease come in.', '今入って。\n\nどうぞお入りください。');
assert.deepEqual(glossary[0].examples.map(e => e.ja), ['今入って。', 'どうぞお入りください。']);
assert.equal(parsed[2].examples[0].ja, '待ちきれない。');
assert.throws(() => parseMA('phrase,meaning,priority\nhello,hi,6'));
assert.throws(() => parseMA(csv, 'One\n\nTwo', '一'));

await Promise.all([importMA(parsed), importMA(parsed)]);
let words = await db.all('words');
assert.equal(words.length, 5);
assert.equal((await db.all('decks')).length, 4);
const initial = words.find(w => w.id === 'ma_61');
await db.put('mastery', { id: 'keep', wordId: initial.id, manualLevel: 4 });
await db.put('words', { ...initial, bookmarked: true });
await importMA(parsed);
assert.equal((await db.get('words', initial.id)).bookmarked, true);
assert.equal((await db.get('mastery', 'keep')).manualLevel, 4);

const v = { id: 'v', name: 'Master & Apprentice Chapter 1', materialType: 'prose' };
const wav = new Blob(['synthetic audio']);
const cue = (id, en, start, end, extra = {}) => ({ id, videoId: v.id, en, start, end, sync: 'manual', ...extra });
const cues = [
  cue('x', 'Someone left.', 0, 1),
  cue('repeat', 'She turned me away.', 1, 3),
  cue('y', 'He knocked.', 3, 4),
  cue('match', 'SHE turned me away!', 4, 6),
  cue('split1', "We can't", 6, 7),
  cue('split2', 'wait.', 7, 8),
  cue('prefix', 'awaiting.', 8, 9),
  cue('timed', 'Come in now.', 9, 11, { wordTimings: [
    { text: 'Come', start: 9.02, end: 9.3 }, { text: 'in', start: 9.32, end: 9.5 },
    { text: 'now', start: 10, end: 10.5 },
  ] }),
];
await db.put('videos', v);
await db.put('vblobs', { id: v.id, blob: wav });
await db.putMany('cues', cues);
assert.equal(await indexChapter(v.id, 'Chapter 01'), 4);
const a = await db.get('words', initial.id);
const [link] = maLinks(a);
assert.equal(link.ref.start, 4);
assert.equal(link.phrase, null);
const b = await db.get('words', 'ma_62');
assert.equal(maLinks(b).length, 0);
assert.ok(b.ma.chapters.v.candidates.length);
const e = maLinks(await db.get('words', 'ma_65'))[0];
assert.deepEqual([e.phrase.start, e.phrase.end], [9.02, 9.5]);
assert.equal(await db.count('vblobs'), 1);

assert.equal(await validMALink(link), true);
await assert.rejects(saveMABoundary(a.id, link, 2, 5, true));
await saveMABoundary(a.id, link, 4.4, 5.8, true);
await indexChapter(v.id, '1');
assert.equal(maLinks(await db.get('words', a.id))[0].manual.start, 4.4);
let ended = 0;
await db.put('cues', { ...cues[3], end: 5.9 });
assert.equal(await validMALink(link), false);
// A missing reference resolves false before any audio player is constructed.
assert.equal(await playMA(a, 'example', { link, onEnd: () => ended++ }), false);
assert.equal(ended, 1);
await db.put('cues', cues[3]);

words = await db.all('words');
const extra = { id: 'long', headword: "we can’t wait", ma: { priority: 1, variants: [] } };
const idx = phraseIndex([...words, extra]);
const hits = highlightRanges(cues, 3, 8, idx, [1, 2, 3]);
assert.equal(hits.get('match')[0].id, a.id);
assert.equal(hits.get('split1')[0].id, 'long');
assert.equal(hits.get('split2')[0].id, 'long');
assert.equal(hits.has('prefix'), false);
assert.equal(highlightRanges(cues, 4, 6, idx, [3]).get('split1')[0].id, 'ma_63');

const size = 650;
const synthetic = Array.from({ length: size }, (_, i) => ({
  id: 'synthetic' + i, headword: 'phrase ' + i,
  ma: { priority: i % 3 + 1, variants: [], examples: [{ en: 'This is phrase ' + i, chapter: '1' }] },
}));
const scene = Array.from({ length: 5000 }, (_, i) => cue('s' + i, i < size ? 'This is phrase ' + i : 'An unrelated test cue', 2 * i, 2 * i + 1));
const rows = scene.map(c => ({ id: c.id, confirmed: true, segments: [{ start: c.start, end: c.end, size: 1, key: v.id, store: 'vblobs' }] }));
globalThis.gc?.();
const heap = process.memoryUsage().heapUsed;
const t0 = performance.now();
const plan = linkChapter(synthetic, scene, v, rows, '1');
const elapsed = performance.now() - t0;
assert.equal(plan.filter(x => x.found.length === 1).length, size);
assert.equal(plan.reduce((sum, entry) => sum + entry.candidates.length, 0), 0);
const synIndex = phraseIndex(synthetic);
const t1 = performance.now();
for (let i = 0; i < 100; i++) assert.equal(highlightRanges(scene, i, i + 12, synIndex, [1, 2, 3]).size, 12);
console.log(JSON.stringify({ matchMs: elapsed, highlightWindowMs: (performance.now() - t1) / 100, liveHeapDeltaMiB: (process.memoryUsage().heapUsed - heap) / 1048576 }));
