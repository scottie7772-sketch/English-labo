import assert from 'node:assert/strict';
import './fake-idb.mjs';

// ---- a simulated <audio> (the clock advances while playing) and animation frames ----
const played = [];
class FakeAudio {
  constructor() { this.src = ''; this.currentTime = 0; this.paused = true; this.ended = false; this.playbackRate = 1; this.muted = false; this.dataset = {}; this.timer = null; }
  set src(v) { this._src = v; if (v) setTimeout(() => this.onloadedmetadata?.(), 1); }
  get src() { return this._src; }
  play() { this.paused = false; played.push({ src: this._src, at: this.currentTime }); clearInterval(this.timer); this.timer = setInterval(() => { if (!this.paused) this.currentTime += 0.01; }, 10); return Promise.resolve(); }
  pause() { this.paused = true; clearInterval(this.timer); this.log?.push(this.currentTime); }
}
globalThis.Audio = FakeAudio;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 8);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const { db, closeDB } = await import('../db.js');
const { sdb, commit, newBlock } = await import('../studio-db.js');
const { isVocabHead } = await import('../studio-vocab-align.js');
const refs = await import('../audio-refs.js');
const { pickReading, vocabItems, studioRows, labRows, planAudioWords, applyAudioWords, wordAudio, referencedMedia, unusedRecordings, refBlob, refBytes } = refs;
const { releaseVideoMedia } = await import('../video-media-ref.js');
const { buildBackup, restoreBackup } = await import('../backup.js');
const { newWord, newSense } = await import('../words.js');
const wa = await import('../word-audio.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- one reading out of several ----------
assert.equal(pickReading([{ start: 0, end: 2 }]).index, 0);
const three = pickReading([{ start: 0, end: 0.6 }, { start: 1, end: 3 }, { start: 3.5, end: 5.6 }]);   // first one cut short
assert.deepEqual([three.index, three.unsure], [1, false]);
assert.equal(pickReading([{ start: 0, end: 2 }, { start: 2.5, end: 4.6 }]).unsure, false);             // two equal readings
assert.equal(pickReading([{ start: 0, end: 2 }, { start: 2.5, end: 6 }]).unsure, true);                // they disagree -> unconfirmed
assert.equal(pickReading([]), null);

// ---------- Studio 金フレ set: word + example (read twice) per group ----------
const src = { id: 'src1', name: 'kinfre.m4a', kind: 'audio', size: 5000, blob: new Blob([new Uint8Array(5000)]) };
await sdb.put('sources', src);
const seg = (start, end) => ({ sourceId: 'src1', start, end });
const B = (id, text, ja, segments, extra = {}) => newBlock('setK', { id, text, ja, jaOverride: !!ja, segments, aligned: true, sync: 'auto', ...extra });
const blocks = [
  B('w1', 'allocate', '割り当てる', [seg(1.0, 1.6)], { kind: 'word' }),
  B('e1', 'We allocate funds to each team.', '各チームに資金を割り当てる。', [seg(2.0, 4.0), seg(4.6, 6.6)], { kind: 'example' }),
  B('w2', 'compromise', '妥協する', [seg(7.0, 7.7)], { kind: 'word' }),
  B('e2', 'They reached a compromise.', '彼らは妥協に至った。', [seg(8.0, 9.6), seg(10.0, 13.5)], { kind: 'example' }),   // readings disagree
  B('w3', 'estimate', '見積もる', [seg(14.0, 14.6)], { kind: 'word', sync: 'estimated', aligned: false }),               // guessed time
  B('e3', 'Please estimate the cost.', '費用を見積もってください。', [], { kind: 'example', aligned: false }),             // no sound
];
let set = { id: 'setK', title: '金フレ Unit 1', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1, materialType: 'vocab' };
await sdb.put('sets', set);
await commit(set, '作成', { blocks });
const sources = { src1: { ...src } };
let rows = studioRows(blocks, sources, { isHead: isVocabHead });
let items = vocabItems(rows, { from: 'studio', materialId: 'setK', title: set.title });
assert.equal(items.length, 3);
const [a1, a2, a3] = items;
assert.deepEqual([a1.head, a1.example, a1.word.start, a1.word.end, a1.ex.start, a1.ex.end, a1.repeats], ['allocate', 'We allocate funds to each team.', 1, 1.6, 2, 4, 2]);
assert.equal(a1.word.state, 'confirmed'); assert.equal(a1.ex.state, 'confirmed');
assert.deepEqual(a1.word.limit, { min: 0, max: 2 }, 'the word never plays into its example');
assert.equal(a1.word.src.store, 'studio');
assert.equal(a2.ex.state, 'unconfirmed');                     // duplicated reading not normal
assert.equal(a3.word.state, 'unconfirmed'); assert.equal(a3.ex, null);
// once the recording also exists in the Lab, the Lab copy is referenced (one stored file, inside the backup scope)
rows = studioRows(blocks, { src1: { ...src, labRef: { videoId: 'vk' } } }, { isHead: isVocabHead });
assert.equal(vocabItems(rows, { from: 'studio', materialId: 'setK' })[0].word.src.store, 'vblobs');

// ---------- Lab material from that set (cues with roles, a joined material maps back to its part) ----------
await db.put('videos', { id: 'vk', name: '金フレ Unit 1', lang: 'en', from: { material: 'setK', media: 'src1' }, folder: '金フレ' });
await db.put('vblobs', { id: 'vk', blob: src.blob, size: src.blob.size });
const cues = [
  { id: 'c1', videoId: 'vk', en: 'allocate', start: 1, end: 1.6, itemId: 'w1', studySet: 'w1', role: 'word', studioOrder: 0 },
  { id: 'c2', videoId: 'vk', en: 'We allocate funds to each team.', start: 2, end: 4, segments: [{ start: 2, end: 4 }, { start: 4.6, end: 6.6 }], itemId: 'e1', studySet: 'w1', role: 'example', studioOrder: 1 },
  { id: 'c3', videoId: 'vk', en: 'compromise', start: 7, end: 7.7, itemId: 'w2', studySet: 'w2', role: 'word', studioOrder: 2 },
  { id: 'c4', videoId: 'vk', en: 'They reached a compromise.', start: 8, end: 9.6, segments: [{ start: 8, end: 9.6 }, { start: 10, end: 13.5 }], itemId: 'e2', studySet: 'w2', role: 'example', studioOrder: 3 },
];
await db.putMany('cues', cues);
const studioMap = new Map(blocks.map(b => [b.id, b]));
const labItems = vocabItems(labRows({ id: 'vk', name: 'x' }, cues, { studio: studioMap, jaOf: c => ({ c1: '割り当てる', c2: '各チームに資金を割り当てる。', c3: '妥協する', c4: '' })[c.id] }), { from: 'lab', materialId: 'vk' });
assert.deepEqual(labItems.map(i => [i.head, i.word.src.key, i.word.state, i.ex.state]), [['allocate', 'vk', 'confirmed', 'confirmed'], ['compromise', 'vk', 'confirmed', 'unconfirmed']]);
assert.equal(labItems[0].word.origin.cueId, 'c1');
// without the Studio set, Lab alone does not confirm a time it cannot check
assert.equal(vocabItems(labRows({ id: 'vk' }, cues), { from: 'lab', materialId: 'vk' })[0].word.state, 'unconfirmed');
const multi = labRows({ id: 'P', kind: 'multi', parts: [{ videoId: 'vk', offset: 100 }] }, [{ ...cues[0], start: 101, end: 101.6, part: 'vk' }], { parts: new Map([['vk', { id: 'vk' }]]) });
assert.deepEqual([multi[0].segments[0].key, multi[0].segments[0].start, multi[0].segments[0].end], ['vk', 1, 1.6]);

// ---------- registration plan: existing entries keep their data, duplicates are not created ----------
const old = newWord({ headword: 'allocate', senses: [newSense({ pos: 'verb', meanings: ['割り当てる'], examples: [{ en: 'We allocate funds to each team.', ja: '元の訳' }] })], tags: ['自分の'] });
const other = newWord({ headword: 'compromise', senses: [newSense({ pos: 'noun', meanings: ['（名誉などを）損なう'], examples: [{ en: 'Do not compromise safety.', ja: '' }] })] });
await db.putMany('words', [old, other]);
const blobsBefore = (await db.keys('vblobs')).length;
let plan = planAudioWords(labItems, await db.all('words'), { tags: ['金フレ'] });
assert.equal(plan.update.length, 1, 'allocate: audio added to the existing entry');
assert.equal(plan.add.length, 1, 'compromise with another meaning and example: a separate entry');
assert.equal(plan.add[0].word.headword, 'compromise');
assert.equal(plan.add[0].word.audio.example.state, 'unconfirmed', 'kept, but marked unconfirmed');
assert(refBytes(plan) < 4000);
await applyAudioWords(plan);
let words = await db.all('words');
const al = words.find(w => w.id === old.id);
assert.deepEqual([al.senses[0].pos, al.senses[0].meanings, al.senses[0].examples[0].ja, al.tags], ['verb', ['割り当てる'], '元の訳', ['自分の']], 'existing data untouched');
assert.equal(wordAudio(al, 'word').start, 1);
assert.equal(wordAudio(al, 'example').end, 4);
const cp = words.find(w => w.headword === 'compromise' && w.id !== other.id);
assert.equal(wordAudio(cp, 'example'), null, 'an unconfirmed example is not played');
assert.equal(wordAudio(cp, 'word').state, 'confirmed');
assert.equal(words.find(w => w.id === other.id).audio, undefined, 'the other meaning is not touched');
// second run: nothing new
plan = planAudioWords(labItems, await db.all('words'));
assert.deepEqual([plan.add.length, plan.update.length], [0, 0]);
// "audio only" mode never adds entries
const fresh = planAudioWords([{ ...labItems[0], head: 'unknownword', example: '' }], await db.all('words'), { mode: 'audio' });
assert.equal(fresh.add.length, 0);
// a confirmed sound later replaces an unconfirmed one without the replace option
const fixed = { ...labItems[1], ex: { ...labItems[1].ex, state: 'confirmed' } };
plan = planAudioWords([fixed], await db.all('words'));
assert.equal(plan.update.length, 1); await applyAudioWords(plan);
assert.equal(wordAudio((await db.all('words')).find(w => w.id === cp.id), 'example').state, 'confirmed');
assert.equal((await db.keys('vblobs')).length, blobsBefore, 'no recording was copied');
assert(!JSON.stringify(await db.all('words')).includes('"blob"'));

// ---------- restart: references are kept ----------
await closeDB();
words = await db.all('words');
assert.equal(wordAudio(words.find(w => w.id === old.id), 'word').src.key, 'vk');

// ---------- the player: a fast second request wins, the range end and the neighbour limit hold ----------
const ref1 = wordAudio(words.find(w => w.id === old.id), 'word');                     // 1.0-1.6, limit max 2.0
const ref2 = wordAudio(words.find(w => w.id === old.id), 'example');                  // 2.0-4.0
played.length = 0;
const p1 = wa.playRef(ref1), p2 = wa.playRef(ref2);                                    // the user swiped at once
assert.deepEqual(await Promise.all([p1, p2]), [false, true]);
assert.equal(played.length, 1, 'the first request never starts');
assert(Math.abs(played[0].at - (2 - 0.06)) < 1e-9);
wa.stop();
played.length = 0;
let ended = false;
assert(await wa.playRef({ ...ref1, limit: { min: 0.98, max: 1.65 } }, { onEnd: () => { ended = true; } }));
assert(Math.abs(played[0].at - 0.98) < 1e-9, 'the padding before the word stays after the previous line');
await wait(900);
assert(ended, 'stops at the end of the range');
// word then example, and a missing recording falls back safely
played.length = 0;
assert(await wa.playRefs([ref1, ref2]));
assert.equal(played.length, 2);
assert.equal(await wa.playRef({ ...ref1, src: { store: 'vblobs', key: 'gone' } }), false);
assert.equal(await refBlob({ store: 'vblobs', key: 'gone' }), null);

// ---------- deleting the material keeps the recording that the word book uses ----------
const removed = await releaseVideoMedia(['vk']);
assert.deepEqual(removed, [], 'vk is used by words');
await db.tx(['videos', 'cues'], 'readwrite', t => { t.objectStore('videos').delete('vk'); for (const c of cues) t.objectStore('cues').delete(c.id); });
let un = await unusedRecordings();
assert.deepEqual([un.kept, un.unused], [['vk'], []]);
assert(await refBlob({ store: 'vblobs', key: 'vk' }), 'still playable after the material was deleted');
// an unrelated, unused recording is listed for clean-up; deleting one word keeps the sound for the others
await db.put('vblobs', { id: 'old', blob: new Blob(['x']) });
un = await unusedRecordings();
assert.deepEqual(un.unused, ['old']);
await db.delete('words', cp.id);
assert.equal((await unusedRecordings()).kept[0], 'vk', 'allocate still uses it');
assert.equal((await referencedMedia()).vblobs.get('vk').size, 1);

// ---------- backup / restore ----------
const backup = JSON.parse(JSON.stringify(await buildBackup()));
assert(!backup.data.vblobs, 'recordings are not in the JSON');
assert(backup.data.words.some(w => w.audio?.word?.src?.key === 'vk'));
await db.clear('words');
await restoreBackup(backup);
const back = (await db.all('words')).find(w => w.id === old.id);
assert(await refBlob(wordAudio(back, 'word').src), 'restored references find the kept recording');

// ---------- Studio set deletion / clean-up keeps a recording a word uses ----------
const studioWord = newWord({ headword: 'x', senses: [newSense({ meanings: ['x'] })] });
studioWord.audio = { word: refs.makeRef({ store: 'studio', key: 'src1', start: 1, end: 1.6, origin: { from: 'studio', materialId: 'setK', text: 'x' }, state: 'confirmed' }) };
await db.put('words', studioWord);
assert((await referencedMedia()).studio.has('src1'));
console.log('word-audio-refs: 金フレ word/example mapping, one reading of repeats, existing entries kept, no duplicates, restart, player overlap/boundary, deletion protection, backup/restore, no copied recordings pass');
