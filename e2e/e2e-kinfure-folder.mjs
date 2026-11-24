// フォルダ一括: 3本の音声(うち1か所欠落・1か所は意図的な重複)。全体スクリプトは貼り付けで1回だけ登録。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [dir, port] = process.argv.slice(2);
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const syl = ['ba','ko','ri','mel','tan','sur','vo','fen','dil','ark','pon','lu','mir','ted','gra','wen'];
const word = () => { let w = ''; for (let i = 0, n = 2 + Math.floor(rnd() * 2); i < n; i++) w += syl[Math.floor(rnd() * syl.length)]; return w; };
const groups = [], lines = [];
for (let n = 1; n <= 300; n++) { const h = word() + ' ' + word(); const ex = [0, 1].map(() => [h.split(' ')[0], ...Array.from({ length: 5 }, word)].join(' ') + '.'); groups.push({ n, h, ex }); lines.push(`${n}. ${h}`, ...ex); }
const cuesFor = (a, b) => { const out = []; let t = 2; for (let n = a; n <= b; n++) { const g = groups[n - 1]; out.push({ text: g.h, start: t, end: t += 1.2 }); t += .8; for (const e of g.ex) { out.push({ text: rnd() < .15 ? e.replace(/\w+(?=\.$)/, 'qqz') : e, start: t, end: t += 3 }); t += 1; } } return out; };
const sets = [['s1', '金フレ 001', cuesFor(1, 60)], ['s2', '金フレ 002', cuesFor(61, 110)], ['s3', '金フレ 003', cuesFor(120, 200)], ['s4', '金フレ 004', cuesFor(190, 240)]];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/studio.html`); await page.waitForSelector('#main');
await page.evaluate(async (sets) => {
  const { sdb, newBlock } = await import('./studio-db.js');
  const wav = new Blob([new Uint8Array(44 + 3200)], { type: 'audio/wav' });
  for (const [id, title, cues] of sets) {
    await sdb.put('sources', { id: 'src' + id, kind: 'audio', name: title + '.m4a', size: wav.size, mime: 'audio/wav', duration: 900, stored: true, blob: wav, addedAt: Date.now() });
    const bl = cues.map((c) => { const b = newBlock(id, { text: c.text, asr: true, segments: [{ sourceId: 'src' + id, start: c.start, end: c.end }], sync: 'auto' }); b.rev = 1; return b; });
    for (const b of bl) await sdb.put('blocks', b);
    await sdb.put('sets', { id, title, folder: '金フレ', order: bl.map((b) => b.id), undo: [], redo: [], sourceId: 'src' + id, createdAt: Date.now() + sets.findIndex((s) => s[0] === id), updatedAt: Date.now() });
  }
  await sdb.put('meta', { key: 'studio-folders', folders: [{ id: 'fold1', name: '金フレ', order: sets.map((s) => s[0]) }] });
}, sets);
await page.evaluate(() => { location.hash = '#sets?folder=fold1'; });
await page.waitForSelector('#folderMenu'); await page.click('#folderMenu'); await page.waitForSelector('button[value="kfLocate"]');
await page.click('button[value="kfLocate"]');
await page.waitForSelector('#kfFile');
await page.fill('#kfText', lines.join('\n'));
await page.click('button[value="ok"]');
await page.waitForSelector('#kfRows', { timeout: 60000 });
const view = await page.evaluate(() => ({ labels: [...document.querySelectorAll('[id^=kfL]')].map((e) => e.textContent), rep: document.querySelector('#kfRep').innerText, applied: [...document.querySelectorAll('[data-ap]')].map((e) => e.checked) }));
console.log(JSON.stringify(view, null, 1));
// 手動で2本目の終了番号を直す → 報告が更新される
await page.fill('[data-b="1"]', '115'); await page.waitForTimeout(100);
console.log('手動修正後', await page.evaluate(() => ({ l: document.querySelector('#kfL1').textContent, rep: document.querySelector('#kfRep').innerText })));
await page.click('button[value="ok"]');
await page.waitForFunction(() => /に範囲を適用しました/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 60000 });
console.log(await page.evaluate(() => document.querySelector('#toast').textContent));
const res = await page.evaluate(async () => {
  const { sdb } = await import('./studio-db.js'); const out = {};
  for (const id of ['s1', 's2', 's3', 's4']) { const s = await sdb.get('sets', id); const bl = (await sdb.byIndex('blocks', 'setId', id)).filter((b) => !b.deleted); out[id] = { kf: s.kfRange && `${s.kfRange.startN}-${s.kfRange.endN}${s.kfRange.manual ? '(手動)' : ''}`, script: bl.filter((b) => b.script).length, asr: bl.filter((b) => b.asr).length, orderLen: s.order.length === bl.length, undo: s.undo.length };
    const ord = s.order.map((i) => bl.find((b) => b.id === i)).filter((b) => b?.script).map((b) => b.kf.i); out[id].sorted = ord.every((v, i) => !i || v > ord[i - 1]); }
  out.folderScripts = (await sdb.all('meta')).filter((m) => m.key.startsWith('studio-folder-kf:')).length; return out; });
console.log(JSON.stringify(res));
console.log('errors', JSON.stringify(errors)); await browser.close(); server.kill();
