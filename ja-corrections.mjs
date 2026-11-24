import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { sdb, commit, liveBlocks, newBlock } = await import('../studio-db.js');
const { readVideoJa, videoJaView, saveVideoJa, cueStamps, labJaRows, labJaChanges, applyJaChanges } = await import('../video-ja.js');
const { studioJaView } = await import('../studio-ja.js');
const { jaModel, moveText, editText, jaChanges } = await import('../ja-position.js');
const { exportCorrections, importCorrections } = await import('../ja-tools-ui.js');
const { applyCorrectionsToMa, matchCorrections, readCorrections } = await import('../ja-corrections.js');

const en = ['CHAPTER ONE', 'Are you ready?', 'Yes.', 'Then go.', 'Are you sure?', 'Yes.', 'Good.'];
const ja = ['第一章', '準備はいい？', 'はい。', 'じゃあ行って。', '本当に？', 'うん。', 'よし。'];
const makeLab = async (V, prefix) => {
  const cues = en.map((t, i) => ({ id: prefix + i, videoId: V, en: t, start: i, end: i + 1 }));
  await db.put('videos', { id: V, name: 'Chapter 1' });
  await db.putMany('cues', cues);
  await saveVideoJa(V, new Map(cues.map((c, i) => [c.id, [ja[i]]])), cueStamps(cues));
  return cues;
};
const cues = await makeLab('v_a', 'a');
const labView = async (V, list) => { const w = videoJaView(list, await readVideoJa(V)); return list.map(c => w.get(c)); };
// hand corrections: the SECOND "Yes." and the translation of "Good."; one translation removed
{
  const { rows, groups } = labJaRows(cues, await readVideoJa('v_a')), m = jaModel(rows, groups);
  let s = editText(m, m.initial, 5, 'ああ、確かだ。').state;
  s = editText(m, s, 6, 'よろしい。').state;
  s = editText(m, s, 0, '').state;
  await applyJaChanges('v_a', labJaChanges(rows, groups, jaChanges(m, s)), cueStamps(cues));
}
const data = await exportCorrections({ kind: 'lab', videoId: 'v_a' });
readCorrections(data);
assert.equal(data.items.length, 3);
const yes = data.items.find(i => i.en === 'Yes.');
assert.deepEqual([yes.ja, yes.occurrence, yes.occurrences, yes.before, yes.after], ['ああ、確かだ。', 2, 2, 'Are you sure?', 'Good.']);
assert.deepEqual(yes.cueIds, ['a5']);
assert(data.items.find(i => i.en === 'CHAPTER ONE').removed);
const json = JSON.stringify(data);
assert(!/start|end"|blob|audio/i.test(json.replace(/"note":"[^"]*"/, '')), 'no audio or timings in the file');

// re-import into a material made again (new ids): matched by English + context, the first "Yes." is untouched
const cues2 = await makeLab('v_b', 'z');
const plan = await importCorrections({ kind: 'lab', videoId: 'v_b' }, JSON.parse(json));
assert.equal(plan.matched.length, 3);
assert.deepEqual(plan.matched.find(m => m.item.en === 'Yes.').ids, ['z5']);
await plan.apply();
assert.deepEqual(await labView('v_b', cues2), ['', '準備はいい？', 'はい。', 'じゃあ行って。', '本当に？', 'ああ、確かだ。', 'よろしい。']);
// imported corrections count as hand corrections: a re-match keeps them
await saveVideoJa('v_b', new Map(cues2.map(c => [c.id, ['再照合']])), cueStamps(cues2), { protectManual: true });
assert.deepEqual(await labView('v_b', cues2), ['', '再照合', '再照合', '再照合', '再照合', 'ああ、確かだ。', 'よろしい。']);

// ambiguous duplicates without context are reported, never guessed
const blind = { ...data, materialId: null, items: [{ en: 'Yes.', ja: 'x', occurrence: 1, occurrences: 3, before: null, after: null }] };
const r = matchCorrections(blind, { source: 'lab', materialId: 'v_b', rows: cues2.map(c => ({ id: c.id, en: c.en })) });
assert.equal(r.matched.length, 0);
assert.match(r.skipped[0].reason, /2か所/);

// merge into the original MA English–Japanese JSON (only the corrected items change)
const ma = { chapter: 1, items: en.map((e, i) => ({ en: e, ja: ja[i], note: 'keep' })) };
const merged = applyCorrectionsToMa(ma, data);
assert.equal(merged.applied.length, 3);
assert.deepEqual(merged.data.items.map(i => i.ja), ['', '準備はいい？', 'はい。', 'じゃあ行って。', '本当に？', 'ああ、確かだ。', 'よろしい。']);
assert.equal(merged.data.items[0].note, 'keep');
assert.equal(ma.items[5].ja, 'うん。', 'the original object is not modified');
// MA with a different sentence split: reported as not applicable
const coarse = applyCorrectionsToMa({ items: [{ en: 'Are you sure? Yes.', ja: '本当に？うん。' }, { en: 'Good.', ja: 'よし。' }] }, data);
assert.equal(coarse.applied.length, 1);
assert.equal(coarse.skipped.length, 2);

// Studio: export / import by block ids and context
const SET = 'set_c';
const blocks = en.map((text, i) => newBlock(SET, { id: 'b' + i, text, ja: ja[i], jaOverride: i === 5 }));
blocks[5].ja = 'スタジオで直した。';
let set = { id: SET, title: 'S', order: blocks.map(b => b.id), undo: [], redo: [], updatedAt: 1 };
await sdb.put('sets', set);
await commit(set, '作成', { blocks });
const sdata = await exportCorrections({ kind: 'studio', setId: SET });
assert(sdata.items.some(i => i.itemIds?.[0] === 'b5' && i.ja === 'スタジオで直した。'));
// a Studio correction file applied to the Lab material (no shared ids): English + context
const toLab = await importCorrections({ kind: 'lab', videoId: 'v_b' }, sdata);
assert(toLab.matched.some(m => m.ids[0] === 'z5'));
// a Lab correction file applied to Studio
const toStudio = await importCorrections({ kind: 'studio', setId: SET }, data);
assert.equal(toStudio.matched.length, 3);
await toStudio.apply();
set = await sdb.get('sets', SET);
const live = await liveBlocks(set), view = studioJaView(live);
assert.deepEqual(live.map(b => view.value(b)), ['', '準備はいい？', 'はい。', 'じゃあ行って。', '本当に？', 'ああ、確かだ。', 'よろしい。']);
assert.equal(set.undo.length, 2, 'one undoable Studio operation');
console.log('ja-corrections: export (ids, context, occurrence, no audio), re-import into a re-created material, MA merge, Studio <-> Lab files pass');
