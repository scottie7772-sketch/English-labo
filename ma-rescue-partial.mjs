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
