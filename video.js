// Phase 6: Video Lab (local videos + SRT/VTT subtitles + word registration linked to video position)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go } from './ui.js';
import { headKey, existingHeadMap, newWord, newSense, saveWord, splitList } from './words.js';

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
    <header class="top"><a href="#home" class="back">‹</a><h1>🎬 Video Lab</h1></header>
    <label class="btn primary" for="vfile">＋ 動画を追加（写真・ファイル）</label>
    <input type="file" id="vfile" accept="video/*" hidden>
    <p class="hint" style="margin-top:6px">30秒〜5分程度の動画向け。動画はこのiPhoneの中だけに保存され、外部には送信されません。JSONバックアップに動画本体は含まれません（字幕は含まれます）。</p>
    <div id="vl">${vids.map((v) => `
      <a class="card vrow" href="#video-play?id=${v.id}">
        <span class="vic">🎞️</span>
        <span class="grow"><b>${esc(v.name)}</b><span class="small muted block">${v.duration ? fmtT(v.duration).replace(/\.\d$/, '') : ''}・${fmtSize(v.size || 0)}・字幕 ${cueCount[v.id] || 0}行${v.hasBlob ? '' : '・<span class="danger-text">動画ファイルなし</span>'}</span></span>
        <span class="muted">›</span>
      </a>`).join('') || '<div class="card center muted">まだ動画がありません</div>'}</div>
    <details class="card" style="margin-top:14px"><summary><b>字幕・翻訳について（無料でできる範囲）</b></summary>
      <div class="small stack" style="margin-top:8px">
        <p><b>追加料金なし</b>：SRT/VTT字幕の読み込み、字幕の手入力・編集、再生・リピート・速度変更、単語登録。<br>
        日本語訳は <b>Claudeのチャット（Proの範囲）</b> で作れます：再生画面の「⋯」→「英語字幕をコピー」→ Claudeに「このSRTを日本語に訳して、同じ形式・同じ時間で返して」と貼る → 返ってきたSRTを「字幕を貼り付け（日本語）」で取り込み。</p>
        <p><b>別途費用が必要</b>：動画の音声から英語字幕を自動で作る機能（文字起こしAPIの従量課金と、APIキーを隠すためのサーバーが必要）。Claudeのチャットは動画の音声を直接文字起こしできないため、Proの範囲では自動化できません。翻訳をボタン一つで自動化する場合も、API料金がかかります。</p>
        <p>字幕付きの教材なら、その字幕ファイル（.srt / .vtt）を使うのが一番確実です。</p>
      </div></details>`;
  $('#vfile', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 500 * 1048576 && !(await confirmDialog({ title: '大きな動画です', body: `<p>${fmtSize(f.size)}あります。保存に時間がかかり、iPhoneの空き容量を使います。続けますか？</p>`, okLabel: '保存する' }))) return;
    toast('保存中…', 10000);
    try {
      const duration = await probeDuration(f);
      const v = { id: uid('v_'), name: f.name.replace(/\.[^.]+$/, '') || '動画', blob: new Blob([f], { type: f.type || 'video/mp4' }), mime: f.type || 'video/mp4', size: f.size, duration, lastTime: 0, createdAt: Date.now() };
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
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.25, 1.5];
export async function videoPlay(el, params) {
  setCleanup(null);
  const v = await db.get('videos', params.get('id'));
  if (!v) { el.innerHTML = `<header class="top"><a href="#video" class="back">‹</a><h1>動画が見つかりません</h1></header><div class="card muted">削除された可能性があります。</div>`; return; }
  let cues = await cuesOf(v.id);
  let showEn = await getSetting('video.en', true), showJa = await getSetting('video.ja', true);
  let loop = null, ab = null, curId = null, rafId = 0, saveT = 0;
  const url = v.blob ? URL.createObjectURL(v.blob) : '';

  el.innerHTML = `
    <header class="top"><a href="#video" class="back">‹</a><h1 class="vtitle">${esc(v.name)}</h1><span class="grow"></span><button class="icon-btn" id="menu">⋯</button></header>
    <div class="vwrap">${url ? `<video id="vid" src="${url}" playsinline webkit-playsinline preload="metadata"></video>` : '<div class="card warn">動画ファイルがありません（バックアップから復元した場合は、動画をもう一度追加してください）</div>'}</div>
    <div class="subbox" id="sub"></div>
    <div class="vctl">
      <button class="btn" id="back3">⟲ 3秒</button>
      <button class="btn primary" id="play">▶︎</button>
      <button class="btn" id="fwd5">5秒 ⟳</button>
      <button class="btn" id="speed">1.0×</button>
    </div>
    <div class="vctl2">
      <button class="tgl" id="tEn">英語字幕</button>
      <button class="tgl" id="tJa">日本語訳</button>
      <button class="tgl" id="tLoop">字幕リピート</button>
      <button class="tgl" id="tAB">A-B</button>
    </div>
    <p class="small muted center" id="mode"></p>
    <div class="row between"><h2 class="sec" style="margin:14px 4px 6px">字幕 <span class="muted small">${cues.length}行</span></h2><button class="link small" id="addCue">＋ 現在位置に追加</button></div>
    <div class="cuelist" id="cl"></div>`;

  const vid = $('#vid', el);
  const sub = $('#sub', el), cl = $('#cl', el);

  function drawToggles() {
    $('#tEn', el).classList.toggle('on', showEn); $('#tJa', el).classList.toggle('on', showJa);
    $('#tLoop', el).classList.toggle('on', !!loop); $('#tAB', el).classList.toggle('on', !!ab);
    $('#tAB', el).textContent = !ab ? 'A-B' : ab.b == null ? 'Bを設定' : `A-B ${fmtT(ab.a)}–${fmtT(ab.b)}`;
    $('#mode', el).textContent = `表示：${showEn && showJa ? '英語字幕＋日本語訳' : showEn ? '英語字幕のみ' : showJa ? '日本語訳のみ' : '字幕なし'}`;
  }
  function drawList() {
    if (!cues.length) {
      cl.innerHTML = `<div class="card stack">
        <p class="small muted">字幕がまだありません。英語と日本語は別々に読み込めます（SRT / VTT）。</p>
        <label class="btn" for="fEn">英語字幕ファイルを読み込む</label>
        <label class="btn" for="fJa">日本語訳ファイルを読み込む</label>
        <button class="btn" data-paste="en">英語字幕を貼り付け</button>
        <button class="btn" data-paste="ja">日本語訳を貼り付け</button></div>`;
    } else {
      cl.innerHTML = cues.map((c) => `
        <div class="cue ${c.id === curId ? 'cur' : ''}" data-id="${c.id}">
          <span class="ct">${fmtT(c.start)}</span>
          <span class="grow ctext">${showEn && c.en ? `<span class="cen">${esc(c.en)}</span>` : ''}${showJa && c.ja ? `<span class="cja">${esc(c.ja)}</span>` : ''}${(!showEn || !c.en) && (!showJa || !c.ja) ? '<span class="muted small">（非表示）</span>' : ''}</span>
          ${c.en ? `<button class="cbtn" data-word="${c.id}" aria-label="単語登録">＋語</button>` : ''}
          <button class="cbtn" data-edit="${c.id}" aria-label="編集">✎</button>
        </div>`).join('');
    }
    cl.insertAdjacentHTML('beforeend', `<input type="file" id="fEn" hidden><input type="file" id="fJa" hidden>`);
    $('#fEn', cl).onchange = (e) => importFile(e, 'en');
    $('#fJa', cl).onchange = (e) => importFile(e, 'ja');
  }
  function drawSub() {
    const c = cues.find((x) => x.id === curId);
    sub.innerHTML = c ? `${showEn && c.en ? `<div class="sen">${esc(c.en)}</div>` : ''}${showJa && c.ja ? `<div class="sja">${esc(c.ja)}</div>` : ''}` : '';
    sub.classList.toggle('empty', !sub.innerHTML);
  }
  function cueAt(t) { let r = null; for (const c of cues) { if (c.start <= t && t < c.end) r = c; if (c.start > t) break; } return r; }
  function tick() {
    if (!vid) return;
    const t = vid.currentTime;
    if (loop && t >= loop.end) vid.currentTime = loop.start;
    if (ab?.b != null && t >= ab.b) vid.currentTime = ab.a;
    const c = cueAt(t);
    const id = c?.id || null;
    if (id !== curId) {
      curId = id; drawSub();
      $$('.cue.cur', cl).forEach((x) => x.classList.remove('cur'));
      const row = id && cl.querySelector(`[data-id="${id}"]`);
      if (row) { row.classList.add('cur'); cl.scrollTop = row.offsetTop - cl.offsetTop - cl.clientHeight / 3; }
    }
    if (Date.now() - saveT > 3000) { saveT = Date.now(); savePos(); }
    rafId = requestAnimationFrame(tick);
  }
  async function savePos() { if (!vid) return; const cur = await db.get('videos', v.id); if (cur) { cur.lastTime = vid.currentTime; await db.put('videos', cur); } }

  async function importText(text, lang) {
    const list = parseSubs(text);
    if (!list.length) return toast('字幕を読み取れませんでした（SRT / VTT形式か確認してください）');
    if (lang === 'en') {
      if (cues.some((c) => c.en) && !(await confirmDialog({ title: '英語字幕を置き換えますか？', body: '<p>今の英語字幕は置き換わります。日本語訳は時間が重なる行に付け直します。</p>', okLabel: '置き換える' }))) return;
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
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${lang === 'en' ? '英語字幕' : '日本語訳'}を貼り付け</h3>
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
      Object.assign(c, { start: s, end: e, en: $('#een', dlg).value.trim(), ja: $('#eja', dlg).value.trim() });
      await db.put('cues', c);
      if (isNew) cues.push(c);
      cues.sort((a, b) => a.start - b.start);
      curId = null; drawList(); toast('保存しました');
    };
    dlg.showModal();
  }

  async function wordFromCue(id) {
    const c = cues.find((x) => x.id === id);
    vid?.pause();
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
      const exist = (await existingHeadMap()).get(headKey(head));
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
        const w = newWord({ headword: head, bookmarked: $('#wb', dlg).checked, source: { type: 'video', ...ref },
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
      <label class="btn" for="fEn" data-close>英語字幕ファイルを読み込む</label>
      <label class="btn" for="fJa" data-close>日本語訳ファイルを読み込む</label>
      <button class="btn" value="pen">英語字幕を貼り付け</button>
      <button class="btn" value="pja">日本語訳を貼り付け</button>
      <button class="btn" value="copy" ${cues.some((c) => c.en) ? '' : 'disabled'}>英語字幕をコピー（翻訳用SRT）</button>
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
    confirmDialog({ title: '英語字幕（SRT）', body: `<p class="hint">全選択してコピーしてください</p><textarea rows="10" readonly style="width:100%">${esc(text)}</textarea>`, okLabel: '閉じる', cancelLabel: null });
  }

  // ---- wiring ----
  drawToggles(); drawList(); drawSub();
  if (vid) {
    const t0 = params.get('t') != null ? Math.max(0, +params.get('t') - 0.3) : v.lastTime || 0;
    vid.addEventListener('loadedmetadata', () => { if (t0 && t0 < vid.duration) vid.currentTime = t0; }, { once: true });
    vid.addEventListener('play', () => { $('#play', el).textContent = '⏸'; });
    vid.addEventListener('pause', () => { $('#play', el).textContent = '▶︎'; savePos(); });
    vid.addEventListener('click', () => (vid.paused ? vid.play() : vid.pause()));
    rafId = requestAnimationFrame(tick);
  }
  const speed = await getSetting('video.speed', 1);
  if (vid) vid.playbackRate = speed;
  $('#speed', el).textContent = `${speed}×`;
  $('#play', el).onclick = () => vid && (vid.paused ? vid.play() : vid.pause());
  $('#back3', el).onclick = () => { if (vid) vid.currentTime = Math.max(0, vid.currentTime - 3); };
  $('#fwd5', el).onclick = () => { if (vid) vid.currentTime = Math.min(vid.duration || 1e9, vid.currentTime + 5); };
  $('#speed', el).onclick = async () => {
    const cur = vid?.playbackRate || 1;
    const nx = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length] || 1;
    if (vid) vid.playbackRate = nx; $('#speed', el).textContent = `${nx}×`; await setSetting('video.speed', nx);
  };
  $('#tEn', el).onclick = () => { showEn = !showEn; drawToggles(); drawList(); drawSub(); setSetting('video.en', showEn); };
  $('#tJa', el).onclick = () => { showJa = !showJa; drawToggles(); drawList(); drawSub(); setSetting('video.ja', showJa); };
  $('#tLoop', el).onclick = () => {
    if (loop) loop = null;
    else {
      const c = cues.find((x) => x.id === curId) || cueAt((vid?.currentTime || 0) + 0.05) || [...cues].reverse().find((x) => x.start <= (vid?.currentTime || 0));
      if (!c) return toast('リピートする字幕がありません');
      loop = { start: c.start, end: c.end }; ab = null;
      if (vid) { vid.currentTime = c.start; vid.play(); }
    }
    drawToggles();
  };
  $('#tAB', el).onclick = () => {
    const t = vid?.currentTime || 0;
    if (!ab) { ab = { a: t, b: null }; loop = null; toast('A地点を設定。もう一度押すとB地点'); }
    else if (ab.b == null) { if (t <= ab.a + 0.3) return toast('A地点より後で押してください'); ab.b = t; if (vid) vid.currentTime = ab.a; }
    else ab = null;
    drawToggles();
  };
  $('#addCue', el).onclick = () => editCue(null);
  $('#menu', el).onclick = menu;
  cl.addEventListener('click', (e) => {
    const p = e.target.closest('[data-paste]'); if (p) return pasteDialog(p.dataset.paste);
    const w = e.target.closest('[data-word]'); if (w) return wordFromCue(w.dataset.word);
    const ed = e.target.closest('[data-edit]'); if (ed) return editCue(ed.dataset.edit);
    const row = e.target.closest('.cue'); if (row && vid) {
      const c = cues.find((x) => x.id === row.dataset.id);
      vid.currentTime = c.start + 0.01;
      if (loop) loop = { start: c.start, end: c.end };
      vid.play(); drawToggles();
    }
  });
  setCleanup(() => { cancelAnimationFrame(rafId); savePos(); vid?.pause(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); });
}
