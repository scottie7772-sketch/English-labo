// Full backup ZIP: JSON + media files round trip (Node, in-memory db). Run: node full-backup-zip.mjs
import assert from 'node:assert/strict';
globalThis.addEventListener = () => {};
globalThis.window = {};
globalThis.document = { addEventListener(){}, querySelector(){return null;} };
const { db } = await import('../db.js');
const B = await import('../backup.js');
const names = ['words','mastery','masteryChanges','reviews','sessions','attempts','decks','grammar','listening','speaking','videos','vblobs','cues','videoJa','imports','settings','meta'];
const rec = Object.fromEntries(names.map(n => [n, new Map()]));
const keyOf = (n, r) => r.id ?? r.key;
db.all = async s => [...rec[s].values()];
db.keys = async s => [...rec[s].keys()];
db.get = async (s, k) => rec[s].get(k);
db.put = async (s, r) => rec[s].set(keyOf(s, r), r);
db.tx = async (stores, mode, fn) => fn({ objectStore: n => ({ clear: () => rec[n].clear(), put: r => rec[n].set(keyOf(n, r), r) }) });

const audio = new Blob([Uint8Array.from({ length: 5000 }, (_, i) => i % 251)], { type: 'audio/mp4' });
const video = new Blob([Uint8Array.from({ length: 9000 }, (_, i) => (i * 7) % 253)], { type: 'video/mp4' });
rec.videos.set('v1', { id: 'v1', title: 'Master & Apprentice 1', blob: video });   // legacy blob field must be dropped from JSON
rec.cues.set('c1', { id: 'c1', videoId: 'v1', text: 'There is no emotion—there is peace.' });
rec.videoJa.set('j1', { id: 'j1', materialId: 'v1', ja: '感情はない。あるのは平穏だ。' });
rec.vblobs.set('v1', { id: 'v1', blob: video, size: video.size, at: 111 });
rec.vblobs.set('a1', { id: 'a1', blob: audio, size: audio.size, at: 222 });
rec.vblobs.set('empty', { id: 'empty', blob: new Blob([]), size: 0 });   // broken record is skipped
rec.words.set('w1', { id: 'w1', headword: 'peace' });

const out = await B.buildFullBackupZip();
assert.equal(out.mediaCount, 2);
assert.match(out.file.name, /^ell-full-backup-\d{12}\.zip$/);
assert.equal(out.file.type, 'application/zip');

// wipe everything, then restore from the ZIP file
for (const n of names) rec[n].clear();
const full = await B.readFullBackupZip(out.file);
assert.equal(B.validateBackup(full.backup).ok, true);
const r = await B.restoreFullBackup(full);
assert.deepEqual([r.restored, r.failed.length], [2, 0]);
assert.equal(rec.cues.get('c1').text, 'There is no emotion—there is peace.');
assert.equal(rec.videoJa.get('j1').ja, '感情はない。あるのは平穏だ。');
assert.equal(rec.words.get('w1').headword, 'peace');
assert.equal(rec.videos.get('v1').blob, undefined);
const same = async (a, b) => Buffer.compare(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())) === 0;
assert.ok(await same(rec.vblobs.get('v1').blob, video) && rec.vblobs.get('v1').blob.type === 'video/mp4' && rec.vblobs.get('v1').at === 111);
assert.ok(await same(rec.vblobs.get('a1').blob, audio) && rec.vblobs.get('a1').blob.type === 'audio/mp4');
assert.equal(rec.vblobs.has('empty'), false);
assert.equal(rec.meta.get('lastBackupAt') !== undefined, true);

// rejects a plain JSON-backup-like zip and a truncated zip
const { zipWrite } = await import('../common-pack.js');
await assert.rejects(B.readFullBackupZip(await zipWrite([{ name: 'x.txt', data: 'hi' }])), /完全バックアップ/);
await assert.rejects(B.readFullBackupZip(out.file.slice(0, 200)), /ZIP/);

// damaged media entry (size mismatch) is refused before anything is changed
const bad = await zipWrite([{ name: 'manifest.json', data: JSON.stringify({ ...full.manifest, media: [{ ...full.manifest.media[0], size: 1 }] }) }, { name: 'backup.json', data: JSON.stringify(full.backup) }, { name: full.manifest.media[0].path, data: audio }]);
await assert.rejects(B.readFullBackupZip(bad), /欠けています/);

// save: share sheet when available, download link otherwise
let shared = null;
const setNav = v => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
setNav( { canShare: () => true, share: async (d) => { shared = d; } });
assert.equal(await B.saveFileNow(out.file), 'shared'); assert.equal(shared.files[0].name, out.file.name);
setNav({ canShare: () => true, share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
assert.equal(await B.saveFileNow(out.file), 'cancelled');
let clicked = 0;
globalThis.URL.createObjectURL = () => 'blob:x'; globalThis.URL.revokeObjectURL = () => {};
globalThis.document = { createElement: () => ({ click: () => clicked++, remove(){} }), body: { appendChild(){} } };
setNav({});
assert.equal(await B.saveFileNow(out.file), 'downloaded'); assert.equal(clicked, 1);
console.log('full-backup-zip: ok');
