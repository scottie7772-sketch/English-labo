// 金フレ範囲特定: 実ブラウザでの検証と計測。node kf-e2e.mjs <appDir> <port> <label> [applyRange]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [dir, port, label, apply = ''] = process.argv.slice(2);
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const syl = ['ba','ko','ri','mel','tan','sur','vo','fen','dil','ark','pon','lu','mir','ted','gra','wen'];
const word = () => { let w = ''; for (let i = 0, n = 2 + Math.floor(rnd() * 2); i < n; i++) w += syl[Math.floor(rnd() * syl.length)]; return w; };
const N = 2000, script = [], groups = [];
for (let n = 1; n <= N; n++) {
  const h = word() + (rnd() < .4 ? ' ' + word() : ''); const g = { n, h, ex: [] };
  script.push({ text: `${n}. ${h}`, ja: '訳' + n, kind: 'word' });
  for (let e = 0, m = 2 + Math.floor(rnd() * 2); e < m; e++) { const t = [h.split(' ')[0], ...Array.from({ length: 5 }, word)].join(' ') + '.'; script.push({ text: t, ja: '例' + n, kind: 'example' }); g.ex.push(t); }
  groups.push(g);
}
// 12分の音声: 番号1201〜1260 を読んだ文字起こし（見出し語は正確、例文は一部を聞き間違い）
const asr = []; let t = 2;
for (let n = 1201; n <= 1260; n++) { const g = groups[n - 1]; asr.push({ text: g.h, start: t, end: t += 1.2 }); t += .8;
  for (const ex of g.ex) { asr.push({ text: rnd() < .2 ? ex.replace(/\w+(?=\.$)/, 'zzq') : ex, start: t, end: t += 3.5 }); t += 1; } }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const url = `http://127.0.0.1:${port}/studio.html`;
await page.goto(url); await page.waitForSelector('#main');
await page.evaluate(async ({ script, asr }) => {
  const db = await import('./studio-db.js');
  const { sdb, newBlock } = db;
  const wav = new Blob([new Uint8Array(44 + 32000)], { type: 'audio/wav' });
  await sdb.put('sources', { id: 'src1', kind: 'audio', name: '金フレ_CD1_001.m4a', size: wav.size, mime: 'audio/wav', duration: 720, stored: true, blob: wav, addedAt: Date.now() });
  const blocks = [];
  script.forEach((l) => blocks.push(newBlock('setA', { text: l.text.replace(/^\d+\.\s*/, ''), ja: l.ja, script: true, kind: l.kind, sync: 'auto' })));
  asr.forEach((c) => blocks.push(newBlock('setA', { text: c.text, asr: true, segments: [{ sourceId: 'src1', start: c.start, end: c.end }], sync: 'auto' })));
  for (const b of blocks) { b.rev = 1; await sdb.put('blocks', b); }
  const set = { id: 'setA', title: '金フレ CD1 001', folder: '金フレ', order: blocks.map((b) => b.id), undo: [], redo: [], sourceId: 'src1', createdAt: Date.now(), updatedAt: Date.now() };
  await sdb.put('sets', set);
  await sdb.put('meta', { key: 'studio-folders', folders: [{ id: 'fold1', name: '金フレ', order: ['setA'] }] });
}, { script, asr });
const gc = async () => { const c = await ctx.newCDPSession(page); await c.send('HeapProfiler.collectGarbage'); await c.detach(); };
const stats = async (tag) => {
  await gc();
  return page.evaluate(async (tag) => {
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { sdb, liveBlocks, commit } = await import('./studio-db.js');
    const rowsDom = document.querySelectorAll('.st-row').length, nodes = document.getElementsByTagName('*').length;
    let tv = 0; for (let i = 0; i < 4; i++) { const t0 = performance.now(); document.querySelector('#viewB').click(); await raf(); tv += performance.now() - t0; }
    const set = await sdb.get('sets', 'setA');
    let t0 = performance.now(); const live = await liveBlocks(set); const tLoad = performance.now() - t0;
    const target = live.find((b) => b.asr);
    t0 = performance.now(); await commit(set, '計測用の編集', { blocks: [{ ...target, text: target.text + ' ' }] }, {}); const tCommit = performance.now() - t0;
    t0 = performance.now(); await commit(set, '計測用の編集(戻す)', { blocks: [{ ...(await sdb.get('blocks', target.id)), text: target.text }] }, {}); const tCommit2 = performance.now() - t0;
    return { tag, blocks: live.length, rowsDom, domNodes: nodes, viewSwitchMs: +(tv / 4).toFixed(0), loadBlocksMs: +tLoad.toFixed(0), commitMs: +((tCommit + tCommit2) / 2).toFixed(0), heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) };
  }, tag);
};
const open = async () => {
  const t0 = Date.now();
  await page.evaluate(() => { location.hash = '#set?id=setA'; });
  await page.waitForSelector('#list .st-row, #list .empty', { timeout: 120000 });
  await page.waitForTimeout(400);
  return Date.now() - t0;
};
const openMs = await open();
const before = await stats('全体スクリプト'); before.openMs = openMs;
console.log(label, JSON.stringify(before));
if (apply) {
  await page.reload(); await page.waitForSelector('#main'); await open();
  const pre = await page.evaluate(() => document.querySelector('#dialog[open]')?.innerText?.slice(0, 200)); if (pre) { console.log('起動時のダイアログ:', pre); await page.evaluate(() => document.querySelector('#dialog').close()); }
  await page.click('#moreB'); await page.waitForSelector('#dialog[open]');
  await page.click('button[value="kfRange"]');
  await page.waitForSelector('#kfFile');
  await page.click('button[value="set"]');           // この教材のスクリプト行から作る
  await page.waitForSelector('#kfRows', { timeout: 60000 });
  const shown = await page.evaluate(() => ({ label: document.querySelector('#kfL0')?.textContent, rep: document.querySelector('#kfRep')?.textContent, a: document.querySelector('[data-a="0"]')?.value, b: document.querySelector('[data-b="0"]')?.value, ap: document.querySelector('[data-ap="0"]')?.checked }));
  console.log('範囲の候補', JSON.stringify(shown));
  const t0 = Date.now();
  await page.click('button[value="ok"]');
  await page.waitForFunction(() => /に範囲を適用しました/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(800);
  const applyMs = Date.now() - t0;
  const msg = await page.evaluate(() => document.querySelector('#toast')?.textContent);
  console.log('適用', applyMs + 'ms', msg);
  await page.reload(); await page.waitForSelector('#main'); const openMs2 = await open();
  const after = await stats('範囲抽出後'); after.openMs = openMs2;
  console.log(label, JSON.stringify(after));
  // 保存の確認: 全体スクリプトはフォルダに1つ、教材には範囲の行だけ、ASRと日本語訳はそのまま
  const chk = await page.evaluate(async () => {
    const { sdb } = await import('./studio-db.js');
    const set = await sdb.get('sets', 'setA'); const bl = (await sdb.byIndex('blocks', 'setId', 'setA')).filter((b) => !b.deleted);
    const meta = await sdb.get('meta', 'studio-folder-kf:fold1');
    return { kfRange: set.kfRange, scriptRows: bl.filter((b) => b.script).length, asrRows: bl.filter((b) => b.asr).length, folderScriptRows: meta?.rows.length,
      jaKept: bl.filter((b) => b.script && b.ja).length, orderOk: set.order.length === bl.length };
  });
  console.log('保存', JSON.stringify(chk));
}
console.log('errors', JSON.stringify(errors.slice(0, 5)));
await browser.close(); server.kill();
