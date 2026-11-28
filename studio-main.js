import { showUpdate, releaseLabel } from './update-manager.js';
import { ensurePackFolder, studioFolders, folderMembers, createStudioFolder, renameStudioFolder, moveStudioSets, saveStudioFolderOrder, getFolderJa, saveFolderJa } from './studio-folders.js';
import { studioConfirmed } from './audio-refs.js';
import { readStudioJaFiles, readStudioJaText, planStudioJa, studioJaView, confirmStudioJa, studioJaChoices, findStudioJaChoices, studioJaRows, studioJaEditBlocks } from './studio-ja.js';
import { openJaPositionEditor } from './ja-position-ui.js';
// 教材スタジオ（制作）: standalone page studio.html now; later mounted inside Englabo with mount(el, { base: 'studio/' }).
// Rules: does not import learning modules and never touches the learning database (ell-db).
import { $, $$, esc, toast, confirmDialog, swipeToDelete } from './ui.js';
import { sdb, newId, commit, undo, redo, saveVersion, restoreVersion, liveBlocks, allBlocksMap, sourcesMap, newBlock, tokensOf, blockDur, linkToLab } from './studio-db.js';
import { parseScript, withoutPlainScriptHeaders, SUB_EXT, isJa, langFromName, autoPair, alignJa } from './studio-subs.js';
import * as ops from './studio-ops.js';
import { fingerprint, zipRead } from './common-pack.js';
import { materialPackEntries, packMedia, readMaterialPack, writeMaterialCollection, writeMaterialPack } from './material-pack.js';
import { decodeTo16k, openTranscriber, speechPieces, captureTo16k, QUALITY, recognisePiece } from './asr.js';
import { extractPhrases, extractWords } from './studio-words.js';
import { findCandidates, applySpans } from './studio-names.js';
import { alignScript, scriptToLines, hasReplacementAudio } from './studio-align.js';
import { speechRegions, regionStatistics, snapCueToRegion } from './studio-structure.js';
import { alignByStructure, parseUnits, planMissing } from './kinfure-structure-align.js';
import { loadKfScript, tagsFor } from './studio-kinfure.js';
import { parseKinfureScript, locateByEdges } from './studio-kinfure-range.js';
import { joinShortGaps } from './vocab-audio-core.js';
import { speechFirstPlaybackRange, nextSourceSegment } from './studio-playback-boundary.js';
import { planVocabAlignment, isVocabTarget, unassignedVocabRanges, vocabKey, isVocabHead } from './studio-vocab-align.js';
import { maSeams, maWindow, inspectMaSeam, proposeMaSeam, maBoundaryUpdates, wavRangeReader } from './studio-ma-boundary.js';
import { createRescueSearch, sameRescueVersion, rescuePreviewRange, manualRescuePair } from './studio-prose-rescue.js';
import { isSymbolRow, needsWork, wordCount, planBulkGaps, rangePieces, keepInPiece, withoutTaken, adjacentWithSound } from './studio-ma-tools.js';
import { alignUtterances } from './studio-import-align.js';
import { probe, audioTracks, canExtract, extractTrack, extractPresentationRange, chooseTrack, mp4Audio } from './media-probe.js';
import { frameRms, frameZcr, edgeCut, isScreenRec, defaultCut } from './media-audio.js';
import { kfRegisterScript, kfLocateFlow } from './studio-kinfure-ui.js';
import { TIERS, bytesPerMin, compressAudio, estimate, cutAac } from './compress.js';

export const STUDIO_VERSION = '0.21.37';
const STUDIO_UPDATED_JST = '2026-11-24 JST';
const LIMIT = { video: 45 * 60, audio: 100 * 60 };   // one import: video up to 45 min, audio up to 100 min in total (user decisions; 1.16: 75 → 100)
let ROOT = null, BASE = '', HOST = null;   // HOST: set when the studio runs inside English Labo
const sessionFiles = new Map();   // sourceId -> File (for "保存しない" media; lives only while the page is open)
const urlCache = new Map();
const nav = (path) => { location.hash = '#' + BASE + path; };
const formatClock = (seconds, digits) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const scale = 10 ** digits, ticks = Math.round(seconds * scale);
  return `${Math.floor(ticks / (60 * scale))}:${((ticks % (60 * scale)) / scale).toFixed(digits).padStart(3 + digits, '0')}`;
};
const fmt = seconds => formatClock(seconds, 1);
const rescueClockValue = seconds => formatClock(seconds, 3);
const parseClock = (v) => {
  const raw = String(v).trim().replace(/[：]/g, ':').replace(/[，、]/g, ',').replace(/,/g, '.');
  const m = raw.match(/^(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/);
  if (!m || (m[1] != null && Number(m[2]) >= 60)) return NaN;
  return Number(m[1] || 0) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));
};
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
let cleanup = null, routeRevision = 0;
export function unmount() { ++routeRevision; cleanup?.(); cleanup = null; }
async function route() {
  unmount();
  if (!inStudio()) return;
  const revision = routeRevision;
  const { path, params } = parseHash();
  const screens = { sets: setsScreen, 'folder-ja': folderJaScreen, import: importScreen, set: editorScreen, versions: versionsScreen, io: ioScreen, words: wordsScreen, clean: cleanScreen };
  try { await (screens[path] || setsScreen)(ROOT, params, revision); }
  catch (e) { if (revision !== routeRevision) return; console.error(e); ROOT.innerHTML = `<div class="card warn">エラー：${esc((e?.message || String(e)))}</div><a class="btn" href="#${BASE}sets">一覧に戻る</a>`; }
  if (revision === routeRevision) scrollTo(0, 0);
  // which build is really serving this screen (same text in the standalone Studio and inside Englabo)
  releaseLabel().then((text) => { if (revision === routeRevision) for (const n of ROOT.querySelectorAll('.st-relinfo')) n.textContent = text; }).catch(() => {});
}
const head = (title, backPath = null, right = '') => `
  <div class="st-band">制作・教材スタジオ <small>v${STUDIO_VERSION} · 更新 ${STUDIO_UPDATED_JST} · <span class="st-relinfo"></span></small></div>
  <header class="top">${backPath != null ? `<a class="back" href="${backPath === '__exit' ? HOST?.exitHref || '#home' : `#${BASE}${backPath}`}" aria-label="戻る">${icon('back')}</a>` : ''}<h1 title="${esc(title)}">${esc(title)}</h1><span class="grow"></span>${right}</header>`;

// 1.17.2: forget what was worked out from a source's OLD file (playback URL, track table) once its file is replaced
// (compressed, cut, made into sound only). Before this, the editor could keep playing / reading the original camera-roll file:
// "再生できません（コード4）", transcription "再生もできません", the start not cut — until the app was reopened.
function forgetSource(id) { const u = urlCache.get(id); if (u) { try { URL.revokeObjectURL(u); } catch {} } urlCache.delete(id); probeCache.delete(id); }
const studioSourceFile = source => source && (source.blob?.size > 0 ? source.blob : sessionFiles.get(source.id));
function mediaURL(src) {
  if (!src) return null;
  if (urlCache.has(src.id)) return urlCache.get(src.id);
  const blob = studioSourceFile(src);
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
const folderPath = folder => 'sets?folder=' + encodeURIComponent(folder.id);
const folderJaPath = folder => 'folder-ja?folder=' + encodeURIComponent(folder.id);
async function importDestination(params) {
  const id = params?.get('folder');
  if (!id) return null;
  const folder = (await studioFolders([])).find(folder => folder.id === id);
  if (!folder) throw Error('取り込み先のフォルダが見つかりません');
  return folder;
}

async function folderJaScreen(el, params, revision) {
  const folder = await importDestination(params);
  if (!folder) { nav('sets'); return; }
  const saved = await getFolderJa(folder.id);
  if (revision !== routeRevision) return;
  el.innerHTML = `${head('英日データを取り込む', folderPath(folder))}
    <section class="card stack">
      <strong>📁 ${esc(folder.name)}</strong>
      <p class="small" id="folderJaSaved">登録済み ${saved?.sections.length || 0}件</p>
      <label class="field">ZIPまたはJSONファイル（複数選択可・1つのJSONに複数章も可）
        <input type="file" id="folderJaFiles" accept=".json,.zip,application/json,application/zip" multiple>
      </label>
      <details><summary class="small">JSONを貼り付けて追加</summary>
        <textarea id="folderJaText" rows="6" placeholder='{"chapter": 3, "items": [{"en": "…", "ja": "…"}]}' autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        <button type="button" class="btn sm" id="folderJaRead">貼り付けたJSONを読み込む</button>
      </details>
      <p class="small" id="folderJaStatus" role="status"></p>
      <div class="row wrap">
        <button type="button" class="btn primary" id="folderJaSave" disabled>フォルダに登録</button>
        <button type="button" class="btn" id="folderJaReplace" hidden disabled>登録データを入れ替える</button>
        <button type="button" class="btn" id="folderJaApply" ${saved?.sections.length ? '' : 'hidden'}>登録済みのデータをフォルダの教材に反映</button>
      </div>
    </section>`;
  const input = $('#folderJaFiles', el), status = $('#folderJaStatus', el);
  const save = $('#folderJaSave', el), replace = $('#folderJaReplace', el);
  let sections = [], count = saved?.sections.length || 0;
  const setButtons = (busy = false) => {
    input.disabled = busy;
    save.disabled = replace.disabled = busy || !sections.length;
    save.textContent = count ? '追加・同名ファイルを更新' : 'フォルダに登録';
    replace.hidden = !count;
  };
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('warn-text', error);
  };
  setButtons();
  $('#folderJaRead', el).onclick = async () => {
    setButtons(true);
    try {
      sections = await readStudioJaText($('#folderJaText', el).value);
      setStatus(`貼り付けたJSON：取り込み可能な英日データ ${sections.length}件`);
    } catch (error) { sections = []; setStatus(error.message, true); }
    finally { setButtons(); }
  };
  // 1.19.31: register, then apply to the folder's materials right away (single or all; how = missing / re-match / overwrite)
  const applyToFolder = async () => {
    const corpus = await getFolderJa(folder.id);
    if (!corpus?.sections.length || revision !== routeRevision) return;
    const ids = (await sdb.all('sets')).filter(set => set.folder === folder.name).map(set => set.id);
    if (!ids.length) return setStatus('このフォルダにはまだ教材がありません');
    await applyStudioJa(ids, corpus.sections, null);
  };
  $('#folderJaApply', el).onclick = applyToFolder;
  input.onchange = async () => {
    sections = [];
    const files = Array.from(input.files);
    if (!files.length) { setButtons(); return; }
    setButtons(true);
    setStatus('英日データを読み込み中…');
    try {
      sections = await readStudioJaFiles(files);
      setStatus(`選択 ${files.length}ファイル・取り込み可能な英日データ ${sections.length}件`);
    } catch (error) {
      setStatus(error.message, true);
    } finally { input.value = ''; setButtons(); }
  };
  const register = async append => {
    if (!sections.length || revision !== routeRevision) return;
    setButtons(true);
    try {
      if (!append && !(await confirmDialog({
        title: '登録データを入れ替える',
        body: '<p>このフォルダの共有英日データを、今回選んだファイルに入れ替えます。</p>',
        okLabel: '入れ替える',
      }))) return;
      if (revision !== routeRevision) return;
      count = await saveFolderJa(folder.id, sections, append);
      sections = [];
      $('#folderJaSaved', el).textContent = `登録済み ${count}件`;
      $('#folderJaText', el).value = '';
      $('#folderJaApply', el).hidden = false;
      setStatus(`フォルダに保存しました（同じ名前・同じ章のデータは更新）。`);
      if (revision === routeRevision && await confirmDialog({ title: 'フォルダの教材に反映', body: '<p>登録したデータを、このフォルダの教材の日本語訳に反映しますか？（反映のしかたを次に選びます。英日対応済みの訳を置き換える「上書き」も選べます）</p>', okLabel: '反映へ進む', cancelLabel: 'あとで' })) await applyToFolder();
    } catch (error) {
      setStatus(`フォルダに保存できませんでした（${error.message || error.name}）`, true);
    } finally { setButtons(); }
  };
  save.onclick = () => register(true);
  replace.onclick = () => register(false);
}
async function setsScreen(el, params, revision) {
  const allSets = (await sdb.all('sets')).sort((a, b) => b.updatedAt - a.updatedAt);
  const registry = await studioFolders(allSets);
  const sortFolders = () => registry.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  sortFolders();
  const current = registry.find(folder => folder.id === params?.get('folder'));
  const sets = current ? folderMembers(allSets, current) : allSets;
  const srcs = await sourcesMap();
  // オリジナル / カット済み label: from the first and last items that have sound
  const cutInfo = {}, stInfo = {}, jaInfo = new Map();
  for (const st of sets) {
    const all = await liveBlocks(st);
    const { total, applied } = studioJaView(all).summary;
    jaInfo.set(st.id, total > 0 && total === applied);
    // 1.17.10: how far the set has got: transcription / matching to the script / left over
    { const scr = all.filter((b) => b.script || b.aligned), al = scr.filter((b) => b.aligned).length;
      const raw = all.filter((b) => b.segments.length && !b.text.trim() && !/文字にできなかった/.test(b.label || '')).length;
      const rest = all.filter((b) => !b.aligned && b.segments.length && (b.asr || /文字にできなかった/.test(b.label || ''))).length;
      const t = [];
      if (scr.length) t.push(al === scr.length ? '<span class="tagp ok">照合済</span>' : al ? `<span class="tagp warn">照合 ${al}/${scr.length}</span>` : '<span class="tagp">未照合</span>');
      if (raw) t.push('<span class="tagp">未起こし</span>'); else if (all.some((b) => b.asr || b.aligned)) t.push('<span class="tagp ok">起こし済</span>');
      if (!scr.length && !all.some((b) => b.asr) && all.some((b) => b.segments.length && b.text.trim())) t.push('<span class="tagp ok">字幕</span>');
      stInfo[st.id] = t.join(''); }
    const bl = all.filter((b) => b.segments.length); if (!bl.length) continue;
    const f = bl[0].segments[0], l = bl[bl.length - 1].segments.at(-1), src = srcs[f.sourceId];
    if (src?.trimmed) cutInfo[st.id] = `<span class="tagp">カット</span>`;
    else if (src && (f.start > 0.05 || (src.duration && l.end < src.duration - 0.05))) cutInfo[st.id] = `<span class="tagp">カット</span>`;
    else cutInfo[st.id] = '';
  }
  const lab = HOST?.studioLabState ? await HOST.studioLabState() : null;
  const est = !current && await navigator.storage?.estimate?.().catch(() => null);
  if (revision !== routeRevision) return;
  let editing = false, folderMenuOpen = false; const chosen = new Set();
  // 1.19.28: short: number of materials and how many are published (+ translated); details are in the folder / ⋯
  const progress = (members, short = false) => {
    const ready = members.filter(set => jaInfo.get(set.id)).length;
    const made = members.filter(set => lab?.has(set.id)).length;
    if (short) return `${members.length}教材${lab ? ` · 教材化 ${made}/${members.length}` : ''} · 訳 ${ready}/${members.length}`;
    return `${members.length}教材 · 訳済 ${ready} · 未反映／要確認 ${members.length-ready}${lab ? ` · 教材化済 ${made} · 未教材化 ${members.length-made}` : ''}`;
  };
  const draw = () => {
    const suffix = current ? '?folder=' + encodeURIComponent(current.id) : '';
    const access = `<a class="btn primary" href="#${BASE}import${suffix}">＋ 動画・音声・字幕</a>${current ? '' : `<a class="btn" href="#${BASE}io${suffix}">教材パック</a>`}`;
    el.innerHTML = `${head(current ? current.name : '教材スタジオ', current ? 'sets' : HOST ? '__exit' : null,
      current ? '<button class="icon-btn" id="folderMenu" aria-label="フォルダのメニュー">⋯</button>' :
        '<button class="btn sm" id="upd">更新を確認</button><a class="btn sm" href="#' + BASE + 'clean">容量</a>')}
    <div class="st-home-actions">${access}${current ? '' : '<button class="btn" id="newFolder">＋ フォルダ</button>'}</div>
    ${current ? `<p class="small muted">${progress(sets, true)}　<span class="muted">（教材パック・英日データ・一括教材化は右上の ⋯）</span></p>` : ''}
    ${est ? `<p class="small muted">端末の保存量：${fmtSize(est.usage || 0)}${est.quota ? ` / 目安の上限 ${fmtSize(est.quota)}` : ''}</p>` : ''}
    ${sets.length ? `<div class="row end"><button class="btn sm" id="edit">${editing ? '完了' : '教材を選ぶ'}</button></div>` : ''}
    ${editing ? `<div class="row wrap"><button class="btn sm" id="eAll">すべて選ぶ</button><button class="btn sm" id="eNone">解除</button>
      <button class="btn sm" id="eFold" ${chosen.size ? '' : 'disabled'}>フォルダへ移動</button><button class="btn sm" id="eRen" ${chosen.size === 1 ? '' : 'disabled'}>名前を変える</button>
      <button class="btn sm danger" id="eDel" ${chosen.size ? '' : 'disabled'}>削除（${chosen.size}）</button></div>
      <div class="row wrap"><button class="btn sm" id="stBatchJa" ${chosen.size ? '' : 'disabled'}>英日データを一括反映</button>
      ${HOST?.sendToLab ? `<button class="btn sm primary" id="stBatchLab" ${chosen.size ? '' : 'disabled'}>一括教材化</button>` : ''}</div>` : ''}
    ${current ? `${sets.length ? `<div class="card list">${sets.map(rowHTML).join('')}</div>` : '<p class="empty">このフォルダにはまだ教材がありません。</p>'}` :
      registry.map(folder => {
        const members = folderMembers(sets, folder);
        if (!editing) return `<div class="card st-folderrow" data-folder-row="${esc(folder.id)}">
          <a class="grow st-folderlink" href="#${BASE}${folderPath(folder)}"><b>📁 ${esc(folder.name)}</b><small class="muted">${progress(members, true)}</small></a>
          <button type="button" class="icon-btn st-foldermenu" aria-label="${esc(folder.name)}のメニュー" aria-haspopup="dialog">⋯</button>
        </div>`;
        return members.length ? `<div class="card list"><b>📁 ${esc(folder.name)}</b>${members.map(rowHTML).join('')}</div>` : '';
      }).join('') + (!sets.some(s => !s.folder) ? '' : `<div class="card list">${sets.filter(s => !s.folder).map(rowHTML).join('')}</div>`)}
    ${!current && !sets.length && !registry.length ? '<p class="empty">まだ教材がありません。</p>' : ''}`;
    $('#eFold', el)?.addEventListener('click', () => toFolder(sets.filter(x => chosen.has(x.id))));
    $('#folderMenu', el)?.addEventListener('click', () => showFolderMenu(current));
    $$('[data-folder-row]', el).forEach(row => {
      const folder = registry.find(entry => entry.id === row.dataset.folderRow);
      const link = $('.st-folderlink', row);
      $('.st-foldermenu', row).onclick = () => showFolderMenu(folder, true);
      let timer, start, held = false;
      const stop = () => { clearTimeout(timer); start = null; };
      link.onpointerdown = event => {
        if (!event.isPrimary || event.button !== 0) return;
        stop();
        held = false;
        start = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => { held = true; showFolderMenu(folder, true); }, 550);
      };
      link.onpointermove = event => {
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) stop();
      };
      link.onpointerup = link.onpointercancel = link.onpointerleave = stop;
      link.oncontextmenu = event => {
        event.preventDefault();
        stop();
        held = true;
        showFolderMenu(folder, true);
      };
      link.onclick = event => { if (held && event.detail !== 0) { event.preventDefault(); held = false; } };
    });
    $('#newFolder', el)?.addEventListener('click', async () => {
      const name = (await askText('フォルダを作成', ''))?.trim();
      if (name && revision === routeRevision) nav(folderPath(await createStudioFolder(name)));
    });
    bind();
  };
  const rowHTML = (s) => {
      const src = srcs[s.sourceId];
      // 1.18.1: compact — the full title (wraps only when it must), then one line of short marks
      const info = `<span class="grow st-sinfo"><b class="st-stitle">${esc(s.title)}</b><span class="st-smeta">${src ? `${src.kind === 'audio' ? '🎧' : '🎬'}${fmt(src.duration).replace(/\.\d$/, '')}` : '音声なし'}・${s.order.length}行${cutInfo[s.id] || ''}${stInfo[s.id] || ''}${s.importing ? `<span class="tagp warn">途中 ${s.importing.done}/${s.importing.total}</span>` : ''}</span><small class="muted" hidden>${new Date(s.updatedAt).toLocaleString('ja-JP')}</small></span>`;
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
    const mine = await liveBlocks(P);
    const copies = kids.flatMap((k) => k.bl.filter((b) => notCopiedYet(mine, b)).map((b) => { const { id, rev, setId, deleted, ...rest } = b; return newBlock(P.id, { ...structuredClone(rest), lineage: { op: 'copy', from: [`${b.id}@${b.rev}`], at: Date.now() } }); }));
    await commit(P, `📁${f} の音声をまとめる`, { blocks: copies, order: [...P.order, ...copies.map((c) => c.id)] });
    if (del) for (const k of kids) await deleteSet(await sdb.get('sets', k.s.id));
    nav(`set?id=${P.id}&align=1`);
  }
  async function showFolderMenu(folder, overview = false) {
    if (!folder || folderMenuOpen || revision !== routeRevision) return;
    folderMenuOpen = true;
    try { await openFolderMenu(folder, overview); }
    catch (error) { toast(error.message, 5500); }
    finally { folderMenuOpen = false; }
  }
  async function openFolderMenu(folder, overview) {
    const members = overview ? folderMembers(allSets, folder) : sets;
    // the home list opens its menu at once; the registered data is read when an English–Japanese action is chosen
    let corpus = overview ? null : await getFolderJa(folder.id);
    if (revision !== routeRevision) return;
    // 1.19.35: ZIP export is a Studio feature, offered from BOTH launch paths. Only "register in the Lab" needs the host.
    const publish = [...(HOST?.sendToLab ? [['lab','一括教材化（新しい教材だけ追加）'],['labUpdate','登録済みも更新して教材化']] : []),
      ['folderPack', HOST?.sendToLab ? 'ZIPで書き出す（一括教材パック）' : '一括教材化（ZIPで書き出す）']];
    const vocabAction = members.length ? [['vocabAudio','音声付き単語帳を作成（フォルダ全体）']] : [];   // 1.19.42
    const jaActions = [['register','英日対応データを登録・追加・更新（JSON/ZIP）'],
      ...((overview || corpus?.sections.length) && members.length ? [['apply','日本語訳を一括反映（未割当・再照合・上書き）']] : [])];
    const actions = overview ? [
      ...(members.length ? publish : []),
      ['open','フォルダを開く'],
      ...vocabAction,
      ...jaActions,
      ['rename','フォルダ名を変更'],
    ] : [
      ...(members.length ? publish : []),
      ['io','教材パック（読み込み・書き出し）'],
      ...vocabAction,
      ...jaActions,
      ['kfScript','金フレ全体スクリプトを登録・差し替え'],
      ...(members.length ? [['kfLocate','金フレ範囲を自動特定（フォルダ内すべて）']] : []),
      ...(corpus?.sections.length && members.length ? [['missing','未割当の訳だけ照合']] : []),
      ...(members.length ? [['review','照合結果を確認']] : []),
      ['rename','フォルダ名を変更'], ...(members.length > 1 ? [['sort','教材を並べ替え'],['merge','このフォルダの音声をまとめて照合']] : []),
    ];
    const summary = overview ? progress(members) : `${progress(members)}<br>英日対応データ ${corpus?.sections.length || 0}ファイル`;
    const action = await studioDialog(folder.name, `<p class="small muted">${summary}</p>`, [...actions, ['close','閉じる']]);
    if (revision !== routeRevision) return;
    const ids = members.map(set => set.id);
    if (action === 'vocabAudio') {
      const wizard = await import('./vocab-audio-wizard.js');
      return wizard.openVocabAudioWizard({ targets: members.map(set => ({ kind: 'studio', id: set.id, title: set.title })), folder: true });
    }
    if (action === 'open') return nav(folderPath(folder));
    if (action === 'io') return nav('io?folder=' + encodeURIComponent(folder.id));
    if (action === 'kfScript') {
      await kfRegisterScript({ folderId: folder.id, folderName: folder.name });
    } else if (action === 'kfLocate') {
      await kfLocateFlow({ edgeCues: (target) => transcribeEdges(target), folderId: folder.id, folderName: folder.name, members, onDone: () => revision === routeRevision && route() });
    } else if (action === 'register') {
      nav(folderJaPath(folder));
    } else if (action === 'apply' || action === 'missing') {
      corpus ||= await getFolderJa(folder.id);
      if (!corpus?.sections.length) { toast('このフォルダには英日対応データがまだありません。登録画面を開きます', 3500); return nav(folderJaPath(folder)); }
      await applyStudioJa(ids, corpus.sections, overview ? null : refreshFolderProgress, { missingOnly: action === 'missing' });
      if (overview && revision === routeRevision) route();
    } else if (action === 'review') {
      await reviewFolderJa();
    } else if (action === 'folderPack') {
      const choice = await studioDialog('一括教材化（ZIP）', `<p>「${esc(folder.name)}」の ${members.length}件を1つのZIPに書き出します。</p>${contentsHTML()}`, [['start','書き出す'],['cancel','閉じる']]);
      if (choice !== 'start' || revision !== routeRevision) return;
      await exportFolderPack(folder, members, readContents());
    } else if (action === 'lab' || action === 'labUpdate') {
      // 1.19.28: 一括教材化 again after adding materials = only the new ones are added; the registered ones keep their
      // subtitles and learning records (only the folder tag and order are refreshed)
      const actualLab = HOST.studioLabState ? await HOST.studioLabState() : lab;
      const fresh = ids.filter(id => !actualLab?.has(id)), known = ids.length - fresh.length;
      const update = action === 'labUpdate', chosenIds = update ? ids : fresh;
      const proceed = await studioDialog(update ? '登録済みも更新して教材化' : '一括教材化', `<p>「${esc(folder.name)}」：<b>新しく追加 ${fresh.length}件</b>${known ? `・登録済み ${known}件（${update ? '字幕・音声を更新' : 'そのまま。フォルダと順番だけ反映'}）` : ''}</p>${chosenIds.length ? contentsHTML() : ''}`,
        chosenIds.length ? [['start','実行する'],['cancel','閉じる']] : [['start','フォルダと順番だけ反映'],['cancel','閉じる']]);
      if (proceed !== 'start' || revision !== routeRevision) return;
      const contents = chosenIds.length ? readContents() : contentsPref();
      await HOST.syncStudioLabFolder?.(folder.name, ids);
      if (revision !== routeRevision) return;
      if (chosenIds.length) await batchSendToLab(chosenIds, true, update, contents);
      else toast('新しい教材はありません（フォルダと順番を反映しました）');
      if (revision === routeRevision) route();
    } else if (action === 'rename') {
      const name = (await askText('フォルダの名前を変更', folder.name))?.trim();
      if (!name || name === folder.name || revision !== routeRevision) return;
      await renameStudioFolder(folder.id, name);
      if (revision !== routeRevision) return;
      for (const member of members) member.folder = name;
      folder.name = name;
      sortFolders();
      draw();
    } else if (action === 'sort') {
      await sortFolder(folder);
    } else if (action === 'merge') {
      await mergeFolder(folder.name);
    }
  }
  async function refreshFolderProgress() {
    for (const set of sets) {
      const fresh = await sdb.get('sets', set.id);
      if (!fresh) continue;
      const { total, applied } = studioJaView(await liveBlocks(fresh)).summary;
      jaInfo.set(set.id, total > 0 && total === applied);
    }
    if (revision === routeRevision) draw();
  }
  async function reviewFolderJa() {
    const report = [];
    for (const set of sets) {
      const fresh = await sdb.get('sets', set.id);
      if (fresh) report.push({ set: fresh, counts: jaCounts(studioJaView(await liveBlocks(fresh)).summary) });
    }
    if (revision !== routeRevision) return;
    const action = await studioDialog('フォルダの照合結果', `<div class="stack" style="max-height:55dvh;overflow:auto">${report.map(({set,counts}, i) =>
      `<button class="btn sm" value="result${i}">${esc(set.title)}<br>${counts}</button>`).join('')}</div>`, [['close','閉じる']]);
    if (/^result\d+$/.test(action)) {
      const { set } = report[Number(action.slice(6))];
      await showStudioJaReview(set, studioJaView(await liveBlocks(set)).summary);
    }
  }
  async function sortFolder(folder) {
    const ordered = [...sets], result = studioDialog('教材を並べ替え', '<div id="folderOrder" class="stack" style="max-height:55dvh;overflow:auto"></div>',
      [['save','順序を保存'],['cancel','閉じる']]);
    const list = $('#folderOrder');
    const render = () => {
      list.innerHTML = ordered.map((set, i) => `<div class="row"><span class="grow">${esc(set.title)}</span>
        <button type="button" class="btn sm" data-up="${i}" aria-label="${esc(set.title)}を上へ" ${i ? '' : 'disabled'}>↑</button>
        <button type="button" class="btn sm" data-down="${i}" aria-label="${esc(set.title)}を下へ" ${i < ordered.length-1 ? '' : 'disabled'}>↓</button></div>`).join('');
    };
    list.onclick = event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      const index = Number(button.dataset.up ?? button.dataset.down), other = index + (button.dataset.up != null ? -1 : 1);
      [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
      render();
    };
    render();
    if (await result === 'save' && revision === routeRevision) {
      await saveStudioFolderOrder(folder.id, ordered.map(set => set.id));
      route();
    }
  }
  async function toFolder(list) {
    const result = studioDialog(`${list.length}教材を移動`,
      `<label class="field">移動先<select id="fdDest"><option value="">フォルダを選ぶ</option>${registry.map(folder => `<option value="${folder.id}">${esc(folder.name)}</option>`).join('')}</select></label>
       <label class="field">または新しいフォルダ<input id="fdNew" autocomplete="off"></label>`,
      [['ok','移動する'],['out','フォルダから出す'],['cancel','閉じる']]);
    const action = await result;
    if (revision !== routeRevision || (action !== 'ok' && action !== 'out')) return;
    const name = $('#fdNew').value.trim();
    const target = action === 'out' ? null : name ? (await createStudioFolder(name)).id : $('#fdDest').value;
    if (action === 'ok' && !target) return toast('移動先を選んでください');
    await moveStudioSets(list.map(set => set.id), target);
    toast(action === 'out' ? 'フォルダから出しました' : '教材を移動しました');
    route();
  }
  const bind = () => {
    $('#upd', el)?.addEventListener('click', checkUpdate);
    const selectedIds = () => sets.filter(set => chosen.has(set.id)).map(set => set.id);
    $('#stBatchJa', el)?.addEventListener('click', () => pickStudioJa(selectedIds(), current ? refreshFolderProgress : undefined));
    $('#stBatchLab', el)?.addEventListener('click', async () => {
      await batchSendToLab(selectedIds());
      if (revision === routeRevision) route();
    });
    if (!editing) swipeToDelete($$('a.st-setrow', el), async (row) => {
      const x = sets.find((s) => row.getAttribute('href').endsWith(s.id)); if (!x) return false;
      if (!(await confirmDialog({ title: '教材を削除', body: `<p>${esc(x.title)}</p><p class="hint">字幕・編集・版も削除します（元に戻せません）。</p>`, okLabel: '削除', danger: true }))) return false;
      await deleteSet(x); toast('削除しました'); route(); return true;
    });
    $('#edit', el)?.addEventListener('click', () => { editing = !editing; chosen.clear(); draw(); });
    $('#eAll', el)?.addEventListener('click', () => { sets.forEach((x) => chosen.add(x.id)); draw(); });
    $('#eNone', el)?.addEventListener('click', () => { chosen.clear(); draw(); });
    // 1.18.3: rename from the list (選ぶ → one set → 名前を変える, or press and hold a row)
    const rename = async (x) => {
      const t = (await askText('名前を変える', x.title))?.trim();
      if (!t || t === x.title || revision !== routeRevision) return;
      const latest = await sdb.get('sets', x.id);
      if (!latest) return;
      await sdb.put('sets', { ...latest, title: t, updatedAt: Date.now() });
      x.title = t; toast('名前を変えました'); draw();
    };
    $('#eRen', el)?.addEventListener('click', () => { const x = sets.find((s) => chosen.has(s.id)); if (x) rename(x); });
    if (!editing) $$('a.st-setrow', el).forEach((a) => {
      let t = 0, held = false;
      a.addEventListener('touchstart', () => { held = false; clearTimeout(t); t = setTimeout(() => { held = true; const x = sets.find((s) => a.getAttribute('href').endsWith(s.id)); if (x) rename(x); }, 600); }, { passive: true });
      ['touchmove', 'touchend', 'touchcancel'].forEach((ev) => a.addEventListener(ev, () => clearTimeout(t), { passive: true }));
      a.addEventListener('click', (e) => { if (held) { e.preventDefault(); e.stopPropagation(); held = false; } }, true);
      a.addEventListener('contextmenu', (e) => e.preventDefault());
    });
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
async function checkUpdate() { await showUpdate(); }

// how a source is kept (for lists)
function srcState(src) {
  if (src.labRef) return 'ラボの音声を使用（重複なし）';
  if (!src.stored) return '保存しない';
  const sz = fmtSize(src.blob?.size || src.size || 0);
  if (src.derived === 'aac') return `圧縮済み（${TIERS[src.tier]?.label || 'AAC'}・${sz}）`;
  if (src.derived === 'audio16k') return `節約保存（${src.codec === 'wav' ? '非圧縮' : '圧縮'}・${sz}）`;
  return `端末に保存（${sz}）`;
}

// 音声1本を、必要な範囲だけ読む（AACは区間抽出、小さな音声は全体を1回だけ）。全体をPCMに展開しない。
async function sourceAudioReader(chosen, say) {
  const blob = chosen.stored ? chosen.blob : sessionFiles.get(chosen.id);
  const container = isContainer(chosen, blob) && chosen.derived !== 'audio16k';
  if (container && !chosen.audio) { chosen.audio = await decideTrack(chosen, blob); await sdb.put('sources', chosen); }
  const info = container ? await probeSource(chosen, blob).catch(() => null) : null;
  const tracks = info ? audioTracks(info) : [];
  const track = tracks.find(t => t.id === chosen.audio?.trackId) || tracks[chosen.audio?.index ?? 0];
  const ranged = Boolean(track && canExtract(track));
  let whole = null;
  if (!ranged) {
    if (!(chosen.duration > 0 && chosen.duration <= 180 && blob.size <= 18 * 1024 * 1024)) throw new Error('長い音声は、区間抽出に対応したAACのM4AまたはMP4にしてください');
    whole = (await sourceAudio16k(chosen, blob, { say })).audio; highPass(whole);
  }
  const end = track?.duration || chosen.duration || (whole?.length || 0) / 16000;
  // read(a, b) → { audio, offset }: audio は offset 秒から始まる16kHzのPCM
  const read = async (a, b) => {
    if (!ranged) return { audio: whole, offset: 0 };
    const extracted = await extractTrack(blob, track, Math.max(0, a), Math.min(end, b));
    const audio = (await decodeTo16k(extracted.blob)).audio; highPass(audio);
    return { audio, offset: extracted.start };
  };
  return { end, read };
}

// 音声の先頭と末尾だけを文字起こしする（全体スクリプトの中の範囲を推定するため）。結果は教材ごとに保存し、同じ音声なら再実行しない。
async function transcribeEdges(set, { seconds = 30, say = () => {}, cancelled = () => false } = {}) {
  const blocks = (await sdb.byIndex('blocks', 'setId', set.id)).filter(b => !b.deleted);
  const byId = new Map(blocks.map(b => [b.id, b]));
  const ids = [];
  for (const id of set.order) { const b = byId.get(id); for (const g of b?.segments || []) if (!ids.includes(g.sourceId)) ids.push(g.sourceId); }
  if (set.sourceId && !ids.includes(set.sourceId)) ids.unshift(set.sourceId);
  const sources = [];
  for (const id of ids) { const src = await sdb.get('sources', id); if (src && (src.stored ? src.blob : sessionFiles.get(src.id))) sources.push(src); }
  if (!sources.length) throw new Error('音声が端末にありません');
  const firstSrc = sources[0], lastSrc = sources.at(-1);
  const sig = [firstSrc.id, firstSrc.size, lastSrc.id, lastSrc.size, seconds].join('|');
  const cached = await sdb.get('meta', `edge-cues:${set.id}`);
  if (cached?.sig === sig) return { head: cached.head, tail: cached.tail, duration: cached.duration, cached: true };
  let tr = null;
  const one = async (src, a, z, label) => {
    const reader = await sourceAudioReader(src, say);
    const total = reader.end, from = Math.max(0, a), to = Math.min(total, z);
    const { audio, offset } = await reader.read(from - .3, to + .3);
    tr ||= openTranscriber('en', say, { quality: 'acc' });
    say(`${src.name || '音声'}　${label}を文字起こし中…`);
    const pieces = [];
    for (let t = from; t < to && !cancelled(); t += 10) {
      const cues = await recognisePiece(tr, audio, Math.max(0, t - offset), Math.min(audio.length / 16000, Math.min(to, t + 10) - offset));
      const text = (cues.raw || cues.map(x => x.text).join(' ')).trim();
      if (text) pieces.push({ text, start: t, end: Math.min(to, t + 10) });
    }
    return { pieces, total };
  };
  try {
    const headWin = await one(firstSrc, 0, seconds, '先頭');
    const tailWin = await one(lastSrc, (lastSrc === firstSrc ? headWin.total : (await sourceAudioReader(lastSrc, say)).end) - seconds, Infinity, '末尾');
    const duration = sources.reduce((sum, x) => sum + (x.duration || 0), 0) || headWin.total;
    await sdb.put('meta', { key: `edge-cues:${set.id}`, sig, head: headWin.pieces, tail: tailWin.pieces, duration });
    return { head: headWin.pieces, tail: tailWin.pieces, duration, cached: false };
  } finally { tr?.close(); }
}

// Direct script import deliberately bypasses audio trimming, encoding and pairing controls.
async function directScriptScreen(el, setId) {
  const set = await sdb.get('sets', setId);
  if (!set) { toast('教材が見つかりません'); return nav('sets'); }
  el.innerHTML = `${head('スクリプトを追加', `set?id=${set.id}`)}
    <div class="card stack"><p class="small">音声カットや圧縮設定は不要です。英語のスクリプトを直接追加します。既存の音声と字幕時刻は変更しません。</p>
    <label class="btn" for="directScriptFile">📄 TXT・SRT・VTT・CSVを選ぶ</label><input id="directScriptFile" type="file" accept=".txt,.srt,.vtt,.csv,text/plain,text/csv" hidden>
    <label class="field"><span>または英文を貼り付ける</span><textarea id="directScriptText" rows="9" placeholder="英文を1行ずつ入力"></textarea></label>
    <div class="card stack"><b>追加範囲を指定（任意）</b><p class="small muted">音声の先頭・末尾の文字起こしから範囲を推定するか、開始・終了の語句を検索して決めます。範囲は行の区切りに合わせます。未指定なら全文を追加します。</p>
    <button type="button" class="btn sm primary" id="directEstimate">音声の先頭・末尾から範囲を推定</button><p id="directEstimateInfo" class="small muted"></p>
    <label class="field">開始語句<input id="directStartSearch" type="search" placeholder="開始する行の語句"></label><div class="row"><button type="button" class="btn sm" id="directFindStart">開始位置を検索（次の一致）</button><button type="button" class="btn sm ghost" id="directFindStartPrev">前の一致</button></div><p id="directStartInfo" class="small muted"></p>
    <label class="field">終了語句<input id="directEndSearch" type="search" placeholder="終了する行の語句"></label><div class="row"><button type="button" class="btn sm" id="directFindEnd">終了位置を検索（次の一致）</button><button type="button" class="btn sm ghost" id="directFindEndPrev">前の一致</button></div><p id="directEndInfo" class="small muted"></p>
    <button type="button" class="btn sm ghost" id="directClearRange">全文に戻す</button><p id="directRangeInfo" class="small muted">全文を追加します</p></div>
    <p id="directScriptInfo" class="small muted"></p><button id="directScriptSave" class="btn primary">スクリプトを追加</button></div>`;
  const area = $('#directScriptText', el), info = $('#directScriptInfo', el), file = $('#directScriptFile', el);
  file.onchange = async () => { const f = file.files?.[0]; if (!f) return; area.value = await f.text(); info.textContent = `${f.name} を読み込みました`; };
  let selectedStart = null, selectedEnd = null;
  const rangeInfo = $('#directRangeInfo', el);
  const lineStarts = () => { const out = []; let at = 0; for (const l of area.value.split('\n')) { out.push([at, at + l.length]); at += l.length + 1; } return out; };
  const lineOf = (pos) => { const ls = lineStarts(); const k = ls.findIndex(([a, z]) => pos >= a && pos <= z); return { k: k < 0 ? ls.length - 1 : k, ls }; };
  const refreshRange = () => {
    const a = selectedStart ?? 0, b = selectedEnd ?? area.value.length;
    const n = (x, y) => area.value.slice(x, y).split('\n').filter(t => t.trim()).length;
    rangeInfo.textContent = a >= b ? '開始位置が終了位置以降です' : `追加する範囲：${n(a, b)}行（全${n(0, area.value.length)}行）`;
  };
  // 語句の一致をすべて集め（大文字小文字を区別しない）、押すたびに次（前）の一致へ進む。範囲は一致した行の先頭／末尾に合わせる（行の途中で切らない）。
  const matches = { start: { list: [], at: -1, term: '' }, end: { list: [], at: -1, term: '' } };
  const collect = (term) => { const out = [], lower = area.value.toLocaleLowerCase(), q = term.toLocaleLowerCase(); for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) out.push(i); return out; };
  const findBoundary = (which, dir = 1) => {
    const box = $(`#direct${which === 'start' ? 'Start' : 'End'}Search`, el), term = box.value.trim();
    if (!term) return toast('検索語句を入力してください');
    const m = matches[which];
    if (m.term !== term || !m.list.length) { m.term = term; m.list = collect(term); m.at = dir > 0 ? -1 : m.list.length; }
    if (!m.list.length) return toast('一致する語句がありません');
    m.at = (m.at + dir + m.list.length) % m.list.length;
    const pos = m.list[m.at], { k, ls } = lineOf(pos);
    if (which === 'start') selectedStart = ls[k][0]; else selectedEnd = ls[k][1];
    $(`#direct${which === 'start' ? 'Start' : 'End'}Info`, el).textContent = `${m.at + 1}/${m.list.length}件目：「${area.value.slice(ls[k][0], ls[k][1]).slice(0, 60)}」の行${which === 'start' ? 'から' : 'まで'}`;
    area.focus(); area.setSelectionRange(ls[k][0], ls[k][1]); refreshRange();
  };
  $('#directFindStart', el).onclick = () => findBoundary('start', 1);
  $('#directFindStartPrev', el).onclick = () => findBoundary('start', -1);
  $('#directFindEnd', el).onclick = () => findBoundary('end', 1);
  $('#directFindEndPrev', el).onclick = () => findBoundary('end', -1);
  $('#directClearRange', el).onclick = () => { selectedStart = selectedEnd = null; $('#directStartInfo', el).textContent = $('#directEndInfo', el).textContent = $('#directEstimateInfo', el).textContent = ''; refreshRange(); };
  area.addEventListener('input', () => { selectedStart = selectedEnd = null; matches.start.list = matches.end.list = []; refreshRange(); });
  // 音声の先頭・末尾を文字起こしして、貼り付けたスクリプトの中の範囲を推定する（文字起こしの結果は教材に保存され、次回は再実行しない）
  $('#directEstimate', el).onclick = async (event) => {
    const button = event.currentTarget, note = $('#directEstimateInfo', el);
    const rows = area.value.split('\n').map(text => ({ text }));
    if (!rows.some(r => r.text.trim())) return toast('先にスクリプトを貼り付けてください');
    const script = parseKinfureScript(rows.map(r => ({ text: r.text })));
    if (script.lines.length < 8) return toast('スクリプトの行が少なすぎます');
    button.disabled = true; note.textContent = '音声を準備しています…';
    try {
      const fresh = await sdb.get('sets', setId) || set;
      const edge = await transcribeEdges(fresh, { say: text => { note.textContent = text; } });
      const rate = (script.lines.length || 1) / Math.max(1, script.groups.length);   // 1項目あたりの行数
      const expectedLines = edge.duration ? Math.round(edge.duration / 9.5 * rate) : 0;   // 金フレ: 1項目 ≈ 9〜10秒
      const res = locateByEdges(script, edge.head, edge.tail, { expectedLines });
      if (!(res.startLine >= 0) || !(res.endLine >= res.startLine)) { note.textContent = res.reason || '範囲を推定できませんでした。語句検索で決めてください。'; return; }
      const row0 = script.lines[res.startLine].row, row1 = script.lines[Math.min(script.lines.length - 1, res.endLine + 1)]?.row;
      const ls = lineStarts();
      selectedStart = ls[row0][0];
      selectedEnd = res.endLine + 1 < script.lines.length && row1 != null ? Math.max(selectedStart, ls[row1][0] - 1) : area.value.length;
      area.focus(); area.setSelectionRange(selectedStart, selectedEnd); refreshRange();
      const LV = { high: '確信度：高', mid: '確信度：中', low: '確信度：低' };
      note.textContent = `推定：No.${res.startN}〜No.${res.endN}（${res.groups}件・${res.lines}行）　${LV[res.level] || ''}（先頭の一致 ${Math.round(res.headShare * 100)}%・末尾の一致 ${Math.round(res.tailShare * 100)}%）${edge.cached ? '　※保存済みの文字起こしを使用' : ''}${res.reason ? '　' + res.reason : ''}${res.ok ? '' : '　→ 範囲を確認し、必要なら語句検索で直してください'}`;
    } catch (e) { note.textContent = '推定できませんでした：' + (e?.message || e); }
    finally { button.disabled = false; }
  };
  $('#directScriptSave', el).onclick = async () => {
    const from = selectedStart ?? 0, to = selectedEnd ?? area.value.length;
    if (from >= to) return toast('選択範囲を確認してください');
    const raw = area.value.slice(from, to).trim(); if (!raw) return toast('スクリプトを入力してください');
    const parsed = withoutPlainScriptHeaders(parseScript(raw, file.files?.[0]?.name || 'script.txt'), raw, [set.title, file.files?.[0]?.name]);
    const lines = scriptToLines(parsed.cues.map((c) => c.text).join('\n'));
    if (!lines.length) return toast('英文を読み取れませんでした');
    if (!(await confirmDialog({title:'スクリプトを追加', body:`<p>${lines.length}行を教材「${esc(set.title)}」に追加します。既存の字幕・時刻は変更しません。</p>`,okLabel:'追加する'}))) return;
    const fresh = await sdb.get('sets', setId); if (!fresh) return toast('教材が見つかりません');
    const blocks = lines.map((text) => newBlock(setId, {segments:[], text, script:true, cueRefs:{en:[],ja:[]}, sync:'auto'}));
    await commit(fresh, 'スクリプトを直接追加', {blocks, order:[...fresh.order,...blocks.map((b)=>b.id)]});
    toast(`${lines.length}行を追加しました`); nav(`set?id=${setId}`);
  };
}

// ================= bulk import =================
async function importScreen(el, params) {
  if (params?.get('script') === '1' && params.get('to')) return directScriptScreen(el, params.get('to'));
  const destination = await importDestination(params);
  let dropImportedEdges = false;
  const files = { media: [], subs: [] };   // analysed entries
  let sets = null, storeMode = 'store', groupMode = 'file', videoQ = (() => { try { return localStorage.getItem('st-quality') || 'std'; } catch { return 'std'; } })(), autoTrimOn = (() => { try { return localStorage.getItem('st-autoTrim') !== '0'; } catch { return true; } })();
  // 1.17.8: the screen-recording start sound has its own cut (a fixed length from the start, measured 0.45 s), apart from the automatic cut
  let recOn = (() => { try { return localStorage.getItem('st-recOn') !== '0'; } catch { return true; } })();
  // 1.17.9: start and end are set separately (defaults measured by the user: 0.52 s / 0.30 s)
  let recCut = recCutGet('S'), recEnd = recCutGet('E');
  const trimOpt = () => (autoTrimOn || recOn ? { auto: autoTrimOn, rec: recOn ? recCut : 0, recE: recOn ? recEnd : 0, dropOriginal: dropImportedEdges } : false);   // both off → the file as it is
  const toSet = params?.get('to') ? await sdb.get('sets', params.get('to')) : null;   // add to an existing set
  el.innerHTML = `${head(toSet ? `「${toSet.title}」に追加` : '一括登録', toSet ? `set?id=${toSet.id}` : destination ? folderPath(destination) : 'sets')}
    ${destination ? `<p class="small">取り込み先　📁 ${esc(destination.name)}</p>` : ''}
    ${toSet ? `<div class="notice stack small"><b>教材「${esc(toSet.title)}」に追加します。</b>同じ教材の続きの音声や、スクリプト（時刻なしのテキスト）を選んでください。追加したあと「文字起こし→照合」で、音声とスクリプトの位置を合わせます。</div>` : ''}
    <div class="card stack">
      <p class="small">動画・音声と、英語・日本語の字幕（SRT・VTT・TXT・CSV）をまとめて選びます。ファイル名・言語・長さから自動で組み合わせます。<b>1回の取り込みは合計で、動画45分・音声100分まで</b>。</p>
      <label class="btn" for="fz">📦 ZIPを選ぶ（フォルダを圧縮したもの）</label><input type="file" id="fz" hidden>
      <label class="btn" for="fm">🎬 動画・音声を選ぶ（複数可）</label><input type="file" id="fm" multiple hidden>
      <label class="btn" for="fs">📄 字幕・スクリプトを選ぶ（複数可）</label><input type="file" id="fs" multiple hidden>
      <small class="muted">フォルダごと入れるとき：「ファイル」アプリでフォルダを長押し →「圧縮」→ できたZIPをここで選ぶ</small>
      <div id="flist" class="small"></div>
    </div>
    <div id="pairs"></div>`;
  const listFiles = () => {
    $('#flist', el).innerHTML = [...files.media.map((m) => `🎬 ${esc(m.name)}（${m.duration ? fmt(m.duration) : '長さ不明'}${m.playable ? '' : '・この端末で再生できません'}・${fmtSize(m.file.size)}）`),
      ...files.subs.map((s) => `📄 ${esc(s.name)}（${s.lang === 'ja' ? '日本語' : '英語'}・${s.parsed.cues.length}行${s.parsed.timed ? '' : '・時間なし'}${s.parsed.cues.some((c) => c.rep > 1) ? `・くり返し×n ${s.parsed.cues.filter((c) => c.rep > 1).length}行` : ''}）`),
      ...previews.map(previewHTML)].join('<br>');
    $$('[data-pv]', el).forEach((b) => (b.onclick = () => { const d = b.nextElementSibling; d.hidden = !d.hidden; }));
  };
  // 1.17: what a timed text / JSON file was read as (before importing): explanations and unreadable lines are left out
  const previews = [];
  let previewAudio = null, previewUrl = null;
  const stopImportPreview = () => { if (previewAudio) { previewAudio.pause(); previewAudio.ontimeupdate = null; previewAudio.onended = null; previewAudio = null; } if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; } };
  const CLS = { head: ['見出し（音声ファイル）', ''], intro: ['説明文（入れない）', 'muted'], word: ['単語', ''], example: ['例文', ''], ja: ['和訳', ''], unknown: ['解釈できない（入れない）', 'warn-text'] };
  const previewHTML = (pv) => {
    const cnt = {}; for (const r of pv.rows) cnt[r.cls] = (cnt[r.cls] || 0) + 1;
    const reps = pv.rows.filter((r) => r.rep > 1).length;
    return `<div class="card stack small st-pv"><b>📄 ${esc(pv.name)} の読み取り結果</b>
      <span>${pv.sections.length > 1 || pv.sections[0]?.file ? `音声ファイルごとに ${pv.sections.length}つに分けました：${pv.sections.map((x) => esc(x.file || '（名前なし）')).join('、')}<br>` : ''}
      ${Object.entries(CLS).filter(([k]) => cnt[k]).map(([k, [l, c]]) => `<span class="${c}">${l} ${cnt[k]}</span>`).join('・')}${reps ? `・くり返し（×n） ${reps}行（記号は字幕から外し、回数だけ残します）` : ''}</span>
      ${cnt.unknown ? '<span class="warn-text">解釈できない行があります。内容を確認してください（時刻のない英文など）。</span>' : ''}
      <button type="button" class="link small" data-pv>内容を確認</button>
      <div class="st-pvrows" hidden>${pv.rows.slice(0, 400).map((r) => `<div class="${CLS[r.cls]?.[1] || ''}"><span class="tagp">${CLS[r.cls]?.[0] || r.cls}</span> ${esc(r.text)}</div>`).join('')}${pv.rows.length > 400 ? `<div class="muted">ほか ${pv.rows.length - 400}行</div>` : ''}</div></div>`;
  };
  async function addMedia(f, name = f.name) {
    const meta = await readDuration(f);
    const fp = await fingerprint(f);
    files.media.push({ key: fp.id, name, file: f, fp, ...meta, kind: f.type.startsWith('audio') || AUDIO_EXT.test(name) ? 'audio' : 'video' });
  }
  async function addSub(text, name) {
    const parsed = parseScript(text, name);
    if (!parsed.cues.length) return;
    if (parsed.sections) {   // timed text / JSON: English with its Japanese per line; one subtitle per audio file named in the text
      previews.push({ name: name.split('/').pop(), rows: parsed.rows, sections: parsed.sections });
      const named = parsed.sections.filter((x) => x.file);
      for (const sec of parsed.sections) {
        const nm = sec.file && named.length ? `${dirOf(name) ? dirOf(name) + '/' : ''}${sec.file.replace(/\.[^.]+$/, '')}.en.txt` : name;
        const p2 = { format: parsed.format, cues: sec.cues, timed: true };
        files.subs.push({ key: newId('f'), name: nm, text: '', parsed: p2, lang: 'en', lastEnd: Math.max(...sec.cues.map((c) => c.end)) });
      }
      return;
    }
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
      const folders = new Set(media.map(dirOf).filter(Boolean)); if (folders.size > 1) groupMode = 'folder';   // only when the ZIP really has several folders
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
      ${over ? `<p class="warn-text small">${overV ? '動画の合計が45分' : '音声の合計が100分'}を超えています。いくつかのチェックを外してください。</p>` : ''}
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
        ${storeMode === 'store' ? `<span class="small">保存する質（音声ファイル・ZIPの中の音声・動画の音声に共通）</span>
        ${Object.entries(TIERS).map(([k, t]) => `<label class="chk"><input type="radio" name="vq" value="${k}" ${videoQ === k ? 'checked' : ''}> ${t.label}：AAC ${t.kbps}kbps・約${(bytesPerMin(k) / 1e6).toFixed(2)}MB/分（${t.note}）${k === 'std' ? '・おすすめ' : ''}</label>`).join('')}
        <label class="chk"><input type="radio" name="vq" value="orig" ${videoQ === 'orig' ? 'checked' : ''}> 元のまま（動画の映像も残す・圧縮しない）</label>
        <small class="muted">圧縮すると動画は音声だけになります。圧縮できなかったファイルは元のまま保存し、結果に表示します。</small>` : ''}
        ${needBytes ? `<small class="muted">必要な容量：約${fmtSize(storeMode === 'store' && TIERS[videoQ] ? inc.reduce((a, x) => a + Math.min(x.media.file.size, (x.media.duration || 0) * bytesPerMin(videoQ) / 60), 0) : needBytes)}</small>` : ''}</div>
      <label class="chk"><input type="checkbox" id="rec" ${recOn ? 'checked' : ''}> 画面収録音をカット</label>
      ${recOn ? `<div class="row wrap st-recrow"><span class="small">始め ${recCut.toFixed(2)}秒</span><button type="button" class="btn xs" data-rc="S:-0.01">−0.01</button><button type="button" class="btn xs" data-rc="S:0.01">＋0.01</button><button type="button" class="btn xs" data-rc="S:-0.05">−0.05</button><button type="button" class="btn xs" data-rc="S:0.05">＋0.05</button></div>
      <div class="row wrap st-recrow"><span class="small">終わり ${recEnd.toFixed(2)}秒</span><button type="button" class="btn xs" data-rc="E:-0.01">−0.01</button><button type="button" class="btn xs" data-rc="E:0.01">＋0.01</button><button type="button" class="btn xs" data-rc="E:-0.05">−0.05</button><button type="button" class="btn xs" data-rc="E:0.05">＋0.05</button><button type="button" class="btn xs ghost" id="rcReset">初期値に戻す</button></div>` : ''}
      <label class="chk"><input type="checkbox" id="atr" ${autoTrimOn ? 'checked' : ''}> 前後の無音・音を自動でカット</label>
      ${!autoTrimOn && !recOn ? '<small class="muted">どちらも外すと、カットせずに元の長さのまま取り込みます。</small>' : ''}
      ${autoTrimOn || recOn ? `<label class="chk"><input type="checkbox" id="drc" ${dropImportedEdges ? 'checked' : ''}> カットした部分（元の前後）は保存しない（容量節約・元に戻せません）</label>` : ''}
      ${inc.length ? `<div class="card stack"><b>カット後の範囲を試聴（保存前）</b><small class="muted">対象ファイルの先頭・末尾を設定値に従って試聴します。自動無音検出の最終結果ではなく、画面収録音カットの指定値を確認する機能です。</small>
      <select id="cutPreviewFile">${inc.map((x,i)=>`<option value="${i}">${esc(x.media.name)}</option>`).join('')}</select>
      <div class="row wrap"><button class="btn sm" id="cutPreviewStart">▶ 冒頭を試聴</button><button class="btn sm" id="cutPreviewEnd">▶ 末尾を試聴</button><button class="btn sm" id="cutPreviewStop">■ 停止</button></div><span id="cutPreviewStatus" class="small muted"></span></div>` : ''}
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
    $$('input[name=vq]', el).forEach((r) => (r.onchange = () => { videoQ = r.value; try { localStorage.setItem('st-quality', videoQ); } catch {} draw(); }));
    $('#atr', el).onchange = (e) => { autoTrimOn = e.target.checked; try { localStorage.setItem('st-autoTrim', autoTrimOn ? '1' : '0'); } catch {} draw(); };
    $('#rec', el).onchange = (e) => { recOn = e.target.checked; try { localStorage.setItem('st-recOn', recOn ? '1' : '0'); } catch {} draw(); };
    $$('[data-rc]', el).forEach((b) => (b.onclick = () => { const [k, d] = b.dataset.rc.split(':'); const v = Math.max(0, Math.min(k === 'E' ? 5 : 3, Math.round(((k === 'S' ? recCut : recEnd) + +d) * 100) / 100)); if (k === 'S') recCut = v; else recEnd = v; recCutSet(k, v); draw(); }));
    $('#rcReset', el)?.addEventListener('click', () => { recCut = REC_DEF.S; recEnd = REC_DEF.E; recCutSet('S', recCut); recCutSet('E', recEnd); draw(); });
    $('#drc', el)?.addEventListener('change', (e) => { dropImportedEdges = e.target.checked; });
    $('#gm', el).onclick = (e) => { const v = e.target.dataset.v; if (v) { groupMode = v; draw(); } };
    $('#incAll', el).onclick = () => { sets.forEach((s) => (s.include = true)); draw(); };
    $('#incNone', el).onclick = () => { sets.forEach((s) => (s.include = false)); draw(); };
    const playPreview = (which) => {
      stopImportPreview(); const m = inc[+$('#cutPreviewFile',el)?.value]?.media; if (!m) return;
      const duration = m.duration || 0, start = recOn ? recCut : 0, end = Math.max(start, duration - (recOn ? recEnd : 0));
      if (duration && end <= start) return toast('試聴できる範囲がありません');
      const from = which === 'end' ? Math.max(start,end-5) : start;
      const until = which === 'end' ? end : Math.min(end,from+5);
      previewUrl = URL.createObjectURL(m.file); previewAudio = new Audio(previewUrl);
      const a = previewAudio; const status = $('#cutPreviewStatus',el);
      status.textContent = `${which === 'end' ? '末尾' : '冒頭'} ${fmt(from)}〜${fmt(until)} を試聴中`;
      a.ontimeupdate = () => { if (previewAudio === a && !a.seeking && a.currentTime >= until) { stopImportPreview(); status.textContent = '試聴終了'; } };
      a.onended = () => { stopImportPreview(); status.textContent = '試聴終了'; };
      a.currentTime = from;
      a.play().catch(e => {
        if (previewAudio !== a) return;
        status.textContent = '再生できません：' + e.message;
        stopImportPreview();
      });
    };
    $('#cutPreviewStart',el)?.addEventListener('click',()=>playPreview('start'));
    $('#cutPreviewEnd',el)?.addEventListener('click',()=>playPreview('end'));
    $('#cutPreviewStop',el)?.addEventListener('click',()=>{stopImportPreview(); const t=$('#cutPreviewStatus',el);if(t)t.textContent='停止しました';});
    $('#go', el).onclick = () => { stopImportPreview(); const inc = sets.filter((s) => s.include); const mode = storeMode === 'store' && TIERS[videoQ] ? `store-c:${videoQ}` : storeMode; if (toSet) return runAppend(inc, mode); runImport(groupMode === 'folder' ? groupsOf(inc).map(({ folder, ...g }) => g) : inc.map((s) => ({ title: s.title, items: [s], folder: groupsOf([s])[0]?.folder || '' })), mode); };
  }
  async function runAppend(list, mode) {
    const prog = $('#prog', el); $('#go', el).disabled = true; running('追加');
    try {
      await appendToSet(toSet.id, list.map((s) => ({ title: s.title, items: [s] })), mode, trimOpt(), (k, n, t = '') => (prog.innerHTML = `<p class="small">追加中（${k} / ${n}）${t ? `<br>${esc(t)}` : ''}</p>`));
      running(null); nav(`set?id=${toSet.id}`);
    } catch (e) { running(null); prog.innerHTML = `<div class="card warn">追加できませんでした：${esc(e?.message || String(e))}</div>`; $('#go', el).disabled = false; }
  }
  async function runImport(list, mode) {
    const prog = $('#prog', el);
    // the same data imported before (or stopped halfway): found by the FILES themselves (fingerprint / subtitle name), not by the title
    const reuseOf = new Map();
    const impOf = (it) => it.media?.fp?.id || it.en?.name || it.ja?.name || '';
    const owner = new Map();   // imported file → set that already has rows from it
    const setsById = Object.fromEntries((await sdb.all('sets')).map((x) => [x.id, x]));
    for (const blk of await sdb.all('blocks')) if (!blk.deleted && blk.imp && setsById[blk.setId]?.order?.includes(blk.id)) owner.set(blk.imp, blk.setId);
    const hits = list.map((g) => { const ids = g.items.map(impOf).filter(Boolean).map((k) => owner.get(k)).filter(Boolean); const best = ids.sort((x, y) => ids.filter((v) => v === y).length - ids.filter((v) => v === x).length)[0]; return best ? [g, setsById[best]] : null; }).filter(Boolean);
    if (hits.length) {
      const dlg = $('#dialog');
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>前に取り込んだファイルが含まれています</h3>
        <div class="small">${hits.map(([g, x]) => `「${esc(g.title)}」→ 教材「${esc(x.title)}」${x.importing ? `（取り込み途中 ${x.importing.done}/${x.importing.total}）` : ''}`).join('<br>')}</div>
        <p class="hint">上書き：その教材に続きを入れ、同じファイルから作った行は新しい内容に置き換えます（行は増えません）。<br>別の教材：新しい教材として、元のファイル名で作ります。</p>
        <button class="btn primary" value="ok">上書きして続ける</button><button class="btn" value="new">別の教材にする</button><button class="btn ghost" value="cancel">キャンセル</button></form>`;
      dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
      if (dlg.returnValue !== 'ok' && dlg.returnValue !== 'new') return;   // cancel: nothing is imported
      if (dlg.returnValue === 'ok') hits.forEach(([g, x]) => reuseOf.set(g, x));
    }
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    navigator.storage?.persist?.().catch(() => {});
    $('#go', el).disabled = true;
    const results = [];
    running('一括登録');
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (destination) s.folder = destination.name;
      prog.innerHTML = `<p class="small">登録中 ${i + 1} / ${list.length}：${esc(s.title)}</p>`;
      const reuse = reuseOf.get(s) || null;
      try { const r = await createSet(s, mode, trimOpt(), (k, n, t = '') => (prog.innerHTML = `<p class="small">登録中 ${i + 1} / ${list.length}：${esc(s.title)}（${k} / ${n}）${t ? `<br>${esc(t)}` : ''}</p>`), reuse); if (destination) await moveStudioSets([r.id], destination.id); results.push({ s, id: r.id, notes: r.notes, again: !!reuse }); }
      catch (e) { results.push({ s, err: (e?.message || String(e)) }); }
    }
    lock?.release?.(); running(null);
    files.media = []; files.subs = []; previews.length = 0; sets = null; listFiles();   // the next files start from empty (not mixed with these)
    prog.innerHTML = `<div class="card stack"><b>登録 ${results.filter((r) => r.id).length}セット・失敗 ${results.filter((r) => r.err).length}</b>
      ${results.map((r) => `<div class="small">${r.id ? `✓ <a class="link" href="#${BASE}set?id=${r.id}">${esc(r.s.title)}</a>${r.again ? '（上書き・続き）' : ''}${(r.notes || []).map((t) => `<br><span class="warn-text">${esc(t)}</span>`).join('')}` : `✕ ${esc(r.s.title)}：${esc(r.err)}<br><span class="muted">途中までのファイルは保存されています。同じデータをもう一度取り込むと続きから入ります。</span>`}</div>`).join('')}
      <a class="btn" href="#${BASE}${destination ? folderPath(destination) : 'sets'}">一覧へ</a></div>`;
  }
}

function highPass(a, fc = 80) { const rc = 1 / (2 * Math.PI * fc), dt = 1 / 16000, al = rc / (rc + dt); let py = 0, px = a[0] || 0; for (let i = 0; i < a.length; i++) { const x = a[i]; py = al * (py + x - px); px = x; a[i] = py; } return a; }
// ---- trimming the start / end (screen-recording sounds, silence) ----
async function findEdges(src, blob, D, a16 = null, opt = null) {
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
  const rc = opt ? opt.rec || 0 : isScreenRec(src.name) ? dc : 0;   // import: the user's setting; elsewhere: screen recordings only
  if (rc > 0 && st.cut < rc) st = { cut: rc, why: `画面収録音 ${rc}秒` };
  const re = opt?.recE || 0; if (re > 0 && en.cut < re) en = { cut: re, why: `画面収録音 ${re}秒` };
  return { start: +st.cut.toFixed(2), end: +(D - en.cut).toFixed(2), whyStart: st.why, whyEnd: en.why, duration: D };
}
// screen-recording sound: seconds cut at the start / end (import screen and the 前後をカット dialog share them)
const REC_DEF = { S: 0.52, E: 0.30 };
// 1.18.5: text input in the app's own dialog (window.prompt does not open in some home-screen apps on the iPhone)
async function askText(title, value = '') {
  const dlg = document.querySelector('#dialog'); if (dlg.open) { dlg.onclose = null; dlg.close(); await new Promise((r) => setTimeout(r, 60)); }
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(title)}</h3><input id="askT" value="${esc(value)}" autocomplete="off"><div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">OK</button></div></form>`;
  dlg.returnValue = ''; dlg.showModal(); const inp = dlg.querySelector('#askT'); setTimeout(() => { inp.focus(); inp.select(); }, 50);
  await new Promise((q) => (dlg.onclose = q));
  return dlg.returnValue === 'ok' ? inp.value.trim() : null;
}
const fmt2 = (t) => { t = Math.max(0, +t || 0); return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
const recCutGet = (k) => { try { const v = localStorage.getItem('st-rec' + k); return v != null && v !== '' && !isNaN(+v) ? +v : REC_DEF[k]; } catch { return REC_DEF[k]; } };
const recCutSet = (k, v) => { try { localStorage.setItem('st-rec' + k, String(v)); } catch {} };
// Remove the parts outside [a, b] from the saved file itself (cannot be undone). Sound only: a video is turned into its sound.
// All items of every set that use this file are shifted so they still point at the same sound.
async function hardTrim(srcId, a, b, say = () => {}) {
  const src = await sdb.get('sources', srcId);
  if (!src?.stored || !src.blob) throw new Error('端末に保存したファイルだけ削れます');
  let blob = null, start = a;
  const info = isContainer(src, src.blob) ? await probe(src.blob).catch(() => null) : null;
  const at = info ? audioTracks(info) : [];
  const t = at.find((x) => x.id === src.audio?.trackId) || at[src.audio?.index ?? 0];
  if (src.derived === 'aac') {   // 1.17.2: our own AAC (compressed at import): exact cut, keeps the quality, no track copy
    say('カット部分を削っています…'); const x = await cutAac(src.blob, a, b, src.name); blob = x.file; start = x.start;
  } else if (t && canExtract(t) && (src.kind === 'audio' || src.derived === 'audio16k')) {   // sound file: cut without re-encoding
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
  delete src.audio; forgetSource(src.id);
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
  const a = await withTimeout(aac16(audio).catch(() => null), 15000 + duration * 300);   // 1.16: tried every time (a failure no longer turns it off for good)
  try { localStorage.removeItem('st-noaac2'); } catch {}
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
  // 1.17.1: files that are not in a folder are not lumped together into one "まとめ" set: each stays its own set
  for (const s of list) { const d = dirOf(s.media?.name || s.en?.name || s.ja?.name || '') || `\u0000${s.title || s.media?.name || Math.random()}`; if (!m.has(d)) m.set(d, []); m.get(d).push(s); }
  return [...m].map(([d, items]) => (d.startsWith('\u0000') ? { title: items[0].title || d.slice(1), items } : { title: d.split('/').filter(Boolean).join(' / '), items, folder: d.split('/').filter(Boolean).join(' / ') }));
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
  let a16 = null, small = null;
  const tier = mode.startsWith('store-c:') ? mode.slice(8) : mode === 'store-audio' ? 'strong' : null;
  if (tier && !src.stored) {   // 1.16: AAC at the chosen quality, read in pieces (long files too); failure → the file is kept as it is
    const est = estimate(media.file.size, media.duration || 0, tier);
    if (media.kind === 'audio' && !est.worth) src.compressNote = 'すでに小さいので、そのまま保存しました';
    else small = await compressAudio(media.file, { tier, name: src.name, duration: media.duration || 0, trackIndex: src.audio?.index ?? null, onProgress: (r, t) => say(t) })
      .catch((e) => { src.compressError = e.message; return null; });
  }
  if (small && small.file.size < media.file.size) {   // sound only, AAC
    Object.assign(src, { stored: true, blob: small.file, kind: 'audio', mime: small.file.type, derived: 'aac', codec: 'm4a', tier: small.tier, origSize: media.file.size, size: small.file.size, duration: small.duration || src.duration });
    delete src.audio;
  } else if (mode.startsWith('store') && !src.stored) { src.stored = true; src.blob = media.file.size <= 300 * 1024 * 1024 ? await copyBlob(media.file, say) : media.file; }
  else if (!src.stored) sessionFiles.set(src.id, media.file);
  if (src.stored) forgetSource(src.id);   // the saved file (copy / compressed sound) is what plays from now on
  await sdb.put('sources', src);   // a big file is written from disk; may take a while
  return { src, a16 };
}
// group = { title, items: [{ media, en, ja, title }] } → one set; items keep their order
// 1.16: the set is saved after every file. If the app stops halfway, the files done so far stay (marked "取り込み途中");
// importing the same data again continues it: rows that came from the same file are replaced (not doubled).
const importKeyOf = (group) => `${group.folder || ''}/${group.title || ''}`;
async function createSet(group, mode, trimEdges = false, onStep = () => {}, reuse = null) {
  let set = reuse;
  const fresh = !set;
  if (fresh) {
    set = { id: newId('set_'), title: group.title || group.items[0]?.media?.name || '無題', ...(group.folder && group.folder !== 'まとめ' ? { folder: group.folder } : {}), sourceId: null, order: [], undo: [], redo: [],
      display: { show: 'both', opEn: 1, opJa: 0.8, pos: 'below', order: 'en' }, createdAt: Date.now(), updatedAt: Date.now() };
  }
  set.importKey = importKeyOf(group); set.importing = { done: 0, total: group.items.length, at: Date.now() };
  await sdb.put('sets', set);
  const n = group.items.length, notes = [];
  for (let i = 0; i < n; i++) {
    const { blocks, tracks, firstSrc } = await buildItems(set.id, { items: [group.items[i]] }, mode, trimEdges, (_k, _n, t = '') => onStep(i + 1, n, t));
    if (firstSrc?.compressError) notes.push(`${firstSrc.name}：圧縮できず元のまま（${firstSrc.compressError}）`);
    if (!set.sourceId && firstSrc) set.sourceId = firstSrc.id;
    const imp = blocks[0]?.imp || tracks[0]?.imp || '';
    const live = await liveBlocks(set);
    const old = imp ? live.filter((b) => b.imp === imp || (firstSrc && !b.imp && b.segments?.some((g) => g.sourceId === firstSrc.id))) : [];
    let order = set.order.slice(), at = order.length;
    if (old.length) { const ids = new Set(old.map((b) => b.id)); at = order.findIndex((id) => ids.has(id)); order = order.filter((id) => !ids.has(id)); }
    order.splice(at, 0, ...blocks.map((b) => b.id));
    const oldTracks = imp ? (await sdb.byIndex('tracks', 'setId', set.id)).filter((x) => x.imp === imp) : [];
    await sdb.tx(['tracks'], 'readwrite', (t) => { oldTracks.forEach((x) => t.objectStore('tracks').delete(x.id)); tracks.forEach((x) => t.objectStore('tracks').put(x)); });
    await commit(set, old.length ? '取り込み（上書き）' : '取り込み', { blocks: [...blocks, ...old.map((b) => ({ ...b, deleted: true }))], order });
    set.undo = []; set.importing = { done: i + 1, total: n, at: Date.now() }; await sdb.put('sets', set);   // the import itself is not undoable
  }
  delete set.importing; if (notes.length) set.importNotes = notes; else delete set.importNotes;
  await sdb.put('sets', set);
  await saveVersion(set, fresh ? '取り込み直後' : '取り込み（上書き）', true);
  return { id: set.id, notes };
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
// 1.17.8: trim = { auto, rec } from the import screen. auto: look for sounds / silence at both ends; rec: always cut that much at the start
async function edgesFor(src, dur, a16, trim) {
  if (trim.auto) return findEdges(src, src.stored ? src.blob : sessionFiles.get(src.id), dur, a16, { rec: trim.rec || 0, recE: trim.recE || 0 });
  const a = Math.min(trim.rec || 0, dur - 1), b = +Math.max(a + 0.5, dur - (trim.recE || 0)).toFixed(2);
  return { start: a, end: b, whyStart: a ? `画面収録音 ${a}秒` : '', whyEnd: b < dur ? `画面収録音 ${trim.recE}秒` : '', duration: dur };
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
    const imp = s.media?.fp?.id || s.en?.name || s.ja?.name || '';   // 1.16: which imported file these rows came from (re-import overwrites them)
    const tag = (list) => list.forEach((b) => (b.imp = imp));
    const mkTrack = (sub, lang) => sub && { id: newId('tr_'), setId, imp, lang, fileName: sub.name.split('/').pop(), format: sub.parsed.format, raw: sub.text, offset: 0, cues: sub.parsed.cues };
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
        const script = withoutPlainScriptHeaders(s.en.parsed, s.en.text, [s.title, s.media?.name, s.en.name]);
        const lines = scriptToLines(script.cues.map((c) => c.text).join('\n'));
        const jaLines = ja && !s.ja.parsed.timed && ja.cues.length === lines.length ? ja.cues.map((c) => c.text) : [];
        lines.forEach((t, i) => part.push(newBlock(setId, { segments: [], text: t, ja: jaLines[i] || '', script: true, cueRefs: { en: [], ja: [] }, sync: 'auto' })));
        if (src) {
          let a = 0, b = dur || 1;
          if (trimEdges && dur > 4) { try { onStep(n, group.items.length, '前後の音を調べています…'); const r = await edgesFor(src, dur, a16, trimEdges); a = r.start; b = r.end; } catch { /* whole file */ } }
          part.push(newBlock(setId, { segments: seg(a, b), label: '', sync: 'auto' }));
        }
        tag(part); blocks.push(...part); a16 = null; await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const { map, extra } = ja && s.ja.parsed.timed && !enCues[0]?.est ? alignJa(enCues, ja.cues) : { map: new Map(), extra: [] };
      enCues.forEach((c, i) => {
        const jas = map.get(c.id) || [];
        const jaText = jas.length ? jas.map((j) => j.text).join('') : c.ja || (ja && !s.ja.parsed.timed ? ja.cues[i]?.text || '' : '');
        const segs = seg(c.start, c.end);
        part.push(newBlock(setId, { segments: segs, text: c.text, ja: jaText, cueRefs: { en: [c.id], ja: jas.map((j) => j.id) }, sync: c.est ? 'estimated' : 'auto',
          align: segs.length && tokensOf(c.text).length ? [{ s: 0, e: tokensOf(c.text).length - 1, v0: 0, v1: segs[0].end - segs[0].start }] : [],
          // 1.17: read n times in the audio ("×n", not part of the text); the end is the next line's start = an estimate; word ↔ example
          ...(c.rep > 1 ? { rep: c.rep } : {}), ...(c.endEst ? { endEst: true } : {}), ...(c.kind ? { kind: c.kind } : {}), ...(c.pair ? { pairCue: c.pair } : {}) }));
      });
      { const byCue = new Map(part.map((b) => [b.cueRefs?.en?.[0], b.id])); part.forEach((b) => { if (b.pairCue) { b.pair = byCue.get(b.pairCue) || null; delete b.pairCue; if (!b.pair) delete b.pair; } }); }
      for (const j of extra) part.push(newBlock(setId, { segments: seg(j.start, j.end), text: '', ja: j.text, jaStatus: 'needsReview', cueRefs: { en: [], ja: [j.id] } }));
      part.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
    } else if (ja) {
      ja.cues.forEach((j) => part.push(newBlock(setId, { segments: s.ja.parsed.timed ? seg(j.start, j.end) : [], text: '', ja: j.text, cueRefs: { en: [], ja: [j.id] }, sync: s.ja.parsed.timed ? 'auto' : 'estimated' })));
    } else if (src) {   // audio/video without a script: one item for the whole file (text can be added later)
      let a = 0, b = dur || 1, trimNote = '';
      if (trimEdges && dur > 4) { try { onStep(n, group.items.length, '前後の音を調べています…'); const r = await edgesFor(src, dur, a16, trimEdges); a = r.start; b = r.end; trimNote = [r.whyStart && `始め ${fmt(a)}`, r.whyEnd && `終わり ${fmt(b)}`].filter(Boolean).join('・'); } catch { /* keep the whole file */ } }
      const shared = (await sdb.all('sets')).some((x) => x.sourceId === src.id);   // used by another set: do not cut its file
      if (trimNote && trimEdges?.dropOriginal && src.stored && !shared) {
        try { onStep(n, group.items.length, 'カットした部分を削っています…'); const t2 = await hardTrim(src.id, a, b, (t) => onStep(n, group.items.length, t)); const off = t2.trimmed.from; a = Math.max(0, a - off); b = Math.min(t2.duration, b - off); Object.assign(src, t2); }
        catch (e) { trimNote += `（削除はできませんでした：${e.message}）`; }
      }
      part.push(newBlock(setId, { segments: seg(a, b), label: '', sync: dur ? 'auto' : 'estimated', ...(trimNote ? { trimNote } : {}) }));
    }
    // Apply screen-recording cut independently to every selected timed-script media file.
    if (src && en && s.en.parsed.timed && trimEdges && dur > 4) {
      try {
        const bounds = await edgesFor(src, dur, a16, trimEdges);
        for (const block of part) {
          const updated = [];
          for (const g of block.segments || []) {
            if (g.sourceId !== src.id) { updated.push(g); continue; }
            const a = Math.max(g.start, bounds.start), b = Math.min(g.end, bounds.end);
            if (b > a + 0.05) updated.push({...g,start:a,end:b});
          }
          if (updated.length !== (block.segments || []).length) block.sync = 'estimated';
          block.segments = updated;
        }
      } catch (err) { crumb(`カット範囲の計算に失敗：${s.media?.name || ''} ${err.message}`); }
    }
    tag(part); blocks.push(...part);
    a16 = null; await new Promise((r) => setTimeout(r, 250));   // let the phone free the decoded sound before the next file
  }
  return { blocks, tracks, firstSrc };
}

// ================= editor =================
async function editorScreen(el, params, revision) {
  let set = await sdb.get('sets', params.get('id'));
  if (revision !== routeRevision) return;
  if (!set) return nav('sets');
  running(`教材を開く（${set.title}）`); setTimeout(() => { if (localStorage.getItem('st-running')?.startsWith('教材を開く')) running(null); }, 4000);
  let srcs = await sourcesMap();
  let blocks = [], byId = {}, jaView = studioJaView([]);
  const sel = new Set();
  let arrange = false, drag = null, arrangeBase = 0;
  let selectMode = false, rangeMode = null, anchor = null, onlySel = false, moveMode = false, playing = null, curBlock = null;
  const reload = async () => { set = await sdb.get('sets', set.id); blocks = await liveBlocks(set); jaView = studioJaView(blocks); byId = Object.fromEntries(blocks.map((b) => [b.id, b])); for (const id of [...sel]) if (!byId[id]) sel.delete(id); cutRanges = await computeCuts(); };
  // Sound of lines the user deleted (and that no remaining line uses) is skipped in continuous playback,
  // so it is not heard inside the neighbouring subtitles. Sound no line ever had (pauses, a second reading) still plays.
  let cutRanges = new Map();
  async function computeCuts() {
    const m = new Map();
    try {
      const live = new Set(set.order);
      for (const d of await sdb.byIndex('blocks', 'setId', set.id)) {
        if (!d.deleted || !d.userDel || live.has(d.id)) continue;
        for (const g of d.segments || []) {
          let pieces = [[g.start, g.end]];
          for (const b of blocks) for (const h of b.segments) if (h.sourceId === g.sourceId)
            pieces = pieces.flatMap(([a, z]) => (h.end <= a || h.start >= z) ? [[a, z]] : [[a, h.start], [h.end, z]].filter(([x, y]) => y - x > 0.001));
          for (const [a, z] of pieces) if (z - a >= 0.15) { if (!m.has(g.sourceId)) m.set(g.sourceId, []); m.get(g.sourceId).push([a, z]); }
        }
      }
    } catch {}
    return m;
  }
  await reload();
  if (revision !== routeRevision) return;
  const src = srcs[set.sourceId];
  const parentFolder = set.folder && (await studioFolders([set])).find(folder => folder.name === set.folder);
  el.innerHTML = `${head(set.title, parentFolder ? folderPath(parentFolder) : 'sets', `<button class="icon-btn" id="undoB" aria-label="元に戻す">${icon('undo')}</button><button class="icon-btn" id="redoB" aria-label="やり直す">${icon('redo')}</button><button class="icon-btn st-viewb" id="viewB" aria-label="表示の切り替え"></button><button class="icon-btn" id="moreB" aria-label="メニュー">${icon('more')}</button>`)}
    <div id="relink"></div>${(() => { const x = srcs[set.sourceId]; return x?.audioError ? `<div class="notice warn small">取り込み時の音声処理で失敗したため、元のまま保存しています：${esc(x.audioError)}</div>` : ''; })()}
    <div class="st-player"><div class="st-vwrap"><video id="vid" playsinline webkit-playsinline preload="metadata"></video></div>
      <div class="st-sub" id="sub"></div></div>
      <div class="st-stick"><div class="row st-seekrow"><input type="range" id="seek" class="st-seek" min="0" max="1" step="0.05" value="0" aria-label="再生位置"><span class="small muted" id="tdur"></span></div>
      <div class="row st-ctl"><button class="btn sm" id="back3">⟲3</button><button class="btn sm primary" id="pp">${icon('play')}</button><button class="btn sm" id="fwd3">3⟳</button><span class="small muted" id="tnow">0:00.0</span><span class="grow"></span><button class="btn sm" id="arrB">結合・移動</button><button class="btn sm" id="selB">選択</button></div></div>
    <div id="sourceNav" class="st-source-nav"></div><div id="info" class="small muted"></div><div id="alignNote"></div>
    <div id="list" class="st-list"></div>
    <div id="bar" class="st-bar" hidden></div><div class="st-jump" id="jump"><button type="button" data-j="top" aria-label="いちばん上へ">▲</button><button type="button" data-j="bot" aria-label="いちばん下へ">▼</button></div>`;
  const jp = $('#jump', el);
  let hideJumpTimer, jumpFrame, pressedArrow, lastArrow, lastTapAt = -Infinity;
  let deferFollowUntil = 0;
  const stopArrow = () => {
    cancelAnimationFrame(jumpFrame);
    pressedArrow = null;
  };
  const showArrows = () => {
    jp.classList.add('on');
    clearTimeout(hideJumpTimer);
    hideJumpTimer = setTimeout(() => { if (!pressedArrow) jp.classList.remove('on'); }, 1800);
  };
  const showArrowsOnScroll = () => {
    if (document.documentElement.scrollHeight >= innerHeight * 2.5) showArrows();
  };
  window.addEventListener('scroll', showArrowsOnScroll, { passive: true });
  for (const button of jp.querySelectorAll('[data-j]')) {
    const direction = button.dataset.j === 'top' ? -1 : 1;
    const step = () => window.scrollBy(0, direction * Math.max(90, innerHeight * .42));
    let held = false;
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || pressedArrow) return;
      event.preventDefault();
      pressedArrow = button;
      held = false;
      showArrows();
      button.setPointerCapture?.(event.pointerId);
      const started = performance.now();
      let previous = started;
      const scroll = (now) => {
        if (pressedArrow !== button) return;
        if (now - started >= 280) {
          held = true;
          deferFollowUntil = now + 1300;
          window.scrollBy(0, direction * Math.min(50, now - previous) * .75);
        }
        previous = now;
        jumpFrame = requestAnimationFrame(scroll);
      };
      jumpFrame = requestAnimationFrame(scroll);
    });
    button.addEventListener('pointerup', () => {
      if (pressedArrow !== button) return;
      stopArrow();
      const now = performance.now();
      deferFollowUntil = now + 1300;
      if (held) lastArrow = null;
      else if (lastArrow === button && now - lastTapAt <= 320) {
        window.scrollTo(0, direction < 0 ? 0 : document.documentElement.scrollHeight);
        lastArrow = null;
      } else {
        step();
        lastArrow = button;
        lastTapAt = now;
      }
      showArrows();
    });
    for (const event of ['pointercancel', 'lostpointercapture']) button.addEventListener(event, stopArrow);
    button.addEventListener('click', (event) => {
      if (event.detail === 0 && !event.pointerType) {
        deferFollowUntil = performance.now() + 1300;
        step();
        showArrows();
      }
    });
  }
  const vid = $('#vid', el), list = $('#list', el), bar = $('#bar', el);
  // 1.17.4: the title bar (title・↶↷・⋯) stays on top too; the player controls stick right under it
  { const hd = $('header.top', el); hd?.classList.add('st-edhead'); const fit = () => el.style.setProperty('--edh', `${hd?.offsetHeight || 0}px`); fit(); try { new ResizeObserver(fit).observe(hd); } catch {} }
  // 1.17.4: show all / only the lines not matched to the script yet / only the matched lines
  const VIEWS = { all: { t: '全', d: 'すべて表示' }, todo: { t: '未', d: '未照合だけ（照合済みはたたむ）' }, done: { t: '済', d: '照合済みだけ' }, rest: { t: '残', d: '照合できなかった文字起こし・文字にできなかった部分だけ' } };
  let view = (() => { try { return localStorage.getItem('st-view') || 'all'; } catch { return 'all'; } })(); if (!VIEWS[view]) view = 'all';
  const drawViewB = () => { const b = $('#viewB', el); b.innerHTML = `<span class="st-vico">☰</span><b>${VIEWS[view].t}</b>`; b.classList.toggle('on', view !== 'all'); b.title = VIEWS[view].d; };
  drawViewB();
  // Preserve the script position when cycling 未/済/残/全. A filtered view
  // may fold several rows into one, so retain the source-order index rather
  // than relying on a row still being present in the new DOM.
  let viewSwitchSerial = 0;
  const viewAnchor = () => {
    const stickyBottom = (el.querySelector('.st-stick')?.getBoundingClientRect().bottom || 0) + 8;
    const visible = [...list.querySelectorAll('.st-row[data-id], .st-fold1[data-oid]')];
    const hit = visible.find(x => x.getBoundingClientRect().bottom > stickyBottom) || visible.at(-1);
    const id = hit?.dataset.id || hit?.dataset.oid || null;
    const index = set.order.indexOf(id);
    return { id, index, offset: hit ? hit.getBoundingClientRect().top - stickyBottom : 0 };
  };
  const restoreViewAnchor = (anchor, serial) => {
    if (serial !== viewSwitchSerial || anchor.index < 0) return;
    const ids = set.order;
    const nodes = [...list.querySelectorAll('.st-row[data-id], .st-fold1[data-oid]')];
    let target = null, distance = Infinity;
    for (const node of nodes) {
      const k = ids.indexOf(node.dataset.id || node.dataset.oid);
      if (k < 0) continue;
      const d = Math.abs(k - anchor.index);
      if (d < distance) { distance = d; target = node; }
    }
    if (!target) return;
    const stickyBottom = (el.querySelector('.st-stick')?.getBoundingClientRect().bottom || 0) + 8;
    const desiredOffset = distance === 0 ? anchor.offset : 0;
    window.scrollBy({top: target.getBoundingClientRect().top - stickyBottom - desiredOffset, behavior: 'instant'});
  };
  // 1.19.29: window for long lists (see drawList) and goNear (it was used but never defined since 1.19.19)
  const WIN = 300, WIN_MAX = 600;
  let listFrom = 0, lastShown = [];
  const goNear = (id) => {
    if (!id) return;
    const k = set.order.indexOf(id);
    if (k < 0) return;
    if (lastShown.length > WIN_MAX) {
      let at = lastShown.findIndex((b) => b.id === id);
      if (at < 0) { const rank = (x) => set.order.indexOf(x.id); at = Math.max(0, lastShown.findIndex((b) => rank(b) >= k)); }
      if (at < listFrom || at >= listFrom + WIN) { listFrom = Math.max(0, at - WIN / 2); drawList(); }
    }
    const lim = (el.querySelector('.st-stick')?.getBoundingClientRect().bottom || 0) + 8;
    let best = null, bd = Infinity;
    for (const node of list.querySelectorAll('.st-row[data-id], .st-fold1[data-oid]')) {
      const kk = set.order.indexOf(node.dataset.id || node.dataset.oid);
      if (kk < 0) continue;
      const d = Math.abs(kk - k) + (kk < k ? 0.5 : 0);
      if (d < bd) { bd = d; best = node; }
    }
    if (best) window.scrollBy({ top: best.getBoundingClientRect().top - lim, behavior: 'instant' });
  };
  const setView = (v) => {
    const anchor = viewAnchor();
    // While playing, use the audio clock as the navigation anchor, not the
    // first visible row (which may be far away from the playback position).
    const active = !vid.paused ? blockAtTime() : null;
    const activeIndex = active ? set.order.indexOf(active.id) : -1;
    const serial = ++viewSwitchSerial;
    view = v;
    try { localStorage.setItem('st-view', view); } catch {}
    drawViewB(); drawList();
    // drawList replaces the rows. The previous highlight node and subtitle
    // cache are no longer valid, even if the active block id is unchanged.
    lastSubId = undefined;
    lastHighlightedRow = null;
    drawSub();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (serial !== viewSwitchSerial) return;
      restoreViewAnchor(activeIndex >= 0 ? {id:active.id,index:activeIndex,offset:0} : anchor, serial);
      // A folded/filtered view may hide the exact active row; resume tracking
      // immediately when it becomes visible again, without seeking the audio.
      lastSubId = undefined;
      drawSub();
    }));
  };
  $('#viewB', el).onclick = () => { setView({ all: 'todo', todo: 'done', done: 'rest', rest: 'all' }[view]); toast(VIEWS[view].d, 1500); };
  // play only the chosen sound track (screen recordings: app sound and microphone are separate tracks; never mixed)
  vid.addEventListener('loadedmetadata', () => { const at = vid.audioTracks, a = srcs[vid.dataset.src]?.audio; if (at && at.length > 1) { const k = a?.index ?? 0; for (let i = 0; i < at.length; i++) at[i].enabled = i === k; } });
  vid.addEventListener('error', () => { const s0 = srcs[vid.dataset.src]; logErr(`再生できません（コード${vid.error?.code}・${s0?.name}・${s0?.mime || '?'}・${s0?.codec || '元のまま'}）`); });

  // ---------- media ----------
  // iOS only lets a tap start sound if play() is called right away (no waiting before it), so everything here is synchronous
  let seekTo = null, seeking = false, playFromSourcePosition = false;
  // A new subtitle tap supersedes pending play() promises from earlier taps.
  let playbackRequest = 0;
  let pendingSegmentSeek = null;
  vid.addEventListener('seeked', () => {
    if (!pendingSegmentSeek || pendingSegmentSeek.request !== playbackRequest) return;
    // Do not advance to the next subtitle while the media element is seeking.
    if (vid.dataset.src === pendingSegmentSeek.sourceId &&
        Math.abs(vid.currentTime - pendingSegmentSeek.time) < 0.12) pendingSegmentSeek = null;
  });
  vid.addEventListener('loadedmetadata', () => { if (seekTo != null) { vid.currentTime = seekTo; seekTo = null; } });
  function attach(sourceId, at = null) {
    const s = srcs[sourceId]; const u = mediaURL(s);
    if (!u) return false;
    if (vid.src !== u) {
      vid.dataset.src = sourceId;
      seekTo = at;
      vid.src = u;
      el.querySelector('.st-vwrap')?.classList.toggle('audio', s.kind === 'audio');
    } else if (at != null) {
      if (vid.readyState < HTMLMediaElement.HAVE_METADATA) seekTo = at;
      else vid.currentTime = at;
    }
    return true;
  }
  function drawRelink() {
    const need = [...new Set(blocks.flatMap((b) => b.segments.map((x) => x.sourceId)))].map((id) => srcs[id]).filter((s) => s && !studioSourceFile(s));
    $('#relink', el).innerHTML = need.map((s) => `<div class="notice warn stack"><b>動画・音声ファイルが必要です</b><span class="small">${esc(s.name)}（${fmtSize(s.size)}・${fmt(s.duration)}）は端末に保存していません。同じファイルを選ぶと再生・分割ができます。文字の編集はこのままでもできます。</span>
      <label class="btn sm" for="rl_${s.id}">ファイルを選ぶ</label><input type="file" id="rl_${s.id}" data-src="${s.id}" hidden></div>`).join('');
    $$('#relink input[type=file]', el).forEach((inp) => (inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return; const s = srcs[inp.dataset.src];
      const fp = await fingerprint(f);
      if (fp.id !== s.id && !(await confirmDialog({ title: '別のファイルのようです', body: `<p class="small">選んだファイルは登録時と大きさか中身が違います（写真アプリから選ぶと、iPhoneが別の形式で書き出すことがあります）。このファイルでつなぎますか？時間がずれる可能性があります。</p>`, okLabel: 'つなぐ' }))) return;
      sessionFiles.set(s.id, f); forgetSource(s.id); drawRelink(); toast('つなぎました（この画面を閉じるまで有効）');
      if (set.sourceId === s.id) attach(s.id);
    }));
  }
  // play a block: its segments in order (may switch files)
  // cont: keep going to the next items in order (subtitles follow line by line)
  const currentRescueSearch = () => createRescueSearch(blocks, materialSourceIds(), srcs);
  let estMap = new Map(), estimateBlocks = null;
  // A no-audio script row is a navigation marker, not a reason to restart.
  // Keep the original rows and their saved timestamps untouched.
  function nextPlayableFrom(b) {
    const ids = set.order.filter((id) => byId[id]);
    const at = ids.indexOf(b?.id);
    for (let k = Math.max(0, at + 1); k < ids.length; k++) {
      const row = byId[ids[k]];
      if (row?.segments.length) return row;
    }
    return null;
  }
  function playBlock(b, loop = false, cont = false, from = null, previewNeighbours = null) {
    ++playbackRequest;
    pendingSegmentSeek = null;
    playFromSourcePosition = false;
    seeking = false;
    if (!b.segments.length) {
      if (cont) {
        const next = nextPlayableFrom(b);
        if (next) { toast('音声なしの行を飛ばして次を再生', 1400); return playBlock(next, false, true); }
        vid.pause(); playing = null; return toast('これ以降に再生できる音声はありません');
      }
      const e = estMap.get(b.id);
      if (e && attach(e.sid, e.t)) { vid.pause(); playing = null; return toast(`音声なし・推定位置 ≈${fmt(e.t)}`, 1800); }
      return toast('この項目には音声区間がありません');
    }
    let i = 0;
    if (from != null) { const k = b.segments.findIndex((x) => x.sourceId === vid.dataset.src && from >= x.start && from < x.end - 0.05); if (k >= 0) i = k; else from = null; }
    playing = { b, i, loop, cont, range: null, previewNeighbours }; curBlock = b;
    startSeg(from);
  }
  function startSeg(from = null) {
    const p = playing; if (!p) return;
    const s = p.b.segments[p.i];
    // Playback-only padding for saved speech-first matches; never rewrite their timings.
    // Explicit user seeks and manually edited blocks keep their exact requested start.
    p.range = from == null ? speechFirstPlaybackRange(p.b, s, p.previewNeighbours ?? blocks, srcs[s.sourceId]?.duration ?? Infinity) : null;
    const target = from ?? p.range?.start ?? s.start;
    const request = ++playbackRequest;
    pendingSegmentSeek = { request, sourceId: s.sourceId, time: target };
    if (!attach(s.sourceId, target)) { pendingSegmentSeek = null; playing = null; return toast('ファイルを選んでください'); }
    // If seeking is unnecessary, do not wait for an event that may never fire.
    if (vid.readyState >= 1 && !vid.seeking && Math.abs(vid.currentTime - target) < 0.025) pendingSegmentSeek = null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    // iOS requires play() in the tap's activation stack. Never await seeked before play().
    vid.play().catch((e) => { if (request !== playbackRequest) return; if (e.name === 'NotAllowedError') toast('もう一度タップしてください'); });
  }
  vid.addEventListener('ended', () => {
    if (!vid.ended || !playing?.cont) return;
    const finishedSource = vid.dataset.src;
    const next = nextSourceSegment(set.order, byId, playing, finishedSource);
    pendingSegmentSeek = null;
    if (!next) { playing = null; return; }
    playing = { ...next, cont: true, loop: false, range: null };
    curBlock = next.b;
    startSeg();
  });
  let editorPlayback = null;
  let raf = 0;
  const tick = () => {
    // Continuous playback must not re-seek at every subtitle boundary.
    // Subtitle highlighting is driven independently by the media clock.
    if (pendingSegmentSeek && !vid.seeking && vid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        vid.dataset.src === pendingSegmentSeek.sourceId) pendingSegmentSeek = null;
    if (playing?.cont && !vid.paused && !vid.seeking && !pendingSegmentSeek) {
      const t = vid.currentTime, cut = cutRanges.get(vid.dataset.src)?.find(([a, z]) => t >= a && t < z - 0.05);
      if (cut) vid.currentTime = cut[1];   // jump over sound of a deleted line
    }
    if (playing && !playing.cont && !vid.paused && !vid.seeking && !pendingSegmentSeek && vid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const s = playing.b.segments[playing.i];
      if (vid.currentTime >= (playing.range?.end ?? s.end)) {
        if (playing.i + 1 < playing.b.segments.length) { playing.i++; startSeg(); }
        else if (playing.loop) { playing.i = 0; startSeg(); }
        else { vid.pause(); playing = null; }
      }
    }
    if (editorPlayback) {
      const p = editorPlayback;
      if (!p.dlg.open) { p.cleanup?.(); editorPlayback = null; }
      else {
        const end = p.segmentEnd();
        if (p.kind === 'range' && p.seekReady && !vid.seeking && !vid.paused && end != null && vid.currentTime >= end - 0.015) { vid.pause(); playing = null; p.done = true; }
        if (p.kind === 'block' && p.started && !playing && vid.paused) p.done = true;
        const state = p.dlg.querySelector('#ePlaybackState');
        if (state) {
          const active = !vid.paused && !p.done;
          state.textContent = p.stopped ? '停止中' : p.done ? '再生終了' : active ? `再生中 ${fmt(vid.currentTime)} / ${fmt(end ?? vid.duration ?? 0)}` : p.started ? '一時停止中' : '未再生';
          const main = p.dlg.querySelector('#ePlay');
          if (main) main.innerHTML = active ? `${icon('pause')} 停止` : `${icon('play')} 再生`;
          const loop = p.dlg.querySelector('#eLoop');
          if (loop) loop.classList.toggle('on', active && p.loop);
        }
      }
    }
    if (editorPlayback?.dlg?.open) {
      editorPlayback.dlg.querySelectorAll('.st-trk[data-source-id]').forEach(track=>{
        const head=track.querySelector('.st-playhead');if(!head)return;
        head.hidden=track.dataset.sourceId!==vid.dataset.src;
        const lo=+track.dataset.lo,hi=+track.dataset.hi;
        if(hi>lo)head.style.left=Math.max(0,Math.min(100,(vid.currentTime-lo)/(hi-lo)*100))+'%';
      });
    }
    $('#tnow', el).textContent = fmt(vid.currentTime || 0);
    const sk = $('#seek', el);
    if (sk && !seeking) {
      const duration = Number.isFinite(vid.duration) ? vid.duration : 0;
      const maximum = duration || 1;
      if (+sk.max !== maximum) sk.max = maximum;
      const label = duration ? fmt(duration) : '';
      const durationLabel = $('#tdur', el);
      if (durationLabel.textContent !== label) durationLabel.textContent = label;
      sk.value = vid.currentTime || 0;
    }
    drawSub();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  cleanup = () => {
    ++playbackRequest;
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', showArrowsOnScroll);
    stopArrow();
    clearTimeout(hideJumpTimer);
    editorPlayback?.cleanup?.();
    vid.onplay = vid.onpause = null;
    vid.pause();
  };
  // The highlight follows the media clock, not just the last requested block.
  // Keep explicit single-block/loop playback pinned to its requested subtitle;
  // continuous playback may move to a later subtitle as soon as its audio starts.
  // Overlapping ASR/script records are retained; this only chooses a display row.
  function blockAtTime() {
    const t = vid.currentTime, sid = vid.dataset.src;
    if (!sid || !Number.isFinite(t)) return playing?.b || null;
    if (pendingSegmentSeek || vid.seeking || seeking) return playing?.b || curBlock || null;
    if (playing && !playing.cont) return playing.b;
    let best = null, bestStart = -Infinity, bestPriority = -1;
    for (const b of blocks) for (const s of b.segments) {
      if (s.sourceId !== sid || t < s.start || t >= s.end) continue;
      // Prefer the latest onset, then the active block, then aligned text.
      const priority = b === playing?.b ? 2 : b.aligned ? 1 : 0;
      if (s.start > bestStart || (s.start === bestStart && priority > bestPriority)) {
        best = b;
        bestStart = s.start;
        bestPriority = priority;
      }
    }
    return best || (playing?.cont ? null : playing?.b || null);
  }
  let lastSubId = null;
  let lastHighlightedRow = null;
  let lastFollowAt = 0;
  function drawSub() {
    const b = blockAtTime();
    const id = b ? b.id + '@' + b.rev : null;
    if (id === lastSubId && (!lastHighlightedRow || lastHighlightedRow.isConnected)) return;
    lastSubId = id;
    // Keep subtitle elements mounted. Replacing innerHTML on each transition
    // can flash the subtitle area on iPad WebKit, even without scrolling.
    const sub = $('#sub', el);
    if (sub) {
      let en = sub.querySelector('.st-en');
      let ja = sub.querySelector('.st-ja');
      let empty = sub.querySelector('.st-sub-empty');
      if (!en || !ja || !empty) {
        sub.replaceChildren();
        en = document.createElement('div'); en.className = 'st-en';
        ja = document.createElement('div'); ja.className = 'st-ja';
        empty = document.createElement('span'); empty.className = 'muted small st-sub-empty';
        empty.textContent = '（字幕）';
        sub.append(en, ja, empty);
      }
      const english = b?.text || '';
      const japanese = jaView.value(b);
      if (en.textContent !== english) en.textContent = english;
      if (ja.textContent !== japanese) ja.textContent = japanese;
      en.hidden = !english;
      ja.hidden = !japanese;
      empty.hidden = !!(english || japanese);
    }
    if (lastHighlightedRow?.isConnected) lastHighlightedRow.classList.remove('cur');
    let row = b ? Array.from(list.querySelectorAll('.st-row')).find(r => r.dataset.id === b.id) : null;
    if (!row && b && lastShown.length > WIN_MAX) {
      const at = lastShown.findIndex(x => x.id === b.id);
      if (at >= 0 && (at < listFrom || at >= listFrom + WIN)) { listFrom = Math.max(0, at - WIN / 4); drawList(); row = Array.from(list.querySelectorAll('.st-row')).find(r => r.dataset.id === b.id); }
    }
    if (!row && b && view === 'todo') {
      const at = set.order.indexOf(b.id);
      const folds = Array.from(list.querySelectorAll('.st-fold1[data-oid]'));
      row = folds.find((fold) => {
        const start = set.order.indexOf(fold.dataset.oid);
        const next = fold.nextElementSibling?.dataset.id;
        const end = next ? set.order.indexOf(next) : set.order.length;
        return start >= 0 && at >= start && at < end;
      }) || null;
    }
    if (row) row.classList.add('cur');
    lastHighlightedRow = row || null;
    // Follow only when the active row leaves a safe visible area; avoid stacked
    // smooth-scroll animations and never seek audio as a result of scrolling.
    if (row && !vid.paused && !seeking) {
      const now = performance.now();
      const rect = row.getBoundingClientRect();
      const top = Math.min(innerHeight * 0.38, 260);
      const bottom = innerHeight - Math.min(innerHeight * 0.22, 160);
      if (now >= deferFollowUntil && !selectMode && !arrange && now - lastFollowAt > 500 && (rect.top < top || rect.bottom > bottom)) {
        lastFollowAt = now;
        const delta = rect.top < top ? rect.top - top : rect.bottom - bottom;
        window.scrollBy({ top: delta, behavior: 'instant' });
      }
    }
  }

  // ---------- list ----------
  const holeHTML = (b) => { const t = tokensOf(b.text); return t.map((w, i) => (b.holes || []).some((h) => i >= h.s && i <= h.e) ? `<u class="st-hole">${esc(w)}</u>` : esc(w)).join(' '); };
  // Source-position navigator. Display-only: no synthetic title/subtitle blocks.
  // Gaps are ranges without a saved subtitle assignment, NOT proven silence.
  const sourceNav = $('#sourceNav', el);
  const materialSourceIds = () => [...new Set([set.sourceId, ...blocks.flatMap(b => b.segments.map(g => g.sourceId))].filter(Boolean))];
  const sourceRanges = () => {
    const ids = materialSourceIds();
    return ids.map(id => {
      const src = srcs[id]; if (!src) return null;
      const spans = blocks.flatMap(b => b.segments.filter(g => g.sourceId === id && Number.isFinite(g.start) && Number.isFinite(g.end) && g.end > g.start).map(g => ({ start: Math.max(0,g.start), end: g.end, id:b.id, aligned:!!b.aligned })));
      spans.sort((a,b) => a.start-b.start || a.end-b.end);
      const duration = spans.reduce((end, g) => Math.max(end, g.end), src.duration || 0);
      const assigned = spans.filter(g => g.aligned || byId[g.id].text.trim());
      const merged = [];
      for (const g of assigned) { const last = merged.at(-1); if (last && g.start <= last.end + .08) last.end = Math.max(last.end,g.end); else merged.push({start:g.start,end:g.end}); }
      const gaps = unassignedVocabRanges(merged, 0, duration, 1.5);
      return {id,src,spans,assigned,duration,gaps};
    }).filter(Boolean);
  };
  function jumpToSource(id, time, rowId=null) {
    if (!attach(id, time)) return toast('この音声ファイルを再生できません。ファイルを再選択してください');
    ++playbackRequest;
    pendingSegmentSeek = null;
    playing = null;
    curBlock = null;
    seeking = false;
    playFromSourcePosition = true;
    vid.pause();
    if (rowId) { setView('all'); goNear(rowId); }
    toast(`${srcs[id]?.name || '音声'} ${fmt(time)} に移動（▶で再生）`, 2200);
  }
  function drawSourceNav() {
    const ranges=sourceRanges();
    if (!ranges.length) {sourceNav.innerHTML='';return;}
    sourceNav.innerHTML = `<details class="st-source-details"><summary>音声ファイルの位置・字幕の未割当区間（${ranges.length}件）</summary>
      <p class="small muted">色のある部分は字幕に音声時刻が割り当てられた範囲です。空白は字幕未割当の可能性がある範囲で、無音とは限りません。タップで移動します（自動再解析・保存変更なし）。</p>
      ${ranges.map((r,i)=>`<div class="st-source-item"><div class="row between"><b class="small">${i+1}. ${esc(r.src.name||'音声')}</b><small class="muted">${fmt(r.duration)}</small></div>
      <div class="st-source-track" data-source-track="${esc(r.id)}" role="slider" tabindex="0" aria-label="${esc(r.src.name||'音声')} の位置" aria-valuemin="0" aria-valuemax="${Math.ceil(r.duration)}" aria-valuenow="0">
      ${r.assigned.map(g=>`<i class="${g.aligned?'aligned':'raw'}" style="left:${100*g.start/Math.max(.1,r.duration)}%;width:${Math.max(.15,100*(g.end-g.start)/Math.max(.1,r.duration))}%"></i>`).join('')}</div>
      <div class="row" style="flex-wrap:wrap"><button type="button" class="btn sm" data-source-start="${esc(r.id)}">音声の先頭へ（0秒）</button>${r.spans.length ? `<button type="button" class="btn sm ghost" data-source-first="${esc(r.id)}">最初の字幕へ</button>` : ''}${r.gaps.slice(0,12).map((g,k)=>`<button type="button" class="btn sm ghost" data-gap-source="${esc(r.id)}" data-gap-index="${k}">未割当候補 ${fmt(g.start)}–${fmt(g.end)}</button>`).join('')}${r.gaps.length>12?`<small class="muted">ほか${r.gaps.length-12}区間</small>`:''}</div></div>`).join('')}</details>`;
    sourceNav.querySelectorAll('[data-source-start]').forEach(b=>b.onclick=()=>jumpToSource(b.dataset.sourceStart,0));
    sourceNav.querySelectorAll('[data-source-first]').forEach(button => {
      button.onclick = () => {
        const range = ranges.find(r => r.id === button.dataset.sourceFirst);
        const first = range?.spans[0];
        if (first) jumpToSource(range.id, first.start, first.id);
      };
    });
    sourceNav.querySelectorAll('[data-gap-source]').forEach(button => {
      button.onclick = () => {
        const range = ranges.find(r => r.id === button.dataset.gapSource);
        const gap = range?.gaps[Number(button.dataset.gapIndex)];
        if (gap) openSourceGap(range.id, gap, range.src.name);
      };
    });
    sourceNav.querySelectorAll('[data-source-track]').forEach(track=>{
      track.onclick=e=>{const r=ranges.find(x=>x.id===track.dataset.sourceTrack);if(!r)return;const rect=track.getBoundingClientRect();jumpToSource(r.id,Math.min(r.duration,Math.max(0,(e.clientX-rect.left)/rect.width*r.duration)));};
      track.onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;e.preventDefault();const r=ranges.find(x=>x.id===track.dataset.sourceTrack);if(r)jumpToSource(r.id,0);};
    });
  }
  function openSourceGap(sourceId, gap, name) {
    const dlg = $('#dialog');
    if (dlg.open) return;
    const previewEnd = Math.min(gap.end, gap.start + 12);
    dlg.innerHTML = `<form method="dialog" class="dlg stack">
      <h3>字幕の未割当候補</h3><p>${esc(name)} ${fmt(gap.start)}〜${fmt(gap.end)}</p>
      <button type="button" class="btn" id="gapPreview">▶ 試聴（最大12秒）</button>
      <button class="btn primary" value="analyze">この区間を文字起こし・照合</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    $('#gapPreview', dlg).onclick = () => playBlock({segments:[{sourceId,start:gap.start,end:previewEnd}]});
    dlg.returnValue = '';
    dlg.onclose = () => {
      ++playbackRequest;
      vid.pause();
      playing = null;
      if (dlg.returnValue === 'analyze' && revision === routeRevision)
        importBySpeechStructure({ sourceId, ...gap });
    };
    dlg.showModal();
  }
  function drawList() {
    const rs = ops.ranges(set.order.filter((id) => byId[id]), sel);
    $('#info', el).textContent = `${blocks.length}項目${selectMode ? `・選択 ${rs.length}範囲 ${sel.size}項目` : ''}${(set.undo || []).length ? `・元に戻せる操作 ${set.undo.length}` : ''}`;
    if (estimateBlocks !== blocks) {
      estMap = currentRescueSearch().estimates();
      estimateBlocks = blocks;
    }
    // 1.17.7: a line whose sound starts before the previous line's sound ended (same file): both play the overlap
    const overlap = new Map(); { let pv = null; for (const id of set.order) { const x = byId[id]; if (!x?.segments.length) continue; const g = x.segments[0]; if (pv && pv.sourceId === g.sourceId && pv.end > g.start + 0.15 && pv.start < g.start) overlap.set(x.id, +(pv.end - g.start).toFixed(1)); pv = x.segments.at(-1); } }
    const base = onlySel ? blocks.filter((b) => sel.has(b.id)) : blocks;
    const filtering = view !== 'all' && !arrange; // Keep 未/済/残 filters visible while selecting rows.
    const isRest = (b) => !b.aligned && b.segments.length && (b.asr || !b.text.trim());   // left over from transcription / matching
    const shown = !filtering ? base : view === 'done' ? base.filter((b) => !needsWork(b) && !isSymbolRow(b)) : view === 'rest' ? base.filter(isRest) : base.filter(needsWork);
    // "未" view: each run of matched lines becomes one folded line (tap = show all)
    const folds = new Map();
    if (filtering && view === 'todo') { let run = 0, first = null; const flush = (nextId) => { if (run) folds.set(nextId ?? '__end', { n: run, from: first }); run = 0; first = null; };
      for (const b of base) { if (!needsWork(b)) { if (!run) first = b; run++; } else flush(b.id); } flush(null); }
    const foldHTML = (f) => `<div class="st-fold1" data-unfold="1" data-oid="${f.from.id}">✓ 済み ${f.n}行（${fmt(f.from.segments[0]?.start)}〜）<small class="muted">タップで全表示</small></div>`;
    list.classList.toggle('arranging', arrange);
    const firstBySource = new Map();
    for (const b of blocks) for (const g of b.segments) if (!firstBySource.has(g.sourceId)) firstBySource.set(g.sourceId,b.id);
    // 1.19.29: very long lists (a whole 金フレ script) draw only a window of rows; the rest is one tap away
    lastShown = shown;
    const windowed = shown.length > WIN_MAX;
    listFrom = windowed ? Math.max(0, Math.min(listFrom, shown.length - WIN)) : 0;
    const rowsShown = windowed ? shown.slice(listFrom, listFrom + WIN) : shown;
    const winBar = (dir, n) => `<div class="notice row small st-winbar"><span class="grow">${dir < 0 ? '前' : '後'}に ${n}行（全${shown.length}行のうち ${listFrom + 1}〜${listFrom + rowsShown.length} を表示中）</span><button class="btn sm" data-win="${dir}">${dir < 0 ? '前の' : '次の'}${Math.min(WIN / 2, n)}行を表示</button></div>`;
    list.innerHTML = (windowed && listFrom > 0 ? winBar(-1, listFrom) : '') + rowsShown.map((b) => (folds.has(b.id) ? foldHTML(folds.get(b.id)) : '') + (() => {
      const badges = [b.segments.length > 1 ? `<span class="tagp">${b.segments.length}区間</span>` : '', new Set(b.segments.map((s) => s.sourceId)).size > 1 ? '<span class="tagp">複数ファイル</span>' : '',
        b.unconfirmed ? '<span class="tagp warn">一括仮割当・未確認</span>' : b.sync === 'estimated' ? '<span class="tagp warn">時間は推定</span>' : '', overlap.has(b.id) ? `<span class="tagp warn" title="前の行と音声が重なっています。✎で開始を動かすと前の行の終わりも合わせて動きます">前と${overlap.get(b.id)}秒重なり</span>` : '', b.rep > 1 ? `<span class="tagp" title="音声では${b.rep}回読まれます（区間は${b.endEst ? '次の行まで・推定' : '確定'}）">×${b.rep}</span>` : '', b.asr && !b.aligned ? '<span class="tagp">自動起こし</span>' : '', b.aligned ? '<span class="tagp">スクリプト照合</span>' : '', b.trimNote ? `<span class="tagp">前後カット済み</span>` : '', !b.segments.length && !isSymbolRow(b) ? '<span class="tagp">音声未割当</span>' : ''].join('');
      const sourceStart = [...firstBySource].filter(([sid,id])=>id===b.id).map(([sid])=>`<div class="st-source-boundary">音声開始：${esc(srcs[sid]?.name||'音声ファイル')} <button type="button" class="btn sm ghost" data-source-row="${esc(sid)}" data-row="${esc(b.id)}">位置へ</button></div>`).join('');
      return `${sourceStart}<div class="st-row ${sel.has(b.id) ? 'sel' : ''} ${arrange ? 'jig' : ''}" data-id="${b.id}">
        ${selectMode ? `<span class="st-chk" data-chk="${b.id}">${sel.has(b.id) ? '☑' : '☐'}</span>` : ''}
        <span class="grow st-txt" data-play="${b.id}"><small class="muted">${b.segments.length ? `${fmt(b.segments[0]?.start)}–${fmt(b.segments.at(-1)?.end)}` : estMap.has(b.id) ? `≈${fmt(estMap.get(b.id).t)}（推定）` : '--:--'} ${badges}</small>
          ${b.label ? `<b class="small">${esc(b.label)}</b>` : ''}<span class="st-en2">${holeHTML(b) || `<span class="muted">（英文なし${b.label ? '・✎で追加' : ''}）</span>`}</span><span class="st-ja2">${esc(jaView.value(b))}</span>${jaView.needsReview(b) ? (!arrange && !selectMode ?
            `<button type="button" class="link small warn-text" data-ja-edit="${esc(b.id)}">訳を要確認</button>` :
            '<span class="small warn-text">訳を要確認</span>') : ''}</span>
        ${arrange ? `<span class="st-grip" data-grip="${b.id}" aria-label="ドラッグ">≡</span>` : selectMode ? '' : `${!b.segments.length && b.text.trim() && !isSymbolRow(b) ? `<button type="button" class="btn xs ghost" data-rescue="${b.id}">音声を割当</button>` : ''}${(b.sync === 'estimated' || b.unconfirmed) && b.segments.length ? `<button type="button" class="btn xs ghost" data-confirm-row="${b.id}" title="試聴した時刻のまま確定">確定</button>` : ''}${b.sync === 'estimated' && b.segments.length && !b.unconfirmed ? `<button type="button" class="btn xs ghost" data-reestimate="${b.id}">前後から再推定</button>` : ''}<button class="icon-btn" data-edit="${b.id}" aria-label="編集">✎</button>`}</div>`;
    })()).join('') + (folds.has('__end') ? foldHTML(folds.get('__end')) : '') + (windowed && listFrom + WIN < shown.length ? winBar(1, shown.length - listFrom - WIN) : '') || `<p class="empty">${filtering ? (view === 'done' ? '照合済みの行はまだありません' : view === 'rest' ? '残っている文字起こしはありません' : '未照合の行はありません（すべて照合済み）') : '項目がありません'}</p>`;
    if (filtering && view === 'rest' && shown.length) {
      list.insertAdjacentHTML('afterbegin', `<div class="notice row small"><span class="grow">スクリプトと照合できなかった文字起こし・文字にできなかった部分：${shown.length}行</span><button class="btn sm" id="restRedo">起こし直す→照合</button><button class="btn sm danger" id="restDel">すべて削除</button></div>`);
      $('#restRedo', list).onclick = () => redoAsr(shown, { thenAlign: true });
      $('#restDel', list).onclick = async () => {
        if (!(await confirmDialog({ title: `${shown.length}行を削除`, body: '<p class="small">音声ファイル自体は消えません（ほかの行で使っていなければ「容量の整理」で消せます）。↶で戻せます。</p>', okLabel: '削除する', danger: true }))) return;
        const ids = new Set(shown.map((b) => b.id));
        await run('残りの文字起こしを削除', { blocks: shown.map((b) => ({ ...b, deleted: true, userDel: true })), order: set.order.filter((id) => !ids.has(id)) });
        toast(`${ids.size}行を削除しました（↶で戻せます）`, 2500);
      };
    }
    $$('[data-rescue]', list).forEach(x => x.onclick = () => rescueUnassigned(x.dataset.rescue));
    $$('[data-reestimate]', list).forEach(x => x.onclick = () => reestimateFromNeighbours(x.dataset.reestimate));
    $$('[data-confirm-row]', list).forEach(x => x.onclick = (e) => { e.stopPropagation(); confirmRow(x.dataset.confirmRow); });
    $$('[data-source-row]', list).forEach(x=>x.onclick=()=>{const b=byId[x.dataset.row];jumpToSource(x.dataset.sourceRow,b?.segments.find(g=>g.sourceId===x.dataset.sourceRow)?.start||0,b?.id);});
    $$('[data-unfold]', list).forEach((x) => (x.onclick = () => { const id = x.dataset.oid; setView('all'); goNear(id); }));
    $$('[data-win]', list).forEach((x) => (x.onclick = () => { const an = viewAnchor(); listFrom += Number(x.dataset.win) * (WIN / 2); drawList(); restoreViewAnchor(an, viewSwitchSerial); }));
    $('#undoB', el).disabled = !(set.undo || []).length; $('#redoB', el).disabled = !(set.redo || []).length;
    const nScript = scriptLines().length, nAudio = blocks.filter((b) => b.segments.length && !b.aligned).length;
    $('#alignNote', el).innerHTML = nScript && nAudio && !selectMode && !arrange ? `<div class="notice row small"><span class="grow">音声の付いていないスクリプトが${nScript}行あります。</span><button class="btn sm primary" id="alignGo">文字起こし→照合</button></div>` : '';
    $('#alignGo', el)?.addEventListener('click', () => runAlign());
    // a deep swipe to the left shows 削除 (undo ↶ brings it back)
    if (!selectMode && !arrange && !onlySel) swipeToDelete($$('.st-row', list), async (row) => {
      const b = byId[row.dataset.id]; if (!b) return false;
      await run('削除', { blocks: [{ ...b, deleted: true, userDel: true }], order: set.order.filter((id) => id !== b.id) });
      toast('削除しました（↶ で戻せます）', 2500); return true;
    }, { width: 96, openAt: 130 });
    drawBar();
    drawSourceNav();
  }
  function drawBar() {
    bar.hidden = !selectMode && !arrange;
    if (arrange) {
      const n0 = (set.undo || []).length - arrangeBase;
      bar.innerHTML = `<div class="small">≡ をつかんで動かします。<b>行の上に重ねる</b>と結合、<b>行と行の間</b>に置くと移動。行をタップすると分けられます。</div>
        <div class="row"><button class="btn sm" id="arrUndo" ${(set.undo || []).length ? '' : 'disabled'} aria-label="元に戻す">${icon('undo')}</button><button class="btn sm" id="arrRedo" ${(set.redo || []).length ? '' : 'disabled'} aria-label="やり直す">${icon('redo')}</button>
        <button class="btn sm" id="arrCancel">キャンセル${n0 > 0 ? `（${n0}件）` : ''}</button><button class="btn sm primary grow" id="arrDone">完了</button></div>`;
      $('#arrDone', bar).onclick = () => { const an = viewAnchor(); arrange = false; drawList(); restoreViewAnchor(an, viewSwitchSerial); };
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
    $('#sAll', bar).onclick = () => { (lastShown.length ? lastShown.map((b) => b.id) : [...list.querySelectorAll('.st-row[data-id]')].map((row) => row.dataset.id)).forEach((id) => sel.add(id)); drawList(); };
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
    const ja = e.target.closest('[data-ja-edit]'); if (ja) return editStudioJa(byId[ja.dataset.jaEdit]);
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

  async function inspectMaBoundaries() {
    const snapshot = set.order.map(id => byId[id]).filter(Boolean);
    const seams = maSeams(snapshot);
    if (!seams.length) return toast('検査できるMA型の字幕境界がありません');
    const guard = rescueVersion();
    if (!(await confirmDialog({
      title: 'MA型の音声境界を検査',
      body: '<p>字幕の開始・終了付近を検査し、切れや隣接文の混入が疑われる箇所だけ端末内で再認識します。</p><p>確認画面で補正前後を試聴し、適用する候補を選べます。</p>',
      okLabel: '検査する',
    })) || revision !== routeRevision) return;
    const progress = document.createElement('dialog');
    progress.className = 'st-speech-pick';
    progress.innerHTML = '<form method="dialog" class="dlg stack"><h3>音声境界の検査</h3><p aria-live="polite"></p><button class="btn ghost">中止</button></form>';
    document.body.append(progress);
    const say = message => { progress.querySelector('p').textContent = message; };
    let tr, cancelled = false;
    const stop = () => { cancelled = true; tr?.close(); };
    progress.addEventListener('close', stop);
    progress.showModal();
    const available = new Map(), proposals = [], held = [], skipped = new Set();
    const decodeRange = async (read, window) => {
      const clip = await read(window.start, window.end);
      const { audio } = await decodeTo16k(clip.blob);
      const first = Math.max(0, Math.ceil(((clip.from ?? window.start) - clip.start) * 16000));
      const last = Math.min(audio.length, Math.floor(((clip.to ?? window.end) - clip.start) * 16000));
      return { audio: audio.subarray(first, last), start: clip.start + first / 16000 };
    };
    let checked = 0, unchanged = 0, asrFailed = '';
    const fmtPrecise = t => t.toFixed(3) + '秒';
    try {
      for (const [index, seam] of seams.entries()) {
        if (cancelled || !progress.open || revision !== routeRevision) return;
        const src = srcs[seam.sourceId];
        if (!available.has(seam.sourceId)) {
          const blob = src?.stored ? src.blob : sessionFiles.get(seam.sourceId);
          let read = null;
          if (blob && src.duration > 0) {
            if (isContainer(src, blob)) {
              const info = await probe(blob, { presentation: true }).catch(() => null);
              const tracks = info ? audioTracks(info) : [];
              const track = tracks.find(t => t.id === src.audio?.trackId) ||
                (src.audio?.index != null ? tracks[src.audio.index] : tracks.length === 1 ? tracks[0] : null);
              if (track?.presentation && canExtract(track)) read = (a, b) => extractPresentationRange(blob, track, a, b);
            } else read = await wavRangeReader(blob).catch(() => null);
          }
          available.set(seam.sourceId, read);
        }
        const read = available.get(seam.sourceId);
        if (!read) { skipped.add(src?.name || seam.sourceId); continue; }
        const label = [seam.left?.text, seam.right?.text].filter(Boolean).map(t => t.slice(0, 85)).join(' / ');
        const window = maWindow(seam, src.duration, 1.05);
        if (!window) { held.push({ label, reason: '字幕間の大きな空白・重複を確認してください' }); continue; }
        if (window.end - window.start < .2) continue;
        say(`境界 ${index + 1} / ${seams.length} を検査中`);
        let reason;
        try {
          const clip = await decodeRange(read, window);
          reason = inspectMaSeam(seam, clip.audio, clip.start);
          checked++;
          if (!reason) continue;
          if (asrFailed) { held.push({ label, reason: reason + '・認識を利用できません' }); continue; }
          const local = maWindow(seam, src.duration, 3.4);
          const input = await decodeRange(read, local);
          if (cancelled || !progress.open || revision !== routeRevision) return;
          say(`境界 ${index + 1} / ${seams.length} を局所再照合中`);
          let chunks;
          try {
            tr ||= openTranscriber('en', say, { quality: 'acc' });
            chunks = await tr.run(input.audio.slice(), { timestamps: 'word' });
          } catch (error) {
            asrFailed = error?.message || String(error);
            held.push({ label, reason: '単語時刻を取得できません' }); continue;
          }
          if (cancelled || !progress.open || revision !== routeRevision) return;
          const result = proposeMaSeam(seam, chunks.map(c => ({ ...c, start: c.start + input.start, end: c.end + input.start })), src.duration,
            { start: input.start, end: input.start + input.audio.length / 16000 });
          if (result.changes.length) proposals.push({ ...result, label, reason });
          else if (result.reason) held.push({ label, reason: result.reason });
          else unchanged++;
        } catch (error) {
          held.push({ label, reason: '区間を読み出せません。' + (error?.message || error) });
        }
      }
      if (!progress.open || revision !== routeRevision) return;
    } finally {
      progress.removeEventListener('close', stop);
      tr?.close();
      progress.remove();
    }
    const dlg = $('#dialog');
    const confirm = confirmDialog({
      title: 'MA型の音声境界を確認',
      body: `<p>${checked}境界を検査・補正候補 ${proposals.length}件・要確認 ${held.length}件。${unchanged ? ` 再照合で変更不要 ${unchanged}件。` : ''}</p>
        ${skipped.size ? `<p>区間抽出に対応したAACのM4A／MP4またはPCM WAVが必要です。対象外 ${skipped.size}ファイル。</p>` : ''}
        ${asrFailed ? `<p>${esc(asrFailed)}</p>` : ''}
        ${proposals.length ? '<p>試聴して適用する境界を選んでください。適用後は↶で元に戻せます。</p>' : ''}
        <div class="stack" style="max-height:50dvh;overflow:auto">${proposals.map((p, i) => `<div class="stack">
          <label class="chk"><input type="checkbox" data-ma-pick="${i}"> ${esc(p.label)}（信頼度 ${p.confidence === 'high' ? '高' : '中'}）</label>
          <small>${esc(p.reason)}</small>
          ${p.changes.map(({ row, side, time }, j) => `<div class="row wrap"><small>${side === 'start' ? '開始' : '終了'} ${fmtPrecise(row.segments[0][side])} → ${fmtPrecise(time)}</small>
            <button type="button" class="btn sm" data-ma-play="${i}:${j}:old">補正前</button>
            <button type="button" class="btn sm" data-ma-play="${i}:${j}:new">補正後</button></div>`).join('')}</div>`).join('')}
          ${held.length ? `<details><summary>要確認 ${held.length}件</summary>${held.map(p => `<p class="small">${esc(p.label)}<br>${esc(p.reason)}</p>`).join('')}</details>` : ''}</div>`,
      okLabel: proposals.length ? '選択分を適用' : '閉じる', cancelLabel: proposals.length ? 'キャンセル' : null,
    });
    let previewing = false;
    for (const button of $$('[data-ma-play]', dlg)) button.onclick = () => {
      const [i, j, version] = button.dataset.maPlay.split(':');
      const proposal = proposals[Number(i)];
      const { row } = proposal.changes[Number(j)];
      if (version === 'old') {
        previewing = true;
        playBlock(row);
        return;
      }
      const updates = maBoundaryUpdates(snapshot, [proposal]);
      if (!updates) return toast('この補正は別の字幕区間と競合しています');
      const replacements = new Map(updates.map(row => [row.id, row]));
      previewing = true;
      playBlock(replacements.get(row.id), false, false, null, blocks.map(b => replacements.get(b.id) ?? b));
    };
    const ok = await confirm;
    if (previewing) { ++playbackRequest; pendingSegmentSeek = null; playing = null; vid.pause(); }
    if (!ok || !proposals.length || revision !== routeRevision) return;
    const picked = $$('[data-ma-pick]:checked', dlg).map(input => proposals[Number(input.dataset.maPick)]);
    const updates = maBoundaryUpdates(snapshot, picked);
    if (!updates) return toast('選んだ補正が別の字幕区間と競合しています。選択を見直してください', 5000);
    if (updates.length) await run('MA型の音声境界を補正', { blocks: updates, guardedSet: guard });
  }

  // Conservative, offline bulk boundary refinement. No ASR, no new subtitles, no new media.
  // Speech activity alone cannot distinguish adjacent spoken words: leave ambiguous boundaries unchanged.
  async function refineBoundaries() {
    const eligible = blocks.filter((b) => b.text.trim() && b.segments.length === 1 && b.sync !== 'manual');
    if (!eligible.length) return toast('自動調整できる字幕がありません（手動調整済みは保護）', 4000);
    if (!(await confirmDialog({ title: '音声位置を一括自動調整（試験版）', body: `<p>${eligible.length}行の音声の前後を、音量と無音区間から最大0.35秒だけ補正します。</p><p>単語の発音を認識して照合する機能ではありません。連続した発話・曖昧な境界は変更しません。削除済み字幕は復元せず、手動調整済みの行も変更しません。</p><p>変更は1回の↶で元に戻せます。元音声は変更しません。</p>`, okLabel: '解析する' }))) return;
    const bySource = new Map();
    for (const b of eligible) { const sid = b.segments[0].sourceId; if (!bySource.has(sid)) bySource.set(sid, []); bySource.get(sid).push(b); }
    const updates = [], skipped = [];
    const guard = rescueVersion();
    try {
      for (const [sid, items] of bySource) {
        const src = srcs[sid], blob = src?.stored ? src.blob : sessionFiles.get(sid);
        if (!blob) { skipped.push(src?.name || sid); continue; }
        const info = isContainer(src, blob) ? await probeSource(src, blob).catch(() => null) : null;
        const tracks = info ? audioTracks(info) : [];
        const track = tracks.find(t => t.id === src.audio?.trackId) || tracks[src.audio?.index ?? 0];
        const ranged = Boolean(track && canExtract(track));
        if (!ranged && (!(src.duration > 0 && src.duration <= 180) || blob.size > 18 * 1024 * 1024)) {
          skipped.push(src.name); continue;
        }
        toast(`音声を解析中：${src.name}`, 2500);
        const allSegments = blocks.flatMap(b => b.segments.filter(g => g.sourceId === sid).map(g => ({ ...g, id: b.id })));
        const windows = new Map();
        for (const b of items) {
          const segment = b.segments[0], start = ranged ? Math.floor(segment.start / 20) * 20 : 0;
          if (ranged && segment.end > start + 45) continue;
          if (!windows.has(start)) windows.set(start, []);
          windows.get(start).push(b);
        }
        for (const [from, lines] of windows) {
          if (revision !== routeRevision) return;
          const to = Math.max(...lines.map(b => b.segments[0].end)) + .45;
          const input = ranged ? await extractTrack(blob, track, Math.max(0, from - .45), to) : { blob, start: 0 };
          const { audio } = await decodeTo16k(input.blob);
          const offset = input.start;
          const sr = 16000, hop = 160, frame = 320;
          const n = Math.floor(Math.max(0, audio.length - frame) / hop) + 1;
          const rms = new Float32Array(n);
          for (let i = 0; i < n; i++) { let e = 0; const off = i * hop; for (let j = 0; j < frame; j += 2) e += audio[off+j] ** 2; rms[i] = Math.sqrt(e / (frame / 2)); }
          // Dynamic floor estimate, avoids a hard-coded volume threshold.
          const sampled = []; for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) sampled.push(rms[i]);
          sampled.sort((a,b)=>a-b);
          const noise = sampled[Math.floor(sampled.length * .2)] || 0;
          const peak = sampled[Math.floor(sampled.length * .9)] || 0;
          const threshold = Math.max(.0015, noise * 3, peak * .13);
          const voiced = (i) => i >= 0 && i < n && rms[i] >= threshold;
          const at = (t) => Math.max(0, Math.min(n-1, Math.round((t - offset) * 100)));
          for (const b of lines) {
            const g = b.segments[0], a = at(g.start), z = at(g.end);
            if (z <= a + 10) continue;
            // Find silence immediately near the edges. Never extend into another retained block.
            let leftLimit = 0, rightLimit = src.duration || (offset + audio.length / sr);
            for (const q of allSegments) {
              if (q.id === b.id) continue;
              if (q.end <= g.start + .02) leftLimit = Math.max(leftLimit, q.end);
              if (q.start >= g.end - .02) rightLimit = Math.min(rightLimit, q.start);
            }
            const l = at(Math.max(leftLimit, g.start - .35)), r = at(Math.min(rightLimit, g.end + .35));
            let start = g.start, end = g.end;
            // Only move a boundary if a stable quiet-to-voiced transition exists nearby.
            const transitions = (lo, hi, opening) => { const out = []; for (let i = Math.max(4,lo); i < Math.min(n-5,hi); i++) {
              const before = [i-4,i-3,i-2,i-1].filter(voiced).length;
              const after = [i+1,i+2,i+3,i+4].filter(voiced).length;
              if (opening ? before === 0 && after >= 3 : before >= 3 && after === 0) out.push(i);
            } return out; };
            const starts = transitions(l, Math.min(z-8,a+35), true);
            const ends = transitions(Math.max(a+8,z-35), r, false);
            const choose = (arr, old, margin, lo, hi) => {
              if (!arr.length || arr.at(-1) - arr[0] > 3) return old;
              const candidate = Math.max(lo, Math.min(hi, offset + (arr[0] + arr.at(-1)) / 200 + margin));
              return Math.abs(candidate - old) <= .35 ? candidate : old;
            };
            start = choose(starts, g.start, -.04, leftLimit, g.start + .35);
            end = choose(ends, g.end, .05, g.end - .35, rightLimit);
            if (end - start < .12) continue;
            if (Math.abs(start-g.start) < .025 && Math.abs(end-g.end) < .025) continue;
            updates.push({ ...b, segments: [{ ...g, start: +start.toFixed(2), end: +end.toFixed(2) }], sync: 'estimated' });
          }
        }
      }
      // Reject a pair of proposed moves if they compete for the same quiet gap.
      const rejected = new Set();
      const ordered = updates.slice().sort((a, b) => a.segments[0].sourceId.localeCompare(b.segments[0].sourceId) || a.segments[0].start - b.segments[0].start);
      let prior;
      for (const row of ordered) {
        const g = row.segments[0], p = prior?.segments[0];
        if (p?.sourceId === g.sourceId && p.end > g.start) { rejected.add(prior.id); rejected.add(row.id); }
        if (p?.sourceId !== g.sourceId || g.end > p.end) prior = row;
      }
      for (let i = updates.length - 1; i >= 0; i--) if (rejected.has(updates[i].id)) updates.splice(i, 1);
      if (!updates.length) return toast(`安全に補正できる境界はありませんでした${skipped.length ? '（一部のファイルは対象外）' : ''}`, 5500);
      const okPromise = confirmDialog({ title: '一括補正の確認', body: `<p>${eligible.length}行のうち<strong>${updates.length}行</strong>に補正候補があります。${skipped.length ? `${skipped.length}ファイルは解析対象外です。` : ''}</p><p>補正は音量に基づく推定です。↶で取り消せます。</p>
        ${updates.slice(0, 12).map((b, i) => `<div class="row wrap"><span class="grow">${esc(b.text.slice(0, 90))}</span><button type="button" class="btn sm" data-before="${i}">補正前</button><button type="button" class="btn sm" data-after="${i}">補正後</button></div>`).join('')}`, okLabel: `${updates.length}行を適用` });
      for (const button of $$('[data-before], [data-after]', $('#dialog'))) button.onclick = () => {
        const index = Number(button.dataset.before ?? button.dataset.after);
        playBlock(button.dataset.before == null ? updates[index] : byId[updates[index].id]);
      };
      const ok = await okPromise;
      if (playing && updates.some(b => b.id === playing.b.id)) {
        ++playbackRequest; pendingSegmentSeek = null; playing = null; vid.pause();
      }
      if (ok && revision === routeRevision) await run('音声位置の一括自動調整', { blocks: updates, guardedSet: guard });
    } catch (e) { toast(`自動調整できませんでした：${e?.message || e}`, 6000); }
  }

  // Read-only, zero-cost structural re-alignment preview. Existing recognised cues only.
  // No network, model download, or persistent cache; never resurrect deleted blocks.
  async function previewStructuralRealign() {
    const active = set.order.map(id => byId[id]).filter(b => b && b.text.trim() && b.segments.length === 1);
    const cues = blocks.filter(b => b.asr && !b.aligned && b.segments.length === 1 && b.text.trim())
      .map(b => ({ id:b.id, sourceId:b.segments[0].sourceId, start:b.segments[0].start, end:b.segments[0].end, text:b.text, tokens:tokensOf(b.text) }))
      .sort((a,b)=>a.sourceId.localeCompare(b.sourceId)||a.start-b.start);
    const dlg = $('#dialog');
    if (!active.length) return toast('音声のある字幕がありません');
    const profile = await new Promise(resolve => {
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>構造を使った再照合（プレビュー）</h3><p class="small">既存の文字起こしと元音声の発話区間を組み合わせます。元の字幕や音声は変更しません。外部通信・課金なし。</p><label>教材の収録形式<select name="profile"><option value="auto">自動（音声の規則性を分析）</option><option value="vocab">単語 → 例文 → 例文の繰り返し</option><option value="conversation">会話・まとまった文章</option><option value="alternate">英語と日本語が交互</option><option value="generic">その他・形式不明</option></select></label><p class="small muted">音声の無音・長さ・繰り返し傾向を分析します。ただし音量だけでは単語の内容を識別できません。認識結果がない場合、位置の自動確定はしません。</p><button class="btn primary" value="go">候補を調べる</button><button class="btn ghost" value="cancel">キャンセル</button></form>`;
      dlg.onclose=()=>resolve(dlg.returnValue==='go'?dlg.querySelector('[name=profile]')?.value:null);
      // capture selection before dialog closes (Safari dialog contents persist)
      dlg.showModal();
    });
    if (!profile) return;
    // Analyze each attached source once, in memory only. Strict cap protects mobile devices.
    const regionBySource = new Map(), audioNotes=[];
    for (const sid of [...new Set(active.map(b=>b.segments[0].sourceId))]) {
      const src=srcs[sid], blob=src?.stored?src.blob:sessionFiles.get(sid);
      if (!blob) {audioNotes.push(`${src?.name||sid}: 音声ファイル未接続`);continue;}
      if (blob.size>25*1024*1024 || (src.duration||0)>12*60) {audioNotes.push(`${src.name}: iPhone負荷を避けるため解析を省略（25MB・12分上限）`);continue;}
      try {
        toast(`発話区間を解析中：${src.name}`,2500);
        const decoded=await sourceAudio16k(src,blob);
        const regions=speechRegions(decoded.audio,16000);
        regionBySource.set(sid,regions);
        const st=regionStatistics(regions);
        audioNotes.push(`${src.name}: 発話候補 ${st.count}件、間隔中央値 ${st.medianGap?.toFixed(2)??'—'}秒、長さ中央値 ${st.medianDuration?.toFixed(2)??'—'}秒、隣接する同程度の長さ ${st.repeats}組`);
      } catch(e) {audioNotes.push(`${src.name}: 解析できませんでした（${e?.message||e}）`);}
    }
    const normal = text => tokensOf(text).map(x => String(x).toLowerCase().replace(/[^a-z0-9']/g,''));
    const proposals = [], missing=[];
    const used = new Set();
    // Exact whole-utterance matches only. A word inside a sentence is NEVER a headword candidate.
    // Source and chronological order are hard constraints; missing/deleted utterances may be skipped.
    const lastBySource = new Map();
    for (const b of active) {
      if (b.sync === 'manual') continue;
      const g=b.segments[0], want=normal(b.text);
      if (!want.length) continue;
      const last=lastBySource.get(g.sourceId)??-Infinity;
      const candidates=cues.filter(c=>c.sourceId===g.sourceId&&!used.has(c.id)&&c.start>=last-0.02&&
        c.tokens.length===want.length&&normal(c.text).join(' ')===want.join(' '));
      if (!candidates.length) { missing.push(b); continue; }
      // Prefer an independently recognised, full utterance. Multiple identical readings
      // cannot be safely disambiguated without additional evidence.
      const ranked=candidates.map(c=>({c, distance:Math.abs(c.start-g.start)})).sort((a,b)=>a.distance-b.distance);
      const best=ranked[0];
      if (ranked.length>1 && ranked[1].distance-best.distance<1.5) { missing.push(b); continue; }
      used.add(best.c.id); lastBySource.set(g.sourceId,best.c.end);
      if (Math.abs(best.c.start-g.start)<.08&&Math.abs(best.c.end-g.end)<.08) continue;
      const snapped=snapCueToRegion(best.c,regionBySource.get(g.sourceId)||[]);
      // Region must agree with an independent transcript; it never establishes words itself.
      proposals.push({b,g,c:snapped?{...best.c,start:snapped.start,end:snapped.end}:best.c, snapped:!!snapped});
    }
    const desc = profile==='auto'?'音声構造を自動解析（文字起こし一致が必須）':profile==='vocab'?'単語・例文（全文一致のみ）':profile==='conversation'?'会話（発話全文一致のみ）':profile==='alternate'?'英日交互（発話全文一致のみ）':'一般（発話全文一致のみ）';
    dlg.innerHTML=`<form method="dialog" class="dlg stack"><h3>再照合の候補</h3><p class="small">${esc(desc)}。認識済み候補 ${cues.length}件、変更候補 ${proposals.length}件、照合不能 ${missing.length}件。<strong>元音声の再認識は行っていません。</strong></p><details><summary>音声構造の解析結果</summary><p class="small">${audioNotes.map(esc).join('<br>')}</p></details>${!cues.length?'<p class="notice warn">照合に使える独立した文字起こしが残っていません。既存の誤対応をもとに再推定すると誤りを繰り返すため、変更しません。</p>':''}<div style="max-height:45vh;overflow:auto">${proposals.slice(0,80).map((x,i)=>`<label class="row small" style="padding:6px 0;border-bottom:1px solid #aaa4"><input type="checkbox" data-proposal="${i}" checked><span class="grow">${esc(x.b.text.slice(0,75))}<br><span class="muted">${fmt(x.g.start)}–${fmt(x.g.end)} → ${fmt(x.c.start)}–${fmt(x.c.end)} ${x.snapped?'（無音境界で補正）':'（認識時刻）'}</span></span></label>`).join('')}</div>${proposals.length?'<p class="small muted">選択した候補のみ適用します。1回のUndoで取り消せます。音声は複製しません。</p><button class="btn primary" value="apply">選択分を適用</button>':''}<button class="btn ghost" value="cancel">閉じる</button></form>`;
    const selected=await new Promise(resolve=>{
      dlg.onclose=()=>resolve(dlg.returnValue==='apply'?[...dlg.querySelectorAll('[data-proposal]:checked')].map(x=>+x.dataset.proposal):null);
      dlg.showModal();
    });
    if (!selected?.length) return;
    const updates=selected.map(i=>proposals[i]).filter(Boolean).map(x=>({...x.b,segments:[{...x.g,start:x.c.start,end:x.c.end}],sync:'estimated',align:[]}));
    if (updates.length) await run('構造を使った再照合', {blocks:updates});
  }

  function vocabInputs() {
    const ordered = set.order.map(id => byId[id]).filter(Boolean);
    const rows = ordered.filter(b => b.text.trim() && !b.asr && (b.script || b.aligned || !b.segments.length));
    const occupied = ordered.filter(b => b.segments.length && (b.aligned || b.sync === 'manual' || (!b.asr && b.text.trim())))
      .flatMap(b => b.segments);
    const evidence = ordered.filter(b => b.asr && !b.aligned && b.sync !== 'manual' && b.segments.length === 1)
      .map(b => ({...b.segments[0], text:b.text, rawId:b.id, rawRev:b.rev, estimated:b.sync === 'estimated' || b.asrBoundaryEstimated === true}));
    return {rows, occupied, evidence};
  }

  // 1.19.29: find which part of the folder's whole 金フレ script this audio holds, and keep only that part in the material
  async function kfEditorRange() {
    if (!set.folder) return toast('先にこの教材をフォルダに入れてください（全体スクリプトはフォルダごとに1つ登録します）', 5000);
    const folder = await createStudioFolder(set.folder);
    const all = (await sdb.all('sets')).filter((x) => x.folder === set.folder);
    const members = folderMembers(all, folder);
    const self = members.find((x) => x.id === set.id) || set;
    await kfLocateFlow({ edgeCues: (target) => transcribeEdges(target), folderId: folder.id, folderName: folder.name, members: members.length ? members : [self], targets: [members.find((x) => x.id === set.id) || self],
      registerFrom: set, onDone: async () => { await reload(); drawList(); drawSub(); } });
  }

  // 音声付き単語帳の作成の下ごしらえ（新しく取り込んだ教材）: 文字のない音声があれば文字起こし → 音声のないスクリプト行のうち、
  // 文字起こしと完全に一致して順序も合うものだけを自動で割り当てる。あいまいなものは割り当てず、このあとの確認画面に候補として出す。
  async function vocabPrepare({ onStep = () => {} } = {}) {
    await reload();
    const out = { asr: 0, assigned: 0 };
    if (blocks.some((b) => !b.text.trim() && b.segments.length === 1)) {
      onStep('文字起こし');
      const r = await runAsr({ auto: true });
      out.asr = r?.lines || 0;
      await reload();
    }
    if (blocks.some((b) => !b.segments.length && b.text.trim() && !b.asr)) {
      onStep('スクリプトと音声の照合');
      const { rows, occupied, evidence } = vocabInputs();
      const exact = planVocabAlignment(rows, evidence, occupied).filter((p) => !p.estimated);
      if (exact.length) { await saveVocabProposals(exact); out.assigned = exact.length; await reload(); }
    }
    return out;
  }
  // 下ごしらえが要る教材: 文字のない音声がある／音声のないスクリプト行があって、音声のある行もある
  const vocabNeedsPrepare = () => blocks.some((b) => !b.text.trim() && b.segments.length === 1) ||
    (blocks.some((b) => !b.segments.length && b.text.trim() && !b.asr) && blocks.some((b) => b.segments.length));

  async function previewVocabAlignment(targets = null, local = null) {
    if (revision !== routeRevision) return;
    await reload();
    if (revision !== routeRevision) return;
    const {rows, occupied, evidence} = vocabInputs();
    if (set.materialType !== 'vocab') {
      await sdb.tx(['sets'], 'readwrite', tx => {
        const store = tx.objectStore('sets'), req = store.get(set.id);
        req.onsuccess = () => { if (req.result) store.put({ ...req.result, materialType: 'vocab' }); };
      });
    }
    const planned = planVocabAlignment(rows, local || evidence, occupied, {targets});
    const proposals = planned.slice(0, 120);
    if (!proposals.length) {
      return confirmDialog({title:'保存できる一致候補がありません',
        body:'<p>単独の発話・語順・反復回数を確認できる候補だけを表示します。既存字幕に収まっている音や境界が不明な音は、字幕の「音声を割当」から試聴し、必要に応じて前後の字幕を調整してください。</p>',
        okLabel:'閉じる',cancelLabel:null});
    }
    const dlg = $('#dialog');
    if (dlg.open) return;
    dlg.innerHTML = `<form method="dialog" class="dlg stack">
      <h3>金フレ型の照合候補</h3>
      <p class="small">${proposals.length}行${planned.length > proposals.length ? `（全${planned.length}候補の先頭。保存後に続きの候補を表示できます）` : ''}。発話を試聴し、保存する行を選んでください。同じ音声を使う照合済み・手動編集済み行は保護します。</p>
      <div class="stack" style="max-height:50vh;overflow:auto">${proposals.map(({row,cues,estimated},i) => `
        <div class="row wrap">
          <label class="grow"><input type="checkbox" data-vocab-save="${i}"> ${esc(row.text)}${estimated ? '（音声位置の推定・要試聴）' : ''}</label>
          ${cues.map((cue,j) => `<button type="button" class="btn sm ghost" data-vocab-play="${i}:${j}">▶ ${esc(srcs[cue.sourceId]?.name || '音声')} ${fmt(cue.start)}〜${fmt(cue.end)}</button>`).join('')}
        </div>`).join('')}</div>
      <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="apply">選択分を保存</button></div>
      </form>`;
    $$('[data-vocab-play]', dlg).forEach(button => button.onclick = () => {
      const [i,j] = button.dataset.vocabPlay.split(':').map(Number);
      const cue = proposals[i].cues[j];
      playBlock({segments:[cue]});
    });
    dlg.returnValue = '';
    const selected = await new Promise(resolve => {
      dlg.onclose = () => resolve(dlg.returnValue === 'apply' ?
        $$('[data-vocab-save]:checked', dlg).map(input => proposals[Number(input.dataset.vocabSave)]) : []);
      dlg.showModal();
    });
    if (revision !== routeRevision) return;
    ++playbackRequest;
    pendingSegmentSeek = null;
    playing = null;
    vid.pause();
    if (!selected.length) return;
    return saveVocabProposals(selected);
  }
  // 候補（確認画面で選んだもの、または音声付き単語帳の作成で自動に選んだ確実なもの）を教材に保存する。1回の操作として ↶ で戻せる。
  async function saveVocabProposals(selected) {
    await reload();
    if (revision !== routeRevision) return;
    const now = vocabInputs();
    const changes = [], consumed = new Set();
    const guardedSet = {updatedAt:set.updatedAt, order:set.order.slice(), undo:(set.undo || []).slice(), redo:(set.redo || []).slice()};
    for (const {row,cues,estimated,redundant = []} of selected) {
      const current = byId[row.id];
      if (!current || current.rev !== row.rev || current.text !== row.text || !isVocabTarget(current) ||
          cues.some(cue => !srcs[cue.sourceId] || now.occupied.some(span => span.sourceId === cue.sourceId &&
            span.start < cue.end && span.end > cue.start))) continue;
      if (cues.some(cue => cue.rawId && (byId[cue.rawId]?.rev !== cue.rawRev ||
          byId[cue.rawId]?.sync === 'manual' || !byId[cue.rawId]?.asr || byId[cue.rawId]?.aligned))) continue;
      if (redundant.some(row => byId[row.id]?.rev !== row.rev || !isVocabTarget(byId[row.id]))) continue;
      redundant.forEach(row => consumed.add(row.id));
      const segments = cues.map(({sourceId,start,end}) => ({sourceId,start,end}));
      changes.push({...current, segments, aligned:!estimated, sync:estimated ? 'estimated' : 'auto', align:[],
        ...(segments.length > 1 ? {rep:segments.length, endEst:false} : {}),
        lineage:{op:'vocab-align',from:[`${current.id}@${current.rev}`],at:Date.now()}});
      if (!estimated) for (const raw of now.evidence) {
        const block = byId[raw.rawId];
        if (!block || block.ja || block.holes?.length || block.rev !== 1 ||
            block.lineage?.op !== 'split') continue;
        if (cues.some(cue => {
          if (cue.rawId === raw.rawId) return true;
          const intersection = Math.min(raw.end, cue.end) - Math.max(raw.start, cue.start);
          return raw.sourceId === cue.sourceId && intersection >= .8 * (raw.end - raw.start) &&
            vocabKey(raw.text) === vocabKey(cue.text);
        })) consumed.add(raw.rawId);
      }
    }
    if (!changes.length) return toast('字幕が更新されました。候補を出し直してください');
    const order = set.order.filter(id => !consumed.has(id));
    await run('金フレ型の照合', {blocks:[...changes,...[...consumed].map(id => ({...byId[id],deleted:true}))],order,guardedSet});
    if (changes.length < selected.length) toast(`${selected.length - changes.length}行は変更・重なりがあるため保留しました`, 4500);
  }

  // 1.19.19: a range of any length (up to 3 minutes) in one go. Only the chosen part is read from the file when the
  // format allows it (mp4/m4a/mov, wav); it is recognised in ~18 s pieces that overlap by 2 s and put back on the file's
  // clock. Nothing is saved until the preview is accepted; cancelling keeps every assignment as it was.
  async function reanalyseRescueRange(sourceId, start, end, targets, prose = null) {
    const source = srcs[sourceId];
    const blob = source?.stored ? source.blob : sessionFiles.get(sourceId);
    if (!blob) return toast('音声ファイルがつながっていません。ファイルを選び直してください', 5000);
    if (![start, end].every(Number.isFinite) || start < 0 || end - start < .2) return toast('開始・終了の時刻を確認してください（開始より後に終了を）', 5000);
    if (source.duration > 0 && end > source.duration + .1) return toast(`終了がファイルの長さ（${fmt(source.duration)}）を超えています`, 5000);
    if (end - start > 180) return toast('一度に解析できるのは3分までです。範囲を分けてください', 5000);
    const dlg = $('#dialog');
    if (dlg.open) return;
    dlg.innerHTML = '<form method="dialog" class="dlg stack"><h3>指定区間の解析</h3><p id="vocabProgress">音声を準備しています…</p><div class="st-meter"><i id="raBar" style="width:0%"></i></div><button class="btn ghost" value="cancel">中止（割り当ては変わりません）</button></form>';
    const progress = $('#vocabProgress', dlg);
    let tr, cancelled = false;
    const stopped = () => cancelled || !dlg.open || revision !== routeRevision;
    dlg.onclose = () => { cancelled = true; tr?.close(); };
    dlg.showModal();
    try {
      // read only the needed part when the format allows it
      let reader = null, whole = null;
      if (isContainer(source, blob)) {
        const info = await probe(blob, { presentation: true }).catch(() => null);
        const tracks = info ? audioTracks(info) : [];
        const track = tracks.find(t => t.id === source.audio?.trackId) || (source.audio?.index != null ? tracks[source.audio.index] : tracks.length === 1 ? tracks[0] : null);
        if (track?.presentation && canExtract(track)) reader = (a, b) => extractPresentationRange(blob, track, a, b);
      } else reader = await wavRangeReader(blob).catch(() => null);
      const clipAt = async (a, z) => {
        if (reader) {
          const clip = await reader(a, z);
          const { audio } = await decodeTo16k(clip.blob);
          const first = Math.max(0, Math.ceil(((clip.from ?? a) - clip.start) * 16000));
          const last = Math.min(audio.length, Math.floor(((clip.to ?? z) - clip.start) * 16000));
          return { audio: audio.slice(first, last), at: clip.start + first / 16000 };
        }
        if (!whole) {
          if (source.duration > 300 || blob.size > 25 * 1024 * 1024) throw new Error('この形式（MP3など）は区間だけを読み出せません。5分・25MBを超える元ファイルは、m4a/mp4/wav にするか、短いファイルに分けてください');
          whole = await sourceAudio16k(source, blob);
        }
        return { audio: whole.audio.slice(Math.round(a * 16000), Math.round(z * 16000)), at: a };
      };
      const pieces = rangePieces(start, end, 18, 2);
      tr = openTranscriber('en', text => { if (!stopped()) progress.textContent = text; }, {quality:'acc'});
      const cues = [];
      for (const [k, [a, z]] of pieces.entries()) {
        if (stopped()) return;
        progress.textContent = `区間 ${k + 1} / ${pieces.length}（${fmt(a)}〜${fmt(z)}）を解析中…`;
        const bar = $('#raBar', dlg); if (bar) bar.style.width = `${Math.round((k / pieces.length) * 100)}%`;
        const { audio: clip, at } = await clipAt(a, z);
        if (stopped()) return;
        highPass(clip);
        const regions = speechRegions(clip, 16000, prose ? undefined : {gapFrames:5,minGap:.08});
        if (regions.length > 60) throw new Error('発話の区切りを絞り込めませんでした（範囲を狭めてください）');
        // keep a cue only in the middle part of its piece, so a sentence across a seam is counted once
        for (const region of regions) {
          if (stopped()) return;
          const result = await recognisePiece(tr, clip, region.start, region.end);
          const text = (result.raw || result.map(cue => cue.text).join(' ')).trim();
          const add = (cue) => { if (keepInPiece(cue, k, pieces, 2)) cues.push(cue); };
          if (prose && result.length && result.every(cue => !cue.est && !cue.boundaryEstimated)) result.forEach(cue => add({sourceId,text:cue.text,start:+(at+cue.start).toFixed(2),end:+(at+cue.end).toFixed(2)}));
          else if (text) add({sourceId, start:+(at+region.start).toFixed(2), end:+(at+region.end).toFixed(2), text});
        }
      }
      if (stopped()) return;
      cues.sort((x, y) => x.start - y.start);
      tr.close();
      tr = null;
      dlg.onclose = null;
      dlg.close();
      await new Promise(resolve => setTimeout(resolve, 60));
      if (!dlg.open && revision === routeRevision) {
        if (prose) await previewProseAssignment(prose.rows,{sid:sourceId,start,end},{local:cues,expected:prose.expected,wide:prose.wide || null});
        else await previewVocabAlignment(targets,cues);
      }
    } catch (error) {
      if (!stopped()) toast('この区間を解析できませんでした：' + error.message, 6000);
    } finally {
      tr?.close();
      if (dlg.open && dlg.contains(progress)) { dlg.onclose = null; dlg.close(); }
    }
  }

  function stopRescuePreview() {
    ++playbackRequest;
    pendingSegmentSeek = null;
    playing = null;
    vid.pause();
  }

  const rescueVersion = () => ({updatedAt:set.updatedAt,order:set.order.slice(),undo:(set.undo || []).slice(),redo:(set.redo || []).slice()});

  // Preserve existing occupied intervals; trim rescue proposals to one continuous free span.
  // Multiple disconnected spans are never stitched together into one subtitle.
  function rescueUnoccupied(segment, excluding = new Set()) {
    const search = createRescueSearch(blocks.filter(b => !excluding.has(b.id)), materialSourceIds(), srcs);
    return search.availableRanges(segment);
  }
  function rescuePreferredFragment(segment, excluding = new Set()) {
    const free=rescueUnoccupied(segment,excluding);
    // Prefer the longest continuous interval; never silently create overlapping assignments.
    return free.sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0] || null;
  }

  // 1.19.19: keep the heard times and mark the line as checked (removes 時間は推定 / 一括仮割当・未確認)
  async function confirmRow(id) {
    await reload(); const row = byId[id];
    if (!row?.segments.length) return toast('音声区間のない行です');
    const {unconfirmed, ...rest} = row;
    await run('この位置で確定', {blocks:[{...rest,sync:'manual',lineage:{op:'confirm-position',from:[`${row.id}@${row.rev}`],at:Date.now()}}]});
  }
  // 1.19.19: every line that is the ONLY unassigned line between two lines with sound gets the sound between them
  // (previous end → next start) as an estimate, marked 一括仮割当・未確認 until confirmed. Neighbours are not moved.
  async function bulkGapTrial() {
    await reload();
    const { can, skip } = planBulkGaps(set.order, byId, (seg, id) => rescueUnoccupied(seg, new Set([id])));
    if (!can.length && !skip.length) return toast('単独の未割当行はありません');
    const tally = {}; skip.forEach((x) => (tally[x.r] = (tally[x.r] || 0) + 1));
    const ok = await confirmDialog({title:'単独の未割当行を一括で仮割り当て',
      body:`<p><b>仮割り当てできる：${can.length}行</b>　見送り：${skip.length}行</p>
        ${skip.length ? `<p class="small muted">${Object.entries(tally).map(([r, n]) => `${esc(r)} ${n}行`).join('・')}</p>` : ''}
        <p class="small">前の字幕の終わり〜次の字幕の始まりを、その1行の仮区間にします。前後の時刻は動かしません。保存後は「一括仮割当・未確認」と表示され、「確定」するまで「未」の一覧に残ります（↶で全部戻せます）。見送った行は「音声を割当」や手動編集で直せます。</p>`,
      okLabel: can.length ? `${can.length}行を仮割り当て` : '閉じる'});
    if (!ok || !can.length || revision !== routeRevision) return;
    await reload();
    const ups = can.filter(({b}) => byId[b.id] && byId[b.id].rev === b.rev && !byId[b.id].segments.length)
      .map(({b, seg}) => ({...byId[b.id],segments:[seg],sync:'estimated',unconfirmed:true,align:[],lineage:{op:'bulk-gap-trial',from:[`${b.id}@${b.rev}`],at:Date.now()}}));
    if (!ups.length) return toast('対象の行が更新されました。もう一度実行してください');
    await run(`${ups.length}行を一括仮割り当て`, {blocks:ups});
    if (view !== 'todo') toast('表示切替「未」で未確認の行だけを確認できます', 3000);
  }
  async function reestimateFromNeighbours(id) {
    await reload();
    if (revision !== routeRevision) return;
    const row = byId[id];
    if (!row || row.sync !== 'estimated' || !row.segments?.length) return toast('再推定できる仮割当がありません');
    const index = set.order.indexOf(id);
    if (index < 0) return;
    // Use script order, not current audio time. Estimated rows are not trusted anchors.
    const reliable = b => b && b.id !== id && b.segments?.length === 1 && b.sync !== 'estimated' &&
      (b.aligned || b.sync === 'manual') && !b.deleted;
    let before=null, after=null;
    for (let i=index-1;i>=0;i--) {const b=byId[set.order[i]];if(reliable(b)){before=b;break;}}
    for (let i=index+1;i<set.order.length;i++) {const b=byId[set.order[i]];if(reliable(b)){after=b;break;}}
    if (!before || !after) return toast('前後に照合済みのアンカーが必要です。境界を手動で確認してください');
    const left=before.segments[0],right=after.segments[0];
    if (left.sourceId !== right.sourceId || right.start <= left.end+.12)
      return toast('前後のアンカーが同じ音声内で順序どおりに並んでいません');
    const between = set.order.slice(set.order.indexOf(before.id)+1,set.order.indexOf(after.id));
    const pending = between.map(x=>byId[x]).filter(b=>b && (b.sync==='estimated'||!b.segments?.length));
    if (pending.length !== between.length) return toast('途中に確定済みの行があります。個別に確認してください');
    // Multiple unresolved rows must not all receive the same gap. Split only
    // after a separate speech alignment; this action handles a single row.
    if (pending.length !== 1 || pending[0].id !== id)
      return toast('間に複数の未確定行があります。先に他の行を照合してください');
    const proposed=rescueUnoccupied({sourceId:left.sourceId,start:left.end,end:right.start},new Set([id]));
    if (proposed.length !== 1) return toast('未使用区間が複数あります。既存区間の境界を確認してください');
    const segment=proposed[0];
    const ok=await confirmDialog({title:'前後から仮割当を再推定',
      body:`<p>${esc(row.text)}</p><p>現在：${fmt(row.segments[0].start)}〜${fmt(row.segments.at(-1).end)}</p><p>再推定：${fmt(segment.start)}〜${fmt(segment.end)}</p><p class="small">前後の照合済み行の間にある未使用音声を使います。発話境界の正確さは未確認です。</p>`,
      okLabel:'再推定して置き換える'});
    if (!ok || revision !== routeRevision) return;
    await reload();
    const current=byId[id];
    if (!current || current.rev !== row.rev || current.sync !== 'estimated') return toast('対象が更新されたため再推定を中止しました');
    const currentFree=rescueUnoccupied(segment,new Set([id]));
    if (currentFree.length !== 1 || Math.abs(currentFree[0].start-segment.start)>.05 || Math.abs(currentFree[0].end-segment.end)>.05)
      return toast('他の割当が変わりました。再度お試しください');
    return run('前後アンカーから再推定',{blocks:[{...current,segments:[segment],sync:'estimated',align:[],lineage:{op:'prose-reestimate',from:[`${current.id}@${current.rev}`],at:Date.now()}}]});
  }

  // 1.19.18: the chosen sound is (partly) inside other lines' saved ranges (often a neighbour aligned too long).
  // Offer to shorten those lines so the chosen range goes to this line. Manually edited lines are never shortened.
  // a line that really owns its sound (script line / matched / manual); left-over transcripts and empty pieces do not
  const isAssigned = (b) => !!(b.text || '').trim() && (!b.asr || b.aligned || b.sync === 'manual');
  async function takeOverRange(row, seg, {label, sync, op, guardedSet}) {
    const hits = blocks.filter(b => isAssigned(b) && b.id !== row.id && b.segments.some(g => g.sourceId === seg.sourceId && g.start < seg.end - .05 && g.end > seg.start + .05));
    if (!hits.length) return false;
    const locked = hits.filter(b => b.sync === 'manual');
    if (locked.length) { toast(`手動で調整した行と重なります：「${locked[0].text.slice(0,30)}」。範囲を狭めるか、その行を先に直してください`, 6000); return true; }
    const cut = hits.map(b => {
      const segs = b.segments.flatMap(g => g.sourceId !== seg.sourceId || g.end <= seg.start || g.start >= seg.end ? [g]
        : [{...g,end:seg.start},{...g,start:seg.end}].filter(x => x.end - x.start >= .15));
      return {b, segs};
    });
    const ok = await confirmDialog({title:'ほかの行の区間と重なっています',
      body:`<p class="small">${fmt(seg.start)}〜${fmt(seg.end)} は次の行に割り当て済みです。これらの行の区間を縮めて、「${esc(row.text.slice(0,40))}」に割り当てますか？（↶で戻せます）</p>
        <div class="stack small" style="max-height:40vh;overflow:auto">${cut.map(({b,segs}) => `<div>「${esc(b.text.slice(0,40))}」<br><span class="muted">${b.segments.map(g=>`${fmt(g.start)}〜${fmt(g.end)}`).join('・')} → ${segs.length ? segs.map(g=>`${fmt(g.start)}〜${fmt(g.end)}`).join('・') : '音声なし'}</span></div>`).join('')}</div>`,
      okLabel:'縮めて割り当てる'});
    if (!ok || revision !== routeRevision) return true;
    const updates = [{...row,segments:[seg],sync,align:[],lineage:{op,from:[`${row.id}@${row.rev}`],at:Date.now()}},
      ...cut.map(({b,segs}) => ({...b,segments:segs,align:[],sync:segs.length ? b.sync : b.sync,aligned:segs.length ? b.aligned : false,lineage:{op:'trim-for-rescue',from:[`${b.id}@${b.rev}`],at:Date.now()}}))];
    await run(label,{blocks:updates,guardedSet});
    return true;
  }
  async function previewProseAssignment(rows, range, {local = null,manual = false,expected,wide = null} = {}) {
    await reload();
    if (revision !== routeRevision) return;
    const guardedSet = rescueVersion();
    if (expected && !sameRescueVersion(guardedSet, expected)) {
      toast('前後の割当が更新されたため、候補を再計算しました');
      return rescueUnassigned(rows[0].id);
    }
    const currentRows = rows.map(b => byId[b.id]);
    // 前後を含めて再照合: the neighbouring lines included this time do not block the search (their old times are only replaced on save)
    const search = wide ? createRescueSearch(blocks.filter(b => !wide.has(b.id)), materialSourceIds(), srcs) : currentRescueSearch();
    if (currentRows.some((b,i) => !b || b.rev !== rows[i].rev || b.text !== rows[i].text || (!wide?.has(b.id) && !search.byRow.has(b.id) && !wide))) {
      return toast('対象の字幕が更新されました。候補を開き直してください');
    }
    const rawProposed = manual ? [{row:currentRows[0],segment:{sourceId:range.sid,start:range.start,end:range.end},evidence:[]}] :
      search.assignments(currentRows,range,local,{partial:true});
    const mine = new Set(currentRows.map(r=>r.id));
    let proposed = rawProposed.map(x => ({...x,segment:wide ? (search.isFree(x.segment) ? x.segment : null) : rescuePreferredFragment(x.segment,mine)}));
    if (manual) {   // the user chose the exact range: if other lines hold (part of) it, offer to shorten them
      const want = {sourceId:range.sid,start:range.start,end:range.end}, got = proposed[0]?.segment;
      if (!got || got.start - want.start > .1 || want.end - got.end > .1) {
        if (await takeOverRange(currentRows[0], want, {label:'朗読の音声割当（重なりを調整）',sync:'manual',op:'prose-rescue-manual',guardedSet})) return;
      }
      if (!got) return toast('指定範囲に未使用の音声がありません。照合済み・手動調整済みの区間を確認してください', 5500);
    }
    proposed = proposed.filter(x => x.segment);
    // Rows whose text was not recognised: when exactly one such row sits between two confirmed rows (or the ends of
    // the chosen range), the unused sound between them is offered as an estimate (unticked if it looks too short / long).
    if (!manual && proposed.length) {
      const got = new Map(proposed.map(x => [x.row.id,x]));
      for (let i = 0; i < currentRows.length; i++) {
        const r = currentRows[i]; if (got.has(r.id)) continue;
        const prev = i > 0 ? got.get(currentRows[i-1].id) : null, next = i < currentRows.length-1 ? got.get(currentRows[i+1].id) : null;
        const a = prev ? prev.segment.end : i === 0 ? range.start : null, z = next ? next.segment.start : i === currentRows.length-1 ? range.end : null;
        if (a == null || z == null || !(prev || next) || z - a < 0.3) continue;
        const segment = wide ? (search.availableRanges({sourceId:range.sid,start:a,end:z}).sort((p,q)=>(q.end-q.start)-(p.end-p.start))[0] || null) : rescuePreferredFragment({sourceId:range.sid,start:a,end:z},mine);
        if (!segment || !search.isFree(segment)) continue;
        const n = Math.max(1, wordCount(r.text)), d = segment.end - segment.start;
        proposed.push({row:r,segment,evidence:[],est:true,doubt:d < n/6 || d > Math.max(4,n*1.2)});
      }
      proposed.sort((x,y) => currentRows.indexOf(x.row) - currentRows.indexOf(y.row));
    }
    if (!proposed.length) {
      return confirmDialog({title:'行ごとの区間を確認できませんでした',
        body:'<p>指定範囲では本文と順序が一意に一致する音声がそろっていません。範囲を広げるか、行数を減らして再解析・試聴してください。1行なら開始と終了を指定して割り当てられます。</p>',
        okLabel:'閉じる',cancelLabel:null});
    }
    // Recheck against current occupied intervals; user sees the trimmed boundaries in preview.
    if (proposed.some(x => !search.isFree(x.segment))) return toast('他の割当と重複するため保存できません。候補を確認してください');
    // 前後を含めて再照合: an included neighbour that was not matched again keeps its time, minus any part now given to another line
    if (wide) {
      const taken = proposed.map(x => x.segment);
      for (const r of currentRows) {
        if (!wide.has(r.id) || proposed.some(x => x.row.id === r.id)) continue;
        const segs = withoutTaken(r.segments, taken);
        if (JSON.stringify(segs) !== JSON.stringify(r.segments)) proposed.push({row:r,segment:segs[0] || null,segs,trim:true,evidence:[]});
      }
      proposed.sort((x,y) => currentRows.indexOf(x.row) - currentRows.indexOf(y.row));
    }
    const nOk = proposed.filter(x => !x.est && !x.trim).length, nEst = proposed.filter(x => x.est).length, nNone = currentRows.filter(r => !proposed.some(x => x.row.id === r.id && !x.trim)).length;
    const keep = new Set(proposed.map((x,i) => (x.doubt ? -1 : i)).filter(i => i >= 0));
    const accepted = confirmDialog({title:'朗読の音声区間を保存',
      body:`${manual ? '' : `<p class="small"><b>一致 ${nOk}行</b>${nEst ? `・前後の間から推定 ${nEst}行` : ''}${nNone ? `・<span class="muted">見つからず ${nNone}行（そのまま）</span>` : ''}。チェックした行だけ保存します。</p>`}<p class="small">${manual ? '入力した範囲を1行に割り当てます。' : local ? '指定区間の発話と本文が順番に一致した行です。' : '保存済みASRと本文が順番に一致した行です。'}各行を試聴して確認できます。</p>
        <div class="stack" style="max-height:45vh;overflow:auto">${proposed.map(({row,segment,est,doubt},i) =>
          `<div class="row wrap">${manual ? '' : `<input type="checkbox" data-prose-keep="${i}" ${keep.has(i) ? 'checked' : ''} aria-label="保存する">`}<span class="grow">${est ? `<span class="tagp warn">${doubt ? '推定・長さ要確認' : '推定'}</span> ` : ''}${proposed[i].trim ? '<span class="tagp warn">境界を調整</span> ' : wide?.has(row.id) ? '<span class="tagp">前後の行・付け直し</span> ' : ''}${esc(row.text)}${wide?.has(row.id) ? `<br><small class="muted">今：${row.segments.map(g=>`${fmt(g.start)}〜${fmt(g.end)}`).join('・') || 'なし'} → ${proposed[i].trim ? (proposed[i].segs.map(g=>`${fmt(g.start)}〜${fmt(g.end)}`).join('・') || '音声なし') : `${fmt(segment.start)}〜${fmt(segment.end)}`}</small>` : ''}</span>${segment ? `<button type="button" class="btn sm" data-prose-preview="${i}">▶ ${fmt(segment.start)}〜${fmt(segment.end)}</button>` : ''}</div>`).join('')}</div>`,
      okLabel:'区間を保存'});
    $$('[data-prose-keep]', $('#dialog')).forEach(box => box.onchange = () => { const i = Number(box.dataset.proseKeep); if (box.checked) keep.add(i); else keep.delete(i); });
    $$('[data-prose-preview]', $('#dialog')).forEach(button => button.onclick = () => {
      stopRescuePreview();
      playBlock({segments:[proposed[Number(button.dataset.prosePreview)].segment]});
    });
    const ok = await accepted;
    if (revision !== routeRevision) return;
    stopRescuePreview();
    if (!ok) return;
    if (!manual) proposed = proposed.filter((x,i) => keep.has(i));
    if (!proposed.length) return toast('保存する行がありません');
    const updates = proposed.map(({row,segment,est,trim,segs}) => trim ? ({...row,segments:segs,align:[],aligned:segs.length ? row.aligned : false,lineage:{op:'prose-rescue-trim',from:[`${row.id}@${row.rev}`],at:Date.now()}}) : ({...(({unconfirmed,...r}) => r)(row),segments:[segment],
      aligned:manual || est ? row.aligned : true, sync:manual ? 'manual' : est ? 'estimated' : 'auto', align:[],
      lineage:{op:manual ? 'prose-rescue-manual' : est ? 'prose-rescue-gap' : 'prose-rescue-match',from:[`${row.id}@${row.rev}`],at:Date.now()}}));
    if (!local && !manual) {
      // Replace only original, unedited ASR display duplicates. Revisions and audio remain available to Undo.
      const raw = new Set(proposed.flatMap(x => x.evidence).map(g => byId[g.id])
        .filter(b => b?.rev === 1 && b.lineage?.op === 'split' && !b.ja && !(b.holes || []).length));
      for (const b of raw) updates.push({...b,deleted:true});
    }
    const removed = new Set(updates.filter(b => b.deleted).map(b => b.id));
    await run('朗読の音声割当',{blocks:updates,order:set.order.filter(id => !removed.has(id)),guardedSet});
  }

  // 1.19.19: the unassigned lines plus k lines with sound on each side are matched again together. The neighbours' saved
  // times do not block the search (their sound may hide this line's sound); saved recognition is used first, and the
  // range is recognised again only when that is not enough. Manually confirmed lines are never included (they stay fixed).
  async function rescueWithNeighbours(selected, sid, a, z, k, expected) {
    await reload();
    const ids = set.order.filter(id => byId[id] && !isSymbolRow(byId[id]));
    const i0 = ids.indexOf(selected[0].id), i1 = ids.indexOf(selected.at(-1).id);
    if (i0 < 0 || i1 < 0) return toast('対象の字幕が見つかりません');
    const side = (from, step) => { const out = []; for (let i = from; i >= 0 && i < ids.length && out.length < k; i += step) { const b = byId[ids[i]]; if (!b.segments.length) continue; if (b.sync === 'manual' || !b.segments.every(g => g.sourceId === sid)) break; out.push(b); } return out; };
    const before = side(i0 - 1, -1).reverse(), after = side(i1 + 1, 1);
    if (!before.length && !after.length) return toast('前後に同じ音声ファイルの字幕がありません（手動確定済みの行は含めません）', 5000);
    const rows = [...before, ...ids.slice(i0, i1 + 1).map(id => byId[id]), ...after];
    const wide = new Set([...before, ...after].map(b => b.id));
    const nb = [...before, ...after].flatMap(b => b.segments);
    const A = Math.max(0, Math.min(a, ...nb.map(g => g.start)) - .3), Z = Math.min(srcs[sid]?.duration || Infinity, Math.max(z, ...nb.map(g => g.end)) + .3);
    // saved recognition first
    const search = createRescueSearch(blocks.filter(b => !wide.has(b.id)), materialSourceIds(), srcs);
    const saved = search.assignments(rows, {sid, start:A, end:Z}, undefined, {partial:true});
    if (saved.length === rows.length) return previewProseAssignment(rows, {sid, start:A, end:Z}, {expected, wide});
    return reanalyseRescueRange(sid, A, Z, new Set(rows.map(b => b.id)), {rows, expected, wide});
  }
  async function rescueUnassigned(id) {
    if (revision !== routeRevision) return;
    await reload();
    if (revision !== routeRevision) return;
    const search = currentRescueSearch();
    const group = search.byRow.get(id);
    const expected = rescueVersion();
    if (!group) return toast('音声なしの字幕を選んでください');
    const selectedIndex = group.rows.findIndex(b => b.id === id);
    const first = selectedIndex;
    const missing = group.rows.slice(first,first+40);   // many rows at once: only rows confirmed by the order are saved
    let opt = [];
    const dlg=$('#dialog');
    if (dlg.open) return;
    dlg.classList.add("st-rescue-dialog");
    dlg.addEventListener("close", () => dlg.classList.remove("st-rescue-dialog"), {once:true});
    dlg.innerHTML=`<form method="dialog" class="dlg stack st-edit"><div class="st-editor-sticky"><h3>音声なし字幕の救済（試験版）</h3><button class="btn sm ghost" value="cancel">閉じる</button><button id="rsApply" class="btn sm primary" value="ok">1行に手動で割り当て</button></div>
      <p class="small">連続する未割当 ${group.rows.length}行（今回表示 ${missing.length}行）。試聴してから反映してください。</p>
      <label class="field"><span>教材の種類</span><select id="rsMode"><option value="prose">朗読・会話（MA型）</option><option value="vocab">金フレ型（見出し語・例文・繰り返し）</option></select></label>
      <label class="field"><span>今回割り当てる行数</span><select id="rsCount">${missing.map((b,i)=>`<option value="${i+1}" ${i===missing.length-1?'selected':''}>${i+1}行${i===missing.length-1&&i?'（まとめて・確かな行だけ保存）':''}</option>`).join('')}</select></label>
      <p id="rsModeHint" class="small muted"></p>
      <p id="rsAnchors" class="small muted"></p>
      <label class="chk"><input id="rsExpand" type="checkbox"> 探索範囲を広げる</label>
      <label class="field"><span>音声候補</span><select id="rsCandidate"></select></label>
      <div class="row wrap"><label class="field grow"><span>開始（分:秒.小数）</span><input id="rsStart" type="text" inputmode="decimal" placeholder="14:03.0"></label><label class="field grow"><span>終了（分:秒.小数）</span><input id="rsEnd" type="text" inputmode="decimal" placeholder="14:10.6"></label></div>
      <div id="rsPairTools" hidden><label class="field"><span>2行の境界（分:秒.小数）</span><input id="rsSplit" type="text" inputmode="decimal"></label><div class="row wrap"><button type="button" class="btn sm" id="rsSplitNow">再生位置を境界に</button><button type="button" class="btn sm" id="rsPairA">▶ 前半</button><button type="button" class="btn sm" id="rsPairB">▶ 後半</button></div><p class="small muted">境界を試聴して確認してください。前後の既存割当は変更しません。</p></div><div class="st-rescue-timeline"><div class="row st-rescue-hscroll"><button type="button" class="btn sm" id="rsView">ファイル全体を表示</button><button type="button" class="btn sm" id="rsStartZero">開始を先頭へ</button><button type="button" class="btn sm" id="rsEndLast">終了を末尾へ</button></div><p class="small muted">バーの下にある短い開始ポインターと長い終了ポインターをドラッグして調整できます。中央をタップすると再生位置を移動します。</p><div class="st-rescue-track" id="rsTrack" style="position:relative;touch-action:none;min-height:44px"><i id="rsSelection" style="pointer-events:none"></i><b id="rsHead" style="pointer-events:none"></b><button type="button" class="st-range-pointer st-range-start" id="rsHandleStart" aria-label="割当開始をドラッグ"></button><button type="button" class="st-range-pointer st-range-end" id="rsHandleEnd" aria-label="割当終了をドラッグ"></button></div><div class="row small muted"><span id="rsClockStart">--:--</span><span class="grow"></span><span id="rsClockNow">--:--</span><span class="grow"></span><span id="rsClockEnd">--:--</span></div><div class="row wrap st-preview-controls"><button type="button" class="btn sm" id="rsPlay">▶ 候補を試聴</button><button type="button" class="btn sm" id="rsPlayHead">▶ 頭2秒</button><button type="button" class="btn sm" id="rsPlayLast">▶ 後ろ2秒</button><button type="button" class="btn sm" id="rsStop">■ 停止</button></div></div>
      <div class="small st-rescue-script" id="rsRows" style="max-height:7rem;overflow:auto">${missing.map((b,i)=>`<div>${i+1}. ${esc(b.text)}</div>`).join('')}</div>
      <p id="rsReason" class="small muted"></p><p class="small muted">朗読の手動割当は1行または2行を選択してください。時刻は例 14:03.0 と入力できます。</p>
      <div class="row end st-rescue-hscroll">
        <button id="rsEditAnchor" class="btn" value="anchor" hidden>既存字幕の境界を確認</button>
        <button id="rsSaved" class="btn" value="saved">既存ASRと照合</button>
        <button id="rsLocal" class="btn" value="local">指定区間を再解析</button>
        <button id="rsWide" class="btn" value="wide" title="前後の字幕も一緒に照合し直す（前後の区間がずれて、この行の音声を覆っているとき）">前後を含めて再照合</button>
        <label class="small">前後に含める行 <select id="rsWideN"><option value="1">1行ずつ</option><option value="2">2行ずつ</option><option value="3">3行ずつ</option></select></label>
        <button id="rsGap" class="btn" value="gap" hidden>前後の間を仮割当</button>
      </div></form>`;
    const pick=$('#rsCandidate',dlg),st=$('#rsStart',dlg),en=$('#rsEnd',dlg);
    const mode=$('#rsMode',dlg),count=$('#rsCount',dlg),rows=$('#rsRows',dlg),hint=$('#rsModeHint',dlg);
    const currentRows=()=>missing.slice(0,+count.value);
    const pickRange = () => opt[Number(pick.value)];
    const apply = $('#rsApply',dlg), saved = $('#rsSaved',dlg), localButton = $('#rsLocal',dlg);
    const editAnchor = $('#rsEditAnchor',dlg), expand = $('#rsExpand',dlg), gapButton=$('#rsGap',dlg);
    let rescueFullView = false;
    const rescueBounds = () => {
      const c=pickRange(), a=parseClock(st.value), z=parseClock(en.value);
      if (!c) return null;
      const duration=Number(srcs[c.sid]?.duration);
      const D=Number.isFinite(duration)&&duration>0 ? duration : Math.max(c.end,z||0,a||0)+5;
      const lo=rescueFullView?0:Math.max(0,Math.min(c.start,Number.isFinite(a)?a:c.start)-15);
      const hi=rescueFullView?D:Math.max(lo+1,Math.min(D,Math.max(c.end,Number.isFinite(z)?z:c.end)+15));
      return {lo,hi,D};
    };
    const rescueClamp=(v,min,max)=>Math.max(min,Math.min(max,v));
    const rescueHandle=(edge)=>{
      const handle=$('#rsHandle'+(edge==='start'?'Start':'End'),dlg);
      handle.addEventListener('pointerdown',e=>{
        const c=pickRange(),bounds=rescueBounds();if(!c||c.review||!bounds)return;
        e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);
        const move=ev=>{
          const rect=$('#rsTrack',dlg).getBoundingClientRect();if(!rect.width)return;
          const t=bounds.lo+rescueClamp((ev.clientX-rect.left)/rect.width,0,1)*(bounds.hi-bounds.lo);
          const a=parseClock(st.value),z=parseClock(en.value);
          if(edge==='start'&&Number.isFinite(z))st.value=rescueClockValue(rescueClamp(t,0,z-.1));
          if(edge==='end'&&Number.isFinite(a))en.value=rescueClockValue(rescueClamp(t,a+.1,bounds.D));
          drawClock();
        };
        const done=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',done);handle.removeEventListener('pointercancel',done);};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',done);handle.addEventListener('pointercancel',done);
      });
    };
    rescueHandle('start');rescueHandle('end');
    $('#rsView',dlg).onclick=()=>{rescueFullView=!rescueFullView;$('#rsView',dlg).textContent=rescueFullView?'周辺を拡大':'ファイル全体を表示';drawClock();};
    $('#rsStartZero',dlg).onclick=()=>{if(st.disabled)return;st.value=rescueClockValue(0);drawClock();};
    $('#rsEndLast',dlg).onclick=()=>{if(en.disabled)return;const b=rescueBounds();if(b)en.value=rescueClockValue(b.D);drawClock();};
    let rescueClock = null;
    const stopClock = () => { if (rescueClock) cancelAnimationFrame(rescueClock); rescueClock=null; };
    const drawClock = () => {
      const c=pickRange(), a=parseClock(st.value), z=parseClock(en.value);
      const track=$('#rsTrack',dlg),head=$('#rsHead',dlg),sel=$('#rsSelection',dlg);
      if (!c || !Number.isFinite(a) || !Number.isFinite(z) || z<=a) return;
      const bounds=rescueBounds();if(!bounds)return;const {lo,hi}=bounds;
      const pct=t=>Math.max(0,Math.min(100,100*(t-lo)/(hi-lo)));
      sel.style.left=pct(a)+'%'; sel.style.width=Math.max(0,pct(z)-pct(a))+'%';
      $('#rsHandleStart',dlg).style.left=pct(a)+'%';$('#rsHandleEnd',dlg).style.left=pct(z)+'%';
      $('#rsHandleStart',dlg).disabled=$('#rsHandleEnd',dlg).disabled=Boolean(c.review);
      head.style.left=pct(vid.currentTime)+'%'; head.hidden=vid.dataset.src!==c.sid;
      $('#rsClockStart',dlg).textContent=fmt(lo); $('#rsClockEnd',dlg).textContent=fmt(hi);
      $('#rsClockNow',dlg).textContent=vid.dataset.src===c.sid?fmt(vid.currentTime):'未再生';
    };
    const clockTick=()=>{ if (!dlg.open) return; drawClock(); rescueClock=requestAnimationFrame(clockTick); };
    st.addEventListener('input',drawClock); en.addEventListener('input',drawClock);
    $('#rsTrack',dlg).onclick=e=>{const c=pickRange();if(!c)return;const a=parseClock(st.value),z=parseClock(en.value);if(!Number.isFinite(a)||!Number.isFinite(z))return;const bounds=rescueBounds();if(!bounds)return;const {lo,hi}=bounds;const t=lo+(e.clientX-e.currentTarget.getBoundingClientRect().left)/e.currentTarget.clientWidth*(hi-lo);if(vid.dataset.src===c.sid)vid.currentTime=Math.max(0,t);drawClock();};
    const refreshRows = () => {
      const selected = currentRows();
      rows.innerHTML = selected.map((b,i) => `<div>${i+1}. ${esc(b.text)}</div>`).join('');
      hint.textContent = mode.value === 'prose' ?
        '複数行は、本文と順序が確認できた区間を保存します。1行は手動指定もできます。' :
        '金フレ型では例文の繰り返しを別区間として扱います。仮割当は試聴して境界を確認してください。';
      const pair = mode.value === 'prose' && selected.length === 2;
      $('#rsPairTools',dlg).hidden = !pair;
      apply.textContent = mode.value === 'prose' ? (pair ? '2行に分割して割り当て' : '1行に手動で割り当て') : '確認して仮割当';
      apply.disabled = !pickRange() || Boolean(pickRange().review) || (mode.value === 'prose' && ![1,2].includes(selected.length));
      saved.disabled = mode.value === 'prose' && (!pickRange() || Boolean(pickRange().review));
      localButton.disabled = !pickRange() || Boolean(pickRange().review);
    };
    const update = () => {
      const c = pickRange();
      stopRescuePreview();
      st.value = c ? rescueClockValue(c.start) : '';
      en.value = c ? rescueClockValue(c.end) : '';
      $('#rsSplit',dlg).value = c ? rescueClockValue((c.start+c.end)/2) : '';
      st.disabled = en.disabled = !c || Boolean(c.review);
      st.title = en.title = c?.review ? 'これは既存字幕の確認用です。下の「手動で時刻指定」を選んでください。' : ''; 
      $('#rsPlay',dlg).disabled = $('#rsPlayHead',dlg).disabled = $('#rsPlayLast',dlg).disabled = !c;
      editAnchor.hidden = !c?.review;
      $('#rsReason',dlg).textContent = c ? c.kind : '候補がありません。探索範囲を広げてください。';
      gapButton.hidden = !(mode.value === 'prose' && c && !c.review && currentRows().length === 1 && group.rows.length === 1 && c.inside);
      drawClock();
      refreshRows();
    };
    const describe = a => a ? `${a.manual ? '手動' : '自動'} ${srcs[a.sourceId]?.name || '音声'} ${fmt(a.start)}〜${fmt(a.end)}「${a.row.text.slice(0,45)}」` : 'なし';
    const refreshCandidates = () => {
      const plan = search.search(group,expand.checked);
      const usable = c => srcs[c.sid]?.stored ? Boolean(srcs[c.sid].blob) : sessionFiles.has(c.sid);
      opt = [...plan.candidates.filter(usable).slice(0,50),...plan.review.filter(usable)];
      // 1.19.18: the space between the two anchors is offered even when other lines hold it (it can be taken over)
      if (plan.before && plan.after && plan.before.sourceId === plan.after.sourceId && plan.after.start - plan.before.end >= .3 &&
          usable({sid:plan.before.sourceId}) && !opt.some(c => c.inside && !c.review))
        opt.unshift({sid:plan.before.sourceId,start:plan.before.end,end:plan.after.start,inside:true,distance:0,matchingAsr:0,
          kind:'前後のアンカー間（ほかの行の区間と重なりあり：保存時に縮めるか確認します）'});
      // A review-only result used to disable both clock inputs and Apply.
      // Always offer a non-destructive manual range on the same source, even
      // when no unused gap was found. Commit still checks occupied intervals.
      const sourceIds = [...new Set([...opt.map(c=>c.sid),plan.before?.sourceId,plan.after?.sourceId].filter(Boolean))];
      if (!sourceIds.length) sourceIds.push(...Object.keys(srcs).filter(sid=>usable({sid})).slice(0,10));
      for (const sid of sourceIds) {
        if (!usable({sid})) continue;
        const duration=Number(srcs[sid]?.duration)||0;
        const a=plan.before?.sourceId===sid ? plan.before.end : 0;
        const z=plan.after?.sourceId===sid ? plan.after.start : Math.min(duration||a+20,a+20);
        const start=Math.max(0,Math.min(a,Math.max(0,(duration||Infinity)-.2)));
        const end=Math.max(start+.2,Math.min(duration||start+20,z>start+.2?z:start+10));
        opt.push({sid,start,end,kind:'手動で時刻指定（既存区間との重複は保存時に検査）'});
      }
      $('#rsAnchors',dlg).textContent = `前のアンカー ${describe(plan.before)} / 次のアンカー ${describe(plan.after)}${plan.reversed ? '（前後の区間が逆順または重複）' : ''}`;
      pick.innerHTML = opt.map((c,i) => `<option value="${i}">${esc(srcs[c.sid]?.name || '音声')} / ${esc(c.kind)} / ${fmt(c.start)}–${fmt(c.end)}</option>`).join('');
      const firstEditable=opt.findIndex(c=>!c.review);
      pick.value=String(firstEditable>=0?firstEditable:0);
      update();
    };
    mode.onchange = count.onchange = () => { refreshRows(); const c=pickRange();gapButton.hidden=!(mode.value==='prose'&&c&&!c.review&&currentRows().length===1&&group.rows.length===1&&c.inside); };
    pick.onchange = update;
    expand.onchange = refreshCandidates;
    refreshCandidates();
    $('#rsStop',dlg).onclick = stopRescuePreview;
    $('#rsSplitNow',dlg).onclick = () => { const c=pickRange(); if(c && vid.dataset.src===c.sid) $('#rsSplit',dlg).value=rescueClockValue(vid.currentTime); };
    for (const [button,half] of [['rsPairA',0],['rsPairB',1]]) $('#'+button,dlg).onclick=()=>{
      const c=pickRange(), a=parseClock(st.value), z=parseClock(en.value), m=parseClock($('#rsSplit',dlg).value);
      if(!c || c.review || !manualRescuePair(c.sid,a,m,z,srcs[c.sid]?.duration)) return toast('分割位置を確認してください');
      stopRescuePreview(); playBlock({segments:[{sourceId:c.sid,start:half?m:a,end:half?z:m}]});
    };
    for (const [button, part] of [['rsPlay', 'all'], ['rsPlayHead', 'head'], ['rsPlayLast', 'tail']]) {
      $('#' + button, dlg).onclick = () => {
        const c = pickRange();
        const duration = c && (vid.dataset.src === c.sid && Number.isFinite(vid.duration) ? vid.duration : srcs[c.sid]?.duration);
        const range = rescuePreviewRange(parseClock(st.value), parseClock(en.value), duration, part);
        if (!c || !range) return toast('開始・終了を確認してください');
        stopRescuePreview();
        playBlock({segments:[{sourceId:c.sid,...range}]});
      };
    }
    dlg.returnValue = '';
    dlg.showModal();
    rescueClock=requestAnimationFrame(clockTick);
    await new Promise(resolve => dlg.onclose = resolve);
    stopClock();
    stopRescuePreview();
    const action = dlg.returnValue, c = pickRange(), a = parseClock(st.value), z = parseClock(en.value);
    const selected = currentRows(), targets = new Set(selected.map(row => row.id));
    const prose = mode.value === 'prose';
    if (action === 'cancel' || !action) return;
    await new Promise(resolve => setTimeout(resolve,60));
    if (dlg.open || revision !== routeRevision) return;
    if (action === 'anchor' && c?.review) {
      await reload();
      if (revision !== routeRevision || dlg.open) return;
      const anchor = byId[c.anchor.row.id];
      if (!anchor?.segments.length) return rescueUnassigned(id);
      return editBlock(anchor,{protectNeighbours:true, onFinish:() => rescueUnassigned(id)});
    }
    if (action === 'saved' && !prose) return previewVocabAlignment(targets);
    if (action === 'wide' && c && Number.isFinite(a) && Number.isFinite(z)) return rescueWithNeighbours(selected, c.sid, a, z, +($('#rsWideN', dlg)?.value || 1), expected);
    if (!c || c.review || !Number.isFinite(a) || !Number.isFinite(z) || a < 0 || z-a < .12) return toast('音声範囲を確認してください');
    const range = {sid:c.sid,start:a,end:z};
    if (action === 'local') return reanalyseRescueRange(c.sid,a,z,targets,prose ? {rows:selected,expected} : null);
    if (action === 'wide') return rescueWithNeighbours(selected, c.sid, a, z, +($('#rsWideN', dlg)?.value || 1), expected);
    if (action === 'saved') return previewProseAssignment(selected,range,{expected});
    if (action === 'gap') {
      if (!prose || selected.length!==1 || group.rows.length!==1 || !c.inside) return toast('前後アンカーに挟まれた1行のみ仮割当できます');
      const ok=await confirmDialog({title:'前後の間を仮割当',body:`<p>${esc(selected[0].text)}</p><p>${fmt(a)}〜${fmt(z)} を推定区間として登録します。正確な発話境界は未検証です。</p>`,okLabel:'仮割当'});
      if (!ok) return;
      await reload();
      if (revision !== routeRevision) return;
      const guardedSet = rescueVersion();
      const row=byId[selected[0].id];
      if (!row || row.rev!==selected[0].rev || row.segments.length || !sameRescueVersion(guardedSet, expected)) return toast('字幕が更新されています。再探索してください');
      const trimmed=rescuePreferredFragment({sourceId:c.sid,start:a,end:z},new Set([row.id]));
      if (!trimmed || trimmed.start - a > .1 || z - trimmed.end > .1) {
        if (await takeOverRange(row,{sourceId:c.sid,start:a,end:z},{label:'前後アンカー間の仮割当（重なりを調整）',sync:'estimated',op:'prose-anchor-gap-trial',guardedSet})) return;
      }
      if (!trimmed) return toast('指定範囲に未使用の音声がありません。照合済み・手動調整済みの区間を確認してください', 5500);
      return run('前後アンカー間の仮割当',{blocks:[{...row,segments:[trimmed],sync:'estimated',align:[],lineage:{op:'prose-anchor-gap-trial',from:[`${row.id}@${row.rev}`],at:Date.now()}}],guardedSet});
    }
    if (action !== 'ok') return;
    if (prose) {
      if (selected.length === 1) return previewProseAssignment(selected,range,{manual:true,expected});
      if (selected.length !== 2) return;
      const segments=manualRescuePair(c.sid,a,parseClock($('#rsSplit',dlg).value),z,srcs[c.sid]?.duration);
      if (!segments) { toast('分割位置が範囲外です'); return rescueUnassigned(id); }
      const ok=await confirmDialog({title:'2行の音声を保存',body:selected.map((r,i)=>`<p>${esc(r.text)}<br>${fmt(segments[i].start)}〜${fmt(segments[i].end)}</p>`).join(''),okLabel:'2行を保存'});
      if (!ok || revision!==routeRevision) return;
      await reload();
      const guardedSet=rescueVersion(), fresh=currentRescueSearch(), current=selected.map(r=>byId[r.id]);
      if (revision!==routeRevision || !sameRescueVersion(guardedSet,expected) || current.some((r,i)=>!r || r.rev!==selected[i].rev || r.segments.length || r.sync==='manual') || !fresh.byRow.get(current[0].id)?.rows.some(r=>r.id===current[1].id)) return toast('字幕が更新されました。開き直してください');
      if (!segments.every(g=>fresh.isFree(g))) { toast('既存の割当と重複しています。範囲を調整してください'); return rescueUnassigned(id); }
      return run('2行の手動音声割当',{blocks:current.map((r,i)=>({...(({unconfirmed,...rest})=>rest)(r),segments:[segments[i]],sync:'manual',align:[],lineage:{op:'prose-rescue-pair',from:[`${r.id}@${r.rev}`],at:Date.now()}})),guardedSet});
    }
    await reload();
    if (revision !== routeRevision) return;
    const duration=srcs[c.sid]?.duration;
    if(!Number.isFinite(a)||!Number.isFinite(z)||a<0||z-a<.2||(Number.isFinite(duration)&&z>duration+.1))return toast('音声範囲が不正です');
    const selectedRows=currentRows();
    if(selectedRows.some(b=>!byId[b.id] || byId[b.id].rev !== b.rev || byId[b.id].segments.length || byId[b.id].sync === 'manual'))return toast('対象の字幕が更新されました。もう一度選んでください');
    // Never overlap an already aligned/manual segment: this is a safe trial.
    const conflict=blocks.some(b=>b.segments.some(g=>g.sourceId===c.sid&&g.start<z-.05&&g.end>a+.05)&&(b.aligned||b.sync==='manual'));
    if(conflict)return toast('照合済み・手動編集済みの音声と重なります。範囲を狭めてください',4500);
    // Vocab: each displayed row represents a separate utterance, including repeated
    // identical example sentences. Never merge repetitions or match a headword
    // merely because its token occurs inside a neighboring example.
    // The duration model is only a preview proposal, not an acoustic boundary.
    const weights=selectedRows.map(b=>Math.max(7,b.text.trim().split(/\s+/).length*.45+3));
    const sum=weights.reduce((v,w)=>v+w,0);
    let at=a;
    const updates=selectedRows.map((b,i)=>{const end=i===selectedRows.length-1?z:a+(z-a)*weights.slice(0,i+1).reduce((v,w)=>v+w,0)/sum;
      const result={...b,segments:[{sourceId:c.sid,start:+at.toFixed(2),end:+end.toFixed(2)}],sync:'estimated',align:[],lineage:{op:'vocab-rescue-trial',from:[`${b.id}@${b.rev}`],at:Date.now()}};at=end;return result;});
    if(updates.some(b=>b.segments[0].end-b.segments[0].start<.12))return toast('区間が短すぎます。対象行を減らすか範囲を広げてください');
    const guardedSet = {updatedAt:set.updatedAt, order:set.order.slice(), undo:(set.undo || []).slice(), redo:(set.redo || []).slice()};
    const ok=await confirmDialog({title:'推定位置を割り当てますか？',body:`<p>${updates.length}行に ${esc(srcs[c.sid]?.name||'音声')} の ${fmt(a)}–${fmt(z)} を割り当てます。</p><p class="small">英文の長さによる仮分割です。正しい発話位置は試聴・手動カットで確認してください。元音声は変更しません。</p>`,okLabel:'割り当てる'});
    if(ok && revision === routeRevision)await run('音声なし字幕への仮割当', {blocks:updates,guardedSet});
  }

  // ---------- actions (each = one undoable operation) ----------
  const ordered = () => ops.orderedSelection(set.order, sel).map((id) => byId[id]).filter(Boolean);
  async function run(label, changes) {
    const keepAt = (() => { try { return viewAnchor(); } catch { return null; } })();   // 1.19.19: the list stays where it was
    try {
      await commit(set, label, changes, srcs);
      // A successful edit/alignment replaces subtitle records and ordering.
      // Clear ephemeral playback/highlight references before loading the new
      // records, just as opening the material again would do. Never mutate
      // saved audio boundaries or manually edited subtitle records here.
      ++playbackRequest;
      pendingSegmentSeek = null;
      vid.pause();
      playing = null;
      curBlock = null;
      lastSubId = undefined;
      lastHighlightedRow = null;
      await reload();
      drawList();
      if (keepAt) try { restoreViewAnchor(keepAt, viewSwitchSerial); } catch {}
      drawSub();
      toast(`${label}しました`, 1200);
      return true;
    } catch (e) { toast((e?.message || String(e)), 3500); return false; }
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
      return run('削除', { blocks: list0.map((b) => ({ ...b, deleted: true, userDel: true })), order: set.order.filter((id) => !ids.has(id)) });
    }
    if (a === 'shift') {
      const v = await askText('ずらす秒数（例：0.5 / -1.2）', '0.5'); const d = parseFloat(v); if (!d) return;
      return run(`時間を${d > 0 ? '+' : ''}${d}秒ずらす`, { blocks: list0.filter((b) => b.segments.length).map((b) => ops.shiftTime(b, d)) });
    }
    if (a === 'redo') return redoAsr(list0);
    if (a === 'replace') {
      const from = await askText(`置き換える文字（${sel.size ? '選択中の項目' : 'すべての項目'}）`); if (!from) return;
      const to = (await askText('置き換え後の文字', '')) ?? ''; const target = sel.size ? list0 : blocks;
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
  // 1.18.1: delete many lines at once (undoable; the sound files stay)
  async function bulkDel(list, what) {
    if (!list.length) return toast(`${what}はありません`);
    if (!(await confirmDialog({ title: `${list.length}行を削除`, body: `<p>${esc(what)}を ${list.length}行削除します。</p><p class="small">音声ファイル自体は消えません。↶で戻せます。</p>`, okLabel: '削除する', danger: true }))) return;
    const ids = new Set(list.map((b) => b.id));
    await run(`${what}を削除`, { blocks: list.map((b) => ({ ...b, deleted: true, userDel: true })), order: set.order.filter((id) => !ids.has(id)) });
    toast(`${ids.size}行を削除しました（↶で戻せます）`, 2500);
  }
  // 1.18.1: a copy of the whole material (lines copied; the sound files are shared, not copied)
  async function dupSet() {
    const nid = newId('set_'), live = set.order.map((id) => byId[id]).filter(Boolean);
    const copy = live.map((b) => ({ ...structuredClone(b), id: newId('b_'), setId: nid, rev: 0, deleted: false }));
    const ns = { ...structuredClone({ ...set, undo: [], redo: [] }), id: nid, title: set.title + '（複製）', order: [], createdAt: Date.now(), updatedAt: Date.now() };
    delete ns.exported; delete ns.importing; delete ns.importKey;
    await sdb.put('sets', ns);
    await commit(ns, '複製から作成', { blocks: copy, order: copy.map((b) => b.id) });
    ns.undo = []; await sdb.put('sets', ns);
    for (const t of await sdb.byIndex('tracks', 'setId', set.id)) await sdb.put('tracks', { ...structuredClone(t), id: newId('t_'), setId: nid });
    toast('複製しました（音声ファイルは共有）', 2500); nav(`set?id=${nid}`);
  }
  // 1.17.6: the whole text in order, one line each, to check the script for missing / doubled / misplaced parts
  function fullText() {
    const ids = set.order.filter((id) => byId[id]); const est = estMap;
    const mark = (b) => b.aligned ? ['✓', 'ok'] : !b.segments.length ? ['○', 'na'] : b.asr ? ['起', 'asr'] : !b.text.trim() ? ['空', 'na'] : ['♪', ''];
    const tm = (b) => b.segments.length ? fmt(b.segments[0].start) : est.has(b.id) ? `≈${fmt(est.get(b.id).t)}` : '';
    // a line whose time goes back (another part of the recording put here) is marked
    let last = -1, lastSid = null; const back = new Set();
    for (const id of ids) { const g = byId[id].segments[0]; if (!g) continue; if (g.sourceId === lastSid && g.start < last - 1) back.add(id); last = g.end; lastSid = g.sourceId; }
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack st-full"><div class="row"><h3 class="grow">スクリプト全文（${ids.length}行）</h3><button type="button" class="btn sm" id="fMulti">行を選択</button><button type="button" class="btn sm" id="fRange">範囲を選ぶ</button><button class="btn sm ghost" value="x">閉じる</button></div>
      <label class="field"><span>スクリプト内を検索（英語・日本語、部分一致）</span><input id="fSearch" type="search" placeholder="例：presence / A seasonal menu" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div class="row small muted" id="fSearchCount" aria-live="polite">検索語を入力すると一致行を絞り込みます</div><div id="fBar" class="row wrap small" hidden></div>
      <p class="small muted">✓ 照合済み　○ 音声なし　起 照合できなかった文字起こし　♪ 音声あり（未照合）　<b class="warn-text">↺</b> 時間が前に戻っている行（順番の入れ違い）</p>
      <ol class="st-fulllist">${ids.map((id, i) => { const b = byId[id], [m, c] = mark(b); return `<li class="${c}" data-go="${id}"><span class="st-fm">${m}</span><span class="st-ft">${tm(b)}${back.has(id) ? ' <b class="warn-text">↺</b>' : ''}</span><span class="st-fx">${esc(b.text || b.label || '（英文なし）')}</span></li>`; }).join('')}</ol></form>`;
    dlg.returnValue = ''; dlg.showModal();
    // 1.18.1: range: tap the first and the last line, then delete (the script lines only, or every line in the range)
    let picking = false, a0 = null, a1 = null;
    let multi = false; const picked = new Set();
    const lis = $$('[data-go]', dlg);
    const search = $('#fSearch', dlg), searchCount = $('#fSearchCount', dlg);
    const applySearch = () => {
      const q = search.value.trim().toLocaleLowerCase(); let n = 0;
      lis.forEach((x) => { const b = byId[x.dataset.go]; const found = !q || `${b?.text || ''} ${b?.ja || ''} ${b?.label || ''}`.toLocaleLowerCase().includes(q); x.hidden = !found; if(found)n++; });
      searchCount.textContent = q ? `一致 ${n} / ${ids.length}行（タップで該当行へ移動）` : `全 ${ids.length}行`;
    };
    search.addEventListener('input', applySearch); applySearch();
    const mark2 = () => { const i0 = ids.indexOf(a0), i1 = ids.indexOf(a1 ?? a0); lis.forEach((x, k) => { const chosen = multi ? picked.has(x.dataset.go) : picking && a0 != null && k >= Math.min(i0, i1) && k <= Math.max(i0, i1); x.classList.toggle('st-fsel', chosen); x.setAttribute('aria-selected', String(chosen)); }); };
    const inRange = () => { const i0 = ids.indexOf(a0), i1 = ids.indexOf(a1 ?? a0); return ids.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map((id) => byId[id]); };
    const fBar = $('#fBar', dlg);
    const drawFB = () => { fBar.hidden = !(picking || multi);
      if (multi) {
        fBar.innerHTML = `<span class="grow">${picked.size}行を選択</span><button type="button" class="btn xs" id="fAllVisible">表示中を全選択</button><button type="button" class="btn xs danger" id="fDelPicked" ${picked.size ? '' : 'disabled'}>選択行を削除</button><button type="button" class="btn xs" id="fCancelMulti">やめる</button>`;
        $('#fAllVisible', fBar).onclick = () => { lis.filter(x => !x.hidden).forEach(x => picked.add(x.dataset.go)); mark2(); drawFB(); };
        $('#fCancelMulti', fBar).onclick = () => { multi = false; picked.clear(); $('#fMulti', dlg).textContent = '行を選択'; mark2(); drawFB(); };
        $('#fDelPicked', fBar).onclick = () => {
          const targets = ids.filter(id => picked.has(id)).map(id => byId[id]).filter(Boolean);
          // Close before showing the confirmation dialog; keep the saved records undoable.
          dlg.onclose = null;
          dlg.addEventListener('close', () => setTimeout(() => bulkDel(targets, 'スクリプト確認で選択した行'), 0), { once: true });
          dlg.close();
        };
        return;
      }
      if (!picking) return;
      if (a0 == null || a1 == null) { fBar.innerHTML = `<span class="grow">${a0 == null ? '始めの行' : '終わりの行'}をタップ</span><button type="button" class="btn xs" id="fCancel">やめる</button>`; }
      else { const r = inRange(), na = r.filter((b) => !b.segments.length && b.text.trim());
        fBar.innerHTML = `<span class="grow">${r.length}行を選択</span><button type="button" class="btn xs danger" id="fDelS" ${na.length ? '' : 'disabled'}>音声のない行だけ削除（${na.length}）</button><button type="button" class="btn xs danger" id="fDelA">すべて削除</button><button type="button" class="btn xs" id="fCancel">やめる</button>`;
        // open the confirmation only after this dialog has really closed (its close event would cancel the next dialog)
        const after = (fn) => { dlg.onclose = null; dlg.addEventListener('close', () => setTimeout(fn, 0), { once: true }); dlg.close(); };
        $('#fDelS', fBar).onclick = () => after(() => bulkDel(na, '選んだ範囲の音声のないスクリプト行'));
        $('#fDelA', fBar).onclick = () => after(() => bulkDel(r, '選んだ範囲の行')); }
      $('#fCancel', fBar).onclick = () => { picking = false; a0 = a1 = null; mark2(); drawFB(); }; };
    $('#fMulti', dlg).onclick = () => { multi = !multi; picking = false; a0 = a1 = null; picked.clear(); $('#fMulti', dlg).textContent = multi ? '選択を終了' : '行を選択'; mark2(); drawFB(); };
    $('#fRange', dlg).onclick = () => { multi = false; picked.clear(); $('#fMulti', dlg).textContent = '行を選択'; search.value = ''; applySearch(); picking = true; a0 = a1 = null; mark2(); drawFB(); };
    lis.forEach((x) => (x.onclick = () => { const id = x.dataset.go;
      if (multi) { if (picked.has(id)) picked.delete(id); else picked.add(id); mark2(); drawFB(); return; }
      if (picking) { if (a0 == null || a1 != null) { a0 = id; a1 = null; } else a1 = id; mark2(); drawFB(); return; }
      dlg.close(); if (view !== 'all') setView('all'); setTimeout(() => goNear(id), 50); }));
  }
  async function editStudioJa(row) {
    if (!row) return;
    vid.pause(); playing = null;
    editorPlayback?.cleanup?.(); editorPlayback = null;
    const guard = jaGuard(set);
    let choices = [], sourceError = '';
    try {
      const folder = parentFolder && await getFolderJa(parentFolder.id);
      if (folder?.sections.length) choices = studioJaChoices(set, folder.sections);
    } catch (error) { sourceError = error.message; }
    if (revision !== routeRevision) return;
    const result = studioDialog('この行の和訳を確定', `
      <div class="small">${esc(row.text)}</div>
      <label class="field">和訳<textarea id="stJaFixText" rows="3">${esc(jaView.value(row))}</textarea></label>
      ${choices.length ? `<label class="field">フォルダの英日データから探す<input id="stJaFixSearch" type="search" placeholder="英文の一部、または日本語"></label>
        <div id="stJaFixChoices" class="stack" style="max-height:32dvh;overflow:auto"></div>` :
        sourceError ? `<p class="small warn-text">候補を読み込めませんでした。和訳は直接入力できます。<br>${esc(sourceError)}</p>` : ''}`,
      [['save','この和訳で確定'],['pos','位置調整…'],['cancel','閉じる']]);
    const dlg = $('#dialog'), text = $('#stJaFixText', dlg);
    const save = $('button[value=save]', dlg);
    const updateSave = () => { save.disabled = !text.value.trim(); };
    text.oninput = updateSave;
    updateSave();
    if (choices.length) {
      const search = $('#stJaFixSearch', dlg), list = $('#stJaFixChoices', dlg);
      const at = blocks.findIndex(block => block.id === row.id);
      const context = { before: blocks[at - 1]?.text, after: blocks[at + 1]?.text };
      let candidates = [];
      const render = () => {
        candidates = findStudioJaChoices(choices, row.text, search.value, context);
        list.innerHTML = candidates.length ? candidates.map((candidate, index) => `<div class="card stack small">
          <b>${esc(candidate.en)}</b><span>${esc(candidate.ja)}</span>
          <details><summary>${esc(candidate.name)}・前後の英文</summary>
            ${candidate.before ? `<div>前　${esc(candidate.before)}</div>` : ''}
            ${candidate.after ? `<div>次　${esc(candidate.after)}</div>` : ''}
          </details><button type="button" class="btn sm" data-ja-choice="${index}">この訳を入力</button></div>`).join('') :
          '<p class="small muted">候補が見つかりません。英文の一部で検索するか、和訳を入力してください。</p>';
      };
      search.oninput = render;
      search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
      list.onclick = event => {
        const button = event.target.closest('[data-ja-choice]');
        if (!button) return;
        text.value = candidates[Number(button.dataset.jaChoice)].ja;
        updateSave();
      };
      render();
    }
    const answer = await result;
    if (answer === 'pos' && revision === routeRevision) return studioJaPosition(row.id);
    if (answer !== 'save' || revision !== routeRevision || !text.value.trim()) return;
    await run('和訳を確定', { blocks: [confirmStudioJa(row, text.value)], guardedSet: guard });
  }

  async function editBlock(b, {protectNeighbours = false,onFinish = null} = {}) {
    if (!b) return;
    const translationGuard = jaGuard(set);
    const shownJa = jaView.value(b);
    let displayedJa = shownJa;
    vid.pause(); playing = null; editorPlayback?.cleanup?.(); editorPlayback = null;
    let mode = 'hole'; let tokenToolsOpen = false; let fullRangeView = false; let work = structuredClone(b);
    // Keep the original positions visible while fine-tuning. No media is copied.
    const originalSegments = structuredClone(b.segments);
    const dlg = $('#dialog');
    let draw = () => {
      // Preserve the reading/trim position when a step button redraws the editor.
      // Replacing dialog.innerHTML otherwise resets its scroll to the top.
      const previousScroll = dlg.scrollTop;
      const previousFormScroll = dlg.querySelector('.st-edit')?.scrollTop ?? 0;
      const toks = tokensOf(work.text);
      dlg.innerHTML = `<form method="dialog" class="dlg stack st-edit"><div class="st-editor-sticky"><h3>項目の編集</h3><button class="btn sm ghost" value="cancel">閉じる</button><button class="btn sm primary" value="ok">保存</button></div>
        <div class="row"><button type="button" class="btn sm" id="ePlay">${icon('play')} 再生</button><button type="button" class="btn sm" id="eLoop">ループ</button><span id="ePlaybackState" class="small muted" role="status" aria-live="off">未再生</span><span class="small muted">${fmt(blockDur(work))}・${work.segments.length}区間</span></div>
        <div><button type="button" class="btn sm ghost" id="eTokenToggle" aria-expanded="${tokenToolsOpen}" aria-controls="eTokenTools">${tokenToolsOpen ? '▾' : '▸'} 語をタップ（穴埋め・分割）</button>
          <div id="eTokenTools" ${tokenToolsOpen ? '' : 'hidden'}>
            <div class="seg sm" id="eMode"><button type="button" data-v="hole" class="${mode === 'hole' ? 'on' : ''}">語をタップ＝穴埋め</button><button type="button" data-v="split" class="${mode === 'split' ? 'on' : ''}">語をタップ＝その前で分割</button></div>
            <div class="st-toks">${toks.map((w, i) => `<button type="button" class="st-tok ${(work.holes || []).some((h) => i >= h.s && i <= h.e) ? 'hole' : ''}" data-t="${i}">${esc(w)}</button>`).join('')}</div>
          </div>
        </div>
        <label class="field"><span>和訳</span><textarea id="eJa" rows="2">${esc(displayedJa)}</textarea></label>
        ${jaView.needsReview(b) ? '<button class="btn sm" value="ja-only">この和訳で確定</button>' : ''}
        <label class="field"><span>英文</span><textarea id="eEn" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(work.text)}</textarea></label>
        <div class="stack">${work.segments.map((s, i) => `<div class="st-segrow"><b>区間${i + 1}</b> <small class="muted">${esc(srcs[s.sourceId]?.name || '')}</small>
          <div class="st-trim" data-trim="${i}"><div class="st-trk"><i class="st-origin"></i><i class="st-playhead"></i><i class="sel" data-slide="${i}" title="長さを固定して移動"></i><b class="h st-range-pointer st-range-start" data-h="start"></b><b class="h st-range-pointer st-range-end" data-h="end"></b></div><div class="row small muted"><span class="st-tl0"></span><span class="grow"></span><span>中央をドラッグ＝長さ固定で移動／薄枠＝元の位置</span><span class="grow"></span><span class="st-tl1"></span></div></div>
          <div class="row"><button type="button" class="btn xs" data-pseg="${i}:all">${icon('play')} 区間</button><button type="button" class="btn xs" data-pseg="${i}:head">頭2秒</button><button type="button" class="btn xs" data-pseg="${i}:tail">後ろ2秒</button></div>
          <div class="row wrap"><button type="button" class="btn xs ghost" data-range-view="${i}">${fullRangeView ? '周辺を拡大' : 'ファイル全体を表示'}</button><button type="button" class="btn xs ghost" data-range-edge="${i}:start">開始を先頭へ</button><button type="button" class="btn xs ghost" data-range-edge="${i}:end">終了を末尾へ</button></div>
          <div class="row wrap"><button type="button" class="btn xs" data-slide-step="${i}:-0.1">◀ 0.10秒</button><button type="button" class="btn xs" data-slide-step="${i}:-0.05">◀ 0.05秒</button><button type="button" class="btn xs" data-slide-step="${i}:0.05">0.05秒 ▶</button><button type="button" class="btn xs" data-slide-step="${i}:0.1">0.10秒 ▶</button><button type="button" class="btn xs ghost" data-slide-reset="${i}">元の位置</button><span class="small muted" data-slide-delta="${i}"></span></div>
          <div class="row wrap"><span class="small">開始 ${fmt(s.start)}（終了固定）</span><button type="button" class="btn xs" data-adj="${i}:start:-1">−1秒</button><button type="button" class="btn xs" data-adj="${i}:start:-0.1">−0.1秒</button><button type="button" class="btn xs" data-adj="${i}:start:0.1">＋0.1秒</button><button type="button" class="btn xs" data-adj="${i}:start:1">＋1秒</button><button type="button" class="btn xs" data-now="${i}:start">今の位置</button></div>
          <div class="row wrap"><span class="small">終了 ${fmt(s.end)}（開始固定）</span><button type="button" class="btn xs" data-adj="${i}:end:-1">−1秒</button><button type="button" class="btn xs" data-adj="${i}:end:-0.1">−0.1秒</button><button type="button" class="btn xs" data-adj="${i}:end:0.1">＋0.1秒</button><button type="button" class="btn xs" data-adj="${i}:end:1">＋1秒</button><button type="button" class="btn xs" data-now="${i}:end">今の位置</button></div></div>`).join('')}</div>
        </form>`;
      dlg.scrollTop = previousScroll;
      const nextForm = dlg.querySelector('.st-edit');
      if (nextForm) nextForm.scrollTop = previousFormScroll;
      $('#ePlay', dlg).onclick = () => {
        readText();
        if (editorPlayback && !vid.paused && !editorPlayback.done) { vid.pause(); playing = null; editorPlayback.started = true; editorPlayback.stopped = true; return; }
        editorPlayback?.cleanup?.();
        playBlock(work);
        editorPlayback = { dlg, kind: 'block', loop: false, started: true, done: false, segmentEnd: () => work.segments.at(-1)?.end };
      };
      $('#eLoop', dlg).onclick = () => { readText(); editorPlayback?.cleanup?.(); playBlock(work, true); editorPlayback = { dlg, kind: 'block', loop: true, started: true, done: false, segmentEnd: () => work.segments.at(-1)?.end }; };
      $('#eTokenToggle', dlg).onclick = () => { readText(); tokenToolsOpen = !tokenToolsOpen; draw(); };
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
      $$('[data-adj]', dlg).forEach((x) => (x.onclick = () => { readText(); const [i, edge, d] = x.dataset.adj.split(':'); const s = work.segments[+i]; const duration = srcs[s.sourceId]?.duration;
        const next = +(s[edge] + Number(d)).toFixed(2);
        if (edge === 'start') s.start = Math.max(0, Math.min(s.end - 0.1, next));
        else s.end = Math.max(s.start + 0.1, Number.isFinite(duration) && duration > 0 ? Math.min(duration, next) : next);
        work.sync = 'manual'; follow = false; draw(); }));
      $$('[data-now]', dlg).forEach((x) => (x.onclick = () => { readText(); const [i, edge] = x.dataset.now.split(':'); const s = work.segments[+i]; if (vid.dataset.src !== s.sourceId) return toast('この区間のファイルを再生してから押してください'); s[edge] = +vid.currentTime.toFixed(2); work.sync = 'manual'; draw(); }));
    };
    const _draw = draw; draw = () => { _draw(); trimBars(); };
    // 1.17.6: trim bar like the iPhone video editor: drag the two edges; on release the edge is played
    function trimBars() {
      $$('[data-pseg]', dlg).forEach((x) => (x.onclick = () => { const [i, k] = x.dataset.pseg.split(':'); const g = work.segments[+i]; if (!g) return;
        const duration = vid.dataset.src === g.sourceId && Number.isFinite(vid.duration) ? vid.duration : srcs[g.sourceId]?.duration;
        const range = k === 'all' ? {start:g.start,end:g.end} : rescuePreviewRange(g.start,g.end,duration,k);
        if (!range) return toast('再生範囲を確認してください');
        playRange(g.sourceId,range.start,range.end); }));
      if (!$('#eFollow', dlg) && work.segments.length) { const st = $('.st-segrow', dlg); st?.insertAdjacentHTML('beforebegin', `<label class="chk small"><input type="checkbox" id="eFollow" ${follow ? 'checked' : ''}> 境界を共有している直前・直後の行も一緒に動かす（初期設定はオフ）</label>`);
        $('#eFollow', dlg).onchange = (e) => { follow = e.target.checked; try { localStorage.setItem('st-follow2', follow ? '1' : '0'); } catch {} }; }
      $$('[data-range-view]', dlg).forEach((x) => (x.onclick = () => { readText(); fullRangeView = !fullRangeView; draw(); }));
      $$('[data-range-edge]', dlg).forEach((x) => (x.onclick = () => {
        readText(); const [i, edge] = x.dataset.rangeEdge.split(':');
        const sg = work.segments[+i]; if (!sg) return;
        const duration = srcs[sg.sourceId]?.duration;
        if (edge === 'start') sg.start = 0;
        else if (Number.isFinite(duration) && duration > sg.start) sg.end = duration;
        else return toast('音声ファイルの終了時刻を取得できません');
        work.sync = 'manual'; follow = false; draw();
      }));
      $$('[data-slide-step]', dlg).forEach((x) => (x.onclick = () => {
        readText(); const [i, delta] = x.dataset.slideStep.split(':');
        const sg = work.segments[+i], duration = srcs[sg.sourceId]?.duration || Infinity;
        const d = +delta, length = sg.end - sg.start;
        const st = Math.max(0, Math.min(duration - length, +(sg.start + d).toFixed(3)));
        if (!Number.isFinite(st)) return;
        sg.start = +st.toFixed(3); sg.end = +(st + length).toFixed(3);
        work.sync = 'manual'; follow = false; draw();
      }));
      $$('[data-slide-reset]', dlg).forEach((x) => (x.onclick = () => {
        readText(); const i = +x.dataset.slideReset, old = originalSegments[i], sg = work.segments[i];
        if (!old || old.sourceId !== sg.sourceId) return;
        sg.start = old.start; sg.end = old.end; work.sync = 'manual'; follow = false; draw();
      }));
      $$('[data-trim]', dlg).forEach((box) => {
        const i = +box.dataset.trim, sg = work.segments[i], original = originalSegments[i];
        const D = srcs[sg.sourceId]?.duration || sg.end + 8;
        // Focus on a short time window, not the entire recording. Show original position.
        const lo = fullRangeView ? 0 : Math.max(0, Math.min(sg.start, original?.start ?? sg.start) - 15);
        const hi = fullRangeView ? Math.max(0.5, D) : Math.max(lo + 0.5, Math.min(D, Math.max(sg.end, original?.end ?? sg.end) + 15));
        const trk = $('.st-trk', box);
        const pct = (t) => Math.max(0, Math.min(100, (t - lo) / (hi - lo) * 100));
        trk.dataset.sourceId=sg.sourceId;trk.dataset.lo=String(lo);trk.dataset.hi=String(hi);
        const pos = () => {
          const L = pct(sg.start), R = pct(sg.end);
          $('.sel', trk).style.cssText = `left:${L}%;width:${Math.max(0,R-L)}%`;
          $('[data-h=start]', trk).style.left = `${L}%`;
          $('[data-h=end]', trk).style.left = `${R}%`;
          const playhead=$('.st-playhead',trk);
          if(playhead){playhead.hidden=vid.dataset.src!==sg.sourceId;playhead.style.left=pct(vid.currentTime)+'%';}
          const origin = $('.st-origin', trk);
          if (original?.sourceId === sg.sourceId) origin.style.cssText = `left:${pct(original.start)}%;width:${Math.max(0,pct(original.end)-pct(original.start))}%`;
          else origin.hidden = true;
          $('.st-tl0', box).textContent = fmt(sg.start); $('.st-tl1', box).textContent = fmt(sg.end);
          const d = sg.start - (original?.start ?? sg.start);
          const label = $(`[data-slide-delta="${i}"]`, dlg);
          if (label) label.textContent = `元の開始から ${d >= 0 ? '+' : ''}${d.toFixed(2)}秒`;
        };
        pos();
        // Use the same seek-aware media-clock range player as the 区間 button.
        const preview = () => playRange(sg.sourceId, sg.start, sg.end);
        const startDrag = (h, edge) => (e) => {
          e.preventDefault(); h.setPointerCapture(e.pointerId); readText();
          const x0 = e.clientX, start0 = sg.start, end0 = sg.end, dur = end0 - start0;
          const mv = (ev) => {
            const width = trk.getBoundingClientRect().width; if (!width) return;
            const delta = Math.round(((ev.clientX - x0) / width) * (hi - lo) * 100) / 100;
            if (edge === 'slide') {
              const ns = Math.max(0, Math.min(D - dur, +(start0 + delta).toFixed(2)));
              sg.start = ns; sg.end = +(ns + dur).toFixed(2);
              follow = false; // moving a whole word must not change its neighbours
            } else if (edge === 'start') sg.start = Math.max(0, Math.min(end0 - 0.1, +(start0 + delta).toFixed(2)));
            else sg.end = Math.min(D, Math.max(start0 + 0.1, +(end0 + delta).toFixed(2)));
            work.sync = 'manual'; pos();
          };
          h.onpointermove = mv;
          h.onpointerup = h.onpointercancel = () => {
            h.onpointermove = null; h.onpointerup = h.onpointercancel = null;
            preview(); draw();
          };
        };
        $$('[data-h]', trk).forEach((h) => h.onpointerdown = startDrag(h, h.dataset.h));
        $('[data-slide]', trk).onpointerdown = startDrag($('.sel', trk), 'slide');
      });
    }
    // 1.17.7: neighbours follow — when this line's start / end moves, the line before ends there / the line after starts there,
    // so the sound is neither heard twice nor lost between the two lines (only lines of the same file that touch or overlap)
    const ids0 = set.order.filter((id) => byId[id]), at0 = ids0.indexOf(b.id);
    // 1.19.19 fix: only the line directly before / after (never a line further away past an unassigned line — that moved
    // a correct line C when A was corrected over an unassigned B), only when they shared the boundary, and only when
    // the user ticks it (off by default). Otherwise other lines are never changed: an overlap is reported instead.
    const prevB = adjacentWithSound(ids0, byId, b.id, -1), nextB = adjacentWithSound(ids0, byId, b.id, 1);
    let follow = !protectNeighbours && (() => { try { return localStorage.getItem('st-follow2') === '1'; } catch { return false; } })();
    function neighbourChanges() {
      if (!follow || !work.segments.length || !b.segments.length) return [];
      const out = [], s0 = b.segments[0], s1 = b.segments.at(-1), n0 = work.segments[0], n1 = work.segments.at(-1);
      if (prevB && prevB.sync !== 'manual' && n0.start !== s0.start) { const pl = prevB.segments.at(-1); if (pl.sourceId === n0.sourceId && Math.abs(pl.end - s0.start) < 0.05 && n0.start > pl.start + 0.1) out.push({ ...prevB, segments: [...prevB.segments.slice(0, -1), { ...pl, end: n0.start }], align: [] }); }
      if (nextB && nextB.sync !== 'manual' && n1.end !== s1.end) { const nf = nextB.segments[0]; if (nf.sourceId === n1.sourceId && Math.abs(nf.start - s1.end) < 0.05 && n1.end < nf.end - 0.1) out.push({ ...nextB, segments: [{ ...nf, start: n1.end }, ...nextB.segments.slice(1)], align: [] }); }
      return out;
    }
    // overlap with other assigned lines after this save (reported, not fixed automatically)
    const overlapsAfter = (changed) => blocks.filter((x) => x.id !== work.id && isAssigned(x) && !changed.some((c) => c.id === x.id) &&
      x.segments.some((g) => work.segments.some((w) => w.sourceId === g.sourceId && w.start < g.end - .05 && w.end > g.start + .05)));
    const playRange = (sid, from, to) => {
      readText();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return toast('再生範囲を確認してください');
      ++playbackRequest; pendingSegmentSeek = null; playing = null;
      editorPlayback?.cleanup?.(); editorPlayback = null;
      vid.pause();
      if (!attach(sid, from)) return toast('ファイルを選んでください');
      if (editorPlayback?.cleanup) editorPlayback.cleanup();
      const preview = { dlg, kind: 'range', loop: false, started: true, done: false,
        stopped: false, seekReady: false, segmentEnd: () => to };
      editorPlayback = preview;
      // A seek to a different file may finish asynchronously on iPad/Safari.
      // Never apply the range end test to the previous playback position.
      const ready = () => {
        if (editorPlayback !== preview || vid.dataset.src !== sid) return;
        if (vid.seeking || Math.abs(vid.currentTime - from) > 0.15) return;
        preview.seekReady = true;
        vid.removeEventListener('seeked', ready);
      };
      preview.cleanup = () => vid.removeEventListener('seeked', ready);
      vid.addEventListener('seeked', ready);
      ready();
      vid.play().catch((e) => {
        if (editorPlayback !== preview || e?.name === 'AbortError') return;
        preview.stopped = true;
        toast('範囲を再生できません：' + (e?.message || '再生操作をやり直してください'));
      });
    };
    const readText = () => {
      const en = $('#eEn', dlg)?.value?.trim(), ja = $('#eJa', dlg)?.value?.trim();
      if (en == null) return;
      if (ja !== displayedJa) {
        displayedJa = ja;
        if (en !== work.text) work = ops.editText(work, en, work.ja || '');
        work = confirmStudioJa(work, ja);
      } else if (en !== work.text) work = ops.editText(work, en, work.ja || '');
    };
    // ---- 1.19.19: confirm in place / give a cut-off part to the neighbour / merge with the neighbour ----
    const idsE = set.order.filter((id) => byId[id] && !isSymbolRow(byId[id])), atE = idsE.indexOf(b.id);
    const prevRow = atE > 0 ? byId[idsE[atE - 1]] : null, nextRow = atE >= 0 && atE < idsE.length - 1 ? byId[idsE[atE + 1]] : null;
    const cutParts = () => {
      const s0 = originalSegments[0], s1 = originalSegments.at(-1), n0 = work.segments[0], n1 = work.segments.at(-1);
      return { head: s0 && n0 && n0.sourceId === s0.sourceId && n0.start > s0.start + .05 ? {sourceId:s0.sourceId,start:s0.start,end:n0.start} : null,
        tail: s1 && n1 && n1.sourceId === s1.sourceId && n1.end < s1.end - .05 ? {sourceId:s1.sourceId,start:n1.end,end:s1.end} : null };
    };
    const _draw0 = draw;
    draw = () => {
      _draw0();
      const form = dlg.querySelector('form.st-edit'); if (!form) return;
      if (work.segments.length) $('.st-editor-sticky', dlg)?.insertAdjacentHTML('beforeend', `<button class="btn sm" value="confirm" title="開始・終了を動かさずに、今の時刻で確定">この位置で確定</button>`);
      const {head, tail} = cutParts();
      form.insertAdjacentHTML('beforeend', `<div class="stack st-edextra">
        ${head && prevRow ? `<button class="btn sm" value="headPrev">切り離した冒頭（${fmt(head.start)}〜${fmt(head.end)}）を前の字幕へ</button>` : ''}
        ${tail && nextRow ? `<button class="btn sm" value="tailNext">切り離した末尾（${fmt(tail.start)}〜${fmt(tail.end)}）を次の字幕へ</button>` : ''}
        <div class="row wrap">${prevRow ? '<button class="btn sm ghost" value="mergePrev">前の字幕と結合</button>' : ''}${nextRow ? '<button class="btn sm ghost" value="mergeNext">次の字幕と結合</button>' : ''}</div>
        <div class="row wrap small"><button class="btn sm" value="jaPos">日本語訳の位置調整…</button><span class="muted">訳が1行ずれているとき：</span><button class="btn sm ghost" value="jaUp">この行から下の訳を1行上へ</button><button class="btn sm ghost" value="jaDown">1行下へ</button></div></div>`);
    };
    draw();
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (editorPlayback?.dlg === dlg) { editorPlayback.cleanup?.(); editorPlayback = null; vid.pause(); playing = null; }
      try {
        const rv = dlg.returnValue;
        if (rv === 'jaPos') return await studioJaPosition(b.id);
        // 1.19.30: the old "shift to the end" opens the range move (nothing pushed out is deleted; merge / swap / cancel)
        if (rv === 'jaUp' || rv === 'jaDown') return await studioJaPosition(b.id, rv === 'jaUp' ? -1 : 1);
        if (['headPrev','tailNext','mergePrev','mergeNext'].includes(rv)) { readText(); return await editNeighbourAction(rv, b, work, originalSegments, cutParts(), prevRow, nextRow); }
        if (rv === 'ja-only') {
          const ja = $('#eJa', dlg).value.trim();
          if (!ja) return editStudioJa(b);
          await run('和訳を確定', { blocks: [confirmStudioJa(b, ja)], guardedSet: translationGuard });
          return;
        }
        if (rv !== 'ok' && rv !== 'confirm') return;
        readText();
        if (rv === 'confirm') { if (!work.segments.length) return; delete work.unconfirmed; work.sync = 'manual'; }
        else if (JSON.stringify(work.segments) !== JSON.stringify(originalSegments)) delete work.unconfirmed;   // times moved by hand
        if (JSON.stringify(work) === JSON.stringify(b)) return;
        if (work.text !== b.text) delete work.asr;
        const nb = neighbourChanges();
        const ov = JSON.stringify(work.segments) !== JSON.stringify(originalSegments) ? overlapsAfter(nb) : [];
        await run('編集', { blocks: [work, ...nb] });
        if (ov.length) toast(`要確認：ほかの行と音声が重なっています（「${ov[0].text.slice(0, 24)}」${ov.length > 1 ? ` ほか${ov.length - 1}行` : ''}）。ほかの行は変更していません`, 6000);
        else if (nb.length) toast(`境界を共有していた隣の行（${nb.length}行）もつなげました（↶で戻せます）`, 2500);
      } finally {
        if (onFinish && revision === routeRevision) setTimeout(onFinish,60);
      }
    };
    dlg.showModal();
  }

  // 1.19.30: the Japanese position editor shared with Video Lab (ja-position-ui.js): one save = one undo step (↶).
  // shift: -1 / 1 opens it with "this line to the end, one line up / down" filled in.
  async function studioJaPosition(id, shift = 0) {
    await new Promise((r) => setTimeout(r, 60)); await reload();
    if (revision !== routeRevision) return;
    const list = set.order.map((x) => byId[x]).filter((x) => x && (x.text || '').trim() && !isSymbolRow(x));
    const k = list.findIndex((x) => x.id === id); if (k < 0) return;
    const guard = jaGuard(set), { rows, groups } = studioJaRows(blocks, list);
    const place = { src: vid.dataset.src, t: vid.currentTime };
    ++playbackRequest; vid.pause(); playing = null;
    const preview = (i, mode) => {
      const seq = mode === 'context' ? list.slice(Math.max(0, i - 1), i + 2) : [list[i]];
      const segments = seq.flatMap((x) => x.segments || []);
      if (!segments.length) return toast('この行には音声区間がありません');
      playBlock({ segments });
    };
    const result = await openJaPositionEditor({ rows, groups, center: k, play: preview,
      stop: () => { ++playbackRequest; vid.pause(); playing = null; },
      range: shift ? { a: k, b: list.length - 1, d: shift } : null, note: '保存後は ↶ で元に戻せます。' });
    ++playbackRequest; vid.pause(); playing = null;
    const back = () => { if (place.src && revision === routeRevision) attach(place.src, place.t); };
    back();
    if (!result || revision !== routeRevision) return;
    let changed;
    try { changed = studioJaEditBlocks(blocks, result.changes); } catch (error) { return toast(error.message, 4000); }
    await run(`訳の位置調整（${changed.length}行）`, { blocks: changed, guardedSet: guard });
    back();
  }
  // 1.19.19: from the edit screen — give the cut-off start / end to the neighbouring line, or merge with it (one save, one undo)
  async function editNeighbourAction(rv, b0, work, originalSegments, cuts, prevRow, nextRow) {
    await new Promise((r) => setTimeout(r, 60)); await reload();
    if (rv === 'mergePrev' || rv === 'mergeNext') {
      const other = byId[(rv === 'mergePrev' ? prevRow : nextRow)?.id], cur = byId[b0.id];
      if (!other || !cur) return toast('前後の行が見つかりません');
      const list = rv === 'mergePrev' ? [other, {...cur, text:work.text, ja:work.ja}] : [{...cur, text:work.text, ja:work.ja}, other];
      const m = ops.merge(list);
      const half = list.some((x) => x.segments.length) && list.some((x) => !x.segments.length && (x.text || '').trim());
      if (half) { m.unconfirmed = true; m.sync = 'estimated'; }
      const segTxt = m.segments.length ? m.segments.map((g) => `${fmt(g.start)}〜${fmt(g.end)}`).join('・') : '音声なし';
      const okP = confirmDialog({title: rv === 'mergePrev' ? '前の字幕と結合' : '次の字幕と結合',
        body:`<p>${esc(m.text)}</p>${m.ja ? `<p class="small muted">訳：${esc(m.ja)}（訳の区切りを確認してください）</p>` : ''}<p class="small">音声：${segTxt} ${m.segments.length ? '<button type="button" class="btn xs" id="mgPlay">▶ 試聴</button>' : ''}</p>
          ${half ? '<p class="warn-text small">片方の行には音声がありません。今の音声が結合後の全文をカバーしているか不明なので「要確認（一括仮割当・未確認）」として保存します。「音声を割当」の「前後を含めて再照合」で直せます。</p>' : ''}`, okLabel:'結合する'});
      $('#mgPlay', $('#dialog'))?.addEventListener('click', () => { stopRescuePreview(); playBlock({segments:m.segments}); });
      if (!(await okP) || revision !== routeRevision) return stopRescuePreview();
      stopRescuePreview();
      const order = set.order.slice(); const k = order.indexOf(list[0].id); order.splice(k, 2, m.id);
      return run('結合', {blocks:[m, ...list.map((x) => ({...byId[x.id], deleted:true}))], order});
    }
    const head = rv === 'headPrev', cut = head ? cuts.head : cuts.tail, target = byId[(head ? prevRow : nextRow)?.id];
    if (!cut || !target) return toast('移せる部分がありません');
    const tg = head ? target.segments.at(-1) : target.segments[0];
    const touching = tg && tg.sourceId === cut.sourceId && (head ? tg.end <= cut.start + .05 && cut.start - tg.end <= 1.5 : tg.start >= cut.end - .05 && tg.start - cut.end <= 1.5);
    const others = blocks.filter((x) => isAssigned(x) && x.id !== target.id && x.id !== b0.id && x.segments.some((g) => g.sourceId === cut.sourceId && g.start < cut.end - .05 && g.end > cut.start + .05));
    if (others.length) return toast(`その部分はほかの行（「${others[0].text.slice(0, 25)}」）と重なっています`, 5000);
    const conn = touching ? (head ? {...tg, end:cut.end} : {...tg, start:cut.start}) : null;
    const opts = target.segments.length ? (conn ? ['connect', 'replace'] : ['replace']) : ['assign'];
    const label = {connect:`今の区間につなぐ（${conn ? `${fmt(conn.start)}〜${fmt(conn.end)}` : ''}）`, replace:`今の区間と置き換える（${fmt(cut.start)}〜${fmt(cut.end)}）`, assign:`この区間を割り当てる（${fmt(cut.start)}〜${fmt(cut.end)}）`};
    const okP = confirmDialog({title: head ? '切り離した冒頭を前の字幕へ' : '切り離した末尾を次の字幕へ',
      body:`<p class="small">移す音声：${fmt(cut.start)}〜${fmt(cut.end)} <button type="button" class="btn xs" id="mvPlay">▶ 試聴</button></p>
        <p>移動先：「${esc(target.text.slice(0, 80))}」<br><span class="small muted">今の音声：${target.segments.length ? target.segments.map((g) => `${fmt(g.start)}〜${fmt(g.end)}`).join('・') : 'なし'}</span></p>
        ${target.sync === 'manual' ? '<p class="warn-text small">移動先は手動で確定した行です。下の内容で変更します。</p>' : ''}
        <div class="stack small">${opts.map((o, i) => `<label class="chk"><input type="radio" name="mvOpt" value="${o}" ${i === 0 ? 'checked' : ''}> ${label[o]}</label>`).join('')}</div>
        <p class="small muted">移動先の全文をカバーしているかは分からないので、移動先は「一括仮割当・未確認」になります（確定は試聴後に）。この行の新しい区間と合わせて1回で保存・↶で戻せます。</p>`, okLabel:'移す'});
    const dd = $('#dialog'); let pick = opts[0];
    dd.querySelectorAll('[name=mvOpt]').forEach((r) => (r.onchange = () => { pick = r.value; }));
    $('#mvPlay', dd)?.addEventListener('click', () => { stopRescuePreview(); playBlock({segments:[cut]}); });
    if (!(await okP) || revision !== routeRevision) return stopRescuePreview();
    stopRescuePreview();
    const segs = pick === 'connect' ? target.segments.map((g) => (g === tg ? conn : g)) : [cut];
    const tUp = {...target, segments:segs, sync:'estimated', unconfirmed:true, align:[], lineage:{op:'move-cut-part',from:[`${target.id}@${target.rev}`],at:Date.now()}};
    const me = {...work, sync:'manual', align:[]}; delete me.unconfirmed;
    return run(head ? '冒頭を前の字幕へ移動' : '末尾を次の字幕へ移動', {blocks:[me, tUp]});
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
    // Keep decision buttons visible while only the comparison rows scroll.
    dlg.style.maxHeight = 'min(90dvh, 90vh)';
    dlg.style.overflow = 'hidden';
    const cmpForm = $('.st-cmp-fixed', dlg);
    if (cmpForm) {
      cmpForm.style.cssText += ';display:flex;flex-direction:column;max-height:calc(min(90dvh, 90vh) - 2rem);min-height:0;overflow:hidden;gap:0';
      const cmpScroll = $('.st-cmp-scroll', cmpForm);
      if (cmpScroll) cmpScroll.style.cssText = 'overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;min-height:0;flex:1 1 auto;padding-bottom:12px';
      const cmpActions = $('.st-cmp-actions', cmpForm);
      if (cmpActions) cmpActions.style.cssText += ';flex:0 0 auto;padding:12px 0 max(8px, env(safe-area-inset-bottom));border-top:1px solid var(--border, rgba(128,128,128,.3));background:var(--surface, inherit)';
    }
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
  async function redoAsr(list0, { thenAlign = false } = {}) {
    const targets = list0.filter((b) => b.segments.length);
    if (!targets.length) return toast('選択した行に音声区間の割当がありません。元MP3の未割当区間を調べてください', 4500);
    const skipped = list0.length - targets.length;
    if (skipped) toast(`音声区間のない${skipped}行を除き、${targets.length}行を起こし直します`, 4000);
    const ids = [...new Set(targets.flatMap((b) => b.segments.map((g) => g.sourceId)))];
    if (ids.some((id) => !(srcs[id]?.stored ? srcs[id].blob : sessionFiles.get(id)))) return toast('動画・音声ファイルを選び直してから実行してください', 4000);
    const total = targets.reduce((a, b) => a + blockDur(b), 0);
    const def = QUALITY[localStorage.getItem('st-asrq-redo')] ? localStorage.getItem('st-asrq-redo') : 'high';
    if (!(await confirmDialog({ title: `${targets.length}行を起こし直す`, body: `<p>音声区間がある${targets.length}行（合計 ${fmtMin(total)}）だけを起こし直します。${skipped ? `音声区間のない${skipped}行は変更せずに飛ばします。` : ''}結果は今の文と並べて表示し、行ごとに選んでから反映します。</p>
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
    dlg.innerHTML = `<form method="dialog" class="dlg stack st-cmp st-cmp-fixed"><div class="st-cmp-scroll"><h3>結果を比べる</h3><p class="small muted">${cancelled ? '途中で中止しました。終わった行だけ表示しています。' : ''}行ごとに使う方を選びます。新しい文は直せます。</p>
      ${results.map((r, i) => { const same = r.neu === r.b.text, empty = !r.neu; return `<div class="card stack st-cmprow">
        <div class="row"><button type="button" class="btn xs" data-pl="${i}">▶︎</button><small class="muted grow">${fmt(r.b.segments[0].start)}–${fmt(r.b.segments.at(-1).end)}${same ? '・同じ結果' : ''}</small></div>
        <label class="chk"><input type="radio" name="c${i}" value="old" ${same || empty ? 'checked' : ''}> 今：${esc(r.b.text || '（なし）')}</label>
        <label class="chk"><input type="radio" name="c${i}" value="new" ${same || empty ? '' : 'checked'} ${empty ? 'disabled' : ''}> 新：</label>
        <textarea rows="2" data-nt="${i}" ${empty ? 'disabled placeholder="（文字にできませんでした）"' : ''}>${esc(r.neu)}</textarea></div>`; }).join('')}
      </div><div class="row end st-cmp-actions"><button class="btn ghost" value="cancel">反映しない</button><button class="btn primary" value="ok">反映</button></div></form>`;
    $$('[data-pl]', dlg).forEach((x) => (x.onclick = () => playBlock(results[+x.dataset.pl].b)));
    $$('[data-nt]', dlg).forEach((x) => (x.oninput = () => { const r = $(`input[name=c${x.dataset.nt}][value=new]`, dlg); if (r) r.checked = true; }));
    dlg.returnValue = ''; dlg.showModal();
    await new Promise((q) => (dlg.onclose = q)); vid.pause(); playing = null;
    if (dlg.returnValue !== 'ok') return;
    const ch = results.map((r, i) => ({ r, use: $(`input[name=c${i}]:checked`, dlg)?.value, t: ($(`[data-nt="${i}"]`, dlg)?.value || '').trim() }))
      .filter((x) => x.use === 'new' && x.t && x.t !== x.r.b.text).map((x) => ({ ...ops.editText(byId[x.r.b.id] || x.r.b, x.t, (byId[x.r.b.id] || x.r.b).ja || ''), asr: true }));
    if (!ch.length) return toast('変更はありません');
    await run(`${ch.length}行を起こし直し`, { blocks: ch });
    // 1.18.2: lines left over from matching, transcribed again: match them to the script right away
    if (thenAlign && blocks.some((b) => b.script && !b.segments.length)) { toast('スクリプトと照合します…', 1500); await reload(); await runAlign(); }
  }

  // Stored in the existing block records; survives closing/reopening the studio.
  // Saved-results dialog is independent of the shared menu dialog.
  // On iOS Safari a pending close event on #dialog could close a newly opened
  // view or invoke a stale onclose callback. Do not reuse that element here.
  async function showStructureSaved() {
    await reload();
    const saved=blocks.filter(b=>b.segments?.length && (b.lineage?.op==='structure-align' || b.structureAlign?.method==='speech-first' || (set.structureAlignReceipt?.blockIds||[]).includes(b.id)))
      .sort((a,b)=>a.segments[0].start-b.segments[0].start);
    const lastReceipt=set.structureAlignReceipt;
    const draft=await sdb.get('sets',set.id).then(x=>x?.speechFirstDraft).catch(()=>null);
    const dlg=document.createElement('dialog');
    dlg.className='st-speech-pick';
    dlg.style.cssText='max-width:min(94vw,700px);max-height:85dvh;overflow:auto;padding:20px;border:0;border-radius:18px;background:#292f49;color:#fff';
    const norm=t=>(t||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const possibleDuplicates=new Map();
    // A review hint only: never delete or merge a record automatically.
    for(const b of saved){
      const g=b.segments[0];
      const matches=blocks.filter(x=>x.id!==b.id && x.segments?.length && norm(x.text)===norm(b.text) && norm(b.text) && x.segments.some(y=>y.sourceId===g.sourceId && Math.min(y.end,g.end)-Math.max(y.start,g.start)>0.12));
      if(matches.length)possibleDuplicates.set(b.id,matches.length);
    }
    dlg.innerHTML=`<div class="dlg stack"><h3>発話区切りの保存結果（${saved.length}件）</h3>
      <p class="small">${lastReceipt ? `前回の保存記録：${esc(new Date(lastReceipt.at).toLocaleString('ja-JP'))}・選択${lastReceipt.selected}件／書込${lastReceipt.written}件／確認${lastReceipt.verified}件。` : 'この教材の保存記録はありません。'} 保存済みの照合結果です。▶で再生し、「行へ」で一覧に戻ります。元音声やスクリプトは変更しません。</p>
      <div class="stack" style="max-height:57vh;overflow:auto">${draft?.length?`<p class="small">未確定の解析候補 ${draft.length}件があります。「⋯ → 発話区切りの候補を再表示」で確認できます。</p>`:''}${saved.length?saved.map((b,i)=>`<div class="card stack" style="padding:10px"><div>${esc(b.text)}</div><small class="muted">${fmt(b.segments[0].start)}〜${fmt(b.segments.at(-1).end)}・${esc(srcs[b.segments[0].sourceId]?.name||'音声ファイル')}</small>${possibleDuplicates.has(b.id)?'<small class="muted">同じ文字列・重複区間の候補あり（復唱の可能性／削除しません）</small>':''}<div class="row"><button type="button" class="btn sm" data-saved-play="${i}">▶ 再生</button><button type="button" class="btn sm ghost" data-saved-jump="${i}">行へ移動</button></div></div>`).join(''):'<p class="muted">保存済みの発話区切り照合結果は見つかりません。</p>'}</div>
      <button type="button" class="btn ghost" data-saved-close>閉じる</button></div>`;
    document.body.appendChild(dlg);
    let disposed=false;
    const finish=()=>{
      if(disposed)return;
      disposed=true;
      if(dlg.open)dlg.close();
      dlg.remove();
    };
    dlg.addEventListener('close',finish,{once:true});
    dlg.querySelector('[data-saved-close]').onclick=finish;
    $$('[data-saved-play]',dlg).forEach(btn=>btn.onclick=()=>{
      const b=saved[Number(btn.dataset.savedPlay)];
      if(!b)return;
      try { const result=playBlock(b); if(result?.catch)result.catch(e=>toast('再生できません：'+(e?.message||e))); }
      catch(e){toast('再生できません：'+(e?.message||e));}
    });
    $$('[data-saved-jump]',dlg).forEach(btn=>btn.onclick=()=>{
      const b=saved[Number(btn.dataset.savedJump)];
      finish();
      if(!b)return;
      view='all';onlySel=false;drawViewB();drawList();
      const row=list.querySelector(`[data-id="${b.id}"]`);
      if(row){row.scrollIntoView({block:'center'});row.classList.add('cur');}
    });
    dlg.showModal();
  }

  // Dedicated dialog: avoids queued `close` events from the shared #dialog on iPad Safari.
  async function pickSpeechFirstCandidates(draft) {
    return new Promise(resolve=>{
      const d=document.createElement('dialog');
      d.className='st-speech-pick';
      d.style.cssText='max-width:min(94vw,700px);max-height:85dvh;overflow:auto;padding:20px;border:0;border-radius:18px;background:#292f49;color:#fff';
      d.innerHTML=`<div class="dlg stack"><h3>照合候補 ${draft.length}件</h3><p class="small">解析結果は教材に一時保存済みです。画面を閉じても再解析せず再表示できます。</p><div class="stack" style="max-height:55dvh;overflow:auto">${draft.map((x,i)=>`<label class="chk"><input type="checkbox" data-pick="${i}" checked><span>${esc(x.text.slice(0,90))}<br><small>${fmt(x.start)}〜${fmt(x.end)}・一致度 ${Math.round(x.score*100)}%</small></span></label>`).join('')}</div><div class="row end"><button type="button" class="btn ghost" data-cancel>あとで確認</button><button type="button" class="btn primary" data-save>選択した候補を保存</button></div></div>`;
      document.body.appendChild(d);
      let settled=false;
      const finish=(v)=>{if(settled)return;settled=true;d.removeEventListener('close',closed);if(d.open)d.close();d.remove();resolve(v);};
      const closed=()=>finish(null);
      d.addEventListener('close',closed);
      d.querySelector('[data-cancel]').onclick=()=>finish(null);
      d.querySelector('[data-save]').onclick=()=>finish(new Set([...d.querySelectorAll('[data-pick]:checked')].map(e=>draft[Number(e.dataset.pick)].blockId)));
      d.showModal();
    });
  }
  async function resumeSpeechFirstCandidates(){
    const fresh=await sdb.get('sets',set.id);
    const draft=fresh?.speechFirstDraft||[];
    if(!draft.length)return confirmDialog({title:'未確定の候補はありません',body:'この教材に再表示できる解析候補はありません。',okLabel:'閉じる',cancelLabel:null});
    const ids=await pickSpeechFirstCandidates(draft);
    if(!ids?.size)return;
    await saveSpeechFirstCandidates(draft.filter(x=>ids.has(x.blockId)),draft.length);
  }
  async function saveSpeechFirstCandidates(chosenCandidates, selectedCount){
    await reload();
    const skips=[];
    const changes=[];
    const reassigned = new Set(chosenCandidates.filter(x => x.reassign).flatMap(x => byId[x.blockId]?.segments || []));
    const occupied = vocabInputs().occupied.filter(g => !reassigned.has(g));
    const guard = rescueVersion();
    for(const x of chosenCandidates){
      const latest=byId[x.blockId];
      if(!latest){skips.push('対象行なし: '+x.text);continue;}
      if(latest.segments?.length && !(x.reassign && latest.aligned && latest.sync === 'auto' && !latest.manual)){skips.push('既に音声あり: '+x.text);continue;}
      if (latest.sync === 'manual' || latest.text !== x.text || (x.blockRev != null && latest.rev !== x.blockRev)) {
        skips.push('手動調整済み・解析後に編集: ' + x.text); continue;
      }
      if(!set.order.includes(latest.id)){skips.push('教材の行一覧に存在しない: '+x.text);continue;}
      if(!srcs[x.sourceId]){skips.push('音声ファイルID不明: '+x.text);continue;}
      if (!(x.end > x.start && x.start >= 0) || [...occupied, ...changes.flatMap(b => b.segments)].some(
          g => g.sourceId === x.sourceId && g.start < x.end && g.end > x.start)) {
        skips.push('既存の音声区間と重複: ' + x.text); continue;
      }
      changes.push({...latest,segments:[{sourceId:x.sourceId,start:x.start,end:x.end}],aligned:true,sync:'auto',structureAlign:{method:'speech-first',score:x.score,at:Date.now()},lineage:{op:'structure-align',from:[`${latest.id}@${latest.rev}`],at:Date.now(),score:x.score}});
    }
    let written=0,verified=[];let error='';
    try{
      if(changes.length){const r=await commit(set,'発話区切りから照合',{blocks:changes,guardedSet:guard},srcs);written=r.blocks.length;}
      await reload();drawList();
      verified=changes.filter(x=>{const b=byId[x.id],a=b?.segments?.[0],g=x.segments[0];return a?.sourceId===g.sourceId&&Math.abs(a.start-g.start)<.01&&Math.abs(a.end-g.end)<.01;});
      const fresh=await sdb.get('sets',set.id);
      await sdb.put('sets',{...fresh,structureAlignReceipt:{at:Date.now(),selected:selectedCount,written,verified:verified.length,blockIds:verified.map(x=>x.id)},speechFirstDraft:(fresh.speechFirstDraft||[]).filter(x=>!verified.some(v=>v.id===x.blockId))});
      await reload();
    }catch(e){error=e?.message||String(e);}
    await confirmDialog({title:error?'保存エラー':verified.length===chosenCandidates.length?'照合結果を保存しました':'保存結果を確認してください',body:`<p>選択 ${selectedCount}件／保存対象 ${changes.length}件／書込 ${written}件／再読込確認 ${verified.length}件</p>${error?`<p class="warn-text">${esc(error)}</p>`:''}${skips.length?`<details><summary>保存対象外 ${skips.length}件（理由）</summary><p class="small">${skips.map(esc).join('<br>')}</p></details>`:''}<p>未確定の候補は再表示できます。</p>`,okLabel:'閉じる',cancelLabel:null});
  }

  // Opt-in: boundaries first, independent ASR per utterance, then monotone script alignment.
  // Preview only: no ASR rows or script changes are persisted before explicit approval.
  async function importBySpeechStructure(range = null) {
    let sl=scriptLines().filter(b => b.sync !== 'manual');
    // 音声のないスクリプト行がなくても、照合済み（自動）の行があれば、それを対象に割り当て直せる（手動で直した行は変えない）
    let reassign = false;
    if (!sl.length) {
      sl = set.order.map(id => byId[id]).filter(b => b && !b.asr && b.text.trim() && b.aligned && b.sync !== 'manual' && !b.manual && !isSymbolRow(b));
      reassign = sl.length > 0;
    }
    if(!sl.length)return toast('スクリプトの行がありません。先にスクリプトを取り込んでください（照合済みの行があれば、それを割り当て直せます）',5000);
    const sources=materialSourceIds().map(id => srcs[id]).filter(x => x && (x.stored ? x.blob : sessionFiles.get(x.id)));
    if(!sources.length)return toast('音声ファイルを選び直してください',4500);
    // Analyze all speech regions in sequential batches; preserve source-absolute timestamps.
    // Only the selected window is ASR'd; all timestamps remain source-absolute.
    const defaultSource=sources.length===1?sources[0]:sources.find(x=>blocks.some(b=>b.segments[0]?.sourceId===x.id))||sources[0];
    const cfg=range ? {source:sources.find(x => x.id === range.sourceId), start:range.start, end:range.end, profile:set.materialType || 'prose'} : await new Promise(resolve=>{
      const dlg=$('#dialog');
      if(dlg.open){dlg.onclose=null;dlg.close();}
      dlg.innerHTML=`<form method="dialog" class="dlg stack"><h3>発話を先に区切って照合（試験版）</h3>
        <label>音声ファイル<select id="structSource">${sources.map(x=>`<option value="${esc(x.id)}" ${x.id===defaultSource.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="field">教材の種類<select id="structProfile">${[['prose','連続朗読・MA'],['vocab','単語・例文・復唱'],['toeic-sentences','TOEIC Part 1 写真描写'],['toeic-response','TOEIC Part 2 質問・応答'],['toeic-dialogue','TOEIC Part 3 会話'],['toeic-talk','TOEIC Part 4 説明文'],['toeic-mixed','TOEIC 混在']].map(([id, label]) => `<option value="${id}" ${set.materialType === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <p class="small">指定範囲の最後まで解析します。同じ音声・範囲・教材の種類を選ぶと、中断前の解析結果を再利用します。</p>
        <div class="row" style="flex-wrap:wrap"><label class="field grow">開始（分）<input id="structStartMin" type="number" min="0" step="1" inputmode="numeric" value="0"></label><label class="field grow">開始（秒）<input id="structStartSec" type="number" min="0" max="59" step="1" inputmode="numeric" value="0"></label></div>
        <div class="row" style="flex-wrap:wrap"><label class="field grow">終了（分・空欄で末尾）<input id="structEndMin" type="number" min="0" step="1" inputmode="numeric" placeholder="末尾まで"></label><label class="field grow">終了（秒）<input id="structEndSec" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="0"></label></div>
        <p class="hint">無料・端末内処理。音声の途中からでもスクリプト全体から一致候補を探します。既存の保存結果と手動編集は上書きしません。処理中は画面を開いたままにしてください。</p>
        <p id="structRangeError" class="warn-text small" aria-live="polite"></p>
        <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="go">解析を開始</button></div></form>`;
      let selected=null;
      const form=dlg.querySelector('form');
      form.addEventListener('submit',e=>{
        const submit=e.submitter;
        if(submit?.value!=='go')return;
        const sid=dlg.querySelector('#structSource').value;
        const startMin=dlg.querySelector('#structStartMin').value;
        const startSec=dlg.querySelector('#structStartSec').value;
        const endMin=dlg.querySelector('#structEndMin').value;
        const endSec=dlg.querySelector('#structEndSec').value;
        const validClock=(m,sec)=>/^\d+$/.test(m)&&/^\d+$/.test(sec)&&Number(sec)<60;
        const start=validClock(startMin,startSec)?Number(startMin)*60+Number(startSec):NaN;
        const end=endMin.trim()===''&&endSec.trim()===''?Infinity:(validClock(endMin||'0',endSec||'0')?Number(endMin||0)*60+Number(endSec||0):NaN);
        const source=sources.find(x=>x.id===sid);
        const duration=Number(source?.duration);
        if(!source||!Number.isFinite(start)||start<0||!Number.isFinite(end)&&end!==Infinity||end<=start||(Number.isFinite(duration)&&duration>0&&start>=duration)){
          e.preventDefault();dlg.querySelector('#structRangeError').textContent='開始・終了時刻を確認してください（例：05:00〜07:00）。';return;
        }
        selected={source,start,end,profile:dlg.querySelector('#structProfile').value};
      });
      dlg.onclose=()=>resolve(dlg.returnValue==='go'?selected:null);
      dlg.showModal();
    });
    if(!cfg?.source || revision !== routeRevision)return;
    const chosen = cfg.source;
    const blob = chosen.stored ? chosen.blob : sessionFiles.get(chosen.id);
    const container = isContainer(chosen, blob) && chosen.derived !== 'audio16k';
    if (container && !chosen.audio) {
      try {
        chosen.audio = await decideTrack(chosen, blob);
        await sdb.put('sources', chosen);
      } catch (error) {
        return toast('音声トラックを選べませんでした。' + (error?.message || error));
      }
    }
    if (revision !== routeRevision) return;
    let tr=null;const dlg=$('#dialog');let cancelled=false;
    await new Promise(r=>setTimeout(r,60));
    if (revision !== routeRevision || dlg.open) return;
    dlg.innerHTML='<form method="dialog" class="dlg stack"><h3>発話区間を解析中</h3><p id="structMsg">音声を準備しています…</p><div id="structCap"></div><button class="btn ghost" value="cancel">中止</button></form>';
    dlg.onclose=()=>{cancelled=true;tr?.close();};dlg.showModal();
    const progress = $('#structMsg', dlg);
    const say = text => { if (progress.isConnected) progress.textContent = text; };
    const lock=await navigator.wakeLock?.request?.('screen').catch(()=>null);
    let result = [], utterances = [], failed = false;
    try {
      const info = container ? await probeSource(chosen, blob).catch(() => null) : null;
      const tracks = info ? audioTracks(info) : [];
      const track = tracks.find(t => t.id === chosen.audio?.trackId) || tracks[chosen.audio?.index ?? 0];
      const ranged = Boolean(track && canExtract(track));
      let whole = null;
      if (!ranged) {
        if (!(chosen.duration > 0 && chosen.duration <= 180 && blob.size <= 18 * 1024 * 1024)) {
          throw new Error('長い音声は、区間抽出に対応したAACのM4AまたはMP4を選んでください');
        }
        whole = (await sourceAudio16k(chosen, blob, { say })).audio;
        highPass(whole);
      }
      const end = Math.min(cfg.end, track?.duration || chosen.duration || (whole?.length || 0) / 16000);
      if (!(end > cfg.start)) throw new Error('指定範囲に音声がありません');
      const vocabProfile = cfg.profile === 'vocab';
      const rapid = vocabProfile || ['toeic-response', 'toeic-dialogue', 'toeic-mixed'].includes(cfg.profile);
      const ownSegments = reassign ? new Set(sl.flatMap(b => b.segments)) : null;   // 割り当て直す行の古い範囲は、重なりの判定から外す
      const occupied = vocabInputs().occupied.filter(g => g.sourceId === chosen.id && !(ownSegments && ownSegments.has(g)));
      const checkpointKey = `speech-first:${set.id}`;
      const signature = JSON.stringify([chosen.id, blob.size, chosen.audio?.trackId, chosen.audio?.index, cfg.profile, cfg.start, end]);
      const saved = await sdb.get('meta', checkpointKey);
      let cursor = saved?.signature === signature ? saved.cursor : cfg.start;
      utterances = saved?.signature === signature ? saved.utterances : [];
      const visited = new Set(utterances.map(u => `${u.start}:${u.end}`));
      const checkpoint = () => sdb.put('meta', { key: checkpointKey, signature, cursor, utterances });
      const formatTime = t => Math.round(t * 1000) / 1000;
      while (cursor < end && !cancelled && revision === routeRevision) {
        let stop = Math.min(end, cursor + 24);
        say(`${Math.floor(100 * (cursor - cfg.start) / (end - cfg.start))}%　${fmt(cursor)}〜${fmt(stop)}`);
        let offset = 0, audio = whole;
        if (ranged) {
          const extracted = await extractTrack(blob, track, Math.max(cfg.start, cursor - .5), Math.min(end, stop + 1.5));
          offset = extracted.start;
          audio = (await decodeTo16k(extracted.blob)).audio;
          highPass(audio);
        }
        const from = Math.max(0, Math.floor((Math.max(cfg.start, cursor - .25) - offset) * 16000));
        const to = Math.min(audio.length, Math.ceil((Math.min(end, stop + 1.25) - offset) * 16000));
        const origin = from / 16000 + offset;
        const regions = speechRegions(audio.subarray(from, to), 16000, rapid ? { gapFrames: 5, minGap: .1 } : undefined);
        if (stop < end) {
          const crossing = regions.find(region => origin + region.start < stop && origin + region.end > stop);
          if (crossing) {
            const at = origin + crossing.start;
            const finish = origin + crossing.end;
            if (finish < stop + 1.1) stop = Math.min(end, Math.ceil((finish + .05) * 1000) / 1000);
            else if (at >= cursor + 16) stop = Math.floor(at * 1000) / 1000;
          }
        }
        let previousEnd = cursor, index = 0;
        for (const region of regions) {
          if (cancelled || revision !== routeRevision) break;
          const start = formatTime(Math.max(previousEnd, origin + region.start));
          const finish = formatTime(Math.min(stop, origin + region.end));
          if (finish > start) previousEnd = finish;
          if (finish - start < .15 || occupied.some(g => g.start < finish && g.end > start) ||
              visited.has(`${start}:${finish}`)) continue;
          say(`${Math.min(99, Math.floor(100 * (start - cfg.start) / (end - cfg.start)))}%　発話 ${++index}/${regions.length}　${fmt(start)}`);
          tr ||= openTranscriber('en', say, { quality: 'acc' });
          const cues = await recognisePiece(tr, audio, Math.max(0, start - offset), Math.min(audio.length / 16000, finish - offset));
          if (cancelled || revision !== routeRevision) break;
          visited.add(`${start}:${finish}`);
          utterances.push({ sourceId: chosen.id, start, end: finish, text: (cues.raw || cues.map(x => x.text).join(' ')).trim(), vad: true });
          if (utterances.length % 8 === 0) await checkpoint();
        }
        if (!cancelled && revision === routeRevision) cursor = stop;
        await checkpoint();
      }
      if (!cancelled && revision === routeRevision) {
        utterances.sort((a, b) => a.start - b.start);
        await sdb.tx(['sets'], 'readwrite', tx => {
          const store = tx.objectStore('sets'), req = store.get(set.id);
          req.onsuccess = () => { if (req.result) store.put({ ...req.result, materialType: cfg.profile }); };
        });
        const available = utterances.filter(u => !occupied.some(g => u.start < g.end && u.end > g.start));
        if (!vocabProfile) {
          const proposals = alignUtterances(sl.map(b => ({ text: b.text })), available, { profile: cfg.profile });
          result = proposals.map(p => ({ b: sl[p.scriptIndex], u: p.range || available[p.utteranceIndex], score: p.score }))
            .filter(x => (reassign || !x.b.segments.length) && x.b.sync !== 'manual');
        }
      }
    } catch (e) {
      failed = true;
      if (!cancelled) toast('解析失敗：' + (e?.message || e), 6000);
    } finally {
      tr?.close(); lock?.release?.();
      if (dlg.open && dlg.contains(progress)) { dlg.onclose = null; dlg.close(); }
    }
    if (revision !== routeRevision) return;
    if (cancelled) return toast('解析を中断しました。同じ条件で再開できます');
    if (failed) return;
    if (cfg.profile === 'vocab') return previewVocabAlignment(null, [...utterances, ...vocabInputs().evidence.filter(cue =>
      !utterances.some(u => u.sourceId === cue.sourceId && u.start < cue.end && u.end > cue.start))]);
    if(!result.length)return confirmDialog({title:'安全な一致候補がありません',body:'発話区間は検出しましたが、認識結果とスクリプトの強い一致が得られませんでした。字幕は変更していません。短い単語や重複する例文は誤対応防止のため保留します。',okLabel:'閉じる',cancelLabel:null});
    // Store candidates BEFORE displaying them. No audio blobs are duplicated.
    const draft=result.map(({b,u,score})=>({blockId:b.id,blockRev:b.rev,sourceId:chosen.id,start:u.start,end:u.end,score,text:b.text,...(reassign?{reassign:true}:{})}));
    const freshForDraft=await sdb.get('sets',set.id);
    const draftIds = new Set(draft.map(x => x.blockId));
    const prior = (freshForDraft.speechFirstDraft || []).filter(x => !draftIds.has(x.blockId));
    await sdb.put('sets',{...freshForDraft,speechFirstDraft:[...prior,...draft]});
    const ids=await pickSpeechFirstCandidates(draft);
    if(!ids || revision !== routeRevision)return;
    if(!ids.size)return toast('候補が選択されていません',3500);
    await saveSpeechFirstCandidates(draft.filter(x=>ids.has(x.blockId)),ids.size);
  }

  // 1.19.43: 金フレ型の音声を、発話区間の構造（見出し語 → 例文 → 例文の繰り返し → 無音）で台本に割り当てる。
  // 文字起こしの時刻は粗い（1秒前後）ので、境界には使わない。境界は発話区間から取り、文字起こしは「どの項目か」の手がかりにだけ使う。
  // 音声1本ごとに、全体の発話区間を調べ、台本の項目と順序を保って対応づける。手がかりが弱い音声には何も割り当てない。プレビューで確認してから保存（↶で戻せる）。
  async function sourceSpeechRegions(reader, label, { say, cancelled, resume = null, onProgress = null }) {
    const { end } = reader, out = resume?.regions ? resume.regions.map(r => [...r]) : []; let cursor = resume?.cursor || 0, n = 0;
    while (cursor < end && !cancelled()) {
      let stop = Math.min(end, cursor + 24);
      say(`${label}　発話区間 ${Math.floor(100 * cursor / end)}%`);
      const { audio, offset } = await reader.read(cursor - .5, stop + 1.5);
      const from = Math.max(0, Math.floor((Math.max(0, cursor - .25) - offset) * 16000)), to = Math.min(audio.length, Math.ceil((Math.min(end, stop + 1.25) - offset) * 16000));
      const origin = from / 16000 + offset, regs = speechRegions(audio.subarray(from, to), 16000);
      if (stop < end) {
        const crossing = regs.find(r => origin + r.start < stop && origin + r.end > stop);
        if (crossing) { const finish = origin + crossing.end; if (finish < stop + 1.1) stop = Math.min(end, Math.ceil((finish + .05) * 1000) / 1000); else if (origin + crossing.start >= cursor + 16) stop = Math.floor((origin + crossing.start) * 1000) / 1000; }
      }
      let prev = cursor;
      for (const r of regs) { const a = Math.round(Math.max(prev, origin + r.start) * 1000) / 1000, z = Math.round(Math.min(stop, origin + r.end) * 1000) / 1000; if (z > a) prev = z; if (z - a >= .15) out.push([a, z]); }
      cursor = stop;
      if (onProgress && ++n % 6 === 0) await onProgress({ cursor, regions: out });   // 6窓ごとに保存（中断しても続きから）
      await new Promise(r => setTimeout(r, 0));
    }
    return out;
  }
  // 例文（繰り返される発話）の1回目だけを文字起こしする。見出し語と繰り返し（2回目）は文字起こししない（全体の約1/3）。時刻は発話区間そのもの。
  async function recogniseExampleUnits(reader, label, units, { say, cancelled, done = [], onHint = null }) {
    const targets = units.filter(u => u.reads.length > 1).map(u => u.span), hints = done.map(h => ({ ...h }));
    const finished = new Set(done.map(h => `${h.start}:${h.end}`));
    let tr = null, i = 0;
    try {
      while (i < targets.length && !cancelled()) {
        if (finished.has(`${targets[i][0]}:${targets[i][1]}`) || ( done.some(h => h.start === targets[i][0]) )) { i++; continue; }   // 前回までに文字起こし済み
        const first = targets[i]; let j = i;
        while (j + 1 < targets.length && targets[j + 1][1] - first[0] <= 22) j++;   // 1回の読み込みに収まる例文をまとめる
        const { audio, offset } = await reader.read(first[0] - .5, targets[j][1] + .5);
        tr ||= openTranscriber('en', say, { quality: 'acc' });
        for (let k = i; k <= j && !cancelled(); k++) {
          const [a, z] = targets[k];
          if (finished.has(`${a}:${z}`)) continue;
          say(`${label}　例文を文字起こし ${k + 1}/${targets.length}（途中で中止しても、続きから再開できます）`);
          const cues = await recognisePiece(tr, audio, Math.max(0, a - .1 - offset), Math.min(audio.length / 16000, z + .1 - offset));
          const text = (cues.raw || cues.map(x => x.text).join(' ')).trim();
          hints.push({ text, start: a, end: z }); finished.add(`${a}:${z}`);
          if (onHint && hints.length % 5 === 0) await onHint(hints);   // 5件ごとに保存
        }
        if (onHint) await onHint(hints);
        i = j + 1;
      }
    } finally { tr?.close(); }
    return hints;
  }
  async function assignByKinfureStructure() {
    await reload();
    if (revision !== routeRevision) return;
    const { rows } = vocabInputs();
    // 台本は1行ずつ、見出し語か例文。見出し語に例文が1つ以上続く（例文は音声で2回繰り返される）
    const lines = rows.map(row => ({ row, text: row.text, kind: isVocabHead(row) ? 'head' : 'example' }));
    // フォルダに全体スクリプトが登録されていれば、各行の全体スクリプト上の位置を求める（台本に足りない行を補うため）
    let kfLines = null;
    try {
      const folder = set.folder ? await createStudioFolder(set.folder) : null, kf = folder ? await loadKfScript(folder.id) : null;
      if (kf) {
        kfLines = kf.lines.map(l => ({ text: l.text, kind: l.kind === 'word' ? 'head' : 'example' }));
        const tags = tagsFor(set.order.map(id => byId[id]).filter(Boolean), kf);
        lines.forEach(l => { const i = tags.get(l.row.id); if (i != null) l.scriptIndex = i; });
      }
    } catch { kfLines = null; }
    if (lines.length < 6) return toast('見出し語と例文を含むスクリプトを先に取り込んでください', 4500);
    const hintsBy = new Map();
    for (const b of set.order.map(id => byId[id]).filter(Boolean)) if (b.asr && b.text.trim() && b.segments.length === 1) { const g = b.segments[0]; if (!hintsBy.has(g.sourceId)) hintsBy.set(g.sourceId, []); hintsBy.get(g.sourceId).push({ text: b.text, start: g.start, end: g.end, id: b.id }); }
    const sources = materialSourceIds().map(id => srcs[id]).filter(x => x && (x.stored ? x.blob : sessionFiles.get(x.id)));
    if (!sources.length) return toast('音声ファイルを選び直してください', 4500);
    const dlg = $('#dialog'); if (dlg.open) { dlg.onclose = null; dlg.close(); await new Promise(r => setTimeout(r, 60)); }
    let cancelled = false;
    dlg.innerHTML = '<form method="dialog" class="dlg stack"><h3>発話区間の構造で割り当て</h3><p id="saMsg" class="small">音声を準備しています…</p><button class="btn ghost" value="cancel">中止</button></form>';
    dlg.onclose = () => { cancelled = true; };
    dlg.showModal();
    const say = text => { const el = $('#saMsg', dlg); if (el?.isConnected) el.textContent = text; };
    const found = [], notes = [], taken = new Set(), extras = [];
    const WHY = { 'weak-evidence': '文字起こしとの一致が弱く、割り当てできません', 'no-structure': '発話区間が少なく、構造が見つかりません', 'no-repeat-structure': '例文が繰り返される構造が見つかりません（この方法の対象外です）', 'no-hints': '文字起こしがありません' };
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    try {
      for (const src of sources) {
        if (cancelled || revision !== routeRevision) break;
        const label = src.name || '音声';
        let reader, regions;
        // 途中結果（発話区間・例文の文字起こし）は音声ごとに保存する。同じ音声なら、中断したところから続ける（台本や設定が変わっても有効）。
        const ckKey = `sa-ckpt:${set.id}:${src.id}`, ckSig = [src.id, src.size ?? (src.blob?.size || 0), src.duration || 0].join('|');
        let ck = await sdb.get('meta', ckKey); if (ck?.sig !== ckSig) ck = { key: ckKey, sig: ckSig, cursor: 0, regions: [], regionsDone: false, hints: [] };
        const saveCk = () => sdb.put('meta', { ...ck, savedAt: Date.now() });
        if (ck.regionsDone || ck.cursor || ck.hints.length) notes.push(`${label}: 前回の途中結果から続けます（発話区間 ${ck.regionsDone ? '済み' : `${Math.round(ck.cursor)}秒まで`}・例文の文字起こし ${ck.hints.length}件）`);
        try {
          reader = await sourceAudioReader(src, say);
          if (ck.regionsDone) regions = ck.regions;
          else {
            const raw = await sourceSpeechRegions(reader, label, { say, cancelled: () => cancelled || revision !== routeRevision, resume: { cursor: ck.cursor, regions: ck.regions }, onProgress: async ({ cursor, regions: part }) => { ck.cursor = cursor; ck.regions = part; await saveCk(); } });
            if (cancelled || revision !== routeRevision) { ck.regions = raw; await saveCk(); break; }
            ck.regions = raw; ck.cursor = reader.end; ck.regionsDone = true; await saveCk(); regions = raw;
          }
          regions = joinShortGaps(regions);
        } catch (e) { notes.push(`${src.name}: ${e?.message || e}`); continue; }
        if (cancelled) break;
        say(`${label}　台本と対応づけています…`);
        const rowsIn = lines.map(l => ({ text: l.text, kind: l.kind }));
        // まず既存の文字起こし（速い）。例文の半分以上を対応づけられなければ、例文だけを文字起こしして（約1/3の量）やり直す
        let res = alignByStructure(rowsIn, regions, hintsBy.get(src.id) || []);
        const exampleRows = lines.filter(l => l.kind === 'example').length, repeatedUnits = res.repeated || 0;
        const covered = r => r.pairs.filter(p => lines[p.row].kind === 'example').length;
        if (repeatedUnits >= 3 && (!res.ok || covered(res) < .6 * Math.min(repeatedUnits, exampleRows))) {
          try {
            const extra = await recogniseExampleUnits(reader, label, parseUnits(regions), { say, cancelled: () => cancelled || revision !== routeRevision, done: ck.hints, onHint: async (all) => { ck.hints = all.map(h => ({ ...h })); await saveCk(); } });
            if (cancelled) break;
            const second = alignByStructure(rowsIn, regions, [...(hintsBy.get(src.id) || []), ...extra]);
            if (second.ok && (!res.ok || second.pairs.length >= res.pairs.length)) res = second;
            notes.push(`${label}: 例文 ${extra.length} 件を文字起こしして照合しました`);
          } catch (e) { notes.push(`${label}: 例文の文字起こしを実行できませんでした（${e?.message || e}）`); }
        }
        if (!res.ok) { notes.push(`${src.name}: ${WHY[res.why] || '割り当てできません'}（発話 ${res.units}・繰り返し ${res.repeated}）`); continue; }
        let used = 0;
        for (const p of res.pairs) { if (taken.has(p.row)) continue; taken.add(p.row); used++; found.push({ ...p, src, line: lines[p.row] }); }
        // 音声にはあるのに台本の行に割り当てられなかった発話: 数と種類が合えば、行の割り当て・全体スクリプトからの行の追加を提案する
        for (const plan of planMissing(lines.map(l => ({ text: l.text, kind: l.kind, scriptIndex: l.scriptIndex })), res.pairs, res.unitList || [], kfLines)) extras.push({ ...plan, src });
        notes.push(`${src.name}: 発話 ${res.units} のうち ${used} を対応づけ（確実 ${res.supported}・補完 ${res.inferred}）`);
      }
    } finally { lock?.release?.(); if (dlg.open) { dlg.onclose = null; dlg.close(); } }
    await new Promise(r => setTimeout(r, 60));   // 閉じたイベントが、次の画面の onclose に届かないよう待つ
    if (cancelled || revision !== routeRevision) return;
    if (!found.length) return confirmDialog({ title: '割り当てできませんでした', body: `<p>字幕は変更していません。</p><ul class="small">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`, okLabel: '閉じる', cancelLabel: null });
    found.sort((a, b) => a.row - b.row);
    // 確実度: 文字起こしの一致が強く（一致度0.6以上）、隣り合う行と区別できるものは「確実」。順序から補ったもの・弱い手がかりのもの・行の追加は「要確認」。
    const isHigh = p => p.kind === 'supported' && p.sim >= .6;
    const extraItems = [];   // 提案のうち保存できるもの（行の割り当て・行の追加）
    extras.forEach(x => { if (x.type !== 'unknown') x.items.forEach(it => { if (it.row != null && (lines[it.row].row.sync === 'manual' || lines[it.row].row.manual || taken.has(it.row))) return; extraItems.push({ ...it, src: x.src, after: x.after, before: x.before, kind: it.kind ?? lines[it.row]?.kind }); }); });
    const unknowns = extras.filter(x => x.type === 'unknown');
    const mm = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    const locked = p => p.line.row.sync === 'manual' || p.line.row.manual;
    let again = true, savedHigh = 0;
    while (again) {   // 「確実な分を保存→残りを確認」のとき、残りで画面をもう一度出す
    again = false;
    const rowsHtml = found.slice(0, 80).map((p, i) => `<div class="row wrap"><label class="grow"><input type="checkbox" data-sa="${i}" ${locked(p) ? 'disabled' : 'checked'}> ${p.line.kind === 'head' ? '【見出し語】' : ''}${esc(p.line.text)}${p.kind === 'inferred' ? '（順序から補完）' : ''}${locked(p) ? '（手動のため変更しません）' : ''}</label>
      <button type="button" class="btn sm ghost" data-sa-play="${i}">▶ ${fmt(p.segments[0].start)}${p.segments.length > 1 ? `（×${p.segments.length}）` : ''}</button></div>`).join('');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>発話区間の構造で割り当て</h3>
      <ul class="small">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
      <p class="small">${found.length}行${found.length > 80 ? '（先頭80行を表示。保存はすべて）' : ''}（確実 <b>${found.filter(p => isHigh(p) && !locked(p)).length}</b>・要確認 <b>${found.filter(p => !isHigh(p) && !locked(p)).length}</b>${extraItems.length ? `・台本にない発話 <b>${extraItems.length}</b>` : ''}）。境界は発話区間から取り、繰り返される例文は反復として保持します。聴いて確認してから保存してください。保存は1回の操作として ↶ で戻せます。</p>
      <div class="stack" style="max-height:50vh;overflow:auto">${rowsHtml}${extraItems.length ? `<b class="small">台本にない発話（行の割り当て・追加の提案：${extraItems.length}件）</b><p class="small muted">前後の行と、数・種類（見出し語は1回・例文は繰り返し）が合うものだけを提案します。行の追加は、フォルダの全体スクリプトの行です。</p>${extraItems.map((it, i) => `<div class="row wrap"><label class="grow"><input type="checkbox" data-sx="${i}" checked> ${it.row != null ? '' : '【追加】'}${it.kind === 'head' ? '【見出し語】' : ''}${esc(it.row != null ? lines[it.row].text : it.text)}</label><button type="button" class="btn sm ghost" data-sx-play="${i}">▶ ${mm(it.segments[0].start)}${it.segments.length > 1 ? `（×${it.segments.length}）` : ''}</button></div>`).join('')}` : ''}${unknowns.length ? `<p class="small muted">説明できない発話：${unknowns.reduce((n, x) => n + x.items.length, 0)}件（${unknowns.slice(0, 6).map(x => mm(x.items[0].segments[0].start)).join('・')}${unknowns.length > 6 ? '…' : ''} など）。台本の行が足りないか、全体スクリプトの登録が必要です。</p>` : ''}</div>
      <div class="row end"><button class="btn ghost" value="cancel">閉じる</button>${found.some(p => isHigh(p) && !locked(p)) && (found.some(p => !isHigh(p) && !locked(p)) || extraItems.length) ? `<button class="btn" value="auto">確実な${found.filter(p => isHigh(p) && !locked(p)).length}件を保存して、残りを確認</button>` : ''}<button class="btn primary" value="apply">保存（チェックした行）</button></div></form>`;
    $$('[data-sx-play]', dlg).forEach(btn => btn.onclick = () => { const it = extraItems[Number(btn.dataset.sxPlay)]; playBlock({ segments: it.segments.map(g => ({ sourceId: it.src.id, start: g.start, end: g.end })) }); });
    $$('[data-sa-play]', dlg).forEach(btn => btn.onclick = () => { const p = found[Number(btn.dataset.saPlay)]; playBlock({ segments: p.segments.map(g => ({ sourceId: p.src.id, start: g.start, end: g.end })) }); });
    dlg.returnValue = '';
    let chosenExtras = [];
    let autoMode = false;
    const chosen = await new Promise(resolve => { dlg.onclose = () => { if (dlg.returnValue === 'auto') { autoMode = true; resolve(found.filter(p => isHigh(p) && !locked(p))); return; } if (dlg.returnValue === 'apply') chosenExtras = extraItems.filter((it, i) => dlg.querySelector(`[data-sx="${i}"]`)?.checked); resolve(dlg.returnValue === 'apply' ? found.filter((p, i) => i >= 80 ? !locked(p) : dlg.querySelector(`[data-sa="${i}"]`)?.checked) : []); }; dlg.showModal(); });
    if (revision !== routeRevision) return;
    ++playbackRequest; pendingSegmentSeek = null; playing = null; vid.pause();
    if (!chosen.length && !chosenExtras.length) return;
    await reload();
    const changes = [], assigned = [], added = [];
    for (const p of chosen) {
      const cur = byId[p.line.row.id];
      if (!cur || cur.rev !== p.line.row.rev || cur.sync === 'manual' || cur.manual) continue;
      const segs = p.segments.map(g => ({ sourceId: p.src.id, start: g.start, end: g.end }));
      const c = { ...cur, segments: segs, aligned: true, sync: 'auto', align: [], lineage: { op: 'structure-assign', from: [`${cur.id}@${cur.rev}`], at: Date.now() } };
      if (segs.length > 1) { c.rep = segs.length; c.endEst = false; } else delete c.rep;
      changes.push(c); assigned.push(...segs);
    }
    const withSegs = (cur, it) => {
      const segs = it.segments.map(g => ({ sourceId: it.src.id, start: g.start, end: g.end }));
      const c = { ...cur, segments: segs, aligned: true, sync: 'auto', align: [], lineage: { op: 'structure-assign', from: [`${cur.id}@${cur.rev}`], at: Date.now() } };
      if (segs.length > 1) { c.rep = segs.length; c.endEst = false; } else delete c.rep;
      assigned.push(...segs); return c;
    };
    const insertAfter = new Map(), insertBefore = new Map();   // 行の id → その後ろ／前に足す新しい行
    for (const it of chosenExtras) {
      if (it.row != null) {
        const cur = byId[lines[it.row].row.id];
        if (cur && cur.rev === lines[it.row].row.rev && cur.sync !== 'manual' && !cur.manual && !changes.some(c => c.id === cur.id)) changes.push(withSegs(cur, it));
      } else {
        const prev = it.before != null ? byId[lines[it.before]?.row?.id] : byId[lines[it.after]?.row?.id];
        if (!prev) continue;
        const segs = it.segments.map(g => ({ sourceId: it.src.id, start: g.start, end: g.end }));
        const nb = newBlock(set.id, { text: it.text, script: true, kind: it.kind === 'head' ? 'word' : 'example', segments: segs, aligned: true, sync: 'auto', cueRefs: { en: [], ja: [] }, ...(segs.length > 1 ? { rep: segs.length, endEst: false } : {}), lineage: { op: 'structure-assign', from: [], at: Date.now() } });
        added.push(nb); assigned.push(...segs);
        const map = it.before != null ? insertBefore : insertAfter;   // 先頭の見出し語などは、最初の行の前に入れる
        const list = map.get(prev.id) || []; list.push(nb); map.set(prev.id, list);
      }
    }
    if (!changes.length && !added.length) return toast('字幕が更新されたため保存できません。もう一度実行してください');
    // 割り当てた範囲に重なる、分割されたままの文字起こし行（未編集）は片づける（残すと重なりの警告が出るため）
    const touched = new Set(changes.map(c => c.id)), drop = [];
    for (const b of set.order.map(id => byId[id]).filter(Boolean)) {
      if (!b.asr || b.aligned || b.sync === 'manual' || b.ja || b.holes?.length || b.rev !== 1 || b.lineage?.op !== 'split' || b.segments.length !== 1 || touched.has(b.id)) continue;
      const g = b.segments[0], dur = g.end - g.start;
      // 見出し語・例文・繰り返しにまたがる文字起こし行は、割り当てた範囲（発話の部分）の合計が行の半分以上を覆うときに片づける
      const covered = assigned.filter(a => a.sourceId === g.sourceId).reduce((sum, a) => sum + Math.max(0, Math.min(a.end, g.end) - Math.max(a.start, g.start)), 0);
      if (dur > 0 && covered >= .5 * dur) drop.push(b);
    }
    const guardedSet = { updatedAt: set.updatedAt, order: set.order.slice(), undo: (set.undo || []).slice(), redo: (set.redo || []).slice() };
    const baseOrder = [];
    for (const id of set.order) { for (const nb of insertBefore.get(id) || []) baseOrder.push(nb.id); if (drop.some(b => b.id === id)) continue; baseOrder.push(id); for (const nb of insertAfter.get(id) || []) baseOrder.push(nb.id); }
    if (!(await run('金フレ型：構造で割り当て', { blocks: [...changes, ...added, ...drop.map(b => ({ ...b, deleted: true }))], order: baseOrder, guardedSet }))) return;   // 失敗したときは、run がエラーの内容を表示している
    toast(`${changes.length}行を割り当て${added.length ? `、${added.length}行を追加` : ''}しました（重なっていた文字起こし ${drop.length}行を整理）。↶で戻せます`, 6000);
    if (autoMode) {   // 確実な分を保存した。残り（要確認・台本にない発話）で、もう一度確認画面を出す
      savedHigh += changes.length;
      const done = new Set(chosen.map(p => p.row));
      for (let k = found.length - 1; k >= 0; k--) if (done.has(found[k].row)) found.splice(k, 1);
      if (found.length || extraItems.length) { await new Promise(r => setTimeout(r, 400)); again = true; }
    }
    }
  }

  // Virtual split: both halves refer to the same stored source and original timestamps.
  // This is intentionally limited to untranscribed audio rows: splitting an aligned
  // sentence would otherwise silently corrupt its text/audio correspondence.
  // Split an entire source into two independent sets, regardless of subtitle assignment.
  // The media blob remains shared; each set has its own blocks and edit history.
  async function splitAudioRange() {
    const ids = [...new Set([set.sourceId, ...blocks.flatMap(b => (b.segments || []).map(g => g.sourceId))].filter(id => srcs[id]))];
    if (!ids.length) return toast('分割する元音声がありません');
    const dlg = $('#dialog');
    const opts = ids.map(id => `<option value="${esc(id)}">${esc(srcs[id].name || '音声')}（${fmt(srcs[id].duration || 0)}）</option>`).join('');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>音声ファイルを前半・後半に分割</h3>
      <p class="small muted">音声トラックから前半・後半の2ファイルを実際に作成し、別教材として保存します。元教材は安全のため保持します。MP4の場合、動画映像は引き継がず音声（M4A）を抽出します。対応外の形式は変更せず中止します。</p>
      <label class="field"><span>元音声・動画</span><select id="wholeSplitSource">${opts}</select></label>
      <div class="field"><span>分割時刻（分・秒・小数）</span>
        <div class="row" style="align-items:center;gap:6px;flex-wrap:wrap">
          <input id="wholeSplitMin" type="number" min="0" step="1" inputmode="numeric" aria-label="分" style="width:76px" placeholder="20"><span>分</span>
          <input id="wholeSplitSec" type="number" min="0" max="59" step="1" inputmode="numeric" aria-label="秒" style="width:65px" placeholder="30"><span>秒</span>
          <input id="wholeSplitDec" type="number" min="0" max="9" step="1" inputmode="numeric" aria-label="0.1秒" style="width:57px" placeholder="5"><span>／10秒</span>
        </div><input id="wholeSplitAt" type="hidden"></div>
      <p id="wholeSplitInfo" class="small muted"></p>
      <div class="card stack"><b>分割前の音声確認</b><p class="small muted">境界の直前・直後をそれぞれ約4秒再生します。</p>
        <div class="row wrap"><button type="button" class="btn sm" id="splitHearBefore">前半の終わりを聴く</button><button type="button" class="btn sm" id="splitHearAfter">後半の始まりを聴く</button><button type="button" class="btn sm ghost" id="splitHearStop">停止</button></div>
        <audio id="splitHearAudio" controls preload="none" style="width:100%;max-width:100%"></audio>
        <p class="small muted" id="splitHearStatus">時刻を指定して試聴してください</p>
      </div>
      <label class="field"><span>スクリプトの分け方</span><select id="splitScriptPolicy"><option value="shared">複製優先：時刻未割当の文章を前後両方に残す</option><option value="strict">分離優先：時刻が分かる文章だけ各教材に入れる（未割当は元教材に保持）</option></select></label>
      <p class="small muted">境界をまたぐ音声付き文章は両方に残し、要確認にします。元教材は削除しません。</p>
      <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">前半・後半の教材を作成</button></div></form>`;
    const pick = $('#wholeSplitSource',dlg), field = $('#wholeSplitAt',dlg), info = $('#wholeSplitInfo',dlg);
    const mins = $('#wholeSplitMin',dlg), secs = $('#wholeSplitSec',dlg), decs = $('#wholeSplitDec',dlg);
    const syncClock = () => {
      const m = Number(mins.value), sec = Number(secs.value), d = Number(decs.value);
      const valid = mins.value !== '' && secs.value !== '' && decs.value !== '' &&
        Number.isInteger(m) && m >= 0 && Number.isInteger(sec) && sec >= 0 && sec < 60 &&
        Number.isInteger(d) && d >= 0 && d <= 9;
      field.value = valid ? `${m}:${String(sec).padStart(2,'0')}.${d}` : '';
    };
    const setClock = (value) => {
      const t = Math.max(0, Math.round(Number(value || 0) * 10));
      mins.value = String(Math.floor(t / 600));
      secs.value = String(Math.floor(t / 10) % 60);
      decs.value = String(t % 10);
      syncClock();
    };
    const refresh = () => {
      const src = srcs[pick.value], duration = Number(src?.duration) || 0, at = parseClock(field.value);
      info.textContent = `元音声：0:00.0〜${fmt(duration)} / 分割位置：${Number.isFinite(at)?fmt(at):'未入力'}${at > 0.1 && at < duration - 0.1 ? '（分割可能）' : '（範囲外）'}`;
    };
    pick.onchange = () => { setClock((Number(srcs[pick.value]?.duration)||0)/2); refresh(); };
    for (const input of [mins, secs, decs]) input.addEventListener('input', () => { syncClock(); refresh(); });
    pick.onchange();
    if (vid.dataset.src === pick.value && vid.currentTime > 0) { setClock(vid.currentTime); refresh(); }
    const preview = $('#splitHearAudio',dlg), previewStatus = $('#splitHearStatus',dlg);
    let previewEnd = null;
    const stopPreview = () => { preview.pause(); previewEnd = null; };
    const playPreview = async (side) => {
      stopPreview();
      const source = srcs[pick.value], duration = Number(source?.duration) || 0, at = parseClock(field.value);
      if (!Number.isFinite(at) || at <= .1 || at >= duration - .1) return toast('先に有効な分割時刻を入力してください');
      const url = mediaURL(source);
      if (!url) return toast('音声が端末にありません。元ファイルを再接続してください');
      const begin = side === 'before' ? Math.max(0,at-4) : at;
      previewEnd = side === 'before' ? at : Math.min(duration,at+4);
      previewStatus.textContent = `${side === 'before' ? '前半の終わり' : '後半の始まり'}：${fmt(begin)}〜${fmt(previewEnd)}`;
      if (preview.src !== url) preview.src = url;
      try { preview.currentTime = begin; await preview.play(); } catch (e) { previewStatus.textContent = `試聴できません：${e.message}`; }
    };
    preview.addEventListener('timeupdate', () => { if (previewEnd != null && preview.currentTime >= previewEnd - .04) stopPreview(); });
    $('#splitHearBefore',dlg).onclick = () => playPreview('before');
    $('#splitHearAfter',dlg).onclick = () => playPreview('after');
    $('#splitHearStop',dlg).onclick = stopPreview;
    pick.addEventListener('change',stopPreview);
    field.addEventListener('input',stopPreview);
    dlg.returnValue = ''; dlg.onclose = null; dlg.showModal();
    await new Promise(resolve => { dlg.onclose = resolve; });
    stopPreview(); preview.removeAttribute('src'); preview.load();
    if (dlg.returnValue !== 'ok') return;
    const scriptPolicy = $('#splitScriptPolicy',dlg).value;
    const sid = pick.value, duration = Number(srcs[sid]?.duration) || 0, at = parseClock(field.value);
    if (!Number.isFinite(at) || at <= 0.1 || at >= duration - 0.1) return toast(`分割時刻は 0:00.0〜${fmt(duration)} の内側に指定してください`, 5500);
    const original = set.order.map(id => byId[id]).filter(Boolean);
    const otherSources = original.some(b => (b.segments || []).some(g => g.sourceId !== sid));
    if (otherSources) return toast('複数の元音声を含む教材です。誤って別音声を分割しないよう、まず対象の音声だけを別教材にしてください。', 6500);
    const boundary = +at.toFixed(3);
    const origin = srcs[sid], blob = origin.stored ? origin.blob : sessionFiles.get(sid);
    if (!blob) return toast('元の音声がありません。ファイルを再接続してください', 6000);
    // Extract encoded audio samples by timestamp, without decoding the whole 40-minute MP4.
    // This produces actual independent files, unlike a splitRange reference to the original.
    let tracks, track;
    try {
      const info = await probeSource(origin, blob);
      tracks = audioTracks(info);
      track = tracks.find(t => t.id === origin.audio?.trackId) || tracks[origin.audio?.index ?? 0] || tracks[0];
      if (!track || !canExtract(track)) throw new Error('音声トラックを部分抽出できない形式です。AAC音声を含むMP4/M4Aまたは対応WAVを使用してください');
    } catch(e) { return toast(`音声分割は実行されませんでした：${e.message}`, 7000); }
    const confirmed = await confirmDialog({title:'音声ファイルを実際に2分割',body:`<p>前半 ${fmt(boundary)}、後半 ${fmt(duration-boundary)} の独立した音声ファイルを保存します。</p><p>元教材・元音声は保持します。保存容量は前半・後半の音声分だけ増えます。動画の場合は音声のみ保存します。</p>`,okLabel:'分割して保存'});
    if (!confirmed) return;
    const created = [];
    try {
      for (const left of [true,false]) {
        const offset = left ? 0 : boundary, finish = left ? boundary : duration;
        const extracted = await extractTrack(blob, track, offset, finish);
        if (!extracted.blob?.size) throw new Error('音声データが空です');
        const newSid = newId('src_'), nid = newId('set_');
        const partDuration = Math.max(0, finish - offset);
        const newSource = {id:newSid, name:`${origin.name || '音声'}（${left?'前半':'後半'}）.${extracted.codec}`,
          kind:'audio', mime:extracted.blob.type || (extracted.codec==='m4a'?'audio/mp4':'audio/wav'),
          size:extracted.blob.size, origSize:extracted.blob.size, duration:partDuration,
          stored:true, blob:extracted.blob, derived:'split-audio', createdAt:Date.now()};
        await sdb.put('sources',newSource);
        created.push({sid:newSid,nid});
        const ns = {...structuredClone({...set,undo:[],redo:[]}),id:nid,
          title:`${set.title}（${left?'前半':'後半'} ${fmt(boundary)}）`,sourceId:newSid,
          order:[],createdAt:Date.now(),updatedAt:Date.now()};
        delete ns.splitRange;delete ns.exported;delete ns.importing;delete ns.importKey;
        const out=[];
        for (const b of original) {
          const gs=(b.segments||[]).filter(g=>g.sourceId===sid);
          if (gs.length) {
            const clipped=gs.map(g=>({...g,sourceId:newSid,
              start:+(Math.max(g.start,offset)-offset).toFixed(3),
              end:+(Math.min(g.end,finish)-offset).toFixed(3)})).filter(g=>g.end>g.start+.01);
            if (!clipped.length) continue;
            const crosses=gs.some(g=>g.start<boundary&&g.end>boundary);
            out.push({...structuredClone(b),id:newId('b_'),setId:nid,rev:0,deleted:false,segments:clipped,
              ...(crosses?{aligned:false,sync:'estimated',splitNeedsReview:true}:{})});
          } else if (b.text?.trim() && scriptPolicy==='shared') {
            out.push({...structuredClone(b),id:newId('b_'),setId:nid,rev:0,deleted:false,segments:[],splitNeedsReview:true});
          }
        }
        // A fresh source must always be transcribable, even when all previous rows have text.
        if (!out.some(b=>!b.text?.trim() && (b.segments||[]).some(g=>g.sourceId===newSid))) {
          out.push(newBlock(nid,{segments:[{sourceId:newSid,start:0,end:partDuration}],text:'',sync:'auto',label:'文字起こし用音声'}));
        }
        await sdb.put('sets',ns);
        await commit(ns,'実音声を分割して独立教材を作成',{blocks:out,order:out.map(b=>b.id)}, {...srcs,[newSid]:newSource});
        ns.undo=[];ns.redo=[];await sdb.put('sets',ns);
        for (const t of await sdb.byIndex('tracks','setId',set.id)) await sdb.put('tracks',{...structuredClone(t),id:newId('t_'),setId:nid});
      }
      toast('前半・後半の音声を別ファイルとして保存しました。元教材は保持しています。',6500);nav('sets');
    } catch(e) {
      logErr(`音声の実分割に失敗：${e.message}`);
      toast('分割中に失敗しました。元教材は変更されていません。作成済みの片側がある場合は一覧で確認してください。',7000);
    }
  }

  // ---------- transcription (Whisper in the browser; audio never leaves the device) ----------
  // Pieces of ~2 min are transcribed one by one and saved as they finish. The block that still has no text keeps the rest,
  // so if iOS reloads the page, running it again continues from where it stopped.
  // auto: 音声付き単語帳の作成から呼ぶとき。確認・精度の選択・文字起こし後の照合は出さない（精度は前回の選択、なければ標準）。
  async function runAsr({ auto = false } = {}) {
    const pool = !auto && sel.size ? ordered() : blocks;
    const targets = pool.filter((b) => !b.text.trim() && b.segments.length === 1);
    if (!targets.length) {
      // 1.18.2: everything has text already — offer to transcribe the left-over lines again (another accuracy) and match again
      const rest = pool.filter((b) => !b.aligned && b.segments.length && (b.asr || !b.text.trim()));
      if (rest.length && await confirmDialog({ title: '照合できなかった行を起こし直す', body: `<p>英文のない音声はもうありません。スクリプトと照合できなかった文字起こし ${rest.length}行を、別の精度でもう一度文字にして、照合し直しますか？</p><p class="small muted">次の画面で精度を選べます。結果は今の文と並べて確認できます。</p>`, okLabel: '起こし直す' })) return redoAsr(rest, { thenAlign: true });
      if (rest.length) return;
      return toast(sel.size ? '選んだ項目に、英文のない音声がありません' : '英文のない音声項目がありません（文字起こしは英文が空の項目だけに行います）', 4000);
    }
    const bySrc = new Map(); for (const b of targets) { const id = b.segments[0].sourceId; if (!bySrc.has(id)) bySrc.set(id, []); bySrc.get(id).push(b.id); }
    if ([...bySrc.keys()].some((id) => !(srcs[id]?.stored ? srcs[id].blob : sessionFiles.get(id)))) return toast('動画・音声ファイルを選び直してから実行してください', 4000);
    const total = targets.reduce((a, b) => a + blockDur(b), 0);
    const big = [...bySrc.keys()].map((id) => srcs[id]).filter((x) => x.kind === 'video' && x.size > 150 * 1024 * 1024);
    if (!auto && !(await confirmDialog({ title: '文字起こし（試験的）', body: `<p>${targets.length}項目（合計 ${fmtMin(total)}）を、この端末の中で英語の文字に起こします。</p>${big.length ? `<p class="warn-text small">大きな動画（${fmtSize(big[0].size)}）はメモリ不足で途中で止まることがあります。先に「⋯」→「容量を減らす」をすると安定します。</p>` : ''}
      <div class="stack">${Object.entries(QUALITY).map(([k, t]) => `<label class="chk"><input type="radio" name="asrq" value="${k}" ${(QUALITY[localStorage.getItem('st-asrq2')] ? localStorage.getItem('st-asrq2') : 'acc') === k ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      <label class="chk"><input type="checkbox" id="asrVocab"> 文字起こし後に金フレ型で照合する</label>
      <p class="hint">・最初の1回だけモデルをダウンロードします（無料・Wi-Fi推奨）。音声は外部に送りません。<br>・無音の部分は飛ばし、話している部分を少しずつ処理して、終わった分から保存します。止まっても、もう一度実行すると続きから。<br>・画面は開いたままにしてください。結果は自動の下書きです。</p>`, okLabel: '始める' }))) return;
    const saved = (() => { try { return localStorage.getItem('st-asrq2'); } catch { return null; } })();
    const quality = auto ? (QUALITY[saved] ? saved : 'acc') : ($('#dialog input[name=asrq]:checked')?.value || 'acc');
    const vocabAfterAsr = !auto && $('#asrVocab')?.checked;
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
        // Long MP4: extract only a short AAC/PCM sample window at a time.
        // Never decode the entire 40-minute screen recording into Float32 buffers.
        const container = isContainer(src, fileBlob) && src.derived !== 'audio16k';
        const info = container ? await probeSource(src, fileBlob) : null;
        const tracks = info ? audioTracks(info) : [];
        const track = tracks.find(t => t.id === src.audio?.trackId) || tracks[src.audio?.index ?? 0] || tracks[0];
        const ranged = !!(track && canExtract(track));
        if (container && src.duration > 300 && !ranged) throw new Error('長時間MP4の音声トラックを小分けに取り出せません（対応外の音声形式）。元ファイルをMP3/M4Aに変換してください。');
        let whole = null;
        if (!ranged) whole = (await sourceAudio16k(src, fileBlob, { box: $('#asrCap', dlg), say: (t) => msg(`${src.name}：${t}`) })).audio;
        for (const bid of ids) {
          // The remaining untranscribed block is updated after every successful piece.
          while (!cancelled && byId[bid] && !byId[bid].deleted && !byId[bid].text.trim() && byId[bid].segments.length === 1) {
          const b0 = byId[bid]; const sg = b0.segments[0];
          const chunkEnd = ranged ? Math.min(sg.end, sg.start + 90) : sg.end;
          let offset = 0, audio;
          if (ranged) {
            msg(`${src.name}：${fmt(sg.start)}〜${fmt(chunkEnd)} の音声を小分けに展開中…`);
            const x = await extractTrack(fileBlob, track, sg.start, chunkEnd);
            offset = x.start;
            audio = (await decodeTo16k(x.blob)).audio;
          } else audio = whole;
          highPass(audio);
          const pieces = speechPieces(audio, sg.start - offset, Math.min(chunkEnd - offset, audio.length / 16000), { len: 25 });   // ≤ one 30 s recognition window: longer pieces lost their tail
          const skipped = (sg.end - sg.start) - pieces.reduce((a, [x, y]) => a + y - x, 0);
          if (!pieces.length) {
            // No reliable speech activity: preserve this span for manual/retry, do not loop forever.
            done += chunkEnd - sg.start; bar(); noSpeech.push(`${src.name} ${fmt(sg.start)}〜${fmt(chunkEnd)}`);
            break;
          }
          for (let pi = 0; pi < pieces.length; pi++) {
            const [localStart, localEnd] = pieces[pi];
            const ps0 = localStart + offset, pe0 = localEnd + offset;
            const ps = ps0, pe = pi === pieces.length - 1 ? chunkEnd : pieces[pi + 1][0] + offset;   // the gap after a piece is silence: it is skipped
            if (cancelled) break;
            const t0 = Date.now(), lbl = `${src.name}：${fmt(ps0)}〜${fmt(pe0)}`;
            msg(`${lbl} を文字起こし中…`); crumb(`文字起こし ${lbl}`);
            const tick = setInterval(() => msg(`${lbl} を文字起こし中…（${Math.round((Date.now() - t0) / 1000)}秒）${speed ? `・残り目安 ${fmtMin(Math.max(0, (total - done) / speed))}` : ''}`), 1000);
            let cues; try { cues = await recognisePiece(tr, audio, localStart, localEnd, { onRetry: (m) => { msg(`${lbl}：${m}`); crumb(m); } }); } finally { clearInterval(tick); }
            cues = cues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset }));
            crumb(`認識結果（${cues.length}行・${Math.round((Date.now() - t0) / 1000)}秒・${cues.how}）：${(cues.raw || '').slice(0, 80) || '（空）'}`); rawAll.push(cues.raw || '');
            speedSamples.push([pe - ps, (Date.now() - t0) / 1000]); speed = speedSamples.reduce((a, x) => a + x[0], 0) / speedSamples.reduce((a, x) => a + x[1], 0);
            if (cancelled) break;
            const b = byId[bid];   // latest revision (its start moves forward)
            const parts = cues.map((c) => ({ s: c.start, e: c.end, text: c.text, est: c.est, boundaryEstimated: c.boundaryEstimated }))
              .map((c, i) => newBlock(set.id, { segments: [{ sourceId: sid, start: +c.s.toFixed(2), end: +c.e.toFixed(2) }], text: c.text, ja: '', sync: c.est ? 'estimated' : 'auto', asr: true,
                ...(c.boundaryEstimated ? {asrBoundaryEstimated:true} : {}),
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
          // When the chunk has been committed, the same block now starts at chunkEnd.
          // If no progress was made, stop instead of retrying indefinitely.
          if (byId[bid] && !byId[bid].deleted && byId[bid].segments[0]?.start <= sg.start + 0.01) break;
          }
        }
      }
    } catch (e) {
      running(null); crumb('失敗：' + (e?.message || e)); lock?.release?.(); tr?.close(); if (dlg.open) dlg.close();
      return confirmDialog({ title: '文字起こしが止まりました', body: `<p class="small">${esc((e?.message || String(e)))}</p><p class="hint">${lines ? `${lines}行は保存済みです。もう一度実行すると続きから始まります。` : '初回はネット接続が必要です（モデルのダウンロード）。'}</p>`, okLabel: '閉じる', cancelLabel: null });
    }
    running(null); lock?.release?.(); tr?.close(); const wasCancelled = cancelled; if (dlg.open) { dlg.onclose = null; dlg.close(); }
    if (!lines) return auto ? { lines: 0, cancelled: wasCancelled } : wasCancelled ? toast('中止しました') : confirmDialog({ title: '文字にできませんでした', body: noSpeech.length ? `<p class="small">${noSpeech.map(esc).join('<br>')}</p><p>音声が見つかりませんでした（無音のまま取り出された可能性）。編集した動画は音声を取り出せないことがあります。写真アプリで「ビデオを複製」または「ファイルに保存」で書き出したものを取り込み直してください。</p>` : `<p>音声認識は動きましたが、文字にできる英語がありませんでした。</p><p class="small">認識された内容：${esc(rawAll.join(' ').trim().slice(0, 200) || '（何も認識されませんでした）')}</p><p class="hint">［Music］のような表示だけなら、音楽や効果音と判定されています。何も認識されない場合は、音声が英語として聞き取れていません。</p>`, okLabel: '閉じる', cancelLabel: null });
    if (auto) return { lines, cancelled: wasCancelled };
    if (!wasCancelled && scriptLines().length) return vocabAfterAsr ? previewVocabAlignment() : runAlign({ afterAsr: lines });
    const ok = await confirmDialog({ title: wasCancelled ? `${lines}行で中止しました` : `文字起こしが終わりました（${lines}行）`,
      body: `<p>結果は、この画面の一覧（動画の下）に「自動起こし」の印つきで並んでいます。行をタップすると、その部分を再生します。✎で直せます。</p>${wasCancelled ? '<p class="hint">もう一度実行すると続きから始まります。</p>' : ''}${emptyPieces ? `<p class="warn-text small">${emptyPieces}か所は文字にできませんでした（一覧に「文字にできなかった部分」として残しています）。「標準」「最高」の精度で、もう一度「文字起こし」を実行すると、その部分だけやり直します。</p>` : ''}<p class="hint">テキストだけ使いたいときは「⋯」→「テキストを書き出す」。単語帳に入れるときは「⋯」→「単語リストを作る」。</p>`,
      okLabel: '英文をコピー', cancelLabel: '閉じる' });
    if (ok) { try { await navigator.clipboard.writeText(blocks.map((b) => b.text).filter(Boolean).join('\n')); toast('コピーしました'); } catch { toast('コピーできませんでした'); } }
  }
  // Read-only alignment diagnostic. Never edits blocks, source media or manual timings.
  function exportAlignmentDiagnostic() {
    const orderedBlocks = set.order.map((id, index) => ({ b: byId[id], index })).filter((x) => x.b && !x.b.deleted);
    const rows = orderedBlocks.map(({ b, index }) => {
      const segs = (b.segments || []).map((g) => ({
        sourceId: g.sourceId, sourceName: srcs[g.sourceId]?.name || null,
        start: g.start, end: g.end,
      }));
      return {
        orderIndex: index, id: b.id, revision: b.rev, text: b.text || '',
        label: b.label || '', asr: !!b.asr, aligned: !!b.aligned,
        sync: b.sync || null, manual: b.sync === 'manual',
        segments: segs, lineage: b.lineage || null,
        normalizedTokens: tokensOf(b.text || ''),
      };
    });
    const overlaps = [];
    const perSource = new Map();
    for (const r of rows) for (const g of r.segments) {
      if (!Number.isFinite(g.start) || !Number.isFinite(g.end) || g.end <= g.start) continue;
      if (!perSource.has(g.sourceId)) perSource.set(g.sourceId, []);
      perSource.get(g.sourceId).push({ r, g });
    }
    for (const [sourceId, entries] of perSource) {
      entries.sort((a, b) => a.g.start - b.g.start || a.g.end - b.g.end);
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length && entries[j].g.start < entries[i].g.end; j++) {
          const a = entries[i], b = entries[j];
          const seconds = Math.min(a.g.end, b.g.end) - Math.max(a.g.start, b.g.start);
          if (seconds > 0.01) overlaps.push({ sourceId, firstId: a.r.id, secondId: b.r.id, seconds: +seconds.toFixed(3), firstKind: a.r.aligned ? 'aligned' : a.r.asr ? 'asr' : 'other', secondKind: b.r.aligned ? 'aligned' : b.r.asr ? 'asr' : 'other' });
        }
      }
    }
    const report = {
      format: 'englabo-alignment-diagnostic-v1', generatedAt: new Date().toISOString(),
      appStudioVersion: STUDIO_VERSION, studioUpdatedJst: STUDIO_UPDATED_JST, setId: set.id, setTitle: set.title,
      counts: { total: rows.length, audioMissing: rows.filter((r) => !r.segments.length).length,
        aligned: rows.filter((r) => r.aligned).length, asr: rows.filter((r) => r.asr).length,
        overlappingPairs: overlaps.length },
      sources: [...perSource].map(([id, entries]) => ({ id, name: srcs[id]?.name || null, timedRows: entries.length })),
      rows, overlaps,
      note: 'Read-only snapshot. Overlap does not necessarily indicate an error; repeated speech and nested ASR cues can be valid. Timestamps are source-local seconds.',
    };
    const file = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(file);
    a.href = url;
    a.download = `englabo-diagnostic-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
    toast(`診断データを出力しました（${rows.length}行・重複候補${overlaps.length}組）。音声ファイルは含みません`, 4500);
  }
  // ---------- script ↔ audio: the transcription (with mistakes) gives the times, the script gives the text ----------
  function scriptLines() { return set.order.map((id) => byId[id]).filter((b) => b && !b.segments.length && b.text.trim() && !isSymbolRow(b)); }
  async function runAlign({ afterAsr = 0, mode = "standard" } = {}) {
    const sl = scriptLines().filter(b => b.sync !== 'manual');
    if (!sl.length) return toast('音声の付いていないスクリプトの行がありません（「⋯」→「スクリプト・音声を追加」でテキストを入れます）', 4500);
    const heard = blocks.filter((b) => b.segments.length === 1 && b.text.trim() && !b.aligned && b.sync !== 'manual');
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
    // 1.17.5: the recording is matched against the WHOLE script, lines already matched included. A recording that overlaps
    // what is already matched (recorded again from a bit earlier) used to find too few matching words and fail completely.
    // Lines that already have their sound are only used as landmarks: they are not changed.
    const isAnchor = (b) => b.aligned && b.text.trim() && b.segments.length;
    for (const [sid, list0] of bySrc) {
      const cues = list0.slice().sort((a, b) => a.segments[0].start - b.segments[0].start).map((b) => ({ id: b.id, start: b.segments[0].start, end: b.segments[0].end, text: b.text }));
      const rem = new Set(remaining.map((b) => b.id));
      const lines = set.order.map((id) => byId[id]).filter((b) => b && (rem.has(b.id) || (isAnchor(b) && !changed.has(b.id))));
      const r = alignScript(lines.map((b) => ({ id: b.id, text: b.text })), cues, { mode });
      for (const id of [...r.times.keys()]) if (!rem.has(id)) r.times.delete(id);   // landmark lines keep their sound
      matched += r.matched; total += r.total;
      for (const [id, t] of r.times) {
        const b = byId[id], n = tokensOf(b.text).length;
        changed.set(id, { ...b, segments: [{ sourceId: sid, start: t.start, end: t.end }], aligned: true, sync: 'auto', align: n ? [{ s: 0, e: n - 1, v0: 0, v1: +(t.end - t.start).toFixed(2) }] : [], lineage: { op: 'align', from: [`${b.id}@${b.rev}`], at: Date.now() } });
      }
      remaining = remaining.filter((b) => !r.times.has(b.id));
    }
    if (!changed.size) {
      crumb(`照合0行：認識語${total}・一致${matched}`);
      return confirmDialog({ title: '照合できませんでした', body: `<p>音声の文字起こしと一致する部分が、スクリプトの中に見つかりませんでした。</p><p class="hint">別の教材の音声か、スクリプトの範囲外の音声かもしれません。文字起こしの精度が低すぎる場合も一致しません。</p>
        <p class="small muted">調べた文字起こし（${heard.length}行・${[...new Set(heard.map((b) => srcs[b.segments[0].sourceId]?.name || '?'))].map(esc).join('、')}）：<br>「${esc(heard.slice(0, 4).map((b) => b.text).join(' / ').slice(0, 160))}…」</p>
        <p class="hint">内容が英文になっていない・同じ短い言葉の繰り返しの場合は、別の音声トラック（マイク側など）を文字にしています。「⋯」→ 音声トラックの選択で切り替えてから、もう一度文字起こししてください。</p>`, okLabel: '閉じる', cancelLabel: null });
    }
    // Remove duplicated display rows only where this operation assigned the same audio.
    // Similar text elsewhere in this file (or another file) can be an intentional repeat.
    const replacements = [...changed.values()].flatMap(b => b.segments);
    for (const row of heard) {
      if (hasReplacementAudio(row.segments[0], replacements)) del.add(row.id);
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
    const mine = blocks.slice(); const copies = live.filter((b) => notCopiedYet(mine, b)).map((b) => { const { id, rev, setId, deleted, ...f } = b; return newBlock(set.id, { ...structuredClone(f), lineage: { op: 'copy', from: [`${b.id}@${b.rev}`], at: Date.now() } }); });
    if (!copies.length) return toast('この教材の内容は、すでにすべて入っています', 3000);
    await run(`「${other.title}」をまとめる`, { blocks: copies, order: [...set.order, ...copies.map((c) => c.id)] });
    if (scriptLines().length && blocks.some((b) => b.segments.length && !b.aligned)) toast('「文字起こし→照合」で位置を合わせられます', 3500);
  }

  // the whole set: start of the first item and end of the last item that has sound
  const edgesOf = () => { const withSeg = set.order.map((id) => byId[id]).filter((b) => b?.segments.length); return withSeg.length ? { first: withSeg[0], last: withSeg[withSeg.length - 1] } : null; };
  async function applyTrim(start, end, label, dropOriginal = false) {
    const e = edgesOf(); if (!e) return toast('音声のある項目がありません');
    const f = structuredClone(e.first), l = e.first.id === e.last.id ? f : structuredClone(e.last);
    const s0 = f.segments[0], s1 = l.segments[l.segments.length - 1];
    if (start != null) { if (start >= s0.end - 0.2) return toast('開始が最初の項目の終わりより後になります'); s0.start = +start.toFixed(2); f.sync = 'manual'; f.align = []; }
    if (end != null) { if (end <= s1.start + 0.2) return toast('終了が最後の項目の始まりより前になります'); s1.end = +end.toFixed(2); l.sync = 'manual'; l.align = []; }
    await run(label, { blocks: f === l ? [f] : [f, l] });
    if (dropOriginal) await maybeDrop();
  }
  // after a cut: optionally remove the cut parts from the saved file
  async function maybeDrop() {
    const e = edgesOf(); if (!e) return;
    const sid = e.first.segments[0].sourceId, src = srcs[sid];
    if (!src?.stored || e.last.segments.at(-1).sourceId !== sid) return;
    const a = e.first.segments[0].start, b = e.last.segments.at(-1).end;
    if (a < 0.05 && (!src.duration || b > src.duration - 0.05)) return;
    const others = (await sdb.all('sets')).filter((x) => x.id !== set.id && x.sourceId === sid).length;
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
    let dropOriginal = false;
    let st = e.first.segments[0].start, en = e.last.segments.at(-1).end; const st0 = st, en0 = en;   // reset = the position when the dialog opened
    const dlg = $('#dialog'); await new Promise((q) => setTimeout(q, 60)); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    const draw = () => {
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>前後をカット</h3><p class="small">教材の始まりと終わりを決めます。元のファイルは変えません（↶で戻せます）。</p>
        <button type="button" class="btn" id="tAuto">自動で見つける（画面収録の音・無音）</button>
        <button type="button" class="btn" id="tRec">画面収録音の秒数で切る（始め ${recCutGet('S')}秒・終わり ${recCutGet('E')}秒）</button>
        <div class="st-segrow st-cutrow"><div class="row"><b class="grow">開始 <span id="sLbl">${fmt2(st)}</span></b><button type="button" class="btn sm ghost" id="sReset">リセット</button></div>
          <div class="st-cutgrid"><button type="button" class="btn sm" data-d="s:-0.5">−0.5</button><button type="button" class="btn sm" data-d="s:-0.1">−0.1</button><button type="button" class="btn sm" data-d="s:-0.01">−0.01</button><button type="button" class="btn sm" data-d="s:0.01">＋0.01</button><button type="button" class="btn sm" data-d="s:0.1">＋0.1</button><button type="button" class="btn sm" data-d="s:0.5">＋0.5</button></div>
          <div class="row"><button type="button" class="btn sm" id="sNow">今の位置</button><button type="button" class="btn sm grow" id="sPlay">▶︎ 開始から3秒聞く</button></div></div>
        <div class="st-segrow st-cutrow"><div class="row"><b class="grow">終了 <span id="eLbl">${fmt2(en)}</span></b><button type="button" class="btn sm ghost" id="eReset">リセット</button></div>
          <div class="st-cutgrid"><button type="button" class="btn sm" data-d="e:-0.5">−0.5</button><button type="button" class="btn sm" data-d="e:-0.1">−0.1</button><button type="button" class="btn sm" data-d="e:-0.01">−0.01</button><button type="button" class="btn sm" data-d="e:0.01">＋0.01</button><button type="button" class="btn sm" data-d="e:0.1">＋0.1</button><button type="button" class="btn sm" data-d="e:0.5">＋0.5</button></div>
          <div class="row"><button type="button" class="btn sm" id="eNow">今の位置</button><button type="button" class="btn sm grow" id="ePlay">▶︎ 終了の3秒前から聞く</button></div></div>
        <label class="chk"><input type="checkbox" id="tDrop" ${dropOriginal ? 'checked' : ''}> カットした部分は保存しない（元に戻せません）</label>
        <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">保存</button></div></form>`;
      $('#tDrop', dlg).onchange = (ev) => { dropOriginal = ev.target.checked; };
      const fileEnd = srcs[e.last.segments.at(-1).sourceId]?.duration || en0;
      $('#tRec', dlg).onclick = () => { st = Math.min(en - 0.3, recCutGet('S')); en = Math.max(st + 0.3, +(fileEnd - recCutGet('E')).toFixed(2)); upd(); };
      $('#sReset', dlg).onclick = () => { st = st0; upd(); }; $('#eReset', dlg).onclick = () => { en = en0; upd(); };
      const upd = () => { $('#sLbl', dlg).textContent = fmt2(st); $('#eLbl', dlg).textContent = fmt2(en); };
      $$('[data-d]', dlg).forEach((b) => (b.onclick = () => { const [k, d] = b.dataset.d.split(':'); const maxEnd = srcs[e.last.segments.at(-1).sourceId]?.duration || Infinity; if (k === 's') st = Math.min(en - 0.3, Math.max(0, +(st + +d).toFixed(2))); else en = Math.min(maxEnd, Math.max(st + 0.3, +(en + +d).toFixed(2))); upd(); }));
      $('#sNow', dlg).onclick = () => { st = +vid.currentTime.toFixed(2); upd(); };
      $('#eNow', dlg).onclick = () => { en = +vid.currentTime.toFixed(2); upd(); };
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
    if (dlg.returnValue === 'ok') await applyTrim(st !== e.first.segments[0].start ? st : null, en !== e.last.segments.at(-1).end ? en : null, '前後をカット', dropOriginal);
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
        await sdb.put('sources', src); forgetSource(id); saved += before - small.file.size;
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
  const restoreEdit = async (operation,label) => {
    const op = await operation(set);
    if (!op || revision !== routeRevision) return;
    await reload();
    if (revision !== routeRevision) return;
    if (playing?.b.id) {
      const previous = playing;
      const current = byId[previous.b.id];
      const old = previous.b.segments[previous.i];
      const i = old && current ? current.segments.findIndex(g => g.sourceId === old.sourceId && g.start === old.start && g.end === old.end) : -1;
      if (i >= 0) playing = {...previous,b:current,i};
      else if (previous.cont) {
        ++playbackRequest;
        pendingSegmentSeek = null;
        const sid = vid.dataset.src, t = vid.currentTime;
        const contains = g => g.sourceId === sid && t >= g.start && t < g.end;
        const b = blocks.find(row => row.segments.some(contains));
        playing = b ? {...previous,b,i:b.segments.findIndex(contains),range:null} : null;
      } else stopRescuePreview();
    }
    curBlock = byId[curBlock?.id] || null;
    lastSubId = undefined;
    lastHighlightedRow = null;
    drawList();
    drawSub();
    toast(`${label}${op.label}`,1500);
  };
  $('#undoB', el).onclick = () => restoreEdit(undo,'元に戻しました：');
  $('#redoB', el).onclick = () => restoreEdit(redo,'やり直しました：');
  $('#selB', el).onclick = () => { selectMode = !selectMode; arrange = false; if (!selectMode) { sel.clear(); onlySel = false; } drawList(); };
  $('#arrB', el).onclick = () => { const an = viewAnchor(); arrange = !arrange; if (arrange) { arrangeBase = (set.undo || []).length; selectMode = false; sel.clear(); onlySel = false; } drawList(); restoreViewAnchor(an, viewSwitchSerial); };
  $('#pp', el).onclick = () => {
    if (!vid.paused) return vid.pause();
    if (playing || playFromSourcePosition) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
      return vid.play().catch(() => {});
    }
    const at = vid.dataset.src && blockAtTime();
    const b = (at?.segments.length ? at : nextPlayableFrom(curBlock)) || blocks.find((x) => x.segments.length);
    if (b) return playBlock(b, false, true, b === at && vid.dataset.src ? vid.currentTime : null);
    if (!vid.dataset.src && set.sourceId) attach(set.sourceId); vid.play().catch(() => {});
  };
  vid.onplay = () => ($('#pp', el).textContent = icon('pause')); vid.onpause = () => ($('#pp', el).textContent = icon('play'));
  // after a seek: follow from the line at the new position (or play freely if there is none)
  const syncAt = (t) => {
    if (!playing) return;
    const sid = vid.dataset.src;
    const matches = blocks.filter((x) => x.segments.some((g) => g.sourceId === sid && t >= g.start && t < g.end));
    // In overlaps prefer a script-aligned row, without removing ASR evidence.
    const b = matches.find((x) => x.aligned) || matches[0];
    if (b) { const i = b.segments.findIndex((g) => g.sourceId === sid && t >= g.start && t < g.end); playing = { b, i, loop: false, cont: true }; curBlock = b; } else playing = null;
  };
  const jump = (d) => { ++playbackRequest; pendingSegmentSeek = null; const t = Math.max(0, Math.min(vid.duration || Infinity, vid.currentTime + d)); vid.currentTime = t; syncAt(t); };
  const sk = $('#seek', el);
  sk.addEventListener('input', () => { ++playbackRequest; pendingSegmentSeek = null; seeking = true; vid.currentTime = +sk.value; $('#tnow', el).textContent = fmt(+sk.value); });
  sk.addEventListener('change', () => { seeking = false; vid.currentTime = +sk.value; syncAt(+sk.value); });
  sk.addEventListener('touchend', () => {
    const request = playbackRequest;
    setTimeout(() => {
      if (request === playbackRequest && seeking) { seeking = false; syncAt(+sk.value); }
    }, 50);
  });
  $('#back3', el).onclick = () => jump(-3);
  $('#fwd3', el).onclick = () => jump(3);
  const reviewRow = params.get('jaEdit');
  if (reviewRow && byId[reviewRow]) setTimeout(() => {
    if (revision !== routeRevision) return;
    history.replaceState(null, '', `#${BASE}set?id=${encodeURIComponent(set.id)}`);
    setView('all'); goNear(reviewRow);
    editStudioJa(byId[reviewRow]);
  }, 0);
  $('#moreB', el).onclick = async () => {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(set.title)}</h3>
      <button class="btn" value="stJa">英日対応データを反映</button>
      ${parentFolder ? '<button class="btn" value="stFolderJa">フォルダの英日データを使う</button>' : ''}
      <button class="btn" value="stJaReview">日本語訳の確認</button>
      <button class="btn" value="stJaSync">Labの訳と比較・反映</button>
      <button class="btn" value="stJaFix">手動修正した訳の書き出し・取り込み</button>
      <button class="btn" value="ver">版（保存・復元）</button>
      ${HOST ? '<button class="btn primary" value="send">英語ラボに送る</button>' : ''}
      <button class="btn" value="exp">教材パックとして書き出す</button>
      <button class="btn" value="autotrim">前後の画面収録音を自動カット</button>
      <button class="btn" value="trim">前後をカット（手動で調整）</button>
      <button class="btn" value="splitAudio">音声を実際に分割（前半・後半）</button>
      <button class="btn" value="asr">文字起こし（端末内・試験的）</button>
      <button class="btn" value="add">スクリプトを直接追加</button>
      <button class="btn" value="addMedia">音声・動画を追加</button>
      <button class="btn" value="align">スクリプトと照合</button>
      <button class="btn" value="kfRange">金フレ型：スクリプトの範囲を特定（全体スクリプトから）</button>
      <button class="btn primary" value="structAssign">金フレ型：無音の構造で割り当て（推奨）</button>
      <button class="btn" value="alignVocab">金フレ型：既存ASRと照合</button>
      <button class="btn" value="alignProse">朗読・会話向け：緩めのスクリプト照合（試験版）</button>
      <button class="btn" value="maBoundary">MA型の音声境界を検査</button>
      <button class="btn" value="refine">音声位置を一括自動調整（試験版）</button>
      <button class="btn" value="realign">構造を使った再照合（プレビュー）</button>
      <button class="btn" value="structImport">発話を先に区切って照合（試験版）</button>
      <button class="btn" value="structSaved">発話区切りの保存結果を見る</button>
      <button class="btn" value="structResume">発話区切りの候補を再表示</button>
      <button class="btn" value="mergeset">別の教材をこの教材にまとめる</button>
      <button class="btn" value="names">固有名詞をまとめて直す</button>
      <button class="btn" value="words">単語リストを作る</button>
      ${blocks.some((b) => b.segments.length) ? '<button class="btn" value="audioWords">音声付き単語帳を作成</button>' : ''}
      <button class="btn" value="txt">テキストを書き出す</button>
      <button class="btn" value="diag">照合・重複の診断データを書き出す（変更なし）</button>
      ${Object.values(srcs).some((x) => x.audio?.count > 1 && x.derived !== 'audio16k') ? '<button class="btn" value="track">使う音声トラックを選ぶ</button>' : ''}
      ${Object.values(srcs).some((x) => x.stored && (x.derived !== 'audio16k' || x.codec === 'aac')) ? '<button class="btn" value="toaudio">容量を減らす（音声だけ・低音質に）</button>' : ''}
      <button class="btn" value="full">スクリプト全文を見る（抜け・重複の確認・範囲で削除）</button>
      <button class="btn" value="bulkGap">単独の未割当行を一括で仮割り当て</button>
      <button class="btn" value="cutNoA">音声のないスクリプト行を削除</button>
      <button class="btn" value="cutNoS">スクリプトのない音声の行を削除</button>
      <button class="btn" value="dupset">この教材を複製</button>
      <button class="btn" value="ren">名前を変える</button>
      <button class="btn danger" value="del">このセットを削除</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      await new Promise((r) => setTimeout(r, 60));   // Safari: let the menu finish closing before the next dialog opens
      const refreshJa = async () => {
        await reload(); if (revision !== routeRevision) return;
        lastSubId = undefined; drawList(); drawSub();
      };
      if (v === 'stJa') pickStudioJa([set.id], refreshJa);
      if (v === 'stJaSync' || v === 'stJaFix') {
        const tools = await import('./ja-tools-ui.js');
        const changed = v === 'stJaSync' ? await tools.openJaSync({ setId: set.id, start: 'studio' }) : await tools.openJaCorrections({ kind: 'studio', setId: set.id });
        if (changed && revision === routeRevision) { const keepAt = (() => { try { return viewAnchor(); } catch { return null; } })(); await refreshJa(); if (keepAt) try { restoreViewAnchor(keepAt, viewSwitchSerial); } catch {} }
      }
      if (v === 'stFolderJa' && parentFolder) {
        const corpus = await getFolderJa(parentFolder.id);
        if (revision !== routeRevision) return;
        if (!corpus?.sections.length) toast('フォルダに英日対応データを登録してください');
        else await applyStudioJa([set.id], corpus.sections, refreshJa);
      }
      if (v === 'stJaReview') showStudioJaReview(set, jaView.summary, row => {
        setView('all'); goNear(row.id); return editStudioJa(byId[row.id]);
      });
      if (v === 'ver') nav(`versions?id=${set.id}`);
      if (v === 'exp') await exportSet(set).catch(error => toast('書き出せませんでした：' + error.message, 6500));
      if (v === 'send') sendToLab(set).catch(error => toast(error.message, 5000));
      if (v === 'full') fullText();
      if (v === 'bulkGap') bulkGapTrial();
      if (v === 'cutNoA') bulkDel(blocks.filter((b) => !b.segments.length && b.text.trim()), '音声のないスクリプト行');
      if (v === 'cutNoS') bulkDel(blocks.filter((b) => b.segments.length && !b.aligned && (b.asr || !b.text.trim())), 'スクリプトのない音声の行（照合できなかった文字起こし・文字にできなかった部分）');
      if (v === 'dupset') dupSet();
      if (v === 'splitAudio') splitAudioRange();
      if (v === 'asr') runAsr();
      if (v === 'words') nav(`words?id=${set.id}`);
      if (v === 'audioWords') { ++playbackRequest; vid.pause(); playing = null; (await import('./vocab-audio-wizard.js')).openVocabAudioWizard({ targets: [{ kind: 'studio', id: set.id, title: set.title }], prepare: vocabNeedsPrepare() ? { run: vocabPrepare, note: `音声が割り当てられていないスクリプト行、または文字のない音声があります。開始すると、先に${blocks.some((b) => !b.text.trim() && b.segments.length === 1) ? '文字起こし（この端末の中・無料。初回のみモデルをダウンロード）と' : ''}確実な照合を自動で行います。` } : null }); }
      if (v === 'names') fixNames();
      if (v === 'add') nav(`import?to=${set.id}&script=1`);
      if (v === 'addMedia') nav(`import?to=${set.id}`);
      if (v === 'align') runAlign();
      if (v === 'kfRange') kfEditorRange();
      if (v === 'structAssign') assignByKinfureStructure();
      if (v === 'alignVocab') previewVocabAlignment();
      if (v === 'alignProse') runAlign({ mode: 'prose' });
      if (v === 'maBoundary') inspectMaBoundaries();
      if (v === 'refine') refineBoundaries();
      if (v === 'realign') previewStructuralRealign();
      if (v === 'structImport') importBySpeechStructure();
      if (v === 'structSaved') showStructureSaved();
      if (v === 'structResume') resumeSpeechFirstCandidates();
      if (v === 'mergeset') mergeSets();
      if (v === 'txt') exportText();
      if (v === 'diag') exportAlignmentDiagnostic();
      if (v === 'toaudio') toAudio();
      if (v === 'track') chooseTrackAgain();
      if (v === 'autotrim') autoTrim();
      if (v === 'trim') trimDialog();
      if (v === 'ren') { const t = await askText('名前を変える', set.title); if (t) { set.title = t; await sdb.put('sets', set); route(); } }
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
  // 1.19.31: a recording used by word cards (単語帳の音声) is kept
  try { const { referencedMedia } = await import('./audio-refs.js'); for (const id of (await referencedMedia()).studio.keys()) usedElsewhere.add(id); } catch {}
  await sdb.tx(['sets', 'blocks', 'blockRevs', 'versions', 'tracks', 'oplog', 'sources', 'meta'], 'readwrite', (t) => {
    t.objectStore('sets').delete(set.id);
    t.objectStore('meta').delete(`speech-first:${set.id}`);
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
  // 1.19.29: does each word / example already have its original sound? (the Lab plays it by the same text)
  const nk = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const lineOf = new Map(); for (const b of blocks) if (b.text && !b.asr) { const k = nk(b.text); if (k && (!lineOf.has(k) || (b.segments.length && !lineOf.get(k).segments.length))) lineOf.set(k, b); }
  const soundOf = (text) => { const b = lineOf.get(nk(text)); return !b ? '？' : !b.segments.length ? '未割当' : (b.sync === 'estimated' || b.unconfirmed) ? '区間未確定' : '元音声あり'; };
  const soundNote = (x) => { const h = soundOf(x.head), e = x.ex && x.ex !== x.head ? soundOf(x.ex) : null, bad = (v) => v !== '元音声あり'; return `<small class="${bad(h) || (e && bad(e)) ? 'warn-text' : 'muted'}">${h === '？' && (!e || e === '？') ? '' : `見出し：${h}${e ? `／例文：${e}` : ''}`}</small>`; };
  const draw = () => {
    let list;
    if (mode === 'phrase') {
      // 1.17: word ↔ example pairs that came with the material (timed text / JSON) first, then the guesses for the rest
      const byId = Object.fromEntries(blocks.map((b, i) => [b.id, { b, i }])), given = new Set();
      const pairs = blocks.map((b, i) => (b.kind === 'example' && b.pair && byId[b.pair] ? { w: byId[b.pair], e: { b, i } } : null)).filter(Boolean);
      list = pairs.map(({ w, e }) => { given.add(w.b.id); given.add(e.b.id); return { key: w.b.text, head: w.b.text, sub: e.b.text, ex: e.b.text, exJa: e.b.ja || '', ja: w.b.ja || '', first: w.i, n: 1 }; });
      const rest = blocks.map((b, i) => (given.has(b.id) ? { text: '', ja: '' } : items[i]));
      const keys = new Set(list.map((x) => x.key.toLowerCase()));
      list.push(...extractPhrases(rest).filter((x) => !keys.has(x.phrase.toLowerCase())).map((x) => ({ key: x.phrase, head: x.phrase, sub: x.ex, ex: x.ex, exJa: x.exJa, first: x.at, n: 1 })));
    }
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
      <div class="card list">${list.map((x) => `<label class="st-wrow"><input type="checkbox" data-w="${esc(x.key)}" ${chosen.has(x.key) ? 'checked' : ''}><span class="grow"><b>${esc(x.head)}</b><br><small class="muted">${esc(x.sub || '')}</small><br>${soundNote(x)}</span></label>`).join('') || `<p class="empty">${blocks.some((b) => b.text) ? (mode === 'phrase' ? '熟語の見出しが見つかりませんでした。「単語」に切り替えてください。' : '該当する語がありません') : '英文がありません。先に文字起こしか字幕の取り込みをしてください。'}</p>`}</div>
      <div class="st-bar"><div class="row">
        <button class="btn sm grow" id="csv">CSVで書き出す</button>
        <button class="btn sm grow" id="cl">Claude用にコピー</button></div>
        <small class="muted">意味をつけるには「Claude用にコピー」→ Claudeのチャットに貼る → 返ってきたCSVを${HOST ? '下に貼り付けて単語帳へ。' : '英語ラボの単語帳「CSVから追加」で読み込み。'}</small></div>
      ${HOST ? `<div class="card stack"><b>訳をつけたCSVを単語帳へ</b>
        <textarea id="wPaste" rows="5" placeholder="ChatGPT・Claudeの返答をそのまま貼り付け（CSV・番号つきの一覧・表・説明文つきでも、書いてある英語と意味を読み取ります）" autocapitalize="off" autocorrect="off"></textarea>
        <label class="field"><span>単語集の名前（元データごとにまとめます）</span><input id="wDeck" value="${esc(set.folder || set.title)}"></label>
        <button class="btn primary" id="wSend">英語ラボの単語帳へ（確認画面へ）</button>
        <small class="muted">同じ単語がすでにあれば、新しく作らずにこの単語集にも入れます。この教材で確定している音声（見出し語・例文）は、追加した単語に自動で付きます。</small></div>` : ''}`;
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
      const csv = '﻿' + ['英語,日本語,例文,例文訳,タグ', ...picked().map((x) => [x.head, x.ja || '', x.ex, x.exJa, tag].map(q).join(','))].join('\n');
      const file = new File([csv], `${set.title.replace(/[\\/:*?"<>|]/g, '_')}-${mode === 'phrase' ? 'phrases' : 'words'}.csv`, { type: 'text/csv' });
      const copyIt = () => navigator.clipboard.writeText(csv.slice(1)).then(() => toast('書き出せなかったので、CSVの中身をコピーしました（メモ等に貼り付けて保存できます）', 4500), () => toast('書き出せませんでした'));
      if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch((e) => { if (e?.name !== 'AbortError') copyIt(); });
      else { try { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); } catch { copyIt(); } }
    };
    $('#wSend', el)?.addEventListener('click', () => {
      const text = $('#wPaste', el).value.replace(/^```\w*\n?|```\s*$/gm, '').trim();
      if (!text) return toast('CSVを貼り付けてください');
      HOST.addWordsCsv?.(text, $('#wDeck', el).value.trim() || set.title, set.title, set.id);
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
  try { const { referencedMedia } = await import('./audio-refs.js'); for (const id of (await referencedMedia()).studio.keys()) (used[id] ||= new Set()).add('単語帳の音声'); } catch {}   // 1.19.31
  const orphans = srcs.filter((x) => !used[x.id]);
  const oplogN = (await sdb.all('oplog')).length, revN = (await sdb.all('blockRevs')).length;
  const names = (await caches.keys().catch(() => [])) || [];
  const model = names.filter((n) => /transformers|onnx|huggingface/i.test(n));
  let mSize = 0; for (const n of model) { try { const c = await caches.open(n); for (const r of await c.keys()) { const res = await c.match(r); mSize += +res.headers.get('content-length') || 0; } } catch {} }
  const sz = (x) => (x.labRef ? 0 : x.blob?.size || 0);   // shared with the learning app: counted there, not here
  const dupes = srcs.filter((x) => x.stored && !x.labRef && x.kind === 'audio' && x.blob);   // candidates (checked when the button is pressed)
  el.innerHTML = `${head('容量の整理', 'sets')}
    <div class="card stack"><b>このスタジオが使っている容量：${fmtSize(est?.usage || 0)}</b>
      <span class="small">・動画・音声：${fmtSize(srcs.reduce((a, x) => a + sz(x), 0))}（${srcs.length}ファイル）<br>・音声認識モデル：${fmtSize(mSize)}<br>・編集の履歴：${oplogN}件の操作・${revN}件の過去の状態</span></div>
    <div class="card stack">
      <div class="row between"><span><b>どの教材にも使われていないファイル</b><br><small class="muted">${orphans.length}件・${fmtSize(orphans.reduce((a, x) => a + sz(x), 0))}</small></span><button class="btn sm" id="cOrph" ${orphans.length ? '' : 'disabled'}>削除</button></div>
      <div class="row between"><span><b>英語ラボとの重複をまとめる</b><br><small class="muted">ラボに送った音声と同じファイルを、スタジオからは外してラボの音声を使います（字幕・編集はそのまま）</small></span><button class="btn sm" id="cDup" ${dupes.length ? '' : 'disabled'}>まとめる</button></div>
      <div class="row between"><span><b>編集の履歴を整理</b><br><small class="muted">↶で戻せる操作と、保存した版に必要な分だけ残します</small></span><button class="btn sm" id="cHist">整理</button></div>
      <div class="row between"><span><b>解析データ・キャッシュ</b><br><small class="muted">途中結果・文字起こしの保存分・候補などを、一覧から選んで一括削除（音声・字幕・手動の修正は消えません）</small></span><button class="btn sm" id="cDerived">一覧を見る</button></div>
      <div class="row between"><span><b>音声認識モデル</b><br><small class="muted">次に文字起こしするとき再ダウンロード</small></span><button class="btn sm" id="cModel" ${model.length ? '' : 'disabled'}>${fmtSize(mSize)} 削除</button></div>
    </div>
    <h2 class="sec">ファイル（大きい順）</h2>
    <div class="card list">${srcs.sort((a, b) => sz(b) - sz(a)).map((x) => `<div class="st-setrow"><span class="grow"><b>${esc(x.name)}</b><small class="muted">${srcState(x)}・${used[x.id] ? `使用：${esc([...used[x.id]].join('、'))}` : '未使用'}</small></span>
      ${x.stored && !x.labRef && x.blob ? `<button class="btn sm" data-comp="${x.id}">圧縮</button>` : ''}</div>`).join('') || '<p class="empty">ファイルはありません</p>'}</div>
    <p class="hint">「圧縮」は試聴してから置き換えます（動画は音声だけになります。字幕・編集・時刻はそのまま）。ラボと共有している音声は、英語ラボの動画ラボ（一覧で長押し）から圧縮すると両方に効きます。教材ごとの削除は一覧の「選んで削除」から。</p>`;
  $('#cDup', el).onclick = async () => {
    let n = 0, freed = 0; toast('調べています…', 3000);
    for (const x of dupes) { const size = x.blob.size; try { if (await linkToLab(x)) { n++; freed += size; } } catch {} }
    toast(n ? `${n}件をまとめました（スタジオ側 ${fmtSize(freed)} を解放）` : '英語ラボと同じファイルはありませんでした', 3500); cleanScreen(el);
  };
  $$('[data-comp]', el).forEach((b) => (b.onclick = async () => {
    const x = await sdb.get('sources', b.dataset.comp); if (!x?.blob) return;
    const { compressDialog, TIERS: TT } = await import('./compress.js');
    const r = await compressDialog({ blob: x.blob, name: x.name, duration: x.duration || 0, trackIndex: x.audio?.index ?? null, lossy: !/wav/.test(x.mime || ''), note: x.kind !== 'audio' ? '動画は音声だけになります。' : '' });
    if (!r) return;
    const before = x.blob.size;
    Object.assign(x, { blob: r.file, kind: 'audio', mime: 'audio/mp4', derived: 'aac', codec: 'm4a', tier: r.tier, origSize: x.origSize || before, size: r.file.size });
    delete x.audio; probeCache.delete(x.id); URL.revokeObjectURL(urlCache.get(x.id) || ''); urlCache.delete(x.id);
    await sdb.put('sources', x);
    toast(`圧縮しました：${fmtSize(before)} → ${fmtSize(r.file.size)}（${TT[r.tier].label}）`, 3000); cleanScreen(el);
  }));
  $('#cOrph', el).onclick = async () => { if (!(await confirmDialog({ title: '使われていないファイルを削除', body: `<p>${orphans.map((x) => esc(x.name)).join('<br>')}</p>`, okLabel: '削除' }))) return; for (const x of orphans) await sdb.del('sources', x.id); toast('削除しました'); cleanScreen(el); };
  $('#cDerived', el).onclick = async () => { const m = await import('./derived-cache.js'); await m.openDerivedCacheDialog({ onDone: () => cleanScreen(el) }); };
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
      Object.assign(x, { blob: small.file, kind: 'audio', mime: small.file.type, derived: 'audio16k', codec: small.codec, origSize: x.size, size: small.file.size }); delete x.audio; forgetSource(x.id);
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
  $('#save', el).onclick = async () => { const label = (await askText('版の名前（任意）', '')) ?? ''; await saveVersion(set, label); toast('保存しました'); versionsScreen(el, params); };
  $$('[data-v]', el).forEach((b) => (b.onclick = async () => {
    const v = vers.find((x) => x.id === b.dataset.v);
    if (!(await confirmDialog({ title: `版${v.number}に戻す`, body: '<p>編集画面の ↶ で取り消せます。</p>', okLabel: '戻す' }))) return;
    await restoreVersion(set, v); toast(`版${v.number}に戻しました`); nav(`set?id=${set.id}`);
  }));
}

const jaGuard = set => ({ folder: set.folder, updatedAt: set.updatedAt, order: [...set.order], undo: [...(set.undo || [])], redo: [...(set.redo || [])] });
const jaCounts = ({ total, applied, review, missing }) =>
  `反映済み ${applied} / ${total}行・要確認 ${review.length}行・未割当 ${missing.length}行・反映率 ${total ? Math.round(applied / total * 100) : 0}%`;

function studioDialog(title, body, buttons) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack st-action-dialog"><h3>${esc(title)}</h3>${body}<div class="st-dialog-actions">
    ${buttons.map(([value, label]) => `<button class="btn sm" value="${value}">${esc(label)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue);
    dlg.showModal();
  });
}

async function showStudioJaReview(set, summary, edit) {
  const todo = [...summary.review.map(row => [row, '要確認']), ...summary.missing.map(row => [row, '未割当'])];
  const result = await studioDialog(set.title + 'の日本語訳', `<p>${jaCounts(summary)}</p>
    <div class="stack" style="max-height:55dvh;overflow:auto">${todo.map(([row, status], i) =>
      `<button class="btn sm" value="row${i}">${status}　${esc(row.text.slice(0, 140))}</button>`).join('')}</div>`, [['close','閉じる']]);
  const row = /^row(\d+)$/.exec(result);
  if (row && todo[Number(row[1])]) {
    const block = todo[Number(row[1])][0];
    if (edit) edit(block);
    else nav(`set?id=${encodeURIComponent(set.id)}&jaEdit=${encodeURIComponent(block.id)}`);
  }
}

async function chooseStudioJaFiles() {
  const picker = studioDialog('英日対応データを選ぶ',
    `<label class="btn primary" for="stJaFiles">JSONまたはZIPを選ぶ（複数可）</label><input type="file" id="stJaFiles" accept=".json,.zip,application/json,application/zip" multiple hidden>
    <details><summary class="small">JSONを貼り付ける（1つのJSONに複数章も可）</summary><textarea id="stJaText" rows="6" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    <button class="btn sm" value="text">貼り付けたJSONを使う</button></details>`,
    [['cancel','閉じる']]);
  const dlg = $('#dialog'), input = $('#stJaFiles', dlg);
  let files = [], text = '';
  input.onchange = () => {
    files = [...input.files];
    if (files.length) dlg.close('files');
  };
  const result = await picker;
  if (result === 'text') text = $('#stJaText', dlg)?.value || '';
  return result === 'files' ? files : result === 'text' ? { text } : [];
}

async function pickStudioJa(ids, onSaved) {
  const start = routeRevision;
  const picked = await chooseStudioJaFiles();
  if ((Array.isArray(picked) ? !picked.length : !picked.text?.trim()) || start !== routeRevision) return;
  await new Promise(resolve => setTimeout(resolve, 60));
  try { await applyStudioJa(ids, Array.isArray(picked) ? await readStudioJaFiles(picked) : await readStudioJaText(picked.text), onSaved, { offerLab: true }); }
  catch (error) { toast(error.message, 5500); }
}

function studioBatchProgress(title) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(title)}</h3><p id="stBatchProgress" aria-live="polite"></p><button class="btn sm">現在の教材が終わったら中断</button></form>`;
  const status = $('#stBatchProgress', dialog);
  dialog.onclose = null;
  dialog.showModal();
  return {
    get stopped() { return !dialog.open || !dialog.contains(status); },
    show(index, total, title) { status.textContent = `${index + 1} / ${total}　${title}`; },
    async close() {
      if (dialog.open && dialog.contains(status)) dialog.close();
      await new Promise(resolve => setTimeout(resolve, 30));
    },
  };
}

// 1.19.31: how the English–Japanese data is applied (one choice for one material, chosen materials or a whole folder)
async function chooseJaMode(initial = 'rematch') {
  const modes = [
    ['missing', '未割当の行だけ', '訳のない行だけに入れます。既存の訳はそのまま。'],
    ['rematch', '再照合（照合結果を更新）', '以前この方法で照合した訳を新しいデータで更新します。教材に元からあった訳と手で直した訳はそのまま。'],
    ['overwrite', '上書き（英日対応済みの訳も置き換え）', '新しいデータに一致した行は、教材に元からあった訳や以前の照合結果も置き換えます。一致しない行はそのまま。'],
  ];
  const choice = await studioDialog('英日データの反映のしかた', `<div class="stack small">${modes.map(([v, t, d]) =>
    `<label class="chk"><input type="radio" name="stJaMode" value="${v}" ${v === initial ? 'checked' : ''}> <span><b>${t}</b><br><span class="muted">${d}</span></span></label>`).join('')}
    <label class="chk"><input type="checkbox" id="stJaHand"> 手で直した訳（和訳の確定・位置調整）も上書きする</label>
    <span class="muted">どの方法でも、反映後に ↶ または「今回の反映を戻す」で元に戻せます。</span></div>`, [['next','候補を確認'],['cancel','閉じる']]);
  if (choice !== 'next') return null;
  const dlg = $('#dialog'), mode = dlg.querySelector('[name=stJaMode]:checked')?.value || initial, all = dlg.querySelector('#stJaHand')?.checked;
  await new Promise(resolve => setTimeout(resolve, 60));
  return { missingOnly: mode === 'missing', overwrite: all ? 'all' : mode === 'overwrite' ? 'imported' : false, mode, all };
}
async function applyStudioJa(ids, sections, onSaved, { missingOnly = false, offerLab = false, how = null } = {}) {
  how ||= await chooseJaMode(missingOnly ? 'missing' : 'rematch');
  if (!how) return;
  ({ missingOnly } = how);
  const overwrite = how.overwrite;
  const start = routeRevision, plans = [];
  const planning = studioBatchProgress('日本語訳の候補を照合中');
  let scanned = 0;
  try {
    for (const id of ids) {
      if (start !== routeRevision || planning.stopped) break;
      const set = await sdb.get('sets', id);
      scanned++;
      if (!set) continue;
      planning.show(scanned - 1, ids.length, set.title);
      const blocks = await liveBlocks(set), plan = planStudioJa(set, blocks, sections, { missingOnly, overwrite });
      const updated = new Map(plan.changes.map(row => [row.id,row]));
      const view = studioJaView(blocks.map(row => updated.get(row.id) || row));
      const sample = plan.changes.filter(row => view.value(row)).slice(0, 3)
        .map(row => `<p>${esc(row.text.slice(0, 180))}<br>${esc(view.value(row).slice(0, 180))}</p>`).join('');
      plans.push({ id, title: set.title, guard: jaGuard(set), summary: jaCounts(plan.summary), count: plan.changes.length, sample });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { await planning.close(); }
  if (start !== routeRevision) return;
  const preview = `${scanned < ids.length ? `<p>未照合 ${ids.length-scanned}教材</p>` : ''}` +
    plans.map(plan => `<details><summary>${esc(plan.title)}　${plan.summary}</summary>${plan.sample}</details>`).join('');
  const choices = [['cancel','閉じる']];
  if (plans.some(plan => plan.count) || scanned < ids.length) choices.push(['save', scanned < ids.length ? '照合済みの候補を反映' : '日本語訳を反映']);
  if (offerLab && HOST?.sendToLab && plans.length && scanned === ids.length) choices.push(['send','反映して一括教材化へ']);
  const modeText = how.mode === 'missing' ? '未割当の行だけ' : how.mode === 'overwrite' ? '上書き（英日対応済みの訳も置き換え）' : '再照合';
  const action = await studioDialog('日本語訳の反映を確認', `<p class="small">方法：<b>${modeText}</b>・手で直した訳は${how.all ? '<b>上書きします</b>' : '保持します'}</p>` + preview, choices);
  if (!['save','send'].includes(action) || start !== routeRevision) return;
  const applied = [], errors = new Map();
  const saving = studioBatchProgress('日本語訳を反映中');
  let saved = 0;
  try {
    for (const plan of plans) {
      if (start !== routeRevision || saving.stopped) break;
      saving.show(saved++, plans.length, plan.title);
      if (!plan.count) continue;
      try {
        const set = await sdb.get('sets', plan.id);
        if (!set || JSON.stringify(jaGuard(set)) !== JSON.stringify(plan.guard)) throw Error('教材が変更されました');
        const current = planStudioJa(set, await liveBlocks(set), sections, { missingOnly, overwrite });
        if (!current.changes.length) continue;
        const op = await commit(set, '日本語訳を反映', { blocks: current.changes, guardedSet: plan.guard });
        applied.push({ id: set.id, opId: op.opId });
      } catch (error) { errors.set(plan.id, `${plan.title}：${error.message}`); }
    }
  } finally { await saving.close(); }
  if (onSaved && start === routeRevision) await onSaved();
  if (start !== routeRevision) return;
  const rest = [...plans.slice(saved).map(plan => plan.id), ...ids.slice(scanned)];
  const buttons = [['close','閉じる']];
  if (rest.length) buttons.push(['resume','未実行の教材を続ける']);
  if (applied.length) buttons.push(['undo','今回の反映を戻す']);
  if (offerLab && HOST?.sendToLab) buttons.push(['send','一括教材化へ']);
  const done = plans.slice(0, saved);
  const report = done.map((plan, i) => `<button class="btn sm" value="review${i}">${esc(plan.title)}<br>${errors.has(plan.id) ? esc(errors.get(plan.id)) : plan.summary}</button>`).join('');
  const next = action === 'send' && !errors.size && !rest.length ? 'send' : await studioDialog('日本語訳の反映結果',
    `<p>更新 ${applied.length}教材${rest.length ? `・未実行 ${rest.length}教材` : ''}</p><div class="stack" style="max-height:52dvh;overflow:auto">${report}</div>`, buttons);
  if (next === 'undo') {
    let skipped = 0;
    for (const entry of applied) {
      const set = await sdb.get('sets', entry.id);
      if (set?.undo?.at(-1) === entry.opId) await undo(set);
      else skipped++;
    }
    await onSaved?.();
    toast(skipped ? `${skipped}教材には後から編集が入っています` : '日本語訳の反映を戻しました');
  } else if (next === 'resume') await applyStudioJa(rest, sections, onSaved, { missingOnly, offerLab, how });
  else if (next === 'send') await batchSendToLab(done.filter(plan => !errors.has(plan.id)).map(plan => plan.id));
  else if (/^review\d+$/.test(next)) {
    const set = await sdb.get('sets', done[Number(next.slice(6))].id);
    if (set) await showStudioJaReview(set, studioJaView(await liveBlocks(set)).summary);
  }
}

// ================= export / import (material pack) =================
// inside English Labo: put the material straight into the video lab (no file in between)
// the same item copied twice into one set (merging again, or the same audio twice): skipped
const itemKey = (b) => (b.segments || []).map((g) => `${g.sourceId}:${(+g.start).toFixed(1)}-${(+g.end).toFixed(1)}`).join('|') + '#' + (b.text || '').trim().toLowerCase();
function notCopiedYet(parentBlocks, b) {
  const keys = new Set(parentBlocks.map(itemKey)), from = new Set(parentBlocks.flatMap((x) => (x.lineage?.from || []).map((f) => String(f).split('@')[0])));
  return !keys.has(itemKey(b)) && !from.has(b.id) && !parentBlocks.some((x) => x.id === b.id);
}
// 1.19.42: what the Lab cannot work out by itself — is this line an aligned script line (音声が確定) or raw recognition (文字起こしのまま)?
// Carried with every line of a transfer / pack, so audio-bearing word cards can be built from the Lab alone.
const transferFlags = (b) => (studioConfirmed(b) ? { confirmed: true } : b.asr && !b.aligned ? { asr: true } : {});
function materialMetadata(blocks, materialType) {
  const map = new Map();
  let studySet = '';
  for (const block of blocks) {
    if (!block.text) continue;
    if (materialType === 'prose') {
      const confirmed = !block.unconfirmed && block.sync !== 'estimated' &&
        (block.sync === 'manual' || (block.aligned && block.segments?.length === 1));
      if (confirmed) map.set(block.id, { maAligned: true, wordTimings: block.wordTimings });
      continue;
    }
    if (block.asr) continue;
    const word = isVocabHead(block);
    if (word) studySet = block.id;
    if (studySet && materialType === 'vocab') map.set(block.id, { studySet, role: word ? 'word' : 'example' });
  }
  return map;
}
// 1.19.28: what a material carries. 'both' = sound + English + Japanese (each line keeps its own pair, so the Lab can
// show English / Japanese / both); 'script' = sound + English only; 'audio' = sound with the sentence ranges, no text.
const CONTENTS = { both: '音声＋英日字幕（英語・日本語訳）', script: '音声＋スクリプト（英語のみ）', audio: '音声のみ（文の区切りだけ）' };
const contentsPref = () => { try { const v = localStorage.getItem('st-contents'); return CONTENTS[v] ? v : 'both'; } catch { return 'both'; } };
const contentsHTML = (v = contentsPref()) => `<div class="stack small"><b>含める内容</b>${Object.entries(CONTENTS).map(([k, t]) => `<label class="chk"><input type="radio" name="stContents" value="${k}" ${k === v ? 'checked' : ''}> ${t}</label>`).join('')}</div>`;
const readContents = () => { const v = document.querySelector('#dialog input[name=stContents]:checked')?.value || contentsPref(); try { localStorage.setItem('st-contents', v); } catch {} return v; };
export async function buildMaterial(set, { contents = 'both' } = {}) {
  const blocks = await liveBlocks(set);
  const media = [];
  for (const id of new Set(blocks.filter(b => b.text || b.ja || (contents === 'audio' && b.segments.length)).flatMap(b => b.segments.map(s => s.sourceId)))) {
    const source = await sdb.get('sources', id);
    if (!source) throw Error('参照先の音声ファイル情報がありません');
    media.push(source);
  }
  const manifest = { format: 'elpack', formatVersion: 2, packId: newId('pk_'), materialId: set.id, title: set.title, lang: 'en', source: { app: 'Englabo Studio', appVersion: STUDIO_VERSION }, createdAt: new Date().toISOString() };
  const metadata = materialMetadata(blocks, set.materialType);
  const setFolder = set.folder && (await studioFolders([set])).find(folder => folder.name === set.folder);
  const folderOrder = setFolder ? folderMembers(await sdb.all('sets'), setFolder).findIndex(member => member.id === set.id) : -1;
  const material = { jaSpans: contents === 'both' ? studioJaView(blocks).spans : [], set: { id: set.id, title: set.title, folder: set.folder,
    folderOrder: folderOrder >= 0 ? folderOrder : undefined, materialType: set.materialType, ...(set.splitRange ? { splitRange: structuredClone(set.splitRange) } : {}),
    contents, ...(setFolder ? { packId: setFolder.id, packName: setFolder.name } : {}) },
    items: blocks.map((b) => ({ id: b.id, rev: b.rev, segments: b.segments.map((s) => ({ media: s.sourceId, start: s.start, end: s.end })),
      text: contents === 'audio' ? '' : b.text, ja: contents === 'both' ? b.ja : '', jaRemoved: contents === 'both' ? b.jaOverride && !b.ja : false,
      holes: contents === 'audio' ? undefined : b.holes, label: b.label, sync: b.sync, ...transferFlags(b), ...metadata.get(b.id) }))
      .filter((it) => contents !== 'audio' || it.segments.length),   // 音声のみ: lines without sound carry nothing
    media: media.map((m) => ({ ...packMedia(m, studioSourceFile(m)), existingMediaKey: m.labRef?.videoId })) };
  manifest.contents = { audio: true, text: contents !== 'audio', translation: contents === 'both', timestamps: true, kind: contents };
  return { manifest, material, media, blocks };
}
async function sendToLab(set, { batch = false, update = true, contents = 'both' } = {}) {
  if (!HOST?.sendToLab) return null;
  const { manifest, material, media, blocks } = await buildMaterial(set, { contents });
  const n = blocks.filter(b => b.segments.length && (b.text || b.ja || contents === 'audio')).length;
  if (!n) throw Object.assign(Error('音声区間が付いた字幕がありません'), { skip: true });
  const wait = blocks.filter(b => !b.segments.length && b.text).length;
  if (!batch && !(await confirmDialog({ title: '英語ラボに送る', body: `<p>音声の付いた ${n}行を入れます。

    ${wait ? `音声が未割当の ${wait}行は今回の再生教材に含まれません。` : ''}</p>
    <p class="hint">登録済みの教材は同じ教材を更新します。Video Labでの手動変更は保持します。</p>`, okLabel: '送る' }))) return null;
  const sources = new Map(media.map(source => [source.id, source]));
  const result = await HOST.sendToLab(manifest, material, m => {
    return studioSourceFile(sources.get(m.id));
  }, { update });
  if (result?.skipped) return result;
  for (const source of media) {
    try { await linkToLab(await sdb.get('sources', source.id)); } catch {}
  }
  if (!batch && result?.id) location.hash = `#video-play?id=${encodeURIComponent(result.id)}`;
  return result;
}

async function batchSendToLab(ids, retry = false, existingUpdate = false, contents = null) {
  if (!HOST?.sendToLab || !ids.length) return;
  const revision = routeRevision;
  const update = retry ? existingUpdate : (await studioDialog('一括教材化',
    `<p>${ids.length}件を独立した教材としてVideo Labに登録します。</p>
      <p>「新規のみ」は、まだ登録していない教材だけを追加します。「既存も更新」は登録済みの教材も上書きします。</p>${contentsHTML()}`,
    [['cancel','閉じる'],['new','新規のみ教材化'],['update','既存も更新']]));
  if (!retry) contents = readContents();
  contents ||= contentsPref();
  if (update === 'cancel' || update === '') return;
  const updateExisting = update === true || update === 'update';
  const registered = updateExisting ? null : await HOST.studioLabState?.();
  if (revision !== routeRevision) return;
  const dlg = $('#dialog');
  dlg.innerHTML = '<form method="dialog" class="dlg stack"><h3>一括教材化</h3><p aria-live="polite" id="stLabProgress"></p><button class="btn sm">現在の教材が終わったら中断</button></form>';
  const progress = $('#stLabProgress', dlg);
  let cancelled = false;
  dlg.onclose = () => { cancelled = true; };
  dlg.showModal();
  const report = [], failed = [];
  for (const [i,id] of ids.entries()) {
    if (cancelled || !dlg.open || revision !== routeRevision) break;
    let set;
    try {
      set = await sdb.get('sets', id);
      if (!set) { report.push(['スキップ',id,'教材が見つかりません']); continue; }
      progress.textContent = `${i+1} / ${ids.length}　${set.title}`;
      if (registered?.has(id)) { report.push(['スキップ',set.title,'登録済み']); continue; }
      const result = await sendToLab(set, { batch: true, update: updateExisting, contents });
      if (!result?.id) report.push(['スキップ',set.title,result?.reason || '登録できません']);
      else report.push(['成功',set.title,'']);
    } catch (error) {
      report.push([error.skip ? 'スキップ' : '失敗',set?.title || id,error.message]);
      if (!error.skip) failed.push(id);
    }
  }
  if (dlg.contains(progress) && dlg.open) { dlg.onclose = null; dlg.close(); }
  if (revision !== routeRevision) return;
  await new Promise(resolve => setTimeout(resolve, 30));
  const groups = ['成功','失敗','スキップ'];
  const summary = groups.map(status => `${status} ${report.filter(row => row[0] === status).length}件`).join('・');
  const action = await studioDialog('一括教材化の結果', `<p>${summary}${report.length < ids.length ? `・未実行 ${ids.length-report.length}件` : ''}</p>
    <div style="max-height:52dvh;overflow:auto">${report.map(row => `<p>${esc(row.filter(Boolean).join('　'))}</p>`).join('')}</div>`,
    [['close','閉じる'], ...(failed.length ? [['retry','失敗した教材だけ再実行']] : []),
      ...(report.length < ids.length ? [['resume','未実行の教材を続ける']] : [])]);
  if (action === 'retry') return batchSendToLab(failed, true, updateExisting);
  if (action === 'resume') return batchSendToLab(ids.slice(report.length), true, updateExisting);
}

async function exportFolderPack(folder, members, contents = 'both') {
  const revision = routeRevision;
  const ready = [], errors = [];
  const progress = studioBatchProgress('一括教材パックの準備中');
  try {
    for (const [i, member] of members.entries()) {
      if (progress.stopped || revision !== routeRevision) return;
      progress.show(i, members.length, member.title);
      try {
        const set = await sdb.get('sets', member.id);
        if (!set || set.folder !== folder.name) throw Error('フォルダ内に見つかりません');
        const { manifest, material, media, blocks } = await buildMaterial(set, { contents });
        if (!blocks.some(block => block.segments.length && (block.text?.trim() || block.ja?.trim() || contents === 'audio'))) {
          throw Error('再生位置の付いた字幕がありません');
        }
        const missing = media.filter(source => !studioSourceFile(source)?.size);
        if (missing.length) throw Error(`音声を選び直してください（${missing.map(source => source.name).join('、')}）`);
        const files = new Map(media.map(source => [source.id, studioSourceFile(source)]));
        manifest.contents = { ...manifest.contents, audioMode:'all' };
        ready.push({ title:set.title, entries:materialPackEntries(manifest, material, files) });
      } catch (error) { errors.push(`${member.title}：${error.message}`); }
    }
    if (progress.stopped) return;
  } finally { await progress.close(); }
  if (revision !== routeRevision) return;
  if (errors.length) {
    const proceed = await studioDialog('書き出せない教材があります', `<p>書き出し可能 ${ready.length} / ${members.length}件</p>
      <div style="max-height:50dvh;overflow:auto">${errors.map(line => `<p>${esc(line)}</p>`).join('')}</div>`,
      [...(ready.length ? [['save','準備できた教材を書き出す']] : []),['close','閉じる']]);
    if (proceed !== 'save' || revision !== routeRevision) return;
  }
  let percent = -1;
  const zip = await writeMaterialCollection(folder.name, ready, fraction => {
    const step = Math.min(10, Math.floor(fraction * 10));
    if (step === percent || revision !== routeRevision) return;
    percent = step;
    toast(`一括教材パックを作成中… ${step * 10}%`, 8000);
  });
  if (revision !== routeRevision) return;
  const name = `${folder.name.replace(/[\\/:*?"<>|]/g, '_')}-一括教材.elpack.zip`;
  await savePackZip(zip, name, folder.name, `教材 ${ready.length}件・音声付き`,
    '<p class="small">保存したZIPを、Video Labの「パックを読み込む」で選んでください。</p>');
}

async function exportSet(set) {
  const revision = routeRevision;
  let blocks = await liveBlocks(set);
  const sourceIds = [...new Set(blocks.flatMap(block => block.segments.map(segment => segment.sourceId)))];
  const media = [];
  for (const id of sourceIds) media.push(await sdb.get('sources', id) || { id, name:id });
  const available = new Map(media.map(source => [source.id, studioSourceFile(source)]).filter(([, blob]) => blob?.size > 0));
  const missing = media.filter(source => !available.has(source.id));
  const totalSize = sources => fmtSize(sources.reduce((sum, source) => sum + (available.get(source.id)?.size || 0), 0));
  const sent = new Set((set.exported?.media || []).filter(previous =>
    media.some(source => source.id === previous.id && (available.get(source.id)?.size ?? source.size) === previous.size)).map(source => source.id));
  const newOnes = media.filter(source => !sent.has(source.id));
  const nLines = blocks.filter(block => block.segments.length && (block.text?.trim() || block.ja?.trim())).length;
  const nWait = blocks.filter(block => !block.segments.length && block.text).length;
  const canInclude = nLines > 0 && media.length > 0 && !missing.length;
  if (revision !== routeRevision) return;
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>教材パックを書き出す</h3>
    <p class="small">再生できる字幕 ${nLines}行・音声／動画 ${media.length}件</p>
    ${missing.length ? `<p class="small warn-text">音声を選び直してください。<br>${missing.map(source => esc(source.name)).join('、')}</p>` : ''}
    ${!nLines ? '<p class="small warn-text">再生位置の付いた字幕が必要です。スタジオで音声を割り当ててから音声付きパックを作成できます。</p>' : ''}
    <div class="stack">
      <label class="chk"><input type="radio" name="em" value="all" ${canInclude ? 'checked' : 'disabled'}> 音声もすべて含める（${totalSize(media)}）</label>
      ${sent.size && nLines ? `<label class="chk"><input type="radio" name="em" value="new" ${newOnes.some(source => !available.has(source.id)) ? 'disabled' : ''}> 登録済み教材の字幕更新（${newOnes.length ? '新しい音声 ' + newOnes.length + '件' : '字幕のみ'}）</label>` : ''}
      <label class="chk"><input type="radio" name="em" value="none"> 字幕だけ書き出す</label>
    </div>
    ${nWait ? `<label class="chk"><input type="checkbox" id="onlyA"> 再生位置の付いた行だけ含める（${nWait}行は音声未割当）</label>` : ''}
    <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">書き出す</button></div></form>`;
  dlg.returnValue = ''; dlg.showModal(); await new Promise(resolve => { dlg.onclose = resolve; });
  if (dlg.returnValue !== 'ok' || revision !== routeRevision) return;
  const em = dlg.querySelector('input[name=em]:checked')?.value;
  if (!em) throw Error('書き出し方法を選んでください');
  if (dlg.querySelector('#onlyA')?.checked) blocks = blocks.filter(block => block.segments.length);
  const files = new Map((em === 'all' ? media : em === 'new' ? newOnes : []).map(source => [source.id, available.get(source.id)]));
  const manifest = { format: 'elpack', formatVersion: 2, packId: newId('pk_'), materialId: set.id,
    materialVersion: (await sdb.byIndex('versions', 'setId', set.id)).length, title: set.title, lang: 'en',
    source: { app: 'Englabo Studio', appVersion: STUDIO_VERSION }, scope: 'collection', createdAt: new Date().toISOString(),
    contents: { audio: files.size > 0, audioMode: em, text: true, translation: true, timestamps: true, vocab: false } };
  const metadata = materialMetadata(blocks, set.materialType);
  const material = { jaSpans: studioJaView(blocks).spans, set: { id: set.id, title: set.title, folder: set.folder, display: set.display, materialType: set.materialType, splitRange: set.splitRange }, units: [{ id: set.id, title: set.title, items: blocks.map((b) => b.id) }],
    items: blocks.map((b) => ({ id: b.id, rev: b.rev, segments: b.segments.map((s) => ({ media: s.sourceId, start: s.start, end: s.end })), text: b.text, ja: b.ja, jaRemoved: b.jaOverride && !b.ja, jaImport: b.jaImport, jaOverride: b.jaOverride, jaReview: b.jaReview, holes: b.holes, align: b.align, cueRefs: b.cueRefs, lineage: b.lineage, sync: b.sync, jaStatus: b.jaStatus, label: b.label, asr: b.asr, ...transferFlags(b), ...metadata.get(b.id) })),
    media: media.map(source => packMedia(source, files.get(source.id))) };
  toast('教材パックを作成中…', 10000);
  const zip = await writeMaterialPack(manifest, material, files);
  if (revision !== routeRevision) return;
  const label = em === 'all' ? '音声付き' : em === 'new' ? '字幕更新' : '字幕のみ';
  const name = `${set.title.replace(/[\\/:*?"<>|]/g, '_')}-${label}.elpack.zip`;
  const remember = async () => {
    if (!files.size) return;
    const cur = await sdb.get('sets', set.id);
    if (!cur) return;
    const keep = (cur.exported?.media || []).filter(entry => !files.has(entry.id));
    cur.exported = { at: Date.now(), media: [...keep, ...Array.from(files, ([id, media]) => ({ id, size:media.size }))] };
    await sdb.put('sets', cur);
    set.exported = cur.exported;
  };
  await savePackZip(zip, name, set.title, `音声／動画 ${files.size}件`, '', remember);
}

async function savePackZip(zip, name, title, summary, help, remember = async () => {}) {
  const dlg = $('#dialog');
  const file = new File([zip], name, { type: 'application/zip' });
  const url = URL.createObjectURL(file);
  try {
    const share = navigator.canShare?.({ files: [file] });
    const result = studioDialog('教材パックを保存', `<p>${esc(name)}</p><p class="small">${esc(summary)}・${fmtSize(file.size)}</p>${help}
      <div class="row wrap">
        ${share ? '<button type="button" class="btn primary" id="shareElPack">共有・ファイルに保存</button>' : ''}
        <a class="btn" href="${esc(url)}" download="${esc(name)}" id="downloadElPack">ZIPをダウンロード</a>
      </div><p class="small" role="status" id="saveElPackStatus"></p>`, [['close','閉じる']]);
    const status = $('#saveElPackStatus', dlg);
    const record = () => remember().catch(() => {});
    $('#downloadElPack', dlg).onclick = () => { record(); };
    const shareButton = $('#shareElPack', dlg);
    if (shareButton) shareButton.onclick = async () => {
      try {
        await navigator.share({ files: [file], title });
        await record();
        status.textContent = '共有が完了しました';
      } catch (error) {
        if (error.name !== 'AbortError') status.textContent = '共有できませんでした。「ZIPをダウンロード」を使えます。';
      }
    };
    await result;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

async function ioScreen(el, params) {
  const destination = await importDestination(params);
  el.innerHTML = `${head('教材パックの読み込み', destination ? folderPath(destination) : 'sets')}
    ${destination ? `<p class="small">取り込み先　📁 ${esc(destination.name)}</p>` : ''}
    <div class="card stack"><p class="small">このスタジオで書き出した教材パック（.elpack.zip）を読み込みます。別の端末で続きを編集したいときや、バックアップから戻すときに使います。</p>
      <label class="btn" for="pk">📦 教材パックを選ぶ</label><input type="file" id="pk" hidden></div><div id="out"></div>`;
  $('#pk', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try {
      const { manifest, material, getFile } = await readMaterialPack(f);
      const exists = await sdb.get('sets', material.set.id);
      // 1.18.1: sound that is neither in the pack nor already in this studio → the lines would open without sound
      const missing = []; for (const m of material.media) { if (m.included) continue; const ex = await sdb.get('sources', m.id); if (!(ex?.stored && ex.blob)) missing.push(m.name || m.id); }
      $('#out', el).innerHTML = `<div class="card stack"><b>${esc(manifest.title)}</b><span class="small">${material.items.length}項目・動画/音声 ${material.media.length}件（${manifest.contents?.audio ? '含む' : '含まない＝あとで選び直し'}）</span>
        ${missing.length ? `<p class="warn-text small">このパックには音声が入っていないファイルが ${missing.length}件あります（${missing.slice(0, 3).map(esc).join('、')}${missing.length > 3 ? '…' : ''}）。読み込むと英文だけになり再生できません。書き出し側で「音声もすべて含める」を選んで書き出し直してください。（あとで教材の画面からファイルを選び直すこともできます）</p>` : ''}
        ${exists ? '<p class="warn-text small">同じセットがすでにあります。</p><button class="btn" id="asCopy">複製として追加</button><button class="btn primary" id="asUpdate">今のセットを更新（新しい版として）</button>' : '<button class="btn primary" id="asNew">登録する</button>'}</div>`;
      const go = async (mode) => { const id = await importPack(getFile, manifest, material, mode); if (destination) await moveStudioSets([id], destination.id); toast('読み込みました'); nav(`set?id=${id}`); };
      $('#asNew', el)?.addEventListener('click', () => go('new'));
      $('#asCopy', el)?.addEventListener('click', () => go('copy'));
      $('#asUpdate', el)?.addEventListener('click', () => go('update'));
    } catch (err) { $('#out', el).innerHTML = `<div class="card warn">読み込めませんでした：${esc(err.message)}</div>`; }
  };
}
async function importPack(getFile, manifest, material, mode) {
  const remap = mode === 'copy';
  const setId = remap ? newId('set_') : material.set.id;
  for (const m of material.media) {
    const exist = await sdb.get('sources', m.id);
    if (exist?.stored && exist.blob && !exist.labMissing) continue;
    let blob = m.included ? await getFile(m) : null;
    // 1.18.1: copy the sound into memory first (as the 動画ラボ does). A piece of the chosen ZIP file stored as it is could be
    // unplayable on the iPhone: the material opened with its script only, without sound.
    if (blob) blob = new File([await blob.arrayBuffer()], m.name || 'audio', { type: m.mime || blob.type || (m.kind === 'audio' ? 'audio/mp4' : 'video/mp4') });
    await sdb.put('sources', { id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime, duration: m.duration, head: m.head, tail: m.tail, stored: !!blob, blob: blob || undefined, addedAt: Date.now() });
  }
  const idMap = {};
  const blocks = material.items.map((it) => { const id = remap ? newId('b_') : it.id; idMap[it.id] = id; return { id, setId, rev: 0, deleted: false, segments: it.segments.map((s) => ({ sourceId: s.media, start: s.start, end: s.end })), text: it.text, ja: it.ja, jaImport: it.jaImport, jaOverride: it.jaOverride, jaReview: it.jaReview, holes: it.holes || [], align: it.align || [], cueRefs: it.cueRefs || { en: [], ja: [] }, lineage: it.lineage || { op: 'create', from: [] }, sync: it.sync || 'auto', jaStatus: it.jaStatus || 'ok', kind: it.role, rep: it.role === 'example' && it.segments.length > 1 ? it.segments.length : undefined, ...(it.label ? { label: it.label } : {}), ...(it.asr ? { asr: true } : {}) }; });
  if (remap) for (const row of blocks) if (row.jaImport) {
    const group = row.jaImport;
    const owner = idMap[group.owner];
    if (!owner || group.members?.some(member => !idMap[member.id])) { delete row.jaImport; row.jaReview = true; continue; }
    row.jaImport = { ...group, owner, ...(group.members ? { members: group.members.map(member => ({ ...member, id: idMap[member.id] })) } : {}) };
  }
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
  if (material.set.packId) set.folder = await ensurePackFolder(material.set.packId, material.set.packName || material.set.folder);
  else if (material.set.folder != null) set.folder = material.set.folder;
  if (material.set.materialType) set.materialType = material.set.materialType;
  if (material.set.splitRange && !remap) set.splitRange = material.set.splitRange;
  await commit(set, mode === 'update' ? '教材パックで更新' : '教材パックから登録', { blocks, order: material.units[0].items.map((id) => idMap[id] || id) });
  if (mode !== 'update') { set.undo = []; await sdb.put('sets', set); }
  await saveVersion(set, '読み込み', true);
  return setId;
}

// ================= technical checks (P1 / P3 / P4) — uses its own database, does not touch real data =================
