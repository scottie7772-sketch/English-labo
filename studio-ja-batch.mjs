import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readStudioJaFiles, planStudioJa, studioJaView } from '../studio-ja.js';
import { zipWrite } from '../common-pack.js';
import { cueStamps, planJaWrites, studioJaPatch, videoJaView } from '../video-ja.js';
globalThis.window = globalThis;
const document = (chapter, ...rows) => ({ chapter, items: rows.map(([en, ja]) => ({ en, ja })) });
const docs = [
  document(2,['CHAPTER TWO','第2章'],['Distinct second chapter.','第二章。'],['Yes.','はい。'],['It ends here.','ここで終わる。']),
  document(5,['CHAPTER FIVE','第5章'],['The fifth chapter begins.','第五章が始まる。']),
  document('BEFORE',['BEFORE','以前'],['Memory from a different time.','別の時代の記憶。']),
  document(6,['CHAPTER SIX','第6章'],['A different beginning.','別の始まり。'],['Yes.','そうだ。'],['The speaker nodded.','話者はうなずいた。']),
  document(10,['CHAPTER TEN','第10章'],['This is chapter ten.','第十章だ。']),
  document(11,['We opened the gate and crossed the dark hall.','門を開けて暗い広間を横切った。']),
  document(12,['CHAPTER TWELVE','第12章'],['Here is the next passage.','次の一節だ。']),
  document(13,['CHAPTER THIRTEEN','第13章'],['Short sentence.','短い文。'],['Second sentence.','二つ目の文。']),
];
const zip = await zipWrite(docs.map((data, i) => ({ name: i === 2 ? 'BEFORE_AFTER_CHAPTER_05.json' : i + '.json', data: JSON.stringify(data) })));
const file = new File([zip], 'chapters.zip');
const sections = await readStudioJaFiles([file]);
assert.deepEqual(sections.map(s => s.data.chapter),[2,5,'BEFORE',6,10,11,12,13]);
assert.equal((await readStudioJaFiles(docs.map((d,i) => new File([JSON.stringify(d)],i+'.json')))).length,docs.length);
assert.equal((await readStudioJaFiles([new File([zip], 'archive'), new File([JSON.stringify(docs[0])], 'chapter.txt')])).length,docs.length + 1);

// Convert a one-member stored ZIP to a standard deflate ZIP without keeping a binary fixture.
const stored = await zipWrite([{ name:'chapter.json', data:JSON.stringify(docs[0]) }]);
const end = new DataView(await stored.slice(-22).arrayBuffer());
const centralStart = end.getUint32(16,true);
const central = new DataView(await stored.slice(centralStart,-22).arrayBuffer());
const local = new DataView(await stored.slice(0,30 + central.getUint16(28,true)).arrayBuffer());
const compressed = deflateRawSync(Buffer.from(JSON.stringify(docs[0])));
local.setUint16(8,8,true);
local.setUint32(18,compressed.length,true);
central.setUint16(10,8,true);
central.setUint32(20,compressed.length,true);
end.setUint32(16,local.byteLength + compressed.length,true);
const packed = new File([local.buffer,compressed,central.buffer,end.buffer], 'Archive.zip');
const nativeDecoder = globalThis.DecompressionStream;
try {
  for (const decoder of [nativeDecoder, undefined, class { constructor() { throw TypeError('Unsupported format'); } }]) {
    globalThis.DecompressionStream = decoder;
    assert.deepEqual((await readStudioJaFiles([packed]))[0].data,docs[0]);
  }
} finally {
  globalThis.DecompressionStream = nativeDecoder;
}
await assert.rejects(() => readStudioJaFiles([new File(['invalid'],'broken.zip')]), /broken\.zip.*ZIP/);
await assert.rejects(() => readStudioJaFiles([new File(['{}'],'other.json')]), /other\.json.*英文と訳文/);
const make = (texts) => texts.map((text,i) => ({ id:'c'+i,rev:3,text,segments:[{sourceId:'s',start:i,end:i+1}], aligned:true,
  sync:'manual', unconfirmed:true, boundary:{status:'checked'}, ja:'' }));
const apply = (blocks, plan) => {
  const edits = new Map(plan.changes.map(b => [b.id,b]));
  return blocks.map(b => edits.get(b.id) || b);
};
const A = make(['CHAPTER TWO','Distinct second chapter.','Yes.','It ends here.','CHAPTER FIVE','The fifth chapter begins.']);
const B = make(['CHAPTER SIX','A different beginning.','Yes.','The speaker nodded.','CHAPTER TEN','This is chapter ten.']);
const C = make(['We opened the gate','and crossed the dark hall!','CHAPTER TWELVE','Here is the next passage.','CHAPTER THIRTEEN','Short sentence. Second sentence.']);
const D = make(['The fifth chapter begins.','BEFORE','Memory from a different time.','CHAPTER SIX','A different beginning.']);
for (const [blocks,i] of [A,B,C,D].map((a,i)=>[a,i])) {
  const plan = planStudioJa({ id:'s'+i,title:'Arbitrary title' },blocks,sections);
  const updated = apply(blocks,plan);
  assert.equal(plan.summary.applied,blocks.length);
  for (const [i,row] of updated.entries()) {
    const {jaImport,jaReview,...unchanged}=row;
    assert.deepEqual(unchanged, blocks[i]);
  }
}
const partial = planStudioJa({id:'partial'},make(['Yes.']),sections);
assert.equal(partial.changes[0].jaReview,true);
assert.equal(partial.summary.review.length,1);
const candidate = apply(C,planStudioJa({id:'c'},C,sections));
const view = studioJaView(candidate);
assert.equal(view.value(candidate[0]),view.value(candidate[1]));
assert.equal(candidate.filter(b=>b.jaImport?.texts?.includes(view.value(candidate[0]))).length,1);
assert.equal(view.value(candidate.at(-1)),'短い文。\n二つ目の文。');
const modified = [{...candidate[0],text:'A different manual line.'},...candidate.slice(1)];
assert.equal(studioJaView(modified).summary.review.length,2);
const removed = [{...candidate[0],jaOverride:true,ja:''},...candidate.slice(1)];
assert.equal(studioJaView(removed).value(removed[0]),'');
assert(studioJaView(removed).value(removed[1]));
assert.equal(planStudioJa({id:'c'},removed,sections).changes.some(b=>b.id===removed[0].id),false);

const cues = candidate.map(({id,text},i)=>({id:'v'+i,itemId:id,en:text,ja:''}));
const patch = studioJaPatch(cues,view.spans);
let records = new Map();
const commit = plan => { for(const id of plan.deletes) records.delete(id); for(const [id,row] of plan.puts) records.set(id,row); };
commit(planJaWrites('lab',cues,[],patch,cueStamps(cues),{fromStudio:true,replaceStudio:true}));
assert.equal(videoJaView(cues,[...records.values()]).get(cues[1]),view.value(candidate[1]));
commit(planJaWrites('lab',cues,[...records.values()],new Map([[cues[0].id,['ラボ手動修正']],[cues[1].id,[]]]),cueStamps(cues)));
commit(planJaWrites('lab',cues,[...records.values()],patch,cueStamps(cues),{fromStudio:true,replaceStudio:true}));
assert.equal(videoJaView(cues,[...records.values()]).get(cues[0]),'ラボ手動修正');
assert.equal(videoJaView(cues,[...records.values()]).get(cues[1]),'');
console.log('Studio JA batch: ZIP/multiple files, partial chapters, BEFORE, repetition, split/merge, review and Lab edit/removal protection');
