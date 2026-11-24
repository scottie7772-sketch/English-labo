import assert from 'node:assert/strict';
import { hasWords, isSymbolRow, needsWork, planBulkGaps, rangePieces, keepInPiece, withoutTaken } from '../studio-ma-tools.js';
const g = (start,end,sourceId='s') => ({sourceId,start,end});
// 8. symbol-only rows
assert(isSymbolRow({text:'─'}) && isSymbolRow({text:'───'}) && !isSymbolRow({text:'“Wait—”'}) && !isSymbolRow({text:''}));
assert(!needsWork({text:'─',segments:[]}) && needsWork({text:'“Wait—”',segments:[]}));
// 1. bulk single gaps: two singles taken, a double run and an overlap skipped, neighbours unchanged
const rows = {
  a:{id:'a',text:'One.',segments:[g(0,2)],aligned:true}, x:{id:'x',text:'Single missing line here.',segments:[]},
  b:{id:'b',text:'Two.',segments:[g(4,6)],aligned:true}, sep:{id:'sep',text:'─',segments:[]},
  y1:{id:'y1',text:'First of two missing.',segments:[]}, y2:{id:'y2',text:'Second of two missing.',segments:[]},
  c:{id:'c',text:'Three.',segments:[g(10,12)],aligned:true}, z:{id:'z',text:'Another single gap.',segments:[]},
  d:{id:'d',text:'Four.',segments:[g(14,16)],aligned:true}, w:{id:'w',text:'Covered by overlap.',segments:[]},
  e:{id:'e',text:'Five.',segments:[g(15.5,18)],aligned:true},
};
const order = ['a','x','b','sep','y1','y2','c','z','d','w','e'];
const before = JSON.stringify(rows);
const plan = planBulkGaps(order, rows, (seg) => [seg]);
assert.deepEqual(plan.can.map(c=>c.b.id), ['x','z']);
assert.deepEqual(plan.can[0].seg, g(2,4));
assert.deepEqual(plan.skip.map(s=>s.r), ['未割当が連続','未割当が連続','前後の区間が重なっている']);
assert.equal(JSON.stringify(rows), before, 'planning changes nothing');
// 2. after the bulk estimate the row is still "to do" until confirmed
assert(needsWork({text:'x',segments:[g(2,4)],sync:'estimated',unconfirmed:true}));
assert(!needsWork({text:'x',segments:[g(2,4)],sync:'manual'}));
// 5. 45 s in overlapping pieces; a sentence on a seam is kept once
const pcs = rangePieces(100,145,18,2);
assert.deepEqual(pcs, [[100,118],[116,134],[132,145]]);
const seamCue = {start:116.5,end:118.5};   // mid 117.5: inside piece 0's overlap end → kept by piece 1 only
assert.equal([0,1].filter(k => keepInPiece(seamCue,k,pcs,2)).length, 1);
for (let t = 100; t < 145; t += .37) assert.equal(pcs.map((_,k)=>k).filter(k => keepInPiece({start:t,end:t},k,pcs,2)).length, 1);
// 3/6. a neighbour that covered the next line's sound gives up only that part
assert.deepEqual(withoutTaken([g(0,14)],[g(10,14)]), [g(0,10)]);
assert.deepEqual(withoutTaken([g(0,14)],[g(0,14)]), []);
assert(hasWords('Wait—') && !hasWords('─ ─'));
console.log('MA tools passed: symbol rows, bulk single-gap plan, unconfirmed stays to-do, 45 s piece plan without seam loss/duplication, neighbour trimming');
// manual fix of A must not reach C past an unassigned B
{
  const { adjacentWithSound } = await import('../studio-ma-tools.js');
  const by = {A:{id:'A',text:'A.',segments:[g(0,3)]},B:{id:'B',text:'B.',segments:[]},C:{id:'C',text:'C.',segments:[g(6,9)]},S:{id:'S',text:'─',segments:[]}};
  assert.equal(adjacentWithSound(['A','B','C'],by,'A',1),null,'B (no sound) is the neighbour: C is not touched');
  assert.equal(adjacentWithSound(['A','S','C'],by,'A',1).id,'C','a symbol row is skipped');
  assert.equal(adjacentWithSound(['A','B','C'],by,'C',-1),null);
  console.log('Neighbour rule passed: correcting A never moves C past unassigned B');
}
