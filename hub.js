// Home / Review / Progress / Grammar hub screens (v0.8). Only real data is shown; unimplemented parts say 「準備中」.
import { db, getMeta } from './db.js';
import { $, esc, go } from './ui.js';
import { icon } from './icons.js';
import { overall, filterLevel, LEVEL_LABELS, loadAllMastery } from './mastery.js';
import { startTest } from './study.js';
import { startQuick } from './quick.js';
import { curLang, langOf, L } from './langs.js';
import { lessonStats, streakDays } from './lesson.js';

const DAY = 86400000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const meaningsOf = (w) => (w.senses || []).flatMap((s) => s.meanings || []);

// ---- progress definitions (shown on screen) ----
// 未学習：このアプリで一度も回答していない
// 学習中：回答したことがあり、総合習得度が Level 3 以下（判定保留を含む）
// 習得  ：総合習得度が Level 4（ほぼ習得）以上
function stageOf(records) {
  const answered = Object.values(records || {}).some((m) => m?.stats?.attempts > 0);
  if (!answered) return 'new';
  return overall(records).level >= 4 ? 'done' : 'learning';
}
export async function collectStats() {
  const [words0, mastery, attempts, sessions0, decks] = await Promise.all([db.all('words'), loadAllMastery(), db.all('attempts'), db.all('sessions'), db.all('decks')]);
  const lang = curLang();
  const words = words0.filter((w) => langOf(w) === lang);
  const sessions = sessions0.filter((s) => (s.lang || 'en') === lang);
  const today = startOfToday(), weekAgo = Date.now() - 7 * DAY;
  const weak = words.filter((w) => filterLevel(overall(mastery[w.id]).level) <= 2);
  const recentWrongIds = new Set(attempts.filter((a) => !a.correct && a.at >= weekAgo).map((a) => a.wordId));
  const recentWrong = words.filter((w) => recentWrongIds.has(w.id));
  const week = attempts.filter((a) => a.at >= weekAgo);
  const days = new Set(attempts.map((a) => new Date(a.at).toDateString()));
  const totalMs = sessions.reduce((t, s) => t + (s.mode === 'quick' ? (s.elapsedMs || 0) : (s.activeMs || 0)), 0);
  const range = (list) => {
    const c = { new: 0, learning: 0, done: 0 };
    list.forEach((w) => c[stageOf(mastery[w.id])]++);
    return { ...c, total: list.length };
  };
  return {
    words, mastery, attempts, sessions, decks, weak, recentWrong,
    bookmarked: words.filter((w) => w.bookmarked),
    todayCount: attempts.filter((a) => a.at >= today).length,
    weekAcc: week.length ? Math.round((week.filter((a) => a.correct).length / week.length) * 100) : null,
    weekCount: week.length, studyDays: days.size, totalMs,
    lastStudy: attempts.length ? Math.max(...attempts.map((a) => a.at)) : null,
    all: range(words),
    byDeck: decks.map((d) => ({ name: d.name, ...range(words.filter((w) => (w.deckIds || []).includes(d.id))) })).filter((r) => r.total),
    byTag: [...new Set(words.flatMap((w) => w.tags || []))].map((t) => ({ name: t, ...range(words.filter((w) => (w.tags || []).includes(t))) })).filter((r) => r.total).sort((a, b) => b.total - a.total).slice(0, 6),
  };
}

function progBar(r) {
  const pct = (n) => (r.total ? (n / r.total) * 100 : 0);
  return `<div class="pbar" role="img" aria-label="習得${r.done}・学習中${r.learning}・未学習${r.new}">
      <i class="p-done" style="width:${pct(r.done)}%"></i><i class="p-learn" style="width:${pct(r.learning)}%"></i></div>
    <div class="plegend"><span><i class="dot p-done"></i>習得 ${r.done}</span><span><i class="dot p-learn"></i>学習中 ${r.learning}</span><span><i class="dot p-new"></i>未学習 ${r.new}</span></div>`;
}
const fmtMin = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}秒` : ms < 3600000 ? `${Math.round(ms / 60000)}分` : `${(ms / 3600000).toFixed(1)}時間`);
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '—');

// ================= Home =================
export async function homeScreen(el) {
  const st = await collectStats();
  const ls = await lessonStats();
  const sk = await streakDays();
  const lastBackup = await getMeta('lastBackupAt', null);
  const bd = lastBackup ? Math.floor((Date.now() - lastBackup) / DAY) : null;
  const backupWarn = st.words.length > 0 && (bd == null || bd >= 7);
  const actives = st.sessions.filter((s) => s.status === 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  const test = actives.find((s) => s.mode !== 'quick'), quick = actives.find((s) => s.mode === 'quick');
  const left = (s) => s.queue.filter((q) => !s.answered[q.qid]).length;
  const item = (href, ic, name, sub, soon) => `<a class="mitem ${soon ? 'soon' : ''}" href="${href}">${icon(ic, 22)}<span class="grow"><b>${name}</b><small>${sub}</small></span>${soon ? '<em>準備中</em>' : ''}</a>`;

  el.innerHTML = `
    <header class="top"><h1>English Labo</h1><span class="grow"></span><a class="icon-btn" href="#settings" aria-label="設定">${icon('gear', 24)}</a></header>
    ${backupWarn ? `<a class="notice warn" href="#settings">${icon('warn', 18)}<span>${bd == null ? 'まだバックアップがありません' : `最終バックアップから${bd}日`}。設定から保存できます</span></a>` : ''}

    <section class="kpis">
      <div class="kpi"><b>${st.words.length}</b><span>登録語数</span></div>
      <div class="kpi"><b class="c-review">${st.weak.length}</b><span>苦手・未習得</span></div>
      <div class="kpi"><b>${icon('flame', 18)} ${sk.n}</b><span>連続日数${sk.today ? '' : '（今日まだ）'}</span></div>
    </section>

    <section class="actions">
      ${test ? `<a class="action resume" href="#session?id=${test.id}">${icon('play', 20)}<span class="grow"><b>前回の続きから</b><small>単語テスト 残り${left(test)}問</small></span>${icon('chevron', 18)}</a>` : ''}
      ${quick ? `<a class="action resume" href="#quick-run?id=${quick.id}">${icon('play', 20)}<span class="grow"><b>単語帳の続きから</b><small>${Object.keys(quick.answered || {}).length}枚済み</small></span>${icon('chevron', 18)}</a>` : ''}
      <a class="action primary" href="#lesson">${icon('lesson', 20)}<span class="grow"><b>今日のレッスン</b><small>${ls.due ? `復習 ${ls.due}件` : '復習なし'}・未学習 ${ls.fresh}語</small></span>${icon('chevron', 18)}</a>
      <button class="action" id="goWeak" ${st.weak.length ? '' : 'disabled'}>${icon('review', 20)}<span class="grow"><b>苦手を復習</b><small>${st.weak.length ? `苦手・未習得 ${st.weak.length}語（前回の出題方法で）` : '現在復習する単語はありません'}</small></span>${icon('chevron', 18)}</button>
    </section>

    <h2 class="sec">学習</h2>
    <nav class="menu">
      ${item('#study', 'cards', '単語テスト', '4択・カード・タイピング')}
      ${item('#quick', 'bolt', '単語帳（カード）', 'スワイプで確認・リピート')}
      ${item('#listening', 'headphones', 'リスニング', '短文・会話の聞き取り')}
      ${item('#speaking', 'mic', '瞬間作文', `日本語から${L().name}`)}
      ${item('#games', 'puzzle', 'ゲーム', 'パズル・Verb Swipe・前置詞の図解')}
      ${item('#video', 'video', 'Video Lab', '動画と字幕')}
      ${item('#grammar', 'grammar', '文法', '単元一覧', true)}
    </nav>
    <h2 class="sec">単語・復習</h2>
    <nav class="menu">
      ${item('#vocab', 'book', '単語リスト', `${st.words.length}語・追加と編集`)}
      ${item('#review', 'review', '復習・記録', '苦手・誤答・履歴・進捗')}
    </nav>

    <h2 class="sec">学習の進み具合</h2>
    <a class="card progcard" href="#review">${progBar(st.all)}</a>

    <details class="card more"><summary>その他の機能</summary>
      <nav class="menu flat">
        ${item('#import', 'import', 'Import', '画像から文字を取り込み', true)}
      </nav>
    </details>`;
  $('#goWeak', el)?.addEventListener('click', () => startTest({ levels: [1, 2], bookmarkedOnly: false, recentWrong: false, phraseOnly: false, lowAcc: false, tag: '', deck: '', count: 'all' }));
}

// ================= Review =================
export async function reviewScreen(el) {
  const st = await collectStats();
  const preview = (list) => list.slice(0, 4).map((w) => `<a class="mini" href="#word?id=${w.id}"><b>${esc(w.headword)}</b><span>${esc(meaningsOf(w).join('、'))}</span></a>`).join('');
  const group = (id, ic, title, list, note) => list.length ? `
    <section class="card rgroup">
      <div class="rhead">${icon(ic, 20)}<b class="grow">${title}</b><span class="count">${list.length}</span></div>
      ${note ? `<p class="hint">${note}</p>` : ''}
      <div class="minis">${preview(list)}${list.length > 4 ? `<span class="small muted">ほか ${list.length - 4}語</span>` : ''}</div>
      <div class="row"><button class="btn grow" data-go="${id}:test">テスト</button><button class="btn grow" data-go="${id}:quick">${icon('cards', 16)} 単語帳</button></div>
    </section>` : '';
  const sessions = st.sessions.filter((s) => s.status === 'done' && Object.keys(s.answered || {}).length).sort((a, b) => (b.endedAt || b.updatedAt) - (a.endedAt || a.updatedAt)).slice(0, 8);
  const sRow = (s) => {
    const v = Object.values(s.answered);
    const ok = s.mode === 'quick' ? v.filter((a) => a.result === 'know').length : v.filter((a) => a.correct).length;
    const n = s.mode === 'quick' ? v.filter((a) => a.result !== 'timeout').length : v.length;
    const href = s.mode === 'quick' ? `#quick-result?id=${s.id}` : `#result?id=${s.id}`;
    return `<a class="hrow2" href="${href}"><span class="grow"><b>${s.mode === 'quick' ? '単語帳' : '単語テスト'}</b><small>${fmtDay(s.endedAt || s.updatedAt)}・${n}問</small></span><span class="acc">${n ? Math.round((ok / n) * 100) : 0}%</span>${icon('chevron', 16)}</a>`;
  };
  const any = st.weak.length || st.recentWrong.length || st.bookmarked.length;

  el.innerHTML = `
    <header class="top"><h1>復習・記録</h1></header>
    <a class="action primary" href="#lesson">${icon('lesson', 20)}<span class="grow"><b>復習予定（間隔反復）</b><small>${(await lessonStats()).due}件が期限・レッスンで復習</small></span>${icon('chevron', 18)}</a>
    ${any ? '' : '<p class="empty">現在復習する問題はありません</p>'}
    ${group('weak', 'review', '苦手な単語・熟語', st.weak, '総合習得度が「苦手」「未習得」の語（学習履歴のない語を含む）')}
    ${group('recent', 'warn', '最近7日間に間違えた', st.recentWrong)}
    ${group('bm', 'bookmark', '保存した単語（ブックマーク）', st.bookmarked)}
    <section class="card rgroup soon"><div class="rhead">${icon('grammar', 20)}<b class="grow">苦手な文法</b><em>準備中</em></div></section>

    <h2 class="sec">学習の進み具合</h2>
    <section class="card stack">
      <div class="row between"><b>すべての単語</b><span class="small muted">${st.all.total}語</span></div>
      ${progBar(st.all)}
      ${[...st.byDeck.map((r) => ({ ...r, kind: '単語集' })), ...st.byTag.map((r) => ({ ...r, kind: 'タグ' }))].map((r) => `
        <div class="prange"><div class="row between"><span>${esc(r.name)} <small class="muted">${r.kind}</small></span><span class="small muted">${r.total}語</span></div>${progBar(r)}</div>`).join('')}
      <details class="small"><summary class="muted">進み具合の数え方</summary>
        <p class="hint">未学習＝このアプリで一度も回答していない語／学習中＝回答したことがあり総合習得度が「学習中」以下（判定保留を含む）／習得＝総合習得度が「ほぼ習得」以上。総合習得度は4つのスキルのうち最も低いものです。</p></details>
    </section>
    <section class="kpis">
      <div class="kpi"><b>${st.weekAcc == null ? '—' : st.weekAcc + '%'}</b><span>正答率（7日・${st.weekCount}回答）</span></div>
      <div class="kpi"><b>${st.studyDays}</b><span>学習日数</span></div>
      <div class="kpi"><b>${fmtMin(st.totalMs)}</b><span>学習時間</span></div>
    </section>
    <p class="small muted center">最終学習日：${fmtDay(st.lastStudy)}</p>

    <h2 class="sec">学習履歴</h2>
    ${sessions.length ? `<div class="card list">${sessions.map(sRow).join('')}</div>` : '<p class="empty">まだ学習履歴はありません</p>'}`;

  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const [k, mode] = b.dataset.go.split(':');
    const base = { levels: [], bookmarkedOnly: false, recentWrong: false, phraseOnly: false, lowAcc: false, tag: '', deck: '', count: 'all' };
    const o = { weak: { levels: [1, 2] }, recent: { recentWrong: true }, bm: { bookmarkedOnly: true } }[k];
    if (mode === 'quick') startQuick({ ...base, ...o }); else startTest({ ...base, ...o });
  }));
}

// ================= Grammar (structure only; no questions yet) =================
const GRAMMAR = [
  ['動詞の形', [['不定詞', 'to + 動詞の原形の用法'], ['動名詞', '-ing を名詞として使う'], ['分詞', '現在分詞・過去分詞と分詞構文']]],
  ['文の構造', [['品詞', '語の働きと語形（TOEIC Part 5 頻出）'], ['文型', '主語・動詞・目的語・補語の並び'], ['修飾', '形容詞・副詞・句と節のかかり方']]],
  ['関係詞', [['主格', 'who / which / that が主語になる'], ['目的格', '目的語になる関係代名詞（省略可）'], ['所有格', 'whose']]],
  ['時間表現', [['時制', '現在・過去・未来'], ['完了形', '現在完了・過去完了・未来完了']]],
  ['仮定法', [['仮定法現在', '要求・提案の that 節'], ['仮定法過去', '現在の事実に反する仮定'], ['仮定法過去完了', '過去の事実に反する仮定'], ['混合', '過去の条件と現在の結果']]],
  ['接続表現', [['接続詞', 'although / because など節をつなぐ'], ['前置詞', 'despite / because of など名詞をつなぐ'], ['接続副詞', 'however / therefore など文をつなぐ']]],
];
export async function grammarScreen(el) {
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>文法</h1></header>
    <p class="notice info">${icon('grammar', 18)}<span>文法の問題・解説・概念マップは準備中です。単元の構成だけ先に表示しています（進捗はまだ記録されません）。</span></p>
    ${GRAMMAR.map(([g, units]) => `
      <h2 class="sec">${g}</h2>
      <div class="card list">${units.map(([u, d]) => `<div class="urow soon"><span class="grow"><b>${u}</b><small>${d}</small></span><em>準備中</em></div>`).join('')}</div>`).join('')}`;
}

export function comingSoon(title, ic, desc) {
  return async (el) => {
    el.innerHTML = `
      <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>${title}</h1></header>
      <div class="card center stack">${icon(ic, 36, 'muted')}<b>準備中</b><p class="muted small">${desc}</p></div>`;
  };
}
