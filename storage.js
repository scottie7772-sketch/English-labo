import { releaseVideoMedia } from './video-media-ref.js';
import { removeVideoJaInTx } from './video-ja.js';
// 容量の整理: what takes space on this iPhone and ways to free it (English Labo)
import { db } from './db.js';
import { $, $$, esc, toast, confirmDialog } from './ui.js';
import { icon } from './icons.js';

const fmtSize = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(0, Math.round(n / 1024)) + ' KB');

// total size of one Cache Storage cache (reads the stored responses; small for the app, large for speech models)
async function cacheSize(name) {
  let total = 0, n = 0;
  try { const c = await caches.open(name); for (const req of await c.keys()) { const r = await c.match(req); if (r) { const len = +r.headers.get('content-length'); total += len || (await r.clone().blob()).size; n++; } } } catch {}
  return { total, n };
}
export const isModelCache = (name) => /transformers|onnx|huggingface/i.test(name);

export async function storageScreen(el) {
  el.innerHTML = `<header class="top"><a href="#settings" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>容量の整理</h1></header><div class="card center muted">調べています…</div>`;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const files = Object.fromEntries((await db.all('vblobs').catch(() => [])).map((x) => [x.id, x.size || x.blob?.size || 0]));
  const vids = (await db.all('videos')).map((v) => ((files[v.id] ?? files[v.mediaRef]) != null ? { ...v, fileSize: files[v.id] ?? files[v.mediaRef] } : v));
  const cueN = await db.countEach('cues', 'videoId', vids.map((v) => v.id));
  const names = (await caches.keys().catch(() => [])) || [];
  const cs = await Promise.all(names.map(async (n) => ({ name: n, ...(await cacheSize(n)) })));
  const model = cs.filter((c) => isModelCache(c.name)), app = cs.filter((c) => !isModelCache(c.name));
  const vSize = (v) => (v.fileSize || 0) + (v.blob?.size || 0) + (v.audioBlob?.size || 0);
  // 1.16: the studio's own files (sounds shared with this app are counted once, here)
  let stTotal = 0, stN = 0, stShared = 0;
  try { const { sdb } = await import('./studio-db.js'); for (const x of await sdb.all('sources')) { if (x.labRef) stShared++; else if (x.stored && x.blob) { stTotal += x.blob.size; stN++; } } } catch {}
  const vTotal = Object.values(files).reduce((a, b) => a + b, 0) + vids.reduce((a,v) => a + (v.blob?.size || 0) + (v.audioBlob?.size || 0), 0), mTotal = model.reduce((a, c) => a + c.total, 0), aTotal = app.reduce((a, c) => a + c.total, 0);
  el.innerHTML = `<header class="top"><a href="#settings" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>容量の整理</h1></header>
    <div class="card stack">
      <b>このアプリが使っている容量：${fmtSize(est?.usage || 0)}${est?.quota ? `<span class="small muted">（上限の目安 ${fmtSize(est.quota)}）</span>` : ''}</b>
      <div class="small">・動画・音声（動画ラボ）：${fmtSize(vTotal)}（${vids.length}本）<br>・教材スタジオのファイル：${fmtSize(stTotal)}（${stN}件${stShared ? `・ラボと共有 ${stShared}件` : ''}） <a class="link" href="#studio/clean">スタジオの整理へ</a><br>・音声認識モデル：${fmtSize(mTotal)}<br>・アプリ本体の保存分：${fmtSize(aTotal)}<br>・単語・学習記録など：残り（通常は数MB）</div>
      <span class="small muted">消されにくい保存：${persisted ? '許可済み' : '未許可'}</span>
    </div>
    <h2 class="sec">すぐ消せるもの（学習データは消えません）</h2>
    <div class="card stack">
      <div class="row between"><span><b>音声認識モデル</b><br><small class="muted">字幕の自動作成に使う部品。消しても、次に使うとき自動で再ダウンロード（Wi-Fi推奨）</small></span><button class="btn sm" id="delModel" ${model.length ? '' : 'disabled'}>${fmtSize(mTotal)} 削除</button></div>
      <div class="row between"><span><b>アプリ本体の保存分</b><br><small class="muted">画面の部品。消すと最新版を読み込み直します（ネット接続が必要）</small></span><button class="btn sm" id="delApp">${fmtSize(aTotal)} 削除</button></div>
    </div>
    <h2 class="sec">動画（大きい順）</h2>
    <div class="card list">${vids.sort((a, b) => vSize(b) - vSize(a)).map((v) => `<div class="row between vrow2"><span class="grow"><b>${esc(v.name)}</b><br><small class="muted">${fmtSize(vSize(v))}${v.compressed ? `・圧縮済み（${esc(v.compressed.label)}）` : ''}・字幕 ${cueN[v.id] || 0}行${v.blob || v.fileSize != null ? '' : '・動画ファイルなし'}</small></span>
      ${(v.blob || v.fileSize != null) && v.kind !== 'multi' ? `<button class="btn sm" data-comp="${v.id}">圧縮</button>` : ''}${v.blob || v.fileSize != null ? `<button class="btn sm" data-dropfile="${v.id}">動画だけ削除</button>` : ''}<button class="btn sm danger" data-del="${v.id}">全部削除</button></div>`).join('') || '<p class="empty">動画はありません</p>'}</div>
    <p class="hint">「動画だけ削除」は字幕・穴埋め・学習記録を残します（あとで「動画を選び直す」で戻せます）。「全部削除」は字幕なども消えます。</p>`;
  $$('[data-comp]', el).forEach((b) => (b.onclick = async () => { const { compressVideoAudio } = await import('./video.js'); if (await compressVideoAudio(b.dataset.comp)) storageScreen(el); }));
  $('#delModel', el).onclick = async () => {
    if (!(await confirmDialog({ title: '音声認識モデルを削除', body: `<p>${fmtSize(mTotal)} を空けます。次に字幕を自動で作るとき、もう一度ダウンロードします。</p>`, okLabel: '削除' }))) return;
    for (const c of model) await caches.delete(c.name);
    toast('削除しました'); storageScreen(el);
  };
  $('#delApp', el).onclick = async () => {
    if (!(await confirmDialog({ title: 'アプリ本体の保存分を削除', body: '<p>最新版を読み込み直します。学習データ・動画は消えません。</p>', okLabel: '削除して読み込み直す' }))) return;
    for (const c of app) await caches.delete(c.name);
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.update().catch(() => {});
    location.replace(location.pathname + '?v=' + Date.now() + '#settings');
  };
  $$('[data-dropfile]', el).forEach((b) => (b.onclick = async () => {
    const v = await db.get('videos', b.dataset.dropfile); const fs = (await db.get('vblobs', v.id))?.size; if (fs != null) v.fileSize = fs;
    if (!(await confirmDialog({ title: '動画ファイルだけ削除', body: `<p>「${esc(v.name)}」の動画（${fmtSize(vSize(v))}）を消します。字幕・穴埋め・学習記録は残ります。</p>`, okLabel: '削除' }))) return;
    const mediaKeys = await releaseVideoMedia([v.id]);   // the studio's sets that use these sounds keep their own copy
    delete v.blob; delete v.audioBlob; delete v.fileSize; delete v.mediaRef;
    await db.tx(['vblobs','videos'], 'readwrite', tx => {
      for (const key of mediaKeys) tx.objectStore('vblobs').delete(key);
      tx.objectStore('videos').put(v);
    }); toast('削除しました'); storageScreen(el);
  }));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
    const v = await db.get('videos', b.dataset.del);
    if (!(await confirmDialog({ title: '動画を全部削除', body: `<p>「${esc(v.name)}」の動画・字幕・穴埋めを消します（元に戻せません）。</p>`, okLabel: '削除', danger: true }))) return;
    const cs2 = await db.byIndex('cues', 'videoId', v.id);
    const mediaKeys = await releaseVideoMedia([v.id]);   // the studio's sets that use these sounds keep their own copy
    await db.tx(['videos', 'vblobs', 'cues', 'videoJa'], 'readwrite', tx => {
      removeVideoJaInTx(tx, v.id);
      tx.objectStore('videos').delete(v.id);
      for (const key of mediaKeys) tx.objectStore('vblobs').delete(key);
      for (const cue of cs2) tx.objectStore('cues').delete(cue.id);
    });
    toast('削除しました'); storageScreen(el);
  }));
}
