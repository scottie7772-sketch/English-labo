// 「音声付き単語帳を作成」: 単語帳・スタジオ・Video Lab から呼ぶ共通の画面。
// 通常の操作は「教材を選ぶ → 開始 → 確認 → 登録」だけ。認識の精度・照合の順序・アルゴリズムは選ばせない（内部で自動）。
// 教材タイプ・単語リスト・境界の調整などは「詳細設定」に置く。既存の手動編集機能（スタジオの編集・音声を割当）はそのまま使える。
import { db } from './db.js';
import { runPipeline, runMany, loadRecord, markBroken, reviewConfirm, reviewClear, registerRecord, planRegistration, buildDiagnostics, parseWordList, loadMaterial, PROFILES, MODES } from './vocab-audio-pipeline.js';
import { STATE } from './vocab-audio-core.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n = 60) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const toast = (text, ms = 3500) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); };
const pause = () => new Promise(r => setTimeout(r, 60));
const TIER_TEXT = { high: '高', mid: '中', low: '低' };
const wa = () => import('./word-audio.js');

function dialog() {
  const dlg = document.getElementById('dialog');
  if (dlg.open) { dlg.onclose = null; dlg.close(); }
  return dlg;
}
function sheet(title, body, buttons) {
  const dlg = dialog();
  dlg.innerHTML = `<form method="dialog" class="dlg stack jp-sheet"><span class="dlg-global-close" hidden></span><h3>${esc(title)}</h3>${body}
    <div class="jp-grid">${buttons.map(([v, l, c = '']) => `<button class="btn sm ${c}" value="${v}">${esc(l)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise(resolve => { dlg.onclose = () => resolve({ value: dlg.returnValue, dlg }); dlg.showModal(); });
}

// ---------- 教材の選択（単語帳から開いたとき） ----------
async function pickTargets() {
  const videos = (await db.all('videos')).map(({ blob, audioBlob, ...v }) => v);
  const children = new Set(videos.flatMap(v => (v.parts || []).map(p => p.videoId)));   // the parts of a joined material are listed through it
  const lab = videos.filter(v => !children.has(v.id));
  let sets = [];
  try { const { sdb } = await import('./studio-db.js'); sets = (await sdb.all('sets')).filter(s => !s.deleted); } catch { /* the Studio store is not available */ }
  const group = list => {
    const byFolder = new Map();
    for (const x of list) { const f = x.folder || ''; if (!byFolder.has(f)) byFolder.set(f, []); byFolder.get(f).push(x); }
    return [...byFolder].map(([f, xs]) => `<div class="stack small">${f ? `<b>📁 ${esc(f)}</b>` : ''}${xs.map(x => `<label class="chk"><input type="checkbox" name="t" value="${esc(x.kind)}:${esc(x.id)}"> ${esc(x.title)}</label>`).join('')}</div>`).join('');
  };
  const labItems = lab.map(v => ({ kind: 'lab', id: v.id, title: v.name, folder: v.folder })), studioItems = sets.map(s => ({ kind: 'studio', id: s.id, title: s.title, folder: s.folder }));
  const r = await sheet('音声付き単語帳を作成：教材を選ぶ', `<p class="small">すでに取り込んである教材（音声と字幕）から作ります。再取り込み・再文字起こしは要りません。</p>
    ${studioItems.length ? `<details open><summary><b>スタジオの教材</b>（${studioItems.length}）</summary><div class="jp-list">${group(studioItems)}</div></details>` : ''}
    ${labItems.length ? `<details ${studioItems.length ? '' : 'open'}><summary><b>Video Labの教材</b>（${labItems.length}）</summary><div class="jp-list">${group(labItems)}</div></details>` : ''}
    ${!studioItems.length && !labItems.length ? '<p class="small warn-text">教材がありません。</p>' : ''}
    <p class="small muted">新しい音声とスクリプトから作るときは、スタジオで取り込んでから、ここで教材を選びます。</p>`,
    [['go', 'この教材で作る', 'primary'], ['studio', '新しい教材を取り込む（スタジオ）'], ['close', '閉じる', 'ghost']]);
  if (r.value === 'studio') { location.hash = '#studio/import'; return []; }
  if (r.value !== 'go') return [];
  const keys = [...r.dlg.querySelectorAll('[name=t]:checked')].map(x => x.value);
  const all = [...studioItems, ...labItems];
  return keys.map(k => all.find(x => `${x.kind}:${x.id}` === k)).filter(Boolean);
}

// ---------- フォルダ単位（同じフォルダの教材すべて） ----------
export async function folderTargets(target) {
  const m = await loadMaterial(target.kind, target.id);
  if (!m.folder) return [{ kind: target.kind, id: target.id, title: m.title }];
  if (target.kind === 'lab') return (await db.all('videos')).filter(v => v.folder === m.folder && v.kind !== 'multi').map(v => ({ kind: 'lab', id: v.id, title: v.name }));
  const { sdb } = await import('./studio-db.js');
  return (await sdb.all('sets')).filter(s => s.folder === m.folder).map(s => ({ kind: 'studio', id: s.id, title: s.title }));
}

// ---------- 開始 ----------
// prepare: { run({onStep}), note } — スタジオの教材で、文字起こしや確実な照合がまだのとき、開始と同時に先に行う下ごしらえ
export async function openVocabAudioWizard({ targets = null, folder = false, prepare = null } = {}) {
  if (!targets?.length) targets = await pickTargets();
  if (!targets.length) return false;
  await pause();
  const rec0 = targets.length === 1 ? await loadRecord(targets[0].kind, targets[0].id) : null;
  const folderName = folder ? '（フォルダ全体）' : '';
  const r = await sheet('音声付き単語帳を作成', `<p class="small"><b>${esc(targets.length === 1 ? targets[0].title : `${targets.length}教材`)}</b>${folderName}　教材の種類は自動で判定し、音声・字幕・照合結果はそのまま使います。</p>
    <fieldset class="stack small"><legend>登録する内容</legend>
      ${Object.entries(MODES).map(([k, t]) => `<label class="chk"><input type="radio" name="mode" value="${k}" ${k === (rec0?.mode || 'head') ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
      <span class="muted">標準は見出し語の元音声を優先します。例文の音声が見つからなくても、見出し語が確定していれば登録できます。</span></fieldset>
    ${prepare?.note ? `<p class="small">${esc(prepare.note)}</p>` : ''}
    ${rec0 ? `<p class="small muted">前回の作成の記録があります（${rec0.items.length}項目）。入力が変わっていなければ、前回の結果をそのまま使います。</p>` : ''}
    <details><summary class="small">詳細設定</summary><div class="stack small">
      <label class="field"><span>教材の種類</span><select name="profile"><option value="auto">自動で判定（標準）</option>${Object.entries(PROFILES).map(([k, t]) => `<option value="${k}" ${rec0?.profileSetting === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field"><span>単語リスト（会話・朗読で、文中のフレーズを登録するとき。1行に1つ、「フレーズ[タブ]意味」でも可）</span><textarea name="words" rows="4" autocapitalize="off" spellcheck="false">${esc((rec0?.wordList || []).map(w => w.ja ? `${w.head}\t${w.ja}` : w.head).join('\n'))}</textarea></label>
      <label class="chk"><input type="checkbox" name="refine" checked> 発話の切れ目を調べて、確認が必要な語の端（語頭・語尾）を合わせる</label>
      <label class="chk"><input type="checkbox" name="force"> 前回の結果を使わず、最初からやり直す（手で確定した音声は残ります）</label></div></details>`,
    [['go', '開始', 'primary'], ['close', '閉じる', 'ghost']]);
  if (r.value !== 'go') return false;
  const q = n => r.dlg.querySelector(`[name=${n}]`);
  const options = { mode: r.dlg.querySelector('[name=mode]:checked')?.value || 'head', profile: q('profile').value, wordList: parseWordList(q('words').value), refine: q('refine').checked, force: q('force').checked };
  await pause();
  if (prepare?.run) {
    // 文字起こしは自分の進み具合の画面を持つ。終わったら続けて作成に進む（途中で止めても、済んだ分は教材に残っている）。
    try { await prepare.run({ onStep: t => toast(t + '…', 4000) }); } catch (error) { toast('下ごしらえを完了できませんでした：' + error.message, 6000); }
    await pause();
  }
  return runAndReview(targets, options);
}

// ---------- 実行（進み具合・中断） ----------
// 進み具合の画面つきで実行する（確認画面は開かない）。
async function runWithProgress(targets, options) {
  const dlg = dialog();
  let cancelled = false;
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><span class="dlg-global-close" hidden></span><h3>音声付き単語帳を作成</h3><p class="small" id="vwMsg" aria-live="polite">準備しています…</p>
    <div class="st-meter"><i id="vwBar" style="width:0%"></i></div><button class="btn sm" value="cancel">中断（済んだ分は保存されます）</button></form>`;
  dlg.returnValue = ''; dlg.onclose = () => { cancelled = true; };
  dlg.showModal();
  const msg = t => { const m = dlg.querySelector('#vwMsg'); if (m) m.textContent = t; };
  const bar = p => { const b = dlg.querySelector('#vwBar'); if (b) b.style.width = `${Math.round(p * 100)}%`; };
  const LABEL = { load: '教材を読み込んでいます', detect: '教材の種類を判定しています', extract: '見出し語・例文を取り出しています', grade: '音声の確からしさを調べています', regions: '発話の切れ目を調べています', recheck: '確定していない語を前後の音声から調べ直しています' };
  const regionsFor = options.refine ? async (src, a, b) => (await wa()).speechRegionsIn(src, a, b) : undefined;
  let index = 0;
  const hooks = { cancelled: () => cancelled, regionsFor,
    onMaterial: (i, n, t) => { index = i; msg(`${i + 1} / ${n}　${t.title || ''}`); bar(i / n); },
    onStep: (name, info) => { msg(`${targets.length > 1 ? `${index + 1}/${targets.length}　` : ''}${LABEL[name] || name}${info?.total ? `（${info.done}/${info.total}）` : ''}`); if (name === 'regions' && info.total) bar(info.done / info.total); } };
  let results;
  try { results = await runMany(targets, options, hooks); }
  finally { dlg.onclose = null; if (dlg.open) dlg.close(); }
  await pause();
  const failed = results.filter(x => x.error);
  if (failed.length) toast(`${failed.length}教材は処理できませんでした：${failed[0].error}`, 6000);
  if (cancelled) toast('中断しました。済んだ分は保存されています（もう一度開始すると続きから進みます）', 5000);
  return results.filter(x => x.rec);
}
async function runAndReview(targets, options) {
  const ok = await runWithProgress(targets, options);
  if (!ok.length) return false;
  return ok.length === 1 ? reviewScreen(ok[0].rec.kind, ok[0].rec.id) : reviewMany(ok.map(x => x.rec));
}

async function reviewMany(recs) {
  for (;;) {
    const rows = recs.map((rec, i) => `<button class="btn sm" value="open${i}">${esc(rec.title)}<br><span class="small muted">${rec.items.length}語・確定 ${rec.items.filter(x => x.state === 'confirmed' || x.state === 'registered').length}・候補 ${rec.items.filter(x => x.state === 'candidates').length}・未特定 ${rec.items.filter(x => x.state === 'unresolved').length}</span></button>`).join('');
    const r = await sheet(`作成結果（${recs.length}教材）`, `<div class="stack" style="max-height:52dvh;overflow:auto">${rows}</div><p class="small muted">教材ごとに確認・修正できます。「すべて登録」は、確定した音声だけを登録します（未確定の語は後から追加できます）。</p>`,
      [['all', '確定した語をすべて登録', 'primary'], ['close', '閉じる', 'ghost']]);
    const m = /^open(\d+)$/.exec(r.value);
    if (m) { await pause(); await reviewScreen(recs[+m[1]].kind, recs[+m[1]].id); await pause(); recs = await Promise.all(recs.map(x => loadRecord(x.kind, x.id))); continue; }
    if (r.value !== 'all') return true;
    await pause();
    let added = 0, updated = 0, bytes = 0;
    for (const rec of recs) { const x = await registerRecord(rec.kind, rec.id); added += x.added; updated += x.updated; bytes += x.bytes; }
    toast(`新規 ${added}語・既存の語に音声を追加 ${updated}語（追加容量 約${fmtSize(bytes)}・音声ファイルは複製しません）`, 6000);
    recs = await Promise.all(recs.map(x => loadRecord(x.kind, x.id)));
  }
}

// ---------- 確認画面 ----------
const PAGE = 30;
// 確認画面。閉じるまで解決しない。「未確定だけ再処理」は、閉じて処理して、また開く。
export async function reviewScreen(kind, id) {
  for (;;) {
    const out = await reviewOnce(kind, id);
    if (out !== 'again') return out !== false;
    await pause();
    const rec = await loadRecord(kind, id);
    await runWithProgress([{ kind, id, title: rec.title }], { mode: rec.mode, profile: rec.profileSetting, wordList: rec.wordList, refine: true, again: true });
    await pause();
  }
}
async function reviewOnce(kind, id) {
  let rec = await loadRecord(kind, id);
  if (!rec) { toast('作成の記録が見つかりません'); return false; }
  await markBroken(rec);
  let result = true, resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  let filter = 'open', shown = PAGE, open = null, closed = false;
  const work = new Map();          // `${key}|${n}` -> 調整中の { start, end }
  const editKinds = () => rec.mode === 'sentence' ? ['sentence'] : ['word'];
  const planText = async () => {
    const p = await planRegistration(rec);
    return `新規登録 <b>${p.add.length}</b>語・既存の語に音声を追加 <b>${p.update.length}</b>語・変更なし ${p.skip.length}語・未確定のため見送り ${p.pending.length}語・重複候補 ${p.dupes.length}件<br><span class="muted">追加される容量：単語データ 約${fmtSize(new Blob([JSON.stringify([...p.add.map(x => x.word), ...p.update.map(x => x.audio)])]).size)}（音声は元の録音を参照するため 0 B）</span>`;
  };
  const stateTag = it => { const s = it.state; return `<span class="wa-tag ${s === 'confirmed' || s === 'registered' ? '' : 'warn'}">${esc(STATE[s] || s)}</span>`; };
  const cands = it => {
    const kind0 = editKinds()[0], cur = it.refs[kind0];
    const list = [];
    if (cur) list.push({ start: cur.ref.start, end: cur.ref.end, src: cur.ref.src, label: `現在の範囲（確からしさ ${TIER_TEXT[cur.tier] || ''}）`, why: cur.reasons.join('・') });
    for (const c of it.candidates || []) list.push({ ...c, label: c.source === 'estimate' ? '文字数からの推定' : `認識結果「${clip(c.text, 24)}」（${c.why || ''}）`, why: '' });
    return list;
  };
  const rowHTML = it => {
    const kind0 = editKinds()[0], ref = it.refs[kind0], isOpen = open === it.key;
    const play = (k, label) => it.refs[k] && !it.refs[k].broken ? `<button type="button" class="btn xs" data-play="${esc(it.key)}|${k}">▶ ${label}</button>` : '';
    const editable = ['candidates', 'unresolved'].includes(it.state) || ref?.broken;
    return `<div class="vw-row card stack small" data-key="${esc(it.key)}">
      <div class="wa-row"><b class="grow">${esc(clip(it.head, 70))}</b>${stateTag(it)}</div>
      <div class="muted">${esc(clip(it.ja, 50))}${it.example ? `${it.ja ? '／' : ''}${esc(clip(it.example, 60))}` : ''}</div>
      <div class="wa-row">${play(kind0, rec.mode === 'sentence' ? '文' : '見出し語')}${rec.mode !== 'sentence' ? play('example', '例文') : ''}${editable ? `<button type="button" class="btn xs" data-open="${esc(it.key)}">${isOpen ? '閉じる' : '候補・修正'}</button>` : ''}${it.state === 'confirmed' || it.state === 'registered' ? `<button type="button" class="btn xs ghost" data-clear="${esc(it.key)}">参照を外す</button>` : ''}</div>
      ${ref?.reasons?.length && it.state !== 'confirmed' && it.state !== 'registered' ? `<div class="muted">${esc(ref.reasons.join('・'))}</div>` : ''}
      ${it.issues?.length && it.state === 'unresolved' ? `<div class="muted">${esc(it.issues[0])}</div>` : ''}
      ${isOpen ? cands(it).map((c, n) => { const w = work.get(`${it.key}|${n}`) || { start: c.start, end: c.end }; return `<div class="stack" data-cand="${n}">
        <div class="muted">${esc(c.label)}</div>
        <div class="wa-grid"><span class="small" data-time>${fmtT(w.start)}〜${fmtT(w.end)}</span><button type="button" class="btn sm" data-adj="${n}:start:-0.05">開始−</button><button type="button" class="btn sm" data-adj="${n}:start:0.05">開始＋</button><button type="button" class="btn sm" data-cplay="${n}">▶ 試聴</button>
        <span></span><button type="button" class="btn sm" data-adj="${n}:end:-0.05">終了−</button><button type="button" class="btn sm" data-adj="${n}:end:0.05">終了＋</button><button type="button" class="btn sm primary" data-pick="${n}">この範囲で確定</button></div></div>`; }).join('') || '<div class="muted">候補がありません（スタジオの「音声を割当」で範囲を指定できます）</div>' : ''}
    </div>`;
  };
  const filterOf = f => it => f === 'all' ? true : f === 'open' ? !['confirmed', 'registered'].includes(it.state) : f === 'confirmed' ? it.state === 'confirmed' : f === 'registered' ? it.state === 'registered' : true;
  async function draw() {
    if (closed) return;
    const { summarize } = await import('./vocab-audio-core.js');
    const s = summarize(rec.items, rec.mode);
    const reg = rec.items.filter(x => x.state === 'registered').length, shownItems = rec.items.filter(filterOf(filter));
    const dlg = document.getElementById('dialog');
    const keep = dlg.querySelector('.vw-list')?.scrollTop ?? 0;
    const FILTERS = [['open', `未確定のみ（${rec.items.filter(filterOf('open')).length}）`], ['confirmed', '確定'], ['registered', '登録済み'], ['all', 'すべて']];
    dlg.innerHTML = `<form class="dlg stack vw-form" novalidate><span class="dlg-global-close" hidden></span>
      <div class="jp-head"><h3>${esc(clip(rec.title, 30))}</h3><span class="grow"></span><button type="button" class="btn sm ghost" data-close>閉じる</button></div>
      <p class="small muted">${esc(PROFILES[rec.profile] || '')}${rec.detect?.auto ? '（自動判定）' : '（手動指定）'}・${esc(MODES[rec.mode])}${rec.detect?.reasons?.length ? '・' + esc(rec.detect.reasons.slice(0, 2).join('・')) : ''}</p>
      ${(rec.notes || []).map(n => `<p class="small warn-text">${esc(n)}</p>`).join('')}
      <div class="small vw-counts">全対象 <b>${s.total}</b>語　見出し語の音声確定 <b>${s.wordConfirmed}</b>　例文の音声確定 <b>${s.exampleConfirmed}</b>${rec.mode === 'sentence' ? `　文の音声確定 <b>${s.sentenceConfirmed}</b>` : ''}<br>音声候補あり <b>${s.candidates}</b>　未特定 <b>${s.unresolved}</b>${s.broken ? `　参照切れ <b>${s.broken}</b>` : ''}　登録済み <b>${reg}</b></div>
      <div class="seg wrap" data-filter>${FILTERS.map(([v, l]) => `<button type="button" data-v="${v}" class="${filter === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <div class="vw-list stack">${shownItems.slice(0, shown).map(rowHTML).join('') || '<p class="small muted">該当する語はありません</p>'}${shownItems.length > shown ? `<button type="button" class="btn sm ghost" data-more>さらに表示（残り${shownItems.length - shown}）</button>` : ''}</div>
      <div class="vw-foot stack small"><div id="vwPlan" class="muted">登録の見込みを計算しています…</div>
        <label class="chk"><input type="checkbox" id="vwPartial"> 音声が未確定の語も登録する（音声は後から追加できます）</label>
        <div class="jp-grid"><button type="button" class="btn sm primary" data-register>確定した音声を登録</button><button type="button" class="btn sm" data-again>未確定だけ再処理</button></div>
        <details class="small"><summary class="muted">詳細</summary><button type="button" class="btn sm ghost" data-diag>診断データ（JSON）を書き出す</button><p class="muted small">認識文字列・時刻・発話区間・割り当て先・確信度をまとめます。音声は含みません。精度の確認用です。</p></details></div></form>`;
    const list = dlg.querySelector('.vw-list'); if (list) list.scrollTop = keep;
    planText().then(t => { const el = dlg.querySelector('#vwPlan'); if (el) el.innerHTML = t; });
  }
  const dlg = dialog();
  const ac = new AbortController(), on = { signal: ac.signal };
  const finish = (value = true) => { result = value; closed = true; ac.abort(); import('./word-audio.js').then(m => m.stop()).catch(() => {}); dlg.onclose = null; if (dlg.open) dlg.close(); resolveDone(result); };
  const itemOf = el => rec.items.find(x => x.key === el.closest('[data-key]')?.dataset.key);
  const candRange = (it, n) => { const c = cands(it)[n]; return { c, w: work.get(`${it.key}|${n}`) || { start: c.start, end: c.end } }; };
  dlg.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); }, on);
  dlg.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !dlg.contains(b)) return;
    e.preventDefault();
    const d = b.dataset, it = itemOf(b);
    try {
      if (d.close != null) return finish();
      if (d.v && b.closest('[data-filter]')) { filter = d.v; shown = PAGE; open = null; return draw(); }
      if (d.more != null) { shown += PAGE; return draw(); }
      if (d.open) { open = open === d.open ? null : d.open; return draw(); }
      if (d.play) { const [key, k] = d.play.split('|'), x = rec.items.find(y => y.key === key); const m = await wa(); if (!(await m.playRef(x.refs[k].ref))) toast('録音が見つかりません'); return; }
      if (d.cplay != null && it) { const { c, w } = candRange(it, +d.cplay); (await wa()).playRef({ src: c.src, start: w.start, end: w.end }); return; }
      if (d.adj && it) {
        const [n, edge, delta] = d.adj.split(':'), { w } = candRange(it, +n), v = Math.round((w[edge] + +delta) * 1000) / 1000;
        if (edge === 'start' ? v < 0 || v >= w.end - .1 : v <= w.start + .1) return;
        work.set(`${it.key}|${n}`, { ...w, [edge]: v });
        const t = b.closest('[data-cand]')?.querySelector('[data-time]'), nw = work.get(`${it.key}|${n}`); if (t) t.textContent = `${fmtT(nw.start)}〜${fmtT(nw.end)}`;
        return;
      }
      if (d.pick && it) { const { c, w } = candRange(it, +d.pick); rec = await reviewConfirm(kind, id, it.key, editKinds()[0], { src: c.src, start: w.start, end: w.end }); open = null; toast('確定しました'); return draw(); }
      if (d.clear) { rec = await reviewClear(kind, id, d.clear, editKinds()[0]); toast('参照を外しました（教材・録音は変わりません）'); return draw(); }
      if (d.register != null) {
        const x = await registerRecord(kind, id, { onlyConfirmed: !dlg.querySelector('#vwPartial')?.checked });
        rec = await loadRecord(kind, id);
        toast(`新規 ${x.added}語・既存の語に音声を追加 ${x.updated}語（追加容量 約${fmtSize(x.bytes)}・音声は複製しません）`, 6000);
        return draw();
      }
      if (d.diag != null) {
        const text = JSON.stringify(await buildDiagnostics(kind, id)), name = `vocab-audio-diagnostics-${String(rec.title || id).replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+/g, '_').slice(0, 40)}.json`;
        const file = new File([text], name, { type: 'application/json' });
        if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (error) { if (error?.name === 'AbortError') return; } }
        const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('診断データを書き出しました（音声は含まれません）'); return;
      }
      if (d.again != null) return finish('again');
    } catch (error) { toast(error.message, 5000); }
  }, on);
  dlg.onclose = () => finish(true);
  await draw();
  dlg.showModal();
  return done;
}
