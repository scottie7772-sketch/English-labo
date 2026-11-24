import assert from 'node:assert/strict';
import { planVocabAlignment } from '../studio-vocab-align.js';
import { alignUtterances } from '../studio-import-align.js';
import { translationRows, planTranslations } from '../video-translations.js';
import { speechFirstPlaybackRange } from '../studio-playback-boundary.js';
import { speechRegions } from '../studio-structure.js';

const row = (id,text,kind) => ({ id, text, kind, segments:[] });
const audio = (text,start,end) => ({ text,start,end,sourceId:'s',vad:true });
const script = [row('1','reserve','word'),row('2','We should reserve a table for this evening.','example'),
  row('3','address','word'),row('4','Please confirm your shipping address with us.','example'),row('5','arrival','word')];
const heard = [audio('Reserve!',0,.4),audio(script[1].text,.8,2.1),audio(script[1].text,2.2,3.5),
  audio(script[1].text,3.7,5),audio('',5.5,5.9),audio(script[3].text,6.4,8),audio('arrival',8.4,9)];
const plan = planVocabAlignment(script,heard,[]);
assert.deepEqual(plan.map(p => [p.row.id,p.cues.length,Boolean(p.estimated)]),
  [['1',1,false],['2',3,false],['3',1,true],['4',1,false],['5',1,false]]);
assert(!planVocabAlignment(script,heard.map(c=>c.text ? c : { ...c, text:'wrong' }),[]).some(p=>p.row.id === '3'));
assert(!planVocabAlignment([{...script[0],sync:'manual'}],heard,[]).length);
const dup = [script[0],script[1],{...script[1],id:'rep'},...script.slice(2)];
assert.deepEqual(planVocabAlignment(dup,heard,[]).find(p=>p.row.id==='2').redundant.map(p=>p.id),['rep']);
const toeic = [{text:'W: When is the meeting?'},{text:'M: On Tuesday.'},{text:'M: There will be a ten minute break before we continue.'}];
const fragments = [audio('When is the meeting?',0,1),audio('On Tuesday.',1.3,2),audio('There will be a ten minute break',3,4),audio('before we continue.',4.3,5)];
assert.deepEqual(alignUtterances(toeic,fragments,{profile:'toeic-talk'}).map(p=>[p.scriptIndex,p.range.end]), [[0,1],[1,2],[2,5]]);
assert.deepEqual(alignUtterances([{text:'The room looked quiet.'}],[audio('The room looked quiet',0,1)]).map(x=>x.score),[1]);
const cues = [{id:'a',en:'One.',start:0,end:1},{id:'b',en:'Two.',start:1,end:2},{id:'c',en:'One.',start:2,end:3}];
const planned = planTranslations(cues,translationRows('cue,ja\n1-2,"一と二, です。"\n2,補足\n4,対象なし'));
assert.deepEqual([...planned.changes.values()].map(c=>[c.id,c.ja]),[['a','一と二, です。'],['b','一と二, です。\n補足']]);
assert.deepEqual(planned.unmatched,[3]);
assert.deepEqual(planTranslations(cues,translationRows('One.\n一。')).unmatched,[1]);
assert.equal(planTranslations(cues,translationRows('[{"english":"One. Two.","japanese":"一と二"}]')).changes.size,2);
assert.equal(planTranslations(cues,translationRows('一\n二')).changes.size,0);
const pcm = new Float32Array(16000*26);
for(let i=0;i<35;i++) for(let k=0;k<3200;k++) pcm[3200+11200*i+k] = Math.sin(k*.11)*.19;
assert.equal(speechRegions(pcm,16000,{gapFrames:5,minGap:.1}).length,35);
const block = {id:'b',sync:'manual',segments:[{sourceId:'s',start:2,end:4}],structureAlign:{method:'speech-first'}};
assert.equal(speechFirstPlaybackRange(block,block.segments[0],[],10),null);
console.log('VAD 35, MA matching/manual playback, vocabulary/repeat/uncertain heading, TOEIC and translation mapping passed');

globalThis.window = {};
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, querySelector: () => ({ textContent: '', hidden: true }) };
const { db } = await import('../db.js');
const { importMaterial } = await import('../video.js');
const stores = Object.fromEntries(['videos','cues','vblobs','attempts'].map(k=>[k,new Map()]));
db.all = async store => [...stores[store].values()].map(x=>structuredClone(x));
db.byIndex = async (store, key, value) => (await db.all(store)).filter(x=>x[key]===value);
db.get = async (store, id) => structuredClone(stores[store].get(id));
db.put = async (store, value) => stores[store].set(value.id,structuredClone(value));
db.tx = async (names, mode, callback) => callback({ objectStore: name => ({
  delete: id => stores[name].delete(id), put: row => stores[name].set(row.id,structuredClone(row)),
}) });
const manifest = {materialId:'material',packId:'pack',title:'Test material',lang:'en'};
const blob = new Blob([new Uint8Array(96)],{type:'audio/wav'});
const mat = {set:{materialType:'vocab'},media:[{id:'m',kind:'audio',name:'test.wav',mime:'audio/wav',size:blob.size,duration:9,included:true}],
  items:[{id:'a',text:'Reserve.',studySet:'a',role:'word',segments:[{media:'m',start:1,end:2}]},
    {id:'b',text:'Reserve a table.',studySet:'a',role:'example',segments:[{media:'m',start:2.2,end:3.3},{media:'m',start:4,end:5}]}]};
const video = await importMaterial(manifest,mat,async()=>blob,{askUpdate:false});
const before = await db.byIndex('cues','videoId',video.id);
const saved = before.find(c=>c.itemId==='b');
await db.put('cues',{...saved,en:'Reserve a table, please.',enEdited:true,ja:'席を予約してください。',jaEdited:true,start:2.15,
  timeEdited:true,segments:[{start:2.15,end:3.3},saved.segments[1]],dict:{best:9}});
await db.put('videos',{...video,lastTime:4.5});
await db.put('attempts',{id:'attempt',videoId:video.id,correct:true});
const again = await importMaterial(manifest,mat,async()=>{throw Error('Unexpected audio copy');},{askUpdate:false});
assert.equal(again.id,video.id);
assert.equal(again.lastTime,4.5);
assert.equal(stores.vblobs.size,1);
assert.equal(stores.attempts.size,1);
const after = await db.byIndex('cues','videoId',video.id);
assert.deepEqual(after.map(x=>x.id),before.map(x=>x.id));
assert.equal(after[1].en,'Reserve a table, please.');
assert.equal(after[1].ja,'席を予約してください。');
assert.equal(after[1].start,2.15);
assert.equal(after[1].segments.length,2);
assert.equal(after[1].dict.best,9);
console.log('Studio re-import preserved cue IDs, title-independent link, media, progress and manual edits (in-memory database)');
