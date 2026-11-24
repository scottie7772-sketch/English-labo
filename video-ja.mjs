import assert from 'node:assert/strict';
import { db, DB_VERSION, STORES } from '../db.js';
import { parseJaPatch, planJaWrites, videoJaView, videoJaSource, compareVideoCues, cueStamps, saveVideoJa } from '../video-ja.js';

const materialId = 'v_ma';
const cues = [
  {id:'a',videoId:materialId,en:'One. ',start:1.1,end:2.2,dict:{best:1},timeEdited:true},
  {id:'b',videoId:materialId,en:'Two.',start:2.2,end:3.3},
  {id:'c',videoId:materialId,en:'Three.',start:3.3,end:4.4,ja:'旧訳'},
];
const text = JSON.stringify({materialId,translations:[
  {cueIds:['a','b'],ja:'共有の訳'},
  {cueIds:['a'],ja:'追加の訳'},
  {cueIds:['c'],ja:'共有の訳'},
]});
const patch = parseJaPatch(text, materialId);
assert.throws(() => parseJaPatch(text, 'v_other'), /教材ID/);
assert.throws(() => parseJaPatch(JSON.stringify({materialId,translations:[{cueIds:['a'],ja:'訳',en:'One.'}]}), materialId));
assert.deepEqual(videoJaSource(materialId,cues),{materialId,cues:cues.map((c,i)=>({cueId:c.id,en:c.en,order:i+1}))});
const sameTime = [{ ...cues[1], start: cues[0].start }, cues[0], {id:'legacy',en:'',ja:'旧訳',start:2.25}, cues[2]];
assert.deepEqual(videoJaSource(materialId,sameTime.sort(compareVideoCues)).cues.map(c => [c.cueId,c.order]),
  [['a',1],['b',2],['c',4]]);
assert(!Object.keys(videoJaSource(materialId,cues).cues[0]).includes('start'));
assert.throws(() => parseJaPatch(JSON.stringify({materialId,translations:[{cueIds:['a'],ja:'訳',order:1}]}), materialId));
assert.equal(videoJaView(cues,[]).get(cues[2]),'旧訳');
const stamps = cueStamps(cues);
const first = planJaWrites(materialId,cues,[],patch,stamps);
const updated = [...first.puts.values()];
assert.equal(updated.filter(r=>r.ja==='共有の訳').length,1);
assert(updated.every(r=>!('en' in r) && !('start' in r) && !('end' in r) && !('blob' in r)));
assert.deepEqual(cues.map(c=>videoJaView(cues,updated).get(c)),['共有の訳\n追加の訳','共有の訳','共有の訳']);
assert.equal(planJaWrites(materialId,cues,updated,patch,stamps).puts.size,0);
const timeOnly = [{...cues[0],start:1.2,end:2.15}, ...cues.slice(1)];
assert.equal(videoJaView(timeOnly,updated).get(timeOnly[0]),'共有の訳\n追加の訳');
const edited = [{...cues[0],en:'A different sentence.'}, ...cues.slice(1)];
const review = videoJaView(edited,updated);
assert.equal(review.get(edited[0]),'');
assert.equal(review.get(edited[1]),'');
assert.equal(review.get(edited[2]),'共有の訳');
assert(review.needsReview(edited[1]));
assert.deepEqual(videoJaView(cues.slice(1),updated).review,['a']);
const invalid = planJaWrites(materialId,edited,updated,patch,stamps);
assert.deepEqual(invalid.needsReview,['a','b']);
assert.equal(invalid.puts.size,0);
const delta = planJaWrites(materialId,cues,updated,new Map([['c',['更新訳']]]),stamps);
assert(delta.puts.size < updated.length);
const allCleared = planJaWrites(materialId,cues,updated,new Map(),new Map(),{clear:true});
assert.equal(allCleared.puts.size,1);
assert.equal(videoJaView(cues,[...allCleared.puts.values()]).get(cues[2]),'');
assert(allCleared.deletes.size >= 4);

const existing = structuredClone(cues);
const readOnly = {
  videos: [{id:materialId,lastTime:2.8}],
  cues: existing,
  vblobs: [{id:materialId,blob:new Blob(['media'])}],
  attempts: [{id:1,cueId:'a',correct:true}],
};
const stored = new Map();
const dbSnapshot = structuredClone(readOnly);
db.tx = async (stores, mode, run) => {
  assert.deepEqual(stores,['videos','cues','videoJa']);
  const req = result => {
    const request = {result};
    queueMicrotask(() => request.onsuccess());
    return request;
  };
  return run({ objectStore: name => {
    if (name === 'videoJa') return {
      index: () => ({getAll: id => req([...stored.values()].filter(r=>r.materialId===id))}),
      put: row => stored.set(row.id, structuredClone(row)), delete: id => stored.delete(id),
    };
    if (name === 'videos') return {get:id=>req(readOnly.videos.find(v=>v.id===id))};
    if (name === 'cues') return {index:()=>({getAll:id=>req(readOnly.cues.filter(c=>c.videoId===id))})};
    throw new Error('Unexpected store');
  } });
};
await saveVideoJa(materialId,patch,stamps);
assert.deepEqual(readOnly,dbSnapshot);
await saveVideoJa(materialId,new Map([['b',[]]]),stamps);
assert.deepEqual(readOnly,dbSnapshot);
assert.equal(videoJaView(cues,[...stored.values()]).get(cues[1]),'');
assert.equal(videoJaView(cues,[...stored.values()]).get(cues[0]),'共有の訳\n追加の訳');
assert.equal(DB_VERSION,3);
assert.deepEqual(STORES.videoJa.indexes,[['materialId','materialId']]);
console.log('Video Lab translation patch passes: per-material isolation, shared text, delta/clear, stale bindings, unchanged cues/media/history');
