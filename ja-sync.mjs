import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, liveBlocks, newBlock, undo, redo } = await import('../studio-db.js');
const { studioJaView, confirmStudioJa, studioJaRows, studioJaEditBlocks, studioHandGroup, planStudioJa } = await import('../studio-ja.js');
const { readVideoJa, videoJaView, saveVideoJa, cueStamps, studioJaPatch, labJaRows, labJaChanges, applyJaChanges } = await import('../video-ja.js');
const { compareStudioLab, studioToLabChanges, labToStudioBlocks, labAgreedChanges } = await import('../ja-sync.js');
const { jaModel, dissolve, splitRow, moveText, jaChanges } = await import('../ja-position.js');

// ---- Studio set ----
const SET = 'set1';
const texts = ['First line.', 'Second line.', 'Third part one', 'and part two.', 'Fifth line.', 'Sixth line.'];
const blocks0 = texts.map((text, i) => newBlock(SET, { id: 'b' + (i + 1), text, segments: [{ sourceId: 's', start: i, end: i + 1 }] }));
let set = { id: SET, title: 'Studio material', order: blocks0.map(b => b.id), undo: [], redo: [], updatedAt: 1 };
await sdb.put('sets', set);
const stamp = t => { let v = 2166136261; for (let i = 0; i < t.length; i++) v = Math.imul(v ^ t.charCodeAt(i), 16777619); return v >>> 0; };
const initial = blocks0.map(b => ({ ...b }));
Object.assign(initial[0], { ja: '一行目。', jaOverride: true });
Object.assign(initial[1], { ja: '二行目。', jaOverride: true });
initial[2].jaImport = { owner: 'b3', members: [{ id: 'b3', stamp: stamp(texts[2]) }, { id: 'b4', stamp: stamp(texts[3]) }], texts: ['三つ目の前半、そして後半。'] };
initial[3].jaImport = { owner: 'b3' };
Object.assign(initial[4], { ja: '五行目。', jaOverride: true });
await commit(set, '作成', { blocks: initial });
const studio = async () => { set = await sdb.get('sets', SET); return liveBlocks(set); };
const sv = async () => { const b = await studio(); const v = studioJaView(b); return b.map(x => v.value(x)); };
assert.deepEqual(await sv(), ['一行目。', '二行目。', '三つ目の前半、そして後半。', '三つ目の前半、そして後半。', '五行目。', '']);
const audioBefore = JSON.stringify((await studio()).map(b => [b.id, b.text, b.segments]));

// ---- Lab material made from it (same transfer as importMaterial) ----
const V = 'v1';
const cues = texts.map((en, i) => ({ id: 'c' + (i + 1), videoId: V, en, start: i, end: i + 1, itemId: 'b' + (i + 1), studioOrder: i }));
await db.put('videos', { id: V, name: 'Lab', from: { material: SET } });
await db.putMany('cues', cues);
await saveVideoJa(V, studioJaPatch(cues, studioJaView(await studio()).spans), cueStamps(cues), { fromStudio: true, replaceStudio: true });
const lab = async () => ({ cues, records: await readVideoJa(V) });
const lv = async () => { const { records } = await lab(); const w = videoJaView(cues, records); return cues.map(c => w.get(c)); };
assert.deepEqual(await lv(), await sv());
const status = async () => { const { records } = await lab(); return Object.fromEntries(compareStudioLab(await studio(), cues, records).map(u => [u.ids.join('+'), u.status])); };
assert.deepEqual(await status(), { b1: 'same', b2: 'same', 'b3+b4': 'same', b5: 'same', b6: 'same' });

// ---- edits on each side ----
let b = await studio();
await commit(set, '和訳を確定', { blocks: [confirmStudioJa(b[0], '一行目（スタジオ）。'), confirmStudioJa(b[4], '五（スタジオ）。')] });
const labEdit = async (fn) => {
  const { records } = await lab(), { rows, groups } = labJaRows(cues, records), model = jaModel(rows, groups);
  const st = fn(model, model.initial);
  await applyJaChanges(V, labJaChanges(rows, groups, jaChanges(model, st)), cueStamps(cues));
};
await labEdit((m, s) => { const o = s.own.slice(); o[1] = '二行目（Lab）。'; o[4] = '五（Lab）。'; return { ...s, own: o }; });
assert.deepEqual(await status(), { b1: 'toLab', b2: 'toStudio', 'b3+b4': 'same', b5: 'conflict', b6: 'same' });

// ---- Studio -> Lab (only the chosen unit; conflict untouched) ----
let units = compareStudioLab(await studio(), cues, (await lab()).records);
let plan = studioToLabChanges(await studio(), cues, (await lab()).records, units.filter(u => u.ids[0] === 'b1'));
await applyJaChanges(V, plan.changes, plan.expected, { mode: 'studio', base: plan.base, label: 'スタジオの訳を反映' });
assert.equal((await lv())[0], '一行目（スタジオ）。');
assert.equal((await lv())[4], '五（Lab）。', 'conflict not overwritten');
assert.equal((await status()).b1, 'same');

// ---- Lab -> Studio: one Studio operation, undoable with ↶ (then Lab records the agreed text, as the dialog does) ----
const toStudio = async (out, done) => {
  await commit(set, 'Labの訳を反映', { blocks: out.blocks });
  const { records } = await lab();
  await applyJaChanges(V, labAgreedChanges(cues, records, done), cueStamps(cues), { mode: 'base', history: false, base: out.base });
};
units = compareStudioLab(await studio(), cues, (await lab()).records);
let out = labToStudioBlocks(await studio(), cues, (await lab()).records, units.filter(u => u.ids[0] === 'b2'));
await toStudio(out, units.filter(u => out.blocks.some(x => u.ids.includes(x.id))));
assert.equal((await sv())[1], '二行目（Lab）。');
assert.equal((await status()).b2, 'same');
await undo(await sdb.get('sets', SET));
assert.equal((await sv())[1], '二行目。');
await redo(await sdb.get('sets', SET));
assert.equal((await sv())[1], '二行目（Lab）。');
assert.equal((await status()).b5, 'conflict');

// ---- shared translation: split in Lab, reflected to Studio as two rows; Studio group not duplicated ----
await labEdit((m, s) => { const key = [...m.groups.keys()][0]; const d = dissolve(m, s, key).state; return splitRow(m, d, 2, '三つ目の前半、'.length, 1).state; });
assert.equal((await status())['b3+b4'], 'toStudio');
units = compareStudioLab(await studio(), cues, (await lab()).records);
out = labToStudioBlocks(await studio(), cues, (await lab()).records, units.filter(u => u.ids.includes('b3')));
await toStudio(out, units.filter(u => out.blocks.some(x => u.ids.includes(x.id))));
assert.deepEqual((await sv()).slice(2, 4), ['三つ目の前半、', 'そして後半。']);
// and back: a Lab shared translation goes to Studio as ONE hand group (protected from re-matching)
await labEdit((m, s) => s);  // no-op
const g = (await lab()).records;
await applyJaChanges(V, [
  { cueId: 'c3', before: labJaRows(cues, g).rows[2].entries, after: [{ ja: '共有（Lab）', cueIds: ['c3', 'c4'] }] },
  { cueId: 'c4', before: labJaRows(cues, g).rows[3].entries, after: [{ ja: '共有（Lab）', cueIds: ['c3', 'c4'] }] }], cueStamps(cues));
units = compareStudioLab(await studio(), cues, (await lab()).records);
const shared = units.find(u => u.ids.includes('b3'));
assert.equal(shared.status, 'toStudio');
out = labToStudioBlocks(await studio(), cues, (await lab()).records, [shared]);
await toStudio(out, units.filter(u => out.blocks.some(x => u.ids.includes(x.id))));
b = await studio();
assert.deepEqual((await sv()).slice(2, 4), ['共有（Lab）', '共有（Lab）']);
assert.equal(b[2].jaImport.manual, true);
assert.equal(studioJaView(b).spans.filter(s => s.ids.includes('b3')).length, 1, 'one span, not two copies');
const rematch = planStudioJa(set, b, [{ index: 0, name: 'x.json', data: { items: texts.map(en => ({ en, ja: '再照合 ' + en })) } }]);
assert(!rematch.changes.some(row => ['b1', 'b2', 'b3', 'b4', 'b5'].includes(row.id)), 'hand rows and hand groups are not re-matched');
assert(rematch.changes.some(row => row.id === 'b6'), 'rows without a translation are still matched');
const missingOnly = planStudioJa(set, b, [{ index: 0, name: 'x.json', data: { items: texts.map(en => ({ en, ja: 'x' })) } }], { missingOnly: true });
assert.deepEqual(missingOnly.changes.map(r => r.id), ['b6']);

// ---- Studio position editor: release the hand group, split it, one undo step ----
b = await studio();
const { rows, groups } = studioJaRows(b);
assert.equal(groups.size, 1);
const m = jaModel(rows, groups);
let st = dissolve(m, m.initial, 'b3').state;
st = splitRow(m, st, 2, 2, 1).state;
st = moveText(m, st, 0, 1, 0, 3).state;
const edited = studioJaEditBlocks(b, jaChanges(m, st));
await commit(set, '訳の位置調整', { blocks: edited });
assert.deepEqual((await sv()).slice(0, 4), ['（スタジオ）。', '一行目二行目（Lab）。', '共有', '（Lab）']);
await undo(await sdb.get('sets', SET));
assert.deepEqual((await sv()).slice(0, 4), ['一行目（スタジオ）。', '二行目（Lab）。', '共有（Lab）', '共有（Lab）']);
assert.equal(JSON.stringify((await studio()).map(x => [x.id, x.text, x.segments])), audioBefore, 'Studio English / audio ranges unchanged');
// a stale Studio guard refuses the save
const guard = { folder: set.folder, updatedAt: set.updatedAt - 1, order: set.order, undo: set.undo, redo: set.redo };
await assert.rejects(commit(await sdb.get('sets', SET), 'x', { blocks: edited, guardedSet: guard }));
console.log('ja-sync: compare (same / toLab / toStudio / conflict), selective reflection both ways, shared groups, undo, re-match protection pass');
