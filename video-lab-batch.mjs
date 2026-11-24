import assert from 'node:assert/strict';
globalThis.addEventListener = () => {};
globalThis.window = {};
globalThis.document = { addEventListener(){}, querySelector(){return {textContent:'',hidden:true};} };
const {importMaterial,importMaterialCollection,videoBlob,studioLabState,syncStudioLabFolder} = await import('../video.js');
const {db} = await import('../db.js');
const {cueStamps,saveVideoJa,videoJaView} = await import('../video-ja.js');
const { materialPackEntries, packMedia, writeMaterialCollection, writeMaterialPack, readMaterialPack, readMaterialImport } = await import('../material-pack.js');
const { zipRead, zipWrite } = await import('../common-pack.js');
const names = ['videos','vblobs','cues','videoJa','settings'];
const records = Object.fromEntries(names.map(name=>[name,new Map()]));
db.all = async store => [...records[store].values()].map(row=>structuredClone(row));
db.get = async (store,id) => structuredClone(records[store].get(id));
db.byIndex = async (store,key,id) => (await db.all(store)).filter(row=>row[key]===id);
db.put = async (store,row) => records[store].set(row.id,structuredClone(row));
db.tx = async (stores,mode,task) => {
  const requests = result => {
    const request = {result}; queueMicrotask(() => request.onsuccess?.()); return request;
  };
  const result = task({objectStore:name=>({
    put: row=>records[name].set(row.id ?? row.key,structuredClone(row)), delete: id=>records[name].delete(id),
    get: id=>requests(structuredClone(records[name].get(id))),
    index: key=>({getAll: id=>requests([...records[name].values()].filter(row=>row[key]===id).map(row=>structuredClone(row)))}),
    openCursor: () => {
      const rows = [...records[name].entries()];
      const request = {};
      const next = () => {
        const row = rows.shift();
        request.result = row ? { value: structuredClone(row[1]), update: v => records[name].set(row[0],structuredClone(v)), continue: () => queueMicrotask(next) } : null;
        request.onsuccess?.();
      };
      queueMicrotask(next);
      return request;
    },
  })});
  await new Promise(resolve => setImmediate(resolve));
  return result;
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
await db.put('videos',{id:'interrupted',from:{material:'not-completed',importComplete:false}});
await db.put('videos',{id:'legacy',from:{material:'legacy-set'},blob:audio});
assert.deepEqual(await studioLabState(),new Set(['studio-a','studio-b','studio-m','legacy-set']));
const beforeFolderSync = await db.all('videos');
const unchanged = await db.all('cues');
const allJa = await db.all('videoJa');
await syncStudioLabFolder('New common name', ['studio-m','studio-b','studio-a','not-completed','legacy-set']);
for (const video of await db.all('videos')) {
  const { folder, folderOrder, ...base } = beforeFolderSync.find(old => old.id === video.id);
  const rank = ['studio-m','studio-b','studio-a'].indexOf(video.from.material);
  assert.deepEqual(video, rank < 0 ? base : { ...base, folder:'New common name', folderOrder:rank });
}
assert.deepEqual(await db.all('cues'),unchanged);
assert.deepEqual(await db.all('videoJa'),allJa);
assert.deepEqual((await db.get('settings','video.studioLegacyFolders')).value.legacy,{folder:'New common name',folderOrder:4});
assert.equal(records.vblobs.size,2);
const packManifest = { format:'elpack', formatVersion:2, materialId:'file-import', title:'Pack Test', contents:{audio:true,audioMode:'all'} };
const wavHeader = Buffer.alloc(44);
wavHeader.write('RIFF'); wavHeader.writeUInt32LE(16036,4); wavHeader.write('WAVEfmt ',8);
wavHeader.writeUInt32LE(16,16); wavHeader.writeUInt16LE(1,20); wavHeader.writeUInt16LE(1,22);
wavHeader.writeUInt32LE(8000,24); wavHeader.writeUInt32LE(16000,28); wavHeader.writeUInt16LE(2,32);
wavHeader.writeUInt16LE(16,34); wavHeader.write('data',36); wavHeader.writeUInt32LE(16000,40);
const wav = new Blob([wavHeader,new Uint8Array(16000)],{type:'audio/wav'});
const media = packMedia({ id:'audio1', name:'Converted.mp4', kind:'video', mime:'video/mp4', duration:1 },wav);
assert.equal(media.path,'media/audio1.wav');
assert.equal(media.kind,'audio');
const packMaterial = { ...mat, media:[media], items:mat.items.map((item,i)=>({
  ...item, segments:[{media:'audio1',start:i/2,end:(i+1)/2}],
})) };
const pack = await writeMaterialPack(packManifest,packMaterial,new Map([['audio1',wav]]));
assert.deepEqual((await zipRead(pack)).names,['manifest.json','material.json','media/audio1.wav']);
await assert.rejects(() => writeMaterialPack(packManifest,packMaterial,new Map()), /音声を保存できません/);
const broken = await zipWrite([
  {name:'manifest.json',data:JSON.stringify(packManifest)},
  {name:'material.json',data:JSON.stringify(packMaterial)},
]);
await assert.rejects(() => readMaterialPack(broken), /パック内の音声が欠けています/);
const subtitleZip = await zipWrite([{name:'chapter.csv',data:'en,ja\nA,あ'}]);
await assert.rejects(() => readMaterialPack(subtitleZip), /\.elpack\.zip/);
const loaded = await readMaterialPack(pack);
const result = await importMaterial(loaded.manifest,loaded.material,loaded.getFile,{askUpdate:false});
assert.deepEqual(Buffer.from(await (await videoBlob(result)).arrayBuffer()),Buffer.from(await wav.arrayBuffer()));
const packCues = await db.byIndex('cues','videoId',result.id);
assert.deepEqual(packCues.map(c=>[c.en,c.start,c.end]),[['Line one.',0,.5],['Line two.',.5,1]]);
assert.equal(videoJaView(packCues,await db.byIndex('videoJa','materialId',result.id)).get(packCues[0]),'共通の日本語訳。');
const textOnly = { ...packMaterial, media:[{...media,included:false,path:null}] };
await assert.rejects(() => importMaterial({...packManifest,materialId:'new-text-only'},textOnly,()=>null,{askUpdate:false}), /再生に必要な音声/);
const reuseAudio = await importMaterial(packManifest,textOnly,()=>null,{askUpdate:false});
assert.equal(reuseAudio.id,result.id);
records.vblobs.delete(result.id);
const restored = await importMaterial(loaded.manifest,loaded.material,loaded.getFile,{askUpdate:false});
assert.equal(restored.id,result.id);
assert.equal((await videoBlob(restored)).size,wav.size);
const batchZip = await writeMaterialCollection('Batch Folder',[0,1,2].map(index => {
  const title = 'Batch ' + index;
  const manifest = { ...packManifest, title, materialId:index === 0 ? packManifest.materialId : 'batch-' + index };
  const material = { ...packMaterial, set:{...packMaterial.set, folder:'Batch Folder', folderOrder:index} };
  return { title, entries:materialPackEntries(manifest,material,new Map([['audio1',wav]])) };
}));
const folder = await readMaterialImport(batchZip);
const progress = [];
const batch = await importMaterialCollection(folder.entries,{onProgress:(i,n,title)=>progress.push([i,n,title])});
assert.deepEqual(batch.report.map(row=>row[0]),['スキップ','成功','成功']);
assert.deepEqual(progress.map(row=>row[0]),[1,2,3]);
const copied = (await db.all('videos')).filter(video => video.folder === 'Batch Folder');
assert.deepEqual(copied.map(video=>[video.name,video.folderOrder]),[['Batch 1',1],['Batch 2',2]]);
assert.ok(copied[0].mediaRef);
assert.equal(copied[0].mediaRef,copied[1].mediaRef);
assert.equal((await videoBlob(copied[0])).size,wav.size);
assert.equal((await db.get('videos',result.id)).folder,packMaterial.set.folder);
assert.equal((await importMaterialCollection([{title:'broken',read:()=>{throw Error('Damaged');}}])).failed.length,1);
// 1.19.28: pack tag — members arriving later (any order) join the same folder even after it was renamed in the Lab
{
  const tagged = (id, rank) => ({ ...mat, set:{ folder:'Studio name', folderOrder:rank, packId:'folder-xyz', packName:'Studio name', materialType:'prose' } });
  const a1 = await importMaterial({materialId:'pk-2',title:'Part 2'},tagged('pk-2',1),()=>audio,{askUpdate:false,direct:true});
  assert.equal((await db.get('videos',a1.id)).folder,'Studio name');
  assert.equal((await db.get('videos',a1.id)).from.packId,'folder-xyz');
  await db.put('videos',{...(await db.get('videos',a1.id)),folder:'Renamed in Lab'});
  const a0 = await importMaterial({materialId:'pk-1',title:'Part 1'},tagged('pk-1',0),()=>audio,{askUpdate:false,direct:true});
  const v0 = await db.get('videos',a0.id);
  assert.equal(v0.folder,'Renamed in Lab');
  assert.equal(v0.folderOrder,0);
  // 音声のみ: sentence ranges without text
  const audioOnly = { ...mat, set:{...mat.set, contents:'audio'}, jaSpans:[], items:mat.items.map(it => ({...it, text:'', ja:''})) };
  const ao = await importMaterial({materialId:'audio-only',title:'Audio only'},audioOnly,()=>audio,{askUpdate:false,direct:true});
  const aoCues = await db.byIndex('cues','videoId',ao.id);
  assert.deepEqual(aoCues.map(c=>[c.en || '',c.start,c.end]),[['',3,4],['',4,5]]);
  console.log('Pack tag: late members join the renamed folder; audio-only materials keep sentence ranges without text');
}
console.log('Material ZIP: playable media bytes, English and Japanese, missing-media rejection and existing media recovery');
console.log('Video Lab direct imports: independent sets, shared media, repeat/update policy, manual protection, multi-file translation and times');
clearTimeout((await import('../ui.js')).toast._t);
