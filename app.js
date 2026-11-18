import { openDB, db, getSetting, setSetting, getMeta, uid, storageInfo, requestPersist, DB_VERSION } from './db.js';
import { exportJSON, exportCSV, validateBackup, restoreBackup, STORE_LABELS } from './backup.js';
import { $, esc, toast, confirmDialog } from './ui.js';
import { vocabList, wordDetail, vocabBulk, vocabCSV, vocabPaste, decksScreen } from './vocab.js';
import { seedIfNeeded, splitSeedIfNeeded } from './words.js';
import { studySetup, sessionScreen, resultScreen } from './study.js';
import { quickSetup, quickRun, quickResult, getSwipe } from './quick.js';
import { videoList, videoPlay } from './video.js';
import { homeScreen, reviewScreen, grammarScreen, comingSoon } from './hub.js';
import { icon } from './icons.js';

export const APP_VERSION = '0.8.1';

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
async function applyTheme(mode) {
  mode = mode || await getSetting('theme', 'dark');
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#121418' : '#f3f4f6');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

// ---------- Screens ----------
const screens = {};

screens.home = homeScreen;
screens.review = reviewScreen;
screens.log = reviewScreen;
screens.grammar = grammarScreen;
screens.toeic = grammarScreen;
screens.listening = comingSoon('リスニング', 'headphones', '短い英文を聞いて内容を答える練習は、まだ実装していません。');
screens.speaking = comingSoon('瞬間英作文', 'mic', '日本語から英語を組み立てる練習は、まだ実装していません。');
screens.import = comingSoon('Import', 'import', '画像やスクリーンショットから英語を取り込む機能は、まだ実装していません。今は単語帳の「まとめて追加」「CSV」「英文から選ぶ」が使えます。');
Object.assign(screens, { quick: quickSetup, 'quick-run': quickRun, 'quick-result': quickResult, video: videoList, 'video-play': videoPlay, study: studySetup, session: sessionScreen, result: resultScreen, vocab: vocabList, word: wordDetail, 'vocab-bulk': vocabBulk, 'vocab-csv': vocabCSV, 'vocab-paste': vocabPaste, decks: decksScreen });
const TAB_OF = { log: 'review', grammar: 'home', toeic: 'home', listening: 'home', speaking: 'home', import: 'home', quick: 'study', 'quick-run': 'study', 'quick-result': 'study', video: 'home', 'video-play': 'home', session: 'study', result: 'study', word: 'vocab', 'vocab-bulk': 'vocab', 'vocab-csv': 'vocab', 'vocab-paste': 'vocab', decks: 'vocab' };

screens.settings = async (el) => {
  const theme = await getSetting('theme', 'dark');
  const swipe = await getSwipe();
  const lastBackup = await getMeta('lastBackupAt', null);
  const st = await storageInfo();
  const counts = {};
  for (const n of ['words', 'attempts', 'sessions', 'videos']) counts[n] = await db.count(n);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  el.innerHTML = `
    <header class="top"><h1>設定</h1></header>

    <h2 class="sec">表示</h2>
    <div class="card">
      <div class="seg" id="theme">
        ${[['dark', 'ダーク'], ['light', 'ライト'], ['system', '端末に合わせる']].map(([v, l]) => `<button data-v="${v}" class="${theme === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
    </div>

    <h2 class="sec">Quick Flashcards</h2>
    <div class="card stack"><span class="small muted">スワイプの左右（↑は常に「曖昧」。単語テストのカードにも適用）</span>
      <div class="seg" id="swipe">${[['right', '右＝わかる'], ['left', '左＝わかる']].map(([v, l]) => `<button data-v="${v}" class="${swipe === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>

    <h2 class="sec">バックアップ</h2>
    <div class="card stack">
      <p class="muted">最終バックアップ: ${fmtDate(lastBackup)}</p>
      <button class="btn primary" id="bk-json">JSONバックアップを保存</button>
      <p class="hint">共有シートが開いたら「"ファイル"に保存」→ iCloud Drive を選ぶと安全です。動画ファイル本体は含まれません（字幕は含まれます）。</p>
      <label class="btn" for="bk-file">バックアップから復元</label>
      <input type="file" id="bk-file" accept=".json,application/json" hidden>
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
      <button class="btn" id="sample">テスト用サンプル単語を追加</button>
      <button class="btn danger" id="wipe">すべてのデータを削除</button>
    </div>

    <p class="muted center small">v${APP_VERSION} / DB schema v${DB_VERSION}</p>`;

  $('#theme', el).addEventListener('click', async (e) => {
    const v = e.target.dataset.v; if (!v) return;
    await setSetting('theme', v); await applyTheme(v); render();
  });
  $('#swipe', el).addEventListener('click', async (e) => { const v = e.target.dataset.v; if (!v) return; await setSetting('swipeKnow', v); toast('スワイプの向きを変更しました'); render(); });
  $('#bk-json', el).onclick = async () => {
    try { const r = await exportJSON(); if (r !== 'cancelled') { toast('バックアップを作成しました'); render(); } }
    catch (e) { toast('失敗: ' + e.message); }
  };
  $('#bk-csv', el).onclick = async () => { try { await exportCSV(); } catch (e) { toast('失敗: ' + e.message); } };
  $('#bk-file', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await f.text()); } catch { return toast('JSONとして読み込めませんでした'); }
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
    try { await restoreBackup(v.backup); toast('復元しました'); render(); }
    catch (err) { toast('復元に失敗: ' + err.message); }
  };
  $('#persist', el)?.addEventListener('click', async () => {
    const r = await requestPersist();
    toast(r ? 'データ保護が有効になりました' : 'iPhoneでは、ホーム画面から起動して使い続けると保護されやすくなります');
    render();
  });
  $('#sample', el).onclick = async () => { await addSampleWords(); toast('サンプル単語を追加しました'); render(); };
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
function currentRoute() { return (location.hash.slice(1) || 'home').split('?')[0]; }
function currentParams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }

async function render() {
  const route = screens[currentRoute()] ? currentRoute() : 'home';
  const main = $('#main');
  try { await screens[route](main, currentParams()); }
  catch (e) { main.innerHTML = `<div class="card warn">エラー: ${esc(e.message)}</div>`; console.error(e); }
  document.body.classList.toggle('focus', ['session', 'quick-run'].includes(route));
  const tab = TAB_OF[route] || route;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.route === tab));
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => `<a href="#${t.route}" data-route="${t.route}">${icon(t.icon, 24)}<small>${t.label}</small></a>`).join('');
}

async function boot() {
  try { await openDB(); }
  catch (e) { $('#main').innerHTML = `<div class="card warn">データベースを開けません: ${esc(e.message)}<br>プライベートブラウズでは保存できません。</div>`; return; }
  await applyTheme();
  try { const n = await seedIfNeeded(); if (n) setTimeout(() => toast(`初期単語${n}語を追加しました（苦手として登録）`, 4000), 300); } catch (e) { console.error('seed', e); }
  try { const n = await splitSeedIfNeeded(); if (n) setTimeout(() => toast(`多義語を意味ごとに分け、${n}項目を追加しました`, 4500), 4600); } catch (e) { console.error('split', e); }
  renderTabs();
  addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
  await render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
  }
  // ask for persistence silently once installed to home screen
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) requestPersist();
}

boot();
