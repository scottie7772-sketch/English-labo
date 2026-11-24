import assert from 'node:assert/strict';
globalThis.addEventListener = () => {};
globalThis.window = {};
globalThis.document = { addEventListener(){}, querySelector(){return {textContent:'',hidden:true};} };
const {importMaterial,videoBlob} = await import('../video.js');
const {db} = await import('../db.js');
const {cueStamps,saveVideoJa,videoJaView} = await import('../video-ja.js');
const names = ['videos','vblobs','cues','videoJa'];
const records = Object.fromEntries(names.map(name=>[name,new Map()]));
db.all = async store => [...records[store].values()].map(row=>structuredClone(row));
db.get = async (store,id) => structuredClone(records[store].get(id));
db.byIndex = async (store,key,id) => (await db.all(store)).filter(row=>row[key]===id);
db.put = async (store,row) => records[store].set(row.id,structuredClone(row));
db.tx = async (stores,mode,task) => {
  const requests = result => {
    const request = {result}; queueMicrotask(() => request.onsuccess?.()); return request;
  };
  return task({objectStore:name=>({
    put: row=>records[name].set(row.id,structuredClone(row)), delete: id=>records[name].delete(id),
    get: id=>requests(structuredClone(records[name].get(id))),
    index: key=>({getAll: id=>requests([...records[name].values()].filter(row=>row[key]===id).map(row=>structuredClone(row)))}),
  })});
};
const audio = new Blob([new Uint8Array(160)],{type:'audio/wav'});
const secondAudio = new Blob([new Uint8Array(80).fill(2)],{type:'audio/wav'});
const mat = {
  set:{folder:'MA / 章',materialType:'prose'},
  media:[{id:'audio1',name:'Original.wav',kind:'audio',mime:'audio/wav',size:160,duration:12,included:true}],
  items:[{id:'one',text:'Line one.',segments:[{media:'audio1',start:3,end:4}]},
    {id:'two',text:'Line two.',segments:[{media:'audio1',start:4,end:5}]}],
  jaSpans:[{ids:['one','two'],texts:['共通の日本語訳。']}],
};
const first = await importMaterial({materialId:'studio-a',title:'Material A',packId:'p'},mat,()=>audio,{askUpdate:false,direct:true});
const other = await importMaterial({materialId:'studio-b',title:'Material B',packId:'p'},mat,()=>audio,{askUpdate:false,direct:true});
assert.notEqual(first.id,other.id);
assert.equal((await db.get('videos',first.id)).folder,'MA / 章');
assert.equal(records.vblobs.size,1);
assert.equal((await videoBlob(other)).size,audio.size);
const current = await db.byIndex('cues','videoId',first.id);
assert.deepEqual(current.map(c=>[c.en,c.start,c.end]),[['Line one.',3,4],['Line two.',4,5]]);
const shared = await db.byIndex('videoJa','materialId',first.id);
assert.equal(shared.filter(r=>r.ja).length,1);
assert.equal(videoJaView(current,shared).get(current[1]),'共通の日本語訳。');
assert.equal((await importMaterial({materialId:'studio-a'},mat,()=>{throw Error('unexpected copy');},
  {askUpdate:false,direct:true,update:false})).skipped,true);
await saveVideoJa(first.id,new Map([[current[1].id,['ラボで修正']]]),cueStamps(current));
await db.put('cues',{...current[0],enEdited:true,en:'Edited in Lab.',timeEdited:true,start:2});
const updated = await importMaterial({materialId:'studio-a',title:'Material A',packId:'p2'},
  {...mat,jaSpans:[{ids:['one','two'],texts:['改訂された訳。']}]},()=>{throw Error('unexpected copy');},{askUpdate:false,direct:true});
assert.equal(updated.id,first.id);
const updatedCues = await db.byIndex('cues','videoId',first.id);
assert.equal(updatedCues[0].en,'Edited in Lab.');
assert.equal(updatedCues[0].start,2);
assert.equal(videoJaView(updatedCues,await db.byIndex('videoJa','materialId',first.id)).get(updatedCues[1]),'ラボで修正');
const multi = {...mat, media:[...mat.media,{id:'audio2',name:'Second.wav',kind:'audio',size:80,duration:10,included:true}],
  items:[mat.items[0],{...mat.items[1],segments:[{media:'audio2',start:1,end:2}]}]};
const m = await importMaterial({materialId:'studio-m',title:'Multiple sources',packId:'p'},multi,f=>f.id==='audio1'?audio:secondAudio,{askUpdate:false,direct:true});
assert.equal(m.kind,'multi');
const multiCues = await db.byIndex('cues','videoId',m.id);
assert.deepEqual(multiCues.map(c=>c.start),[3,13]);
const multiJa = await db.byIndex('videoJa','materialId',m.id);
assert.equal(multiJa.filter(r=>r.ja).length,1);
assert.equal(videoJaView(multiCues,multiJa).get(multiCues[0]),'共通の日本語訳。');
await assert.rejects(() => importMaterial({materialId:'studio-m',title:'Multiple sources',packId:'p2'},
  {...multi,items:[...multi.items].reverse()},()=>{throw Error('unexpected copy');},{askUpdate:false,direct:true}),
  error => error.skip && error.message.includes('順序'));
assert.deepEqual(await db.byIndex('cues','videoId',m.id),multiCues);
console.log('Video Lab direct imports: independent sets, shared media, repeat/update policy, manual protection, multi-file translation and times');
clearTimeout((await import('../ui.js')).toast._t);
