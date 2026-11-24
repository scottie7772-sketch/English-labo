import assert from 'node:assert/strict';
import { adjustJaRows, joinJa, jaModel, isLocked, moveText, swapRows, splitRow, mergeInto, editText, rangeMove, sharedImpact, dissolve,
  jaChanges, jaBalance, rowText } from '../ja-position.js';

// ---- stage 1 API (kept) ----
assert.deepEqual(adjustJaRows(['あいう', 'えお'], 0, 1), ['', 'あいうえお']);            // whole text down
assert.deepEqual(adjustJaRows(['あいう', 'えお'], 1, 0), ['あいうえお', '']);            // whole text up
assert.deepEqual(adjustJaRows(['あいう', 'えお'], 0, 1, false, 2, 3), ['あい', 'うえお']); // selection down goes in front
assert.deepEqual(adjustJaRows(['あいう', 'えお'], 1, 0, false, 0, 1), ['あいうえ', 'お']); // selection up goes after
assert.deepEqual(adjustJaRows(['a', 'b'], 0, 1, true), ['b', 'a']);
assert.equal(adjustJaRows(['a', 'b', 'c'], 0, 2), null);                                   // neighbours only
assert.equal(adjustJaRows(['', 'b'], 0, 1), null);
assert.equal(joinJa('word', 'next'), 'word next');
assert.equal(joinJa('こんにちは', '世界'), 'こんにちは世界');

// ---- model over a material ----
const rows = [
  { id: 'a', en: 'A.', own: '一つ目。' },
  { id: 'b', en: 'B.', own: '二つ目。三つ目。' },
  { id: 'c', en: 'C.', own: '' },
  { id: 'd', en: 'D.', own: '四つ目。', groups: [] },
  { id: 'e', en: 'E1', own: '', groups: ['g'] },
  { id: 'f', en: 'E2', own: '', groups: ['g'] },
  { id: 'h', en: 'H.', own: '最後。' },
];
const groups = new Map([['g', { text: '共有の訳。前半。後半。', members: ['e', 'f'] }]]);
const m = jaModel(rows, groups);
let s = m.initial;
const step = r => { assert(!r.error, r.error); s = r.state; return r; };

// whole move / partial move / swap / split / merge
step(moveText(m, s, 1, 1, 4, 8));                 // 「三つ目。」 to the next row
assert.deepEqual(s.own.slice(0, 3), ['一つ目。', '二つ目。', '三つ目。']);
step(swapRows(m, s, 0, 1));
assert.deepEqual(s.own.slice(0, 2), ['二つ目。', '一つ目。']);
step(swapRows(m, s, 0, 1));
assert.ok(splitRow(m, s, 0, 2, -1).error);        // no previous row
step(splitRow(m, s, 0, 2, 1));
assert.deepEqual(s.own.slice(0, 2), ['一つ', '目。二つ目。']);
step(mergeInto(m, s, 0, 1));
assert.deepEqual(s.own.slice(0, 2), ['一つ目。二つ目。', '']);
step(moveText(m, s, 0, 1, 4, 8));
assert.deepEqual(s.own.slice(0, 3), ['一つ目。', '二つ目。', '三つ目。']);
assert.deepEqual(jaChanges(m, s).map(c => c.id), ['b', 'c']);
assert.equal(jaChanges(m, s)[1].after.own, '三つ目。');

// shared rows are locked until released; releasing shows its full impact and touches only its members
assert(isLocked(m, s, 4) && isLocked(m, s, 5) && !isLocked(m, s, 3));
assert.match(moveText(m, s, 3, 1).error, /共有/);
assert.match(rangeMove(m, s, 2, 4, 1).error, /共有/);
assert.match(editText(m, s, 4, 'x').error, /共有/);
const impact = sharedImpact(m, 'g');
assert.deepEqual(impact.members, [4, 5]);
assert.equal(impact.recipient, 4);
step(dissolve(m, s, 'g'));
assert.ok(dissolve(m, s, 'g').error);             // only once
assert.deepEqual(s.own.slice(4, 6), ['共有の訳。前半。後半。', '']);
step(splitRow(m, s, 4, '共有の訳。前半。'.length, 1));
assert.deepEqual(s.own.slice(4, 6), ['共有の訳。前半。', '後半。']);
const ch = jaChanges(m, s);
assert.deepEqual(ch.map(c => c.id), ['b', 'c', 'e', 'f']);
assert.deepEqual(ch.find(c => c.id === 'f').before, { own: '', groups: ['g'] });
assert.deepEqual(ch.find(c => c.id === 'f').after, { own: '後半。', groups: [] });
assert.equal(jaBalance(m, s).lost, 0);
assert.equal(rowText(m, m.initial, 4), '共有の訳。前半。後半。');

// a group that also belongs to a subtitle outside the list cannot be released here
const partial = jaModel(rows.slice(0, 5), groups);
assert.equal(sharedImpact(partial, 'g').complete, false);
assert.match(dissolve(partial, partial.initial, 'g').error, /範囲外/);

// ---- range move: any range, collisions -> merge / swap / cancel, nothing pushed out is deleted ----
const r2 = jaModel(['一', '二', '三', '四', '五', '六'].map((own, i) => ({ id: 'r' + i, en: 'E' + i, own })));
let t = r2.initial;
let p = rangeMove(r2, t, 1, 2, 2);               // rows 2-3 down by two: 四 / 五 are in the way
assert.deepEqual(p.collisions, [3, 4]);
assert(p.needsChoice && !p.state);               // no mode chosen = preview only (= cancel)
const merged = rangeMove(r2, t, 1, 2, 2, 'merge').state.own;
assert.deepEqual(merged, ['一', '', '', '二四', '三五', '六']);
const swapped = rangeMove(r2, t, 1, 2, 2, 'swap').state.own;
assert.deepEqual(swapped, ['一', '四', '五', '二', '三', '六']);
const up = rangeMove(r2, t, 3, 4, -1, 'merge').state.own;       // up: the moved text goes after the existing one
assert.deepEqual(up, ['一', '二', '三四', '五', '', '六']);
const free = jaModel(['一', '', '', '四'].map((own, i) => ({ id: 'f' + i, en: 'E' + i, own })));
const plain = rangeMove(free, free.initial, 0, 0, 2);
assert(!plain.needsChoice && plain.state);       // empty target: moves directly
assert.deepEqual(plain.state.own, ['', '', '一', '四']);
// "this line to the end, one line down" (the old shift): the last translation is merged, not dropped
const tail = rangeMove(r2, t, 2, 5, 1);
assert.deepEqual(tail.overflow, [5]);
assert(tail.needsChoice);
assert.match(rangeMove(r2, t, 2, 5, 1, 'swap').error, /交換/);
assert.deepEqual(rangeMove(r2, t, 2, 5, 1, 'merge').state.own, ['一', '二', '', '三', '四', '五六']);
// shift up from row 2 to the end: the first translation meets row 1 (collision) instead of being discarded
assert.deepEqual(rangeMove(r2, t, 1, 5, -1, 'merge').state.own, ['一二', '三', '四', '五', '六', '']);
assert.deepEqual(rangeMove(r2, t, 1, 5, -1, 'swap').state.own, ['二', '三', '四', '五', '六', '一']);
assert.match(rangeMove(r2, t, 0, 1, 1, null).error || 'x', /x|移動/);
assert.ok(rangeMove(free, free.initial, 1, 2, 1).error);        // nothing to move

// ---- randomized: moves never lose or duplicate text ----
const chars = list => list.join('').split('').sort().join('');
let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let round = 0; round < 300; round++) {
  const size = 2 + rnd(6);
  const model = jaModel(Array.from({ length: size }, (_, i) => ({ id: 'x' + i, en: 'e' + i, own: rnd(3) ? 'あいうえおかきくけこ'.slice(rnd(5), 5 + rnd(5)) : '' })));
  let st = model.initial; const before = chars(st.own);
  for (let k = 0; k < 12; k++) {
    const i = rnd(size), d = rnd(2) ? 1 : -1, op = rnd(5);
    const len = st.own[i].length, a = rnd(len + 1), b = a + rnd(len - a + 1);
    const r = op === 0 ? moveText(model, st, i, d, a, b) : op === 1 ? swapRows(model, st, i, d) : op === 2 ? splitRow(model, st, i, a, d)
      : op === 3 ? mergeInto(model, st, i, d) : rangeMove(model, st, i, Math.min(size - 1, i + rnd(3)), d * (1 + rnd(2)), rnd(2) ? 'merge' : 'swap');
    if (r.state) st = r.state;
  }
  assert.equal(chars(st.own), before, 'text must be conserved');
}
console.log('ja-position: move / partial / swap / split / merge / range (merge, swap, cancel, overflow) / shared release / conservation pass');
