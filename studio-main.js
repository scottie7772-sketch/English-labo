// 教材スタジオ（制作）: standalone page studio.html now; later mounted inside Englabo with mount(el, { base: 'studio/' }).
// Rules: does not import learning modules and never touches the learning database (ell-db).
import { $, $$, esc, toast, confirmDialog, swipeToDelete } from './ui.js';
import { sdb, newId, commit, undo, redo, saveVersion, restoreVersion, liveBlocks, allBlocksMap, sourcesMap, newBlock, tokensOf, blockDur } from './studio-db.js';
import { parseScript, SUB_EXT, isJa, langFromName, autoPair, alignJa } from './studio-subs.js';
import * as ops from './studio-ops.js';
import { fingerprint, zipWrite, zipRead } from './common-pack.js';
import { decodeTo16k, openTranscriber, speechPieces, captureTo16k, QUALITY, recognisePiece } from './asr.js';
import { extractPhrases, extractWords } from './studio-words.js';
import { findCandidates, applySpans } from './studio-names.js';
import { alignScript, scriptToLines } from './studio-align.js';
import { probe, audioTracks, canExtract, extractTrack, chooseTrack, mp4Audio } from './media-probe.js';
import { frameRms, frameZcr, edgeCut, isScreenRec, defaultCut } from './media-audio.js';

export const STUDIO_VERSION = '0.15.2';
const LIMIT = { video: 15 * 60, audio: 75 * 60 };   // one import: video up to 15 min, audio up to 75 min in total (user decisions)
let ROOT = null, BASE = '', HOST = null;   // HOST: set when the studio runs inside English Labo
const sessionFiles = new Map();   // sourceId -> File (for "保存しない" media; lives only while the page is open)
const urlCache = new Map();
const nav = (path) => { location.hash = '#' + BASE + path; };
const fmt = (s) => (s == null || isNaN(s) ? '--:--' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);
const fmtMin = (s) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
const fmtSize = (n) => (n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const icon = (n) => ({ back: '‹', undo: '↶', redo: '↷', play: '▶︎', pause: '❚❚', more: '⋯' }[n] || n);

// breadcrumbs survive a crash (iOS reloads the page when memory runs out); shown at the next start
const crumbs = (() => { try { return JSON.parse(localStorage.getItem('st-crumbs') || '[]'); } catch { return []; } })();
function crumb(msg) { crumbs.push(`${new Date().toLocaleTimeString('ja-JP')} ${msg}`); while (crumbs.length > 40) crumbs.shift(); try { localStorage.setItem('st-crumbs', JSON.stringify(crumbs)); } catch {} }
function running(what) { try { what ? localStorage.setItem('st-running', what) : localStorage.removeItem('st-running'); } catch {} if (what) crumb('開始：' + what); }
const errLog = [];
const inStudio = () => !BASE || location.hash.slice(1).startsWith(BASE);
function logErr(msg) { errLog.push(`${new Date().toLocaleTimeString('ja-JP')} ${msg}`); if (errLog.length > 50) errLog.shift(); if (inStudio()) toast('エラー：' + msg, 5000); }
let mounted = false;
// host (English Labo): { exitHref, sendToLab(manifest, material, getFile) } — the host's router calls mount() for every studio screen
export function mount(el, { base = '', host = null } = {}) {
  ROOT = el; BASE = base; HOST = host;
  if (mounted && host) { route(); return; }
  mounted = true;
  addEventListener('error', (e) => logErr(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => logErr(String(e.reason?.message || e.reason)));
  if (!host) addEventListener('hashchange', route);
  let crashed = null; try { crashed = localStorage.getItem('st-running'); } catch {}
  if (crashed) {
    running(null);
    if (location.hash.slice(1).startsWith(BASE + 'set')) history.replaceState(null, '', '#' + BASE + 'sets');   // do not reopen the screen that stopped
    route();
    const last = crumbs.slice(-12).join('\n');
    setTimeout(() => confirmDialog({ title: '前回、処理の途中で止まりました', body: `<p class="small">「${esc(crashed)}」の途中でアプリが閉じました。iPhoneのメモリが足りなくなった可能性が高いです。保存済みの分は残っています。</p><pre class="st-log">${esc(last)}</pre>`, okLabel: '記録をコピー', cancelLabel: '閉じる' }).then((ok) => ok && navigator.clipboard.writeText(`${crashed}\n${last}`).then(() => toast('コピーしました'), () => {})), 300);
    return;
  }
  route();
}
function parseHash() {
  const h = location.hash.slice(1);
  const rest = h.startsWith(BASE) ? h.slice(BASE.length) : h;
  const [path, q] = rest.split('?');
  return { path: path || 'sets', params: new URLSearchParams(q || '') };
}
let cleanup = null;
export function unmount() { cleanup?.(); cleanup = null; }
async function route() {
  cleanup?.(); cleanup = null;
  if (!inStudio()) return;
  const { path, params } = parseHash();
  const screens = { sets: setsScreen, import: importScreen, set: editorScreen, versions: versionsScreen, lab: labScreen, io: ioScreen, words: wordsScreen, clean: cleanScreen };
  try { await (screens[path] || setsScreen)(ROOT, params); }
  catch (e) { console.error(e); ROOT.innerHTML = `<div class="card warn">エラー：${esc((e?.message || String(e)))}</div><a class="btn" href="#${BASE}sets">一覧に戻る</a>`; }
  scrollTo(0, 0);
}
const head = (title, backPath = null, right = '') => `
  <div class="st-band">制作・教材スタジオ <small>v${STUDIO_VERSION}</small></div>
  <header class="top">${backPath != null ? `<a class="back" href="${backPath === '__exit' ? HOST?.exitHref || '#home' : `#${BASE}${backPath}`}" aria-label="戻る">${icon('back')}</a>` : ''}<h1 title="${esc(title)}">${esc(title)}</h1><span class="grow"></span>${right}</header>`;

function mediaURL(src) {
  if (!src) return null;
  if (urlCache.has(src.id)) return urlCache.get(src.id);
  const blob = src.stored ? src.blob : sessionFiles.get(src.id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob); urlCache.set(src.id, u); return u;
}
async function readDuration(file) {
  return new Promise((res) => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    const u = URL.createObjectURL(file); let done = false;
    const fin = (d, ok) => { if (done) return; done = true; URL.revokeObjectURL(u); res({ duration: d, playable: ok }); };
    v.onloadedmetadata = () => fin(isFinite(v.duration) ? v.duration : null, true);
    v.onerror = () => fin(null, false);
    setTimeout(() => fin(null, false), 8000);
    v.src = u;
  });
}

// ================= sets list =================
async function setsScreen(el) {
  const sets = (await sdb.all('sets')).sort((a, b) => b.updatedAt - a.updatedAt);
  const srcs = await sourcesMap();
  // オリジナル / カット済み label: from the first and last items that have sound
  const cutInfo = {};
  for (const st of sets) {
    const bl = (await liveBlocks(st)).filter((b) => b.segments.length); if (!bl.length) continue;
    const f = bl[0].segments[0], l = bl[bl.length - 1].segments.at(-1), src = srcs[f.sourceId];
    if (src?.trimmed) cutInfo[st.id] = `<span class="tagp">カット済み・元は削除</span>`;
    else if (src && (f.start > 0.05 || (src.duration && l.end < src.duration - 0.05))) cutInfo[st.id] = `<span class="tagp">カット済み ${fmt(f.start)}–${fmt(l.end)}（元も保存）</span>`;
    else cutInfo[st.id] = `<span class="tagp">オリジナル</span>`;
  }
  const est = await navigator.storage?.estimate?.().catch(() => null);
  let editing = false; const chosen = new Set();
  const openF = new Set(JSON.parse(localStorage.getItem('st-openF') || '[]'));
  const folders = [...new Set(sets.map((s) => s.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const draw = () => {
    el.innerHTML = `${head('教材スタジオ', HOST ? '__exit' : null, `<button class="btn sm" id="upd">更新を確認</button><a class="btn sm" href="#${BASE}clean">容量</a><a class="btn sm" href="#${BASE}lab">技術検証</a>`)}
    <div class="row"><a class="btn primary grow" href="#${BASE}import">＋ 一括登録（動画・音声・字幕）</a><a class="btn" href="#${BASE}io">読み込み</a></div>
    ${est ? `<p class="small muted">端末の保存量：${fmtSize(est.usage || 0)}${est.quota ? ` / 目安の上限 ${fmtSize(est.quota)}` : ''}</p>` : ''}
    ${sets.length ? `<div class="row"><span class="grow small muted">${sets.length}セット・左にスワイプで削除</span><button class="btn sm" id="edit">${editing ? '完了' : '選ぶ（フォルダ・削除）'}</button></div>
    ${editing ? `<div class="row wrap"><button class="btn sm" id="eAll">すべて選ぶ</button><button class="btn sm danger" id="eDel" ${chosen.size ? '' : 'disabled'}>削除（${chosen.size}）</button><button class="btn sm" id="eNone">解除</button><button class="btn sm grow" id="eFold" ${chosen.size ? '' : 'disabled'}>📁 フォルダへ</button></div>` : ''}
    ${[...folders, ''].map((f) => { const inF = sets.filter((s) => (s.folder || '') === f); if (!inF.length) return '';
      const rows = inF.map(rowHTML).join('');
      return f ? `<details class="card st-fold" data-f="${esc(f)}" ${openF.has(f) || editing ? 'open' : ''}><summary>📁 ${esc(f)} <small class="muted">${inF.length}</small></summary>${!editing && inF.length > 1 ? `<button class="btn sm st-fmerge" data-fmerge="${esc(f)}">🔗 このフォルダをまとめて照合（スクリプトに音声を入れる）</button>` : ''}<div class="list">${rows}</div></details>` : `<div class="card list">${rows}</div>`; }).join('')}` : '<p class="empty">まだ教材セットがありません。「一括登録」から動画・音声と字幕を選んでください。</p>'}
    <p class="hint">${HOST ? 'ここで作った教材は、教材を開いて「⋯」→「英語ラボに送る」で動画ラボに入ります。' : 'このスタジオは単体版です。教材は「⋯」→「書き出す」→ 英語ラボで読み込みで移せます。'}</p>`;
    $$('.st-fold', el).forEach((d) => d.addEventListener('toggle', () => { if (editing) return; d.open ? openF.add(d.dataset.f) : openF.delete(d.dataset.f); try { localStorage.setItem('st-openF', JSON.stringify([...openF])); } catch {} }));
    $('#eFold', el)?.addEventListener('click', () => toFolder(sets.filter((x) => chosen.has(x.id))));
    $$('[data-fmerge]', el).forEach((b) => (b.onclick = () => mergeFolder(b.dataset.fmerge)));
    bind();
  };
  const rowHTML = (s) => {
      const src = srcs[s.sourceId];
      const info = `<span class="grow"><b>${esc(s.title)}</b> ${cutInfo[s.id] || ''}<small class="muted">${src ? `${src.kind === 'audio' ? '🎧' : '🎬'} ${fmt(src.duration)}・${src.stored ? (src.derived === 'audio16k' ? `節約保存（${src.codec === 'wav' ? '非圧縮' : '圧縮'}・${fmtSize(src.blob?.size || 0)}）` : '端末に保存') : '保存しない'}` : '音声なし'}・${s.order.length}項目・更新 ${new Date(s.updatedAt).toLocaleString('ja-JP')}</small></span>`;
      return editing ? `<label class="st-setrow"><input type="checkbox" class="st-cb" data-id="${s.id}" ${chosen.has(s.id) ? 'checked' : ''}>${info}</label>` : `<a class="st-setrow" href="#${BASE}set?id=${s.id}">${info}›</a>`;
  };
  // folder = one material: the script (lines without sound) is the parent; the sound of the other sets goes into it and is aligned
  async function mergeFolder(f) {
    const inF = sets.filter((s) => (s.folder || '') === f);
    const info = await Promise.all(inF.map(async (s) => { const bl = await liveBlocks(s); return { s, bl, script: bl.filter((b) => !b.segments.length && b.text.trim()).length + bl.filter((b) => b.aligned).length, audio: bl.filter((b) => b.segments.length && !b.aligned).length }; }));
    const parent = info.filter((x) => x.script > 0).sort((a, b) => b.script - a.script)[0];
    if (!parent) return toast('このフォルダに、スクリプト（音声のない英文）の教材がありません。先にスクリプトのテキストを取り込んでください', 5000);
    const kids = info.filter((x) => x !== parent && x.audio > 0);
    if (!kids.length) return toast('まとめる音声の教材がありません', 3000);
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>📁 ${esc(f)} をまとめて照合</h3>
      <p class="small">親（スクリプト）：<b>${esc(parent.s.title)}</b></p>
      <p class="small">入れる音声：<br>${kids.map((k) => `・${esc(k.s.title)}（${k.audio}行）`).join('<br>')}</p>
      <label class="chk"><input type="checkbox" id="fmDel" checked> まとめた音声の教材は一覧から消す（音声は親の教材に残ります）</label>
      <p class="hint">まとめたあと、親の教材を開いて「文字起こし→照合」を続けて行います。文字起こし済みの音声はそのまま照合します。</p>
      <div class="row end"><button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok">まとめる</button></div></form>`;
    dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
    if (dlg.returnValue !== 'ok') return;
    const del = $('#fmDel', dlg)?.checked;
    const P = await sdb.get('sets', parent.s.id);
    const copies = kids.flatMap((k) => k.bl.map((b) => { const { id, rev, setId, deleted, ...rest } = b; return newBlock(P.id, { ...structuredClone(rest), lineage: { op: 'copy', from: [`${b.id}@${b.rev}`], at: Date.now() } }); }));
    await commit(P, `📁${f} の音声をまとめる`, { blocks: copies, order: [...P.order, ...copies.map((c) => c.id)] });
    if (del) for (const k of kids) await deleteSet(await sdb.get('sets', k.s.id));
    nav(`set?id=${P.id}&align=1`);
  }
  async function toFolder(list) {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${list.length}セットをフォルダへ</h3>
      ${folders.length ? `<div class="stack">${folders.map((f, i) => `<label class="chk"><input type="radio" name="fd" value="${i}"> 📁 ${esc(f)}</label>`).join('')}</div>` : ''}
      <label class="field"><span>新しいフォルダ</span><input id="fdNew" autocomplete="off" placeholder="例：MA"></label>
      <div class="row end"><button class="btn ghost" value="out">フォルダから出す</button><button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok">入れる</button></div></form>`;
    $('#fdNew', dlg).oninput = () => $$('input[name=fd]', dlg).forEach((r) => (r.checked = false));
    dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
    let f;
    if (dlg.returnValue === 'out') f = '';
    else if (dlg.returnValue === 'ok') { const r = $('input[name=fd]:checked', dlg); f = $('#fdNew', dlg).value.trim() || (r ? folders[+r.value] : null); if (f == null) return toast('フォルダを選ぶか、名前を入れてください'); }
    else return;
    for (const x of list) { const cur = await sdb.get('sets', x.id); if (!cur) continue; if (f) cur.folder = f; else delete cur.folder; await sdb.put('sets', cur); }   // folder only: does not change updatedAt or the content
    if (f) { openF.add(f); try { localStorage.setItem('st-openF', JSON.stringify([...openF])); } catch {} }
    toast(f ? `「${f}」に入れました` : 'フォルダから出しました'); route();
  }
  const bind = () => {
    $('#upd', el).onclick = checkUpdate;
    if (!editing) swipeToDelete($$('a.st-setrow', el), async (row) => {
      const x = sets.find((s) => row.getAttribute('href').endsWith(s.id)); if (!x) return false;
      if (!(await confirmDialog({ title: '教材を削除', body: `<p>${esc(x.title)}</p><p class="hint">字幕・編集・版も削除します（元に戻せません）。</p>`, okLabel: '削除', danger: true }))) return false;
      await deleteSet(x); toast('削除しました'); route(); return true;
    });
    $('#edit', el)?.addEventListener('click', () => { editing = !editing; chosen.clear(); draw(); });
    $('#eAll', el)?.addEventListener('click', () => { sets.forEach((x) => chosen.add(x.id)); draw(); });
    $('#eNone', el)?.addEventListener('click', () => { chosen.clear(); draw(); });
    $$('.st-cb', el).forEach((c) => (c.onchange = () => { c.checked ? chosen.add(c.dataset.id) : chosen.delete(c.dataset.id); draw(); }));
    $('#eDel', el)?.addEventListener('click', async () => {
      const list = sets.filter((x) => chosen.has(x.id));
      if (!(await confirmDialog({ title: `${list.length}セットを削除`, body: `<p>${list.map((x) => esc(x.title)).join('<br>')}</p><p class="hint">字幕・編集・版も削除します（元に戻せません）。必要なら先に「⋯」→「書き出す」で保存してください。</p>`, okLabel: '削除', danger: true }))) return;
      for (const x of list) await deleteSet(x);
      toast(`${list.length}セットを削除しました`); route();
    });
  };
  draw();
}
async function checkUpdate() {
  toast('最新版を確認しています…', 2000);
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.update().catch(() => {});
    for (const k of await caches.keys()) await caches.delete(k);
  } catch {}
  location.replace(location.pathname + '?v=' + Date.now() + location.hash);
}

// ================= bulk import =================
async function importScreen(el, params) {
  const files = { media: [], subs: [] };   // analysed entries
  let sets = null, storeMode = 'store', groupMode = 'file', videoQ = 'audio', autoTrimOn = true;
  const toSet = params?.get('to') ? await sdb.get('sets', params.get('to')) : null;   // add to an existing set
  el.innerHTML = `${head(toSet ? `「${toSet.title}」に追加` : '一括登録', toSet ? `set?id=${toSet.id}` : 'sets')}
    ${toSet ? `<div class="notice stack small"><b>教材「${esc(toSet.title)}」に追加します。</b>同じ教材の続きの音声や、スクリプト（時刻なしのテキスト）を選んでください。追加したあと「文字起こし→照合」で、音声とスクリプトの位置を合わせます。</div>` : ''}
    <div class="card stack">
      <p class="small">動画・音声と、英語・日本語の字幕（SRT・VTT・TXT・CSV）をまとめて選びます。ファイル名・言語・長さから自動で組み合わせます。<b>1回の取り込みは合計で、動画15分・音声75分まで</b>。</p>
      <label class="btn" for="fz">📦 ZIPを選ぶ（フォルダを圧縮したもの）</label><input type="file" id="fz" hidden>
      <label class="btn" for="fm">🎬 動画・音声を選ぶ（複数可）</label><input type="file" id="fm" multiple hidden>
      <label class="btn" for="fs">📄 字幕・スクリプトを選ぶ（複数可）</label><input type="file" id="fs" multiple hidden>
      <small class="muted">フォルダごと入れるとき：「ファイル」アプリでフォルダを長押し →「圧縮」→ できたZIPをここで選ぶ</small>
      <div id="flist" class="small"></div>
    </div>
    <div id="pairs"></div>`;
  const listFiles = () => {
    $('#flist', el).innerHTML = [...files.media.map((m) => `🎬 ${esc(m.name)}（${m.duration ? fmt(m.duration) : '長さ不明'}${m.playable ? '' : '・この端末で再生できません'}・${fmtSize(m.file.size)}）`),
      ...files.subs.map((s) => `📄 ${esc(s.name)}（${s.lang === 'ja' ? '日本語' : '英語'}・${s.parsed.cues.length}行${s.parsed.timed ? '' : '・時間なし'}）`)].join('<br>');
  };
  async function addMedia(f, name = f.name) {
    const meta = await readDuration(f);
    const fp = await fingerprint(f);
    files.media.push({ key: fp.id, name, file: f, fp, ...meta, kind: f.type.startsWith('audio') || AUDIO_EXT.test(name) ? 'audio' : 'video' });
  }
  async function addSub(text, name) {
    const parsed = parseScript(text, name);
    if (!parsed.cues.length) return;
    const lang = langFromName(name.split('/').pop()) || (parsed.cues.slice(0, 30).filter((c) => isJa(c.text)).length > Math.min(5, parsed.cues.length / 2) ? 'ja' : 'en');
    const lastEnd = parsed.timed ? Math.max(...parsed.cues.map((c) => c.end)) : null;
    files.subs.push({ key: newId('f'), name, text, parsed, lang, lastEnd });
  }
  $('#fm', el).onchange = async (e) => {
    const fl = [...e.target.files]; e.target.value = '';
    toast('動画・音声を確認しています…', 1500);
    for (const f of fl) { if (MEDIA_EXT.test(f.name) || /^(audio|video)\//.test(f.type)) await addMedia(f); else toast(`${f.name} は動画・音声ではありません`); }
    listFiles(); pair();
  };
  $('#fs', el).onchange = async (e) => {
    const fl = [...e.target.files]; e.target.value = '';
    for (const f of fl) {
      if (!SUB_EXT.test(f.name) && !/text/.test(f.type)) { toast(`${f.name} は字幕として読めません`); continue; }
      await addSub(await f.text(), f.name);
    }
    listFiles(); pair();
  };
  $('#fz', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const z = await zipRead(f);
      const names = z.names.filter((n) => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.)/.test(n)).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
      const media = names.filter((n) => MEDIA_EXT.test(n)), subs = names.filter((n) => SUB_EXT.test(n));
      const skipped = names.length - media.length - subs.length;
      $('#flist', el).innerHTML = `<span class="muted">ZIPを展開しています… 0 / ${media.length + subs.length}</span>`;
      let i = 0;
      for (const n of media) { const b = await z.file(n); await addMedia(new File([b], n.split('/').pop(), { type: mimeOf(n) }), n); $('#flist', el).innerHTML = `<span class="muted">ZIPを展開しています… ${++i} / ${media.length + subs.length}</span>`; }
      for (const n of subs) { await addSub(await z.text(n), n); i++; }
      const folders = new Set(media.map(dirOf)); if (folders.size > 1 || media.length > 3) groupMode = 'folder';
      toast(`動画・音声 ${media.length}件・字幕 ${subs.length}件を読み込みました${skipped ? `（対象外 ${skipped}件）` : ''}`, 3000);
      listFiles(); pair();
    } catch (err) { toast('ZIPを読めませんでした：' + err.message, 4000); }
  };
  function pair() {
    sets = autoPair(files.media, files.subs).map((s) => ({ ...s, include: true }));
    draw();
  }
  function draw() {
    if (!sets?.length) { $('#pairs', el).innerHTML = ''; return; }
    const total = sets.filter((s) => s.include && s.media).reduce((a, s) => a + (s.media.duration || 0), 0);
    const inc = sets.filter((s) => s.include && s.media);
    const tv = inc.filter((s) => s.media.kind !== 'audio').reduce((a, s) => a + (s.media.duration || 0), 0);
    const ta = inc.filter((s) => s.media.kind === 'audio').reduce((a, s) => a + (s.media.duration || 0), 0);
    const overV = tv > LIMIT.video, overA = ta > LIMIT.audio, over = overV || overA;
    const meter = (t, lim, label, ov) => `<div class="st-meter ${ov ? 'over' : ''}"><i style="width:${Math.min(100, (t / lim) * 100)}%"></i><span>${label} ${fmtMin(t)} / ${lim / 60}分</span></div>`;
    const opt = (arr, cur, label) => `<option value="">（なし）</option>${arr.map((x) => `<option value="${x.key}" ${cur === x ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}`;
    const needBytes = storeMode === 'store' ? sets.filter((s) => s.include && s.media).reduce((a, s) => a + s.media.file.size, 0) : 0;
    $('#pairs', el).innerHTML = `
      <div class="card stack"><span class="small">まとめ方</span>
        <div class="seg" id="gm"><button data-v="file" class="${groupMode === 'file' ? 'on' : ''}">1ファイル＝1教材</button><button data-v="folder" class="${groupMode === 'folder' ? 'on' : ''}">1フォルダ＝1教材</button></div>
        <small class="muted">${groupMode === 'file' ? '音声（動画）1つと、その字幕・スクリプトで1つの教材にします。ZIPの中のフォルダ名は、一覧の「フォルダ」として使います（Unitごとの整理など）。' : 'ZIPの中の同じフォルダにあるファイルを、名前順につないで1つの教材にします（分割された音声を1本の教材にしたいとき）。'}</small>
        ${groupMode === 'folder' ? `<small class="muted">${groupsOf(sets.filter((s) => s.include)).map((g) => `📁 ${esc(g.title)}（${g.items.length}件）`).join('<br>')}</small>` : ''}</div>
      <h2 class="sec">組み合わせ（${sets.length}件）</h2>
      <div class="row"><button class="btn sm" id="incAll">すべて入れる</button><button class="btn sm" id="incNone">すべて外す</button></div>
      ${tv || !ta ? meter(tv, LIMIT.video, '🎬 動画', overV) : ''}${ta ? meter(ta, LIMIT.audio, '🎧 音声', overA) : ''}
      ${over ? `<p class="warn-text small">${overV ? '動画の合計が15分' : '音声の合計が75分'}を超えています。いくつかのチェックを外してください。</p>` : ''}
      ${sets.map((s, i) => `<div class="card stack st-pair ${s.confidence}">
        <div class="row"><label class="chk grow"><input type="checkbox" data-inc="${i}" ${s.include ? 'checked' : ''}> <input class="st-title" data-title="${i}" value="${esc(s.title)}"></label>
          <span class="tagp">${s.confidence === 'high' ? '確か' : s.confidence === 'mid' ? 'たぶん' : '要確認'}</span></div>
        <label class="field"><span>🎬 動画・音声</span><select data-k="media" data-i="${i}">${opt(files.media, s.media, (m) => `${m.name}（${fmt(m.duration)}）`)}</select></label>
        <label class="field"><span>英語</span><select data-k="en" data-i="${i}">${opt(files.subs, s.en, (x) => x.name)}</select></label>
        <label class="field"><span>日本語</span><select data-k="ja" data-i="${i}">${opt(files.subs, s.ja, (x) => x.name)}</select></label>
        <small class="muted">${esc(s.reasons.join('・') || '手動')}</small></div>`).join('')}
      <div class="card stack"><span class="small">動画・音声の保存</span>
        <label class="chk"><input type="radio" name="sm" value="store" ${storeMode === 'store' ? 'checked' : ''}> 端末に保存（おすすめ・すぐ再生できる）</label>
        <label class="chk"><input type="radio" name="sm" value="ref" ${storeMode === 'ref' ? 'checked' : ''}> 保存しない（開くたびに同じファイルを選び直す）</label>
        ${storeMode === 'store' ? `<span class="small">保存する質</span>
        <label class="chk"><input type="radio" name="vq" value="audio" ${videoQ === 'audio' ? 'checked' : ''}> 節約（おすすめ）：音声だけ・低音質（動画は映像を捨てる）</label>
        <label class="chk"><input type="radio" name="vq" value="orig" ${videoQ === 'orig' ? 'checked' : ''}> 元のまま（映像も見る教材・高音質）</label>` : ''}
        ${needBytes ? `<small class="muted">必要な容量：約${fmtSize(storeMode === 'store' && videoQ === 'audio' ? inc.reduce((a, x) => a + Math.min(x.media.file.size, (x.media.duration || 0) * (typeof AudioEncoder !== 'undefined' ? 4000 : 32000)), 0) : needBytes)}</small>` : ''}</div>
      <label class="chk"><input type="checkbox" id="atr" ${autoTrimOn ? 'checked' : ''}> 前後の画面収録音・無音を自動でカット</label>
      ${autoTrimOn ? `<label class="chk"><input type="checkbox" id="drc" ${dropCutSetting() ? 'checked' : ''}> カットした部分（元の前後）は保存しない（容量節約・元に戻せません）</label>` : ''}
      <button class="btn primary" id="go" ${over || !sets.some((s) => s.include) ? 'disabled' : ''}>${toSet ? '追加する' : '登録する'}</button>
      <div id="prog"></div>`;
    $$('[data-inc]', el).forEach((c) => (c.onchange = () => { sets[+c.dataset.inc].include = c.checked; draw(); }));
    $$('[data-title]', el).forEach((c) => (c.onchange = () => { sets[+c.dataset.title].title = c.value; }));
    $$('select[data-k]', el).forEach((sel) => (sel.onchange = () => {
      const s = sets[+sel.dataset.i], k = sel.dataset.k;
      const pool = k === 'media' ? files.media : files.subs;
      s[k] = pool.find((x) => x.key === sel.value) || null;
      if (k !== 'media' && s[k]) s[k].lang = k;   // the user decides the language by the column
      s.reasons = ['手動']; s.confidence = s.media && (s.en || s.ja) ? 'high' : 'low';
      draw();
    }));
    $$('input[name=sm]', el).forEach((r) => (r.onchange = () => { storeMode = r.value; draw(); }));
    $$('input[name=vq]', el).forEach((r) => (r.onchange = () => { videoQ = r.value; draw(); }));
    $('#atr', el).onchange = (e) => { autoTrimOn = e.target.checked; draw(); };
    $('#drc', el)?.addEventListener('change', (e) => setDropCut(e.target.checked));
    $('#gm', el).onclick = (e) => { const v = e.target.dataset.v; if (v) { groupMode = v; draw(); } };
    $('#incAll', el).onclick = () => { sets.forEach((s) => (s.include = true)); draw(); };
    $('#incNone', el).onclick = () => { sets.forEach((s) => (s.include = false)); draw(); };
    $('#go', el).onclick = () => { const inc = sets.filter((s) => s.include); if (toSet) return runAppend(inc, storeMode === 'store' && videoQ === 'audio' ? 'store-audio' : storeMode); runImport(groupMode === 'folder' ? groupsOf(inc) : inc.map((s) => ({ title: s.title, items: [s], folder: groupsOf([s])[0]?.title || '' })), storeMode === 'store' && videoQ === 'audio' ? 'store-audio' : storeMode); };
  }
  async function runAppend(list, mode) {
    const prog = $('#prog', el); $('#go', el).disabled = true; running('追加');
    try {
      await appendToSet(toSet.id, list.map((s) => ({ title: s.title, items: [s] })), mode, autoTrimOn, (k, n, t = '') => (prog.innerHTML = `<p class="small">追加中（${k} / ${n}）${t ? `<br>${esc(t)}` : ''}</p>`));
      running(null); nav(`set?id=${toSet.id}`);
    } catch (e) { running(null); prog.innerHTML = `<div class="card warn">追加できませんでした：${esc(e?.message || String(e))}</div>`; $('#go', el).disabled = false; }
  }
  async function runImport(list, mode) {
    const prog = $('#prog', el);
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    navigator.storage?.persist?.().catch(() => {});
    $('#go', el).disabled = true;
    const results = [];
    running('一括登録');
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      prog.innerHTML = `<p class="small">登録中 ${i + 1} / ${list.length}：${esc(s.title)}</p>`;
      try { results.push({ s, id: await createSet(s, mode, autoTrimOn, (k, n, t = '') => (prog.innerHTML = `<p class="small">登録中 ${i + 1} / ${list.length}：${esc(s.title)}（${k} / ${n}）${t ? `<br>${esc(t)}` : ''}</p>`)) }); }
      catch (e) { results.push({ s, err: (e?.message || String(e)) }); }
    }
    lock?.release?.(); running(null);
    files.media = []; files.subs = []; sets = null; listFiles();   // the next files start from empty (not mixed with these)
    prog.innerHTML = `<div class="card stack"><b>登録 ${results.filter((r) => r.id).length}セット・失敗 ${results.filter((r) => r.err).length}</b>
      ${results.map((r) => `<div class="small">${r.id ? `✓ <a class="link" href="#${BASE}set?id=${r.id}">${esc(r.s.title)}</a>` : `✕ ${esc(r.s.title)}：${esc(r.err)}`}</div>`).join('')}
      <a class="btn" href="#${BASE}sets">一覧へ</a></div>`;
  }
}

function highPass(a, fc = 80) { const rc = 1 / (2 * Math.PI * fc), dt = 1 / 16000, al = rc / (rc + dt); let py = 0, px = a[0] || 0; for (let i = 0; i < a.length; i++) { const x = a[i]; py = al * (py + x - px); px = x; a[i] = py; } return a; }
// ---- trimming the start / end (screen-recording sounds, silence) ----
async function findEdges(src, blob, D, a16 = null) {
  const W = Math.min(6, D / 3);
  let a0, a1;
  const isMp3 = /mpeg|mp3|aac/.test(blob?.type || src.mime || '') || /\.(mp3|aac)$/i.test(src.name || '');
  if (a16) { D = a16.length / 16000; a0 = a16.subarray(0, W * 16000); a1 = a16.subarray(Math.max(0, a16.length - W * 16000)); }   // already in memory: no second decode
  else if (isMp3 && blob.size > 2e6 && D > 30 && src.derived !== 'audio16k') {   // mp3/aac frames can be cut anywhere: decode only the head and the tail
    try {
      const h = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
      const id3 = h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 ? 10 + ((h[6] & 0x7f) << 21 | (h[7] & 0x7f) << 14 | (h[8] & 0x7f) << 7 | (h[9] & 0x7f)) : 0;   // skip the tag (cover art)
      const bps = (blob.size - id3) / D, n = Math.ceil((W + 2) * bps);
      a0 = (await decodeTo16k(blob.slice(id3, id3 + n, blob.type))).audio.subarray(0, W * 16000);
      const t = (await decodeTo16k(blob.slice(blob.size - n, blob.size, blob.type))).audio; a1 = t.subarray(Math.max(0, t.length - W * 16000));
    } catch { a0 = a1 = undefined; }
  }
  if (a0) { /* done */ } else {
  const info = isContainer(src, blob) && src.derived !== 'audio16k' ? await probeSource(src, blob).catch(() => null) : null;
  const at = info ? audioTracks(info) : [];
  const t = at.find((x) => x.id === src.audio?.trackId) || at[src.audio?.index ?? 0];
  if (t && canExtract(t)) {
    a0 = (await decodeTo16k((await extractTrack(blob, t, 0, W)).blob)).audio;
    const x = await extractTrack(blob, t, Math.max(0, D - W), D); const d1 = await decodeTo16k(x.blob); a1 = d1.audio; D = x.start + d1.duration;
  } else { const { audio, duration } = await decodeTo16k(blob); D = duration; a0 = audio.subarray(0, W * 16000); a1 = audio.subarray(Math.max(0, audio.length - W * 16000)); }
  }
  let st = edgeCut(frameRms(a0), frameZcr(a0)), en = edgeCut(frameRms(a1).reverse(), frameZcr(a1).reverse());
  const dc = defaultCut();
  // screen recordings: always cut at least the usual sound length (more if a longer sound/silence was found)
  // (start only: the stop sound is not in the recording — on a real recording the speech runs to the very end)
  if (isScreenRec(src.name) && dc > 0 && st.cut < dc) st = { cut: dc, why: `画面収録の音 ${dc}秒` };
  return { start: +st.cut.toFixed(2), end: +(D - en.cut).toFixed(2), whyStart: st.why, whyEnd: en.why, duration: D };
}
const dropCutSetting = () => { try { return localStorage.getItem('st-dropCut') === '1'; } catch { return false; } };
const setDropCut = (v) => { try { localStorage.setItem('st-dropCut', v ? '1' : '0'); } catch {} };
// Remove the parts outside [a, b] from the saved file itself (cannot be undone). Sound only: a video is turned into its sound.
// All items of every set that use this file are shifted so they still point at the same sound.
async function hardTrim(srcId, a, b, say = () => {}) {
  const src = await sdb.get('sources', srcId);
  if (!src?.stored || !src.blob) throw new Error('端末に保存したファイルだけ削れます');
  let blob = null, start = a;
  const info = isContainer(src, src.blob) ? await probe(src.blob).catch(() => null) : null;
  const at = info ? audioTracks(info) : [];
  const t = at.find((x) => x.id === src.audio?.trackId) || at[src.audio?.index ?? 0];
  if (t && canExtract(t) && (src.kind === 'audio' || src.derived === 'audio16k')) {   // sound file: cut without re-encoding
    say('カット部分を削っています…'); const x = await extractTrack(src.blob, t, a, b); blob = new File([await x.blob.arrayBuffer()], src.name.replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' }); start = x.start;
  } else {   // video or other format: keep only the sound of [a, b] (same as the data saver)
    say('音声だけにして削っています…');
    const full = await sourceAudio16k(src, src.blob, { say });
    const part = full.audio.slice(Math.floor(a * 16000), Math.ceil(b * 16000));
    const small = await shrinkAudio({ audio: part, duration: part.length / 16000 }, src.name, true, say);
    if (!small) throw new Error('この端末では変換できませんでした');
    blob = small.file; start = a; Object.assign(src, { kind: 'audio', derived: 'audio16k', codec: small.codec });
  }
  const m = await readDuration(blob);
  if (!m.playable) throw new Error('カット後のファイルが再生できなかったため、元のまま残しました');   // never replace a good file with a broken one
  Object.assign(src, { blob, mime: blob.type, origSize: src.origSize || src.size, size: blob.size, duration: m.duration || b - start, trimmed: { from: start, to: b, at: Date.now() } });
  delete src.audio; probeCache.delete(src.id); URL.revokeObjectURL(urlCache.get(src.id) || ''); urlCache.delete(src.id);
  await sdb.put('sources', src);
  // shift every set's items that use this file
  for (const set of await sdb.all('sets')) {
    const live = await liveBlocks(set); const changed = [];
    for (const blk of live) {
      if (!blk.segments.some((g) => g.sourceId === srcId)) continue;
      const segs = blk.segments.map((g) => g.sourceId !== srcId ? g : { ...g, start: +Math.max(0, g.start - start).toFixed(2), end: +Math.min(src.duration, g.end - start).toFixed(2) }).filter((g) => g.end - g.start > 0.05);
      changed.push({ ...blk, segments: segs });
    }
    if (!changed.length) continue;
    await commit(set, 'カット部分を削除', { blocks: changed });
    set.undo = []; set.redo = []; await sdb.put('sets', set);   // the old sound is gone: earlier steps cannot be undone
  }
  return src;
}
const probeCache = new Map();
const isContainer = (src, blob) => /mp4|quicktime|m4a|mov/.test(blob?.type || src.mime || '') || /\.(mp4|m4v|mov|m4a)$/i.test(src.name || '');
async function probeSource(src, blob) {
  if (probeCache.has(src.id)) return probeCache.get(src.id);
  const info = await probe(blob); probeCache.set(src.id, info); return info;
}
const stageErr = (stage, e) => Object.assign(new Error(`${stage}：${e?.message || e}`), { stage });
// track choice for a file: auto when clear, otherwise the user picks (with preview). Returns the audio record kept on the source
async function decideTrack(src, blob, say = () => {}) {
  if (!isContainer(src, blob)) return null;
  crumb(`トラック判定 ${src.name} ${fmtSize(blob.size)}`);
  let info; try { say('音声トラックを調べています…'); info = await probeSource(src, blob); } catch { return null; }   // not mp4/mov: normal decoding
  const at = audioTracks(info);
  if (at.length <= 1) return at.length ? { trackId: at[0].id, index: 0, count: 1, method: 'auto', reason: '音声トラックは1本', codec: at[0].codec } : { trackId: null, count: 0, reason: '音声トラックがありません' };
  say(`音声トラックが${at.length}本あります。内容を確かめています…`);
  const r = await chooseTrack(blob, info, decodeTo16k);
  const summary = r.stats.map((x) => ({ id: x.t.id, codec: x.t.codec, lang: x.t.lang, name: x.t.name, speech: x.speech, level: x.level, ok: x.ok }));
  let chosen = r.chosen, method = 'auto';
  if (!r.auto) { chosen = await pickTrackDialog(src, blob, info, r) || chosen; method = 'user'; }
  if (!chosen) throw stageErr('音声トラックの選択', r.reason);
  return { trackId: chosen.id, index: at.indexOf(chosen), count: at.length, method, reason: method === 'user' ? '利用者が選択' : r.reason, codec: chosen.codec, tracks: summary };
}
async function pickTrackDialog(src, blob, info, r) {
  const at = audioTracks(info), dlg = $('#dialog');
  await new Promise((q) => setTimeout(q, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
  const st = (t) => r.stats.find((x) => x.t === t);
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>どの音声を使いますか？</h3><p class="small">${esc(src.name)} には音声が${at.length}本入っています（${esc(r.reason)}）。聞いて、文字起こしに使う方を選んでください。</p>
    ${at.map((t, i) => { const x = st(t); return `<div class="st-segrow"><label class="chk"><input type="radio" name="tk" value="${i}" ${t === r.chosen ? 'checked' : ''}> 音声${i + 1}${t.name ? `（${esc(t.name)}）` : ''}</label>
      <small class="muted">${t.codec}・${t.channels || '?'}ch${t.lang && t.lang !== 'und' ? `・${t.lang}` : ''}${x?.ok ? `・話し声 ${Math.round(x.speech * 100)}%・音量 ${(20 * Math.log10(x.level || 1e-6)).toFixed(0)}dB` : x ? `・${esc(x.why)}` : ''}</small>
      ${canExtract(t) ? `<button type="button" class="btn sm" data-prev="${i}">▶︎ 5秒聞く</button>` : ''}</div>`; }).join('')}
    <audio id="tkPrev" playsinline></audio>
    <div class="row end"><button class="btn primary" value="ok">これを使う</button></div></form>`;
  const au = $('#tkPrev', dlg); const urls = {};
  $$('[data-prev]', dlg).forEach((b) => (b.onclick = async () => {
    const t = at[+b.dataset.prev];
    if (!urls[b.dataset.prev]) { const D = t.duration || 30; const x = await extractTrack(blob, t, Math.max(0, D * 0.3), Math.max(0, D * 0.3) + 5); urls[b.dataset.prev] = URL.createObjectURL(x.blob); }
    au.src = urls[b.dataset.prev]; au.play().catch(() => toast('もう一度押してください'));
  }));
  dlg.returnValue = ''; dlg.showModal();
  await new Promise((q) => (dlg.onclose = q));
  au.pause(); Object.values(urls).forEach(URL.revokeObjectURL);
  const v = $('input[name=tk]:checked', dlg)?.value;
  return v != null ? at[+v] : null;
}
// 16 kHz mono sound of a source, from the chosen track. box: where a "tap to start" button can be shown for the last fallback
async function sourceAudio16k(src, blob, { box = null, say = () => {} } = {}) {
  if (src.derived !== 'audio16k' && isContainer(src, blob)) {
    let info = null; try { info = await probeSource(src, blob); } catch {}
    const at = info ? audioTracks(info) : [];
    if (at.length) {
      const t = at.find((x) => x.id === src.audio?.trackId) || at[src.audio?.index ?? 0] || at[0];
      if (canExtract(t)) {
        let x; try { say('選んだ音声トラックを取り出しています…'); crumb(`取り出し 音声${at.indexOf(t) + 1} ${t.codec}`); x = await extractTrack(blob, t); } catch (e) { throw stageErr('音声の取り出し', e); }
        try { say('音声を展開しています…'); crumb(`展開 ${fmtSize(x.blob.size)}`); const r = await decodeTo16k(x.blob); return { ...r, method: `トラック${at.indexOf(t) + 1}を取り出し` }; } catch (e) { if (!box) throw stageErr('音声の展開', e); }
      }
      if (box) { const r = await captureWithTap(blob, box, src.name, src.duration, at.length > 1 ? at.indexOf(t) : null); return { ...r, method: '再生しながら取り出し' }; }
      throw stageErr('音声の取り出し', `この音声の形式（${t.codec}）は直接取り出せません`);
    }
  }
  try { say('音声を展開しています…'); crumb(`展開（ファイル全体）${fmtSize(blob.size)}`); const r = await decodeTo16k(blob); return { ...r, method: '展開' }; }
  catch (e) { if (!box) throw stageErr('音声の展開', e); const r = await captureWithTap(blob, box, src.name, src.duration, null); return { ...r, method: '再生しながら取り出し' }; }
}

// shows a button in `box`; the capture starts in the tap (iPhone needs a tap to play sound)
function captureWithTap(blob, box, name, dur, trackIndex = null) {
  return new Promise((resolve, reject) => {
    box.innerHTML = `<div class="notice warn stack"><b>${esc(name)}</b><span class="small">このファイルからは音声を直接取り出せませんでした。<br>代わりに、音を出さずに2倍速で再生しながら取り出します（約${fmtMin((dur || 60) / 2)}・画面は開いたまま）。</span>
      <button type="button" class="btn primary" id="capGo">再生しながら取り出す</button><button type="button" class="btn ghost" id="capNo">やめる</button><div class="st-meter" hidden id="capBar"><i style="width:0%"></i><span>0%</span></div></div>`;
    box.querySelector('#capNo').onclick = () => reject(new Error('取り出しをやめました'));
    box.querySelector('#capGo').onclick = () => {
      const c = captureTo16k(blob, { trackIndex, onProgress: (r) => { const m = box.querySelector('#capBar'); if (m) { m.hidden = false; m.querySelector('i').style.width = `${r * 100}%`; m.querySelector('span').textContent = `${Math.round(r * 100)}%`; } } });
      c.startNow();   // synchronous inside the tap
      box.querySelector('#capGo').disabled = true; box.querySelector('#capNo').hidden = true;
      c.done.then((x) => { box.innerHTML = ''; resolve(x); }, (e) => { box.innerHTML = ''; reject(e); });
    };
  });
}
function wav16(f32) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) { const x = Math.max(-1, Math.min(1, f32[i])); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return buf;
}
// AAC 32 kbps mono 16 kHz in ADTS (~0.24 MB/min) via WebCodecs; null if this device cannot encode it
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
async function aac16(f32) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const cfg = { codec: 'mp4a.40.2', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000 };
  try { if (!(await AudioEncoder.isConfigSupported(cfg)).supported) return null; } catch { return null; }
  const frames = []; let err = null, asc = null;
  const enc = new AudioEncoder({ output: (c, meta) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); frames.push(b); if (meta?.decoderConfig?.description && !asc) asc = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description); }, error: (e) => (err = e) });
  enc.configure(cfg);
  const N = 16000;
  for (let i = 0; i < f32.length; i += N) {
    const part = f32.slice(i, Math.min(f32.length, i + N));
    const ad = new AudioData({ format: 'f32', sampleRate: 16000, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((i / 16000) * 1e6), data: part });
    enc.encode(ad); ad.close();
    if (enc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush(); enc.close();
  if (err || !frames.length) return null;
  // some encoders still emit ADTS headers: strip them (7 bytes, no CRC)
  const raw = frames.map((f) => (f.length > 7 && f[0] === 0xff && (f[1] & 0xf0) === 0xf0 ? f.subarray((f[1] & 1) ? 7 : 9) : f));
  return new Blob([mp4Audio(raw, asc || new Uint8Array([0x14, 0x08]))], { type: 'audio/mp4' });
}
// smallest playable copy of the sound: AAC if the device can encode and play it, otherwise 16 kHz WAV (video) or null (audio file kept as is)
async function shrink(blob, name, isVideo, say = () => {}) {
  say('音声を取り出しています…');
  const dec = await decodeTo16k(blob);
  return shrinkAudio(dec, name, isVideo, say);
}
async function shrinkAudio({ audio, duration }, name, isVideo, say = () => {}) {
  let peak = 0; for (let i = 0; i < audio.length; i += 160) peak = Math.max(peak, Math.abs(audio[i]));
  if (peak < 0.001) throw new Error('音声が無音のまま取り出されました（この動画からは音声を取り出せません）');
  say('小さくしています…');
  const a = localStorage.getItem('st-noaac2') ? null : await withTimeout(aac16(audio).catch(() => null), 15000 + duration * 300);
  if (!a && typeof AudioEncoder !== 'undefined') try { localStorage.setItem('st-noaac2', '1'); } catch {}   // do not try again on this device
  if (a) { const f = new File([await a.arrayBuffer()], name.replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' }); const m = await readDuration(f); if (m.playable && m.duration && Math.abs(m.duration - duration) < Math.max(2, duration * 0.03)) return { file: f, duration, codec: 'm4a' }; }
  if (isVideo) return { file: new File([wav16(audio)], name.replace(/\.[^.]+$/, '') + '.wav', { type: 'audio/wav' }), duration, codec: 'wav' };
  return null;
}
const MEDIA_EXT = /\.(mp4|m4v|mov|mp3|m4a|wav|aac|caf|aif|aiff)$/i, AUDIO_EXT = /\.(mp3|m4a|wav|aac|caf|aif|aiff)$/i;
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', caf: 'audio/x-caf', aif: 'audio/aiff', aiff: 'audio/aiff' };
const mimeOf = (n) => MIME[(n.match(/\.(\w+)$/) || [])[1]?.toLowerCase()] || '';
const dirOf = (n) => (n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '');
// folder mode: one set per folder of the media file (keeps file order)
function groupsOf(list) {
  const m = new Map();
  for (const s of list) { const d = dirOf(s.media?.name || s.en?.name || s.ja?.name || '') || 'まとめ'; if (!m.has(d)) m.set(d, []); m.get(d).push(s); }
  return [...m].map(([d, items]) => ({ title: d.split('/').filter(Boolean).join(' / '), items }));
}
// read the file into memory in pieces and make a new Blob, so the saved data does not depend on a temporary file
async function copyBlob(file, say = () => {}) {
  const parts = []; const N = 8 * 1024 * 1024;
  for (let o = 0; o < file.size; o += N) { parts.push(await file.slice(o, Math.min(file.size, o + N)).arrayBuffer()); if (file.size > 50e6) say(`保存しています… ${Math.round((o / file.size) * 100)}%`); }
  return new File(parts, file.name, { type: file.type });
}
async function putSource(media, mode, say = () => {}) {
  let exist = await sdb.get('sources', media.fp.id);
  // the same file was saved before: reuse it only if a set uses it and it still reads and plays.
  // Files left over from an import that stopped (app closed / crashed) can be broken: they are made again from the new file.
  if (exist?.stored) {
    let ok = (await sdb.all('blocks')).some((b) => !b.deleted && b.segments?.some((g) => g.sourceId === exist.id));
    if (ok) try { const B = exist.blob; await B.slice(0, 1024).arrayBuffer(); await B.slice(Math.max(0, B.size - 65536)).arrayBuffer(); ok = (await readDuration(B)).playable; } catch { ok = false; }
    if (!ok) { crumb(`保存済みの${exist.name}を作り直します`); probeCache.delete(exist.id); urlCache.delete(exist.id); exist = null; }
  }
  const src = exist || { id: media.fp.id, kind: media.kind, name: media.name.split('/').pop(), size: media.file.size, mime: media.file.type, duration: media.duration, playable: media.playable, head: media.fp.head, tail: media.fp.tail, addedAt: Date.now(), stored: false };
  if (!src.audio && media.kind !== 'audio' || (!src.audio && isContainer(src, media.file))) { try { src.audio = await decideTrack(src, media.file, say); } catch (e) { src.audioError = e.message; } }
  let a16 = null;
  const small = mode === 'store-audio' && !src.stored ? await sourceAudio16k(src, media.file, { say }).then((a) => { a16 = a.audio; say('小さくしています…'); return shrinkAudio(a, src.name, media.kind !== 'audio', say); }).catch((e) => { src.audioError = e.message; return null; }) : null;
  if (small && small.file.size < media.file.size) {   // data saver: sound only, low quality
    Object.assign(src, { stored: true, blob: small.file, kind: 'audio', mime: small.file.type, derived: 'audio16k', codec: small.codec, origSize: media.file.size, duration: small.duration || src.duration });
  } else if (mode.startsWith('store') && !src.stored) { src.stored = true; src.blob = media.file.size <= 300 * 1024 * 1024 ? await copyBlob(media.file, say) : media.file; }
  else if (!src.stored) sessionFiles.set(src.id, media.file);
  await sdb.put('sources', src);   // a big file is written from disk; may take a while
  return { src, a16 };
}
// group = { title, items: [{ media, en, ja, title }] } → one set; items keep their order
async function createSet(group, mode, trimEdges = false, onStep = () => {}) {
  const setId = newId('set_');
  const { blocks, tracks, firstSrc } = await buildItems(setId, group, mode, trimEdges, onStep);
  const set = { id: setId, title: group.title || firstSrc?.name || '無題', ...(group.folder && group.folder !== 'まとめ' ? { folder: group.folder } : {}), sourceId: firstSrc?.id || null, order: [], undo: [], redo: [],
    display: { show: 'both', opEn: 1, opJa: 0.8, pos: 'below', order: 'en' }, createdAt: Date.now(), updatedAt: Date.now() };
  await sdb.tx(['sets', 'tracks'], 'readwrite', (t) => { t.objectStore('sets').put(set); tracks.forEach((x) => t.objectStore('tracks').put(x)); });
  await commit(set, '取り込み', { blocks, order: blocks.map((b) => b.id) });
  set.undo = []; await sdb.put('sets', set);   // the import itself is not undoable (delete the set instead)
  await saveVersion(set, '取り込み直後', true);
  return setId;
}
// add files to an existing set (script / audio of the same material, added later): one undoable step
async function appendToSet(setId, groups, mode, trimEdges = false, onStep = () => {}) {
  const set = await sdb.get('sets', setId); if (!set) throw new Error('追加先の教材が見つかりません');
  const items = groups.flatMap((g) => g.items);
  const { blocks, tracks, firstSrc } = await buildItems(setId, { items }, mode, trimEdges, onStep);
  if (tracks.length) await sdb.tx(['tracks'], 'readwrite', (t) => tracks.forEach((x) => t.objectStore('tracks').put(x)));
  if (!set.sourceId && firstSrc) set.sourceId = firstSrc.id;
  await commit(set, 'スクリプト・音声を追加', { blocks, order: [...set.order, ...blocks.map((b) => b.id)] });
  return setId;
}
async function buildItems(setId, group, mode, trimEdges = false, onStep = () => {}) {
  const blocks = [], tracks = [];
  let firstSrc = null, n = 0;
  for (const s of group.items) {
    onStep(++n, group.items.length);
    let { src = null, a16 = null } = s.media ? await putSource(s.media, mode, (t) => onStep(n, group.items.length, t)) : {};
    crumb(`登録 ${n}/${group.items.length}：${s.media?.name || ''}`);
    firstSrc ||= src;
    const dur = src?.duration || 0;
    const mkTrack = (sub, lang) => sub && { id: newId('tr_'), setId, lang, fileName: sub.name.split('/').pop(), format: sub.parsed.format, raw: sub.text, offset: 0, cues: sub.parsed.cues };
    const en = mkTrack(s.en, 'en'), ja = mkTrack(s.ja, 'ja');
    if (en) tracks.push(en); if (ja) tracks.push(ja);
    const seg = (a, b) => (src && a != null ? [{ sourceId: src.id, start: Math.max(0, a), end: Math.min(src.duration || dur || b, Math.max(b, a + 0.2)) }] : []);
    const part = [];
    if (en) {
      let enCues = en.cues;
      if (!s.en.parsed.timed) {
        tracks.splice(tracks.indexOf(en), 1);   // the raw copy is not needed: keeps the data small
        if (ja && !s.ja.parsed.timed) tracks.splice(tracks.indexOf(ja), 1);
        // a script without times: lines without sound for now ("文字起こし→照合" gives them their times);
        // the audio stays as one item to transcribe
        const lines = scriptToLines(enCues.map((c) => c.text).join('\n'));
        const jaLines = ja && !s.ja.parsed.timed && ja.cues.length === lines.length ? ja.cues.map((c) => c.text) : [];
        lines.forEach((t, i) => part.push(newBlock(setId, { segments: [], text: t, ja: jaLines[i] || '', script: true, cueRefs: { en: [], ja: [] }, sync: 'auto' })));
        if (src) {
          let a = 0, b = dur || 1;
          if (trimEdges && dur > 4) { try { onStep(n, group.items.length, '前後の音を調べています…'); const r = await findEdges(src, src.stored ? src.blob : sessionFiles.get(src.id), dur, a16); a = r.start; b = r.end; } catch { /* whole file */ } }
          part.push(newBlock(setId, { segments: seg(a, b), label: src.name.replace(/\.[^.]+$/, ''), sync: 'auto' }));
        }
        blocks.push(...part); a16 = null; await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const { map, extra } = ja && s.ja.parsed.timed && !enCues[0]?.est ? alignJa(enCues, ja.cues) : { map: new Map(), extra: [] };
      enCues.forEach((c, i) => {
        const jas = map.get(c.id) || [];
        const jaText = jas.length ? jas.map((j) => j.text).join('') : c.ja || (ja && !s.ja.parsed.timed ? ja.cues[i]?.text || '' : '');
        const segs = seg(c.start, c.end);
        part.push(newBlock(setId, { segments: segs, text: c.text, ja: jaText, cueRefs: { en: [c.id], ja: jas.map((j) => j.id) }, sync: c.est ? 'estimated' : 'auto',
          align: segs.length && tokensOf(c.text).length ? [{ s: 0, e: tokensOf(c.text).length - 1, v0: 0, v1: segs[0].end - segs[0].start }] : [] }));
      });
      for (const j of extra) part.push(newBlock(setId, { segments: seg(j.start, j.end), text: '', ja: j.text, jaStatus: 'needsReview', cueRefs: { en: [], ja: [j.id] } }));
      part.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
    } else if (ja) {
      ja.cues.forEach((j) => part.push(newBlock(setId, { segments: s.ja.parsed.timed ? seg(j.start, j.end) : [], text: '', ja: j.text, cueRefs: { en: [], ja: [j.id] }, sync: s.ja.parsed.timed ? 'auto' : 'estimated' })));
    } else if (src) {   // audio/video without a script: one item for the whole file (text can be added later)
      let a = 0, b = dur || 1, trimNote = '';
      if (trimEdges && dur > 4) { try { onStep(n, group.items.length, '前後の音を調べています…'); const r = await findEdges(src, src.stored ? src.blob : sessionFiles.get(src.id), dur, a16); a = r.start; b = r.end; trimNote = [r.whyStart && `始め ${fmt(a)}`, r.whyEnd && `終わり ${fmt(b)}`].filter(Boolean).join('・'); } catch { /* keep the whole file */ } }
      const shared = (await sdb.all('sets')).some((x) => x.sourceId === src.id);   // used by another set: do not cut its file
      if (trimNote && dropCutSetting() && src.stored && !shared) {
        try { onStep(n, group.items.length, 'カットした部分を削っています…'); const t2 = await hardTrim(src.id, a, b, (t) => onStep(n, group.items.length, t)); const off = t2.trimmed.from; a = Math.max(0, a - off); b = Math.min(t2.duration, b - off); Object.assign(src, t2); }
        catch (e) { trimNote += `（削除はできませんでした：${e.message}）`; }
      }
      part.push(newBlock(setId, { segments: seg(a, b), label: src.name.replace(/\.[^.]+$/, ''), sync: dur ? 'auto' : 'estimated', ...(trimNote ? { trimNote } : {}) }));
    }
    blocks.push(...part);
    a16 = null; await new Promise((r) => setTimeout(r, 250));   // let the phone free the decoded sound before the next file
  }
  return { blocks, tracks, firstSrc };
}

// ================= editor =================
async function editorScreen(el, params) {
  let set = await sdb.get('sets', params.get('id'));
  if (!set) return nav('sets');
  running(`教材を開く（${set.title}）`); setTimeout(() => { if (localStorage.getItem('st-running')?.startsWith('教材を開く')) running(null); }, 4000);
  let srcs = await sourcesMap();
  let blocks = [], byId = {};
  const sel = new Set();
  let arrange = false, drag = null, arrangeBase = 0;
  let selectMode = false, rangeMode = null, anchor = null, onlySel = false, moveMode = false, playing = null, curBlock = null;
  const reload = async () => { set = await sdb.get('sets', set.id); blocks = await liveBlocks(set); byId = Object.fromEntries(blocks.map((b) => [b.id, b])); for (const id of [...sel]) if (!byId[id]) sel.delete(id); };
  await reload();
  const src = srcs[set.sourceId];
  el.innerHTML = `${head(set.title, 'sets', `<button class="icon-btn" id="undoB" aria-label="元に戻す">${icon('undo')}</button><button class="icon-btn" id="redoB" aria-label="やり直す">${icon('redo')}</button><button class="icon-btn" id="moreB" aria-label="メニュー">${icon('more')}</button>`)}
    <div id="relink"></div>${(() => { const x = srcs[set.sourceId]; return x?.audioError ? `<div class="notice warn small">取り込み時の音声処理で失敗したため、元のまま保存しています：${esc(x.audioError)}</div>` : ''; })()}
    <div class="st-player"><div class="st-vwrap"><video id="vid" playsinline webkit-playsinline preload="metadata"></video></div>
      <div class="st-sub" id="sub"></div></div>
      <div class="st-stick"><div class="row st-seekrow"><input type="range" id="seek" class="st-seek" min="0" max="1" step="0.05" value="0" aria-label="再生位置"><span class="small muted" id="tdur"></span></div>
      <div class="row st-ctl"><button class="btn sm" id="back3">⟲3</button><button class="btn sm primary" id="pp">${icon('play')}</button><button class="btn sm" id="fwd3">3⟳</button><span class="small muted" id="tnow">0:00.0</span><span class="grow"></span><button class="btn sm" id="arrB">結合・移動</button><button class="btn sm" id="selB">選択</button></div></div>
    <div id="info" class="small muted"></div><div id="alignNote"></div>
    <div id="list" class="st-list"></div>
    <div id="bar" class="st-bar" hidden></div>`;
  const vid = $('#vid', el), list = $('#list', el), bar = $('#bar', el);
  // play only the chosen sound track (screen recordings: app sound and microphone are separate tracks; never mixed)
  vid.addEventListener('loadedmetadata', () => { const at = vid.audioTracks, a = srcs[vid.dataset.src]?.audio; if (at && at.length > 1) { const k = a?.index ?? 0; for (let i = 0; i < at.length; i++) at[i].enabled = i === k; } });
  vid.addEventListener('error', () => { const s0 = srcs[vid.dataset.src]; logErr(`再生できません（コード${vid.error?.code}・${s0?.name}・${s0?.mime || '?'}・${s0?.codec || '元のまま'}）`); });

  // ---------- media ----------
  // iOS only lets a tap start sound if play() is called right away (no waiting before it), so everything here is synchronous
  let seekTo = null, seeking = false;
  vid.addEventListener('loadedmetadata', () => { if (seekTo != null) { vid.currentTime = seekTo; seekTo = null; } });
  function attach(sourceId, at = null) {
    const s = srcs[sourceId]; const u = mediaURL(s);
    if (!u) return false;
    if (vid.dataset.src !== sourceId) { vid.dataset.src = sourceId; seekTo = at; vid.src = u; el.querySelector('.st-vwrap')?.classList.toggle('audio', s.kind === 'audio'); }
    else if (at != null) vid.currentTime = at;
    return true;
  }
  function drawRelink() {
    const need = [...new Set(blocks.flatMap((b) => b.segments.map((x) => x.sourceId)))].map((id) => srcs[id]).filter((s) => s && !s.stored && !sessionFiles.has(s.id));
    $('#relink', el).innerHTML = need.map((s) => `<div class="notice warn stack"><b>動画・音声ファイルが必要です</b><span class="small">${esc(s.name)}（${fmtSize(s.size)}・${fmt(s.duration)}）は端末に保存していません。同じファイルを選ぶと再生・分割ができます。文字の編集はこのままでもできます。</span>
      <label class="btn sm" for="rl_${s.id}">ファイルを選ぶ</label><input type="file" id="rl_${s.id}" data-src="${s.id}" hidden></div>`).join('');
    $$('#relink input[type=file]', el).forEach((inp) => (inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return; const s = srcs[inp.dataset.src];
      const fp = await fingerprint(f);
      if (fp.id !== s.id && !(await confirmDialog({ title: '別のファイルのようです', body: `<p class="small">選んだファイルは登録時と大きさか中身が違います（写真アプリから選ぶと、iPhoneが別の形式で書き出すことがあります）。このファイルでつなぎますか？時間がずれる可能性があります。</p>`, okLabel: 'つなぐ' }))) return;
      sessionFiles.set(s.id, f); urlCache.delete(s.id); drawRelink(); toast('つなぎました（この画面を閉じるまで有効）');
      if (set.sourceId === s.id) attach(s.id);
    }));
  }
  // play a block: its segments in order (may switch files)
  // cont: keep going to the next items in order (subtitles follow line by line)
  function playBlock(b, loop = false, cont = false, from = null) {
    if (!b.segments.length) return toast('この項目には音声区間がありません');
    let i = 0;
    if (from != null) { const k = b.segments.findIndex((x) => x.sourceId === vid.dataset.src && from >= x.start && from < x.end - 0.05); if (k >= 0) i = k; else from = null; }
    playing = { b, i, loop, cont }; curBlock = b;
    startSeg(from);
  }
  function nextPlayable(b) {
    const ids = set.order.filter((id) => byId[id]); let k = ids.indexOf(b.id);
    while (++k < ids.length) { const n = byId[ids[k]]; if (n?.segments.length) return n; }
    return null;
  }
  function startSeg(from = null) {
    const p = playing; if (!p) return;
    const s = p.b.segments[p.i];
    if (!attach(s.sourceId, from ?? s.start)) { playing = null; return toast('ファイルを選んでください'); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    vid.play().catch((e) => { if (e.name === 'NotAllowedError') toast('もう一度タップしてください'); });
  }
  let raf = 0;
  const tick = () => {
    if (playing && !vid.paused) {
      const s = playing.b.segments[playing.i];
      if (vid.currentTime >= s.end - 0.02) {
        if (playing.i + 1 < playing.b.segments.length) { playing.i++; startSeg(); }
        else if (playing.loop) { playing.i = 0; startSeg(); }
        else if (playing.cont) {
          const n = nextPlayable(playing.b), s1 = n?.segments[0];
          if (!n) { vid.pause(); playing = null; }
          else if (s1.sourceId === s.sourceId && Math.abs(s1.start - vid.currentTime) < 0.3) { playing = { b: n, i: 0, loop: false, cont: true }; curBlock = n; }   // already there: no seek, no gap
          else { playing = { b: n, i: 0, loop: false, cont: true }; curBlock = n; startSeg(); }
        }
        else { vid.pause(); playing = null; }
      }
    }
    $('#tnow', el).textContent = fmt(vid.currentTime || 0);
    const sk = $('#seek', el);
    if (sk && !seeking) { const D = isFinite(vid.duration) ? vid.duration : 0; if (D && +sk.max !== D) { sk.max = D; $('#tdur', el).textContent = fmt(D); } sk.value = vid.currentTime || 0; }
    drawSub();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  cleanup = () => { cancelAnimationFrame(raf); vid.pause(); };
  function blockAtTime() {
    if (playing) return playing.b;
    const t = vid.currentTime, sid = vid.dataset.src;
    return blocks.find((b) => b.segments.some((s) => s.sourceId === sid && t >= s.start && t < s.end)) || null;
  }
  let lastSubId = null;
  function drawSub() {
    const b = blockAtTime(); const id = b ? b.id + '@' + b.rev : null;
    if (id === lastSubId) return; lastSubId = id;
    const html = (b?.text ? `<div class="st-en">${esc(b.text)}</div>` : '') + (b?.ja ? `<div class="st-ja">${esc(b.ja)}</div>` : '');
    $('#sub', el).innerHTML = html || '<span class="muted small">（字幕）</span>';
    $$('.st-row.cur', list).forEach((r) => r.classList.remove('cur'));
    const row = b && list.querySelector(`[data-id="${b.id}"]`);
    if (!row) return;
    row.classList.add('cur');
    if (!vid.paused && !selectMode) {   // keep the current line visible below the (sticky) player
      const ph = el.querySelector('.st-stick')?.getBoundingClientRect().bottom || 0, r = row.getBoundingClientRect();
      if (r.top < ph || r.bottom > innerHeight) { row.style.scrollMarginTop = `${ph + 8}px`; row.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
  }

  // ---------- list ----------
  const holeHTML = (b) => { const t = tokensOf(b.text); return t.map((w, i) => (b.holes || []).some((h) => i >= h.s && i <= h.e) ? `<u class="st-hole">${esc(w)}</u>` : esc(w)).join(' '); };
  function drawList() {
    const rs = ops.ranges(set.order.filter((id) => byId[id]), sel);
    $('#info', el).textContent = `${blocks.length}項目${selectMode ? `・選択 ${rs.length}範囲 ${sel.size}項目` : ''}${(set.undo || []).length ? `・元に戻せる操作 ${set.undo.length}` : ''}`;
    const shown = onlySel ? blocks.filter((b) => sel.has(b.id)) : blocks;
    list.classList.toggle('arranging', arrange);
    list.innerHTML = shown.map((b) => {
      const badges = [b.segments.length > 1 ? `<span class="tagp">${b.segments.length}区間</span>` : '', new Set(b.segments.map((s) => s.sourceId)).size > 1 ? '<span class="tagp">複数ファイル</span>' : '',
        b.sync === 'estimated' ? '<span class="tagp warn">時間は推定</span>' : '', b.asr && !b.aligned ? '<span class="tagp">自動起こし</span>' : '', b.aligned ? '<span class="tagp">スクリプト照合</span>' : '', b.trimNote ? `<span class="tagp">前後カット済み</span>` : '', b.jaStatus === 'needsReview' ? '<span class="tagp warn">訳を確認</span>' : '', !b.segments.length ? '<span class="tagp">音声なし</span>' : ''].join('');
      return `<div class="st-row ${sel.has(b.id) ? 'sel' : ''} ${arrange ? 'jig' : ''}" data-id="${b.id}">
        ${selectMode ? `<span class="st-chk" data-chk="${b.id}">${sel.has(b.id) ? '☑' : '☐'}</span>` : ''}
        <span class="grow st-txt" data-play="${b.id}"><small class="muted">${fmt(b.segments[0]?.start)}–${fmt(b.segments.at(-1)?.end)} ${badges}</small>
          ${b.label ? `<b class="small">${esc(b.label)}</b>` : ''}<span class="st-en2">${holeHTML(b) || `<span class="muted">（英文なし${b.label ? '・✎で追加' : ''}）</span>`}</span><span class="st-ja2">${esc(b.ja || '')}</span></span>
        ${arrange ? `<span class="st-grip" data-grip="${b.id}" aria-label="ドラッグ">≡</span>` : selectMode ? '' : `<button class="icon-btn" data-edit="${b.id}" aria-label="編集">✎</button>`}</div>`;
    }).join('') || '<p class="empty">項目がありません</p>';
    $('#undoB', el).disabled = !(set.undo || []).length; $('#redoB', el).disabled = !(set.redo || []).length;
    const nScript = scriptLines().length, nAudio = blocks.filter((b) => b.segments.length && !b.aligned).length;
    $('#alignNote', el).innerHTML = nScript && nAudio && !selectMode && !arrange ? `<div class="notice row small"><span class="grow">音声の付いていないスクリプトが${nScript}行あります。</span><button class="btn sm primary" id="alignGo">文字起こし→照合</button></div>` : '';
    $('#alignGo', el)?.addEventListener('click', () => runAlign());
    drawBar();
  }
  function drawBar() {
    bar.hidden = !selectMode && !arrange;
    if (arrange) {
      const n0 = (set.undo || []).length - arrangeBase;
      bar.innerHTML = `<div class="small">≡ をつかんで動かします。<b>行の上に重ねる</b>と結合、<b>行と行の間</b>に置くと移動。行をタップすると分けられます。</div>
        <div class="row"><button class="btn sm" id="arrUndo" ${(set.undo || []).length ? '' : 'disabled'} aria-label="元に戻す">${icon('undo')}</button><button class="btn sm" id="arrRedo" ${(set.redo || []).length ? '' : 'disabled'} aria-label="やり直す">${icon('redo')}</button>
        <button class="btn sm" id="arrCancel">キャンセル${n0 > 0 ? `（${n0}件）` : ''}</button><button class="btn sm primary grow" id="arrDone">完了</button></div>`;
      $('#arrDone', bar).onclick = () => { arrange = false; drawList(); };
      $('#arrUndo', bar).onclick = () => $('#undoB', el).click();
      $('#arrRedo', bar).onclick = () => $('#redoB', el).click();
      $('#arrCancel', bar).onclick = async () => {   // undo everything done since 結合・移動 was opened
        let n = (set.undo || []).length - arrangeBase;
        if (n > 0 && !(await confirmDialog({ title: '取り消して終わる', body: `<p>このモードで行った ${n}件の操作を元に戻します。</p>`, okLabel: '取り消す' }))) return;
        while (n-- > 0) { if (!(await undo(set))) break; await reload(); }
        arrange = false; drawList();
      };
      return;
    }
    if (!selectMode) return;
    const n = sel.size;
    if (moveMode) { bar.innerHTML = `<div class="small">移動先の行をタップ（その行の前に入ります）</div><div class="row"><button class="btn sm grow" id="mvEnd">末尾へ</button><button class="btn sm grow" id="mvCancel">やめる</button></div>`;
      $('#mvEnd', bar).onclick = () => doMove(null); $('#mvCancel', bar).onclick = () => { moveMode = false; drawBar(); }; return; }
    bar.innerHTML = `
      <div class="row st-selrow">
        <button class="btn sm ${rangeMode === 'add' ? 'on' : ''}" id="rAdd">${rangeMode === 'add' ? (anchor ? '終わりの行をタップ' : '始めの行をタップ') : '範囲で追加'}</button>
        <button class="btn sm ${rangeMode === 'remove' ? 'on' : ''}" id="rRem">${rangeMode === 'remove' ? (anchor ? '終わりの行をタップ' : '始めの行をタップ') : '範囲で解除'}</button>
        <button class="btn sm" id="sAll">全選択</button><button class="btn sm" id="sNone">解除</button>
        <button class="btn sm ${onlySel ? 'on' : ''}" id="sOnly">選択のみ</button></div>
      <div class="row st-acts">
        <button class="btn sm" data-a="merge" ${n < 2 ? 'disabled' : ''}>結合</button>
        <button class="btn sm" data-a="split" ${n < 1 ? 'disabled' : ''}>文で分割</button>
        <button class="btn sm" data-a="up" ${n < 1 ? 'disabled' : ''}>↑</button>
        <button class="btn sm" data-a="down" ${n < 1 ? 'disabled' : ''}>↓</button>
        <button class="btn sm" data-a="move" ${n < 1 ? 'disabled' : ''}>移動先へ</button>
        <button class="btn sm" data-a="dup" ${n < 1 ? 'disabled' : ''}>複製</button>
        <button class="btn sm" data-a="shift" ${n < 1 ? 'disabled' : ''}>時間±</button>
        <button class="btn sm" data-a="replace">置換</button>
        <button class="btn sm" data-a="redo" ${n < 1 ? 'disabled' : ''}>起こし直す</button>
        <button class="btn sm danger" data-a="del" ${n < 1 ? 'disabled' : ''}>削除</button>
        <button class="btn sm" data-a="done">完了</button></div>`;
    $('#rAdd', bar).onclick = () => { rangeMode = rangeMode === 'add' ? null : 'add'; anchor = null; drawBar(); };
    $('#rRem', bar).onclick = () => { rangeMode = rangeMode === 'remove' ? null : 'remove'; anchor = null; drawBar(); };
    $('#sAll', bar).onclick = () => { blocks.forEach((b) => sel.add(b.id)); drawList(); };
    $('#sNone', bar).onclick = () => { sel.clear(); onlySel = false; drawList(); };
    $('#sOnly', bar).onclick = () => { onlySel = !onlySel; drawList(); };
    $$('[data-a]', bar).forEach((b) => (b.onclick = () => action(b.dataset.a)));
  }
  // selection by tapping rows / range / swipe on the check column
  function tapRow(id) {
    if (moveMode) return doMove(id);
    if (rangeMode) {
      if (!anchor) { anchor = id; drawBar(); return; }
      const ids = blocks.map((b) => b.id); const a = ids.indexOf(anchor), z = ids.indexOf(id);
      for (const x of ids.slice(Math.min(a, z), Math.max(a, z) + 1)) rangeMode === 'add' ? sel.add(x) : sel.delete(x);
      rangeMode = null; anchor = null; drawList(); return;
    }
    sel.has(id) ? sel.delete(id) : sel.add(id); drawList();
  }
  let swipe = null;
  list.addEventListener('touchstart', (e) => { const c = e.target.closest('[data-chk]'); if (!c || !selectMode) return; e.preventDefault(); const id = c.dataset.chk; swipe = { on: !sel.has(id), seen: new Set([id]) }; swipe.on ? sel.add(id) : sel.delete(id); c.textContent = swipe.on ? '☑' : '☐'; c.closest('.st-row').classList.toggle('sel', swipe.on); }, { passive: false });
  list.addEventListener('touchmove', (e) => {
    if (!swipe) return; e.preventDefault();
    const t = e.touches[0]; const row = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.st-row'); if (!row) return;
    const id = row.dataset.id; if (swipe.seen.has(id)) return; swipe.seen.add(id);
    swipe.on ? sel.add(id) : sel.delete(id); row.classList.toggle('sel', swipe.on); const c = row.querySelector('[data-chk]'); if (c) c.textContent = swipe.on ? '☑' : '☐';
  }, { passive: false });
  list.addEventListener('touchend', () => { if (swipe) { swipe = null; drawList(); } });
  list.addEventListener('click', (e) => {
    const chk = e.target.closest('[data-chk]'); if (chk) { if (!('ontouchstart' in window)) tapRow(chk.dataset.chk); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) return editBlock(byId[ed.dataset.edit]);
    const row = e.target.closest('.st-row'); if (!row) return;
    if (arrange) { if (!e.target.closest('[data-grip]')) splitSheet(byId[row.dataset.id]); return; }
    if (selectMode) return tapRow(row.dataset.id);
    playBlock(byId[row.dataset.id], false, true);
  });

  // ---------- 結合・移動 mode (like moving icons on the iPhone home screen): only after pressing the button ----------
  const scroller = document.scrollingElement || document.documentElement;
  list.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-grip]'); if (!g || !arrange) return;
    e.preventDefault();
    const row = g.closest('.st-row'), r = row.getBoundingClientRect();
    const ghost = row.cloneNode(true); ghost.classList.add('st-ghost'); ghost.classList.remove('jig');
    ghost.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;pointer-events:none;z-index:60`;
    document.body.appendChild(ghost); row.classList.add('dragging');
    drag = { id: row.dataset.id, row, ghost, dy: e.clientY - r.top, x: r.left + r.width / 2, target: null, mode: null, y: e.clientY };
    try { g.setPointerCapture(e.pointerId); } catch {}
    const auto = () => { if (!drag) return; const top = (el.querySelector('.st-stick')?.getBoundingClientRect().bottom || 0) + 40;
      if (drag.y < top) scroller.scrollBy(0, -10); else if (drag.y > innerHeight - 70) scroller.scrollBy(0, 10); drag.raf = requestAnimationFrame(auto); };
    drag.raf = requestAnimationFrame(auto);
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag) return; e.preventDefault();
    drag.y = e.clientY; drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    $$('.drop-before,.drop-after,.drop-merge', list).forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-merge'));
    const over = document.elementFromPoint(drag.x, e.clientY)?.closest('.st-row');
    if (!over || over === drag.row || !list.contains(over)) { drag.target = null; return; }
    const r = over.getBoundingClientRect(), k = (e.clientY - r.top) / r.height;
    drag.mode = k < 0.28 ? 'before' : k > 0.72 ? 'after' : 'merge'; drag.target = over.dataset.id;
    over.classList.add(`drop-${drag.mode}`);
  });
  const endDrag = async (ok) => {
    if (!drag) return; const d = drag; drag = null; cancelAnimationFrame(d.raf);
    d.ghost.remove(); d.row.classList.remove('dragging');
    $$('.drop-before,.drop-after,.drop-merge', list).forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-merge'));
    if (!ok || !d.target) return;
    const order = set.order.filter((id) => byId[id]);
    if (d.mode === 'merge') {
      const items = order.filter((id) => id === d.id || id === d.target).map((id) => byId[id]);   // text in display order
      const m = ops.merge(items);
      const o = order.flatMap((id) => (id === items[0].id ? [m.id] : id === items[1].id ? [] : [id]));
      return run('結合', { blocks: [m, ...items.map((b) => ({ ...b, deleted: true }))], order: o });
    }
    const rest = order.filter((id) => id !== d.id); let at = rest.indexOf(d.target) + (d.mode === 'after' ? 1 : 0);
    const o = [...rest.slice(0, at), d.id, ...rest.slice(at)];
    if (o.join() === order.join()) return;
    return run('移動', { order: o });
  };
  list.addEventListener('pointerup', () => endDrag(true));
  list.addEventListener('pointercancel', () => endDrag(false));
  // split one line: tap the word that should start the new line
  async function splitSheet(b) {
    const toks = tokensOf(b.text || '');
    if (toks.length < 2) return toast('分けられる英文がありません');
    const dlg = $('#dialog'); let k = null;
    const sents = ops.splitSentences(b);
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>行を分ける</h3><p class="small muted">新しい行の<b>最初の語</b>をタップしてください。</p>
      <div class="st-words">${toks.map((w, i) => `<button type="button" class="st-wd" data-k="${i}" ${i ? '' : 'disabled'}>${esc(w)}</button>`).join('')}</div>
      <div class="small" id="spPrev"></div>
      <div class="row end">${sents ? `<button class="btn" value="sent">文ごとに分ける（${sents.length}行）</button>` : ''}<button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok" id="spOk" disabled>ここで分ける</button></div></form>`;
    $$('.st-wd', dlg).forEach((x) => (x.onclick = () => {
      k = +x.dataset.k; $$('.st-wd', dlg).forEach((y) => y.classList.toggle('cut', +y.dataset.k === k));
      $('#spPrev', dlg).innerHTML = `<div>1：${esc(toks.slice(0, k).join(' '))}</div><div>2：${esc(toks.slice(k).join(' '))}</div>`; $('#spOk', dlg).disabled = false;
    }));
    dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q));
    const order = set.order.slice();
    if (dlg.returnValue === 'sent' && sents) { order.splice(order.indexOf(b.id), 1, ...sents.map((p) => p.id)); return run(`${sents.length}行に分割`, { blocks: [...sents, { ...b, deleted: true }], order }); }
    if (dlg.returnValue !== 'ok' || k == null) return;
    try { const [A, B] = ops.splitAt(b, k); order.splice(order.indexOf(b.id), 1, A.id, B.id); await run('分割', { blocks: [A, B, { ...b, deleted: true }], order }); }
    catch (e) { toast(e?.message || String(e), 3500); }
  }

  // ---------- actions (each = one undoable operation) ----------
  const ordered = () => ops.orderedSelection(set.order, sel).map((id) => byId[id]).filter(Boolean);
  async function run(label, changes) {
    try { await commit(set, label, changes, srcs); await reload(); drawList(); toast(`${label}しました`, 1200); }
    catch (e) { toast((e?.message || String(e)), 3500); }
  }
  async function action(a) {
    const list0 = ordered();
    if (a === 'done') { selectMode = false; sel.clear(); onlySel = false; rangeMode = null; drawList(); return; }
    if (a === 'merge') {
      const far = ops.ranges(set.order, sel).length > 1;
      if (far && !(await confirmDialog({ title: '離れた項目を結合', body: `<p>${list0.length}項目を表示順に1つにします。音声は順につないで再生します（元のファイルは変えません）。</p>`, okLabel: '結合' }))) return;
      const m = ops.merge(list0);
      const order = set.order.flatMap((id) => (id === list0[0].id ? [m.id] : sel.has(id) ? [] : [id]));
      sel.clear(); sel.add(m.id);
      return run('結合', { blocks: [m, ...list0.map((b) => ({ ...b, deleted: true }))], order });
    }
    if (a === 'split') {
      const changed = [], order = set.order.slice(); let n = 0;
      for (const b of list0) { const parts = ops.splitSentences(b); if (!parts) continue; n++; changed.push(...parts, { ...b, deleted: true }); order.splice(order.indexOf(b.id), 1, ...parts.map((p) => p.id)); sel.delete(b.id); parts.forEach((p) => sel.add(p.id)); }
      if (!n) return toast('文の区切りがある項目がありません（1文の項目は編集画面で語の位置を指定して分割できます）', 3500);
      return run(`${n}項目を文で分割`, { blocks: changed, order });
    }
    if (a === 'up' || a === 'down') return run(a === 'up' ? '上へ移動' : '下へ移動', { order: ops.moveStep(set.order, list0.map((b) => b.id), a === 'up' ? -1 : 1) });
    if (a === 'move') { moveMode = true; drawBar(); return; }
    if (a === 'dup') {
      const copies = list0.map(ops.duplicate);
      const lastIdx = Math.max(...list0.map((b) => set.order.indexOf(b.id)));
      const order = [...set.order.slice(0, lastIdx + 1), ...copies.map((c) => c.id), ...set.order.slice(lastIdx + 1)];
      sel.clear(); copies.forEach((c) => sel.add(c.id));
      return run('複製', { blocks: copies, order });
    }
    if (a === 'del') {
      if (!(await confirmDialog({ title: `${list0.length}項目を削除`, body: '<p>元に戻す（↶）で戻せます。</p>', okLabel: '削除', danger: true }))) return;
      const ids = new Set(list0.map((b) => b.id)); sel.clear();
      return run('削除', { blocks: list0.map((b) => ({ ...b, deleted: true })), order: set.order.filter((id) => !ids.has(id)) });
    }
    if (a === 'shift') {
      const v = prompt('ずらす秒数（例：0.5 / -1.2）', '0.5'); const d = parseFloat(v); if (!d) return;
      return run(`時間を${d > 0 ? '+' : ''}${d}秒ずらす`, { blocks: list0.filter((b) => b.segments.length).map((b) => ops.shiftTime(b, d)) });
    }
    if (a === 'redo') return redoAsr(list0);
    if (a === 'replace') {
      const from = prompt(`置き換える文字（${sel.size ? '選択中の項目' : 'すべての項目'}）`); if (!from) return;
      const to = prompt('置き換え後の文字', '') ?? ''; const target = sel.size ? list0 : blocks;
      const ch = target.filter((b) => b.text.includes(from) || (b.ja || '').includes(from)).map((b) => ops.editText(b, b.text.split(from).join(to), (b.ja || '').split(from).join(to)));
      if (!ch.length) return toast('見つかりませんでした');
      return run(`${ch.length}項目で置換`, { blocks: ch });
    }
  }
  async function doMove(targetId) {
    moveMode = false;
    const ids = ops.orderedSelection(set.order, sel);
    if (targetId && sel.has(targetId)) { toast('選択していない行を移動先にしてください'); drawBar(); return; }
    await run('移動', { order: ops.moveIds(set.order, ids, targetId) });
  }

  // ---------- edit one block ----------
  async function editBlock(b) {
    vid.pause(); playing = null;
    let mode = 'hole'; let work = structuredClone(b);
    const dlg = $('#dialog');
    const draw = () => {
      const toks = tokensOf(work.text);
      dlg.innerHTML = `<form method="dialog" class="dlg stack st-edit"><h3>項目の編集</h3>
        <div class="row"><button type="button" class="btn sm" id="ePlay">${icon('play')} 再生</button><button type="button" class="btn sm" id="eLoop">ループ</button><span class="small muted">${fmt(blockDur(work))}・${work.segments.length}区間</span></div>
        <label class="field"><span>英文</span><textarea id="eEn" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(work.text)}</textarea></label>
        <div class="seg sm" id="eMode"><button type="button" data-v="hole" class="${mode === 'hole' ? 'on' : ''}">語をタップ＝穴埋め</button><button type="button" data-v="split" class="${mode === 'split' ? 'on' : ''}">語をタップ＝その前で分割</button></div>
        <div class="st-toks">${toks.map((w, i) => `<button type="button" class="st-tok ${(work.holes || []).some((h) => i >= h.s && i <= h.e) ? 'hole' : ''}" data-t="${i}">${esc(w)}</button>`).join('')}</div>
        <label class="field"><span>和訳</span><textarea id="eJa" rows="2">${esc(work.ja || '')}</textarea></label>
        <div class="stack">${work.segments.map((s, i) => `<div class="st-segrow"><b>区間${i + 1}</b> <small class="muted">${esc(srcs[s.sourceId]?.name || '')}</small>
          <div class="row"><span class="small">開始 ${fmt(s.start)}</span><button type="button" class="btn xs" data-adj="${i}:start:-0.1">−0.1</button><button type="button" class="btn xs" data-adj="${i}:start:0.1">＋0.1</button><button type="button" class="btn xs" data-now="${i}:start">今の位置</button></div>
          <div class="row"><span class="small">終了 ${fmt(s.end)}</span><button type="button" class="btn xs" data-adj="${i}:end:-0.1">−0.1</button><button type="button" class="btn xs" data-adj="${i}:end:0.1">＋0.1</button><button type="button" class="btn xs" data-now="${i}:end">今の位置</button></div></div>`).join('')}</div>
        <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">保存</button></div></form>`;
      $('#ePlay', dlg).onclick = () => { readText(); playBlock(work); };
      $('#eLoop', dlg).onclick = () => { readText(); playBlock(work, true); };
      $('#eMode', dlg).onclick = (e) => { const v = e.target.dataset.v; if (v) { readText(); mode = v; draw(); } };
      $$('[data-t]', dlg).forEach((t) => (t.onclick = async () => {
        readText(); const i = +t.dataset.t;
        if (mode === 'hole') { work = ops.toggleHole(work, i); draw(); return; }
        if (i === 0) return toast('2語目以降を選んでください');
        try {
          const [A, B] = ops.splitAt(work, i);
          dlg.close('split');
          const order = set.order.slice(); order.splice(order.indexOf(b.id), 1, A.id, B.id);
          await run('分割', { blocks: [A, B, { ...b, deleted: true }], order });
          if (A.sync === 'estimated') toast('音声の切れ目は文字数から推定しました。編集で開始・終了を調整してください', 4000);
        } catch (e) { toast((e?.message || String(e)), 3000); }
      }));
      $$('[data-adj]', dlg).forEach((x) => (x.onclick = () => { readText(); const [i, edge, d] = x.dataset.adj.split(':'); const s = work.segments[+i]; s[edge] = Math.max(0, +(s[edge] + +d).toFixed(2)); work.sync = 'manual'; draw(); }));
      $$('[data-now]', dlg).forEach((x) => (x.onclick = () => { readText(); const [i, edge] = x.dataset.now.split(':'); const s = work.segments[+i]; if (vid.dataset.src !== s.sourceId) return toast('この区間のファイルを再生してから押してください'); s[edge] = +vid.currentTime.toFixed(2); work.sync = 'manual'; draw(); }));
    };
    const readText = () => { const en = $('#eEn', dlg)?.value, ja = $('#eJa', dlg)?.value; if (en != null && (en !== work.text || ja !== work.ja)) work = ops.editText(work, en.trim(), (ja || '').trim()); };
    draw();
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      readText();
      if (JSON.stringify(work) === JSON.stringify(b)) return;
      if (work.text !== b.text) delete work.asr;
      await run('編集', { blocks: [work] });
    };
    dlg.showModal();
  }

  // ---------- proper nouns: list probable mis-hearings, the user confirms each one (with the sound), then one undoable replace ----------
  async function fixNames() {
    const dlg = $('#dialog'); await new Promise((r) => setTimeout(r, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    const names = set.names || [];
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>固有名詞をまとめて直す</h3>
      <p class="small">正しい表記を入れると、聞き違いと思われる箇所を探します。<b>自動では置き換えません</b>。一覧で確かめてから反映します。</p>
      ${names.length ? `<div class="row wrap">${names.map((n, i) => `<button type="button" class="btn xs" data-nm="${i}">${esc(n.name)}</button>`).join('')}</div>` : ''}
      <label class="field"><span>正しい表記</span><input id="nmName" autocomplete="off" autocapitalize="words" placeholder="例：Tahl"></label>
      <label class="field"><span>聞き違いの例（任意・カンマ区切り）</span><input id="nmVar" autocomplete="off" autocapitalize="off" placeholder="例：Tal, Tall Lee"></label>
      <p class="hint">似た綴り・似た音の語も候補に出します。名前らしい語（大文字で始まる・普通の単語でない）は最初からチェックが入り、tall のような普通の単語は外れています。</p>
      <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">探す</button></div></form>`;
    $$('[data-nm]', dlg).forEach((x) => (x.onclick = () => { const n = names[+x.dataset.nm]; $('#nmName', dlg).value = n.name; $('#nmVar', dlg).value = (n.variants || []).join(', '); }));
    dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q));
    if (dlg.returnValue !== 'ok') return;
    const name = $('#nmName', dlg).value.trim(); const variants = $('#nmVar', dlg).value.split(/[,、，]/).map((x) => x.trim()).filter(Boolean);
    if (!name) return toast('正しい表記を入れてください');
    const cands = findCandidates(blocks.map((b) => ({ id: b.id, text: b.text })), name, variants);
    const saveName = async (extra = []) => { const cur = (set.names || []).filter((n) => n.name !== name); const old = (set.names || []).find((n) => n.name === name); set.names = [{ name, variants: [...new Set([...(old?.variants || []), ...variants, ...extra])] }, ...cur].slice(0, 30); await sdb.put('sets', set); };
    if (!cands.length) { await saveName(); return toast('候補は見つかりませんでした（聞き違いの例を足すと探せます）', 3500); }
    await new Promise((r) => setTimeout(r, 60));
    const hl = (c) => { const t = byId[c.id].text; const a = Math.max(0, c.s - 40), z = Math.min(t.length, c.e + 40); return `${a ? '…' : ''}${esc(t.slice(a, c.s))}<mark>${esc(t.slice(c.s, c.e))}</mark>${esc(t.slice(c.e, z))}${z < t.length ? '…' : ''}`; };
    dlg.innerHTML = `<form method="dialog" class="dlg stack st-cmp"><h3>「${esc(name)}」に置き換える候補</h3>
      <p class="small muted">${cands.length}箇所。▶︎で聞いて確かめ、置き換える箇所にチェックを入れてください。</p>
      <div class="row"><button type="button" class="btn xs" id="nmAll">すべて選ぶ</button><button type="button" class="btn xs" id="nmNone">すべて外す</button></div>
      ${cands.map((c, i) => `<div class="row st-nmrow"><input type="checkbox" data-ci="${i}" ${c.checked ? 'checked' : ''}><button type="button" class="btn xs" data-pl="${i}">▶︎</button><span class="small grow">${hl(c)}${c.kind === 'variant' ? ' <span class="tagp">登録した例</span>' : ''}</span></div>`).join('')}
      <div class="row end"><button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok">チェックした箇所を置き換え</button></div></form>`;
    $$('[data-pl]', dlg).forEach((x) => (x.onclick = () => playBlock(byId[cands[+x.dataset.pl].id])));
    $('#nmAll', dlg).onclick = () => $$('[data-ci]', dlg).forEach((x) => (x.checked = true));
    $('#nmNone', dlg).onclick = () => $$('[data-ci]', dlg).forEach((x) => (x.checked = false));
    dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q)); vid.pause(); playing = null;
    if (dlg.returnValue !== 'ok') return;
    const chosen = cands.filter((c, i) => $(`[data-ci="${i}"]`, dlg)?.checked);
    if (!chosen.length) { await saveName(); return toast('置き換えませんでした'); }
    const byB = new Map(); chosen.forEach((c) => { if (!byB.has(c.id)) byB.set(c.id, []); byB.get(c.id).push(c); });
    const ch = [...byB].map(([id, cs]) => { const b = byId[id]; return ops.editText(b, applySpans(b.text, cs, name), b.ja || ''); });
    await saveName(chosen.map((c) => c.word));   // remembered as wrong spellings for next time
    await run(`${chosen.length}箇所を「${name}」に置換`, { blocks: ch });
  }

  // ---------- re-transcribe chosen lines (e.g. with a more accurate model), then compare old / new line by line ----------
  async function redoAsr(list0) {
    const targets = list0.filter((b) => b.segments.length);
    if (!targets.length) return toast('音声のある行を選んでください');
    const ids = [...new Set(targets.flatMap((b) => b.segments.map((g) => g.sourceId)))];
    if (ids.some((id) => !(srcs[id]?.stored ? srcs[id].blob : sessionFiles.get(id)))) return toast('動画・音声ファイルを選び直してから実行してください', 4000);
    const total = targets.reduce((a, b) => a + blockDur(b), 0);
    const def = QUALITY[localStorage.getItem('st-asrq-redo')] ? localStorage.getItem('st-asrq-redo') : 'high';
    if (!(await confirmDialog({ title: `${targets.length}行を起こし直す`, body: `<p>選んだ行（合計 ${fmtMin(total)}）の音声だけを、もう一度文字にします。結果は今の文と並べて表示し、行ごとに選んでから反映します。</p>
      ${total > 180 ? '<p class="warn-text small">行が多いと時間がかかります。気になる行だけを選ぶのがおすすめです。</p>' : ''}
      <div class="stack">${Object.entries(QUALITY).map(([k, t]) => `<label class="chk"><input type="radio" name="rdq" value="${k}" ${def === k ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      <p class="hint">初めて使う精度は、最初にモデルをダウンロードします（無料・Wi-Fi推奨）。</p>`, okLabel: '始める' }))) return;
    const quality = $('#dialog input[name=rdq]:checked')?.value || def;
    try { localStorage.setItem('st-asrq-redo', quality); } catch {}
    const dlg = $('#dialog'); await new Promise((r) => setTimeout(r, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    let cancelled = false, tr = null;
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>起こし直し中</h3><p class="small" id="rdMsg">準備しています…</p><div id="rdCap"></div><button class="btn ghost" value="cancel">中止</button></form>`;
    dlg.returnValue = ''; dlg.onclose = () => { cancelled = true; tr?.close(); }; dlg.showModal();
    const msg = (t) => { const m = $('#rdMsg', dlg); if (m) m.textContent = t; };
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    running(`起こし直し（${set.title}）`); crumb(`起こし直し ${targets.length}行・精度：${quality}`);
    const results = [];
    try {
      tr = openTranscriber('en', msg, { quality });
      const audioOf = new Map();
      for (let k = 0; k < targets.length && !cancelled; k++) {
        const b = targets[k]; const parts = [];
        for (const g of b.segments) {
          if (cancelled) break;
          let a16 = audioOf.get(g.sourceId);
          if (!a16) {
            const src = srcs[g.sourceId], blob = src.stored ? src.blob : sessionFiles.get(g.sourceId);
            msg(`${src.name}：音声を取り出しています…`);
            if (!src.audio && isContainer(src, blob) && src.derived !== 'audio16k') { src.audio = await decideTrack(src, blob, msg); await sdb.put('sources', src); }
            a16 = highPass((await sourceAudio16k(src, blob, { box: $('#rdCap', dlg), say: msg })).audio); audioOf.set(g.sourceId, a16);
          }
          const D = a16.length / 16000, a = Math.max(0, g.start - 0.25), z = Math.min(D, g.end + 0.25);
          const pieces = z - a > 28 ? speechPieces(a16, a, z, { len: 25 }) : [[a, z]];
          for (const [ps, pe] of pieces) {
            if (cancelled) break;
            msg(`${k + 1} / ${targets.length} 行目を文字にしています…`);
            const cues = await recognisePiece(tr, a16, ps, pe, { onRetry: (m) => { msg(`${k + 1} / ${targets.length} 行目：${m}`); crumb(m); } });
            crumb(`起こし直し結果（${cues.how}）：${(cues.raw || '').slice(0, 80) || '（空）'}`);
            parts.push(cues.map((c) => c.text).join(' '));
          }
        }
        results.push({ b, neu: parts.join(' ').replace(/\s+/g, ' ').trim() });
      }
    } catch (e) { logErr('起こし直し：' + (e?.message || e)); }
    finally { tr?.close(); lock?.release?.(); running(null); }
    if (dlg.open) { dlg.onclose = null; dlg.close(); }
    if (!results.length) return;
    await new Promise((r) => setTimeout(r, 60));
    // compare: choose old / new per line (new text is editable)
    dlg.innerHTML = `<form method="dialog" class="dlg stack st-cmp"><h3>結果を比べる</h3><p class="small muted">${cancelled ? '途中で中止しました。終わった行だけ表示しています。' : ''}行ごとに使う方を選びます。新しい文は直せます。</p>
      ${results.map((r, i) => { const same = r.neu === r.b.text, empty = !r.neu; return `<div class="card stack st-cmprow">
        <div class="row"><button type="button" class="btn xs" data-pl="${i}">▶︎</button><small class="muted grow">${fmt(r.b.segments[0].start)}–${fmt(r.b.segments.at(-1).end)}${same ? '・同じ結果' : ''}</small></div>
        <label class="chk"><input type="radio" name="c${i}" value="old" ${same || empty ? 'checked' : ''}> 今：${esc(r.b.text || '（なし）')}</label>
        <label class="chk"><input type="radio" name="c${i}" value="new" ${same || empty ? '' : 'checked'} ${empty ? 'disabled' : ''}> 新：</label>
        <textarea rows="2" data-nt="${i}" ${empty ? 'disabled placeholder="（文字にできませんでした）"' : ''}>${esc(r.neu)}</textarea></div>`; }).join('')}
      <div class="row end"><button class="btn ghost" value="cancel">反映しない</button><button class="btn primary" value="ok">反映</button></div></form>`;
    $$('[data-pl]', dlg).forEach((x) => (x.onclick = () => playBlock(results[+x.dataset.pl].b)));
    $$('[data-nt]', dlg).forEach((x) => (x.oninput = () => { const r = $(`input[name=c${x.dataset.nt}][value=new]`, dlg); if (r) r.checked = true; }));
    dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q)); vid.pause(); playing = null;
    if (dlg.returnValue !== 'ok') return;
    const ch = results.map((r, i) => ({ r, use: $(`input[name=c${i}]:checked`, dlg)?.value, t: ($(`[data-nt="${i}"]`, dlg)?.value || '').trim() }))
      .filter((x) => x.use === 'new' && x.t && x.t !== x.r.b.text).map((x) => ({ ...ops.editText(byId[x.r.b.id] || x.r.b, x.t, (byId[x.r.b.id] || x.r.b).ja || ''), asr: true }));
    if (!ch.length) return toast('変更はありません');
    await run(`${ch.length}行を起こし直し`, { blocks: ch });
  }

  // ---------- transcription (Whisper in the browser; audio never leaves the device) ----------
  // Pieces of ~2 min are transcribed one by one and saved as they finish. The block that still has no text keeps the rest,
  // so if iOS reloads the page, running it again continues from where it stopped.
  async function runAsr() {
    const pool = sel.size ? ordered() : blocks;
    const targets = pool.filter((b) => !b.text.trim() && b.segments.length === 1);
    if (!targets.length) return toast(sel.size ? '選んだ項目に、英文のない音声がありません' : '英文のない音声項目がありません（文字起こしは英文が空の項目だけに行います）', 4000);
    const bySrc = new Map(); for (const b of targets) { const id = b.segments[0].sourceId; if (!bySrc.has(id)) bySrc.set(id, []); bySrc.get(id).push(b.id); }
    if ([...bySrc.keys()].some((id) => !(srcs[id]?.stored ? srcs[id].blob : sessionFiles.get(id)))) return toast('動画・音声ファイルを選び直してから実行してください', 4000);
    const total = targets.reduce((a, b) => a + blockDur(b), 0);
    const big = [...bySrc.keys()].map((id) => srcs[id]).filter((x) => x.kind === 'video' && x.size > 150 * 1024 * 1024);
    if (!(await confirmDialog({ title: '文字起こし（試験的）', body: `<p>${targets.length}項目（合計 ${fmtMin(total)}）を、この端末の中で英語の文字に起こします。</p>${big.length ? `<p class="warn-text small">大きな動画（${fmtSize(big[0].size)}）はメモリ不足で途中で止まることがあります。先に「⋯」→「容量を減らす」をすると安定します。</p>` : ''}
      <div class="stack">${Object.entries(QUALITY).map(([k, t]) => `<label class="chk"><input type="radio" name="asrq" value="${k}" ${(QUALITY[localStorage.getItem('st-asrq2')] ? localStorage.getItem('st-asrq2') : 'acc') === k ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      <p class="hint">・最初の1回だけモデルをダウンロードします（無料・Wi-Fi推奨）。音声は外部に送りません。<br>・無音の部分は飛ばし、話している部分を少しずつ処理して、終わった分から保存します。止まっても、もう一度実行すると続きから。<br>・画面は開いたままにしてください。結果は自動の下書きです。</p>`, okLabel: '始める' }))) return;
    const quality = $('#dialog input[name=asrq]:checked')?.value || 'acc';
    try { localStorage.setItem('st-asrq2', quality); } catch {}
    let cancelled = false, done = 0, lines = 0, speed = 0; const speedSamples = [], noSpeech = [], rawAll = []; let emptyPieces = 0;
    const dlg = $('#dialog');
    await new Promise((r) => setTimeout(r, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>文字起こし中</h3><p class="small" id="asrMsg">準備しています…</p><div class="st-meter"><i id="asrBar" style="width:0%"></i><span id="asrPct">0%</span></div><p class="small muted" id="asrDone"></p><div id="asrCap"></div><button class="btn ghost" value="cancel">中止（ここまでは保存済み）</button></form>`;
    dlg.returnValue = ''; dlg.onclose = () => { cancelled = true; tr?.close(); }; dlg.showModal();
    const msg = (t) => { const m = $('#asrMsg', dlg); if (m) m.textContent = t; };
    const bar = () => { const pr = total ? done / total : 0; const b = $('#asrBar', dlg); if (b) { b.style.width = `${pr * 100}%`; $('#asrPct', dlg).textContent = `${Math.round(pr * 100)}%`; } };
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    let tr = null; running(`文字起こし（${set.title}）`); crumb(`精度：${quality}`);
    try {
      tr = openTranscriber('en', msg, { quality });
      for (const [sid, ids] of bySrc) {
        if (cancelled) break;
        const src = srcs[sid];
        msg(`${src.name}：音声を取り出しています…`);
        const fileBlob = src.stored ? src.blob : sessionFiles.get(sid);
        if (!src.audio && isContainer(src, fileBlob) && src.derived !== 'audio16k') { src.audio = await decideTrack(src, fileBlob, (t) => msg(`${src.name}：${t}`)); await sdb.put('sources', src); }
        const { audio } = await sourceAudio16k(src, fileBlob, { box: $('#asrCap', dlg), say: (t) => msg(`${src.name}：${t}`) });
        highPass(audio);   // low rumble / hum makes recognition worse
        for (const bid of ids) {
          const b0 = byId[bid]; const sg = b0.segments[0];
          const pieces = speechPieces(audio, sg.start, sg.end, { len: 25 });   // ≤ one 30 s recognition window: longer pieces lost their tail
          const skipped = (sg.end - sg.start) - pieces.reduce((a, [x, y]) => a + y - x, 0);
          if (!pieces.length) { done += sg.end - sg.start; bar(); noSpeech.push(src.name); continue; }
          for (let pi = 0; pi < pieces.length; pi++) {
            const [ps0, pe0] = pieces[pi];
            const ps = ps0, pe = pi === pieces.length - 1 ? sg.end : pieces[pi + 1][0];   // the gap after a piece is silence: it is skipped
            if (cancelled) break;
            const t0 = Date.now(), lbl = `${src.name}：${fmt(ps0)}〜${fmt(pe0)}`;
            msg(`${lbl} を文字起こし中…`); crumb(`文字起こし ${lbl}`);
            const tick = setInterval(() => msg(`${lbl} を文字起こし中…（${Math.round((Date.now() - t0) / 1000)}秒）${speed ? `・残り目安 ${fmtMin(Math.max(0, (total - done) / speed))}` : ''}`), 1000);
            let cues; try { cues = await recognisePiece(tr, audio, ps0, pe0, { onRetry: (m) => { msg(`${lbl}：${m}`); crumb(m); } }); } finally { clearInterval(tick); }
            crumb(`認識結果（${cues.length}行・${Math.round((Date.now() - t0) / 1000)}秒・${cues.how}）：${(cues.raw || '').slice(0, 80) || '（空）'}`); rawAll.push(cues.raw || '');
            speedSamples.push([pe - ps, (Date.now() - t0) / 1000]); speed = speedSamples.reduce((a, x) => a + x[0], 0) / speedSamples.reduce((a, x) => a + x[1], 0);
            if (cancelled) break;
            const b = byId[bid];   // latest revision (its start moves forward)
            const parts = cues.map((c) => ({ s: c.start, e: c.end, text: c.text, est: c.est }))
              .map((c, i) => newBlock(set.id, { segments: [{ sourceId: sid, start: +c.s.toFixed(2), end: +c.e.toFixed(2) }], text: c.text, ja: '', sync: c.est ? 'estimated' : 'auto', asr: true,
                ...(i === 0 && b.label && b.segments[0].start === sg.start ? { label: b.label } : {}), lineage: { op: 'split', from: [`${b.id}@${b.rev}`], at: Date.now() },
                align: tokensOf(c.text).length ? [{ s: 0, e: tokensOf(c.text).length - 1, v0: 0, v1: +(c.e - c.s).toFixed(2) }] : [] }));
            // nothing recognised in this piece: keep it as an empty item (visible, and re-run picks it up again)
            if (!parts.length) { parts.push(newBlock(set.id, { segments: [{ sourceId: sid, start: +ps0.toFixed(2), end: +pe0.toFixed(2) }], text: '', ja: '', label: '（文字にできなかった部分・もう一度実行できます）', sync: 'auto', lineage: { op: 'split', from: [`${b.id}@${b.rev}`], at: Date.now() } })); emptyPieces++; }
            const rest = pe < sg.end - 0.5 ? { ...b, segments: [{ ...b.segments[0], start: +pe.toFixed(2) }], align: [] } : { ...b, deleted: true };
            const order = set.order.slice(); const at = order.indexOf(b.id);
            order.splice(at, rest.deleted ? 1 : 0, ...parts.map((x) => x.id));
            await commit(set, `文字起こし ${fmt(ps)}〜${fmt(pe)}`, { blocks: [...parts, rest], order }, srcs);
            await reload(); drawList();
            done += pe - ps; lines += parts.filter((x) => x.text).length; bar();
            const dd = $('#asrDone', dlg); if (dd) dd.textContent = `保存済み：${lines}行`;
          }
          if (cancelled) break;
        }
      }
    } catch (e) {
      running(null); crumb('失敗：' + (e?.message || e)); lock?.release?.(); tr?.close(); if (dlg.open) dlg.close();
      return confirmDialog({ title: '文字起こしが止まりました', body: `<p class="small">${esc((e?.message || String(e)))}</p><p class="hint">${lines ? `${lines}行は保存済みです。もう一度実行すると続きから始まります。` : '初回はネット接続が必要です（モデルのダウンロード）。'}</p>`, okLabel: '閉じる', cancelLabel: null });
    }
    running(null); lock?.release?.(); tr?.close(); const wasCancelled = cancelled; if (dlg.open) { dlg.onclose = null; dlg.close(); }
    if (!lines) return wasCancelled ? toast('中止しました') : confirmDialog({ title: '文字にできませんでした', body: noSpeech.length ? `<p class="small">${noSpeech.map(esc).join('<br>')}</p><p>音声が見つかりませんでした（無音のまま取り出された可能性）。編集した動画は音声を取り出せないことがあります。写真アプリで「ビデオを複製」または「ファイルに保存」で書き出したものを取り込み直してください。</p>` : `<p>音声認識は動きましたが、文字にできる英語がありませんでした。</p><p class="small">認識された内容：${esc(rawAll.join(' ').trim().slice(0, 200) || '（何も認識されませんでした）')}</p><p class="hint">［Music］のような表示だけなら、音楽や効果音と判定されています。何も認識されない場合は、音声が英語として聞き取れていません。</p>`, okLabel: '閉じる', cancelLabel: null });
    if (!wasCancelled && scriptLines().length) return runAlign({ afterAsr: lines });
    const ok = await confirmDialog({ title: wasCancelled ? `${lines}行で中止しました` : `文字起こしが終わりました（${lines}行）`,
      body: `<p>結果は、この画面の一覧（動画の下）に「自動起こし」の印つきで並んでいます。行をタップすると、その部分を再生します。✎で直せます。</p>${wasCancelled ? '<p class="hint">もう一度実行すると続きから始まります。</p>' : ''}${emptyPieces ? `<p class="warn-text small">${emptyPieces}か所は文字にできませんでした（一覧に「文字にできなかった部分」として残しています）。「標準」「最高」の精度で、もう一度「文字起こし」を実行すると、その部分だけやり直します。</p>` : ''}<p class="hint">テキストだけ使いたいときは「⋯」→「テキストを書き出す」。単語帳に入れるときは「⋯」→「単語リストを作る」。</p>`,
      okLabel: '英文をコピー', cancelLabel: '閉じる' });
    if (ok) { try { await navigator.clipboard.writeText(blocks.map((b) => b.text).filter(Boolean).join('\n')); toast('コピーしました'); } catch { toast('コピーできませんでした'); } }
  }
  // ---------- script ↔ audio: the transcription (with mistakes) gives the times, the script gives the text ----------
  function scriptLines() { return set.order.map((id) => byId[id]).filter((b) => b && !b.segments.length && b.text.trim()); }
  async function runAlign({ afterAsr = 0 } = {}) {
    const sl = scriptLines();
    if (!sl.length) return toast('音声の付いていないスクリプトの行がありません（「⋯」→「スクリプト・音声を追加」でテキストを入れます）', 4500);
    const heard = blocks.filter((b) => b.segments.length === 1 && b.text.trim() && !b.aligned);
    if (!heard.length) {
      if (blocks.some((b) => b.segments.length && !b.text.trim())) {
        if (await confirmDialog({ title: '先に文字起こしをします', body: '<p>照合には、音声のおおまかな文字起こしが必要です（間違いがあっても大丈夫です）。終わったら続けて照合します。</p>', okLabel: '文字起こしへ' })) { await new Promise((r) => setTimeout(r, 60)); return runAsr(); }
        return;
      }
      return toast('照合できる音声の行がありません');
    }
    crumb(`照合：スクリプト${sl.length}行・音声の行${heard.length}`);
    const bySrc = new Map(); for (const b of heard) { const k = b.segments[0].sourceId; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(b); }
    let remaining = sl.slice(); const changed = new Map(), del = new Set(); let matched = 0, total = 0;
    for (const [sid, list0] of bySrc) {
      const cues = list0.slice().sort((a, b) => a.segments[0].start - b.segments[0].start).map((b) => ({ id: b.id, start: b.segments[0].start, end: b.segments[0].end, text: b.text }));
      const r = alignScript(remaining.map((b) => ({ id: b.id, text: b.text })), cues);
      matched += r.matched; total += r.total;
      for (const [id, t] of r.times) {
        const b = byId[id], n = tokensOf(b.text).length;
        changed.set(id, { ...b, segments: [{ sourceId: sid, start: t.start, end: t.end }], aligned: true, sync: 'auto', align: n ? [{ s: 0, e: n - 1, v0: 0, v1: +(t.end - t.start).toFixed(2) }] : [], lineage: { op: 'align', from: [`${b.id}@${b.rev}`], at: Date.now() } });
      }
      r.covered.forEach((id) => del.add(id));
      remaining = remaining.filter((b) => !r.times.has(b.id));
    }
    if (!changed.size) {
      return confirmDialog({ title: '照合できませんでした', body: `<p>音声の文字起こしと一致する部分が、スクリプトの中に見つかりませんでした。</p><p class="hint">別の教材の音声か、スクリプトの範囲外の音声かもしれません。文字起こしの精度が低すぎる場合も一致しません。</p>`, okLabel: '閉じる', cancelLabel: null });
    }
    // order: script order stays; recognised lines that were not in the script are placed by time among the aligned lines
    const cur = (id) => changed.get(id) || byId[id];
    const startOf = (id) => cur(id)?.segments[0]?.start;
    const leftover = heard.filter((b) => !del.has(b.id)).sort((a, b) => a.segments[0].start - b.segments[0].start);
    let order = set.order.filter((id) => byId[id] && !del.has(id) && !leftover.some((b) => b.id === id));
    for (const L of leftover) {
      const sid = L.segments[0].sourceId;
      const same = order.filter((id) => cur(id)?.aligned && cur(id).segments[0]?.sourceId === sid);
      if (!same.length) { order.push(L.id); continue; }
      const nextId = same.find((id) => startOf(id) > L.segments[0].start);
      if (nextId) order.splice(order.indexOf(nextId), 0, L.id); else order.splice(order.indexOf(same.at(-1)) + 1, 0, L.id);
    }
    await run('スクリプトと照合', { blocks: [...changed.values(), ...[...del].map((id) => ({ ...byId[id], deleted: true }))], order });
    const left = scriptLines().length;
    await confirmDialog({ title: '照合しました', body: `<p>スクリプト ${sl.length}行のうち <b>${changed.size}行</b>に時刻を付けました（文字起こしの単語の ${total ? Math.round((matched / total) * 100) : 0}% が一致）。</p>
      ${leftover.length ? `<p class="small">スクリプトに無かった音声 ${leftover.length}行は、文字起こしのまま残しています。</p>` : ''}
      ${left ? `<p class="small">音声がまだ無いスクリプト ${left}行は「音声なし」のままです。音声を追加すると、続きを照合できます。</p>` : ''}
      <p class="hint">「スクリプト照合」の行をタップすると再生します。ずれていたら「結合・移動」や✎で直せます。${afterAsr ? '' : ''}</p>`, okLabel: '閉じる', cancelLabel: null });
  }
  // copy the items of another set into this one (the other set is kept)
  async function mergeSets() {
    const others = (await sdb.all('sets')).filter((x) => x.id !== set.id && !x.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!others.length) return toast('ほかの教材がありません');
    const dlg = $('#dialog'); await new Promise((r) => setTimeout(r, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>この教材にまとめる</h3><p class="small">選んだ教材の行を、この教材の最後に足します（選んだ教材はそのまま残ります）。</p>
      <div class="stack">${others.slice(0, 40).map((x, i) => `<label class="chk"><input type="radio" name="ms" value="${i}" ${i ? '' : 'checked'}> ${esc(x.title)}</label>`).join('')}</div>
      <div class="row end"><button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok">まとめる</button></div></form>`;
    dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
    if (dlg.returnValue !== 'ok') return;
    const other = others[+($('input[name=ms]:checked', dlg)?.value || 0)];
    const live = await liveBlocks(other);
    const copies = live.map((b) => { const { id, rev, setId, deleted, ...f } = b; return newBlock(set.id, { ...structuredClone(f), lineage: { op: 'copy', from: [`${b.id}@${b.rev}`], at: Date.now() } }); });
    await run(`「${other.title}」をまとめる`, { blocks: copies, order: [...set.order, ...copies.map((c) => c.id)] });
    if (scriptLines().length && blocks.some((b) => b.segments.length && !b.aligned)) toast('「文字起こし→照合」で位置を合わせられます', 3500);
  }

  // the whole set: start of the first item and end of the last item that has sound
  const edgesOf = () => { const withSeg = set.order.map((id) => byId[id]).filter((b) => b?.segments.length); return withSeg.length ? { first: withSeg[0], last: withSeg[withSeg.length - 1] } : null; };
  async function applyTrim(start, end, label) {
    const e = edgesOf(); if (!e) return toast('音声のある項目がありません');
    const f = structuredClone(e.first), l = e.first.id === e.last.id ? f : structuredClone(e.last);
    const s0 = f.segments[0], s1 = l.segments[l.segments.length - 1];
    if (start != null) { if (start >= s0.end - 0.2) return toast('開始が最初の項目の終わりより後になります'); s0.start = +start.toFixed(2); f.sync = 'manual'; f.align = []; }
    if (end != null) { if (end <= s1.start + 0.2) return toast('終了が最後の項目の始まりより前になります'); s1.end = +end.toFixed(2); l.sync = 'manual'; l.align = []; }
    await run(label, { blocks: f === l ? [f] : [f, l] });
    await maybeDrop();
  }
  // after a cut: optionally remove the cut parts from the saved file
  async function maybeDrop() {
    const e = edgesOf(); if (!e) return;
    const sid = e.first.segments[0].sourceId, src = srcs[sid];
    if (!src?.stored || e.last.segments.at(-1).sourceId !== sid) return;
    const a = e.first.segments[0].start, b = e.last.segments.at(-1).end;
    if (a < 0.05 && (!src.duration || b > src.duration - 0.05)) return;
    const others = (await sdb.all('sets')).filter((x) => x.id !== set.id && x.sourceId === sid).length;
    if (!dropCutSetting()) return;
    if (!(await confirmDialog({ title: 'カットした部分を削除しますか？', body: `<p>${fmt(a)} より前と ${fmt(b)} より後を、保存したファイルから削ります（容量が減ります）。</p><p class="hint">元に戻せません。${src.kind !== 'audio' ? '動画は音声だけになります。' : ''}${others ? `このファイルを使うほかの教材（${others}件）からも、その部分はなくなります。` : ''}</p>`, okLabel: '削除する', cancelLabel: '残す', danger: true }))) return;
    try { await hardTrim(sid, a, b, (t) => toast(t, 3000)); toast('カットした部分を削除しました'); route(); }
    catch (err) { toast('削除できませんでした：' + (err?.message || err), 4000); }
  }
  async function autoTrim() {
    const e = edgesOf(); if (!e) return toast('音声のある項目がありません');
    const sid = e.first.segments[0].sourceId, src = srcs[sid], blob = src.stored ? src.blob : sessionFiles.get(sid);
    if (!blob) return toast('動画・音声ファイルを選び直してください');
    if (e.last.segments.at(-1).sourceId !== sid) return toast('この教材は複数のファイルでできているため自動カットできません。「前後をカット（手動）」で調整してください', 4500);
    if (src.trimmed) return toast('このファイルはすでにカット部分を削除済みです', 3500);
    toast('前後の音を調べています…', 2000);
    try {
      const r = await findEdges(src, blob, src.duration || e.last.segments.at(-1).end);
      const s0 = e.first.segments[0].start, s1 = e.last.segments.at(-1).end;
      const ns = r.start > s0 + 0.05 ? r.start : null, ne = r.end < s1 - 0.05 ? r.end : null;
      if (ns == null && ne == null) return toast('カットする音は見つかりませんでした（前後をカットで手動調整できます）', 3500);
      await applyTrim(ns, ne, '前後の音を自動カット');
      toast(`${ns != null ? `始め ${fmt(ns)}（${r.whyStart}）` : ''}${ns != null && ne != null ? '・' : ''}${ne != null ? `終わり ${fmt(ne)}（${r.whyEnd}）` : ''} でカットしました。↶で戻せます`, 5000);
    } catch (err) { toast('調べられませんでした：' + (err?.message || err), 4000); }
  }
  async function trimDialog() {
    const e = edgesOf(); if (!e) return toast('音声のある項目がありません');
    let st = e.first.segments[0].start, en = e.last.segments.at(-1).end;
    const dlg = $('#dialog'); await new Promise((q) => setTimeout(q, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    const draw = () => {
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>前後をカット</h3><p class="small">教材の始まりと終わりを決めます。元のファイルは変えません（↶で戻せます）。</p>
        <button type="button" class="btn" id="tAuto">自動で見つける（画面収録の音・無音）</button>
        <div class="row"><span class="small grow">画面収録の始めで必ず切る長さ（録画開始の音）</span><button type="button" class="btn xs" id="tDef">${defaultCut() ? `始め${defaultCut()}秒` : '切らない'}</button></div>
        <div class="st-segrow"><b>開始 ${fmt(st)}</b><div class="row"><button type="button" class="btn xs" data-d="s:-0.5">−0.5</button><button type="button" class="btn xs" data-d="s:-0.1">−0.1</button><button type="button" class="btn xs" data-d="s:0.1">＋0.1</button><button type="button" class="btn xs" data-d="s:0.5">＋0.5</button><button type="button" class="btn xs" id="sNow">今の位置</button></div><button type="button" class="btn sm" id="sPlay">▶︎ 開始から3秒聞く</button></div>
        <div class="st-segrow"><b>終了 ${fmt(en)}</b><div class="row"><button type="button" class="btn xs" data-d="e:-0.5">−0.5</button><button type="button" class="btn xs" data-d="e:-0.1">−0.1</button><button type="button" class="btn xs" data-d="e:0.1">＋0.1</button><button type="button" class="btn xs" data-d="e:0.5">＋0.5</button><button type="button" class="btn xs" id="eNow">今の位置</button></div><button type="button" class="btn sm" id="ePlay">▶︎ 終了の3秒前から聞く</button></div>
        <label class="chk"><input type="checkbox" id="tDrop" ${dropCutSetting() ? 'checked' : ''}> カットした部分は保存しない（元に戻せません）</label>
        <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">保存</button></div></form>`;
      $('#tDrop', dlg).onchange = (ev) => setDropCut(ev.target.checked);
      $('#tDef', dlg).onclick = () => { const L = [0, 0.5, 0.9, 1.2, 1.5, 2]; const nx = L[(L.indexOf(defaultCut()) + 1) % L.length]; try { localStorage.setItem('st-defCut2', String(nx)); } catch {} draw(); };
      $$('[data-d]', dlg).forEach((b) => (b.onclick = () => { const [k, d] = b.dataset.d.split(':'); const maxEnd = srcs[e.last.segments.at(-1).sourceId]?.duration || Infinity; if (k === 's') st = Math.min(en - 0.3, Math.max(0, +(st + +d).toFixed(2))); else en = Math.min(maxEnd, Math.max(st + 0.3, +(en + +d).toFixed(2))); draw(); }));
      $('#sNow', dlg).onclick = () => { st = +vid.currentTime.toFixed(2); draw(); };
      $('#eNow', dlg).onclick = () => { en = +vid.currentTime.toFixed(2); draw(); };
      const sid = e.first.segments[0].sourceId;
      $('#sPlay', dlg).onclick = () => playBlock({ segments: [{ sourceId: sid, start: st, end: st + 3 }] });
      $('#ePlay', dlg).onclick = () => playBlock({ segments: [{ sourceId: e.last.segments.at(-1).sourceId, start: Math.max(0, en - 3), end: en }] });
      $('#tAuto', dlg).onclick = async () => {
        const src = srcs[sid], blob = src.stored ? src.blob : sessionFiles.get(sid); if (!blob) return toast('ファイルを選び直してください');
        $('#tAuto', dlg).textContent = '調べています…';
        try { const r = await findEdges(src, blob, src.duration || en); if (r.start > st + 0.05) st = r.start; if (r.end < en - 0.05) en = r.end; draw(); toast(r.whyStart || r.whyEnd ? `見つかりました：${[r.whyStart && '始め ' + r.whyStart, r.whyEnd && '終わり ' + r.whyEnd].filter(Boolean).join('・')}` : 'カットする音は見つかりませんでした', 3500); }
        catch (err) { toast('調べられませんでした：' + (err?.message || err)); draw(); }
      };
    };
    draw(); dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q)); vid.pause(); playing = null;
    if (dlg.returnValue === 'ok') await applyTrim(st !== e.first.segments[0].start ? st : null, en !== e.last.segments.at(-1).end ? en : null, '前後をカット');
  }
  async function chooseTrackAgain() {
    const list = Object.values(srcs).filter((x) => x.audio?.count > 1 && x.derived !== 'audio16k' && blocks.some((b) => b.segments.some((g) => g.sourceId === x.id)));
    for (const x of list) {
      const blob = x.stored ? x.blob : sessionFiles.get(x.id); if (!blob) continue;
      const info = await probeSource(x, blob);
      const r = await chooseTrack(blob, info, decodeTo16k);
      const t = await pickTrackDialog(x, blob, info, { ...r, chosen: audioTracks(info)[x.audio.index] || r.chosen, reason: `今は音声${x.audio.index + 1}` });
      if (!t) continue;
      x.audio = { ...x.audio, trackId: t.id, index: audioTracks(info).indexOf(t), method: 'user', reason: '利用者が選択' };
      await sdb.put('sources', x); toast(`音声${x.audio.index + 1}を使います`);
    }
    route();
  }
  async function toAudio() {
    const ids = [...new Set(blocks.flatMap((b) => b.segments.map((x) => x.sourceId)))].filter((id) => srcs[id]?.stored && (srcs[id].derived !== 'audio16k' || srcs[id].codec === 'aac'));
    if (!ids.length) return toast('容量を減らせるファイルがありません（すでに節約済み）');
    const size = ids.reduce((a, id) => a + (srcs[id].blob?.size || srcs[id].size), 0);
    if (!(await confirmDialog({ title: '容量を減らす', body: `<p>${ids.length}ファイル（${fmtSize(size)}）を、音声だけ・低音質に変換します。字幕・編集・時間はそのままです。</p><p class="hint">動画の映像と元の音質は戻せません（元のファイルは「ファイル」アプリなどに残っています）。文字起こしが途中で止まる場合にも有効です。</p>`, okLabel: '変換する', danger: true }))) return;
    let saved = 0, n = 0; running('容量を減らす');
    for (const id of ids) {
      toast(`変換中 ${++n} / ${ids.length}：${srcs[id].name}`, 4000);
      try {
        const src = await sdb.get('sources', id); const before = src.blob.size;
        const say = (t) => toast(`${n} / ${ids.length}：${t}`, 4000);
        if (!src.audio && src.kind !== 'audio') { src.audio = await decideTrack(src, src.blob, say); await sdb.put('sources', src); }
        let small = await sourceAudio16k(src, src.blob, { say }).then((a) => shrinkAudio(a, src.name, src.kind !== 'audio', say)).catch((e) => e);
        if (small instanceof Error && small.stage !== '音声トラックの選択') {
          const dlg = $('#dialog'); await new Promise((r) => setTimeout(r, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
          dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>音声の取り出し</h3><p class="small">${esc(small.message)}</p><div id="capBox"></div></form>`; dlg.showModal();
          try { const cap = await captureWithTap(src.blob, $('#capBox', dlg), src.name, src.duration, src.audio?.count > 1 ? src.audio.index : null); small = await shrinkAudio(cap, src.name, src.kind !== 'audio'); }
          catch (e) { small = e; } finally { if (dlg.open) dlg.close(); }
        }
        if (small instanceof Error) throw small;
        if (!small || (small.file.size >= before && src.codec !== 'aac' && !/mpeg|mp3/.test(src.mime || ''))) continue;
        Object.assign(src, { blob: small.file, kind: 'audio', mime: small.file.type, derived: 'audio16k', codec: small.codec, origSize: src.size, duration: small.duration || src.duration });
        await sdb.put('sources', src); URL.revokeObjectURL(urlCache.get(id) || ''); urlCache.delete(id); saved += before - small.file.size;
      } catch (e) { running(null); await confirmDialog({ title: '変換できませんでした', body: `<p class="small">${esc(srcs[id].name)}<br>${esc((e?.message || String(e)))}</p><p class="hint">元のまま残しています。</p>`, okLabel: '閉じる', cancelLabel: null }); }
    }
    running(null); toast(saved ? `${fmtSize(saved)} 減らしました` : 'この端末では、これ以上小さくできませんでした', 3500); route();
  }
  async function exportText() {
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const ts = (t) => `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(Math.floor(t % 60))},${pad(Math.round((t % 1) * 1000), 3)}`;
    // times on the ORIGINAL file's clock (if the cut parts were deleted, the removed start is added back),
    // so the SRT matches the original video in English Labo's video lab
    let acc = 0;
    const timed = blocks.filter((b) => b.text || b.ja).map((b) => { const g = b.segments[0]; const off = g ? srcs[g.sourceId]?.trimmed?.from || 0 : 0; const s0 = set.sourceId && b.segments.length === 1 && g.sourceId === set.sourceId ? g.start + off : acc; const d = blockDur(b) || 2; acc = s0 + d; return { s0, s1: s0 + d, en: b.text, ja: b.ja }; });
    const toSrt = (k) => timed.filter((c) => c[k]).map((c, i) => `${i + 1}\n${ts(c.s0)} --> ${ts(c.s1)}\n${c[k]}\n`).join('\n');
    const srt = toSrt('en'), srtJa = toSrt('ja');
    const which = await confirmDialog({ title: 'テキストを書き出す', body: '<p>どちらの形式にしますか？</p><p class="hint">TXT：英文（と和訳）を並べた文書。SRT：時間つき字幕。英語と日本語は別々のファイルになります（Englaboの動画ラボで「英語字幕」「日本語字幕」としてそれぞれ読み込めます）。</p>', okLabel: 'TXT', cancelLabel: 'SRT' });
    const name = set.title.replace(/[\\/:*?"<>|]/g, '_');
    const files = which ? [new File([txt], `${name}.txt`, { type: 'text/plain' })] : [new File([srt], `${name}.en.srt`, { type: 'text/plain' }), ...(srtJa ? [new File([srtJa], `${name}.ja.srt`, { type: 'text/plain' })] : [])];
    if (navigator.canShare?.({ files })) { try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    for (const file of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); await new Promise((q) => setTimeout(q, 300)); }
  }

  // ---------- header buttons ----------
  $('#undoB', el).onclick = async () => { const op = await undo(set); if (op) { await reload(); drawList(); toast(`元に戻しました：${op.label}`, 1500); } };
  $('#redoB', el).onclick = async () => { const op = await redo(set); if (op) { await reload(); drawList(); toast(`やり直しました：${op.label}`, 1500); } };
  $('#selB', el).onclick = () => { selectMode = !selectMode; arrange = false; if (!selectMode) { sel.clear(); onlySel = false; } drawList(); };
  $('#arrB', el).onclick = () => { arrange = !arrange; if (arrange) { arrangeBase = (set.undo || []).length; selectMode = false; sel.clear(); onlySel = false; vid.pause(); playing = null; } drawList(); };
  $('#pp', el).onclick = () => {
    if (!vid.paused) return vid.pause();
    if (playing) { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} return vid.play().catch(() => {}); }   // resume where it stopped
    const b = (vid.dataset.src && blockAtTime()) || blocks.find((x) => x.segments.length);
    if (b) return playBlock(b, false, true, vid.dataset.src ? vid.currentTime : null);
    if (!vid.dataset.src && set.sourceId) attach(set.sourceId); vid.play().catch(() => {});
  };
  vid.onplay = () => ($('#pp', el).textContent = icon('pause')); vid.onpause = () => ($('#pp', el).textContent = icon('play'));
  // after a seek: follow from the line at the new position (or play freely if there is none)
  const syncAt = (t) => {
    if (!playing) return;
    const sid = vid.dataset.src; const b = blocks.find((x) => x.segments.some((g) => g.sourceId === sid && t >= g.start && t < g.end));
    if (b) { const i = b.segments.findIndex((g) => g.sourceId === sid && t >= g.start && t < g.end); playing = { b, i, loop: false, cont: true }; curBlock = b; } else playing = null;
  };
  const jump = (d) => { const t = Math.max(0, Math.min(vid.duration || Infinity, vid.currentTime + d)); vid.currentTime = t; syncAt(t); };
  const sk = $('#seek', el);
  sk.addEventListener('input', () => { seeking = true; vid.currentTime = +sk.value; $('#tnow', el).textContent = fmt(+sk.value); });
  sk.addEventListener('change', () => { seeking = false; vid.currentTime = +sk.value; syncAt(+sk.value); });
  sk.addEventListener('touchend', () => setTimeout(() => { if (seeking) { seeking = false; syncAt(+sk.value); } }, 50));
  $('#back3', el).onclick = () => jump(-3);
  $('#fwd3', el).onclick = () => jump(3);
  $('#moreB', el).onclick = async () => {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(set.title)}</h3>
      <button class="btn" value="ver">版（保存・復元）</button>
      ${HOST ? '<button class="btn primary" value="send">英語ラボに送る</button>' : ''}
      <button class="btn" value="exp">教材パックとして書き出す${HOST ? '（ファイル）' : ''}</button>
      <button class="btn" value="autotrim">前後の画面収録音を自動カット</button>
      <button class="btn" value="trim">前後をカット（手動で調整）</button>
      <button class="btn" value="asr">文字起こし（端末内・試験的）</button>
      <button class="btn" value="add">スクリプト・音声を追加</button>
      <button class="btn" value="align">スクリプトと照合</button>
      <button class="btn" value="mergeset">別の教材をこの教材にまとめる</button>
      <button class="btn" value="names">固有名詞をまとめて直す</button>
      <button class="btn" value="words">単語リストを作る</button>
      <button class="btn" value="txt">テキストを書き出す</button>
      ${Object.values(srcs).some((x) => x.audio?.count > 1 && x.derived !== 'audio16k') ? '<button class="btn" value="track">使う音声トラックを選ぶ</button>' : ''}
      ${Object.values(srcs).some((x) => x.stored && (x.derived !== 'audio16k' || x.codec === 'aac')) ? '<button class="btn" value="toaudio">容量を減らす（音声だけ・低音質に）</button>' : ''}
      <button class="btn" value="ren">名前を変える</button>
      <button class="btn danger" value="del">このセットを削除</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      await new Promise((r) => setTimeout(r, 60));   // Safari: let the menu finish closing before the next dialog opens
      if (v === 'ver') nav(`versions?id=${set.id}`);
      if (v === 'exp') exportSet(set);
      if (v === 'send') sendToLab(set);
      if (v === 'asr') runAsr();
      if (v === 'words') nav(`words?id=${set.id}`);
      if (v === 'names') fixNames();
      if (v === 'add') nav(`import?to=${set.id}`);
      if (v === 'align') runAlign();
      if (v === 'mergeset') mergeSets();
      if (v === 'txt') exportText();
      if (v === 'toaudio') toAudio();
      if (v === 'track') chooseTrackAgain();
      if (v === 'autotrim') autoTrim();
      if (v === 'trim') trimDialog();
      if (v === 'ren') { const t = prompt('新しい名前', set.title); if (t) { set.title = t; await sdb.put('sets', set); route(); } }
      if (v === 'del' && (await confirmDialog({ title: 'セットを削除', body: '<p>字幕・編集・版も削除します（元に戻せません）。動画本体は、ほかのセットで使っていなければ削除します。</p>', okLabel: '削除', danger: true }))) { await deleteSet(set); nav('sets'); }
    };
    dlg.showModal();
  };
  if (set.sourceId) attach(set.sourceId);
  drawRelink(); drawList(); drawSub();
  if (params.get('align') === '1') { history.replaceState(null, '', `#${BASE}set?id=${set.id}`); setTimeout(() => runAlign(), 300); }   // from 「このフォルダをまとめて照合」
}

async function deleteSet(set) {
  const blocks = await sdb.byIndex('blocks', 'setId', set.id);
  const revs = (await Promise.all(blocks.map((b) => sdb.byIndex('blockRevs', 'blockId', b.id)))).flat();
  const vers = await sdb.byIndex('versions', 'setId', set.id), tracks = await sdb.byIndex('tracks', 'setId', set.id), oplog = await sdb.byIndex('oplog', 'setId', set.id);
  const others = (await sdb.all('sets')).filter((s) => s.id !== set.id);
  const usedElsewhere = new Set((await Promise.all(others.map(async (s) => (await sdb.byIndex('blocks', 'setId', s.id)).flatMap((b) => b.segments.map((x) => x.sourceId))))).flat());
  const srcIds = new Set(blocks.flatMap((b) => b.segments.map((x) => x.sourceId)));
  await sdb.tx(['sets', 'blocks', 'blockRevs', 'versions', 'tracks', 'oplog', 'sources'], 'readwrite', (t) => {
    t.objectStore('sets').delete(set.id);
    blocks.forEach((b) => t.objectStore('blocks').delete(b.id)); revs.forEach((r) => t.objectStore('blockRevs').delete(r.id));
    vers.forEach((v) => t.objectStore('versions').delete(v.id)); tracks.forEach((x) => t.objectStore('tracks').delete(x.id)); oplog.forEach((o) => t.objectStore('oplog').delete(o.id));
    for (const id of srcIds) if (!usedElsewhere.has(id)) t.objectStore('sources').delete(id);
  });
}

// ================= word list (for English Labo's word book) =================
async function wordsScreen(el, params) {
  const set = await sdb.get('sets', params.get('id'));
  if (!set) return nav('sets');
  const blocks = await liveBlocks(set);
  const items = blocks.map((b) => ({ text: b.text, ja: b.ja }));
  let mode = localStorage.getItem('st-wmode') || 'phrase', hideBasic = true, showCommon = false, sort = 'order';
  const chosen = new Set();
  const draw = () => {
    let list;
    if (mode === 'phrase') list = extractPhrases(items).map((x) => ({ key: x.phrase, head: x.phrase, sub: x.ex, ex: x.ex, exJa: x.exJa, first: x.at, n: 1 }));
    else list = extractWords(items, { hideBasic, showCommon }).map((x) => ({ key: x.w, head: x.w, sub: `×${x.n}${x.forms.size > 1 ? `（${[...x.forms].join(', ')}）` : ''}・${x.ex}`, ex: x.ex, exJa: x.exJa, first: x.first, n: x.n }));
    list.sort(sort === 'freq' ? (a, b) => b.n - a.n || a.first - b.first : sort === 'abc' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => a.first - b.first);
    const shown = new Set(list.map((x) => x.key)); for (const k of [...chosen]) if (!shown.has(k)) chosen.delete(k);
    el.innerHTML = `${head('単語リスト', `set?id=${set.id}`)}
      <div class="seg" id="md"><button data-v="phrase" class="${mode === 'phrase' ? 'on' : ''}">熟語（見出し＋例文）</button><button data-v="word" class="${mode === 'word' ? 'on' : ''}">単語</button></div>
      <p class="small muted" id="cnt"></p>
      ${mode === 'word' ? `<div class="seg sm" id="srt"><button data-v="order" class="${sort === 'order' ? 'on' : ''}">出てきた順</button><button data-v="freq" class="${sort === 'freq' ? 'on' : ''}">多い順</button><button data-v="abc" class="${sort === 'abc' ? 'on' : ''}">ABC順</button></div>
      <label class="chk"><input type="checkbox" id="hb" ${hideBasic ? 'checked' : ''}> 中学レベルの基本語を隠す</label>
      <label class="chk"><input type="checkbox" id="cmn" ${showCommon ? 'checked' : ''}> the, is などの機能語も表示</label>
      <p class="hint">人名・地名（文の途中の大文字）、短縮形（I'm など）、数字は外しています。変化形（-s / -ed / -ing）は1つにまとめています。</p>` :
      '<p class="hint">「Refer to. Please refer to the map.」のように、短い見出しのすぐ後にその語を使った例文がある所を熟語として取り出します。見出しのない会話文は対象外です。</p>'}
      <div class="row"><button class="btn sm" id="wAll">表示中をすべて選ぶ</button><button class="btn sm" id="wNone">選択を解除</button></div>
      <div class="card list">${list.map((x) => `<label class="st-wrow"><input type="checkbox" data-w="${esc(x.key)}" ${chosen.has(x.key) ? 'checked' : ''}><span class="grow"><b>${esc(x.head)}</b><br><small class="muted">${esc(x.sub || '')}</small></span></label>`).join('') || `<p class="empty">${blocks.some((b) => b.text) ? (mode === 'phrase' ? '熟語の見出しが見つかりませんでした。「単語」に切り替えてください。' : '該当する語がありません') : '英文がありません。先に文字起こしか字幕の取り込みをしてください。'}</p>`}</div>
      <div class="st-bar"><div class="row">
        <button class="btn sm grow" id="csv">CSVで書き出す</button>
        <button class="btn sm grow" id="cl">Claude用にコピー</button></div>
        <small class="muted">意味をつけるには「Claude用にコピー」→ Claudeのチャットに貼る → 返ってきたCSVを${HOST ? '下に貼り付けて単語帳へ。' : '英語ラボの単語帳「CSVから追加」で読み込み。'}</small></div>
      ${HOST ? `<div class="card stack"><b>訳をつけたCSVを単語帳へ</b>
        <textarea id="wPaste" rows="5" placeholder="Claudeから返ってきたCSV（英語,日本語,品詞,例文,例文訳…）をここに貼り付け" autocapitalize="off" autocorrect="off"></textarea>
        <label class="field"><span>単語集の名前（元データごとにまとめます）</span><input id="wDeck" value="${esc(set.folder || set.title)}"></label>
        <button class="btn primary" id="wSend">英語ラボの単語帳へ（確認画面へ）</button>
        <small class="muted">同じ単語がすでにあれば、新しく作らずにこの単語集にも入れます。</small></div>` : ''}`;
    const upd = () => { $('#cnt', el).textContent = `${set.title}：${list.length}${mode === 'phrase' ? '個の熟語' : '語'}（選択 ${chosen.size}）`; $('#csv', el).disabled = $('#cl', el).disabled = !chosen.size; };
    upd();
    $('#md', el).onclick = (e) => { const v = e.target.dataset.v; if (v && v !== mode) { mode = v; chosen.clear(); try { localStorage.setItem('st-wmode', v); } catch {} draw(); } };
    $('#srt', el)?.addEventListener('click', (e) => { if (e.target.dataset.v) { sort = e.target.dataset.v; draw(); } });
    $('#hb', el)?.addEventListener('change', (e) => { hideBasic = e.target.checked; draw(); });
    $('#cmn', el)?.addEventListener('change', (e) => { showCommon = e.target.checked; draw(); });
    $('#wAll', el).onclick = () => { list.forEach((x) => chosen.add(x.key)); draw(); };
    $('#wNone', el).onclick = () => { chosen.clear(); draw(); };
    $$('[data-w]', el).forEach((c) => (c.onchange = () => { c.checked ? chosen.add(c.dataset.w) : chosen.delete(c.dataset.w); upd(); }));
    const picked = () => list.filter((x) => chosen.has(x.key));
    const q = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    $('#csv', el).onclick = () => {
      const tag = set.title.replace(/[,\s/]+/g, '_').replace(/_+/g, '_');
      const csv = '﻿' + ['英語,日本語,例文,例文訳,タグ', ...picked().map((x) => [x.head, '', x.ex, x.exJa, tag].map(q).join(','))].join('\n');
      const file = new File([csv], `${set.title.replace(/[\\/:*?"<>|]/g, '_')}-${mode === 'phrase' ? 'phrases' : 'words'}.csv`, { type: 'text/csv' });
      const copyIt = () => navigator.clipboard.writeText(csv.slice(1)).then(() => toast('書き出せなかったので、CSVの中身をコピーしました（メモ等に貼り付けて保存できます）', 4500), () => toast('書き出せませんでした'));
      if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch((e) => { if (e?.name !== 'AbortError') copyIt(); });
      else { try { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); } catch { copyIt(); } }
    };
    $('#wSend', el)?.addEventListener('click', () => {
      const text = $('#wPaste', el).value.replace(/^```\w*\n?|```\s*$/gm, '').trim();
      if (!text) return toast('CSVを貼り付けてください');
      HOST.addWordsCsv?.(text, $('#wDeck', el).value.trim() || set.title, set.title);
    });
    $('#cl', el).onclick = async () => {
      const text = (mode === 'phrase'
        ? `次の英語の熟語・表現を、英語学習の単語帳用にCSVにしてください。列は「英語,日本語,品詞,例文,例文訳,メモ」。\n・英語は下の見出しを使います（X・do・one's などの記号はそのまま）。\n・日本語は例文の文脈での意味を中心に（複数あれば「;」区切り）。品詞は「熟語」「句動詞」など。\n・例文は下のものを使い、例文訳をつけます。\n・音声の文字起こしなので聞き間違いがあります。見出し・例文とも、明らかな聞き間違いは正しい英語に直し（例：but away→put away、relion→rely on）、直した内容は「メモ」列に書いてください（例文訳には書かない）。\n・1行に2つの項目が混ざっている場合は2行に分け、例文が見出しと合わない場合は見出しに合う短い例文にしてメモに書いてください。\nCSVだけをコードブロックで返してください。\n\n`
        : `次の英単語を、英語学習の単語帳用にCSVにしてください。列は「英語,日本語,品詞,例文,例文訳」。日本語は例文の文脈での意味を中心に（複数あれば「;」区切り）、例文は下のものをそのまま使い、例文訳をつけてください。熟語として覚えるべきものは、熟語の形に直して構いません。CSVだけをコードブロックで返してください。\n\n`) + picked().map((x) => `${x.head}\t${x.ex}`).join('\n');
      try { await navigator.clipboard.writeText(text); toast('コピーしました。Claudeのチャットに貼り付けてください', 3000); } catch { toast('コピーできませんでした'); }
    };
  };
  draw();
}

// ================= storage cleanup =================
async function cleanScreen(el) {
  el.innerHTML = `${head('容量の整理', 'sets')}<div class="card center muted">調べています…</div>`;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const sets = await sdb.all('sets'), srcs = await sdb.all('sources');
  const used = {}; for (const st of sets) for (const b of await sdb.byIndex('blocks', 'setId', st.id)) if (!b.deleted) for (const g of b.segments) (used[g.sourceId] ||= new Set()).add(st.title);
  const orphans = srcs.filter((x) => !used[x.id]);
  const oplogN = (await sdb.all('oplog')).length, revN = (await sdb.all('blockRevs')).length;
  const names = (await caches.keys().catch(() => [])) || [];
  const model = names.filter((n) => /transformers|onnx|huggingface/i.test(n));
  let mSize = 0; for (const n of model) { try { const c = await caches.open(n); for (const r of await c.keys()) { const res = await c.match(r); mSize += +res.headers.get('content-length') || 0; } } catch {} }
  const sz = (x) => x.blob?.size || 0;
  el.innerHTML = `${head('容量の整理', 'sets')}
    <div class="card stack"><b>このスタジオが使っている容量：${fmtSize(est?.usage || 0)}</b>
      <span class="small">・動画・音声：${fmtSize(srcs.reduce((a, x) => a + sz(x), 0))}（${srcs.length}ファイル）<br>・音声認識モデル：${fmtSize(mSize)}<br>・編集の履歴：${oplogN}件の操作・${revN}件の過去の状態</span></div>
    <div class="card stack">
      <div class="row between"><span><b>どの教材にも使われていないファイル</b><br><small class="muted">${orphans.length}件・${fmtSize(orphans.reduce((a, x) => a + sz(x), 0))}</small></span><button class="btn sm" id="cOrph" ${orphans.length ? '' : 'disabled'}>削除</button></div>
      <div class="row between"><span><b>編集の履歴を整理</b><br><small class="muted">↶で戻せる操作と、保存した版に必要な分だけ残します</small></span><button class="btn sm" id="cHist">整理</button></div>
      <div class="row between"><span><b>音声認識モデル</b><br><small class="muted">次に文字起こしするとき再ダウンロード</small></span><button class="btn sm" id="cModel" ${model.length ? '' : 'disabled'}>${fmtSize(mSize)} 削除</button></div>
    </div>
    <h2 class="sec">ファイル（大きい順）</h2>
    <div class="card list">${srcs.sort((a, b) => sz(b) - sz(a)).map((x) => `<div class="st-setrow"><span class="grow"><b>${esc(x.name)}</b><small class="muted">${x.stored ? fmtSize(sz(x)) : '保存なし'}・${x.derived === 'audio16k' ? '節約保存' : x.kind === 'audio' ? '音声' : '動画'}・${used[x.id] ? `使用：${esc([...used[x.id]].join('、'))}` : '未使用'}</small></span>
      ${x.stored && x.kind !== 'audio' ? `<button class="btn sm" data-small="${x.id}">音声だけに</button>` : ''}</div>`).join('') || '<p class="empty">ファイルはありません</p>'}</div>
    <p class="hint">動画を「音声だけに」すると、映像を捨てて小さな音声にします（字幕・編集はそのまま）。教材ごとの削除は一覧の「選んで削除」から。</p>`;
  $('#cOrph', el).onclick = async () => { if (!(await confirmDialog({ title: '使われていないファイルを削除', body: `<p>${orphans.map((x) => esc(x.name)).join('<br>')}</p>`, okLabel: '削除' }))) return; for (const x of orphans) await sdb.del('sources', x.id); toast('削除しました'); cleanScreen(el); };
  $('#cModel', el).onclick = async () => { for (const n of model) await caches.delete(n); toast('削除しました'); cleanScreen(el); };
  $('#cHist', el).onclick = async () => {
    const keepOps = new Set(), keepRevs = new Set();
    for (const st of sets) {
      (st.undo || []).concat(st.redo || []).forEach((id) => keepOps.add(id));
      for (const b of await sdb.byIndex('blocks', 'setId', st.id)) keepRevs.add(`${b.id}@${b.rev}`);
      for (const v of await sdb.byIndex('versions', 'setId', st.id)) Object.values(v.revs).forEach((r) => keepRevs.add(r));
    }
    const ops = await sdb.all('oplog'); let dOps = 0, dRevs = 0;
    for (const o of ops) { if (keepOps.has(o.id)) o.blocks.forEach((e) => { if (e.before) keepRevs.add(e.before); if (e.after) keepRevs.add(e.after); }); }
    for (const o of ops) if (!keepOps.has(o.id)) { await sdb.del('oplog', o.id); dOps++; }
    for (const r of await sdb.all('blockRevs')) if (!keepRevs.has(r.id)) { await sdb.del('blockRevs', r.id); dRevs++; }
    toast(`整理しました（操作 ${dOps}件・過去の状態 ${dRevs}件）`, 3000); cleanScreen(el);
  };
  $$('[data-small]', el).forEach((b) => (b.onclick = async () => {
    const x = await sdb.get('sources', b.dataset.small);
    if (!(await confirmDialog({ title: '音声だけにする', body: `<p>${esc(x.name)}（${fmtSize(sz(x))}）の映像を捨てて、小さな音声にします。元に戻せません。</p>`, okLabel: '変換', danger: true }))) return;
    try {
      toast('変換中…', 8000);
      if (!x.audio && x.kind !== 'audio') x.audio = await decideTrack(x, x.blob, (t) => toast(t, 4000));
      const a = await sourceAudio16k(x, x.blob, { say: (t) => toast(t, 4000) });
      const small = await shrinkAudio(a, x.name, true); if (!small) throw new Error('この端末では変換できませんでした');
      Object.assign(x, { blob: small.file, kind: 'audio', mime: small.file.type, derived: 'audio16k', codec: small.codec, origSize: x.size, size: small.file.size }); delete x.audio; probeCache.delete(x.id);
      await sdb.put('sources', x); toast('変換しました'); cleanScreen(el);
    } catch (e) { toast('変換できませんでした：' + (e?.message || e), 4000); }
  }));
}

// ================= versions =================
async function versionsScreen(el, params) {
  const set = await sdb.get('sets', params.get('id'));
  if (!set) return nav('sets');
  const vers = (await sdb.byIndex('versions', 'setId', set.id)).sort((a, b) => b.number - a.number);
  const live = await liveBlocks(set);
  const diffCount = (v) => {
    const now = Object.fromEntries(live.map((b) => [b.id, `${b.id}@${b.rev}`]));
    let add = 0, del = 0, mod = 0;
    for (const id of Object.keys(now)) { if (!v.revs[id]) add++; else if (v.revs[id] !== now[id]) mod++; }
    for (const id of Object.keys(v.revs)) if (!now[id]) del++;
    const moved = v.order.join() !== set.order.join();
    return { add, del, mod, moved };
  };
  el.innerHTML = `${head('版', `set?id=${set.id}`)}
    <button class="btn primary" id="save">今の状態を版として保存</button>
    <div class="card list">${vers.map((v) => { const d = diffCount(v); return `<div class="st-setrow"><span class="grow"><b>版${v.number}</b> ${esc(v.label || '')}${v.auto ? ' <span class="tagp">自動</span>' : ''}
      <small class="muted">${new Date(v.at).toLocaleString('ja-JP')}・${Object.keys(v.revs).length}項目・今との差：追加${d.add} 削除${d.del} 変更${d.mod}${d.moved ? '・順番' : ''}</small></span>
      <button class="btn sm" data-v="${v.id}">この版に戻す</button></div>`; }).join('') || '<p class="empty">版がありません</p>'}</div>
    <p class="hint">「この版に戻す」は1つの操作として記録されるので、編集画面の ↶ で取り消せます。今の状態も消えません（先に版として保存しておくと安心です）。</p>`;
  $('#save', el).onclick = async () => { const label = prompt('版の名前（任意）', '') ?? ''; await saveVersion(set, label); toast('保存しました'); versionsScreen(el, params); };
  $$('[data-v]', el).forEach((b) => (b.onclick = async () => {
    const v = vers.find((x) => x.id === b.dataset.v);
    if (!(await confirmDialog({ title: `版${v.number}に戻す`, body: '<p>編集画面の ↶ で取り消せます。</p>', okLabel: '戻す' }))) return;
    await restoreVersion(set, v); toast(`版${v.number}に戻しました`); nav(`set?id=${set.id}`);
  }));
}

// ================= export / import (material pack) =================
// inside English Labo: put the material straight into the video lab (no file in between)
async function buildMaterial(set) {
  const blocks = await liveBlocks(set), srcs = await sourcesMap(), tracks = await sdb.byIndex('tracks', 'setId', set.id);
  const media = [...new Set(blocks.flatMap((b) => b.segments.map((s) => s.sourceId)))].map((id) => srcs[id]).filter(Boolean);
  const manifest = { format: 'elpack', formatVersion: 2, packId: newId('pk_'), materialId: set.id, title: set.title, lang: 'en', source: { app: 'Englabo Studio', appVersion: STUDIO_VERSION }, createdAt: new Date().toISOString() };
  const material = { set: { id: set.id, title: set.title },
    items: blocks.map((b) => ({ id: b.id, rev: b.rev, segments: b.segments.map((s) => ({ media: s.sourceId, start: s.start, end: s.end })), text: b.text, ja: b.ja, holes: b.holes, label: b.label })),
    media: media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime, duration: m.duration, included: !!(m.stored ? m.blob : sessionFiles.get(m.id)) })) };
  return { manifest, material, media, blocks, tracks };
}
async function sendToLab(set) {
  if (!HOST?.sendToLab) return;
  const { manifest, material, media, blocks } = await buildMaterial(set);
  const n = blocks.filter((b) => b.segments.length && (b.text || b.ja)).length;
  if (!n) return toast('音声の付いた英文の行がありません（文字起こし・照合をしてから送ってください）', 4000);
  if (media.some((m) => !(m.stored ? m.blob : sessionFiles.get(m.id)))) return toast('動画・音声ファイルを選び直してから送ってください', 4000);
  const wait = blocks.filter((b) => !b.segments.length && b.text).length;
  if (!(await confirmDialog({ title: '英語ラボに送る', body: `<p>音声の付いた ${n}行を、英語ラボの動画ラボに入れます。${wait ? `（音声のないスクリプト ${wait}行は、照合が済んでから送ると入ります）` : ''}</p><p class="hint">前に送った教材なら、字幕だけ入れ替わります（学習記録は残ります）。</p>`, okLabel: '送る' }))) return;
  try {
    toast('送っています…', 10000);
    const byId = Object.fromEntries(media.map((m) => [m.id, m]));
    const id = await HOST.sendToLab(manifest, material, async (m) => { const s = byId[m.id]; return s ? (s.stored ? s.blob : sessionFiles.get(s.id)) : null; });
    if (id) location.hash = `#video-play?id=${id}`;
  } catch (e) { toast('送れませんでした：' + (e?.message || e), 5000); }
}
async function exportSet(set) {
  const blocks = await liveBlocks(set), srcs = await sourcesMap(), tracks = await sdb.byIndex('tracks', 'setId', set.id);
  const media = [...new Set(blocks.flatMap((b) => b.segments.map((s) => s.sourceId)))].map((id) => srcs[id]).filter(Boolean);
  const canInclude = media.every((m) => m.stored || sessionFiles.has(m.id));
  // English Labo already has the sound that was sent before: a later export can carry only the new sound (+ all subtitles)
  const sent = new Set((set.exported?.media || []).filter((x) => media.some((m) => m.id === x.id && m.size === x.size)).map((x) => x.id));
  const newOnes = media.filter((m) => !sent.has(m.id));
  const nLines = blocks.filter((b) => b.segments.length && (b.text || b.ja)).length, nWait = blocks.filter((b) => !b.segments.length && b.text).length;
  const dlg = document.querySelector('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>英語ラボへ書き出す</h3>
    <p class="small">音声の付いた ${nLines}行が教材になります。${nWait ? `（音声のないスクリプト ${nWait}行は、音声を足して照合したあとの書き出しで入ります）` : ''}</p>
    <div class="stack">
      ${sent.size ? `<label class="chk"><input type="radio" name="em" value="new" checked> 字幕の更新（${newOnes.length ? `新しい音声 ${newOnes.length}件・${fmtSize(newOnes.reduce((a, m) => a + m.size, 0))}だけ含める` : '音声は含めない・とても小さい'}）</label>` : ''}
      <label class="chk"><input type="radio" name="em" value="all" ${sent.size ? '' : 'checked'} ${canInclude ? '' : 'disabled'}> 音声もすべて含める（${fmtSize(media.reduce((a, m) => a + m.size, 0))}）</label>
      <label class="chk"><input type="radio" name="em" value="none"> 音声を含めない（字幕だけ）</label></div>
    <p class="hint">英語ラボで同じ教材を読み込むと、字幕だけ入れ替わります（学習記録は残ります）。前に送った音声は送り直さなくて大丈夫です。</p>
    <div class="row end"><button class="btn ghost" value="cancel">やめる</button><button class="btn primary" value="ok">書き出す</button></div></form>`;
  dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
  if (dlg.returnValue !== 'ok') return;
  const em = dlg.querySelector('input[name=em]:checked')?.value || 'all';
  const inc = new Set(em === 'all' ? media.map((m) => m.id) : em === 'new' ? newOnes.filter((m) => m.stored || sessionFiles.has(m.id)).map((m) => m.id) : []);
  const withMedia = inc.size > 0;
  const manifest = { format: 'elpack', formatVersion: 2, packId: newId('pk_'), materialId: set.id, materialVersion: (await sdb.byIndex('versions', 'setId', set.id)).length, title: set.title, lang: 'en', source: { app: 'Englabo Studio', appVersion: STUDIO_VERSION }, scope: 'collection', createdAt: new Date().toISOString(),
    contents: { audio: withMedia, text: true, translation: true, timestamps: true, vocab: false } };
  const material = { set: { id: set.id, title: set.title, display: set.display }, units: [{ id: set.id, title: set.title, items: blocks.map((b) => b.id) }],
    items: blocks.map((b) => ({ id: b.id, rev: b.rev, segments: b.segments.map((s) => ({ media: s.sourceId, start: s.start, end: s.end })), text: b.text, ja: b.ja, holes: b.holes, align: b.align, cueRefs: b.cueRefs, lineage: b.lineage, sync: b.sync, jaStatus: b.jaStatus, label: b.label, asr: b.asr })),
    media: media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime, duration: m.duration, head: m.head, tail: m.tail, included: inc.has(m.id), path: inc.has(m.id) ? `media/${m.id}${(m.name.match(/\.\w+$/) || [''])[0]}` : null })),
    tracks: tracks.map((t) => ({ id: t.id, lang: t.lang, fileName: t.fileName, format: t.format, path: `subtitles/${t.id}-${t.fileName}` })) };
  const files = [{ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) }, { name: 'material.json', data: JSON.stringify(material, null, 1) }, ...tracks.map((t) => ({ name: `subtitles/${t.id}-${t.fileName}`, data: t.raw }))];
  for (const m of media) if (inc.has(m.id)) files.push({ name: material.media.find((x) => x.id === m.id).path, data: m.stored ? m.blob : sessionFiles.get(m.id) });
  toast('書き出しています…', 2000);
  const zip = await zipWrite(files);
  const name = `${set.title.replace(/[\\/:*?"<>|]/g, '_')}.elpack.zip`;
  const file = new File([zip], name, { type: 'application/zip' });
  const remember = async () => { const cur = await sdb.get('sets', set.id); if (!cur) return; const keep = (cur.exported?.media || []).filter((x) => !inc.has(x.id)); cur.exported = { at: Date.now(), media: [...keep, ...media.filter((m) => inc.has(m.id)).map((m) => ({ id: m.id, size: m.size }))] }; await sdb.put('sets', cur); set.exported = cur.exported; };
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: set.title }); await remember(); return; } catch (e) { if (e.name === 'AbortError') return; } }
  await remember();
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function ioScreen(el) {
  el.innerHTML = `${head('教材パックの読み込み', 'sets')}
    <div class="card stack"><p class="small">このスタジオで書き出した教材パック（.elpack.zip）を読み込みます。別の端末で続きを編集したいときや、バックアップから戻すときに使います。</p>
      <label class="btn" for="pk">📦 教材パックを選ぶ</label><input type="file" id="pk" hidden></div><div id="out"></div>`;
  $('#pk', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try {
      const z = await zipRead(f);
      const manifest = JSON.parse(await z.text('manifest.json')), material = JSON.parse(await z.text('material.json'));
      if (manifest.format !== 'elpack' || manifest.formatVersion > 2) throw new Error('対応していない教材パックです（アプリを更新してください）');
      const exists = await sdb.get('sets', material.set.id);
      $('#out', el).innerHTML = `<div class="card stack"><b>${esc(manifest.title)}</b><span class="small">${material.items.length}項目・動画/音声 ${material.media.length}件（${manifest.contents.audio ? '含む' : '含まない＝あとで選び直し'}）</span>
        ${exists ? '<p class="warn-text small">同じセットがすでにあります。</p><button class="btn" id="asCopy">複製として追加</button><button class="btn primary" id="asUpdate">今のセットを更新（新しい版として）</button>' : '<button class="btn primary" id="asNew">登録する</button>'}</div>`;
      const go = async (mode) => { const id = await importPack(z, manifest, material, mode); toast('読み込みました'); nav(`set?id=${id}`); };
      $('#asNew', el)?.addEventListener('click', () => go('new'));
      $('#asCopy', el)?.addEventListener('click', () => go('copy'));
      $('#asUpdate', el)?.addEventListener('click', () => go('update'));
    } catch (err) { $('#out', el).innerHTML = `<div class="card warn">読み込めませんでした：${esc(err.message)}</div>`; }
  };
}
async function importPack(z, manifest, material, mode) {
  const remap = mode === 'copy';
  const setId = remap ? newId('set_') : material.set.id;
  for (const m of material.media) {
    const exist = await sdb.get('sources', m.id);
    if (exist?.stored) continue;
    const blob = m.included ? await z.file(m.path) : null;
    await sdb.put('sources', { id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime, duration: m.duration, head: m.head, tail: m.tail, stored: !!blob, blob: blob || undefined, addedAt: Date.now() });
  }
  const idMap = {};
  const blocks = material.items.map((it) => { const id = remap ? newId('b_') : it.id; idMap[it.id] = id; return { id, setId, rev: 0, deleted: false, segments: it.segments.map((s) => ({ sourceId: s.media, start: s.start, end: s.end })), text: it.text, ja: it.ja, holes: it.holes || [], align: it.align || [], cueRefs: it.cueRefs || { en: [], ja: [] }, lineage: it.lineage || { op: 'create', from: [] }, sync: it.sync || 'auto', jaStatus: it.jaStatus || 'ok', ...(it.label ? { label: it.label } : {}), ...(it.asr ? { asr: true } : {}) }; });
  let set = mode === 'update' ? await sdb.get('sets', setId) : null;
  if (!set) {
    set = { id: setId, title: material.set.title + (remap ? '（複製）' : ''), sourceId: material.media[0]?.id || null, tracks: {}, order: [], undo: [], redo: [], display: material.set.display || { show: 'both', opEn: 1, opJa: 0.8, pos: 'below', order: 'en' }, createdAt: Date.now(), updatedAt: Date.now() };
    await sdb.put('sets', set);
  } else {
    // update: blocks not in the pack are removed (kept as revisions, restorable via versions); version saved first
    await saveVersion(set, '読み込み前', true);
    const live = await liveBlocks(set); const incoming = new Set(blocks.map((b) => b.id));
    blocks.push(...live.filter((b) => !incoming.has(b.id)).map((b) => ({ ...b, deleted: true })));
  }
  await commit(set, mode === 'update' ? '教材パックで更新' : '教材パックから登録', { blocks, order: material.units[0].items.map((id) => idMap[id] || id) });
  if (mode !== 'update') { set.undo = []; await sdb.put('sets', set); }
  await saveVersion(set, '読み込み', true);
  return setId;
}

// ================= technical checks (P1 / P3 / P4) — uses its own database, does not touch real data =================
async function labScreen(el) {
  const log = [];
  const out = (s) => { log.push(s); $('#lo', el).textContent = log.join('\n'); };
  el.innerHTML = `${head('技術検証', 'sets')}
    <p class="hint">iPhone（ホーム画面から開いた状態）で試し、結果をコピーして送ってください。ここで保存するデータは本番とは別の場所に入ります。</p>
    <div class="card stack"><b>容量</b><button class="btn sm" id="q">保存できる容量を調べる</button></div>
    <div class="card stack"><b>P1 大きな動画の保存・再生</b><span class="small">15分程度の動画を選ぶ（「ファイル」と「写真」の両方で試すと理想）</span>
      <label class="btn sm" for="p1f">動画を選んで保存テスト</label><input type="file" id="p1f" hidden>
      <button class="btn sm" id="p1r">保存済みを読み出して再生（アプリを閉じて開き直した後に）</button><button class="btn sm" id="p1d">テスト用データを削除</button></div>
    <div class="card stack"><b>P2 同じファイルの照合</b><span class="small">同じ動画をもう一度選び、P1 の指紋と比べる</span>
      <label class="btn sm" for="p2f">同じ動画を選ぶ</label><input type="file" id="p2f" hidden></div>
    <div class="card stack"><b>P3 区間再生の途切れ</b><span class="small">選んだ動画の3か所を続けて再生し、切り替えにかかる時間を測る（2本目を選ぶと別ファイルをまたぐ測定も）</span>
      <label class="btn sm" for="p3f">動画（1〜2本）を選ぶ</label><input type="file" id="p3f" multiple hidden>
      <video id="p3v" playsinline muted style="width:100%;max-height:160px;background:#000"></video><video id="p3v2" playsinline muted hidden></video></div>
    <div class="card stack"><b>P4 音声の展開（波形・無音検出用）</b><span class="small">5分・10分・15分の動画や音声で試す。落ちた場合は「落ちた」と伝えてください</span>
      <label class="btn sm" for="p4f">動画・音声を選ぶ</label><input type="file" id="p4f" hidden></div>
    <div class="card stack"><b>音声トラックの解析</b><span class="small">動画を選ぶと、音声トラックの数・形式を調べ、自動でどれを使うか判定し、取り出しと展開を試します（保存はしません）</span>
      <label class="btn sm" for="trf">動画を選ぶ</label><input type="file" id="trf" hidden></div>
    <div class="card stack"><b>保存した音声・動画の点検</b><span class="small">教材セットの音声・動画を1つずつ読み込んで1秒再生し、結果を下に書きます</span><button class="btn sm" id="chk">点検する</button></div>
    <div class="card stack"><b>結果</b><pre id="lo" class="st-log"></pre><button class="btn sm" id="cp">結果をコピー</button></div>`;
  $('#trf', el).onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    out(`トラック解析: ${f.name} ${fmtSize(f.size)} ${f.type}`);
    let t = performance.now(), info;
    try { info = await probe(f); } catch (e) { return out(`  解析で失敗：${e?.message || e}`); }
    out(`  解析 ${Math.round(performance.now() - t)}ms・形式 ${info.container}`);
    info.tracks.forEach((x) => out(`  ・${x.kind}｜${x.codec}｜${x.lang}｜${x.name || '名前なし'}｜${fmt(x.duration)}${x.kind === 'audio' ? `｜${x.rate}Hz ${x.channels}ch｜取り出し${canExtract(x) ? '可' : '不可'}` : ''}`));
    t = performance.now(); const r = await chooseTrack(f, info, decodeTo16k).catch((e) => ({ err: e }));
    if (r.err) return out(`  判定で失敗：${r.err.message}`);
    out(`  判定 ${Math.round(performance.now() - t)}ms：${r.chosen ? `音声${audioTracks(info).indexOf(r.chosen) + 1}` : 'なし'}・${r.auto ? '自動' : '利用者に確認'}（${r.reason}）`);
    r.stats.forEach((x, i) => out(`    音声${i + 1}: ${x.ok ? `話し声 ${Math.round(x.speech * 100)}%・音量 ${(20 * Math.log10(x.level || 1e-6)).toFixed(0)}dB` : x.why}`));
    if (r.chosen && canExtract(r.chosen)) {
      t = performance.now(); try { const x = await extractTrack(f, r.chosen); out(`  取り出し ${Math.round(performance.now() - t)}ms・${fmtSize(x.blob.size)}`); t = performance.now(); const d = await decodeTo16k(x.blob); out(`  展開 ${Math.round(performance.now() - t)}ms・${fmt(d.duration)} ✓（文字起こしに使えます）`);
        const a = new Audio(URL.createObjectURL(x.blob)); a.currentTime = Math.min(5, d.duration / 2); await a.play(); await new Promise((q) => setTimeout(q, 1200)); out(`  再生 ${a.currentTime > 0.3 ? '✓' : '進まない'}`); a.pause(); }
      catch (e) { out(`  取り出し／展開／再生で失敗：${e?.message || e}`); }
    }
  };
  $('#chk', el).onclick = async () => {
    out(`バージョン ${STUDIO_VERSION}・audioSession: ${navigator.audioSession?.type ?? 'なし'}`);
    if (errLog.length) out('最近のエラー:\n  ' + errLog.join('\n  '));
    if (crumbs.length) out('最近の処理の記録:\n  ' + crumbs.slice(-15).join('\n  '));
    const all = await sdb.all('sources');
    if (!all.length) return out('保存した音声・動画がありません');
    const v = $('#p3v', el); v.muted = false;
    for (const x of all) {
      const blob = x.stored ? x.blob : null;
      let line = `・${x.name}｜${x.kind}｜${x.mime || '?'}｜${x.codec || '元のまま'}｜${blob ? fmtSize(blob.size) : '保存なし'}｜長さ${fmt(x.duration)}`;
      if (!blob) { out(line); continue; }
      if (x.audio) line += `｜音声${(x.audio.index ?? 0) + 1}/${x.audio.count}（${x.audio.method}）`;
      if (x.audioError) line += `｜取り込み時の失敗：${x.audioError}`;
      try { await blob.slice(0, 16).arrayBuffer(); } catch (e) { out(line + `→ 保存データを読めません（${e.name}）`); continue; }
      const u = URL.createObjectURL(blob);
      const r = await new Promise((res) => { let done = false; const fin = (t) => { if (!done) { done = true; res(t); } };
        v.onloadedmetadata = () => fin(`読込OK 長さ${fmt(v.duration)}・音声トラック${v.audioTracks ? v.audioTracks.length : '?'}`); v.onerror = () => fin(`読込エラー コード${v.error?.code}`); setTimeout(() => fin('読込が終わらない'), 8000); v.src = u; });
      line += `→ ${r}`;
      if (r.startsWith('読込OK')) { try { v.currentTime = Math.min(5, (v.duration || 10) / 2); await v.play(); const t0 = v.currentTime; await new Promise((q) => setTimeout(q, 1200)); line += `・再生 ${v.currentTime > t0 + 0.3 ? 'OK' : '進まない'}`; v.pause(); } catch (e) { line += `・再生エラー ${e.name}`; } }
      URL.revokeObjectURL(u); out(line);
    }
  };
  const lab = (await import('./common-idb.js')).makeDB('ell-studio-lab', 1, { files: { keyPath: 'id' } });
  out(`端末: ${navigator.userAgent}`); out(`表示: ${matchMedia('(display-mode: standalone)').matches ? 'ホーム画面アプリ' : 'ブラウザ'}`);
  $('#q', el).onclick = async () => {
    const e = await navigator.storage?.estimate?.(); const p = await navigator.storage?.persisted?.(); const r = await navigator.storage?.persist?.().catch(() => null);
    out(`容量: 使用 ${fmtSize(e?.usage || 0)} / 上限の目安 ${e?.quota ? fmtSize(e.quota) : '不明'}・消されにくい保存: ${p ? '許可済み' : r ? '今許可された' : '未許可'}`);
  };
  $('#p1f', el).onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    out(`P1: ${f.name} ${fmtSize(f.size)} ${f.type}`);
    let t = performance.now(); const fp = await fingerprint(f); out(`  指紋 ${Math.round(performance.now() - t)}ms ${fp.id}`);
    t = performance.now(); const meta = await readDuration(f); out(`  長さ ${fmt(meta.duration)}・再生可能 ${meta.playable}（${Math.round(performance.now() - t)}ms）`);
    t = performance.now();
    try { await lab.put('files', { id: 'p1', name: f.name, blob: f, fp: fp.id, size: f.size }); out(`  端末に保存 ${((performance.now() - t) / 1000).toFixed(1)}秒 ✓`); }
    catch (e) { out(`  端末に保存 失敗：${e.name} ${(e?.message || String(e))}`); return; }
    await playTest('p1');
  };
  async function playTest(id) {
    const rec = await lab.get('files', id); if (!rec) return out('  保存済みデータがありません');
    const v = $('#p3v', el); const u = URL.createObjectURL(rec.blob); let t = performance.now();
    v.src = u; await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 10000); });
    out(`  読み出し→再生準備 ${Math.round(performance.now() - t)}ms・長さ ${fmt(v.duration)}`);
    t = performance.now(); v.currentTime = (v.duration || 10) * 0.8; await new Promise((r) => { v.onseeked = r; setTimeout(r, 8000); });
    out(`  80%地点へシーク ${Math.round(performance.now() - t)}ms`);
    try { await v.play(); await new Promise((r) => setTimeout(r, 800)); v.pause(); out('  再生 ✓'); } catch (e) { out(`  再生 失敗：${(e?.message || String(e))}`); }
  }
  $('#p1r', el).onclick = () => { out('P1(再起動後):'); playTest('p1'); };
  $('#p1d', el).onclick = async () => { await lab.del('files', 'p1'); out('テスト用データを削除しました'); };
  $('#p2f', el).onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    const fp = await fingerprint(f); const rec = await lab.get('files', 'p1');
    out(`P2: ${f.name} ${fmtSize(f.size)} 指紋 ${fp.id} → ${rec ? (rec.fp === fp.id ? '一致 ✓' : `不一致（P1: ${rec.fp}）`) : 'P1 が未実施'}`);
  };
  $('#p3f', el).onchange = async (ev) => {
    const fs = [...ev.target.files]; ev.target.value = ''; if (!fs.length) return;
    const v = $('#p3v', el); v.muted = true;
    const load = async (vv, f) => { vv.src = URL.createObjectURL(f); await new Promise((r) => { vv.onloadedmetadata = r; setTimeout(r, 8000); }); };
    await load(v, fs[0]);
    const D = v.duration || 60;
    const segs = [[D * 0.1, D * 0.1 + 1.5], [D * 0.5, D * 0.5 + 1.5], [D * 0.3, D * 0.3 + 1.5]];
    const gaps = [];
    for (const [a, b] of segs) { gaps.push(await jumpPlay(v, a)); await until(v, b); v.pause(); }
    out(`P3: 同じファイル内の区間切り替え ${gaps.join(' / ')} ms`);
    if (fs[1]) {
      const v2 = $('#p3v2', el); v2.muted = true; await load(v2, fs[1]);
      out(`P3: 別ファイル（先読み済み）への切り替え ${await jumpPlay(v2, 1)} ms`); v2.pause();
      const t1 = performance.now(); await load(v, fs[1]); const g = await jumpPlay(v, 1);
      out(`P3: 別ファイル（先読みなし）への切り替え ${Math.round(performance.now() - t1 - g) + g} ms`); v.pause();
    }
  };
  // time from "go to a" until the playhead actually moves (= the audible gap)
  async function jumpPlay(v, a) {
    const t0 = performance.now();
    v.currentTime = a; await new Promise((r) => { if (!v.seeking) return r(); v.onseeked = r; setTimeout(r, 4000); });
    v.play().catch(() => {});
    const start = v.currentTime;
    await new Promise((r) => { const iv = setInterval(() => { if (v.currentTime > start + 0.03) { clearInterval(iv); r(); } }, 10); setTimeout(() => { clearInterval(iv); r(); }, 4000); });
    return Math.round(performance.now() - t0);
  }
  function until(v, b) { return new Promise((r) => { const iv = setInterval(() => { if (v.currentTime >= b || v.paused) { clearInterval(iv); r(); } }, 20); setTimeout(() => { clearInterval(iv); r(); }, 4000); }); }
  $('#p4f', el).onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    out(`P4: ${f.name} ${fmtSize(f.size)}`);
    try {
      let t = performance.now(); const buf = await f.arrayBuffer(); out(`  読み込み ${Math.round(performance.now() - t)}ms`);
      const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
      t = performance.now();
      const audio = await new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
      out(`  展開 ${((performance.now() - t) / 1000).toFixed(1)}秒・${audio.numberOfChannels}ch ${audio.sampleRate}Hz ${fmt(audio.duration)}・展開後 約${fmtSize(audio.length * audio.numberOfChannels * 4)}`);
      ac.close?.();
      t = performance.now();
      const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
      const s = off.createBufferSource(); s.buffer = audio; s.connect(off.destination); s.start();
      const r = await off.startRendering();
      out(`  16kHzモノラルに変換 ${((performance.now() - t) / 1000).toFixed(1)}秒・約${fmtSize(r.length * 4)}`);
      // simple silence detection (20 ms frames)
      t = performance.now(); const d = r.getChannelData(0), F = 320; let sil = 0, runs = 0, inSil = false;
      const rms = []; for (let i = 0; i + F <= d.length; i += F) { let x = 0; for (let k = 0; k < F; k++) x += d[i + k] * d[i + k]; rms.push(Math.sqrt(x / F)); }
      const th = rms.slice().sort((a, b) => a - b)[Math.floor(rms.length * 0.2)] * 2.5 + 1e-4;
      for (const v of rms) { if (v < th) { sil++; if (sil === 30 && !inSil) { runs++; inSil = true; } } else { sil = 0; inSil = false; } }
      out(`  無音検出 ${Math.round(performance.now() - t)}ms・0.6秒以上の無音 ${runs}か所 ✓`);
    } catch (e) { out(`  失敗：${e.name} ${(e?.message || String(e))}`); }
  };
  // one test at a time (overlapping runs on the same video gave false time-outs)
  let busy = false;
  for (const x of $$('button, input[type=file]', el)) for (const k of ['onclick', 'onchange']) {
    const f = x[k]; if (!f || x.id === 'cp') continue;
    x[k] = async (ev) => { if (busy) { ev.preventDefault?.(); return toast('前のテストが終わるまで待ってください'); } busy = true; el.classList.add('st-busy'); try { await f(ev); } finally { busy = false; el.classList.remove('st-busy'); } };
  }
  $('#cp', el).onclick = async () => { try { await navigator.clipboard.writeText(log.join('\n')); toast('コピーしました'); } catch { toast('コピーできませんでした。長押しで選択してください'); } };
}
