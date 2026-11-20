// Phase 6: Video Lab (local videos + SRT/VTT subtitles + word registration linked to video position)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, swipeToDelete } from './ui.js';
import { icon } from './icons.js';
import { L, curLang, langAttr } from './langs.js';
import { pickWordsDialog } from './pick.js';
import { headKey, wordsByHead, findDuplicate, newWord, newSense, saveWord, splitList } from './words.js';
import { clozeHTML, toggleToken, candidates } from './cloze.js';
import { recordAnswer } from './judge.js';

// ---------- subtitles ----------
const TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
function toSec(t) {
  const p = t.replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
export function parseSubs(text) {
  const out = [];
  const blocks = String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => TIME.test(l));
    if (i < 0) continue;
    const m = lines[i].match(TIME);
    const txt = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (txt) out.push({ start: toSec(m[1]), end: toSec(m[2]), text: txt });
  }
  return out.sort((a, b) => a.start - b.start);
}
function srtTime(s) {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function toSRT(cues, field) {
  return cues.filter((c) => c[field]).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c[field]}\n`).join('\n');
}
// attach Japanese cues to the English cue they overlap most
function mergeJa(cues, jaList, videoId) {
  const extra = [];
  for (const j of jaList) {
    let best = null, bestOv = 0;
    for (const c of cues) {
      const ov = Math.min(c.end, j.end) - Math.max(c.start, j.start);
      if (ov > bestOv) { bestOv = ov; best = c; }
    }
    if (best && bestOv > 0) { best.ja = best._jaSet ? best.ja + ' ' + j.text : j.text; best._jaSet = true; }
    else extra.push({ id: uid('c_'), videoId, start: j.start, end: j.end, en: '', ja: j.text });
  }
  cues.forEach((c) => delete c._jaSet);
  return [...cues, ...extra].sort((a, b) => a.start - b.start);
}
const fmtT = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const parseT = (v) => { v = String(v).trim(); if (!v) return NaN; if (v.includes(':')) { const [m, s] = v.split(':'); return +m * 60 + +s; } return +v; };
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
async function cuesOf(videoId) { return (await db.byIndex('cues', 'videoId', videoId)).sort((a, b) => a.start - b.start); }
async function replaceCues(videoId, cues) {
  const old = await db.byIndex('cues', 'videoId', videoId);
  await db.tx(['cues'], 'readwrite', (t) => { const os = t.objectStore('cues'); old.forEach((c) => os.delete(c.id)); cues.forEach((c) => os.put(c)); });
}
// a studio material (from a pack file, or sent directly by the studio inside this app) → video lab.
// The same material again: subtitles are replaced in place, learning records kept. getFile(m) → Blob of a media file or null.
export async function importMaterial(manifest, mat, getFile, { askUpdate = true } = {}) {
  const { copyBlob } = await import('./media-audio.js');
  // same material imported before (same studio set): update it in place, keeping the learning records
  const all = (await db.all('videos')).map(({ blob, ...x }) => x);
  const mine = all.filter((x) => x.from?.material && x.from.material === manifest.materialId && x.kind !== 'multi');
  const oldParent = all.find((x) => x.kind === 'multi' && x.from?.material === manifest.materialId);
  const findOld = (m) => mine.find((x) => x.from.media === m.id) || mine.find((x) => !x.from.media && (x.name === manifest.title || x.name === `${manifest.title}（${m.name}）`));
  const withText = (m) => mat.items.some((it) => it.segments?.[0]?.media === m.id && (it.text || it.ja));
  const plan = mat.media.filter(withText).map((m) => ({ m, old: findOld(m) }));
  let update = false;
  if (plan.some((p) => p.old)) {
    update = !askUpdate || await confirmDialog({ title: 'すでにある教材です', body: `<p>「${esc(manifest.title)}」は前に取り込んでいます。字幕を新しい内容に入れ替えますか？</p><p class="hint">入れ替えても、単語帳の「元の動画」へのリンク・再生位置・固有名詞・変わっていない行のディクテーション記録は残ります。</p>`, okLabel: '入れ替える', cancelLabel: '別の教材として追加' });
    if (!update) plan.forEach((p) => (p.old = null));
  }
  const missing = plan.filter((p) => !p.old && !p.m.included);
  if (!plan.some((p) => p.old || p.m.included)) throw new Error('このパックには動画・音声が入っていません。スタジオで「動画・音声も含める」を選んで書き出し直してください');
  let first = null, nUpd = 0, nNew = 0; const made = [];
  for (const { m, old } of plan) {
    if (!old && !m.included) continue;
    toast('取り込み中…', 10000);
    let v, freshBlob = null;
    if (old) {
      v = await db.get('videos', old.id);
      if (m.included && m.size && v.from?.mediaSize && m.size !== v.from.mediaSize) {   // the sound itself changed in the studio: replace it
        const raw = await getFile(m); const { saveVideoCopy } = await import('./media-audio.js');
        const sv = m.kind === 'video' ? await saveVideoCopy(new File([raw], m.name, { type: m.mime || 'video/mp4' }), { onStep: (x) => toast(x, 10000) }) : { blob: await copyBlob(raw, () => {}, { name: m.name, type: m.mime || 'audio/mp4' }) };
        freshBlob = sv.blob; Object.assign(v, { size: sv.blob.size, mime: m.mime || v.mime, duration: m.duration || v.duration, audioChecked: true, audioFixed: true }); if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
      }
      v.from = { ...v.from, pack: manifest.packId, media: m.id, mediaSize: m.size || v.from?.mediaSize, updatedAt: Date.now() };
      nUpd++;
    } else {
      const raw = await getFile(m);
      const { saveVideoCopy } = await import('./media-audio.js');
      const sv = m.kind === 'video' ? await saveVideoCopy(new File([raw], m.name, { type: m.mime || 'video/mp4' }), { onStep: (x) => toast(x, 10000) }) : { blob: await copyBlob(raw, (r) => toast(`取り込み中… ${Math.round(r * 100)}%`, 10000), { name: m.name, type: m.mime || 'audio/mp4' }) };
      const blob = sv.blob; freshBlob = blob;
      v = { id: uid('v_'), lang: manifest.lang || curLang(), name: mat.media.filter(withText).length > 1 ? `${manifest.title}（${m.name}）` : manifest.title, mime: m.mime || 'video/mp4', size: blob.size, duration: m.duration || 0, lastTime: 0, createdAt: Date.now(), from: { pack: manifest.packId, material: manifest.materialId, media: m.id, mediaSize: m.size } };
      Object.assign(v, { audioChecked: true, audioFixed: true }); if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
      nNew++;
    }
    // the studio's cut (start/end) = the range covered by the items: playback stays inside it
    const segs = mat.items.flatMap((it) => (it.segments || []).filter((g) => g.media === m.id));
    delete v.trim;
    if (segs.length) { const a0 = Math.min(...segs.map((g) => g.start)), a1 = Math.max(...segs.map((g) => g.end)); if (a0 > 0.05 || (m.duration && a1 < m.duration - 0.05)) v.trim = { start: a0, end: a1, why: 'スタジオのカット' }; }
    if (freshBlob) await putVideoBlob(v.id, freshBlob);
    await saveVideoMeta(v);
    const fresh = mat.items.filter((it) => it.segments?.[0]?.media === m.id && (it.text || it.ja))
      .map((it) => ({ id: uid('c_'), videoId: v.id, itemId: it.id, start: it.segments[0].start, end: it.segments.at(-1).media === m.id ? it.segments.at(-1).end : it.segments[0].end, en: it.text || '', ja: it.ja || '', ...(it.holes?.length ? { holes: it.holes } : {}) }))
      .sort((a, b) => a.start - b.start);
    if (old) {   // keep cue ids (word links) and records of lines that still exist
      const prev = await db.byIndex('cues', 'videoId', v.id); const used = new Set();
      for (const c of fresh) {
        const o = prev.find((x) => !used.has(x.id) && x.itemId && x.itemId === c.itemId) || prev.find((x) => !used.has(x.id) && !x.itemId && x.en && x.en === c.en);
        if (!o) continue; used.add(o.id);
        c.id = o.id; if (o.dict) c.dict = o.dict;
        if (o.en === c.en && o.holes?.length) c.holes = o.holes;   // same sentence: keep the cloze holes and their results
      }
    }
    await replaceCues(v.id, fresh);
    first ||= v; made.push({ m, v });
  }
  // several sound files in one material (a script with its audio pieces): also one entry that plays them as one timeline, in script order
  const medias = mat.media.filter(withText);
  if (medias.length > 1 && made.length === medias.length) {
    const order = []; for (const it of mat.items) { const mid = it.segments?.[0]?.media; if (mid && !order.includes(mid) && medias.some((m) => m.id === mid)) order.push(mid); }
    let off = 0; const parts = order.map((mid) => { const x = made.find((y) => y.m.id === mid); const dur = x.m.duration || x.v.duration || 0; const p = { videoId: x.v.id, media: mid, offset: +off.toFixed(3), dur }; off += dur; return p; });
    const P = (update && oldParent) ? { ...(await db.get('videos', oldParent.id)) } : { id: uid('v_'), lang: manifest.lang || curLang(), lastTime: 0, createdAt: Date.now() };
    Object.assign(P, { kind: 'multi', name: manifest.title, parts, duration: off, size: 0, mime: 'audio/mp4', audioChecked: true, audioFixed: true, from: { material: manifest.materialId, multi: true, pack: manifest.packId, updatedAt: Date.now() } });
    delete P.blob; delete P.trim;
    await db.put('videos', P);
    const partOf = Object.fromEntries(parts.map((p) => [p.media, p]));
    const fresh = mat.items.filter((it) => partOf[it.segments?.[0]?.media] && (it.text || it.ja)).map((it) => {
      const p = partOf[it.segments[0].media], g0 = it.segments[0], g1 = it.segments.at(-1).media === g0.media ? it.segments.at(-1) : g0;
      return { id: uid('c_'), videoId: P.id, itemId: it.id, part: p.videoId, start: +(p.offset + g0.start).toFixed(3), end: +(p.offset + g1.end).toFixed(3), en: it.text || '', ja: it.ja || '', ...(it.holes?.length ? { holes: it.holes } : {}) };
    });   // script order = timeline order
    if (update && oldParent) {
      const prev = await db.byIndex('cues', 'videoId', P.id); const used = new Set();
      for (const c of fresh) { const o = prev.find((x) => !used.has(x.id) && x.itemId === c.itemId); if (!o) continue; used.add(o.id); c.id = o.id; if (o.dict) c.dict = o.dict; if (o.en === c.en && o.holes?.length) c.holes = o.holes; }
    }
    await replaceCues(P.id, fresh);
    first = P;
  }
  if (missing.length) toast(`音声が入っていない部分（${missing.length}件）は取り込めませんでした。スタジオで音声を含めて書き出してください`, 5000);
  if (!missing.length) toast(`${nUpd ? `更新しました` : '取り込みました'}（字幕 ${mat.items.filter((it) => it.segments?.length && (it.text || it.ja)).length}行）`);
  return first;
}
// ---- media files live in their own store ('vblobs') and are written once ----
// (iPhone: putting a file that was read from the database back into it — e.g. with the play position — made it unreadable after reopening)
export async function videoBlob(v) { if (!v) return null; return (await db.get('vblobs', v.id))?.blob || v.blob || null; }
async function putVideoBlob(id, blob) { await db.put('vblobs', { id, blob, size: blob.size, at: Date.now() }); }
// save the video record without its file (never puts a file read from the database back)
async function saveVideoMeta(rec) {
  const { blob, audioBlob, ...m } = rec;
  if (blob && !(await db.get('vblobs', rec.id))) m.blob = blob;   // older record not moved yet: left as it was
  await db.put('videos', m);
}
// older records: move the file into its own store once (only while it is still readable)
async function migrateBlob(v) {
  if (!v?.blob) return v;
  const { blob, audioBlob, ...m } = v;
  if (await db.get('vblobs', v.id)) { await db.put('videos', m); return m; }
  const { readable, copyBlob } = await import('./media-audio.js');
  if (!(await readable(blob))) return v;   // already unreadable: the "choose again" dialog handles it
  const fresh = await copyBlob(blob, () => {}, { name: v.name, type: v.mime || blob.type });
  await putVideoBlob(v.id, fresh); await db.put('videos', m); return m;
}
// lightweight video list without loading blobs into the page
async function videoMetas() {
  const files = new Set((await db.all('vblobs')).map((x) => x.id));
  return (await db.all('videos')).map(({ blob, ...m }) => ({ ...m, hasBlob: m.kind === 'multi' ? (m.parts || []).every((p) => files.has(p.videoId)) : !!blob || files.has(m.id) })).sort((a, b) => b.createdAt - a.createdAt);
}
export async function videoNames() { return Object.fromEntries((await videoMetas()).map((v) => [v.id, v])); }

let cleanup = null;
function setCleanup(fn) { cleanup?.(); cleanup = fn; }
addEventListener('hashchange', () => { if (!location.hash.startsWith('#video-play')) setCleanup(null); });

// ================= List =================
export async function videoList(el) {
  setCleanup(null);
  const vids = await videoMetas();
  const cueCount = {};
  for (const c of await db.all('cues')) cueCount[c.videoId] = (cueCount[c.videoId] || 0) + 1;
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>🎬 Video Lab</h1></header>
    <a class="btn primary" href="#studio/sets">🛠 教材スタジオを開く（教材を作って送る）</a>
    <label class="btn" for="vpack">📦 教材パック（.elpack.zip）を読み込む</label>
    <input type="file" id="vpack" hidden>
    <p class="hint" style="margin-top:6px">取り込み・カット・文字起こし・字幕づくりは<b>教材スタジオ</b>で行い、ここでは再生と学習（速度・区間リピート・ディクテーション・シャドーイング・穴埋め）を行います。スタジオで「⋯」→「教材パックとして書き出す」→「含める」で作ったファイルを選んでください。</p>
    <label class="btn sm" for="vfile" style="margin-top:4px">動画をそのまま追加（字幕ファイルがある場合など）</label>
    <input type="file" id="vfile" accept="video/*" hidden>
    <p class="hint" style="margin-top:6px">30秒〜5分程度の動画向け。動画はこのiPhoneの中だけに保存され、外部には送信されません。JSONバックアップに動画本体は含まれません（字幕は含まれます）。</p>
    <div id="vlbar"></div>
    <div id="vl">${vids.map((v) => `
      <a class="card vrow" href="#video-play?id=${v.id}" data-id="${v.id}">
        <span class="vsel" hidden><input type="checkbox" data-pick="${v.id}"></span>
        <span class="vic">${icon('video', 26)}</span>
        <span class="grow"><b>${esc(v.name)}</b><span class="tagp">${esc(L(v.lang || 'en').short)}</span><span class="small muted block">${v.kind === 'multi' ? `📚 音声${(v.parts || []).length}本をつないだ教材・` : ''}${v.duration ? fmtT(v.duration).replace(/\.\d$/, '') : ''}${v.kind === 'multi' ? '' : `・${fmtSize(v.size || 0)}`}・字幕 ${cueCount[v.id] || 0}行${v.hasBlob ? '' : '・<span class="danger-text">動画ファイルなし</span>'}</span></span>
        <span class="muted">›</span>
      </a>`).join('') || '<div class="card center muted">まだ動画がありません</div>'}</div>
    <details class="card" style="margin-top:14px"><summary><b>字幕・翻訳について（無料でできる範囲）</b></summary>
      <div class="small stack" style="margin-top:8px">
        <p><b>追加料金なし</b>：SRT/VTT字幕の読み込み、字幕の手入力・編集、再生・リピート・速度変更、単語登録。<br>
        日本語訳は <b>Claudeのチャット（Proの範囲）</b> で作れます：再生画面の「⋯」→「英語字幕をコピー」→ Claudeに「このSRTを日本語に訳して、同じ形式・同じ時間で返して」と貼る → 返ってきたSRTを「字幕を貼り付け（日本語）」で取り込み。</p>
        <p><b>追加料金なし（iPhone内・試験的）</b>：動画の音声から英語字幕を作る（再生画面の「字幕を作る」）。教材スタジオで作った字幕つき教材も、パックから取り込めます。</p>
        <p><b>別途費用が必要</b>：翻訳をボタン一つで全自動にする場合（API料金）。このアプリでは使っていません。</p>
        <p>字幕付きの教材なら、その字幕ファイル（.srt / .vtt）を使うのが一番確実です。</p>
      </div></details>`;
  // delete: swipe a row to the left, or 選ぶ → すべて選ぶ / 削除
  let picking = false; const picked = new Set();
  const drawBar = () => {
    const bar = $('#vlbar', el); if (!vids.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = picking
      ? `<div class="row" style="margin:10px 0 6px"><button class="btn sm" id="vAll">${picked.size === vids.length ? 'すべて外す' : 'すべて選ぶ'}</button><button class="btn sm danger" id="vDel" ${picked.size ? '' : 'disabled'}>削除（${picked.size}）</button><span class="grow"></span><button class="btn sm" id="vDone">完了</button></div>`
      : `<div class="row" style="margin:10px 0 6px"><span class="grow small muted">${vids.length}本・左にスワイプで削除</span><button class="btn sm" id="vPick">選ぶ</button></div>`;
    $('#vPick', bar)?.addEventListener('click', () => { picking = true; drawRows(); });
    $('#vDone', bar)?.addEventListener('click', () => { picking = false; picked.clear(); drawRows(); });
    $('#vAll', bar)?.addEventListener('click', () => { if (picked.size === vids.length) picked.clear(); else vids.forEach((v) => picked.add(v.id)); drawRows(); });
    $('#vDel', bar)?.addEventListener('click', async () => { if (await removeVideos([...picked])) videoList(el); });
  };
  const drawRows = () => {
    $$('#vl .vrow', el).forEach((a) => { a.querySelector('.vsel').hidden = !picking; const cb = a.querySelector('[data-pick]'); cb.checked = picked.has(a.dataset.id); });
    drawBar();
  };
  async function removeVideos(ids) {
    if (!ids.length) return false;
    const names = vids.filter((v) => ids.includes(v.id)).map((v) => v.name);
    if (!(await confirmDialog({ title: `${ids.length}件を削除`, body: `<p>${names.slice(0, 8).map(esc).join('<br>')}${names.length > 8 ? `<br>ほか${names.length - 8}件` : ''}</p><p class="hint">動画・音声と字幕・穴埋めを消します（元に戻せません）。この動画から登録した単語は残ります。</p>`, okLabel: '削除', danger: true }))) return false;
    const cues = (await db.all('cues')).filter((c) => ids.includes(c.videoId));
    await db.tx(['videos', 'vblobs', 'cues'], 'readwrite', (t) => { for (const id of ids) { t.objectStore('videos').delete(id); t.objectStore('vblobs').delete(id); } cues.forEach((c) => t.objectStore('cues').delete(c.id)); });
    toast(`${ids.length}件を削除しました`); return true;
  }
  $('#vl', el).addEventListener('click', (e) => {
    if (!picking) return;
    const a = e.target.closest('.vrow'); if (!a) return;
    e.preventDefault(); const id = a.dataset.id; picked.has(id) ? picked.delete(id) : picked.add(id); drawRows();
  });
  swipeToDelete($$('#vl .vrow', el), async (row) => { if (picking) return false; const ok = await removeVideos([row.dataset.id]); if (ok) videoList(el); return ok; });
  drawBar();
  // material pack from the studio: its sound/video + subtitles (EN/JA) + hidden words become a video lab entry
  $('#vpack', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const { zipRead } = await import('./common-pack.js'); const { copyBlob } = await import('./media-audio.js');
      const z = await zipRead(f);
      const manifest = JSON.parse(await z.text('manifest.json')), mat = JSON.parse(await z.text('material.json'));
      if (manifest.format !== 'elpack') throw new Error('教材スタジオのパックではありません');
      const first = await importMaterial(manifest, mat, async (m) => (m.included ? z.file(m.path) : null));
      if (first) go(`#video-play?id=${first.id}`);
    } catch (err) { toast('取り込めませんでした：' + (err?.message || err), 5000); }
  };
  $('#vfile', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 500 * 1048576 && !(await confirmDialog({ title: '大きな動画です', body: `<p>${fmtSize(f.size)}あります。保存に時間がかかり、iPhoneの空き容量を使います。続けますか？</p>`, okLabel: '保存する' }))) return;
    toast('保存中…', 10000);
    try {
      const duration = await probeDuration(f);
      // a real copy (Safari may otherwise keep only a reference to a temporary file that iOS deletes later)
      // a real copy; for screen recordings (app sound + microphone) only the speech track is kept in the saved video
      const { saveVideoCopy } = await import('./media-audio.js');
      const sv = f.size <= 600 * 1048576 ? await saveVideoCopy(f, { onStep: (m) => toast(m, 10000) }) : { blob: f, info: null };
      const blob = sv.blob;
      const v = { id: uid('v_'), lang: curLang(), name: f.name.replace(/\.[^.]+$/, '') || '動画', mime: f.type || 'video/mp4', size: blob.size, duration, lastTime: 0, createdAt: Date.now(), audioChecked: true, audioFixed: true };
      if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
      await putVideoBlob(v.id, blob); await saveVideoMeta(v);
      toast('動画を追加しました。字幕はファイルで読み込むか、教材スタジオで作ってください', 3500);
      go(`#video-play?id=${v.id}`);
    } catch (err) { toast('保存できませんでした: ' + (err?.message || err)); }
  };
}
function probeDuration(file) {
  return new Promise((res) => {
    const v = document.createElement('video'); const url = URL.createObjectURL(file);
    v.preload = 'metadata'; v.muted = true; v.src = url;
    v.onloadedmetadata = () => { res(isFinite(v.duration) ? v.duration : 0); URL.revokeObjectURL(url); };
    v.onerror = () => { res(0); URL.revokeObjectURL(url); };
    setTimeout(() => res(0), 8000);
  });
}

// ================= Player =================
const SPEEDS = [0.75, 0.9, 1, 1.25, 1.5];
const VIEW_DEFAULTS = { mode: 'both', order: 'en', opEn: 1, opJa: 1, fsEn: 19, fsJa: 15, step: false, test: false, cloze: false, clozeUnit: 'phrase', clozeAuto: false, jaHint: true, loopMax: 0 };
const OPS = [1, 0.7, 0.4, 0.2], FS_EN = [[15, '小'], [19, '中'], [23, '大'], [28, '特大']], FS_JA = [[12, '小'], [15, '中'], [18, '大'], [22, '特大']];
const MODES = [['both', '英＋日'], ['en', '英語のみ'], ['ja', '日本語のみ'], ['none', '字幕なし']];
async function loadView() {
  const v = await getSetting('video.view', null);
  if (v) return { ...VIEW_DEFAULTS, ...v };
  // from the older separate settings
  const en = await getSetting('video.en', true), ja = await getSetting('video.ja', true), step = await getSetting('video.step', false);
  return { ...VIEW_DEFAULTS, mode: en && ja ? 'both' : en ? 'en' : ja ? 'ja' : 'none', step };
}

// several files played as one timeline: looks like a <video> to the player (currentTime / duration / play / pause / events)
function multiMedia(el, parts) {
  let cur = 0, pendingSeek = null, rate = 1, endFns = [];
  const total = parts.reduce((a, p) => Math.max(a, p.offset + p.dur), 0);
  const partAt = (t) => { for (let i = parts.length - 1; i >= 0; i--) if (t >= parts[i].offset - 0.001) return i; return 0; };
  const go = (i, local, play) => {
    cur = i; pendingSeek = local; el.src = parts[i].url;
    el.playbackRate = rate;
    if (play) { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} el.play().catch(() => {}); }
  };
  el.addEventListener('loadedmetadata', () => { el.playbackRate = rate; if (pendingSeek != null) { try { el.currentTime = pendingSeek; } catch {} pendingSeek = null; } });
  el.addEventListener('ended', () => { if (cur < parts.length - 1) go(cur + 1, 0, true); else endFns.forEach((f) => f()); });
  const api = {
    get currentTime() { return parts[cur].offset + (pendingSeek ?? el.currentTime ?? 0); },
    set currentTime(t) { t = Math.max(0, Math.min(total, t)); const i = partAt(t), local = Math.max(0, t - parts[i].offset); if (i === cur && pendingSeek == null) el.currentTime = local; else if (i === cur) pendingSeek = local; else go(i, local, !el.paused); },
    get duration() { return total; },
    get paused() { return el.paused; },
    get seeking() { return el.seeking || pendingSeek != null; },
    get readyState() { return el.readyState; },
    get videoWidth() { return el.videoWidth; },
    get audioTracks() { return el.audioTracks; },
    get playbackRate() { return rate; },
    set playbackRate(r) { rate = r; el.playbackRate = r; },
    play() { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} return el.play(); },
    pause() { el.pause(); },
    addEventListener(type, fn, opt) { if (type === 'ended') endFns.push(fn); else el.addEventListener(type, fn, opt); },
    removeEventListener(type, fn, opt) { if (type === 'ended') endFns = endFns.filter((f) => f !== fn); else el.removeEventListener(type, fn, opt); },
    get el() { return el; },
  };
  return api;
}
export async function videoPlay(el, params) {
  setCleanup(null);
  let v = await db.get('videos', params.get('id'));
  if (v) v = await migrateBlob(v);
  // one entry made of several sound files (a script and its audio pieces): one timeline over all parts
  let parts = null, missingPart = false;
  if (v?.kind === 'multi') {
    parts = [];
    for (const p of v.parts || []) { const b = await videoBlob(await db.get('videos', p.videoId)); if (!b) { missingPart = true; continue; } parts.push({ ...p, url: URL.createObjectURL(b), blob: b }); }
  }
  const fileBlob = parts ? parts[0]?.blob || null : await videoBlob(v);
  if (!v) { el.innerHTML = `<header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>動画が見つかりません</h1></header><div class="card muted">削除された可能性があります。</div>`; return; }
  const vlang = v.lang || 'en';
  const TL = L(vlang).name;
  let cues = await cuesOf(v.id);
  const view = await loadView();
  const saveView = () => setSetting('video.view', view);
  let loop = null, ab = null, curId = null, rafId = 0, saveT = 0, seekT = 0, loopN = 0, stepCue = null, revealedCue = null, editing = false;
  const revealed = new Map();   // cueId -> Set(hole index)
  const url = parts ? parts[0]?.url || '' : fileBlob ? URL.createObjectURL(fileBlob) : '';
  const aurl = '';   // (1.3.1–1.3.2 used a separate sound file; now the chosen track of the video itself is played)
  const MLABEL = (m) => MODES.find((x) => x[0] === m)[1].replace('英', L(vlang).ch);

  el.innerHTML = `
    <div class="vp-root" id="vroot">
    <header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1 class="vtitle">${esc(v.name)}</h1><span class="grow"></span><button class="icon-btn vh-btn vmode-btn" id="openMode" aria-label="学習モード">🎛</button><button class="icon-btn vh-btn" id="openSet" aria-label="表示・学習の設定">⚙︎</button><button class="icon-btn vh-btn" id="openMake" aria-label="字幕・日本語訳">字</button><button class="icon-btn" id="menu" aria-label="メニュー">⋯</button></header>
    <div class="vwrap">${!url ? '<div class="card warn">動画ファイルがありません（バックアップから復元した場合は、動画をもう一度追加してください）</div>'
      : aurl ? `<video id="vpic" src="${url}" muted playsinline webkit-playsinline preload="metadata"></video><audio id="vid" src="${aurl}" preload="auto" playsinline></audio>`
      : `<video id="vid" src="${url}" playsinline webkit-playsinline preload="metadata"></video>`}</div>
    <div class="vbottom"><div class="vbin">
      <div class="vseek" id="seek"><div class="vs-track"><i class="vs-range" id="sRange"></i><i class="vs-played" id="sPlayed"></i><i class="vs-head" id="sHead"></i></div></div>
      <div class="vs-info small"><span id="sTime">0:00.0</span><span id="sRangeTxt" class="grow center"></span><button class="link small" id="sClear" hidden>区間を解除</button></div>
      <div class="vctl2b">
        <button class="vb vb-speed" id="speed" aria-label="速さ">1×</button>
        <button class="vb vb-skip" id="prevCue" aria-label="この文の頭へ・前の文">⏮</button>
        <button class="vb vb-step" id="back" aria-label="戻す（長押しで秒数）">⟲3</button>
        <button class="vb vb-play" id="play" aria-label="再生">▶︎</button>
        <button class="vb vb-step" id="fwd" aria-label="送る（長押しで秒数）">3⟳</button>
        <button class="vb vb-skip" id="nextCue" aria-label="次の文">⏭</button>
        <span class="vb-speed vb-spacer"></span>
      </div>
    </div></div>
    <div class="subbox" id="sub"></div>
    <div id="grade"></div>
    <div class="vsheet" id="shMode" hidden><div class="vsheet-in card stack"><div class="row between"><b>学習モード</b><button class="btn sm" data-shclose>閉じる</button></div>
    <div class="vquick vquick-sheet">
      <button class="tgl" id="qMode"></button>
      <button class="tgl" id="qDict">ディクテーション</button>
      <button class="tgl" id="qShadow">シャドーイング</button>
      <button class="tgl" id="qRange">字幕で区間指定</button>
      <button class="tgl" id="qCloze">穴埋め</button>
      <button class="tgl" id="qLoop">ループ</button>
      <button class="tgl" id="qTest">字幕なしテスト</button>
    </div></div></div>
    <div id="dict" class="card stack dict" hidden></div>
    <div id="shadow" class="card stack" hidden></div>
    <div class="vsheet" id="shSet" hidden><div class="vsheet-in card stack"><div class="row between"><b>表示・学習の設定</b><button class="btn sm" data-shclose>閉じる</button></div><div class="vset stack" id="set">
      <div class="fgrp"><span>2言語のとき</span><div class="seg" id="order"><button data-v="en">${esc(L(vlang).ch)}が上</button><button data-v="ja">日本語が上</button></div></div>
      <div class="fgrp"><span>${esc(TL)}の透明度</span><div class="seg" id="opEn">${OPS.map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>${esc(TL)}の文字</span><div class="seg" id="fsEn">${FS_EN.map(([n, l]) => `<button data-v="${n}">${l}</button>`).join('')}</div></div>
      <div class="fgrp"><span>日本語の透明度</span><div class="seg" id="opJa">${OPS.map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>日本語の文字</span><div class="seg" id="fsJa">${FS_JA.map(([n, l]) => `<button data-v="${n}">${l}</button>`).join('')}</div></div>
      <label class="chk"><input type="checkbox" id="step"> 1文ごとに一時停止</label>
      <div class="fgrp"><span>ループ</span><div class="seg" id="loopMax"><button data-v="0">ずっと</button><button data-v="3">3回で次の文へ</button></div></div>
      <button class="btn sm" id="tAB">A-B区間リピート</button>
      <h3 class="sub">穴埋め</h3>
      <div class="fgrp"><span>隠す単位</span><div class="seg" id="clozeUnit"><button data-v="word">単語</button><button data-v="phrase">熟語（続けて選ぶとまとまる）</button></div></div>
      <div class="fgrp"><span>穴の選び方</span><div class="seg" id="clozeAuto"><button data-v="0">手動</button><button data-v="1">自動の候補を使う</button></div></div>
      <label class="chk"><input type="checkbox" id="jaHint"> 日本語訳をヒントとして表示（字幕モードに関係なく）</label>
      <div class="row"><button class="btn sm grow" id="edit">穴を選ぶ（語をタップ）</button><button class="btn sm grow" id="autoGo">自動の候補で穴を作る</button></div>
      <div id="czStats" class="small"></div>
    </div></div></div>
    <div class="vsheet" id="shMake" hidden><div class="vsheet-in card stack"><div class="row between"><b>字幕・日本語訳</b><button class="btn sm" data-shclose>閉じる</button></div><div id="make">
      <div class="stack">
        <p class="hint">字幕の自動作成・前後のカット・スクリプト合わせは<b>教材スタジオ</b>で行います（ここは再生と学習用）。字幕ファイル（SRT/VTT）の読み込みと日本語訳の依頼はここでもできます。</p>
        <button class="btn" id="askClaude" ${cues.some((c) => c.en) ? '' : 'disabled'}>日本語訳をClaudeに頼む（依頼文ごとコピー）</button>
        <button class="btn" data-paste="ja">返ってきた日本語訳を貼り付け</button>
        <label class="btn" for="fEn">${esc(TL)}字幕ファイル（SRT/VTT）を読み込む</label>
        <label class="btn" for="fJa">日本語訳ファイルを読み込む</label>
        <button class="btn" data-paste="en">${esc(TL)}字幕を貼り付け</button>
      </div></div></div></div>
    <p class="small muted center" id="modeTxt"></p>
    <div class="row between"><h2 class="sec" style="margin:14px 4px 6px">字幕 <span class="muted small">${cues.length}行</span></h2><button class="link small" id="addCue">＋ 現在位置に追加</button></div>
    <div class="cuelist" id="cl"></div>
    <input type="file" id="fEn" hidden><input type="file" id="fJa" hidden>
    </div>`;

  const root = $('#vroot', el), sub = $('#sub', el), cl = $('#cl', el);
  // subtitle list follows the sound, gently; when you scroll it yourself (to read a line that has passed) it stops following
  // until you tap 「現在の行へ」 or a line, or leave it for 20 seconds
  let followOff = 0;
  const followBtn = document.createElement('button'); followBtn.className = 'btn sm vfollow'; followBtn.textContent = '↧ 現在の行へ'; followBtn.hidden = true;
  cl?.before(followBtn);
  const followCue = (row, force = false) => {
    if (!cl || !row) return;
    if (!force && followOff && Date.now() - followOff < 20000) { followBtn.hidden = false; return; }
    followOff = 0; followBtn.hidden = true;
    const top = row.offsetTop - cl.offsetTop, y = top - cl.scrollTop, h = cl.clientHeight;
    if (force || y < h * 0.12 || y + row.offsetHeight > h * 0.75) cl.scrollTo({ top: Math.max(0, top - h * 0.25), behavior: 'smooth' });
  };
  if (cl) {
    const off = () => { followOff = Date.now(); };
    cl.addEventListener('touchmove', off, { passive: true }); cl.addEventListener('wheel', off, { passive: true });
    cl.addEventListener('click', () => { followOff = 0; followBtn.hidden = true; });
    followBtn.onclick = () => { followOff = 0; followCue(cl.querySelector('.cue.cur'), true); };
  }
  const vid = parts && $('#vid', el) ? multiMedia($('#vid', el), parts) : $('#vid', el);
  // while typing (dictation) the keyboard is up: hide the bottom buttons so they do not cover the input
  root?.addEventListener('focusin', (e) => { if (e.target.matches('textarea, input[type=text], input:not([type])')) document.body.classList.add('vtyping'); });
  root?.addEventListener('focusout', () => setTimeout(() => { if (!root.contains(document.activeElement) || !document.activeElement.matches('textarea, input')) document.body.classList.remove('vtyping'); }, 50));
  if (missingPart) toast('この教材の音声の一部が見つかりません（元の音声の教材が削除された可能性）', 5000);
  // every play: ask iOS for the "playback" sound session inside the tap (it can drop back after the app is reopened → no sound)
  if (vid) { const _play = vid.play.bind(vid); vid.play = () => { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} return _play(); }; }
  // sound only: a slim bar instead of a black video area
  const markAudio = () => {
    if (!vid || !(parts || String(v.mime || '').startsWith('audio') || (vid.readyState >= 1 && !vid.videoWidth))) return;
    $('.vwrap', el)?.classList.add('audio');
    const t = $('.vtitle', el); if (t && !t.dataset.audio) { t.dataset.audio = '1'; t.textContent = '🎧 ' + t.textContent; }
  };
  vid?.addEventListener('loadedmetadata', markAudio); markAudio();
  // settings / subtitles open as sheets (hidden by default)
  const sheet = (id, on) => { const x = $(id, el); if (x) x.hidden = !on; };
  $('#openSet', el).onclick = () => sheet('#shSet', true);
  $('#openMake', el).onclick = () => sheet('#shMake', true);
  // 学習モード: one button → a sheet with the modes; the chosen ones are listed next to the button
  // the header button shows a dot while a mode (dictation, shadowing …) is on
  const modeOn = () => { const on = $$('#shMode .tgl.on', el).filter((b) => b.id !== 'qMode').map((b) => b.textContent.trim()); const m = $('#openMode', el); if (m) { m.classList.toggle('on', on.length > 0); m.title = on.join('・'); } };
  $('#openMode', el).onclick = () => sheet('#shMode', true);
  $('#shMode', el).addEventListener('click', (e) => { const b = e.target.closest('.tgl'); if (!b) return; setTimeout(() => { modeOn(); if (b.id !== 'qMode') sheet('#shMode', false); }, 0); });
  setTimeout(modeOn, 0); setTimeout(modeOn, 500);
  $$('.vsheet', el).forEach((x) => x.addEventListener('click', (e) => { if (e.target === x || e.target.closest('[data-shclose]')) x.hidden = true; }));
  const pic = null;
  if (v.audioBlob) { (async () => { const cur = await db.get('videos', v.id); if (cur?.audioBlob) await saveVideoMeta(cur); })(); }   // free the old separate sound file
  // videos saved before: decide the speech track once — only while paused (Web Audio during playback can stop the sound on iPhone)
  if (vid && fileBlob && !v.audioFixed) {
    const check = async () => {
      if (!vid.paused) return setTimeout(check, 3000);
      try {
        const { speechTrackIndex, readable } = await import('./media-audio.js');
        if (!(await readable(fileBlob))) return;
        const fname = v.name + ((v.mime || '').includes('quicktime') ? '.mov' : '.mp4');
        const sp = await speechTrackIndex(fileBlob, fname);
        const cur = await db.get('videos', v.id); if (!cur) return;
        cur.audioChecked = true; cur.audioFixed = true;
        if (sp) {
          const { keepOneAudioTrack } = await import('./media-probe.js');
          toast('音声を直しています（話し声の方だけ残します）…', 8000);
          const f2 = await keepOneAudioTrack(fileBlob, sp.id, { name: fname, type: v.mime || 'video/mp4' }).catch(() => null);
          if (f2) { const { copyBlob } = await import('./media-audio.js'); await putVideoBlob(v.id, await copyBlob(f2, () => {}, { name: fname, type: v.mime || 'video/mp4' })); cur.size = f2.size; delete cur.audioTrack; cur.audioInfo = { count: sp.count, kept: sp.index, reason: sp.reason, auto: sp.auto }; }
          else { cur.audioTrack = sp.index; }
        }
        await saveVideoMeta(cur);
        if (sp && location.hash.includes(v.id)) { toast(`音声が${sp.count}本あったので、話し声の方（音声${sp.index + 1}）だけにしました`, 3500); videoPlay(el, params); }
      } catch {}
    };
    setTimeout(check, 500);
  }
  if (vid && !pic) {
    // several sound tracks (screen recordings: app sound + microphone): play only the one with speech, never mix
    vid.addEventListener('loadedmetadata', enableTrack);
    vid.addEventListener('error', async () => {
      const { readable } = await import('./media-audio.js');
      if (!(await readable(fileBlob)) && (await confirmDialog({ title: '動画データが読めません', body: '<p>保存していた動画データが読めなくなっています（iPhoneが一時ファイルを消した可能性）。字幕・穴埋め・学習記録はそのまま残っています。</p>', okLabel: '動画を選び直す', cancelLabel: '閉じる' }))) relinkVideo();
    });
  }
  // ---- trimming (non-destructive): playback and transcription stay inside [trim.start, trim.end] ----
  function enableTrack() { const at = vid?.audioTracks; if (!at || at.length < 2 || v.audioTrack == null) return; for (let i = 0; i < at.length; i++) at[i].enabled = i === v.audioTrack; }
  {   // speech recognition quality (tap to choose)
    const QT = { fast: '速さ：約40MB・速いが聞き間違いが多い', acc: '標準：約80MB・おすすめ', best: '最高：約250MB・2〜3倍遅い・試験的（iPhoneのメモリによっては止まる）' };
    const drawQ = (q) => { $$('#asrQ button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === q)); $('#asrQtxt', el).textContent = QT[q]; };
    if ($('#asrQ', el)) getSetting('video.asrQ', 'acc').then(drawQ);
    if ($('#asrQ', el)) $('#asrQ', el).onclick = async (e) => { const q = e.target.closest('button')?.dataset.v; if (!q) return; await setSetting('video.asrQ', q); drawQ(q); };
  }
  const showEn = () => view.mode === 'both' || view.mode === 'en';
  const showJa = () => view.mode === 'both' || view.mode === 'ja' || (view.cloze && view.jaHint);

  // ---- appearance (CSS variables / classes only: never touches playback) ----
  function applyView() {
    root.style.setProperty('--fsEn', view.fsEn + 'px'); root.style.setProperty('--fsJa', view.fsJa + 'px');
    root.style.setProperty('--opEn', view.opEn); root.style.setProperty('--opJa', view.opJa);
    root.classList.toggle('jatop', view.order === 'ja');
    root.dataset.mode = view.mode;   // the subtitle box keeps one height per mode (the screen below does not jump)
    if (sub) requestAnimationFrame(fitSub);
    const segOn = (id, val) => $$(`#${id} button`, el).forEach((b) => b.classList.toggle('on', String(b.dataset.v) === String(val)));
    segOn('order', view.order); segOn('opEn', view.opEn); segOn('opJa', view.opJa); segOn('fsEn', view.fsEn); segOn('fsJa', view.fsJa);
    segOn('loopMax', view.loopMax); segOn('clozeUnit', view.clozeUnit); segOn('clozeAuto', view.clozeAuto ? 1 : 0);
    $('#step', el).checked = view.step; $('#jaHint', el).checked = view.jaHint;
    $('#qMode', el).textContent = `字幕：${MLABEL(view.mode)}`;
    $('#qCloze', el).classList.toggle('on', view.cloze);
    $('#qLoop', el).classList.toggle('on', !!loop); $('#qLoop', el).textContent = !loop ? 'ループ' : view.loopMax ? `ループ${view.loopMax}回` : 'ループ∞';
    $('#qTest', el).classList.toggle('on', view.test);
    $('#qDict', el).classList.toggle('on', dictOn); $('#qShadow', el).classList.toggle('on', shadowOn); $('#qRange', el).classList.toggle('on', !!rangeMode);
    $('#tAB', el).classList.toggle('on', !!ab); drawSeek?.(); $('#tAB', el).textContent = !ab ? 'A-B区間リピート' : ab.b == null ? 'B地点を押す' : `A-B ${fmtT(ab.a)}–${fmtT(ab.b)}（押すと解除）`;
    $('#edit', el).classList.toggle('on', editing); $('#edit', el).textContent = editing ? '穴を選び終える' : '穴を選ぶ（語をタップ）';
    $('#autoGo', el).hidden = !view.clozeAuto;
    $('#modeTxt', el).textContent = [view.test ? '聞き取りテスト中：字幕はタップで表示' : '', view.cloze ? '穴埋め：_____ をタップで答え' : '', editing ? '穴を選ぶ：字幕の語をタップ' : '', view.step && !view.test ? '1文ごとに停止' : ''].filter(Boolean).join('・');
    drawSub(); drawList();
  }
  const textHTML = (c, where) => {
    const en = c.en ? (view.cloze || editing ? clozeHTML(c.en, c.holes || [], { lang: vlang, revealed: revealed.get(c.id) || new Set(), editing, cueId: c.id }) : esc(c.en)) : '';
    const veil = where === 'sub' && view.test && revealedCue !== c.id ? ' veil' : '';
    const parts = [];
    if (showEn() && c.en) parts.push(`<div class="sen${veil}" ${langAttr(vlang)}>${en}</div>`);
    if (showJa() && c.ja) parts.push(`<div class="sja${veil}">${esc(c.ja)}</div>`);
    return parts.join('');
  };
  function drawSub() {
    const c = cues.find((x) => x.id === curId);
    sub.innerHTML = c ? textHTML(c, 'sub') + (view.test && revealedCue !== c.id ? '<span class="subhint">タップで字幕を表示</span>' : '') : '';
    sub.classList.toggle('empty', !sub.innerHTML);
    fitSub();
  }
  // the box keeps its height; a long sentence gets smaller letters instead of scrolling
  function fitSub() {
    let f = 1; sub.style.setProperty('--fit', 1);
    while (sub.scrollHeight > sub.clientHeight + 1 && f > 0.55) { f -= 0.07; sub.style.setProperty('--fit', f.toFixed(2)); }
  }
  function drawList() {
    if (!cues.length) { cl.innerHTML = `<div class="card stack"><p class="small muted">字幕がまだありません。上の「字幕を作る・読み込む」から作成・読み込みできます。</p></div>`; return; }
    cl.innerHTML = cues.map((c) => `
      <div class="cue ${c.id === curId ? 'cur' : ''}" data-id="${c.id}">
        <span class="ct">${fmtT(c.start)}</span>
        <span class="grow ctext ${view.test && !rangeMode ? 'veil' : ''}">${rangeMode && c.en ? `<div class="sen" ${langAttr(vlang)}>${toks(c).map((k, i) => `<span class="rk" data-rk="${c.id}:${i}">${esc(k.w)}</span>`).join(' ')}</div>` : textHTML(c, 'list') || '<span class="muted small">（非表示）</span>'}</span>
        ${c.en ? `<button class="cbtn" data-word="${c.id}" aria-label="単語登録">＋語</button>` : ''}
        <button class="cbtn" data-edit="${c.id}" aria-label="編集">✎</button>
      </div>`).join('');
  }
  function drawStats() {
    const holes = cues.flatMap((c) => (c.holes || []).map((h, i) => ({ c, h, i })));
    const ok = holes.filter((x) => x.h.last === 'ok').length, ng = holes.filter((x) => x.h.last === 'ng');
    $('#czStats', el).innerHTML = holes.length ? `穴 ${holes.length}個（聞けた ${ok}・聞けなかった ${ng.length}・未回答 ${holes.length - ok - ng.length}）
      ${ng.length ? `<div class="stack" style="margin-top:6px">${ng.map((x) => `<div class="row between"><span>「${esc(x.h.text)}」</span><button class="btn sm" data-addng="${x.c.id}:${x.i}">単語帳に追加</button></div>`).join('')}</div>` : ''}` : '<span class="muted">まだ穴がありません</span>';
  }

  function cueAt(t) { let r = null; for (const c of cues) { if (c.start <= t && t < c.end) r = c; if (c.start > t) break; } return r; }
  function tick() {
    if (!vid) return;
    const t = vid.currentTime;
    if (loop && t >= loop.end) {
      loopN++;
      if (view.loopMax && loopN >= view.loopMax) {
        const nx = cues.find((x) => x.start >= loop.end - 0.01);
        if (nx) { loop = { start: nx.start, end: nx.end }; loopN = 0; vid.currentTime = nx.start; } else { loop = null; vid.pause(); applyView(); }
      } else vid.currentTime = loop.start;
    }
    if (ab?.b != null && t >= ab.b) vid.currentTime = ab.a;
    if (shadowOn) shadowTick(t);
    if ((view.step || view.test) && !loop && stepCue && t >= stepCue.end - 0.03 && !vid.paused) { vid.pause(); vid.currentTime = Math.max(stepCue.start, stepCue.end - 0.05); stepCue = null; }
    const c = cueAt(t), id = c?.id || null;
    if (id !== curId) {
      curId = id; if (c) { stepCue = c; revealedCue = null; }
      drawSub();
      $$('.cue.cur', cl).forEach((x) => x.classList.remove('cur'));
      const row = id && cl.querySelector(`[data-id="${id}"]`);
      if (row) { row.classList.add('cur'); followCue(row); }
    }
    if (v.trim && !vid.seeking) {
      if (t < v.trim.start - 0.05) vid.currentTime = v.trim.start;
      else if (t >= v.trim.end && !vid.paused && !(ab?.b != null)) { vid.pause(); vid.currentTime = Math.max(v.trim.start, v.trim.end - 0.05); }
    }
    if (Date.now() - seekT > 200 || vid.paused) { seekT = Date.now(); drawSeek?.(); }   // the bar: 5 times a second while playing (was a timer that never stopped)
    if (Date.now() - saveT > 3000) { saveT = Date.now(); savePos(); }
    rafId = vid.paused ? 0 : requestAnimationFrame(tick);   // runs only while playing (no work while paused)
  }
  const kick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };   // one update after a seek while paused, or the loop again on play
  let savedT = -1;
  async function savePos() {   // only when the position really changed
    if (!vid) return; const t = vid.currentTime; if (Math.abs(t - savedT) < 0.5) return; savedT = t;
    const cur = await db.get('videos', v.id); if (cur) { cur.lastTime = t; cur.playedAt = Date.now(); await saveVideoMeta(cur); }
  }
  const playFrom = (c) => { if (!vid || !c) return; vid.currentTime = c.start + 0.01; stepCue = c; revealedCue = null; if (loop) { loop = { start: c.start, end: c.end }; loopN = 0; } vid.play(); };

  // ---- cloze grading ----
  async function gradeHole(c, hi, ok) {
    const h = c.holes[hi];
    h[ok ? 'ok' : 'ng'] = (h[ok ? 'ok' : 'ng'] || 0) + 1; h.last = ok ? 'ok' : 'ng'; h.lastAt = Date.now();
    await db.put('cues', c);
    const vocab = (await wordsByHead(vlang)).get(headKey(h.text))?.[0];
    await recordAnswer({ sessionId: 'video:' + v.id, qid: `${c.id}:${hi}:${Date.now()}`, wordId: vocab ? vocab.id : `cz_${c.id}_${h.s}`, direction: 'audio', format: 'video-cloze', mode: 'video', prompt: c.en, answer: ok ? '聞けた' : '聞けなかった', ms: 0, self: true,
      results: [{ skill: 'listening', correct: ok, hint: false }], srs: vocab ? { kind: 'word', lang: vlang } : { kind: 'cloze', lang: vlang } });
    $('#grade', el).innerHTML = ok ? '' : `<div class="hgrade">「${esc(h.text)}」を記録しました <button class="btn sm" data-addng="${c.id}:${hi}">単語帳に追加</button></div>`;
    drawSub(); drawList(); drawStats();
  }
  async function addToVocab(c, hi) {
    const h = c.holes[hi];
    const ref = { videoId: v.id, cueId: c.id, time: c.start, text: c.en };
    const exist = (await wordsByHead(vlang)).get(headKey(h.text))?.[0];
    if (exist) {
      exist.videoRefs = [...(exist.videoRefs || []).filter((r) => r.cueId !== c.id), ref];
      const s0 = exist.senses[0]; if (!(s0.examples || []).some((x) => x.en === c.en)) s0.examples = [...(s0.examples || []), { en: c.en, ja: c.ja || '' }];
      await saveWord(exist); toast(`「${exist.headword}」は登録済み：例文と動画の位置を追加しました`); return;
    }
    const w = newWord({ lang: vlang, headword: h.text, source: { type: 'video', ...ref }, tags: ['動画の穴埋め'], senses: [newSense({ examples: [{ en: c.en, ja: c.ja || '' }] })] });
    w.videoRefs = [ref]; await saveWord(w);
    toast(`「${w.headword}」を単語帳に追加しました（意味は詳細画面で入力）`);
  }

  // ---- subtitle box & list taps ----
  function onTextTap(e) {
    const hole = e.target.closest('.hole');
    if (hole) {
      e.stopPropagation();
      const c = cues.find((x) => x.id === hole.dataset.cue), hi = +hole.dataset.hole;
      const set = revealed.get(c.id) || new Set(); revealed.set(c.id, set);
      if (set.has(hi)) { set.delete(hi); $('#grade', el).innerHTML = ''; }
      else {
        set.add(hi);
        $('#grade', el).innerHTML = `<div class="hgrade">「${esc(c.holes[hi].text)}」 <button class="btn sm ok" data-g="1" data-c="${c.id}" data-h="${hi}">聞けた</button><button class="btn sm ng" data-g="0" data-c="${c.id}" data-h="${hi}">聞けなかった</button></div>`;
      }
      drawSub(); drawList(); return true;
    }
    const tok = e.target.closest('.ctok');
    if (tok && editing) {
      e.stopPropagation();
      const c = cues.find((x) => x.id === tok.dataset.cue);
      toggleToken(c, +tok.dataset.t, view.clozeUnit, vlang);
      db.put('cues', c); revealed.delete(c.id);
      drawSub(); drawList(); drawStats(); return true;
    }
    return false;
  }
  sub.addEventListener('click', (e) => {
    if (onTextTap(e)) return;
    const c = cues.find((x) => x.id === curId); if (!c) return;
    if (view.test && revealedCue !== c.id) { revealedCue = c.id; drawSub(); return; }
    if (!editing && c.en) wordFromCue(c.id);
  });
  $('#grade', el).addEventListener('click', async (e) => {
    const g = e.target.closest('[data-g]');
    if (g) { const c = cues.find((x) => x.id === g.dataset.c); return gradeHole(c, +g.dataset.h, g.dataset.g === '1'); }
    const a = e.target.closest('[data-addng]'); if (a) { const [cid, hi] = a.dataset.addng.split(':'); await addToVocab(cues.find((x) => x.id === cid), +hi); $('#grade', el).innerHTML = ''; }
  });
  $('#czStats', el).addEventListener('click', async (e) => { const a = e.target.closest('[data-addng]'); if (a) { const [cid, hi] = a.dataset.addng.split(':'); await addToVocab(cues.find((x) => x.id === cid), +hi); a.disabled = true; } });
  cl.addEventListener('click', (e) => {
    if (onTextTap(e)) return;
    const w = e.target.closest('[data-word]'); if (w) return wordFromCue(w.dataset.word);
    const ed = e.target.closest('[data-edit]'); if (ed) return editCue(ed.dataset.edit);
    const row = e.target.closest('.cue'); if (!row) return;
    const c = cues.find((x) => x.id === row.dataset.id);
    if (dictOn) { dictTyped = ''; return setRange(c.start, c.end, c.en); }   // dictation: the tapped sentence becomes the repeat range
    if (shadowOn) { shadow.cur = c; shadow.n = 0; shadow.waiting = false; clearTimeout(shadowT); }
    playFrom(c);
  });

  // ================= dictation / shadowing tools =================
  const STEPS = [3, 5, 10], RATES = [1, 0.7, 0.5];
  let stepSec = (await getSetting('video.stepSec', 3)) || 3, dictOn = false, rangeMode = null, shadowOn = false, shadowT = null;
  const shadow = { gap: (await getSetting('video.shGap', 1.5)) || 1.5, rep: (await getSetting('video.shRep', 1)) || 1, n: 0, waiting: false };
  // words of a cue with estimated times (spread by characters inside the cue)
  const toks = (c) => { const out = []; const re = /\S+/g; let m; const L0 = Math.max(1, (c.en || '').length); while ((m = re.exec(c.en || ''))) out.push({ w: m[0], t0: c.start + ((c.end - c.start) * m.index) / L0, t1: c.start + ((c.end - c.start) * (m.index + m[0].length)) / L0 }); return out; };
  // text inside the current range (A–B), or the current / next sentence
  function targetText() {
    if (ab?.b != null) {
      if (ab.text) return ab.text;
      return cues.flatMap((c) => toks(c).filter((k) => (k.t0 + k.t1) / 2 >= ab.a - 0.05 && (k.t0 + k.t1) / 2 <= ab.b + 0.05).map((k) => k.w)).join(' ');
    }
    const t = vid?.currentTime || 0; const c = cueAt(t) || cues.find((x) => x.start >= t) || cues[cues.length - 1];
    return c?.en || '';
  }
  function setRange(a, b, text = null) {
    if (b - a < 0.2) return;
    ab = { a: Math.max(0, a), b: Math.min(vid?.duration || b, b), text }; loop = null;
    if (vid) { vid.currentTime = ab.a; vid.play().catch(() => {}); }
    applyView(); drawSeek(); if (dictOn) drawDict();
  }
  function clearRange() { ab = null; rangeMode = null; applyView(); drawSeek(); if (dictOn) drawDict(); }
  // ---- wide seek bar: tap = jump, drag = choose a range that repeats ----
  const seekEl = $('#seek', el);
  function drawSeek() {
    if (!vid || !seekEl) return;
    const D = vid.duration || 1, t = vid.currentTime || 0;
    $('#sPlayed', el).style.width = `${(t / D) * 100}%`; $('#sHead', el).style.left = `${(t / D) * 100}%`;
    const r = $('#sRange', el);
    if (ab?.b != null) { r.hidden = false; r.style.left = `${(ab.a / D) * 100}%`; r.style.width = `${((ab.b - ab.a) / D) * 100}%`; $('#sRangeTxt', el).textContent = `区間 ${fmtT(ab.a)}–${fmtT(ab.b)} をくり返し`; $('#sClear', el).hidden = false; }
    else { r.hidden = true; $('#sRangeTxt', el).textContent = 'バーを指でなぞると区間をくり返し'; $('#sClear', el).hidden = true; }
    $('#sTime', el).textContent = `${fmtT(t)} / ${fmtT(D)}`;
  }
  if (seekEl) {
    let d = null;
    const posT = (x) => { const r = seekEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (vid?.duration || 0); };
    seekEl.addEventListener('pointerdown', (e) => { if (!vid) return; seekEl.setPointerCapture(e.pointerId); d = { x0: e.clientX, t0: posT(e.clientX), moved: false }; });
    seekEl.addEventListener('pointermove', (e) => {
      if (!d) return; if (!d.moved && Math.abs(e.clientX - d.x0) < 8) return; d.moved = true;
      const t1 = posT(e.clientX), a = Math.min(d.t0, t1), b = Math.max(d.t0, t1), D = vid.duration || 1, r = $('#sRange', el);
      r.hidden = false; r.style.left = `${(a / D) * 100}%`; r.style.width = `${((b - a) / D) * 100}%`; $('#sRangeTxt', el).textContent = `${fmtT(a)}–${fmtT(b)}`;
    });
    seekEl.addEventListener('pointerup', (e) => {
      if (!d) return; const t1 = posT(e.clientX), x = d; d = null;
      if (!x.moved) { vid.currentTime = t1; if (ab?.b != null && (t1 < ab.a || t1 > ab.b)) ab = null; drawSeek(); applyView(); return; }
      setRange(Math.min(x.t0, t1), Math.max(x.t0, t1));
    });
    seekEl.addEventListener('pointercancel', () => { d = null; drawSeek(); });
    $('#sClear', el).onclick = clearRange;
    vid?.addEventListener('loadedmetadata', drawSeek);
  }
  // ---- back / forward (seconds cycle 3 → 5 → 10), speed (1 → 0.7 → 0.5) ----
  const drawSteps = () => { $('#back', el).textContent = `⟲${stepSec}`; $('#fwd', el).textContent = `${stepSec}⟳`; };
  drawSteps();
  // long press on ⟲ / ⟳: the seconds appear above the button; slide onto one and let go to choose
  const pressSteps = (btn) => {
    let timer = null, pop = null, pick = null, used = false;
    const close = () => { pop?.remove(); pop = null; pick = null; };
    btn.addEventListener('pointerdown', (e) => {
      used = false; clearTimeout(timer);
      timer = setTimeout(() => {
        used = true; try { navigator.vibrate?.(10); } catch {}
        const r = btn.getBoundingClientRect();
        pop = document.createElement('div'); pop.className = 'vsteps';
        pop.innerHTML = STEPS.map((n) => `<span data-n="${n}" class="${n === stepSec ? 'on' : ''}">${n}秒</span>`).join('');
        document.body.appendChild(pop);
        pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2))}px`; pop.style.top = `${r.top - pop.offsetHeight - 10}px`;
        try { btn.setPointerCapture(e.pointerId); } catch {}
      }, 420);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!pop) return;
      const o = document.elementFromPoint(e.clientX, e.clientY)?.closest('.vsteps span');
      $$('span', pop).forEach((x) => x.classList.toggle('hover', x === o)); pick = o ? +o.dataset.n : null;
    });
    const up = async () => { clearTimeout(timer); if (pop) { const n = pick; close(); if (n) { stepSec = n; drawSteps(); toast(`戻す・送る：${n}秒`, 1200); await setSetting('video.stepSec', n); } } };
    btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', () => { clearTimeout(timer); close(); });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => { if (used) { e.stopImmediatePropagation(); e.preventDefault(); used = false; } }, true);
  };
  pressSteps($('#back', el)); pressSteps($('#fwd', el));
  $('#back', el).onclick = () => { if (vid) vid.currentTime = Math.max(ab?.b != null ? ab.a : 0, vid.currentTime - stepSec); };
  $('#fwd', el).onclick = () => { if (vid) vid.currentTime = Math.min(ab?.b != null ? ab.b - 0.05 : vid.duration || 1e9, vid.currentTime + stepSec); };
  // ---- range from the subtitle text: tap the first word, then the last word ----
  $('#qRange', el).onclick = () => { rangeMode = rangeMode ? null : { first: null }; if (rangeMode) toast('字幕の一覧で、区間の最初の語→最後の語をタップ', 3000); applyView(); };
  cl.addEventListener('click', (e) => {
    if (!rangeMode) return;
    const k = e.target.closest('[data-rk]'); if (!k) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const [cid, i] = k.dataset.rk.split(':'); const c = cues.find((x) => x.id === cid), tk = toks(c)[+i];
    if (!rangeMode.first) { rangeMode.first = { c, i: +i, tk }; k.classList.add('rsel'); toast('最後の語をタップ', 1500); return; }
    let A = rangeMode.first, B = { c, i: +i, tk };
    if (B.tk.t0 < A.tk.t0) [A, B] = [B, A];
    const words = cues.filter((x) => x.start >= A.c.start && x.start <= B.c.start).flatMap((x) => toks(x).filter((t) => t.t0 >= A.tk.t0 - 0.001 && t.t0 <= B.tk.t0 + 0.001).map((t) => t.w));
    rangeMode = null;
    setRange(A.tk.t0 - 0.15, B.tk.t1 + 0.25, words.join(' '));
  }, true);

  // ---- dictation: type what you hear, compare word by word ----
  const normW = (w) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  function compareWords(answer, typed) {
    const A = answer.split(/\s+/).filter(Boolean), T = typed.split(/\s+/).filter(Boolean);
    const a = A.map(normW), t = T.map(normW);
    const names = new Set((v.properNouns || []).flatMap((x) => x.split(/\s+/)).map(normW).filter(Boolean));
    const del = (i) => (names.has(a[i]) ? 0 : 1);   // a registered proper noun may be left out (counted as given)
    const n = a.length, m = t.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + del(i - 1); for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + del(i - 1), dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === t[j - 1] ? 0 : 1));
    const ops = []; let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === t[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { ops.push({ k: 'ok', a: A[i - 1], t: T[j - 1] }); i--; j--; }
      else if (i > 0 && names.has(a[i - 1]) && dp[i][j] === dp[i - 1][j]) { ops.push({ k: 'ok', a: A[i - 1], t: '', name: true }); i--; }
      else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) { ops.push({ k: 'sub', a: A[i - 1], t: T[j - 1] }); i--; j--; }
      else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { ops.push({ k: 'miss', a: A[i - 1], t: '' }); i--; }
      else { ops.push({ k: 'extra', a: '', t: T[j - 1] }); j--; }
    }
    ops.reverse();
    // group: runs of matches become one chunk; runs of differences become one two-line chunk (typed in red / answer in green)
    const chunks = []; for (const o of ops) { const ok = o.k === 'ok'; const last = chunks[chunks.length - 1]; if (last && last.ok === ok) last.ops.push(o); else chunks.push({ ok, ops: [o] }); }
    const good = ops.filter((o) => o.k === 'ok').length;
    return { chunks, good, total: a.length, perfect: good === a.length && !ops.some((o) => o.k === 'extra') };
  }
  function diffHTML(r) {
    return r.chunks.map((ch) => ch.ok
      ? `<span class="dk ok">${ch.ops.map((o) => (o.name ? `<u class="dk-name">${esc(o.a)}</u>` : esc(o.a))).join(' ')}</span>`
      : `<span class="dk ng"><span class="dk-t">${esc(ch.ops.map((o) => o.t).filter(Boolean).join(' ')) || '＿'}</span><span class="dk-a">${esc(ch.ops.map((o) => o.a).filter(Boolean).join(' ')) || '（不要）'}</span></span>`).join(' ');
  }
  let dictTyped = '';
  function drawDict() {
    const box = $('#dict', el); box.hidden = !dictOn; if (!dictOn) return;
    const target = targetText();
    box.innerHTML = `<div class="row between"><b>ディクテーション</b><span class="small muted">${ab?.b != null ? `区間 ${fmtT(ab.a)}–${fmtT(ab.b)}` : '今の文'}</span></div>
      <div class="row"><button class="btn sm" id="dPlay">▶︎ 聞く（くり返し）</button><button class="btn sm" id="dNext">次の文へ</button></div>
      <div class="row dnames"><span class="small muted">固有名詞：</span>${(v.properNouns || []).map((x, i) => `<button class="chip" data-pn="${i}">${esc(x)}</button>`).join('') || '<span class="small muted">なし</span>'}<button class="link small" id="dPN">${(v.properNouns || []).length ? '編集' : '＋登録'}</button></div>
      <textarea id="dIn" rows="3" placeholder="聞こえた英語を入力" autocapitalize="off" autocorrect="off" spellcheck="false" ${langAttr(vlang)}>${esc(dictTyped)}</textarea>
      <div class="row"><button class="btn primary grow" id="dCheck">判定</button><button class="btn sm" id="dShow">答えを見る</button></div>
      <div id="dOut"></div>`;
    $('#dIn', el).oninput = (e) => (dictTyped = e.target.value);
    // proper nouns of this video: tap to insert; if left out, they count as given
    $$('[data-pn]', el).forEach((b) => (b.onclick = () => { const ta = $('#dIn', el), w = v.properNouns[+b.dataset.pn]; const p0 = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, p0) + (p0 && !/\s$/.test(ta.value.slice(0, p0)) ? ' ' : '') + w + ' ' + ta.value.slice(p0); dictTyped = ta.value; ta.focus(); }));
    $('#dPN', el).onclick = async () => {
      const cur = (v.properNouns || []).join(', ');
      const ans = prompt('この動画の固有名詞（人名・地名など）をカンマ区切りで\n例：Maria, Cleveland, Burns and Associates', cur); if (ans == null) return;
      v.properNouns = [...new Set(ans.split(/[,、，\n]/).map((x) => x.trim()).filter(Boolean))];
      const dbv = await db.get('videos', v.id); if (dbv) { dbv.properNouns = v.properNouns; await saveVideoMeta(dbv); }
      drawDict();
    };
    $('#dPlay', el).onclick = () => {
      if (ab?.b == null) { const t = vid.currentTime; const c = cueAt(t) || cues.find((x) => x.start >= t); if (c) setRange(c.start, c.end, c.en); return; }
      vid.currentTime = ab.a; vid.play().catch(() => {});
    };
    $('#dNext', el).onclick = () => { const c = cues.find((x) => x.start > (ab?.b != null ? ab.a : vid.currentTime) + 0.05); dictTyped = ''; if (c) setRange(c.start, c.end, c.en); else toast('最後の文です'); };
    $('#dShow', el).onclick = () => { $('#dOut', el).innerHTML = `<div class="dans">${esc(target)}</div>`; };
    $('#dCheck', el).onclick = async () => {
      if (!target) return toast('答えの字幕がありません');
      if (!dictTyped.trim()) return toast('聞こえた英語を入力してください');
      const r = compareWords(target, dictTyped);
      $('#dOut', el).innerHTML = `<div class="small ${r.perfect ? 'ok-text' : ''}">${r.perfect ? '全部合っています！' : `${r.good} / ${r.total} 語が一致`}</div><div class="dline">${diffHTML(r)}</div>`;
      // keep a small record on the sentence (used later for review)
      const c = cues.find((x) => x.start <= (ab?.a ?? vid.currentTime) + 0.3 && x.end >= (ab?.a ?? vid.currentTime)); if (c) { c.dict = { n: (c.dict?.n || 0) + 1, best: Math.max(c.dict?.best || 0, r.good / Math.max(1, r.total)), last: r.good / Math.max(1, r.total), at: Date.now() }; db.put('cues', c); }
    };
  }
  $('#qDict', el).onclick = () => {
    dictOn = !dictOn; if (dictOn) { shadowOn = false; view.test = true; dictTyped = ''; const t = vid?.currentTime || 0; const c = ab?.b != null ? null : cueAt(t) || cues.find((x) => x.start >= t); if (c) setRange(c.start, c.end, c.en); }
    else view.test = false;
    applyView(); drawDict(); drawShadow();
  };
  // ---- shadowing: play a sentence, pause so you can repeat, then go on ----
  function drawShadow() {
    const box = $('#shadow', el); box.hidden = !shadowOn; if (!shadowOn) return;
    box.innerHTML = `<div class="row between"><b>シャドーイング</b><span class="small muted" id="shSt">${shadow.waiting ? '今、くり返して言う番です' : '聞いて、続けて言う'}</span></div>
      <div class="row"><button class="btn sm" id="shGap">間：文の${shadow.gap}倍</button><button class="btn sm" id="shRep">${shadow.rep}回ずつ</button><button class="btn sm" id="shStart">${vid?.paused ? '▶︎ 始める' : '❚❚ 止める'}</button></div>
      <p class="hint">文が終わると止まり、その文の長さ×「間」だけ待って次へ進みます。字幕の表示は上の「字幕：」で切り替え。速さは「1×」ボタン。</p>`;
    $('#shGap', el).onclick = async () => { const G = [1, 1.5, 2]; shadow.gap = G[(G.indexOf(shadow.gap) + 1) % G.length]; await setSetting('video.shGap', shadow.gap); drawShadow(); };
    $('#shRep', el).onclick = async () => { const R = [1, 2, 3]; shadow.rep = R[(R.indexOf(shadow.rep) + 1) % R.length]; await setSetting('video.shRep', shadow.rep); drawShadow(); };
    $('#shStart', el).onclick = () => { if (vid.paused) { clearTimeout(shadowT); shadow.waiting = false; const c = cueAt(vid.currentTime) || cues.find((x) => x.start >= vid.currentTime); if (c) { shadow.cur = c; shadow.n = 0; vid.currentTime = c.start; } vid.play().catch(() => {}); } else { vid.pause(); clearTimeout(shadowT); } drawShadow(); };
  }
  function shadowTick(t) {
    const c = shadow.cur; if (!c || shadow.waiting || vid.paused) return;
    if (t >= c.end - 0.03) {
      vid.pause(); shadow.waiting = true; drawShadow();
      shadowT = setTimeout(() => {
        if (!shadowOn) return; shadow.waiting = false; shadow.n++;
        let nx = c; if (shadow.n >= shadow.rep) { shadow.n = 0; nx = cues.find((x) => x.start >= c.end - 0.01 && x.id !== c.id); }
        if (!nx) { drawShadow(); return toast('最後まで終わりました'); }
        shadow.cur = nx; vid.currentTime = nx.start; vid.play().catch(() => {}); drawShadow();
      }, Math.max(800, (c.end - c.start) * shadow.gap * 1000 / (vid.playbackRate || 1)));
    }
  }
  $('#qShadow', el).onclick = () => { shadowOn = !shadowOn; clearTimeout(shadowT); shadow.waiting = false; if (shadowOn) { dictOn = false; view.test = false; ab = null; loop = null; } applyView(); drawDict(); drawShadow(); drawSeek(); };

  // ---- controls ----
  const jump = (dir) => {
    if (!vid || !cues.length) return;
    const t = vid.currentTime, i = cues.findIndex((x) => x.id === curId);
    const c = dir < 0 ? [...cues].reverse().find((x) => x.start < (i >= 0 ? cues[i].start : t) - 0.05) || cues[0] : cues.find((x) => x.start > t + 0.05);
    playFrom(c);
  };
  // ⏮: back to the start of the sentence being heard; pressed again near its start → the previous sentence
  $('#prevCue', el).onclick = () => {
    if (!vid || !cues.length) return;
    const t = vid.currentTime, c = cueAt(t);
    if (c && t - c.start > 1.2) return playFrom(c);
    jump(-1);
  };
  $('#nextCue', el).onclick = () => jump(1);
  $('#again', el)?.addEventListener('click', () => {   // the phrase being heard, or the one just before if we're between phrases / at its start
    if (!vid || !cues.length) return;
    const t = vid.currentTime;
    const c = cueAt(t) && t - cueAt(t).start > 0.4 ? cueAt(t) : [...cues].reverse().find((x) => x.start < t - 0.05) || cues[0];
    playFrom(c);
  });
  $('#play', el).onclick = () => vid && (vid.paused ? vid.play() : vid.pause());
  $('#speed', el).onclick = async () => {
    const cur = vid?.playbackRate || 1;
    const nx = RATES[(RATES.indexOf(cur) + 1) % RATES.length] ?? 1;
    if (vid) vid.playbackRate = nx; $('#speed', el).textContent = `${nx}×`; await setSetting('video.speed', nx);
  };
  $('#qMode', el).onclick = () => { const i = MODES.findIndex((m) => m[0] === view.mode); view.mode = MODES[(i + 1) % MODES.length][0]; saveView(); applyView(); };
  $('#qCloze', el).onclick = () => { view.cloze = !view.cloze; if (!view.cloze) editing = false; saveView(); applyView(); drawStats(); if (view.cloze && !cues.some((c) => c.holes?.length)) toast(view.clozeAuto ? '設定の「自動の候補で穴を作る」で穴を作れます' : '設定の「穴を選ぶ」で、字幕の語をタップして隠せます', 3200); };
  $('#qLoop', el).onclick = () => {
    if (loop) loop = null;
    else {
      const t = vid?.currentTime || 0;
      const c = cues.find((x) => x.id === curId) || [...cues].reverse().find((x) => x.start <= t);
      if (!c) return toast('ループする字幕がありません');
      loop = { start: c.start, end: c.end }; loopN = 0; ab = null; if (vid) { vid.currentTime = c.start; vid.play(); }
    }
    applyView();
  };
  $('#qTest', el).onclick = () => { view.test = !view.test; revealedCue = null; saveView(); applyView(); };
  const seg = (id, key, num = true) => ($('#' + id, el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view[key] = num ? +b.dataset.v : b.dataset.v; saveView(); applyView(); });
  seg('order', 'order', false); seg('opEn', 'opEn'); seg('opJa', 'opJa'); seg('fsEn', 'fsEn'); seg('fsJa', 'fsJa'); seg('loopMax', 'loopMax'); seg('clozeUnit', 'clozeUnit', false);
  $('#clozeAuto', el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view.clozeAuto = b.dataset.v === '1'; saveView(); applyView(); };
  $('#step', el).onchange = (e) => { view.step = e.target.checked; saveView(); applyView(); };
  $('#jaHint', el).onchange = (e) => { view.jaHint = e.target.checked; saveView(); applyView(); };
  $('#tAB', el).onclick = () => {
    const t = vid?.currentTime || 0;
    if (!ab) { ab = { a: t, b: null }; loop = null; toast('A地点を設定。もう一度押すとB地点'); }
    else if (ab.b == null) { if (t <= ab.a + 0.3) return toast('A地点より後で押してください'); ab.b = t; if (vid) vid.currentTime = ab.a; }
    else ab = null;
    applyView();
  };
  $('#edit', el).onclick = () => { editing = !editing; if (editing && !view.cloze) view.cloze = true; applyView(); };
  $('#autoGo', el).onclick = async () => {
    const vocab = (await db.all('words')).filter((w) => (w.lang || 'en') === vlang);
    let n = 0;
    for (const c of cues) {
      if (!c.en) continue;
      const manual = (c.holes || []).filter((h) => !h.auto);
      const cand = candidates(c.en, vocab, view.clozeUnit, vlang).filter((x) => !manual.some((h) => !(x.e < h.s || x.s > h.e)));
      const keepStats = Object.fromEntries((c.holes || []).filter((h) => h.auto).map((h) => [`${h.s}-${h.e}`, h]));
      c.holes = [...manual, ...cand.map((x) => ({ ...(keepStats[`${x.s}-${x.e}`] || {}), s: x.s, e: x.e, text: x.text, auto: true, why: x.why }))].sort((a, b) => a.s - b.s);
      n += cand.length;
    }
    await db.tx(['cues'], 'readwrite', (t) => cues.forEach((c) => t.objectStore('cues').put(c)));
    view.cloze = true; saveView(); revealed.clear(); applyView(); drawStats();
    toast(n ? `${n}か所を穴にしました（単語帳の語・句動詞・TOEIC頻出語）。手動の穴はそのままです` : '候補が見つかりませんでした');
  };
  $('#askClaude', el).onclick = async () => {
    const srt = toSRT(cues, 'en');
    const text = `次の${TL}のSRT字幕を、自然な日本語に訳してください。番号と時刻はそのまま、同じSRT形式で訳文だけを返してください（説明は不要です）。\n\n${srt}`;
    try { await navigator.clipboard.writeText(text); toast('依頼文をコピーしました。Claudeのチャットに貼り付けて送り、返ってきた字幕を「返ってきた日本語訳を貼り付け」で取り込んでください', 6000); }
    catch { confirmDialog({ title: '依頼文', body: `<p class="hint">全選択してコピーしてください</p><textarea rows="10" readonly style="width:100%">${esc(text)}</textarea>`, okLabel: '閉じる', cancelLabel: null }); }
  };
  $('#make', el).addEventListener('click', (e) => { const p = e.target.closest('[data-paste]'); if (p) pasteDialog(p.dataset.paste); });
  $('#fEn', el).onchange = (e) => importFile(e, 'en');
  $('#fJa', el).onchange = (e) => importFile(e, 'ja');
  $('#addCue', el).onclick = () => editCue(null);
  $('#menu', el).onclick = menu;

  // put the video file back (same subtitles and records) when the saved data became unreadable
  function relinkVideo() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const { copyBlob } = await import('./media-audio.js');
      toast('保存中…', 10000);
      try {
        const { saveVideoCopy } = await import('./media-audio.js'); const sv = await saveVideoCopy(f, { onStep: (m) => toast(m, 10000) });
        await putVideoBlob(v.id, sv.blob);
        delete v.blob; v.size = sv.blob.size; delete v.audioTrack; delete v.audioBlob; v.audioChecked = true; v.audioFixed = true; if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
        await saveVideoMeta(v); toast('動画を選び直しました'); videoPlay(el, params);
      }
      catch (e) { toast('保存できませんでした: ' + (e?.message || e)); }
    };
    inp.click();
  }
  async function importText(text, lang) {
    const list = parseSubs(text);
    if (!list.length) return toast('字幕を読み取れませんでした（SRT / VTT形式か確認してください）');
    if (lang === 'en') {
      if (cues.some((c) => c.en) && !(await confirmDialog({ title: `${TL}字幕を置き換えますか？`, body: '<p>今の字幕は置き換わります。日本語訳は時間が重なる行に付け直します。</p>', okLabel: '置き換える' }))) return;
      const jaOld = cues.filter((c) => c.ja).map((c) => ({ start: c.start, end: c.end, text: c.ja }));
      cues = mergeJa(list.map((x) => ({ id: uid('c_'), videoId: v.id, start: x.start, end: x.end, en: x.text, ja: '' })), jaOld, v.id);
    } else {
      cues.forEach((c) => (c.ja = ''));
      cues = mergeJa(cues.filter((c) => c.en), list, v.id);
    }
    await replaceCues(v.id, cues);
    toast(`${list.length}行を読み込みました`);
    videoPlay(el, params);
  }
  async function importFile(e, lang) { const f = e.target.files[0]; e.target.value = ''; if (f) importText(await f.text(), lang); }
  async function pasteDialog(lang) {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${lang === 'en' ? TL + '字幕' : '日本語訳'}を貼り付け</h3>
      <textarea id="pt" rows="10" placeholder="1&#10;00:00:01,000 --> 00:00:03,500&#10;Hello, everyone." autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">取り込む</button></div></form>`;
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'ok') importText($('#pt', dlg).value, lang); };
    dlg.showModal();
  }

  async function editCue(id) {
    const isNew = !id;
    const t = vid?.currentTime || 0;
    const c = isNew ? { id: uid('c_'), videoId: v.id, start: t, end: t + 2, en: '', ja: '' } : cues.find((x) => x.id === id);
    vid?.pause();
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${isNew ? '字幕を追加' : '字幕を編集'}</h3>
      <div class="row"><label class="field grow"><span>開始（分:秒）</span><input id="es" value="${fmtT(c.start)}" inputmode="decimal"></label><button type="button" class="btn sm" id="nowS">現在位置</button></div>
      <div class="row"><label class="field grow"><span>終了（分:秒）</span><input id="ee" value="${fmtT(c.end)}" inputmode="decimal"></label><button type="button" class="btn sm" id="nowE">現在位置</button></div>
      <label class="field"><span>英語</span><textarea id="een" rows="2" autocapitalize="off" spellcheck="false">${esc(c.en)}</textarea></label>
      <label class="field"><span>日本語訳</span><textarea id="eja" rows="2">${esc(c.ja)}</textarea></label>
      <div class="row between">${isNew ? '<span></span>' : '<button class="btn sm danger" value="del">削除</button>'}<span class="row"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">保存</button></span></div></form>`;
    $('#nowS', dlg).onclick = () => ($('#es', dlg).value = fmtT(vid?.currentTime || 0));
    $('#nowE', dlg).onclick = () => ($('#ee', dlg).value = fmtT(vid?.currentTime || 0));
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue === 'del') {
        if (!(await confirmDialog({ title: 'この字幕を削除', okLabel: '削除', danger: true }))) return;
        await db.delete('cues', c.id); cues = cues.filter((x) => x.id !== c.id); drawList(); drawSub(); return;
      }
      if (dlg.returnValue !== 'ok') return;
      const s = parseT($('#es', dlg).value), e = parseT($('#ee', dlg).value);
      if (!(s >= 0) || !(e > s)) return toast('時間が正しくありません（終了は開始より後）');
      const newEn = $('#een', dlg).value.trim();
      if (newEn !== c.en) c.holes = [];   // token positions changed
      Object.assign(c, { start: s, end: e, en: newEn, ja: $('#eja', dlg).value.trim() });
      await db.put('cues', c);
      if (isNew) cues.push(c);
      cues.sort((a, b) => a.start - b.start);
      curId = null; drawList(); drawSub(); toast('保存しました');
    };
    dlg.showModal();
  }

  async function wordFromCue(id) {
    const c = cues.find((x) => x.id === id);
    vid?.pause();
    if ((v.lang || 'en') !== 'en') { const w = await pickWordsDialog({ text: c.en, ja: c.ja, lang: v.lang, source: { type: 'video', videoId: v.id, cueId: c.id, time: c.start, text: c.en }, title: '字幕から語句を登録' }); if (w) { w.videoRefs = [...(w.videoRefs || []).filter((r) => r.cueId !== c.id), { videoId: v.id, cueId: c.id, time: c.start, text: c.en }]; await saveWord(w); } return; }
    const toks = c.en.split(/(\s+)/);
    let n = 0;
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>字幕から単語を登録</h3>
      <p class="hint">語をタップ（隣り合う語を続けて選ぶと熟語）</p>
      <div class="ptext">${toks.map((tk) => { if (!tk.trim()) return tk; const m = tk.match(/^([^A-Za-z']*)([A-Za-z][A-Za-z'\-]*)([^A-Za-z']*)$/); return m ? `${esc(m[1])}<span class="tok" data-n="${n++}">${esc(m[2])}</span>${esc(m[3])}` : esc(tk); }).join('')}</div>
      ${c.ja ? `<p class="small muted">${esc(c.ja)}</p>` : ''}
      <label class="field"><span>登録する語（編集可）</span><input id="wh" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>意味（「/」で複数・あとで入力も可）</span><input id="wm"></label>
      <label class="chk"><input type="checkbox" id="wb"> ブックマークする</label>
      <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">登録</button></div></form>`;
    const sync = () => {
      const on = $$('.tok.on', dlg).map((t) => +t.dataset.n);
      const all = $$('.tok', dlg);
      if (!on.length) return;
      $('#wh', dlg).value = all.slice(Math.min(...on), Math.max(...on) + 1).map((t) => t.textContent).join(' ');
    };
    $('.ptext', dlg).onclick = (e) => { const t = e.target.closest('.tok'); if (t) { t.classList.toggle('on'); sync(); } };
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const head = $('#wh', dlg).value.trim();
      if (!head) return toast('語を選んでください');
      const ref = { videoId: v.id, cueId: c.id, time: c.start, text: c.en };
      const exist = findDuplicate(await wordsByHead(), head, splitList($('#wm', dlg).value));
      if (exist) {
        exist.videoRefs = [...(exist.videoRefs || []).filter((r) => r.cueId !== c.id), ref];
        const s0 = exist.senses[0];
        if (!(s0.examples || []).some((x) => x.en === c.en)) s0.examples = [...(s0.examples || []), { en: c.en, ja: c.ja || '' }];
        const add = splitList($('#wm', dlg).value).filter((m) => !s0.meanings.includes(m));
        s0.meanings.push(...add);
        if ($('#wb', dlg).checked) exist.bookmarked = true;
        await saveWord(exist);
        toast(`「${exist.headword}」は登録済み：例文と動画の位置を追加しました`);
      } else {
        const w = newWord({ lang: v.lang || 'en', headword: head, bookmarked: $('#wb', dlg).checked, source: { type: 'video', ...ref },
          senses: [newSense({ meanings: splitList($('#wm', dlg).value), examples: [{ en: c.en, ja: c.ja || '' }] })] });
        w.videoRefs = [ref];
        await saveWord(w);
        toast(`「${w.headword}」を登録しました`);
      }
    };
    dlg.showModal();
  }

  async function menu() {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(v.name)}</h3>
      <label class="btn" for="fEn" data-close>${esc(TL)}字幕ファイルを読み込む</label>
      <label class="btn" for="fJa" data-close>日本語訳ファイルを読み込む</label>
      <button class="btn" value="pen">${esc(TL)}字幕を貼り付け</button>
      <button class="btn" value="pja">日本語訳を貼り付け</button>
      <button class="btn" value="copy" ${cues.some((c) => c.en) ? '' : 'disabled'}>${esc(TL)}字幕をコピー（翻訳用SRT）</button>
      <button class="btn" value="rename">名前を変更</button>
      <button class="btn danger" value="del">動画を削除</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.querySelectorAll('[data-close]').forEach((l) => l.addEventListener('click', () => setTimeout(() => dlg.close(), 0)));
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const r = dlg.returnValue;
      if (r === 'pen' || r === 'pja') pasteDialog(r === 'pen' ? 'en' : 'ja');
      else if (r === 'copy') {
        const srt = toSRT(cues, 'en');
        try { await navigator.clipboard.writeText(srt); toast('コピーしました。Claudeのチャットに貼って翻訳を頼めます'); }
        catch { pasteShow(srt); }
      } else if (r === 'rename') {
        const name = prompt('動画の名前', v.name);
        if (name?.trim()) { const cur = await db.get('videos', v.id); cur.name = name.trim(); await saveVideoMeta(cur); videoPlay(el, params); }
      } else if (r === 'del') {
        if (!(await confirmDialog({ title: '動画を削除', body: '<p>動画と字幕を削除します。この動画から登録した単語は残りますが、動画へのリンクは使えなくなります。</p>', okLabel: '削除', danger: true }))) return;
        const old = await db.byIndex('cues', 'videoId', v.id);
        await db.tx(['videos', 'cues', 'vblobs'], 'readwrite', (t) => { t.objectStore('videos').delete(v.id); t.objectStore('vblobs').delete(v.id); old.forEach((c) => t.objectStore('cues').delete(c.id)); });
        toast('削除しました'); go('#video');
      }
    };
    dlg.showModal();
  }
  function pasteShow(text) {
    confirmDialog({ title: `${TL}字幕（SRT）`, body: `<p class="hint">全選択してコピーしてください</p><textarea rows="10" readonly style="width:100%">${esc(text)}</textarea>`, okLabel: '閉じる', cancelLabel: null });
  }


  // ---- start ----
  applyView(); drawStats();
  if (vid) {
    const t0 = params.get('t') != null ? Math.max(0, +params.get('t') - 0.3) : v.lastTime || 0;
    vid.addEventListener('loadedmetadata', () => { if (t0 && t0 < vid.duration) vid.currentTime = t0; }, { once: true });
    vid.addEventListener('play', () => { $('#play', el).textContent = '⏸'; kick(); });
    vid.addEventListener('seeked', kick); vid.addEventListener('loadeddata', kick);
    vid.addEventListener('pause', () => { $('#play', el).textContent = '▶︎'; savePos(); });
    vid.addEventListener('click', () => (vid.paused ? vid.play() : vid.pause()));
    rafId = requestAnimationFrame(tick);
  }
  const speed = await getSetting('video.speed', 1);
  if (vid) vid.playbackRate = SPEEDS.includes(speed) ? speed : 1;
  $('#speed', el).textContent = `${vid?.playbackRate || 1}×`;
  setCleanup(() => { cancelAnimationFrame(rafId); savePos(); vid?.pause(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); });
}
