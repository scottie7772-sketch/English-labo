import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db, closeDB } = await import('../db.js');
const { readVideoJa, videoJaView, labJaRows, labJaChanges, applyJaChanges, readJaHistory, revertJaHistory, saveVideoJa,
  cueStamps, labManualCueIds, studioJaPatch } = await import('../video-ja.js');
const { jaModel, moveText, dissolve, splitRow, rangeMove, jaChanges } = await import('../ja-position.js');

const V = 'v_lab';
const cues = [
  { id: 'c1', videoId: V, en: 'First line.', start: 0, end: 1, itemId: 'b1' },
  { id: 'c2', videoId: V, en: 'Second line.', start: 1, end: 2, itemId: 'b2' },
  { id: 'c3', videoId: V, en: 'Third part one', start: 2, end: 3, itemId: 'b3' },
  { id: 'c4', videoId: V, en: 'and part two.', start: 3, end: 4, itemId: 'b4' },
  { id: 'c5', videoId: V, en: 'Fifth line.', start: 4, end: 5, itemId: 'b5' },
  { id: 'c6', videoId: V, en: 'Sixth line.', start: 5, end: 6, itemId: 'b6' },
];
const media = new Blob(['audio bytes']);
await db.put('videos', { id: V, name: 'Lab material', from: { material: 'set1' } });
await db.put('vblobs', { id: V, blob: media });
await db.putMany('cues', cues);
// Studio transfer: c3+c4 share one translation; c2 carries c1's translation (off by one).
await saveVideoJa(V, studioJaPatch(cues, [
  { ids: ['b1'], texts: ['一行目。'] }, { ids: ['b2'], texts: ['二行目。'] },
  { ids: ['b3', 'b4'], texts: ['三つ目の前半、そして後半。'] }, { ids: ['b5'], texts: ['六行目。'] }, { ids: ['b6'], texts: [] },
]), cueStamps(cues), { fromStudio: true, replaceStudio: true });
const view = async () => videoJaView(cues, await readVideoJa(V));
const texts = async () => { const w = await view(); return cues.map(c => w.get(c)); };
const snapshot = async () => JSON.stringify({ cues: await db.byIndex('cues', 'videoId', V), video: await db.get('videos', V) });
const untouched = await snapshot();
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、そして後半。', '三つ目の前半、そして後半。', '六行目。', '']);

// ---- editor: release the shared translation, split it between its two subtitles, move c5 down by range ----
const open = async () => {
  const records = await readVideoJa(V), { rows, groups } = labJaRows(cues, records);
  return { rows, groups, model: jaModel(rows, groups), expected: cueStamps(cues) };
};
let ed = await open();
assert.equal(ed.groups.size, 1);
let st = ed.model.initial;
const key = [...ed.groups.keys()][0];
st = dissolve(ed.model, st, key).state;
st = splitRow(ed.model, st, 2, '三つ目の前半、'.length, 1).state;
const pv = rangeMove(ed.model, st, 4, 4, 1);
assert(!pv.needsChoice);                                    // c6 is empty: plain move
st = rangeMove(ed.model, st, 4, 4, 1).state;
const changes = labJaChanges(ed.rows, ed.groups, jaChanges(ed.model, st));
assert.deepEqual(changes.map(c => c.cueId), ['c3', 'c4', 'c5', 'c6']);
const saved = await applyJaChanges(V, changes, ed.expected, { label: 'test edit' });
assert(saved.history);
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、', 'そして後半。', '', '六行目。']);
// no duplicated or orphan shared records: the group of c3+c4 is gone, every text row is used once
const recs = (await readVideoJa(V)).filter(r => !r.kind);
assert(!recs.some(r => r.cueIds?.length > 1));
assert.equal(new Set(recs.filter(r => typeof r.ja === 'string').map(r => r.ja)).size, recs.filter(r => typeof r.ja === 'string').length);
assert.equal(await snapshot(), untouched, 'English, timings and cue ids must not change');
assert.equal((await db.get('vblobs', V)).blob.size, media.size);
assert.deepEqual([...labManualCueIds(cues, await readVideoJa(V))].sort(), ['c3', 'c4', 'c5', 'c6']);

// ---- restart: everything is still there, and the saved change can be undone after the restart ----
await closeDB();
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、', 'そして後半。', '', '六行目。']);
let history = await readJaHistory(V);
assert.equal(history.length, 1);
assert(!JSON.stringify(history).includes('start') && !JSON.stringify(history).includes('blob'), 'history holds text only');
await revertJaHistory(V, history[0].id);
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、そして後半。', '三つ目の前半、そして後半。', '六行目。', '']);
assert((await readVideoJa(V)).some(r => r.cueIds?.length === 2), 'the shared translation is shared again (not copied)');
await assert.rejects(revertJaHistory(V, history[0].id), /すでに/);
await revertJaHistory(V, history[0].id, { redo: true });
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、', 'そして後半。', '', '六行目。']);

// ---- a later edit of the same subtitle blocks undo of the earlier one ----
ed = await open();
st = moveText(ed.model, ed.model.initial, 0, 1).state;      // c1's translation into c2
await applyJaChanges(V, labJaChanges(ed.rows, ed.groups, jaChanges(ed.model, st)), ed.expected, { label: 'second' });
history = await readJaHistory(V);
assert.equal(history[0].label, 'second');
ed = await open();
st = moveText(ed.model, ed.model.initial, 1, -1, 0, 3).state;
await applyJaChanges(V, labJaChanges(ed.rows, ed.groups, jaChanges(ed.model, st)), ed.expected, { label: 'third' });
await assert.rejects(revertJaHistory(V, (await readJaHistory(V)).find(h => h.label === 'second').id), /その後/);
await revertJaHistory(V, (await readJaHistory(V)).find(h => h.label === 'third').id);
await revertJaHistory(V, (await readJaHistory(V)).find(h => h.label === 'second').id);
assert.deepEqual(await texts(), ['一行目。', '二行目。', '三つ目の前半、', 'そして後半。', '', '六行目。']);

// ---- stale editor: English edited after the editor opened -> nothing saved ----
ed = await open();
st = moveText(ed.model, ed.model.initial, 0, 1).state;
const stale = labJaChanges(ed.rows, ed.groups, jaChanges(ed.model, st));
const before = JSON.stringify(await readVideoJa(V));
await db.put('cues', { ...cues[1], en: 'Second line, edited.' });
await assert.rejects(applyJaChanges(V, stale, ed.expected), /中止/);
assert.equal(JSON.stringify(await readVideoJa(V)), before);
await db.put('cues', cues[1]);
// translation changed elsewhere (e.g. a Studio reflection) after the editor opened -> nothing saved
ed = await open();
st = moveText(ed.model, ed.model.initial, 4, 1).state || moveText(ed.model, ed.model.initial, 5, -1).state;
const other = labJaChanges(ed.rows, ed.groups, jaChanges(ed.model, st));
await saveVideoJa(V, new Map([['c6', ['別の画面での訳']]]), cueStamps(cues));
const mid = JSON.stringify(await readVideoJa(V));
await assert.rejects(applyJaChanges(V, other, ed.expected), /中止/);
assert.equal(JSON.stringify(await readVideoJa(V)), mid);
// a failing write inside the transaction leaves no partial result
const pre = JSON.stringify(await readVideoJa(V));
await assert.rejects(db.tx(['videoJa'], 'readwrite', t => { t.objectStore('videoJa').put({ id: 'x', materialId: V, ja: 'partial' }); throw new Error('boom'); }));
assert.equal(JSON.stringify(await readVideoJa(V)), pre);

// ---- matching / re-import never overwrite hand corrections; "missing only" is different from re-match ----
const reimport = new Map(cues.map(c => [c.id, [`再取込 ${c.id}`]]));
const manual = labManualCueIds(cues, await readVideoJa(V));
let r = await saveVideoJa(V, reimport, cueStamps(cues), { protectManual: true, missingOnly: true });
let now = await texts();
assert(manual.has('c3') && now[2] === '三つ目の前半、', 'hand correction kept');
assert.equal(now[0], '一行目。', 'missing-only keeps existing translations');
r = await saveVideoJa(V, reimport, cueStamps(cues), { protectManual: true });
now = await texts();
assert.equal(now[0], '再取込 c1', 'explicit re-match replaces non-manual translations');
assert.equal(now[2], '三つ目の前半、', 'explicit re-match still keeps hand corrections');
assert(r.skipped.includes('c3'));
// Studio re-transfer (fromStudio) also leaves hand corrections alone, including a hand removal
await saveVideoJa(V, studioJaPatch(cues, [{ ids: ['b5'], texts: ['スタジオ'] }, { ids: ['b3'], texts: ['スタジオ3'] }]), cueStamps(cues), { fromStudio: true });
now = await texts();
assert.equal(now[2], '三つ目の前半、');
assert.equal(now[4], '', 'a hand removal is not brought back by the Studio transfer');
assert.equal(await snapshot(), untouched);
console.log('ja-position (Lab): shared release+split, range move, atomic save with history, undo/redo after restart, stale abort, manual protection pass');
