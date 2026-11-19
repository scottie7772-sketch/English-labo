// 教材スタジオ（制作）: standalone page studio.html now; later mounted inside Englabo with mount(el, { base: 'studio/' }).
// Rules: does not import learning modules and never touches the learning database (ell-db).
import { $, $$, esc, toast, confirmDialog } from './ui.js';
import { sdb, newId, commit, undo, redo, saveVersion, restoreVersion, liveBlocks, allBlocksMap, sourcesMap, newBlock, tokensOf, blockDur } from './studio-db.js';
import { parseScript, SUB_EXT, isJa, langFromName, autoPair, alignJa } from './studio-subs.js';
import * as ops from './studio-ops.js';
import { fingerprint, zipWrite, zipRead } from './common-pack.js';

export const STUDIO_VERSION = '0.1.0';
const LIMIT_SEC = 15 * 60;   // one import: up to 15 minutes in total (user decision)
let ROOT = null, BASE = '';
const sessionFiles = new Map();   // sourceId -> File (for "保存しない" media; lives only while the page is open)
const urlCache = new Map();
const nav = (path) => { location.hash = '#' + BASE + path; };
const fmt = (s) => (s == null || isNaN(s) ? '--:--' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);
const fmtMin = (s) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
const fmtSize = (n) => (n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const icon = (n) => ({ back: '‹', undo: '↶', redo: '↷', play: '▶︎', pause: '❚❚', more: '⋯' }[n] || n);

export function mount(el, { base = '' } = {}) {
  ROOT = el; BASE = base;
  addEventListener('hashchange', route);
  route();
}
function parseHash() {
  const h = location.hash.slice(1);
  const rest = h.startsWith(BASE) ? h.slice(BASE.length) : h;
  const [path, q] = rest.split('?');
  return { path: path || 'sets', params: new URLSearchParams(q || '') };
}
let cleanup = null;
async function route() {
  cleanup?.(); cleanup = null;
  const { path, params } = parseHash();
  const screens = { sets: setsScreen, import: importScreen, set: editorScreen, versions: versionsScreen, lab: labScreen, io: ioScreen };
  try { await (screens[path] || setsScreen)(ROOT, params); }
  catch (e) { console.error(e); ROOT.innerHTML = `<div class="card warn">エラー：${esc(e.message)}</div><a class="btn" href="#${BASE}sets">一覧に戻る</a>`; }
  scrollTo(0, 0);
}
const head = (title, backPath = null, right = '') => `
  <div class="st-band">制作・教材スタジオ <small>v${STUDIO_VERSION}</small></div>
  <header class="top">${backPath != null ? `<a class="back" href="#${BASE}${backPath}" aria-label="戻る">${icon('back')}</a>` : ''}<h1>${esc(title)}</h1><span class="grow"></span>${right}</header>`;

async function mediaURL(src) {
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
  const est = await navigator.storage?.estimate?.().catch(() => null);
  el.innerHTML = `${head('教材セット', null, `<a class="btn sm" href="#${BASE}lab">技術検証</a>`)}
    <div class="row"><a class="btn primary grow" href="#${BASE}import">＋ 一括登録（動画・音声・字幕）</a><a class="btn" href="#${BASE}io">読み込み</a></div>
    ${est ? `<p class="small muted">端末の保存量：${fmtSize(est.usage || 0)}${est.quota ? ` / 目安の上限 ${fmtSize(est.quota)}` : ''}</p>` : ''}
    ${sets.length ? `<div class="card list">${sets.map((s) => {
      const src = srcs[s.sourceId];
      return `<a class="st-setrow" href="#${BASE}set?id=${s.id}"><span class="grow"><b>${esc(s.title)}</b>
        <small class="muted">${src ? `${src.kind === 'audio' ? '🎧' : '🎬'} ${fmt(src.duration)}・${src.stored ? '端末に保存' : '保存しない'}` : '音声なし'}・${s.order.length}項目・更新 ${new Date(s.updatedAt).toLocaleString('ja-JP')}</small></span>›</a>`;
    }).join('')}</div>` : '<p class="empty">まだ教材セットがありません。「一括登録」から動画・音声と字幕を選んでください。</p>'}
    <p class="hint">このスタジオは単体で動く試作版です（データはこのアプリの中だけに保存）。後で English Labo の中に組み込み、ここで作った教材は「書き出し」→ English Labo で読み込みで移せます。</p>`;
}

// ================= bulk import =================
async function importScreen(el) {
  const files = { media: [], subs: [] };   // analysed entries
  let sets = null, storeMode = 'store';
  el.innerHTML = `${head('一括登録', 'sets')}
    <div class="card stack">
      <p class="small">動画・音声と、英語・日本語の字幕（SRT・VTT・TXT・CSV）をまとめて選びます。ファイル名・言語・長さから自動で組み合わせます。<b>1回の取り込みは合計15分まで</b>。</p>
      <label class="btn" for="fm">🎬 動画・音声を選ぶ（複数可）</label><input type="file" id="fm" accept="video/*,audio/*" multiple hidden>
      <label class="btn" for="fs">📄 字幕・スクリプトを選ぶ（複数可）</label><input type="file" id="fs" multiple hidden>
      <div id="flist" class="small"></div>
    </div>
    <div id="pairs"></div>`;
  const listFiles = () => {
    $('#flist', el).innerHTML = [...files.media.map((m) => `🎬 ${esc(m.name)}（${m.duration ? fmt(m.duration) : '長さ不明'}${m.playable ? '' : '・この端末で再生できません'}・${fmtSize(m.file.size)}）`),
      ...files.subs.map((s) => `📄 ${esc(s.name)}（${s.lang === 'ja' ? '日本語' : '英語'}・${s.parsed.cues.length}行${s.parsed.timed ? '' : '・時間なし'}）`)].join('<br>');
  };
  $('#fm', el).onchange = async (e) => {
    const fl = [...e.target.files]; e.target.value = '';
    toast('動画・音声を確認しています…', 1500);
    for (const f of fl) {
      const meta = await readDuration(f);
      const fp = await fingerprint(f);
      files.media.push({ key: fp.id, name: f.name, file: f, fp, ...meta, kind: f.type.startsWith('audio') || /\.(mp3|m4a|wav|aac)$/i.test(f.name) ? 'audio' : 'video' });
    }
    listFiles(); pair();
  };
  $('#fs', el).onchange = async (e) => {
    const fl = [...e.target.files]; e.target.value = '';
    for (const f of fl) {
      if (!SUB_EXT.test(f.name) && !/text/.test(f.type)) { toast(`${f.name} は字幕として読めません`); continue; }
      const text = await f.text();
      const parsed = parseScript(text, f.name);
      const lang = langFromName(f.name) || (parsed.cues.slice(0, 30).filter((c) => isJa(c.text)).length > 5 ? 'ja' : 'en');
      const lastEnd = parsed.timed ? Math.max(...parsed.cues.map((c) => c.end)) : null;
      files.subs.push({ key: newId('f'), name: f.name, text, parsed, lang, lastEnd });
    }
    listFiles(); pair();
  };
  function pair() {
    sets = autoPair(files.media, files.subs).map((s) => ({ ...s, include: true }));
    draw();
  }
  function draw() {
    if (!sets?.length) { $('#pairs', el).innerHTML = ''; return; }
    const total = sets.filter((s) => s.include && s.media).reduce((a, s) => a + (s.media.duration || 0), 0);
    const over = total > LIMIT_SEC;
    const opt = (arr, cur, label) => `<option value="">（なし）</option>${arr.map((x) => `<option value="${x.key}" ${cur === x ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}`;
    const needBytes = storeMode === 'store' ? sets.filter((s) => s.include && s.media).reduce((a, s) => a + s.media.file.size, 0) : 0;
    $('#pairs', el).innerHTML = `
      <h2 class="sec">組み合わせ（${sets.length}セット）</h2>
      <div class="st-meter ${over ? 'over' : ''}"><i style="width:${Math.min(100, (total / LIMIT_SEC) * 100)}%"></i><span>${fmtMin(total)} / 15分</span></div>
      ${over ? '<p class="warn-text small">合計が15分を超えています。いくつかのセットのチェックを外してください。</p>' : ''}
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
        ${needBytes ? `<small class="muted">必要な容量：約${fmtSize(needBytes)}</small>` : ''}</div>
      <button class="btn primary" id="go" ${over || !sets.some((s) => s.include) ? 'disabled' : ''}>登録する</button>
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
    $('#go', el).onclick = () => runImport(sets.filter((s) => s.include), storeMode);
  }
  async function runImport(list, mode) {
    const prog = $('#prog', el);
    const lock = await navigator.wakeLock?.request?.('screen').catch(() => null);
    navigator.storage?.persist?.().catch(() => {});
    $('#go', el).disabled = true;
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      prog.innerHTML = `<p class="small">登録中 ${i + 1} / ${list.length}：${esc(s.title)}</p>`;
      try { results.push({ s, id: await createSet(s, mode) }); }
      catch (e) { results.push({ s, err: e.message }); }
    }
    lock?.release?.();
    prog.innerHTML = `<div class="card stack"><b>登録 ${results.filter((r) => r.id).length}セット・失敗 ${results.filter((r) => r.err).length}</b>
      ${results.map((r) => `<div class="small">${r.id ? `✓ <a class="link" href="#${BASE}set?id=${r.id}">${esc(r.s.title)}</a>` : `✕ ${esc(r.s.title)}：${esc(r.err)}`}</div>`).join('')}
      <a class="btn" href="#${BASE}sets">一覧へ</a></div>`;
  }
}

async function createSet(s, mode) {
  const setId = newId('set_');
  let src = null;
  if (s.media) {
    const exist = await sdb.get('sources', s.media.fp.id);
    src = exist || { id: s.media.fp.id, kind: s.media.kind, name: s.media.name, size: s.media.file.size, mime: s.media.file.type, duration: s.media.duration, playable: s.media.playable, head: s.media.fp.head, tail: s.media.fp.tail, addedAt: Date.now(), stored: false };
    if (mode === 'store' && !src.stored) { src.stored = true; src.blob = s.media.file; }
    else if (!src.stored) sessionFiles.set(src.id, s.media.file);
    await sdb.put('sources', src);   // a big file is written from disk; may take a while
  }
  const dur = src?.duration || 0;
  const mkTrack = (sub, lang) => sub && { id: newId('tr_'), setId, lang, fileName: sub.name, format: sub.parsed.format, raw: sub.text, offset: 0, cues: sub.parsed.cues };
  const en = mkTrack(s.en, 'en'), ja = mkTrack(s.ja, 'ja');
  const blocks = [];
  const seg = (a, b) => (src && a != null ? [{ sourceId: src.id, start: Math.max(0, a), end: Math.min(dur || b, Math.max(b, a + 0.2)) }] : []);
  if (en) {
    let enCues = en.cues;
    if (!s.en.parsed.timed) {   // no times: spread evenly over the media (marked as estimated)
      const step = dur && enCues.length ? dur / enCues.length : 2;
      enCues = enCues.map((c, i) => ({ ...c, start: i * step, end: (i + 1) * step, est: true }));
    }
    const { map, extra } = ja && s.ja.parsed.timed && !enCues[0]?.est ? alignJa(enCues, ja.cues) : { map: new Map(), extra: [] };
    enCues.forEach((c, i) => {
      const jas = map.get(c.id) || [];
      const jaText = jas.length ? jas.map((j) => j.text).join('') : c.ja || (ja && !s.ja.parsed.timed ? ja.cues[i]?.text || '' : '');
      const segs = seg(c.start, c.end);
      blocks.push(newBlock(setId, { segments: segs, text: c.text, ja: jaText, cueRefs: { en: [c.id], ja: jas.map((j) => j.id) }, sync: c.est ? 'estimated' : 'auto',
        align: segs.length && tokensOf(c.text).length ? [{ s: 0, e: tokensOf(c.text).length - 1, v0: 0, v1: segs[0].end - segs[0].start }] : [] }));
    });
    for (const j of extra) blocks.push(newBlock(setId, { segments: seg(j.start, j.end), text: '', ja: j.text, jaStatus: 'needsReview', cueRefs: { en: [], ja: [j.id] } }));
    blocks.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
  } else if (ja) {
    ja.cues.forEach((j) => blocks.push(newBlock(setId, { segments: s.ja.parsed.timed ? seg(j.start, j.end) : [], text: '', ja: j.text, cueRefs: { en: [], ja: [j.id] }, sync: s.ja.parsed.timed ? 'auto' : 'estimated' })));
  }
  const set = { id: setId, title: s.title || src?.name || '無題', sourceId: src?.id || null, tracks: { en: en?.id || null, ja: ja?.id || null }, order: [], undo: [], redo: [],
    display: { en: true, ja: true, opEn: 1, opJa: 0.8, pos: 'below', order: 'en' }, createdAt: Date.now(), updatedAt: Date.now() };
  await sdb.tx(['sets', 'tracks'], 'readwrite', (t) => { t.objectStore('sets').put(set); if (en) t.objectStore('tracks').put(en); if (ja) t.objectStore('tracks').put(ja); });
  await commit(set, '取り込み', { blocks, order: blocks.map((b) => b.id) });
  set.undo = []; await sdb.put('sets', set);   // the import itself is not undoable (delete the set instead)
  await saveVersion(set, '取り込み直後', true);
  return setId;
}

// ================= editor =================
async function editorScreen(el, params) {
  let set = await sdb.get('sets', params.get('id'));
  if (!set) return nav('sets');
  let srcs = await sourcesMap();
  let blocks = [], byId = {};
  const sel = new Set();
  let selectMode = false, rangeMode = null, anchor = null, onlySel = false, moveMode = false, playing = null, curBlock = null;
  const reload = async () => { set = await sdb.get('sets', set.id); blocks = await liveBlocks(set); byId = Object.fromEntries(blocks.map((b) => [b.id, b])); for (const id of [...sel]) if (!byId[id]) sel.delete(id); };
  await reload();
  const src = srcs[set.sourceId];
  el.innerHTML = `${head(set.title, 'sets', `<button class="icon-btn" id="undoB" aria-label="元に戻す">${icon('undo')}</button><button class="icon-btn" id="redoB" aria-label="やり直す">${icon('redo')}</button><button class="icon-btn" id="moreB" aria-label="メニュー">${icon('more')}</button>`)}
    <div id="relink"></div>
    <div class="st-player"><div class="st-vwrap"><video id="vid" playsinline webkit-playsinline preload="metadata"></video><div class="st-ov" id="ov"></div></div>
      <div class="st-sub" id="sub"></div>
      <div class="row st-ctl"><button class="btn sm" id="back3">⟲3</button><button class="btn sm primary" id="pp">${icon('play')}</button><button class="btn sm" id="fwd3">3⟳</button><span class="small muted" id="tnow">0:00.0</span><span class="grow"></span><button class="btn sm" id="selB">選択</button></div></div>
    <details class="card details"><summary>字幕の表示</summary>
      <div class="fgrp"><span>表示</span><div class="seg" id="dShow"><button data-v="both">英＋日</button><button data-v="en">英</button><button data-v="ja">日</button><button data-v="none">なし</button></div></div>
      <div class="fgrp"><span>位置</span><div class="seg" id="dPos"><button data-v="below">動画の下</button><button data-v="ovb">動画の上・下端</button><button data-v="ovt">動画の上・上端</button></div></div>
      <div class="fgrp"><span>英語の透明度</span><div class="seg" id="dOpEn">${[1, 0.7, 0.4, 0.2].map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>日本語の透明度</span><div class="seg" id="dOpJa">${[1, 0.7, 0.4, 0.2].map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>順番</span><div class="seg" id="dOrd"><button data-v="en">英が上</button><button data-v="ja">日が上</button></div></div>
    </details>
    <div id="info" class="small muted"></div>
    <div id="list" class="st-list"></div>
    <div id="bar" class="st-bar" hidden></div>`;
  const vid = $('#vid', el), list = $('#list', el), bar = $('#bar', el);

  // ---------- media ----------
  async function attach(sourceId) {
    const s = srcs[sourceId]; const u = await mediaURL(s);
    if (!u) return false;
    if (vid.dataset.src !== sourceId) { vid.dataset.src = sourceId; vid.src = u; await new Promise((r) => { vid.onloadedmetadata = r; setTimeout(r, 4000); }); }
    return true;
  }
  function drawRelink() {
    const need = [...new Set(blocks.flatMap((b) => b.segments.map((x) => x.sourceId)))].map((id) => srcs[id]).filter((s) => s && !s.stored && !sessionFiles.has(s.id));
    $('#relink', el).innerHTML = need.map((s) => `<div class="notice warn stack"><b>動画・音声ファイルが必要です</b><span class="small">${esc(s.name)}（${fmtSize(s.size)}・${fmt(s.duration)}）は端末に保存していません。同じファイルを選ぶと再生・分割ができます。文字の編集はこのままでもできます。</span>
      <label class="btn sm" for="rl_${s.id}">ファイルを選ぶ</label><input type="file" id="rl_${s.id}" data-src="${s.id}" accept="video/*,audio/*" hidden></div>`).join('');
    $$('#relink input[type=file]', el).forEach((inp) => (inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return; const s = srcs[inp.dataset.src];
      const fp = await fingerprint(f);
      if (fp.id !== s.id && !(await confirmDialog({ title: '別のファイルのようです', body: `<p class="small">選んだファイルは登録時と大きさか中身が違います（写真アプリから選ぶと、iPhoneが別の形式で書き出すことがあります）。このファイルでつなぎますか？時間がずれる可能性があります。</p>`, okLabel: 'つなぐ' }))) return;
      sessionFiles.set(s.id, f); urlCache.delete(s.id); drawRelink(); toast('つなぎました（この画面を閉じるまで有効）');
      if (set.sourceId === s.id) attach(s.id);
    }));
  }
  // play a block: its segments in order (may switch files)
  async function playBlock(b, loop = false) {
    if (!b.segments.length) return toast('この項目には音声区間がありません');
    playing = { b, i: 0, loop }; curBlock = b;
    await startSeg();
  }
  async function startSeg() {
    const p = playing; if (!p) return;
    const s = p.b.segments[p.i];
    if (!(await attach(s.sourceId))) { playing = null; return toast('ファイルを選んでください'); }
    vid.currentTime = s.start; try { await vid.play(); } catch {}
  }
  let raf = 0;
  const tick = () => {
    if (playing && !vid.paused) {
      const s = playing.b.segments[playing.i];
      if (vid.currentTime >= s.end - 0.02) {
        if (playing.i + 1 < playing.b.segments.length) { playing.i++; startSeg(); }
        else if (playing.loop) { playing.i = 0; startSeg(); }
        else { vid.pause(); playing = null; }
      }
    }
    $('#tnow', el).textContent = fmt(vid.currentTime || 0);
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
    const d = set.display;
    const en = b && (d.show !== 'ja' && d.show !== 'none') && b.text ? `<div class="st-en" style="opacity:${d.opEn}">${esc(b.text)}</div>` : '';
    const ja = b && (d.show !== 'en' && d.show !== 'none') && b.ja ? `<div class="st-ja" style="opacity:${d.opJa}">${esc(b.ja)}</div>` : '';
    const html = d.order === 'ja' ? ja + en : en + ja;
    const over = d.pos !== 'below';
    $('#ov', el).className = `st-ov ${d.pos}`; $('#ov', el).innerHTML = over ? html : '';
    $('#sub', el).innerHTML = over ? '' : html || '<span class="muted small">（字幕）</span>';
    $$('.st-row.cur', list).forEach((r) => r.classList.remove('cur'));
    if (b) list.querySelector(`[data-id="${b.id}"]`)?.classList.add('cur');
  }
  function drawDisplay() {
    const d = set.display; d.show ||= 'both';
    const on = (id, v) => $$(`#${id} button`, el).forEach((x) => x.classList.toggle('on', x.dataset.v === String(v)));
    on('dShow', d.show); on('dPos', d.pos); on('dOpEn', d.opEn); on('dOpJa', d.opJa); on('dOrd', d.order);
    lastSubId = null; drawSub();
  }
  const segBind = (id, key, num) => ($('#' + id, el).onclick = async (e) => { const v = e.target.dataset.v; if (v == null) return; set.display[key] = num ? +v : v; await sdb.put('sets', set); drawDisplay(); });
  segBind('dShow', 'show'); segBind('dPos', 'pos'); segBind('dOpEn', 'opEn', true); segBind('dOpJa', 'opJa', true); segBind('dOrd', 'order');

  // ---------- list ----------
  const holeHTML = (b) => { const t = tokensOf(b.text); return t.map((w, i) => (b.holes || []).some((h) => i >= h.s && i <= h.e) ? `<u class="st-hole">${esc(w)}</u>` : esc(w)).join(' '); };
  function drawList() {
    const rs = ops.ranges(set.order.filter((id) => byId[id]), sel);
    $('#info', el).textContent = `${blocks.length}項目${selectMode ? `・選択 ${rs.length}範囲 ${sel.size}項目` : ''}${(set.undo || []).length ? `・元に戻せる操作 ${set.undo.length}` : ''}`;
    const shown = onlySel ? blocks.filter((b) => sel.has(b.id)) : blocks;
    list.innerHTML = shown.map((b) => {
      const badges = [b.segments.length > 1 ? `<span class="tagp">${b.segments.length}区間</span>` : '', new Set(b.segments.map((s) => s.sourceId)).size > 1 ? '<span class="tagp">複数ファイル</span>' : '',
        b.sync === 'estimated' ? '<span class="tagp warn">時間は推定</span>' : '', b.jaStatus === 'needsReview' ? '<span class="tagp warn">訳を確認</span>' : '', !b.segments.length ? '<span class="tagp">音声なし</span>' : ''].join('');
      return `<div class="st-row ${sel.has(b.id) ? 'sel' : ''}" data-id="${b.id}">
        ${selectMode ? `<span class="st-chk" data-chk="${b.id}">${sel.has(b.id) ? '☑' : '☐'}</span>` : ''}
        <span class="grow st-txt" data-play="${b.id}"><small class="muted">${fmt(b.segments[0]?.start)}–${fmt(b.segments.at(-1)?.end)} ${badges}</small>
          <span class="st-en2">${holeHTML(b) || '<span class="muted">（英文なし）</span>'}</span><span class="st-ja2">${esc(b.ja || '')}</span></span>
        ${selectMode ? '' : `<button class="icon-btn" data-edit="${b.id}" aria-label="編集">✎</button>`}</div>`;
    }).join('') || '<p class="empty">項目がありません</p>';
    $('#undoB', el).disabled = !(set.undo || []).length; $('#redoB', el).disabled = !(set.redo || []).length;
    drawBar();
  }
  function drawBar() {
    bar.hidden = !selectMode;
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
    if (selectMode) return tapRow(row.dataset.id);
    playBlock(byId[row.dataset.id]);
  });

  // ---------- actions (each = one undoable operation) ----------
  const ordered = () => ops.orderedSelection(set.order, sel).map((id) => byId[id]).filter(Boolean);
  async function run(label, changes) {
    try { await commit(set, label, changes, srcs); await reload(); drawList(); toast(`${label}しました`, 1200); }
    catch (e) { toast(e.message, 3500); }
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
        } catch (e) { toast(e.message, 3000); }
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
      await run('編集', { blocks: [work] });
    };
    dlg.showModal();
  }

  // ---------- header buttons ----------
  $('#undoB', el).onclick = async () => { const op = await undo(set); if (op) { await reload(); drawList(); toast(`元に戻しました：${op.label}`, 1500); } };
  $('#redoB', el).onclick = async () => { const op = await redo(set); if (op) { await reload(); drawList(); toast(`やり直しました：${op.label}`, 1500); } };
  $('#selB', el).onclick = () => { selectMode = !selectMode; if (!selectMode) { sel.clear(); onlySel = false; } drawList(); };
  $('#pp', el).onclick = async () => { if (vid.paused) { if (!vid.src && set.sourceId) await attach(set.sourceId); playing = null; vid.play().catch(() => {}); } else vid.pause(); };
  vid.onplay = () => ($('#pp', el).textContent = icon('pause')); vid.onpause = () => ($('#pp', el).textContent = icon('play'));
  $('#back3', el).onclick = () => { vid.currentTime = Math.max(0, vid.currentTime - 3); };
  $('#fwd3', el).onclick = () => { vid.currentTime += 3; };
  $('#moreB', el).onclick = async () => {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(set.title)}</h3>
      <button class="btn" value="ver">版（保存・復元）</button>
      <button class="btn" value="exp">教材パックとして書き出す</button>
      <button class="btn" value="ren">名前を変える</button>
      <button class="btn danger" value="del">このセットを削除</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      if (v === 'ver') nav(`versions?id=${set.id}`);
      if (v === 'exp') exportSet(set);
      if (v === 'ren') { const t = prompt('新しい名前', set.title); if (t) { set.title = t; await sdb.put('sets', set); route(); } }
      if (v === 'del' && (await confirmDialog({ title: 'セットを削除', body: '<p>字幕・編集・版も削除します（元に戻せません）。動画本体は、ほかのセットで使っていなければ削除します。</p>', okLabel: '削除', danger: true }))) { await deleteSet(set); nav('sets'); }
    };
    dlg.showModal();
  };
  if (set.sourceId) attach(set.sourceId);
  drawRelink(); drawDisplay(); drawList();
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
async function exportSet(set) {
  const blocks = await liveBlocks(set), srcs = await sourcesMap(), tracks = await sdb.byIndex('tracks', 'setId', set.id);
  const media = [...new Set(blocks.flatMap((b) => b.segments.map((s) => s.sourceId)))].map((id) => srcs[id]).filter(Boolean);
  const canInclude = media.every((m) => m.stored || sessionFiles.has(m.id));
  const withMedia = canInclude && (await confirmDialog({ title: '書き出し', body: `<p>動画・音声も含めますか？（${fmtSize(media.reduce((a, m) => a + m.size, 0))}）</p><p class="hint">含めない場合は小さなファイルになり、読み込む側で同じ動画を選び直します。</p>`, okLabel: '含める', cancelLabel: '含めない' }));
  const manifest = { format: 'elpack', formatVersion: 2, packId: newId('pk_'), materialId: set.id, materialVersion: (await sdb.byIndex('versions', 'setId', set.id)).length, title: set.title, lang: 'en', source: { app: 'Englabo Studio', appVersion: STUDIO_VERSION }, scope: 'collection', createdAt: new Date().toISOString(),
    contents: { audio: withMedia, text: true, translation: true, timestamps: true, vocab: false } };
  const material = { set: { id: set.id, title: set.title, display: set.display }, units: [{ id: set.id, title: set.title, items: blocks.map((b) => b.id) }],
    items: blocks.map((b) => ({ id: b.id, rev: b.rev, segments: b.segments.map((s) => ({ media: s.sourceId, start: s.start, end: s.end })), text: b.text, ja: b.ja, holes: b.holes, align: b.align, cueRefs: b.cueRefs, lineage: b.lineage, sync: b.sync, jaStatus: b.jaStatus })),
    media: media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime, duration: m.duration, head: m.head, tail: m.tail, included: withMedia, path: withMedia ? `media/${m.id}${(m.name.match(/\.\w+$/) || [''])[0]}` : null })),
    tracks: tracks.map((t) => ({ id: t.id, lang: t.lang, fileName: t.fileName, format: t.format, path: `subtitles/${t.id}-${t.fileName}` })) };
  const files = [{ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) }, { name: 'material.json', data: JSON.stringify(material, null, 1) }, ...tracks.map((t) => ({ name: `subtitles/${t.id}-${t.fileName}`, data: t.raw }))];
  if (withMedia) for (const m of media) files.push({ name: material.media.find((x) => x.id === m.id).path, data: m.stored ? m.blob : sessionFiles.get(m.id) });
  toast('書き出しています…', 2000);
  const zip = await zipWrite(files);
  const name = `${set.title.replace(/[\\/:*?"<>|]/g, '_')}.elpack.zip`;
  const file = new File([zip], name, { type: 'application/zip' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: set.title }); return; } catch (e) { if (e.name === 'AbortError') return; } }
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
  const blocks = material.items.map((it) => { const id = remap ? newId('b_') : it.id; idMap[it.id] = id; return { id, setId, rev: 0, deleted: false, segments: it.segments.map((s) => ({ sourceId: s.media, start: s.start, end: s.end })), text: it.text, ja: it.ja, holes: it.holes || [], align: it.align || [], cueRefs: it.cueRefs || { en: [], ja: [] }, lineage: it.lineage || { op: 'create', from: [] }, sync: it.sync || 'auto', jaStatus: it.jaStatus || 'ok' }; });
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
      <label class="btn sm" for="p1f">動画を選んで保存テスト</label><input type="file" id="p1f" accept="video/*,audio/*" hidden>
      <button class="btn sm" id="p1r">保存済みを読み出して再生（アプリを閉じて開き直した後に）</button><button class="btn sm" id="p1d">テスト用データを削除</button></div>
    <div class="card stack"><b>P2 同じファイルの照合</b><span class="small">同じ動画をもう一度選び、P1 の指紋と比べる</span>
      <label class="btn sm" for="p2f">同じ動画を選ぶ</label><input type="file" id="p2f" accept="video/*,audio/*" hidden></div>
    <div class="card stack"><b>P3 区間再生の途切れ</b><span class="small">選んだ動画の3か所を続けて再生し、切り替えにかかる時間を測る（2本目を選ぶと別ファイルをまたぐ測定も）</span>
      <label class="btn sm" for="p3f">動画（1〜2本）を選ぶ</label><input type="file" id="p3f" accept="video/*,audio/*" multiple hidden>
      <video id="p3v" playsinline muted style="width:100%;max-height:160px;background:#000"></video><video id="p3v2" playsinline muted hidden></video></div>
    <div class="card stack"><b>P4 音声の展開（波形・無音検出用）</b><span class="small">5分・10分・15分の動画や音声で試す。落ちた場合は「落ちた」と伝えてください</span>
      <label class="btn sm" for="p4f">動画・音声を選ぶ</label><input type="file" id="p4f" accept="video/*,audio/*" hidden></div>
    <div class="card stack"><b>結果</b><pre id="lo" class="st-log"></pre><button class="btn sm" id="cp">結果をコピー</button></div>`;
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
    catch (e) { out(`  端末に保存 失敗：${e.name} ${e.message}`); return; }
    await playTest('p1');
  };
  async function playTest(id) {
    const rec = await lab.get('files', id); if (!rec) return out('  保存済みデータがありません');
    const v = $('#p3v', el); const u = URL.createObjectURL(rec.blob); let t = performance.now();
    v.src = u; await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 10000); });
    out(`  読み出し→再生準備 ${Math.round(performance.now() - t)}ms・長さ ${fmt(v.duration)}`);
    t = performance.now(); v.currentTime = (v.duration || 10) * 0.8; await new Promise((r) => { v.onseeked = r; setTimeout(r, 8000); });
    out(`  80%地点へシーク ${Math.round(performance.now() - t)}ms`);
    try { await v.play(); await new Promise((r) => setTimeout(r, 800)); v.pause(); out('  再生 ✓'); } catch (e) { out(`  再生 失敗：${e.message}`); }
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
    } catch (e) { out(`  失敗：${e.name} ${e.message}`); }
  };
  $('#cp', el).onclick = async () => { try { await navigator.clipboard.writeText(log.join('\n')); toast('コピーしました'); } catch { toast('コピーできませんでした。長押しで選択してください'); } };
}
