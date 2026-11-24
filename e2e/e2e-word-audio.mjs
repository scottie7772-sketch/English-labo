// 金フレ型: スタジオで照合済み→教材化→ZIP→別の保存領域(別オリジン)へ取り込み→フラッシュカードで元音声を再生
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [dir, portA] = process.argv.slice(2);
const ports = [+portA, +portA + 1, +portA + 2];
const servers = ports.map((p) => spawn('python3', ['-m', 'http.server', String(p), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const mk = async (port, path) => { const ctx = await browser.newContext({ serviceWorkers: 'block' }); const page = await ctx.newPage(); page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); await page.goto(`http://127.0.0.1:${port}/${path}`); await page.waitForTimeout(600); return page; };

// ---- A: スタジオ（照合済みの金フレ型教材）
const A = await mk(ports[0], 'studio.html');
const zipB64 = await A.evaluate(async () => {
  const { sdb, newBlock } = await import('./studio-db.js');
  const { buildMaterial } = await import('./studio-main.js');
  const { writeMaterialPack } = await import('./material-pack.js');
  const sr = 8000, secs = 20, pcm = new Int16Array(sr * secs);
  const tone = (a, b, f) => { for (let i = Math.floor(a * sr); i < b * sr; i++) pcm[i] = 9000 * Math.sin(2 * Math.PI * f * i / sr); };
  tone(1, 2, 440); tone(3, 6, 660); tone(7, 10, 660); tone(12, 13, 520); tone(14, 17, 740);
  const wav = new Uint8Array(44 + pcm.length * 2), dv = new DataView(wav.buffer);
  const w4 = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w4(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w4(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w4(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Uint8Array(wav.buffer, 44).set(new Uint8Array(pcm.buffer));
  const blob = new Blob([wav], { type: 'audio/wav' });
  await sdb.put('sources', { id: 'src1', kind: 'audio', name: 'kinfure-001.wav', size: blob.size, mime: 'audio/wav', duration: secs, stored: true, blob, addedAt: Date.now() });
  const seg = (a, b) => [{ sourceId: 'src1', start: a, end: b }];
  const L = [
    ['put off', 'word', seg(1, 2), 'auto', true, '延期する'],
    ['We put off the meeting until Friday.', 'example', [...seg(3, 6), ...seg(7, 10)], 'auto', true, '会議を延期した。'],   // read twice
    ['take off', 'word', seg(12, 13), 'auto', true, '脱ぐ'],
    ['Please take off your shoes.', 'example', seg(14, 17), 'auto', true, '靴を脱いで。'],
    ['look up', 'word', seg(18, 18.8), 'estimated', false, '調べる'],      // 区間未確定
    ['break down', 'word', [], 'auto', false, '故障する'],               // 音声未割当
  ];
  const blocks = L.map(([text, kind, segments, sync, aligned, ja]) => { const b = newBlock('set1', { text, kind, segments, sync, aligned, ja, rep: segments.length > 1 ? segments.length : undefined }); b.rev = 1; return b; });
  blocks[1].pair = blocks[0].id; blocks[3].pair = blocks[2].id;
  for (const b of blocks) await sdb.put('blocks', b);
  const set = { id: 'set1', title: '金フレ テスト', folder: '', order: blocks.map((b) => b.id), materialType: 'vocab', undo: [], redo: [], sourceId: 'src1', createdAt: Date.now(), updatedAt: Date.now() };
  await sdb.put('sets', set);
  // スタジオ単体の保存領域だけでも索引から元音声が引ける（反復の例文を含む）
  const wa = await import('./word-audio.js'); await wa.prepare(true);
  window.__studioStatus = ['put off', 'We put off the meeting until Friday.', 'look up', 'break down'].map((t) => wa.status(t));
  window.__studioFind = wa.find('We put off the meeting until Friday.');
  const { manifest, material, media } = await buildMaterial(set, { contents: 'both' });
  const files = new Map(media.map((m) => [m.id, m.blob]));
  const zip = await writeMaterialPack(manifest, material, files);
  const buf = new Uint8Array(await zip.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
  return btoa(s);
});
const st = await A.evaluate(() => ({ s: window.__studioStatus, f: window.__studioFind }));
ok(JSON.stringify(st.s) === JSON.stringify(['orig', 'orig', 'unsure', 'tts']), 'スタジオ単体: 元音声あり/反復の例文も元音声/区間未確定/音声なし ' + JSON.stringify(st.s));
ok(st.f && st.f.start === 3 && st.f.end === 6, '反復の例文は正常な1回目(3〜6秒)を選ぶ ' + JSON.stringify(st.f && [st.f.start, st.f.end]));

// ---- B: 別の保存領域（別オリジン）へ取り込み。direct=false(ZIPを選ぶ) と direct=true(一括教材化ZIP/Englabo転送)
for (const [port, direct] of [[ports[1], false], [ports[2], true]]) {
  const label = direct ? '直接取り込み(mediaRef)' : 'ZIP取り込み';
  const B = await mk(port, 'index.html');
  await B.evaluate(() => { window.__plays = []; const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__plays.push({ src: this.currentSrc || this.src, t: this.currentTime, muted: this.muted }); return orig.apply(this, arguments).catch(() => {}); }; });
  const res = await B.evaluate(async ({ b64, direct }) => {
    const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const { readMaterialImport } = await import('./material-pack.js');
    const { importMaterial } = await import('./video.js');
    const { db } = await import('./db.js');
    const { newWord, saveWord } = await import('./words.js');
    const w = newWord({ headword: 'put off' }); await saveWord(w);
    const before = JSON.stringify(await db.get('words', w.id));
    const pack = await readMaterialImport(new File([u8], 'kf.elpack.zip', { type: 'application/zip' }));
    await importMaterial(pack.manifest, pack.material, pack.getFile, direct ? { askUpdate: false, direct: true, archive: true, update: false } : {});
    const vids = await db.all('videos'), keys = [];
    const wa = await import('./word-audio.js'); await wa.prepare(true);
    const texts = ['put off', 'We put off the meeting until Friday.', 'take off', 'Please take off your shoes.', 'look up', 'break down'];
    const out = { vid: vids.map((v) => ({ id: v.id, mediaRef: v.mediaRef || null, hasOwnBlob: false })), status: texts.map((t) => wa.status(t)), find: wa.find('We put off the meeting until Friday.'), before, wordId: w.id };
    out.hasOwn = !!(await db.get('vblobs', vids[0].id));
    return out;
  }, { b64: zipB64, direct });
  ok(JSON.stringify(res.status) === JSON.stringify(['orig', 'orig', 'orig', 'orig', 'unsure', 'tts']), `${label}: 状態 ${JSON.stringify(res.status)}`);
  if (direct) ok(!!res.vid[0].mediaRef && !res.hasOwn, `${label}: 音声は mediaRef 側にだけある（以前はここで見失っていた）`); else ok(res.hasOwn, `${label}: 音声は動画IDの下にある`);
  ok(res.find && res.find.start === 3 && res.find.end === 6, `${label}: 例文は1回目(3〜6秒)`);
  // フラッシュカード: fc2Voice → 元音声を再生し、合成音声(TTS)は呼ばない
  const play = await B.evaluate(async () => {
    const { fc2Voice } = await import('./swipecard.js');
    let tts = 0; const root = document.createElement('div'); document.body.append(root);
    const v = fc2Voice(root, () => { tts++; return null; });
    await new Promise((r) => setTimeout(r, 800));
    v.tap('We put off the meeting until Friday.'); await new Promise((r) => setTimeout(r, 1500));
    const p = window.__plays.at(-1); let size = null, magic = null;
    if (p?.src) { const blob = await (await fetch(p.src)).blob(); size = blob.size; magic = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 4).arrayBuffer())); }
    v.tap('put off'); await new Promise((r) => setTimeout(r, 1200));
    return { tts, plays: window.__plays.length, p, size, magic, p2: window.__plays.at(-1) };
  });
  ok(play.tts === 0 && play.plays >= 2, `${label}: カードで元音声を再生（合成音声は0回） tts=${play.tts} plays=${play.plays}`);
  ok(play.magic === 'RIFF' && play.size > 100000, `${label}: 再生した音声は教材の元ファイル(WAV ${play.size}B)`);
  ok(Math.abs(play.p.t - 2.94) < .3 && Math.abs(play.p2.t - 0.94) < .3, `${label}: 開始位置が区間どおり(例文3秒/見出し1秒) ${play.p.t.toFixed(2)} / ${play.p2.t.toFixed(2)}`);
  // 状態の可視化: 区間未確定・音声なしは合成音声へ。区間未確定は理由を表示
  const fb = await B.evaluate(async () => {
    const { fc2Voice } = await import('./swipecard.js'); let tts = 0; const root = document.createElement('div'); document.body.append(root);
    const v = fc2Voice(root, () => { tts++; return null; }); await new Promise((r) => setTimeout(r, 800));
    v.tap('look up'); await new Promise((r) => setTimeout(r, 500));
    return { tts, toast: document.querySelector('#toast')?.textContent || '' };
  });
  ok(fb.tts === 1 && /区間未確定/.test(fb.toast), `${label}: 区間未確定は合成音声に切り替え、理由を表示 "${fb.toast}"`);
  // 音声参照切れ: 音声データを消すと「参照切れ」と表示して読み上げ
  const br = await B.evaluate(async () => {
    const { db } = await import('./db.js'); for (const v of await db.all('videos')) { await db.delete('vblobs', v.id); if (v.mediaRef) await db.delete('vblobs', v.mediaRef); }
    const wa = await import('./word-audio.js'); await wa.prepare(true);
    const { fc2Voice } = await import('./swipecard.js'); let tts = 0; const root = document.createElement('div'); document.body.append(root);
    const v = fc2Voice(root, () => { tts++; return null; }); await new Promise((r) => setTimeout(r, 800));
    await new Promise((r) => setTimeout(r, 1700)); v.tap('take off'); await new Promise((r) => setTimeout(r, 600));
    return { st: wa.status('take off'), tts, toast: document.querySelector('#toast')?.textContent || '' };
  });
  ok(br.st === "broken" && br.tts === 1 && /参照切れ/.test(br.toast), `${label}: 音声が無い→参照切れ表示＋読み上げ "${br.toast}"`);
  const after = await B.evaluate(async (id) => { const { db } = await import('./db.js'); return JSON.stringify(await db.get('words', id)); }, res.wordId);
  ok(after === res.before, `${label}: 既存の単語レコード（学習記録）は書き換わらない`);
  ok(!B.errs.length, `${label}: ページエラーなし ${JSON.stringify(B.errs.slice(0, 2))}`);
}
ok(!A.errs.length, 'スタジオ: ページエラーなし ' + JSON.stringify(A.errs.slice(0, 2)));
await browser.close(); servers.forEach((s) => s.kill());
console.log(fails ? `${fails} 件失敗` : '全て成功'); process.exit(fails ? 1 : 0);
