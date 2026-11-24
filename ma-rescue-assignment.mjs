import assert from 'node:assert/strict';
import { createRescueSearch, sameRescueVersion, rescuePreviewRange } from '../studio-prose-rescue.js';

const span = (start,end) => ({sourceId:'s',start,end});
const rows = [
  {id:'a',text:'Previous line.',aligned:true,sync:'manual',segments:[span(0,10)]},
  {id:'pending',text:'The missing line.',script:true,segments:[]},
  {id:'asr',text:'The missing line.',asr:true,sync:'auto',segments:[span(10.2,12.8)]},
  {id:'raw',text:'',segments:[span(10,13)]},
  {id:'b',text:'Next line.',aligned:true,segments:[span(13,16)]},
];
const search = createRescueSearch(rows,['s'],{s:{duration:20}});
const selected = search.byRow.get('pending');
const candidate = search.search(selected).candidates[0];
assert.equal(candidate.inside,true);
assert.equal(candidate.matchingAsr,1);
assert.deepEqual(search.availableRanges(span(9,14)),[span(10,13)]);
assert(search.isFree(span(10,13)));
assert(!search.isFree(span(9,14)));
assert.equal(search.assignments([rows[1]],candidate)[0].segment.start,10.2);
const protectedSearch = createRescueSearch([...rows,{id:'manual',text:'',sync:'manual',segments:[span(10.5,13)]}],['s'],{s:{duration:20}});
assert.deepEqual(protectedSearch.availableRanges(span(10,13)),[span(10,10.5)]);
assert.deepEqual(protectedSearch.availableRanges(span(10.6,12.7)),[]);
const version = {updatedAt:1,order:['a','pending','b'],undo:[],redo:[]};
assert(sameRescueVersion(version,structuredClone(version)));
assert(!sameRescueVersion(version,{...version,updatedAt:2}));
assert.deepEqual(rescuePreviewRange(10,20.05,20,'tail'),{start:18,end:20});
assert.deepEqual(rescuePreviewRange(10,11,20,'tail'),{start:10,end:11});
assert.deepEqual(rescuePreviewRange(10,20,20,'head'),{start:10,end:12});
assert.equal(rescuePreviewRange(20,21,20,'tail'),null);
console.log('MA rescue passed: ASR/raw gaps remain available, manual spans protected, anchor trial version and preview ranges');
