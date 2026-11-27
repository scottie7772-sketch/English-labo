// 手元で実行する実ブラウザ検証（音声はリポジトリに入れない）。使い方: ffmpeg -i unit.mp3 -c:a aac -b:a 64k -ac 1 en01.m4a; TRANSCRIPT=台本.txt node eval/studio-structure-assign-e2e.mjs <アプリのフォルダ> <ポート>（reg.json と en01.m4a を作業ディレクトリに置く。playwright が必要）
// 実音声（金フレ en01 をAACにしたもの）で、Studio の「無音の構造で割り当て」を実ブラウザで通す。台本は実物の先頭から。文字起こしは模擬（粗い時刻・見出し語の聞き間違いあり）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir, port] = process.argv.slice(2);
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const T = fs.readFileSync(process.env.TRANSCRIPT, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const key = JSON.parse(fs.readFileSync('reg.json')).slice(0, 300);
const OFFSET = 20, NE = 150;   // 台本は 項目0〜149。音声は 項目0〜99 を読んだもの（台本が広い）… 先頭に余計な台本はない版と、20項目ずらした版を試す
const rnd = ((s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)(5);
const script = []; for (let i = 0; i < NE; i++) { script.push({ text: T[2 * i], kind: 'word' }, { text: T[2 * i + 1], kind: 'example' }); }
const grid = (t) => Math.round(t) + .14;
const asr = []; for (let g = 0; g < 100; g++) { if (rnd() < .2) continue; const h = key[3 * g], r2 = key[3 * g + 2]; const head = rnd() < .5 ? T[2 * g].split('').reverse().join('').slice(0, 5) : T[2 * g]; asr.push({ text: `${head} ${T[2 * g + 1]} ${T[2 * g + 1]}`, start: grid(h[0] - .4), end: grid(r2[1] + .6) }); }
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('DBG')) errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/studio.html`); await page.waitForSelector('#main');
const b64 = fs.readFileSync('en01.m4a').toString('base64');
await page.evaluate(async ({ script, asr, b64 }) => {
  const { sdb, newBlock } = await import('./studio-db.js');
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const blob = new Blob([bin], { type: 'audio/mp4' });
  await sdb.put('sources', { id: 'src1', kind: 'audio', name: 'unit1.m4a', size: blob.size, mime: 'audio/mp4', duration: 748.85, stored: true, blob, addedAt: Date.now() });
  const blocks = [];
  script.forEach((l) => blocks.push(newBlock('setA', { text: l.text, script: true, kind: l.kind, sync: 'auto' })));
  asr.forEach((c) => blocks.push(newBlock('setA', { text: c.text, asr: true, segments: [{ sourceId: 'src1', start: c.start, end: c.end }], sync: 'auto' })));
  for (const b of blocks) { b.rev = 1; if (b.asr) b.lineage = { op: 'split', from: ['x@1'], at: 1 }; await sdb.put('blocks', b); }
  await sdb.put('sets', { id: 'setA', title: 'kinfure unit1', folder: '', order: blocks.map((b) => b.id), undo: [], redo: [], sourceId: 'src1', createdAt: Date.now(), updatedAt: Date.now() });
}, { script, asr, b64 });
await page.evaluate(() => { location.hash = '#set?id=setA'; }); await page.waitForTimeout(1500);
await page.click('#moreB'); await page.waitForSelector('button[value=structAssign]');
const t0 = Date.now();
await page.click('button[value=structAssign]');
await page.waitForSelector('[data-sa]', { timeout: 240000 });
console.log('解析時間(秒)', ((Date.now() - t0) / 1000).toFixed(1));
console.log('プレビュー:', (await page.textContent('#dialog ul')).replace(/\s+/g, ' ').slice(0, 200), '| 行数', await page.$$eval('[data-sa]', (a) => a.length));
await page.click('button[value=apply]'); await page.waitForTimeout(2500);
console.log('toast:', await page.evaluate(() => document.getElementById('toast')?.textContent));
console.log('rows with segments (non-asr):', await page.evaluate(async () => { const { sdb, liveBlocks } = await import('./studio-db.js'); const live = await liveBlocks(await sdb.get('sets','setA')); return [live.length, live.filter(b=>!b.asr&&b.segments.length).length, live.filter(b=>b.lineage?.op==='structure-assign').length]; }));
const res = await page.evaluate(async () => { const { sdb, liveBlocks } = await import('./studio-db.js'); const set = await sdb.get('sets', 'setA'); const live = await liveBlocks(set); return live.filter((b) => !b.asr).map((b) => ({ text: b.text, kind: b.kind, segs: b.segments, rep: b.rep, aligned: b.aligned, op: b.lineage?.op })).concat([{ asrLeft: live.filter((b) => b.asr).length }]); });
let hOk = 0, eOk = 0, wrong = 0, n = 0, clip = 0, rep2 = 0;
for (let i = 0; i < 100; i++) {
  const h = res[2 * i], e = res[2 * i + 1], k = [key[3 * i], key[3 * i + 1], key[3 * i + 2]];
  if (h?.segs?.length) { n++; const s = h.segs[0]; if (s.start <= k[0][0] + .02 && s.end >= k[0][1] - .05 && s.start >= k[0][0] - .2 && s.end <= k[0][1] + .4) hOk++; else if (s.start > k[0][0] + .02 || s.end < k[0][1] - .05) clip++; else wrong++; }
  if (e?.segs?.length) { const s = e.segs[0]; if (s.start <= k[1][0] + .02 && s.end >= k[1][1] - .05 && s.end < k[2][0]) eOk++; if (e.segs.length === 2) rep2++; }
}
console.log(`割り当て ${n}/100 見出し語正 ${hOk} 語頭/語尾欠け ${clip} 誤 ${wrong} / 例文正 ${eOk} 反復2回保持 ${rep2} / 余った文字起こし行 ${res.at(-1).asrLeft}`);
console.log('台本150行目以降（音声外）が割り当て済みか:', res.slice(200, 300).filter((r) => r.segs?.length).length);
console.log('errors', errors.slice(0, 3));
await browser.close(); server.kill();
