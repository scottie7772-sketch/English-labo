import assert from 'node:assert/strict';
import { sdb } from '../studio-db.js';
import {
  studioFolders, folderMembers, createStudioFolder, renameStudioFolder, moveStudioSets,
  saveStudioFolderOrder, getFolderJa, saveFolderJa,
} from '../studio-folders.js';
import { planStudioJa, studioJaView } from '../studio-ja.js';

const sets = [
  { id:'a', title:'Part 1', folder:'MA', sourceId:'one', order:['a1'], undo:[8], updatedAt:2 },
  { id:'b', title:'Part 2', folder:'MA', sourceId:'two', order:['b1'], undo:[9], updatedAt:1 },
  { id:'c', title:'Part 3', sourceId:'three', order:['c1'], redo:[5], updatedAt:3 },
];
const state = { sets: new Map(sets.map(set => [set.id, structuredClone(set)])), meta: new Map() };
sdb.get = async (store, key) => structuredClone(state[store].get(key));
sdb.tx = async (stores, mode, task) => {
  let stopped = false;
  const copies = Object.fromEntries(stores.map(store => [store, structuredClone(state[store])]));
  const request = result => {
    const response = { result: structuredClone(result) };
    queueMicrotask(() => { if (!stopped) response.onsuccess?.(); });
    return response;
  };
  task({ abort() { stopped = true; }, objectStore(store) {
    assert.ok(copies[store], 'transaction only uses folder and set metadata');
    const map = copies[store];
    return { get: key => request(map.get(key)), getAll: () => request([...map.values()]),
      put: row => map.set(row.id ?? row.key, structuredClone(row)) };
  } });
  await new Promise(resolve => setImmediate(resolve));
  if (stopped) throw Error('aborted');
  Object.assign(state, copies);
};

const [ma] = await studioFolders([...state.sets.values()]);
assert.deepEqual(ma.order, ['a','b']);
const empty = await createStudioFolder('Empty');
assert.equal((await studioFolders([])).length, 2);
assert.deepEqual(folderMembers([...state.sets.values()], empty), []);
await moveStudioSets(['a','b'], empty.id);
assert.deepEqual(await sdb.get('sets','a'), { ...sets[0], folder:'Empty' });
assert.deepEqual(await sdb.get('sets','b'), { ...sets[1], folder:'Empty' });
await moveStudioSets(['c'], empty.id);
await saveStudioFolderOrder(empty.id, ['c','b','a']);
await assert.rejects(() => saveStudioFolderOrder(empty.id, ['a','b','b']), /変更/);

const section = (chapter, name, en, ja) => ({ name, data:{ chapter, items:[{en,ja}] } });
const c2 = section(2, 'MA/CHAPTER_02.json', 'The first team arrived at the station.', '最初の一団が駅に着きました。');
const before = section('BEFORE', 'BEFORE_AFTER_CHAPTER_02.json', 'A long time ago they sailed together.', '昔、一緒に船に乗りました。');
const c3 = section(3, 'CHAPTER_03.json', 'The door had already been closed.', 'その扉はすでに閉まっていました。');
await saveFolderJa(empty.id, [c3,c2,before], false);
await saveFolderJa(empty.id, [{...c2,name:'chapter_02.json',data:{...c2.data,items:[{...c2.data.items[0],ja:'最初の一団が駅に到着しました。'}]}}], true);
await renameStudioFolder(empty.id, 'Master & Apprentice');
await assert.rejects(() => renameStudioFolder(empty.id, 'MA'), /同じ名前/);
const renamed = (await studioFolders([])).find(folder => folder.id === empty.id);
assert.deepEqual(folderMembers([...state.sets.values()], renamed).map(x=>x.id), ['c','b','a']);
const corpus = (await getFolderJa(renamed.id)).sections;
assert.deepEqual(corpus.map(x => x.data.chapter), [2,'BEFORE',3]);
assert.equal(corpus[0].data.items[0].ja, '最初の一団が駅に到着しました。');
assert.equal(await getFolderJa(ma.id), undefined);

const set = await sdb.get('sets','c');
const ordinary = (id, text) => ({ id, text, aligned:true, sync:'manual', boundary:{review:true}, segments:[{sourceId:'three', start:2, end:4}] });
const rows = [
  { ...ordinary('c1', c2.data.items[0].en), ja:'手動の訳', jaOverride:true },
  ordinary('b1', before.data.items[0].en),
  ordinary('b2', c3.data.items[0].en),
  { ...ordinary('q', 'Some other sentence.'), jaReview:true },
];
const plan = planStudioJa(set, rows, corpus, { missingOnly: true });
assert.deepEqual(plan.changes.map(row=>row.id), ['b1','b2']);
assert.deepEqual(plan.changes[0].segments, rows[1].segments);
assert.deepEqual(plan.changes[0].boundary, rows[1].boundary);
assert.equal(plan.changes[0].sync, 'manual');
assert.deepEqual(plan.summary.review.map(row => row.id), ['q']);
assert.equal(studioJaView(plan.changes).value(plan.changes[1]), c3.data.items[0].ja);
await moveStudioSets(['c'], null);
assert.deepEqual(await sdb.get('sets','c'), sets[2]);
assert.deepEqual((await getFolderJa(renamed.id)).sections, corpus);
console.log('Studio folders: old labels, empty folders, ID-preserving moves, ordering, rename, archived chapters, reusable corpus and missing-only protection');
