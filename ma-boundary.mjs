import assert from 'node:assert/strict';
import { maSeams, maWindow, inspectMaSeam, proposeMaSeam, maBoundaryUpdates, wavRangeReader } from '../studio-ma-boundary.js';
import { speechFirstPlaybackRange } from '../studio-playback-boundary.js';

const makeRow = (id, text, start, end, sync = 'auto') => ({
  id, text, ja: '日本語', holes: [], aligned: true, sync, segments: [{ sourceId: 'media', start, end }],
});
const left = (end, sync) => makeRow('left', 'He quietly closed the wooden door.', .2, end, sync);
const right = (start, sync) => makeRow('right', 'She took a step backwards.', start, 5, sync);
const middle = (a, b) => maSeams([a, b]).find(seam => seam.left && seam.right);
function pcm(spans, duration = 6) {
  const out = new Float32Array(duration * 16000);
  for (const [a, b] of spans) for (let i = Math.round(a * 16000); i < b * 16000; i++) out[i] = .08 * Math.sin(i * .11);
  return out;
}
const sound = pcm([[.3, 2.25], [2.7, 4.7]]);
const heard = [
  ...['closed','the','wooden','door'].map((text, i) => ({text, start: 1.26 + i * .25, end: 1.49 + i * .25})),
  ...['She','took','a','step','backwards'].map((text, i) => ({text, start: 2.7 + i * .22, end: 2.88 + i * .22})),
];

assert.equal(inspectMaSeam(middle(left(2.32), right(2.64)), sound), '', 'normal pause');
const cutHead = middle(left(2.32), right(2.96));
assert.match(inspectMaSeam(cutHead, sound), /空白|語頭/);
assert.deepEqual(proposeMaSeam(cutHead, heard, 6).changes.map(c => [c.side, c.time]), [['start',2.635]]);
const cutTail = middle(left(2), right(2.64));
assert.match(inspectMaSeam(cutTail, sound), /空白|語尾/);
assert.deepEqual(proposeMaSeam(cutTail, heard, 6).changes.map(c => [c.side, c.time]), [['end',2.295]]);
const overlap = middle(left(2.95), right(2.48));
assert.match(inspectMaSeam(overlap, sound), /重複/);
const fixed = proposeMaSeam(overlap, heard, 6);
assert.equal(fixed.confidence, 'high');
const applied = maBoundaryUpdates([overlap.left, overlap.right], [fixed]);
assert.equal(applied.length, 2);
assert(applied[0].segments[0].end < applied[1].segments[0].start);
assert.deepEqual(applied.map(r => [r.text, r.ja, r.sync]), [[overlap.left.text,'日本語','auto'],[overlap.right.text,'日本語','auto']]);
const correction = {...applied[0],structureAlign:{method:'speech-first'}};
const restored = speechFirstPlaybackRange(correction,correction.segments[0],applied,6);
assert.equal(restored.start.toFixed(2),'0.02');
assert.equal(restored.end.toFixed(3),'2.355');
assert.deepEqual(speechFirstPlaybackRange({...correction,maBoundaryChecked:true},correction.segments[0],applied,6),restored,
  'corrections saved by the earlier version regain normal playback padding');
assert.equal(speechFirstPlaybackRange({...correction,sync:'manual'},correction.segments[0],applied,6),null);
assert.equal(proposeMaSeam(overlap,heard,6,{start:1.24,end:5}).confidence,'review');
const connected = pcm([[.2,4.6]]);
assert.equal(inspectMaSeam(middle(left(2.5),right(2.5)), connected), '', 'natural continuous reading');
const continuousWords = heard.map((w,i) => i < 4 ? {...w, start:w.start+.46,end:w.end+.46} : w);
const continuousCorrection = proposeMaSeam(middle(left(2.9),right(2.55)),continuousWords,6);
const seamRows = maBoundaryUpdates([left(2.9),right(2.55)],[continuousCorrection]);
assert(seamRows[0].segments[0].end <= seamRows[1].segments[0].start);
const manual = middle(left(2.31,'manual'),right(2.96));
const manualProposal = proposeMaSeam(manual, heard, 6);
assert.deepEqual(manualProposal.changes.map(c=>c.row.id), ['right']);
assert.deepEqual(maBoundaryUpdates([manual.left,manual.right],[manualProposal]).map(r=>r.id),['right']);
assert(!middle(left(2.31,'manual'),right(2.96,'manual')));
const conflict = middle(left(2.76,'manual'),right(2.96));
assert.equal(proposeMaSeam(conflict,heard,6).confidence,'review');
assert.equal(proposeMaSeam(overlap, [], 6).confidence, 'review');
assert.equal(proposeMaSeam(overlap, [{text:'unrelated English audio',start:2,end:3}],6).confidence,'review');
assert.equal(maWindow(overlap,6,3.4).end, 6);
assert.equal(maWindow(middle(left(.5),right(3)),6,3.4),null);
const old = structuredClone(overlap.left);
assert.equal(old.segments[0].end,2.95,'original snapshot is untouched and can be restored by Studio Undo');

const bytes = new Uint8Array(44 + 32000 * 12);
const v = new DataView(bytes.buffer);
const ascii = (at,s) => [...s].forEach((ch,i)=>v.setUint8(at+i,ch.charCodeAt()));
ascii(0,'RIFF');v.setUint32(4,bytes.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');
v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
ascii(36,'data');v.setUint32(40,bytes.length-44,true);v.setInt16(44+32000*7,32000,true);
const read = await wavRangeReader(new Blob([bytes]));
const extract = read(7, 7.5);
assert.equal(extract.start,7);
assert.equal(extract.blob.size,16044);
assert.equal(new DataView(await extract.blob.slice(44,46).arrayBuffer()).getInt16(0,true),32000);
console.log('MA boundary regression passed: normal, onset, tail, overlap, connected speech, manual lock, mismatch, bounded WAV');

const { commit, undo, sdb } = await import('../studio-db.js');
const material = {id:'s',order:['left','right'],undo:[],redo:[],updatedAt:42};
const rows = [overlap.left,overlap.right].map(r => ({...r,setId:material.id,rev:1}));
const before = new Map(rows.map(r => [r.id,r]));
const snapshots = new Map(rows.map(r => [r.id+'@1',{...r,id:r.id+'@1',blockId:r.id}]));
const stores = {blocks:before,blockRevs:snapshots,sets:new Map([['s',structuredClone(material)]]),oplog:new Map()};
sdb.get = async (store,id) => structuredClone(stores[store].get(id));
sdb.tx = async (names,mode,execute) => {
  const queued = [];
  execute({ objectStore: name => ({
    put: row => stores[name].set(row.id,structuredClone(row)),
    add: row => { stores[name].set(1,structuredClone(row)); const req={result:1}; queued.push(req); return req; },
    get: id => { const req={result:structuredClone(stores[name].get(id))}; queued.push(req); return req; },
  }) });
  for (const request of queued) request.onsuccess?.();
};
await commit(material,'Boundary edit',{blocks:maBoundaryUpdates(rows,[fixed]),guardedSet:structuredClone(material)});
assert.equal(stores.blocks.get('left').segments[0].end,2.295);
await undo(material);
assert.deepEqual([...stores.blocks.values()],rows);
console.log('Studio commit and Undo restored the original timestamps and texts (in-memory database)');
