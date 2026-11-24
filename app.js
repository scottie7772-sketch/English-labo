import { openDB, db, getSetting, setSetting, getMeta, setMeta, uid, storageInfo, requestPersist, DB_VERSION } from './db.js';
import { $, esc, toast, confirmDialog } from './ui.js';
import { seedIfNeeded, splitSeedIfNeeded } from './words.js';
import { homeScreen, reviewScreen, grammarScreen, comingSoon } from './hub.js';
import { loadLang, setLang, langSwitchHTML, enabledLangs, setEnabled, LANGS } from './langs.js';
import { seedContent } from './content.js';
import { icon } from './icons.js';
import { showUpdate, initUpdate, releaseLabel } from './update-manager.js';
import { APP_VERSION, BUILD_LABEL } from './app-version.js';


const TABS = [
  { route: 'home', icon: 'home', label: 'ホーム' },
  { route: 'vocab', icon: 'book', label: '単語' },
  { route: 'study', icon: 'cards', label: '学習' },
  { route: 'review', icon: 'review', label: '復習' },
  { route: 'settings', icon: 'gear', label: '設定' },
];

function fmtBytes(n) {
  if (n == null) return '不明';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function daysSince(ts) { return ts ? Math.floor((Date.now() - ts) / 86400000) : null; }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }

// ---------- Theme ----------
// 1.16: dark only, one colour set (light mode and the forest set were removed to keep the app small)
async function applyTheme() {
  document.documentElement.dataset.theme = 'dark';
  $('meta[name=theme-color]')?.setAttribute('content', '#1e2236');
}


// ---------- Screens ----------
const screens = {};

screens.home = homeScreen;
screens.review = reviewScreen;
screens.log = reviewScreen;
screens.grammar = grammarScreen;
screens.toeic = grammarScreen;
screens.import = comingSoon('Import', 'import', '画像やスクリーンショットから英語を取り込む機能は、まだ実装していません。今は単語帳の「まとめて追加」「CSV」「英文から選ぶ」が使えます。');
const TAB_OF = { storage: 'settings', course: 'home', 'course-unit': 'home', 'course-puzzle': 'home', datacheck: 'settings', 'listening-run': 'home', 'speaking-run': 'home', lesson: 'home', 'lesson-run': 'home', games: 'home', game: 'home', log: 'review', grammar: 'home', toeic: 'home', listening: 'home', speaking: 'home', import: 'home', quick: 'study', 'quick-run': 'study', 'quick-result': 'study', video: 'home', 'video-play': 'home', session: 'study', result: 'study', word: 'vocab', 'vocab-bulk': 'vocab', 'vocab-csv': 'vocab', 'vocab-paste': 'vocab', 'ma-phrases': 'vocab', decks: 'vocab' };
// the other screens: their code is loaded the first time they are opened (then kept by the browser)
const LAZY = {
  './ma-phrases-ui.js': { 'ma-phrases': 'maImportScreen' },
  './vocab.js': { vocab: 'vocabList', word: 'wordDetail', 'vocab-bulk': 'vocabBulk', 'vocab-csv': 'vocabCSV', 'vocab-paste': 'vocabPaste', decks: 'decksScreen' },
  './study.js': { study: 'studySetup', session: 'sessionScreen', result: 'resultScreen' },
  './quick.js': { quick: 'quickSetup', 'quick-run': 'quickRun', 'quick-result': 'quickResult' },
  './video.js': { video: 'videoList', 'video-play': 'videoPlay' },
  './speaking.js': { speaking: 'speakingScreen', 'speaking-run': 'speakingRun' },
  './listening.js': { listening: 'listeningScreen', 'listening-run': 'listeningRun' },
  './lesson.js': { lesson: 'lessonScreen', 'lesson-run': 'lessonRun' },
  './games.js': { games: 'gamesScreen', game: 'gameRun' },
  './datacheck.js': { datacheck: 'dataCheckScreen' },
  './storage.js': { storage: 'storageScreen' },
  './course.js': { course: 'courseScreen', 'course-unit': 'courseUnit', 'course-puzzle': 'coursePuzzle' },
};
for (const [file, map] of Object.entries(LAZY)) for (const [route, fn] of Object.entries(map)) screens[route] = async (el, params) => (await import(file))[fn](el, params);

screens.settings = async (el) => {
  const [{ getSwipe }, { exportJSON, exportCSV, validateBackup, restoreBackup, STORE_LABELS, buildFullBackupZip, readFullBackupZip, restoreFullBackup, saveFileNow }] = await Promise.all([import('./quick.js'), import('./backup.js')]);
  const swipe = await getSwipe();
  const lastBackup = await getMeta('lastBackupAt', null);
  const st = await storageInfo();
  const counts = {};
  for (const n of ['words', 'attempts', 'sessions', 'videos']) counts[n] = await db.count(n);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  el.innerHTML = `
    <header class="top"><h1>設定</h1></header>
    <div class="card stack"><button class="btn" id="appUpdate">アプリの更新を確認</button></div>

    <h2 class="sec">学習する言語</h2>
    <div class="card stack"><span class="small muted">使う言語（画面上部の EN / ES / 華 で切り替え）。言語ごとに単語・習得度・復習予定は別々に管理されます。</span>
      <div class="chips" id="langs">${Object.values(LANGS).map((l) => `<button data-v="${l.code}" class="${enabledLangs().includes(l.code) ? 'on' : ''}" ${l.code === 'en' ? 'disabled' : ''}>${l.name}</button>`).join('')}</div>
      <p class="hint">スペイン語は中南米（メキシコ）基準。華語は繁体字・ピンイン。初期の単語・問題はAI作成で未検証です。読み上げは端末に入っている声を使います（設定 → アクセシビリティ → 読み上げコンテンツ → 声 で追加できます）。</p></div>

    <h2 class="sec">フラッシュカード</h2>
    <div class="card stack"><span class="small muted">スワイプの向き（単語テストのカードにも適用）。上下（片手）＝↑わかる ↓わからない →後回し（記録しない）。右・左＝わかる側、↑は曖昧</span>
      <div class="seg" id="swipe">${[['up', '上下（片手）'], ['right', '右＝わかる'], ['left', '左＝わかる']].map(([v, l]) => `<button data-v="${v}" class="${swipe === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>

    <div class="card stack"><label class="chk"><input type="checkbox" id="fcOrig" ${(() => { try { return localStorage.getItem('fc-orig') !== '0'; } catch { return true; } })() ? 'checked' : ''}> カードの音声に元の録音を使う</label>
      ${(() => { const f = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
        return `<label class="chk"><input type="checkbox" id="fcAuto" ${f('fc-auto', true) ? 'checked' : ''}> カードを出したら単語の音声を自動再生</label>
      <label class="chk"><input type="checkbox" id="fcSeq" ${f('fc-seq', false) ? 'checked' : ''}> 自動再生で単語→例文を続けて再生（例文の音声がある単語）</label>
      <label class="chk"><input type="checkbox" id="fcListenEn" ${f('fc-listen-en', false) ? 'checked' : ''}> 音声→意味のカードで、再生後に英文を表示</label>`; })()}
      <p class="hint">教材スタジオで照合した行・動画ラボの字幕に同じ単語・例文があれば、その部分の録音を再生します（出元にかかわらず同じ音声）。無い単語は読み上げ音声です。</p></div>

    <h2 class="sec">バックアップ</h2>
    <div class="card stack">
      <p class="muted">最終バックアップ: ${fmtDate(lastBackup)}</p>
      <button class="btn primary" id="bk-full">音声・動画つき完全バックアップ（ZIP）を作る</button>
      <p class="hint" id="bk-full-st">教材（字幕・日本語訳）と音声・動画ファイルをまとめて1つのZIPにします。1回目のタップで準備、2回目のタップで共有シートが開くので「"ファイル"に保存」を選んでください。</p>
      <button class="btn" id="bk-json">JSONバックアップを保存（軽量・音声なし）</button>
      <p class="hint">共有シートが開いたら「"ファイル"に保存」→ iCloud Drive を選ぶと安全です。JSONには動画・音声ファイル本体は含まれません（字幕は含まれます）。</p>
      <label class="btn" for="bk-file">バックアップから復元（JSON / ZIP）</label>
      <input type="file" id="bk-file" accept=".json,.zip,application/json,application/zip" hidden>
      <button class="btn" id="bk-csv">単語一覧をCSVで書き出し</button>
    </div>

    <h2 class="sec">データ</h2>
    <div class="card stack">
      <div class="kv"><span>単語</span><b>${counts.words}</b></div>
      <div class="kv"><span>回答記録</span><b>${counts.attempts}</b></div>
      <div class="kv"><span>セッション</span><b>${counts.sessions}</b></div>
      <div class="kv"><span>動画</span><b>${counts.videos}</b></div>
      <div class="kv"><span>使用容量</span><b>${fmtBytes(st.usage)}</b></div>
      <div class="kv"><span>保護（自動削除対象外）</span><b>${st.persisted == null ? '不明' : st.persisted ? '✅ 有効' : '未設定'}</b></div>
      <div class="kv"><span>ホーム画面から起動</span><b>${standalone ? '✅' : 'いいえ（Safariで表示中）'}</b></div>
      ${st.persisted ? '' : '<button class="btn" id="persist">データ保護をリクエスト</button>'}
      <a class="btn" href="#datacheck">データ点検（列のずれ・重複の確認）</a>
      <a class="btn" href="#storage">容量の整理（キャッシュ・動画の削除）</a>
      <button class="btn" id="sample">テスト用サンプル単語を追加</button>
      <button class="btn danger" id="wipeMedia">動画・音声・リスニングを一括削除（単語は残す）</button>
      <button class="btn danger" id="wipe">すべてのデータを削除</button>
    </div>

    <p class="muted center small">Englabo v${APP_VERSION} · ${BUILD_LABEL} / DB schema v${DB_VERSION}<br><span id="relInfo"></span></p>`;
  releaseLabel().then((t) => { const n = $('#relInfo', el); if (n) n.textContent = t; });

  $('#appUpdate', el).onclick = showUpdate;
  $('#langs', el).onclick = async (e) => { const v = e.target.dataset.v; if (!v || v === 'en') return; const cur = enabledLangs().filter((c) => c !== 'en'); await setEnabled(cur.includes(v) ? cur.filter((c) => c !== v) : [...cur, v]); render(); };
  $('#swipe', el).addEventListener('click', async (e) => { const v = e.target.dataset.v; if (!v) return; await setSetting('swipeKnow', v); toast('スワイプの向きを変更しました'); render(); });
  // 1.19.31: word-card sound settings (stored on this device)
  for (const [id, key] of [['fcAuto', 'fc-auto'], ['fcSeq', 'fc-seq'], ['fcListenEn', 'fc-listen-en']]) $('#' + id, el)?.addEventListener('change', (e) => { try { localStorage.setItem(key, e.target.checked ? '1' : '0'); } catch {} });
  $('#fcOrig', el)?.addEventListener('change', (e) => { try { localStorage.setItem('fc-orig', e.target.checked ? '1' : '0'); } catch {} toast(e.target.checked ? '元の録音を使います' : '読み上げ音声だけにします'); });
  $('#bk-json', el).onclick = async () => {
    try { const r = await exportJSON(); if (r !== 'cancelled') { toast('バックアップを作成しました'); render(); } }
    catch (e) { toast('失敗: ' + e.message); }
  };
  // 1.19.33: full backup. Tap 1 builds the ZIP in memory; tap 2 opens the share sheet right inside the tap (iPhone requirement).
  let preparedZip = null;
  $('#bk-full', el).onclick = async (e) => {
    const btn = e.currentTarget, status = $('#bk-full-st', el);
    if (preparedZip) {
      const file = preparedZip;
      const r = await saveFileNow(file);   // no await before this line
      if (r === 'cancelled') { status.textContent = '保存をキャンセルしました。もう一度タップすると共有シートを開きます。'; return; }
      preparedZip = null; btn.textContent = '音声・動画つき完全バックアップ（ZIP）を作る';
      await setMeta('lastBackupAt', Date.now());
      status.textContent = (r === 'shared' ? '共有しました: ' : 'ダウンロードしました: ') + file.name + '（「ファイル」アプリで確認してください）';
      return;
    }
    btn.disabled = true;
    try {
      const out = await buildFullBackupZip((p) => {
        status.textContent = p.phase === 'read' ? `音声・動画を読み込み中… ${p.done}/${p.total}` : `ZIPを作成中… ${Math.floor((p.fraction || 0) * 100)}%`;
      });
      preparedZip = out.file;
      btn.textContent = `ファイルに保存（${fmtBytes(out.file.size)}）をタップ`;
      status.textContent = `準備完了: 音声・動画 ${out.mediaCount}件。もう一度ボタンをタップすると共有シートが開きます。`;
    } catch (err) { status.textContent = '失敗: ' + err.message; }
    finally { btn.disabled = false; }
  };
  $('#bk-csv', el).onclick = async () => { try { await exportCSV(); } catch (e) { toast('失敗: ' + e.message); } };
  $('#bk-file', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let obj, full = null;
    if (/\.zip$/i.test(f.name)) {
      try { full = await readFullBackupZip(f); obj = full.backup; } catch (err) { return toast('ZIPを読み込めませんでした: ' + err.message); }
    } else {
      try { obj = JSON.parse(await f.text()); } catch { return toast('JSONとして読み込めませんでした'); }
    }
    const v = validateBackup(obj);
    if (!v.ok) {
      return confirmDialog({ title: '復元できません', body: `<ul class="errs">${v.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, okLabel: '閉じる' });
    }
    const rows = Object.entries(v.summary).filter(([, n]) => n > 0).map(([k, n]) => `<div class="kv"><span>${STORE_LABELS[k] || k}</span><b>${n}</b></div>`).join('') || '<p class="muted">（空のバックアップ）</p>';
    const ok = await confirmDialog({
      title: 'このバックアップで置き換えますか？',
      body: `<p class="muted">作成日時: ${esc(new Date(obj.exportedAt).toLocaleString('ja-JP'))}</p>${rows}
             <p class="warn-text">現在のデータはすべて置き換えられます。不安なら先に今のデータをバックアップしてください。</p>`,
      okLabel: '置き換える', danger: true,
    });
    if (!ok) return;
    try {
      if (full) {
        const r = await restoreFullBackup(full, (p) => toast(`音声・動画を復元中… ${p.done}/${p.total}`, 4000));
        toast(r.failed.length ? `復元しました（音声・動画 ${r.failed.length}件は戻せませんでした）` : `復元しました（音声・動画 ${r.restored}件）`);
      } else { await restoreBackup(v.backup); toast('復元しました'); }
      render();
    }
    catch (err) { toast('復元に失敗: ' + err.message); }
  };
  $('#persist', el)?.addEventListener('click', async () => {
    const r = await requestPersist();
    toast(r ? 'データ保護が有効になりました' : 'iPhoneでは、ホーム画面から起動して使い続けると保護されやすくなります');
    render();
  });
  $('#sample', el).onclick = async () => { await addSampleWords(); toast('サンプル単語を追加しました'); render(); };
  $('#wipeMedia', el).onclick = async () => {
    const ok = await confirmDialog({ title: '動画・音声・リスニングを削除', body: '<p>動画ラボの動画・音声・字幕・穴埋めと、リスニングの問題の記録を消します。<b>単語・習得度・復習予定・ゲームは残ります</b>（動画から登録した単語も残り、動画へのリンクだけ外れます）。元に戻せません。</p>', okLabel: '削除', danger: true, requireText: '削除' });
    if (!ok) return;
    const wordIds = new Set((await db.all('words')).map((w) => w.id));
    const notWord = (id) => !wordIds.has(id);
    await (await import('./studio-db.js')).releaseLabRefs(null).catch(() => 0);   // studio sets keep their own copy of the sounds
    // 1.19.31: recordings that word cards use are kept (単語帳の音声; 容量の整理 shows and removes them)
    const { referencedMedia } = await import('./audio-refs.js');
    const keepAudio = (await referencedMedia()).vblobs;
    for (const key of await db.keys('vblobs')) if (!keepAudio.has(key)) await db.delete('vblobs', key);
    await db.clear('cues'); await db.clear('videos'); await db.clear('listening');
    const atts = (await db.all('attempts')).filter((a) => (a.mode === 'listening' || a.mode === 'video') && notWord(a.wordId));
    for (const a of atts) await db.delete('attempts', a.id);
    const gone = new Set(atts.map((a) => a.wordId));
    for (const m of await db.all('mastery')) if (notWord(m.wordId) && (gone.has(m.wordId) || String(m.wordId).startsWith('cz_'))) await db.delete('mastery', m.id);
    for (const r of await db.all('reviews')) if (notWord(r.id) && (r.kind === 'listening' || gone.has(r.id) || String(r.id).startsWith('cz_'))) await db.delete('reviews', r.id);
    for (const w of await db.all('words')) if (w.videoRefs?.length) { w.videoRefs = []; await db.put('words', w); }
    toast('削除しました'); render();
  };
  $('#wipe', el).onclick = async () => {
    const ok = await confirmDialog({ title: 'すべてのデータを削除', body: '<p>単語・学習記録・動画などすべて消えます。元に戻せません。</p>', okLabel: '削除', danger: true, requireText: '削除' });
    if (!ok) return;
    const { STORES } = await import('./db.js');
    for (const n of Object.keys(STORES)) await db.clear(n);
    toast('削除しました'); render();
  };
};

async function addSampleWords() {
  const now = Date.now();
  const samples = [
    ['take over', true, 'phrasal verb', ['引き継ぐ', '乗っ取る'], 'She will take over the project next month.', '彼女が来月そのプロジェクトを引き継ぐ。'],
    ['postpone', false, 'verb', ['延期する'], 'The meeting was postponed until Friday.', '会議は金曜日まで延期された。'],
    ['in advance', true, 'adverb phrase', ['前もって', '事前に'], 'Please register in advance.', '事前に登録してください。'],
  ];
  const words = samples.map(([h, ph, pos, ms, en, ja]) => ({
    id: uid('w_'), headword: h, isPhrase: ph, ipa: '',
    senses: [{ id: uid('s_'), pos, meanings: ms, accepted: [], context: '', examples: [{ en, ja }] }],
    tags: ['sample'], deckIds: [], bookmarked: false, bookmarkedNum: 0,
    source: { type: 'manual' }, createdAt: now, updatedAt: now,
  }));
  await db.putMany('words', words);
}

// ---------- Router ----------
function currentRoute() { const r = (location.hash.slice(1) || 'home').split('?')[0]; return r.startsWith('studio') ? 'studio' : r; }
function currentParams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }

let studioMod = null;
// 教材スタジオ inside the app: loaded only when opened (no weight for the other screens)
screens.studio = async (el) => {
  if (!document.querySelector('link[data-studio]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'studio.css'; l.dataset.studio = '1'; document.head.appendChild(l); }
  studioMod ||= await import('./studio-main.js');
  const { importMaterial, studioLabState, syncStudioLabFolder } = await import('./video.js');
  studioMod.mount(el, { base: 'studio/', host: { exitHref: '#home', sendToLab: (manifest, mat, getFile, options) => importMaterial(manifest, mat, getFile, { askUpdate: false, direct: true, ...options }),
    studioLabState, syncStudioLabFolder,
    addWordsCsv: (text, deck, note) => { try { sessionStorage.setItem('ell-pending-csv', JSON.stringify({ text, deck, note })); } catch {} location.hash = '#vocab-csv'; } } });
};
async function render() {
  const route = screens[currentRoute()] ? currentRoute() : 'home';
  if (route !== 'studio') studioMod?.unmount();
  document.body.classList.remove('vtyping');
  const main = $('#main');
  // Apply the destination palette before any asynchronous screen work. Otherwise
  // the old amber/blue palette can flash during navigation on slower iPads.
  document.body.dataset.zone = ['home', 'vocab', 'word', 'decks', 'vocab-bulk', 'vocab-csv', 'vocab-paste', 'datacheck', 'storage', 'review', 'log', 'settings'].includes(route) ? 'brown' : '';
  document.body.classList.toggle('studio', route === 'studio');   // same layout rules as studio.html (body.studio in studio.css)
  document.body.classList.toggle('focus', ['session', 'quick-run', 'speaking-run', 'listening-run', 'lesson-run', 'game', 'course-puzzle', 'studio', 'video-play'].includes(route));
  try { await screens[route](main, currentParams()); }
  catch (e) { main.innerHTML = `<div class="card warn">エラー: ${esc(e.message)}</div>`; console.error(e); }
  // language switch in the header of screens that depend on the learning language
  if (['home', 'vocab', 'study', 'quick', 'review', 'lesson', 'speaking', 'listening', 'games', 'course'].includes(route)) {
    const h = main.querySelector('header.top');
    if (h && !h.querySelector('.langsw')) { const tmp = document.createElement('div'); tmp.innerHTML = langSwitchHTML(); const sw = tmp.firstElementChild; if (sw) { const grow = h.querySelector('.grow'); grow ? grow.after(sw) : h.appendChild(sw); } }
  }
  const tab = TAB_OF[route] || route;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.route === tab));
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => `<a href="#${t.route}" data-route="${t.route}">${icon(t.icon, 24)}<small>${t.label}</small></a>`).join('');
}

async function boot() {
  document.addEventListener('gesturestart', (e) => e.preventDefault());   // no pinch zoom (iOS)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}   // keep sound with the silent switch on, also after Web Audio was used
  document.addEventListener('pointerdown', () => { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} }, { capture: true, passive: true });   // again inside a real tap (iOS may ignore it at start-up)
  try { await openDB(); }
  catch (e) { $('#main').innerHTML = `<div class="card warn">データベースを開けません: ${esc(e.message)}<br>プライベートブラウズでは保存できません。</div>`; return; }
  await applyTheme();
  try { const n = await seedIfNeeded(); if (n) setTimeout(() => toast(`初期単語${n}語を追加しました（苦手として登録）`, 4000), 300); } catch (e) { console.error('seed', e); }
  try { const n = await splitSeedIfNeeded(); if (n) setTimeout(() => toast(`多義語を意味ごとに分け、${n}項目を追加しました`, 4500), 4600); } catch (e) { console.error('split', e); }
  // 1.12: one-handed swipe (↑わかる ↓わからない →後回し) becomes the setting once; the old directions stay selectable
  if (!(await getSetting('swipe:v112', false))) { await setSetting('swipeKnow', 'up'); await setSetting('swipe:v112', true); }
  await loadLang();
  seedContent().then((n) => { if (n) { toast(`教材の単語${n}語を追加しました（AI作成・未検証）`, 3500); if (['home', 'vocab'].includes(currentRoute())) render(); } }).catch((e) => console.error('content', e));
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-langsw]'); if (!b) return;
    await setLang(b.dataset.langsw); render();
  });
  renderTabs();
  addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
  await render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    initUpdate();
  }
  // ask for persistence silently once installed to home screen
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) requestPersist();
}

boot();
