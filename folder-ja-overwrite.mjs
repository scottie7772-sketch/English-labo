import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { db } = await import('../db.js');
const { readStudioJaFiles, readStudioJaText, planStudioJa, studioJaView, confirmStudioJa } = await import('../studio-ja.js');
const { mergeFolderJaSections } = await import('../studio-folders.js');
const { saveVideoJa, cueStamps, readVideoJa, videoJaView, studioJaPatch, labJaRows, labJaChanges, applyJaChanges, readJaHistory, revertJaHistory } = await import('../video-ja.js');
const { planLabJa } = await import('../lab-ja-batch.js');
const { jaModel, jaChanges } = await import('../ja-position.js');

// ---------- JSON: one file, several chapters in one file, pasted text ----------
const ch = (chapter, rows) => ({ chapter, items: rows.map(([en, ja]) => ({ en, ja })) });
const bundle = [ch(1, [['CHAPTER ONE', '第1章'], ['The door opened.', 'ドアが開いた。']]), ch(2, [['CHAPTER TWO', '第2章'], ['She smiled.', '彼女は微笑んだ。']])];
let sections = await readStudioJaFiles([new File([JSON.stringify(bundle)], 'book.json')]);
assert.deepEqual(sections.map(s => [s.name, s.data.chapter]), [['book.json#1', 1], ['book.json#2', 2]]);
assert.equal((await readStudioJaFiles([new File([JSON.stringify({ chapters: bundle })], 'b.json')])).length, 2);
assert.equal((await readStudioJaText(JSON.stringify(bundle[0]))).length, 1);
await assert.rejects(readStudioJaText('  '), /貼り付け/);
await assert.rejects(readStudioJaText(JSON.stringify([ch(1, [['a', 'b']]), { chapter: 2, items: [{ en: 1 }] }])), /2番目の章/);
// registering the same file again updates it (folder data: add / update by name)
const v2 = await readStudioJaText(JSON.stringify(ch(2, [['CHAPTER TWO', '第2章'], ['She smiled.', '彼女はほほえんだ。']])), 'book.json#2');
const merged = mergeFolderJaSections(sections, v2);
assert.equal(merged.length, 2);
assert.equal(merged.find(s => s.data.chapter === 2).data.items[1].ja, '彼女はほほえんだ。');

// ---------- Studio: missing / re-match / overwrite / overwrite including hand corrections ----------
const set = { id: 'set1' };
const stamp = t => { let v = 2166136261; for (let i = 0; i < t.length; i++) v = Math.imul(v ^ t.charCodeAt(i), 16777619); return v >>> 0; };
const rows = [
  { id: 'a', text: 'First line here.', ja: '教材に元からあった訳' },                                   // came with the material
  { id: 'b', text: 'Second line here.', ja: '', jaImport: { owner: 'b', members: [{ id: 'b', stamp: stamp('Second line here.') }], texts: ['以前の英日データ'] } },
  { id: 'c', text: 'Third line here.', ja: '手で直した訳', jaOverride: true },                           // hand correction
  { id: 'd', text: 'Fourth line here.', ja: '' },                                                     // no translation
  { id: 'e', text: 'Fifth line here.', ja: 'データにない行の訳' },
];
const data = [{ name: 'new.json', index: 0, data: { items: rows.slice(0, 4).map((r, i) => ({ en: r.text, ja: '新しい訳' + i })) } }];
const changed = opts => planStudioJa(set, rows, data, opts).changes.map(r => r.id).sort();
const valueAfter = opts => { const plan = planStudioJa(set, rows, data, opts), up = new Map(plan.changes.map(r => [r.id, r])); const all = rows.map(r => up.get(r.id) || r); const v = studioJaView(all); return all.map(r => v.value(r)); };
assert.deepEqual(changed({ missingOnly: true }), ['d']);
assert.deepEqual(changed({}), ['b', 'd']);
assert.deepEqual(changed({ overwrite: 'imported' }), ['a', 'b', 'd']);
assert.deepEqual(changed({ overwrite: 'all' }), ['a', 'b', 'c', 'd']);
assert.deepEqual(valueAfter({ overwrite: 'imported' }), ['新しい訳0', '新しい訳1', '手で直した訳', '新しい訳3', 'データにない行の訳']);
assert.deepEqual(valueAfter({ overwrite: 'all' }), ['新しい訳0', '新しい訳1', '新しい訳2', '新しい訳3', 'データにない行の訳']);
const over = planStudioJa(set, rows, data, { overwrite: 'all' }).changes.find(r => r.id === 'c');
assert(!over.jaOverride && over.ja === '', 'an overwritten hand row becomes an imported row');
// overwritten rows can be re-matched later (they are no longer treated as hand-made)
const after = rows.map(r => planStudioJa(set, rows, data, { overwrite: 'imported' }).changes.find(x => x.id === r.id) || r);
assert.deepEqual(planStudioJa(set, after, [{ name: 'n2', index: 0, data: { items: [{ en: rows[0].text, ja: '再更新' }] } }], {}).changes.map(r => r.id), ['a']);

// ---------- Video Lab: the same choices on a material ----------
const V = 'v1';
const cues = ['First line here.', 'Second line here.', 'Third line here.', 'Fourth line here.', 'Fifth line here.']
  .map((en, i) => ({ id: 'c' + i, videoId: V, en, start: i, end: i + 1, itemId: 'b' + i, studioOrder: i }));
await db.put('videos', { id: V, name: 'Lab', from: { material: 'set1' } });
await db.putMany('cues', cues);
// c0: from the Studio transfer; c1: from an earlier data file; c2: corrected by hand; c3: none; c4: from the Studio, not in the data
await saveVideoJa(V, studioJaPatch(cues, [{ ids: ['b0'], texts: ['スタジオの訳'] }, { ids: ['b4'], texts: ['スタジオの訳4'] }]), cueStamps(cues), { fromStudio: true });
await saveVideoJa(V, new Map([['c1', ['以前の英日データ']]]), cueStamps(cues));
{ const r = labJaRows(cues, await readVideoJa(V)), m = jaModel(r.rows, r.groups); const own = m.initial.own.slice(); own[2] = '手で直した訳';
  await applyJaChanges(V, labJaChanges(r.rows, r.groups, jaChanges(m, { ...m.initial, own })), cueStamps(cues)); }
const labData = [{ name: 'new.json', index: 0, data: { items: cues.slice(0, 4).map((c, i) => ({ en: c.en, ja: 'L' + i })) } }];
const lab = async opts => planLabJa({ id: V, from: { material: 'set1' } }, cues, await readVideoJa(V), labData, opts).changes.map(c => c.cueId).sort();
assert.deepEqual(await lab({ mode: 'missing' }), ['c3']);
assert.deepEqual(await lab({ mode: 'rematch' }), ['c1', 'c3']);
assert.deepEqual(await lab({ mode: 'overwrite' }), ['c0', 'c1', 'c3']);
assert.deepEqual(await lab({ mode: 'overwrite', all: true }), ['c0', 'c1', 'c2', 'c3']);
// data written for the Studio set id is accepted; another material's data is not
assert.equal(planLabJa({ id: V, from: { material: 'set1' } }, cues, await readVideoJa(V), [{ name: 'x', index: 0, data: { materialId: 'set1', items: [{ en: cues[3].en, ja: 'X' }] } }]).changes.length, 1);
assert.equal(planLabJa({ id: V, from: { material: 'set1' } }, cues, await readVideoJa(V), [{ name: 'x', index: 0, data: { materialId: 'other', items: [{ en: cues[3].en, ja: 'X' }] } }]).changes.length, 0);
// apply (overwrite incl. hand) as one history entry, then undo it
const plan = planLabJa({ id: V, from: { material: 'set1' } }, cues, await readVideoJa(V), labData, { mode: 'overwrite', all: true });
await applyJaChanges(V, plan.changes, cueStamps(cues), { mode: 'import', label: '英日データを反映' });
const show = async () => { const w = videoJaView(cues, await readVideoJa(V)); return cues.map(c => w.get(c)); };
assert.deepEqual(await show(), ['L0', 'L1', 'L2', 'L3', 'スタジオの訳4']);
const links = (await readVideoJa(V)).filter(r => r.cueId);
assert(!links.find(l => l.cueId === 'c2').manual, 'overwritten by data: no longer a hand correction');
const hist = await readJaHistory(V);
assert.equal(hist[0].label, '英日データを反映');
await revertJaHistory(V, hist[0].id);
assert.deepEqual(await show(), ['スタジオの訳', '以前の英日データ', '手で直した訳', '', 'スタジオの訳4']);
assert((await readVideoJa(V)).find(r => r.cueId === 'c2').manual, 'undo restores the hand flag');
assert(JSON.stringify(await db.byIndex('cues', 'videoId', V)) === JSON.stringify(cues), 'subtitles and timings unchanged');
console.log('folder-ja-overwrite: JSON (several chapters, paste, update by name), Studio and Lab missing / re-match / overwrite / incl. hand corrections, undo pass');
