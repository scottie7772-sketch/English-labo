// 実音声での評価（手元で実行する。音声ファイルはリポジトリに入れない）。
//   使い方:  ffmpeg -i unit.mp3 -f s16le -ac 1 -ar 16000 unit.raw
//            node eval/real-audio-eval.mjs unit.raw regions.json transcript.txt
//   regions.json = 構造から求めた仮の正解（[[開始,終了]…] を 見出し語・例文・繰り返しの順に並べたもの。聞いて確認したものではない）
//   transcript.txt = 1行ごとに 見出し語・例文 を交互に並べた台本
// 区間の検出は、アプリ（word-audio.js の partsOf）と同じ式。認識結果（錨）は欠け方を決めた模擬。
import fs from 'node:fs';
const [rawPath, keyPath, scriptPath] = process.argv.slice(2);
if (!rawPath || !keyPath || !scriptPath) { console.error('usage: node eval/real-audio-eval.mjs unit.raw regions.json transcript.txt'); process.exit(2); }
const core = await import('../vocab-audio-core.js');
const { extractItems, confirmRef, structureRescue } = core;
const raw = fs.readFileSync(rawPath); const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2); const SR = 16000;
const detect = (start, end) => {   // word-audio.js partsOf の式そのまま（20 ms 刻みの RMS、下位10%と上位95%から閾値、0.26 s 以上の静けさで区切る）
  const from = Math.floor(start * SR), to = Math.min(pcm.length, Math.floor(end * SR)), hop = Math.round(SR * .02), rms = [];
  for (let i = from; i + hop <= to; i += hop) { let a = 0; for (let j = i; j < i + hop; j++) { const v = pcm[j] / 32768; a += v * v; } rms.push(Math.sqrt(a / hop)); }
  const sorted = rms.slice().sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * .1)], peak = sorted[Math.floor(sorted.length * .95)], th = floor + (peak - floor) * .12;
  const parts = []; let on = -1, quiet = 0;
  rms.forEach((v, i) => { if (v > th) { if (on < 0) on = i; quiet = 0; } else if (on >= 0 && ++quiet >= 13) { parts.push([on, i - quiet + 1]); on = -1; quiet = 0; } });
  if (on >= 0) parts.push([on, rms.length]);
  return parts.filter(([a, b]) => b - a >= 4).map(([a, b]) => [+(start + a * .02).toFixed(2), +(start + b * .02).toFixed(2)]);
};
const merge = (all) => { all = all.sort((a, b) => a[0] - b[0]); const out = []; for (const r of all) { if (out.length && r[0] <= out.at(-1)[1] + .01) out.at(-1)[1] = Math.max(out.at(-1)[1], r[1]); else out.push([...r]); } return out; };
const key = JSON.parse(fs.readFileSync(keyPath)).slice(0, 300);  // 先頭100項目（300区間）
const T = fs.readFileSync(scriptPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const N = 100, total = pcm.length / SR;
const out = {};
for (const [label, win] of [['40秒窓', 40], ['80秒窓', 80], ['全体を1窓(参考)', total]]) {
  let regs = []; for (let a = 0; a < total; a += win) regs.push(...detect(a, Math.min(total, a + win)));
  regs = merge(regs);
  // 発話区間そのものの一致（キーの区間と、検出した区間が重なる割合）
  let same = 0; for (const k of key) if (regs.some(r => Math.min(r[1], k[1]) - Math.max(r[0], k[0]) > .6 * (k[1] - k[0]) && Math.abs(r[0] - k[0]) < .25 && Math.abs(r[1] - k[1]) < .35)) same++;
  out[label] = { regions: regs.length, regionsMatchKey: same + '/300' };
  out[label]._regs = regs;
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { regions: v.regions, regionsMatchKey: v.regionsMatchKey }])), null, 1));
// 構造の救済: 認識できた見出し語（錨）を欠かせて評価。区間はアプリ検出（40秒窓）
const regs = out['40秒窓']._regs;
const rows = []; for (let i = 0; i < N; i++) { rows.push({ id: 'h' + i, text: T[2 * i], role: 'word', group: 'g' + i, segments: [], confirmed: false }, { id: 'e' + i, text: T[2 * i + 1], role: 'example', group: 'g' + i, segments: [], confirmed: false }); }
const SRC = { store: 'vblobs', key: 'unit1', size: 6e6 };
const rnd = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const scen = [['ランダム30%欠け', () => { const r = rnd(7); return new Set(Array.from({ length: N }, (_, i) => i).filter(() => r() < .3)); }], ['ランダム50%欠け', () => { const r = rnd(3); return new Set(Array.from({ length: N }, (_, i) => i).filter(() => r() < .5)); }], ['連続10件欠け', () => new Set(Array.from({ length: 10 }, (_, k) => 40 + k))], ['1件おき欠け', () => new Set(Array.from({ length: 50 }, (_, k) => 2 * k + 1))]];
for (const withEx of [true, false]) for (const [label, mkMissing] of scen) {
  const missing = mkMissing(); const { items } = extractItems(rows, 'kinfure', { from: 'studio', materialId: 'S' });
  items.forEach((it, i) => { if (missing.has(i)) return; const h = key[3 * i], e = key[3 * i + 1]; confirmRef(it, 'word', { src: SRC, start: h[0] - .05, end: h[1] + .1 }); if (withEx) confirmRef(it, 'example', { src: SRC, start: e[0] - .05, end: e[1] + .1 }); });
  const res = structureRescue(items, { regions: new Map([['vblobs:unit1', regs]]), mode: 'head' });
  let ok = 0, exOk = 0, wrong = 0, clipHead = 0, clipTail = 0, longHead = 0, shifted = 0, done = 0;
  for (const i of missing) {
    const w = items[i].refs.word; if (!w?.fromStructure) continue; done++;
    const h = key[3 * i], e = key[3 * i + 1], rep = key[3 * i + 2];
    const inside = w.ref.start <= h[0] + .02 && w.ref.end >= h[1] - .02;
    if (inside && w.ref.start >= h[0] - .25 && w.ref.end <= h[1] + .35) ok++; else { wrong++; if (process.env.VERBOSE) console.log('  wrong item', i, 'key', h.map(x=>+x.toFixed(2)), 'got', w.ref.start, w.ref.end); if (key.some((k, kk) => kk % 3 === 0 && kk !== 3 * i && Math.abs(k[0] - w.ref.start) < .4)) shifted++; }
    if (w.ref.start > h[0] + .02) clipHead++; if (w.ref.end < h[1] - .02) clipTail++; if (w.ref.end - w.ref.start > h[1] - h[0] + .5) longHead++;
    const ex = items[i].refs.example?.ref; if (ex && ex.start <= e[0] + .02 && ex.end >= e[1] - .02 && ex.end < rep[0]) exOk++;
  }
  console.log(`${withEx ? '錨に例文あり' : '錨は見出し語だけ'} / ${label}: 欠け${missing.size} → 構造で確定${done} 正しい${ok} 誤り${wrong}(後続へのずれ${shifted}) 語頭切れ${clipHead} 語尾切れ${clipTail} 長すぎ${longHead} 例文(1回目のみ)${exOk}`);
}
