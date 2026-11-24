import assert from 'node:assert/strict';
import { createRescueSearch } from '../studio-prose-rescue.js';
const span = (start,end) => ({sourceId:'s',start,end});
const texts = ['First missing sentence here.','Second one is spoken too.','Third line nobody recognised.','Fourth sentence is fine.','Fifth and last line.'];
const rows = [
  {id:'a',text:'Anchor before.',aligned:true,segments:[span(0,10)]},
  ...texts.map((t,i)=>({id:'m'+i,text:t,script:true,segments:[]})),
  {id:'b',text:'Anchor after.',aligned:true,segments:[span(30,34)]},
  // recognised speech for rows 0,1,3,4 (row 2 not recognised: wrong words)
  {id:'r0',text:texts[0],asr:true,sync:'auto',segments:[span(10.5,13)]},
  {id:'r1',text:texts[1],asr:true,sync:'auto',segments:[span(13.4,16)]},
  {id:'r2',text:'Turd lime nobody wreck honest.',asr:true,sync:'auto',segments:[span(16.5,20)]},
  {id:'r3',text:texts[3],asr:true,sync:'auto',segments:[span(20.4,24)]},
  {id:'r4',text:texts[4],asr:true,sync:'auto',segments:[span(24.5,29)]},
];
const search = createRescueSearch(rows,['s'],{s:{duration:40}});
const run = search.byRow.get('m0'), cand = search.search(run).candidates[0];
const targets = rows.slice(1,6);
assert.equal(search.assignments(targets,cand).length,0,'all-or-nothing gives nothing');
const part = search.assignments(targets,cand,undefined,{partial:true});
assert.deepEqual(part.map(x=>x.row.id),['m0','m1','m3','m4']);
assert.equal(part[2].segment.start,20.4);
// identical text twice: the order decides only when unambiguous
const dup = [{id:'a',text:'Anchor.',aligned:true,segments:[span(0,5)]},{id:'x',text:'Yes, of course.',script:true,segments:[]},{id:'y',text:'Something else said.',script:true,segments:[]},{id:'b',text:'End.',aligned:true,segments:[span(20,22)]},
  {id:'q1',text:'Yes, of course.',asr:true,sync:'auto',segments:[span(6,7)]},{id:'q2',text:'Yes, of course.',asr:true,sync:'auto',segments:[span(12,13)]}];
const s2 = createRescueSearch(dup,['s'],{s:{duration:30}}), c2 = s2.search(s2.byRow.get('x')).candidates[0];
assert.equal(s2.assignments(dup.slice(1,3),c2,undefined,{partial:true}).length,0,'ambiguous repeat is not saved');
console.log('MA partial rescue passed: confirmed rows kept when one row is unrecognised; ambiguous repeats skipped');
// 3. the next line's reading is inside the previous line: matching the neighbours together moves it to the right line
{
  const A = {id:'A',text:'The first long sentence ends here.',aligned:true,segments:[span(0,14)]};
  const M = {id:'M',text:'The hidden second sentence.',script:true,segments:[]};
  const B = {id:'B',text:'And a third one follows.',aligned:true,segments:[span(14,18)]};
  const asr = [{id:'e1',text:A.text,asr:true,sync:'auto',segments:[span(.5,9.5)]},{id:'e2',text:M.text,asr:true,sync:'auto',segments:[span(10,13.8)]},{id:'e3',text:B.text,asr:true,sync:'auto',segments:[span(14.2,17.8)]}];
  const all = [A,M,B,...asr], wide = new Set(['A','B']);
  const normal = createRescueSearch(all,['s'],{s:{duration:20}});
  assert.equal(normal.availableRanges(span(10,13.8)).length,0,'covered by A: nothing free');
  const s3 = createRescueSearch(all.filter(b=>!wide.has(b.id)),['s'],{s:{duration:20}});
  const got = s3.assignments([A,M,B],{sid:'s',start:0,end:18.3},undefined,{partial:true});
  assert.deepEqual(got.map(x=>[x.row.id,x.segment.start,x.segment.end]),[['A',.5,9.5],['M',10,13.8],['B',14.2,17.8]]);
  // a manually confirmed line outside the included rows still protects its time
  const s4 = createRescueSearch([...all.filter(b=>!wide.has(b.id)),{id:'man',text:'',sync:'manual',segments:[span(10,12)]}],['s'],{s:{duration:20}});
  assert(!s4.isFree(span(10,13.8)));
}
console.log('MA wide rescue passed: a reading hidden in the previous line is reassigned; manual times protected');
