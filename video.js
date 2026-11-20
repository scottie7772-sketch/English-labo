// Phase 6: Video Lab (local videos + SRT/VTT subtitles + word registration linked to video position)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go } from './ui.js';
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
// lightweight video list without loading blobs into the page
async function videoMetas() {
  return (await db.all('videos')).map(({ blob, ...m }) => ({ ...m, hasBlob: !!blob })).sort((a, b) => b.createdAt - a.createdAt);
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
    <label class="btn primary" for="vfile">＋ 動画を追加（写真・ファイル）</label>
    <input type="file" id="vfile" accept="video/*" hidden>
    <label class="btn" for="vpack" style="margin-top:8px">📦 教材スタジオのパック（.elpack.zip）から追加</label>
    <input type="file" id="vpack" hidden>
    <p class="hint" style="margin-top:6px">30秒〜5分程度の動画向け。動画はこのiPhoneの中だけに保存され、外部には送信されません。JSONバックアップに動画本体は含まれません（字幕は含まれます）。</p>
    <div id="vl">${vids.map((v) => `
      <a class="card vrow" href="#video-play?id=${v.id}">
        <span class="vic">${icon('video', 26)}</span>
        <span class="grow"><b>${esc(v.name)}</b><span class="tagp">${esc(L(v.lang || 'en').short)}</span><span class="small muted block">${v.duration ? fmtT(v.duration).replace(/\.\d$/, '') : ''}・${fmtSize(v.size || 0)}・字幕 ${cueCount[v.id] || 0}行${v.hasBlob ? '' : '・<span class="danger-text">動画ファイルなし</span>'}</span></span>
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
  // material pack from the studio: its sound/video + subtitles (EN/JA) + hidden words become a video lab entry
  $('#vpack', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const { zipRead } = await import('./common-pack.js'); const { copyBlob } = await import('./media-audio.js');
      const z = await zipRead(f);
      const manifest = JSON.parse(await z.text('manifest.json')), mat = JSON.parse(await z.text('material.json'));
      if (manifest.format !== 'elpack') throw new Error('教材スタジオのパックではありません');
      const media = mat.media.filter((m) => m.included);
      if (!media.length) throw new Error('このパックには動画・音声が入っていません。スタジオで「動画・音声も含める」を選んで書き出し直してください');
      let first = null;
      for (const m of media) {
        toast('取り込み中…', 10000);
        const raw = await z.file(m.path); const blob = await copyBlob(raw, (r) => toast(`取り込み中… ${Math.round(r * 100)}%`, 10000), { name: m.name, type: m.mime || 'video/mp4' });
        const v = { id: uid('v_'), lang: manifest.lang || curLang(), name: media.length > 1 ? `${manifest.title}（${m.name}）` : manifest.title, blob, mime: m.mime || 'video/mp4', size: blob.size, duration: m.duration || 0, lastTime: 0, createdAt: Date.now(), from: { pack: manifest.packId, material: manifest.materialId } };
        await db.put('videos', v);
        const cues = mat.items.filter((it) => it.segments?.[0]?.media === m.id && (it.text || it.ja))
          .map((it) => ({ id: uid('c_'), videoId: v.id, start: it.segments[0].start, end: it.segments.at(-1).media === m.id ? it.segments.at(-1).end : it.segments[0].end, en: it.text || '', ja: it.ja || '', ...(it.holes?.length ? { holes: it.holes } : {}) }))
          .sort((a, b) => a.start - b.start);
        await replaceCues(v.id, cues);
        first ||= v;
      }
      toast(`取り込みました（字幕 ${mat.items.filter((it) => it.text || it.ja).length}行）`);
      go(`#video-play?id=${first.id}`);
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
      const { copyBlob } = await import('./media-audio.js');
      const blob = f.size <= 600 * 1048576 ? await copyBlob(f, (r) => toast(`保存中… ${Math.round(r * 100)}%`, 10000), { type: f.type || 'video/mp4' }) : f;
      const v = { id: uid('v_'), lang: curLang(), name: f.name.replace(/\.[^.]+$/, '') || '動画', blob, mime: f.type || 'video/mp4', size: f.size, duration, lastTime: 0, createdAt: Date.now(), audioChecked: true };
      // screen recordings have app sound and microphone as separate tracks: keep the speech track as its own sound file
      try { const { separateSpeechTrack } = await import('./media-audio.js'); const sp = await separateSpeechTrack(blob, f.name, (m) => toast(m, 8000)); if (sp) { v.audioBlob = sp.file; v.audioTrack = sp.index; v.audioInfo = { count: sp.count, reason: sp.reason, auto: sp.auto }; } } catch {}
      await db.put('videos', v);
      toast('動画を追加しました');
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

export async function videoPlay(el, params) {
  setCleanup(null);
  const v = await db.get('videos', params.get('id'));
  if (!v) { el.innerHTML = `<header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>動画が見つかりません</h1></header><div class="card muted">削除された可能性があります。</div>`; return; }
  const vlang = v.lang || 'en';
  const TL = L(vlang).name;
  let cues = await cuesOf(v.id);
  const view = await loadView();
  const saveView = () => setSetting('video.view', view);
  let loop = null, ab = null, curId = null, rafId = 0, saveT = 0, loopN = 0, stepCue = null, revealedCue = null, editing = false;
  const revealed = new Map();   // cueId -> Set(hole index)
  const url = v.blob ? URL.createObjectURL(v.blob) : '';
  const aurl = v.audioBlob ? URL.createObjectURL(v.audioBlob) : '';
  const MLABEL = (m) => MODES.find((x) => x[0] === m)[1].replace('英', L(vlang).ch);

  el.innerHTML = `
    <div class="vp-root" id="vroot">
    <header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1 class="vtitle">${esc(v.name)}</h1><span class="grow"></span><button class="icon-btn" id="menu" aria-label="メニュー">⋯</button></header>
    <div class="vwrap">${!url ? '<div class="card warn">動画ファイルがありません（バックアップから復元した場合は、動画をもう一度追加してください）</div>'
      : aurl ? `<video id="vpic" src="${url}" muted playsinline webkit-playsinline preload="metadata"></video><audio id="vid" src="${aurl}" preload="auto" playsinline></audio>`
      : `<video id="vid" src="${url}" playsinline webkit-playsinline preload="metadata"></video>`}</div>
    <div class="subbox" id="sub"></div>
    <div id="grade"></div>
    <div class="vseek" id="seek"><div class="vs-track"><i class="vs-range" id="sRange"></i><i class="vs-played" id="sPlayed"></i><i class="vs-head" id="sHead"></i></div></div>
    <div class="vs-info small"><span id="sTime">0:00.0</span><span id="sRangeTxt" class="grow center"></span><button class="link small" id="sClear" hidden>区間を解除</button></div>
    <div class="vctl">
      <button class="btn" id="back" aria-label="戻す">⟲3</button>
      <button class="btn primary" id="play" aria-label="再生">▶︎</button>
      <button class="btn" id="fwd" aria-label="送る">3⟳</button>
      <button class="btn sm" id="stepSec" aria-label="戻す・送る秒数">3秒</button>
      <button class="btn sm" id="speed" aria-label="速さ">1×</button>
    </div>
    <div class="vctl sub2">
      <button class="btn sm" id="prevCue" aria-label="前の文">⏮ 前の文</button>
      <button class="btn sm" id="again" aria-label="この文をもう一度">↺ もう一度</button>
      <button class="btn sm" id="nextCue" aria-label="次の文">次の文 ⏭</button>
    </div>
    <div class="vquick">
      <button class="tgl" id="qMode"></button>
      <button class="tgl" id="qDict">ディクテーション</button>
      <button class="tgl" id="qShadow">シャドーイング</button>
      <button class="tgl" id="qRange">字幕で区間指定</button>
      <button class="tgl" id="qCloze">穴埋め</button>
      <button class="tgl" id="qLoop">ループ</button>
      <button class="tgl" id="qTest">字幕なしテスト</button>
    </div>
    <div id="dict" class="card stack dict" hidden></div>
    <div id="shadow" class="card stack" hidden></div>
    <details class="card details vset" id="set"><summary>表示・学習の設定</summary>
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
    </details>
    <details class="card details" id="make"><summary>字幕を作る・読み込む</summary>
      <div class="stack" style="margin-top:8px">
        <button class="btn" id="asr">${icon('mic', 18)} 音声から${esc(TL)}字幕を作る（iPhone内・試験的）</button>
        <p class="hint">無料。動画は外部に送りません。初回だけ音声認識モデル（約40〜80MB）をダウンロードします。iPhoneでは数分かかることがあり、うまく動かない場合もあります。</p>
        <button class="btn" id="askClaude" ${cues.some((c) => c.en) ? '' : 'disabled'}>日本語訳をClaudeに頼む（依頼文ごとコピー）</button>
        <button class="btn" data-paste="ja">返ってきた日本語訳を貼り付け</button>
        <label class="btn" for="fEn">${esc(TL)}字幕ファイル（SRT/VTT）を読み込む</label>
        <label class="btn" for="fJa">日本語訳ファイルを読み込む</label>
        <button class="btn" data-paste="en">${esc(TL)}字幕を貼り付け</button>
      </div></details>
    <p class="small muted center" id="modeTxt"></p>
    <div class="row between"><h2 class="sec" style="margin:14px 4px 6px">字幕 <span class="muted small">${cues.length}行</span></h2><button class="link small" id="addCue">＋ 現在位置に追加</button></div>
    <div class="cuelist" id="cl"></div>
    <input type="file" id="fEn" hidden><input type="file" id="fJa" hidden>
    </div>`;

  const root = $('#vroot', el), vid = $('#vid', el), sub = $('#sub', el), cl = $('#cl', el);
  const pic = $('#vpic', el);
  if (vid && pic) {   // picture follows the sound
    vid.addEventListener('error', async () => {
      const { readable } = await import('./media-audio.js');
      if (await readable(v.audioBlob)) return;
      const cur = await db.get('videos', v.id); if (!cur) return;
      delete cur.audioBlob; cur.audioChecked = false; await db.put('videos', cur);
      if (await readable(cur.blob)) { toast('音声を作り直しています…', 3000); videoPlay(el, params); }
      else if (await confirmDialog({ title: '動画データが読めません', body: '<p>保存していた動画データが読めなくなっています。字幕・穴埋め・学習記録はそのまま残っています。</p>', okLabel: '動画を選び直す', cancelLabel: '閉じる' })) relinkVideo();
    });
    vid.addEventListener('play', () => pic.play().catch(() => {}));
    vid.addEventListener('pause', () => pic.pause());
    vid.addEventListener('ratechange', () => (pic.playbackRate = vid.playbackRate));
    vid.addEventListener('seeked', () => { pic.currentTime = vid.currentTime; });
    const sync = setInterval(() => { if (!document.contains(pic)) return clearInterval(sync); if (Math.abs(pic.currentTime - vid.currentTime) > 0.25) pic.currentTime = vid.currentTime; }, 500);
    pic.addEventListener('click', () => (vid.paused ? vid.play() : vid.pause()));
  }
  // videos saved before: check once for several sound tracks and keep the speech track separately
  if (vid && !pic && v.blob && !v.audioChecked) {
    (async () => {
      try {
        const { separateSpeechTrack, readable } = await import('./media-audio.js');
        if (!(await readable(v.blob))) return;
        const sp = await separateSpeechTrack(v.blob, v.name + ((v.mime || '').includes('quicktime') ? '.mov' : '.mp4'));
        const cur = await db.get('videos', v.id); if (!cur) return;
        cur.audioChecked = true;
        if (sp) { Object.assign(cur, { audioBlob: sp.file, audioTrack: sp.index, audioInfo: { count: sp.count, reason: sp.reason, auto: sp.auto } }); }
        await db.put('videos', cur);
        if (sp && location.hash.includes(v.id)) { toast(`音声が${sp.count}本あったので、話し声の方（音声${sp.index + 1}）で再生します`, 3500); videoPlay(el, params); }
      } catch {}
    })();
  }
  if (vid && !pic) {
    // several sound tracks (screen recordings: app sound + microphone): play only the one with speech, never mix
    const pickTrack = async () => {
      const at = vid.audioTracks; if (!at || at.length < 2) return;
      if (v.audioTrack == null) {
        try { const { probe, chooseTrack } = await import('./media-probe.js'); const { decodeTo16k } = await import('./asr.js'); const info = await probe(v.blob); const r = await chooseTrack(v.blob, info, decodeTo16k); const k = info.tracks.filter((t) => t.kind === 'audio').indexOf(r.chosen); if (k >= 0) { v.audioTrack = k; const cur = await db.get('videos', v.id); if (cur) { cur.audioTrack = k; await db.put('videos', cur); } } } catch {}
      }
      const k = v.audioTrack ?? 0; for (let i = 0; i < at.length; i++) at[i].enabled = i === k;
    };
    vid.addEventListener('loadedmetadata', pickTrack);
    vid.addEventListener('error', async () => {
      const { readable } = await import('./media-audio.js');
      if (!(await readable(v.blob)) && (await confirmDialog({ title: '動画データが読めません', body: '<p>保存していた動画データが読めなくなっています（iPhoneが一時ファイルを消した可能性）。字幕・穴埋め・学習記録はそのまま残っています。</p>', okLabel: '動画を選び直す', cancelLabel: '閉じる' }))) relinkVideo();
    });
  }
  const showEn = () => view.mode === 'both' || view.mode === 'en';
  const showJa = () => view.mode === 'both' || view.mode === 'ja' || (view.cloze && view.jaHint);

  // ---- appearance (CSS variables / classes only: never touches playback) ----
  function applyView() {
    root.style.setProperty('--fsEn', view.fsEn + 'px'); root.style.setProperty('--fsJa', view.fsJa + 'px');
    root.style.setProperty('--opEn', view.opEn); root.style.setProperty('--opJa', view.opJa);
    root.classList.toggle('jatop', view.order === 'ja');
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
      if (row) { row.classList.add('cur'); cl.scrollTop = row.offsetTop - cl.offsetTop - cl.clientHeight / 3; }
    }
    if (Date.now() - saveT > 3000) { saveT = Date.now(); savePos(); }
    rafId = requestAnimationFrame(tick);
  }
  async function savePos() { if (!vid) return; const cur = await db.get('videos', v.id); if (cur) { cur.lastTime = vid.currentTime; await db.put('videos', cur); } }
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
    setInterval(() => { if (document.contains(seekEl)) drawSeek(); }, 200);
    vid?.addEventListener('loadedmetadata', drawSeek);
  }
  // ---- back / forward (seconds cycle 3 → 5 → 10), speed (1 → 0.7 → 0.5) ----
  const drawSteps = () => { $('#back', el).textContent = `⟲${stepSec}`; $('#fwd', el).textContent = `${stepSec}⟳`; $('#stepSec', el).textContent = `${stepSec}秒`; };
  drawSteps();
  $('#stepSec', el).onclick = async () => { stepSec = STEPS[(STEPS.indexOf(stepSec) + 1) % STEPS.length]; drawSteps(); await setSetting('video.stepSec', stepSec); };
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
      const dbv = await db.get('videos', v.id); if (dbv) { dbv.properNouns = v.properNouns; await db.put('videos', dbv); }
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
  $('#prevCue', el).onclick = () => jump(-1);
  $('#nextCue', el).onclick = () => jump(1);
  $('#again', el).onclick = () => {   // the phrase being heard, or the one just before if we're between phrases / at its start
    if (!vid || !cues.length) return;
    const t = vid.currentTime;
    const c = cueAt(t) && t - cueAt(t).start > 0.4 ? cueAt(t) : [...cues].reverse().find((x) => x.start < t - 0.05) || cues[0];
    playFrom(c);
  };
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
  $('#asr', el).onclick = () => runASR();
  $('#make', el).addEventListener('click', (e) => { const p = e.target.closest('[data-paste]'); if (p) pasteDialog(p.dataset.paste); });
  $('#fEn', el).onchange = (e) => importFile(e, 'en');
  $('#fJa', el).onchange = (e) => importFile(e, 'ja');
  $('#addCue', el).onclick = () => editCue(null);
  $('#menu', el).onclick = menu;

  // ---- on-device transcription (experimental) ----
  async function runASR() {
    if (!v.blob) return toast('動画ファイルがありません');
    if (cues.some((c) => c.en) && !(await confirmDialog({ title: `${TL}字幕を作り直しますか？`, body: '<p>今の字幕（と穴埋め）は置き換わります。日本語訳は時間の重なる行に付け直します。</p>', okLabel: '作る' }))) return;
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>字幕を作成中</h3><p id="asrMsg" class="small">準備しています…</p><div class="progress"><i id="asrBar" style="width:2%"></i></div><p class="hint">画面を閉じたりアプリを切り替えたりすると止まることがあります。</p><button class="btn ghost" value="cancel">中止</button></form>`;
    let cancelled = false;
    dlg.onclose = () => { cancelled = true; };
    dlg.showModal();
    const say = (msg, p) => { if (cancelled) return; const m = $('#asrMsg', dlg); if (m) m.textContent = msg; const b = $('#asrBar', dlg); if (b && p != null) b.style.width = Math.max(2, p * 100) + '%'; };
    try {
      const { audio16kFromBlob, transcribeAudio } = await import('./media-audio.js');
      const a = v.audioBlob ? await audio16kFromBlob(v.audioBlob, { name: 'speech.m4a', onStep: (m) => say(m, 0.05) })
        : await audio16kFromBlob(v.blob, { name: v.name + '.' + ((v.mime || '').includes('quicktime') ? 'mov' : 'mp4'), trackIndex: v.audioTrack ?? null, onStep: (m) => say(m, 0.05) });
      if (a.track && a.track.count > 1 && v.audioTrack == null) { v.audioTrack = a.track.index; await db.put('videos', v); }   // remember the chosen sound track (also used for playback)
      const fast = (await getSetting('video.asrFast', true)) !== false;
      const out = await transcribeAudio(a.audio, { lang: vlang, fast, onProgress: (m, p) => say(m, p == null ? null : 0.1 + p * 0.9), isCancelled: () => cancelled });
      if (cancelled) return;
      dlg.close();
      const jaOld = cues.filter((c) => c.ja).map((c) => ({ start: c.start, end: c.end, text: c.ja }));
      cues = mergeJa(out.map((x) => ({ id: uid('c_'), videoId: v.id, start: x.start, end: x.end, en: x.text, ja: '', auto: true })), jaOld, v.id);
      await replaceCues(v.id, cues);
      toast(`${out.length}行の字幕を作りました。誤りは ✎ で直せます`);
      videoPlay(el, params);
    } catch (err) {
      if (dlg.open) dlg.close();
      const lost = err?.stage === '保存データの読み込み';
      const ok = await confirmDialog({ title: '字幕を作れませんでした', body: `<p class="small">${esc(err?.message || String(err))}</p><p class="hint">${lost ? '字幕・穴埋め・学習記録はそのまま残ります。同じ動画を選び直すと、続けて使えます。' : '初回はネット接続が必要です（モデルのダウンロード）。字幕ファイル（SRT）があれば、その読み込みが確実です。'}</p>`, okLabel: lost ? '動画を選び直す' : '閉じる', cancelLabel: lost ? '閉じる' : null });
      if (ok && lost) relinkVideo();
    }
  }
  // put the video file back (same subtitles and records) when the saved data became unreadable
  function relinkVideo() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const { copyBlob } = await import('./media-audio.js');
      toast('保存中…', 10000);
      try {
        v.blob = await copyBlob(f, (r) => toast(`保存中… ${Math.round(r * 100)}%`, 10000), { type: f.type || v.mime || 'video/mp4' }); v.size = f.size; delete v.audioTrack; delete v.audioBlob;
        try { const { separateSpeechTrack } = await import('./media-audio.js'); const sp = await separateSpeechTrack(v.blob, f.name, (m) => toast(m, 8000)); if (sp) { v.audioBlob = sp.file; v.audioTrack = sp.index; v.audioInfo = { count: sp.count, reason: sp.reason, auto: sp.auto }; } } catch {}
        await db.put('videos', v); toast('動画を選び直しました'); videoPlay(el, params);
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
        if (name?.trim()) { const cur = await db.get('videos', v.id); cur.name = name.trim(); await db.put('videos', cur); videoPlay(el, params); }
      } else if (r === 'del') {
        if (!(await confirmDialog({ title: '動画を削除', body: '<p>動画と字幕を削除します。この動画から登録した単語は残りますが、動画へのリンクは使えなくなります。</p>', okLabel: '削除', danger: true }))) return;
        const old = await db.byIndex('cues', 'videoId', v.id);
        await db.tx(['videos', 'cues'], 'readwrite', (t) => { t.objectStore('videos').delete(v.id); old.forEach((c) => t.objectStore('cues').delete(c.id)); });
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
    vid.addEventListener('play', () => { $('#play', el).textContent = '⏸'; });
    vid.addEventListener('pause', () => { $('#play', el).textContent = '▶︎'; savePos(); });
    vid.addEventListener('click', () => (vid.paused ? vid.play() : vid.pause()));
    rafId = requestAnimationFrame(tick);
  }
  const speed = await getSetting('video.speed', 1);
  if (vid) vid.playbackRate = SPEEDS.includes(speed) ? speed : 1;
  $('#speed', el).textContent = `${vid?.playbackRate || 1}×`;
  setCleanup(() => { cancelAnimationFrame(rafId); savePos(); vid?.pause(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); });
}
