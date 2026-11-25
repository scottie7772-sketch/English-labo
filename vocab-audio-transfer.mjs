import assert from 'node:assert/strict';
import './fake-idb.mjs';
globalThis.addEventListener = () => {};
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, querySelector() { return { textContent: '', hidden: true }; } };
const { importMaterial } = await import('../video.js');
const { db } = await import('../db.js');
const B = await import('../backup.js');
const { loadLabMaterial } = await import('../audio-words-ui.js');
const P = await import('../vocab-audio-pipeline.js');
const { resolveAudio } = await import('../word-audio-resolve.js');
const { refBlob, referencedMedia } = await import('../audio-refs.js');

const audio = new Blob([new Uint8Array(3000).fill(7)], { type: 'audio/wav' });
const items = [
  { id: 'h1', text: 'allocate', studySet: 'h1', role: 'word', confirmed: true, sync: 'auto', segments: [{ media: 'a1', start: 1, end: 1.6 }] },
  { id: 'e1', text: 'We allocate funds to each team.', studySet: 'h1', role: 'example', confirmed: true, sync: 'auto', segments: [{ media: 'a1', start: 2, end: 4 }] },
  { id: 'h2', text: 'compromise', studySet: 'h2', role: 'word', sync: 'auto', segments: [{ media: 'a1', start: 8, end: 8.7 }] },             // 旧い送り方: 確定かどうかの情報がない
  { id: 'r1', text: 'a locate', asr: true, sync: 'auto', segments: [{ media: 'a1', start: 12, end: 12.6 }] },                                // 文字起こしのまま
  { id: 'h3', text: 'estimate', studySet: 'h3', role: 'word', sync: 'estimated', segments: [{ media: 'a1', start: 15, end: 15.6 }] },
];
const mat = (extra = {}) => ({ set: { folder: 'F', materialType: 'vocab', ...extra }, media: [{ id: 'a1', name: 'k.wav', kind: 'audio', mime: 'audio/wav', size: 3000, duration: 30, included: true }], items });

// 直接の転送とZIP（教材パック）のどちらも、同じ取り込みで、確定／文字起こしの区別を持ち込む
const direct = await importMaterial({ materialId: 'set-d', title: 'Direct', packId: 'p' }, mat(), () => audio, { askUpdate: false, direct: true });
assert.equal((await db.all('vblobs')).length, 1);
const packed = await importMaterial({ materialId: 'set-p', title: 'Packed', packId: 'p' }, mat(), () => audio, { askUpdate: false, direct: false });
for (const v of [direct, packed]) {
  const cues = await db.byIndex('cues', 'videoId', v.id);
  const by = Object.fromEntries(cues.map(c => [c.en, c]));
  assert.equal(by.allocate.confirmed, true); assert.equal(by['We allocate funds to each team.'].confirmed, true);
  assert.equal(by.compromise.confirmed, undefined, '確定の情報がない行は、確定にしない');
  assert.equal(by['a locate'].asr, true); assert.equal(by['a locate'].confirmed, undefined);
}
assert.equal((await db.all('vblobs')).length, 2, '録音は教材ごとに1つ（行や単語ごとには増えない）');

// Lab だけ（スタジオの教材がなくても）で、確定した見出し語の音声を作れる
const m = await loadLabMaterial(direct.id);
const row = Object.fromEntries(m.rows.map(r => [r.text, r]));
assert.deepEqual([row.allocate.confirmed, row.compromise.confirmed, row.estimate.estimated], [true, false, true]);
assert.equal(m.rows.some(r => r.text === 'a locate'), true);
assert.deepEqual(m.evidence.map(e => e.text), ['a locate'], '文字起こしのままの行は、再照合の証拠として使う');
const r = await P.runPipeline({ kind: 'lab', id: direct.id }, {}, {});
const H = Object.fromEntries(r.items.map(i => [i.head, i]));
assert.equal(H.allocate.state, 'confirmed');
assert.notEqual(H.compromise.state, 'confirmed', '旧い送り方の行は、Labだけでは確定にしない（スタジオから送り直すと確定の情報が付く）');
assert.notEqual(H.estimate.state, 'confirmed');
assert.equal(r.rec.profile, 'kinfure');

// 登録 → バックアップ（JSON + 録音のZIP）→ 全消去 → 復元 → 再生できる
await P.registerRecord('lab', direct.id);
const word = (await db.all('words')).find(w => w.headword === 'allocate');
const dv = await db.get('videos', direct.id);
assert.equal(word.audio.word.src.key, dv.mediaRef || dv.id, '参照するのは録音の保存キー（ファイル名でも字幕IDでもない）'); assert.equal(word.audio.example.end, 4);
const zip = await B.buildFullBackupZip();
assert.equal(zip.mediaCount, 2);
const { STORES } = await import('../db.js');
for (const n of Object.keys(STORES)) await db.clear(n);
assert.equal(await refBlob(word.audio.word.src), null, '消した直後は参照切れ（録音がない）');
const restored = await B.restoreFullBackup(await B.readFullBackupZip(zip.file));
assert.equal(restored.failed.length, 0);
const back = (await db.all('words')).find(w => w.headword === 'allocate');
assert.equal((await refBlob(back.audio.word.src)).size, 3000, '復元後に、同じ参照から録音を取り出せる');
assert.equal(resolveAudio(back).via, 'ref');
assert.equal((await db.all('vblobs')).length, 2);

// JSONだけのバックアップ（録音なし）を復元した場合: 参照は残り、録音がないので「参照切れ」と分かる
const json = JSON.parse(JSON.stringify(await B.buildBackup()));
assert(json.data.words[0].audio.word.src.key && !json.data.vblobs, '参照は単語に入り、録音はJSONに入らない');
await db.clear('vblobs');
await B.restoreBackup(json);
const lost = (await db.all('words')).find(w => w.headword === 'allocate');
assert.equal(await refBlob(lost.audio.word.src), null);
assert.equal(resolveAudio(lost).via, 'ref', '参照そのものは残る（再生時に録音がなければ音声なしとして扱う）');
console.log('vocab-audio-transfer: flags carried by direct transfer and pack import, one stored recording, Lab-only confirmed items, old transfers stay unconfirmed, full backup / JSON backup keep the references pass');
