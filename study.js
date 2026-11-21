// Phase 3: Flashcards & Tests (setup / session / result)
import { db, uid, getSetting, setSetting, attemptsSince } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, speak, toEyeLine } from './ui.js';
import { SKILL_LABELS, LEVEL_LABELS, effLevel, filterLevel, levelText, loadAllMastery, loadWordMastery } from './mastery.js';
import { recordAnswer, snapshotMastery, undoAnswer } from './judge.js';
import { makeSwipeCard, swipeCardHTML, answerStripHTML, swipeMap, isOneHand, swipeHint, oneHandPadHTML, fitStage, fc2FaceHTML, fc2CardHTML, fitBig, fc2Setup, fc2Fit, fc2Voice } from './swipecard.js';
import { icon } from './icons.js';
import { L, curLang, langOf, compareAnswer, numToMarks, isZh } from './langs.js';

// ---------- definitions ----------
export const DIRS = {
  ja2en:    { get label() { return `日→${L().ch}`; }, get desc() { return `日本語を見て${L().name}`; }, formats: ['typing', 'flash', 'choice'] },
  en2ja:    { get label() { return `${L().ch}→日`; }, get desc() { return `${L().name}を見て意味`; }, formats: ['flash', 'choice'] },
  audio2ja: { label: '音声→意味', desc: '音声だけ聞いて意味', formats: ['flash', 'choice'] },
  audio2en: { get label() { return `音声→${L().name}`; }, get desc() { return `聞こえた${L().name}を入力`; }, formats: ['typing'] },
};
export const FORMATS = { typing: 'タイピング', flash: 'フラッシュカード', choice: '四択' };
// which mastery skills a question measures (filter uses the lowest of these)
export function basisSkills(direction, format) {
  if (direction === 'ja2en') return format === 'typing' ? ['recall', 'spelling'] : ['recall'];
  if (direction === 'en2ja') return ['recognition'];
  if (direction === 'audio2ja') return ['listening'];
  return ['spelling'];
}
export const FACTORY_TEST_DEFAULTS = Object.freeze({
  direction: 'ja2en', format: 'typing', levels: [1, 2], count: 'all', customCount: 15, order: 'random',
  caseSensitive: false, bookmarkedOnly: false, phraseOnly: false, recentWrong: false, lowAcc: false, tag: '', deck: '', decks: [],
});
const POS_JA = { noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞', preposition: '前置詞', conjunction: '接続詞', pronoun: '代名詞', 'phrasal verb': '句動詞', idiom: 'イディオム', phrase: '熟語' };

const ORDERS = [['random', 'ランダム'], ['registered', '登録順'], ['weak', '苦手度順'], ['due', '復習期限順']];

async function loadDefaults() { return { ...FACTORY_TEST_DEFAULTS, ...(await getSetting('testDefaults', {})) }; }

export const allMeanings = (w) => (w.senses || []).flatMap((s) => s.meanings || []);
const allAccepted = (w) => [...new Set((w.senses || []).flatMap((s) => s.accepted || []))];
function basisLevel(records, skills) { return Math.min(...skills.map((s) => filterLevel(effLevel(records?.[s])))); }
function rawBasis(records, skills) { const l = skills.map((s) => effLevel(records?.[s])); return l.some((x) => x === 0) ? 0 : Math.min(...l); }
export function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- candidate selection ----------
export async function selectWords(cfg) {
  const [words0, mastery, attempts, decks] = await Promise.all([db.all('words'), loadAllMastery(), attemptsSince(Date.now() - 7 * 86400000), db.all('decks')]);
  const words = words0.filter((w) => !w.slim && langOf(w) === curLang());
  const skills = basisSkills(cfg.direction, cfg.format);
  const needMeaning = cfg.direction !== 'audio2en';
  const weekAgo = Date.now() - 7 * 86400000;
  const wrongRecent = new Set(attempts.filter((a) => !a.correct && a.at >= weekAgo).map((a) => a.wordId));
  const noMeaning = words.filter((w) => needMeaning && !allMeanings(w).length).length;
  // 単語集 (several can be chosen; each may have a range 「何番〜何番」 in the order the words were added)
  const picks = cfg.decks?.length ? cfg.decks : cfg.deck ? [{ id: cfg.deck }] : [];
  const inPicked = new Set();
  for (const p of picks) {
    const inDeck = words.filter((w) => (w.deckIds || []).includes(p.id)).sort((a, b) => a.createdAt - b.createdAt);
    const from = Math.max(1, +p.from || 1), to = Math.min(inDeck.length, +p.to || inDeck.length);
    inDeck.slice(from - 1, to).forEach((w) => inPicked.add(w.id));
  }
  let list = words.filter((w) => {
    if (needMeaning && !allMeanings(w).length) return false;
    if (cfg.levels.length && !cfg.levels.includes(basisLevel(mastery[w.id], skills))) return false;
    if (cfg.bookmarkedOnly && !w.bookmarked) return false;
    if (cfg.phraseOnly && !w.isPhrase) return false;
    if (cfg.tag && !(w.tags || []).includes(cfg.tag)) return false;
    if (picks.length && !inPicked.has(w.id)) return false;
    if (cfg.recentWrong && !wrongRecent.has(w.id)) return false;
    if (cfg.lowAcc) {
      const st = skills.map((s) => mastery[w.id]?.[s]?.stats).filter((x) => x?.attempts);
      if (!st.length) return false;
      const acc = Math.min(...st.map((x) => x.correct / x.attempts));
      if (acc >= 0.6) return false;
    }
    return true;
  });
  if (cfg.order === 'random') shuffle(list);
  else if (cfg.order === 'registered') list.sort((a, b) => a.createdAt - b.createdAt);
  else if (cfg.order === 'weak') list.sort((a, b) => basisLevel(mastery[a.id], skills) - basisLevel(mastery[b.id], skills) || Math.random() - 0.5);
  const deckCount = {}; for (const w of words) for (const d of w.deckIds || []) deckCount[d] = (deckCount[d] || 0) + 1;
  return { list, mastery, skills, total: words.length, noMeaning, tags: [...new Set(words.flatMap((w) => w.tags || []))].sort(), decks, deckCount };
}

async function activeSession() {
  const act = (await db.byIndex('sessions', 'status', 'active')).filter((x) => x.mode !== 'quick').sort((a, b) => b.updatedAt - a.updatedAt);
  return act[0] || null;
}
const remaining = (s) => s.queue.filter((q) => !s.answered[q.qid]).length;

// ================= Setup screen =================
// 学習範囲のプリセット（基本設定）。詳細設定で変えると「カスタム」になる
const RANGES = [
  ['weak', '苦手・未習得', { levels: [1, 2], bookmarkedOnly: false, recentWrong: false }],
  ['all', 'すべて', { levels: [], bookmarkedOnly: false, recentWrong: false }],
  ['bookmark', 'ブックマーク', { levels: [], bookmarkedOnly: true, recentWrong: false }],
  ['recent', '最近の誤答', { levels: [], bookmarkedOnly: false, recentWrong: true }],
];
function rangeOf(cfg) {
  if (cfg.phraseOnly || cfg.lowAcc || cfg.tag || cfg.deck || cfg.decks?.length) return 'custom';
  const r = RANGES.find(([, , v]) => JSON.stringify(v.levels) === JSON.stringify(cfg.levels) && !!v.bookmarkedOnly === !!cfg.bookmarkedOnly && !!v.recentWrong === !!cfg.recentWrong);
  return r ? r[0] : 'custom';
}
const FMT_SHORT = { typing: 'タイピング', flash: 'カード', choice: '4択' };
const BASIC_COUNTS = [10, 20, 'all', 'custom'];

export async function studySetup(el) {
  const cfg = await loadDefaults();           // 前回使った設定（スタート時に自動保存）。4.6 の初期値は「初期設定に戻す」で復元
  const active = await activeSession();
  let sel = await selectWords(cfg);
  let detailsOpen = false;

  function draw() {
    const fmts = DIRS[cfg.direction].formats;
    if (!fmts.includes(cfg.format)) cfg.format = fmts[0];
    const n = cfg.count === 'all' ? sel.list.length : Math.min(sel.list.length, cfg.count === 'custom' ? cfg.customCount : cfg.count);
    const range = rangeOf(cfg);
    el.innerHTML = `
      <header class="top"><h1>単語テスト</h1><span class="grow"></span><a class="pill-link" href="#quick">${icon('cards', 18)}単語帳（カード）</a></header>
      ${active ? `
        <div class="resume-bar">
          <span class="grow"><b>中断中のテスト</b><small>${DIRS[active.config.direction].label}・${FMT_SHORT[active.config.format]}　残り ${remaining(active)}/${active.queue.length}問</small></span>
          <button class="btn sm ghost" id="abandon">破棄</button><a class="btn sm primary" href="#session?id=${active.id}">再開</a>
        </div>` : ''}

      <div class="setlist">
        <div class="setrow"><span class="setlabel">学習範囲</span>
          <div class="chips" id="range">${RANGES.map(([k, l]) => `<button data-v="${k}" class="${range === k ? 'on' : ''}">${l}</button>`).join('')}${range === 'custom' ? '<button class="on" disabled>カスタム</button>' : ''}</div></div>
        <div class="setrow"><span class="setlabel">出題方向</span>
          <div class="seg wrap" data-k="direction">${Object.entries(DIRS).map(([k, d]) => `<button data-v="${k}" class="${cfg.direction === k ? 'on' : ''}">${d.label}</button>`).join('')}</div></div>
        <div class="setrow"><span class="setlabel">回答方法</span>
          <div class="seg" data-k="format">${['choice', 'flash', 'typing'].map((f) => `<button data-v="${f}" class="${cfg.format === f ? 'on' : ''}" ${fmts.includes(f) ? '' : 'disabled'}>${FMT_SHORT[f]}</button>`).join('')}</div></div>
        <div class="setrow"><span class="setlabel">問題数</span>
          <div class="chips" id="count">${BASIC_COUNTS.map((c) => `<button data-v="${c}" class="${String(cfg.count) === String(c) || (c === 'custom' && ![10, 20, 'all'].includes(cfg.count)) ? 'on' : ''}">${c === 'all' ? '全問' : c === 'custom' ? 'カスタム' : c + '問'}</button>`).join('')}</div>
          ${cfg.count === 'custom' || ![10, 20, 'all'].includes(cfg.count) ? `<input type="number" id="custom" min="1" inputmode="numeric" value="${typeof cfg.count === 'number' ? cfg.count : cfg.customCount}" class="numin">` : ''}</div>
      </div>

      <details class="card details" id="det" ${detailsOpen ? 'open' : ''}><summary>詳細設定<span class="muted small">　習得度・絞り込み・出題順</span></summary>
        <div class="fgrp"><span>習得度（複数可・基準：${sel.skills.map((x) => SKILL_LABELS[x]).join('・')}）</span>
          <div class="chips" id="levels">${[1, 2, 3, 4, 5].map((l) => `<button data-l="${l}" class="${cfg.levels.includes(l) ? 'on' : ''}">${LEVEL_LABELS[l]}</button>`).join('')}</div>
          <p class="hint">未選択＝全単語。学習履歴のない単語は「未習得」に含まれます。</p></div>
        <div class="fgrp"><span>絞り込み</span>
          <label class="chk"><input type="checkbox" data-c="bookmarkedOnly" ${cfg.bookmarkedOnly ? 'checked' : ''}> ブックマークのみ</label>
          <label class="chk"><input type="checkbox" data-c="phraseOnly" ${cfg.phraseOnly ? 'checked' : ''}> 熟語のみ</label>
          <label class="chk"><input type="checkbox" data-c="recentWrong" ${cfg.recentWrong ? 'checked' : ''}> 最近7日間に間違えた単語のみ</label>
          <label class="chk"><input type="checkbox" data-c="lowAcc" ${cfg.lowAcc ? 'checked' : ''}> この方向・形式の正答率が60%未満のみ</label>
          <div class="row"><select id="tag" class="grow"><option value="">タグ：すべて</option>${sel.tags.map((t) => `<option ${cfg.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div></div>
        ${sel.decks.length ? `<div class="fgrp"><span>単語集（複数可・範囲は追加した順の番号）</span>
          <div class="stack" id="decks">${sel.decks.map((d) => { const p = (cfg.decks || []).find((x) => x.id === d.id) || (cfg.deck === d.id ? { id: d.id } : null); const n = sel.deckCount[d.id] || 0; return `<div class="row deckpick">
            <label class="chk grow"><input type="checkbox" data-deck="${d.id}" ${p ? 'checked' : ''}> ${esc(d.name)} <small class="muted">${n}語</small></label>
            ${p ? `<input type="number" inputmode="numeric" min="1" max="${n}" data-from="${d.id}" value="${p.from || ''}" placeholder="1" aria-label="から">〜<input type="number" inputmode="numeric" min="1" max="${n}" data-to="${d.id}" value="${p.to || ''}" placeholder="${n}" aria-label="まで">` : ''}</div>`; }).join('')}</div>
          <p class="hint">未選択＝すべての単語。複数選ぶと、それぞれの範囲を合わせて出題します。</p></div>` : ''}
        <div class="fgrp"><span>出題順</span>
          <div class="seg wrap" data-k="order">${ORDERS.map(([v, l]) => `<button data-v="${v}" class="${cfg.order === v ? 'on' : ''}" ${v === 'due' ? 'disabled' : ''}>${l}${v === 'due' ? '（準備中）' : ''}</button>`).join('')}</div></div>
        ${cfg.format === 'typing' ? `<div class="fgrp"><label class="chk"><input type="checkbox" id="case" ${cfg.caseSensitive ? 'checked' : ''}> 大文字・小文字を区別する</label></div>` : ''}
        <button class="btn ghost" id="resetDef">初期設定に戻す</button>
        <p class="hint">設定は「スタート」を押したときに保存され、次回もそのまま使われます。</p>
      </details>

      <div class="cta-bar"><div class="cta-count"><b>${n}</b><span>問</span><small>対象 ${sel.list.length}語 / 全${sel.total}語${sel.noMeaning ? `・意味未入力${sel.noMeaning}語は除外` : ''}</small></div>
        <button class="btn primary cta" id="start" ${n ? '' : 'disabled'}>スタート</button></div>`;
    bind();
  }

  async function refresh() { detailsOpen = $('#det', el)?.open || false; sel = await selectWords(cfg); draw(); }

  function bind() {
    $('#range', el).addEventListener('click', (e) => {
      const v = e.target.dataset.v; const r = RANGES.find((x) => x[0] === v); if (!r) return;
      Object.assign(cfg, r[2], { levels: [...r[2].levels], phraseOnly: false, lowAcc: false, tag: '', deck: '' }); refresh();
    });
    el.querySelectorAll('.seg[data-k]').forEach((s) => s.addEventListener('click', (e) => {
      const b = e.target.closest('button'); const v = b?.dataset.v; if (!v || b.disabled) return;
      cfg[s.dataset.k] = v; refresh();
    }));
    $('#levels', el).addEventListener('click', (e) => {
      const l = +e.target.dataset.l; if (!l) return;
      cfg.levels = cfg.levels.includes(l) ? cfg.levels.filter((x) => x !== l) : [...cfg.levels, l].sort();
      refresh();
    });
    $('#count', el).addEventListener('click', (e) => {
      const v = e.target.dataset.v; if (!v) return;
      cfg.count = v === 'all' || v === 'custom' ? v : +v; detailsOpen = $('#det', el).open; draw();
    });
    $('#custom', el)?.addEventListener('change', (e) => { cfg.count = 'custom'; cfg.customCount = Math.max(1, +e.target.value || 1); detailsOpen = $('#det', el).open; draw(); });
    $('#case', el)?.addEventListener('change', (e) => { cfg.caseSensitive = e.target.checked; });
    el.querySelectorAll('[data-c]').forEach((c) => c.addEventListener('change', () => { cfg[c.dataset.c] = c.checked; refresh(); }));
    $('#tag', el).onchange = (e) => { cfg.tag = e.target.value; refresh(); };
    const deckSync = () => { cfg.deck = ''; cfg.decks = $$('[data-deck]', el).filter((c) => c.checked).map((c) => { const id = c.dataset.deck; const f = $(`[data-from="${id}"]`, el)?.value, t = $(`[data-to="${id}"]`, el)?.value; return { id, ...(f ? { from: +f } : {}), ...(t ? { to: +t } : {}) }; }); };
    $$('[data-deck]', el).forEach((c) => c.addEventListener('change', () => { deckSync(); detailsOpen = true; refresh(); }));
    $$('[data-from],[data-to]', el).forEach((c) => c.addEventListener('change', () => { deckSync(); detailsOpen = true; refresh(); }));
    $('#resetDef', el).onclick = async () => {
      await db.delete('settings', 'testDefaults');
      Object.assign(cfg, FACTORY_TEST_DEFAULTS, { levels: [...FACTORY_TEST_DEFAULTS.levels] });
      toast('初期設定（日→英・タイピング・未習得/苦手・全問・ランダム）に戻しました');
      refresh();
    };
    $('#abandon', el)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: '中断中のテストを破棄', body: '<p>回答済みの記録は残ります。残りの問題は出題されません。</p>', okLabel: '破棄', danger: true }))) return;
      active.status = 'abandoned'; active.updatedAt = Date.now(); await db.put('sessions', active); studySetup(el);
    });
    $('#start', el).onclick = async () => {
      if (active && !(await confirmDialog({ title: '新しく始めますか？', body: '<p>中断中のテストは破棄されます（回答済みの記録は残ります）。</p>', okLabel: '新しく始める' }))) return;
      if (active) { active.status = 'abandoned'; active.updatedAt = Date.now(); await db.put('sessions', active); }
      await setSetting('testDefaults', { ...cfg });          // 前回の設定として保存
      const s = await createSession(cfg, sel);
      go(`#session?id=${s.id}`);
    };
  }
  draw();
}

// One-tap start from Home / Review (does not change the saved settings)
export async function startTest(overrides = {}) {
  const act = await activeSession();
  if (act) { act.status = 'abandoned'; act.updatedAt = Date.now(); await db.put('sessions', act); }
  const cfg = { ...(await loadDefaults()), ...overrides };
  const sel = await selectWords(cfg);
  if (!sel.list.length) { toast('対象の単語がありません'); return; }
  const s = await createSession(cfg, sel);
  go(`#session?id=${s.id}`);
}
export { loadDefaults, activeSession };

// Queue is fixed at start: later mastery changes never add/remove questions (4.6)
async function createSession(cfg, sel, retryOf = null, wordIds = null) {
  let list = sel.list;
  if (wordIds) list = shuffle(list.filter((w) => wordIds.includes(w.id)));
  const n = cfg.count === 'all' || wordIds ? list.length : Math.min(list.length, cfg.count === 'custom' ? cfg.customCount : cfg.count);
  const now = Date.now();
  const s = {
    id: uid('ss_'), status: 'active', config: { ...cfg }, retryOf,
    queue: list.slice(0, n).map((w) => ({ qid: uid('q_'), wordId: w.id, direction: cfg.direction, format: cfg.format, skills: sel.skills, levelAtStart: rawBasis(sel.mastery[w.id], sel.skills) })),
    mode: 'test', lang: curLang(), cursor: 0, answered: {}, startedAt: now, updatedAt: now, endedAt: null, activeMs: 0,
  };
  await db.put('sessions', s);
  return s;
}

// ================= answer checking =================
export function normalize(s, caseSensitive) {
  let t = String(s || '').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  t = t.replace(/[.!?]+$/, '');
  return caseSensitive ? t : t.toLowerCase();
}
const loose = (s) => s.replace(/[-\s]+/g, ' ');   // "top notch" == "top-notch"
export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// returns { result: 'correct'|'near'|'wrong', target }
export function checkTyping(input, answers, caseSensitive, lang = 'en') {
  const inp = normalize(input, caseSensitive);
  if (!inp) return { result: 'wrong', target: answers[0], dist: Infinity };
  let best = { d: Infinity, a: answers[0] };
  let nearBy = null;
  for (const a of answers) {
    const c = compareAnswer(input, a, lang, { caseSensitive });
    if (c === 'exact') return { result: 'correct', target: a, dist: 0 };
    if (c && !nearBy) nearBy = { result: 'near', reason: c, target: a, dist: 1 };
  }
  if (nearBy) return nearBy;
  for (const a of answers) {
    const na = normalize(a, caseSensitive);
    if (na === inp || loose(na) === loose(inp)) return { result: 'correct', target: a, dist: 0 };
    const d = lev(inp, na);
    if (d < best.d) best = { d, a };
  }
  const len = normalize(best.a, caseSensitive).length;
  const near = best.d <= Math.max(1, Math.floor(len * 0.2)) && len >= 3;
  return { result: near ? 'near' : 'wrong', target: best.a, dist: best.d };
}
// LCS-based diff: marks chars of input not in target (extra) and chars of target missing in input
export function diffHTML(input, target) {
  const a = [...input], b = [...target];
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, you = '', ok = '';
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].toLowerCase() === b[j].toLowerCase()) { you += esc(a[i]); ok += esc(b[j]); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { ok += `<ins>${esc(b[j])}</ins>`; you += '<span class="gap">_</span>'; j++; }
    else { you += `<del>${esc(a[i])}</del>`; i++; }
  }
  return { you, ok };
}
function hintText(target, level) {
  const chars = [...target];
  const show = level >= 2 ? Math.ceil(chars.filter((c) => c !== ' ').length / 2) : 1;
  let shown = 0;
  return chars.map((c, i) => {
    if (c === ' ' || c === '-') return c === ' ' ? ' ' : '-';
    const first = i === 0 || chars[i - 1] === ' ' || chars[i - 1] === '-';
    if ((level >= 1 && first) || shown < show && level >= 2) { shown++; return c; }
    return '_';
  }).join(' ');
}

// ================= Session screen =================
export async function sessionScreen(el, params) {
  const s = await db.get('sessions', params.get('id'));
  if (!s) { el.innerHTML = `<header class="top"><a href="#study" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>見つかりません</h1></header>`; return; }
  if (s.status !== 'active') { go(`#result?id=${s.id}`); return; }
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));
  const allWords = Object.values(words).filter((x) => langOf(x) === (s.lang || 'en'));

  // skip questions whose word was deleted meanwhile
  let idx = s.queue.findIndex((q) => !s.answered[q.qid] && words[q.wordId]);
  if (idx < 0) return finish();

  const undoStack = [];
  let busy = Promise.resolve();
  const swipeSet = await getSetting('swipeKnow', 'up'), map = swipeMap(swipeSet), oneHand = isOneHand(map), knowRight = swipeSet === 'right';

  // ---- flashcard format: 1 swipe = judged, auto-advance (no feedback screen) ----
  function showFlash(q, w) {
    const meanings = allMeanings(w);
    const answeredN = Object.keys(s.answered).length;
    const left = remaining(s);
    const isAudio = q.direction.startsWith('audio');
    const en = `<div class="fc-en">${esc(w.headword)}</div>`, ja = `<div class="fc-ja">${esc(meanings.join('、'))}</div>`;
    const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
    const exH = ex ? `<div class="fc-ex">${esc(ex.en)}${ex.ja ? `<br><span class="muted">${esc(ex.ja)}</span>` : ''}</div>` : '';
    const front = q.direction === 'ja2en' ? ja : q.direction === 'en2ja' ? en : '<div class="fc-ja">' + icon('speaker', 44) + '</div><div class="q-sub">音声を聞いて意味を思い出す</div>';
    const back = q.direction === 'ja2en' ? `${ja}${en}${exH}` : `${en}${ja}${exH}`;
    if (!$('#fstage', el)) {
      el.innerHTML = `
        <div class="qrun ${oneHand ? 'onehand' : ''}">
        <header class="qhead"><button class="xbtn" id="quit" aria-label="中断">✕</button><span class="qlabel">${DIRS[q.direction].label}・${FORMATS.flash}</span><span class="qleft" id="left"></span></header>
        <div class="progress"><i id="prog"></i></div>
        <p class="small muted center" id="pos"></p>
        <div class="qstage" id="fstage"></div>
        <div class="laststrip" id="last"></div>
        <p class="hint center">${oneHand ? swipeHint(map) : `タップで答え ・ ${knowRight ? '← わからない ・ → わかる' : '← わかる ・ → わからない'} ・ ↑曖昧`}</p>
        ${oneHand ? '<button id="undo" hidden></button>' : `<div class="qbtns3">
          <button class="btn qb ${knowRight ? 'dont' : 'know'}" data-r="${knowRight ? 'dont' : 'know'}"><b>←</b>${knowRight ? 'わからない' : 'わかる'}</button>
      <button class="btn qb vague" data-r="vague"><b>↑</b>曖昧</button>
      <button class="btn qb ${knowRight ? 'know' : 'dont'}" data-r="${knowRight ? 'know' : 'dont'}"><b>→</b>${knowRight ? 'わかる' : 'わからない'}</button>
          <button class="btn qb" id="undo">↩︎</button>
        </div>`}
        ${isAudio ? `<button class="btn" id="say" style="margin-top:8px">${icon('speaker', 20)} もう一度聞く</button>` : ''}
        </div>`;
      document.body.classList.add('noscroll');
      const off = () => { document.body.classList.remove('noscroll'); removeEventListener('hashchange', off); };
      addEventListener('hashchange', off);
      $('#quit', el).onclick = () => { toast(`中断しました（残り${remaining(s)}問）。学習タブから再開できます`); go('#study'); };
      $('#undo', el).onclick = flashUndo;
      el.querySelectorAll('.qb[data-r]').forEach((b) => (b.onclick = () => { const c = el._flashCur; if (c && !c.ctl.done) c.ctl.commit(b.dataset.r); }));
      $('[data-flip]', el)?.addEventListener('click', () => { const c = el._flashCur; if (c && !c.ctl.done) c.flip(); });
      if ($('#qpad', el)) fitStage($('#fstage', el), $('#qpad', el));
      if (oneHand) {   // 1.14 single-card design
        const qr = $('.qrun', el);
        el._voice = fc2Voice(qr, (t) => speak(t));
        fc2Setup(qr, { info: () => $('#left', el).textContent, items: [{ label: '直前の回答を取り消す', run: () => flashUndo(), disabled: () => !undoStack.length }] });
        fc2Fit($('#fstage', el));
      }
      $('#say', el)?.addEventListener('click', () => speak(words[s.queue[idx]?.wordId]?.headword));
    }
    $('#left', el).textContent = `残り ${left}`;
    $('#prog', el).style.width = `${(answeredN / s.queue.length) * 100}%`;
    $('#pos', el).textContent = `${answeredN + 1} / ${s.queue.length}`;
    $('#undo', el).disabled = !undoStack.length;
    const stage = $('#fstage', el);
    const fc2 = oneHand, voice = el._voice;
    stage.insertAdjacentHTML('afterbegin', fc2 ? fc2CardHTML(fc2FaceHTML(w, q.direction, meanings)) : swipeCardHTML(front, knowRight));
    const card = stage.firstElementChild;
    const st = { flipped: false, revealed: false, t0: performance.now() };
    if (fc2) fitBig(card);
    st.flip = () => {
      st.flipped = !st.flipped;
      card.classList.add('flipping');
      setTimeout(() => { $('.face', card).innerHTML = st.flipped ? back : front; card.classList.remove('flipping'); }, 90);
      if (st.flipped) { st.revealed = true; if (q.direction === 'ja2en') speak(w.headword); }
    };
    const qpad = $('#qpad', el);
    if (fc2) st.flip = () => { st.flipped = !st.flipped; card.classList.toggle('revealed', st.flipped); if (st.flipped) { st.revealed = true; if (q.direction === 'ja2en') voice.tap(w.headword); } };
    st.ctl = makeSwipeCard(card, {
      map, pads: fc2 ? [$('.qrun', el)] : qpad ? [qpad] : [], paper: fc2,
      revealOnCommit: () => back,
      onTap: fc2 ? (t) => { const sayEl = t?.closest?.('[data-say]'); if (sayEl) voice.tap(sayEl.classList.contains('fc2-audio') ? w.headword : sayEl.textContent); else st.flip(); } : () => {
        st.flipped = !st.flipped;
        card.classList.add('flipping');
        setTimeout(() => { $('.face', card).innerHTML = st.flipped ? back : front; card.classList.remove('flipping'); }, 90);
        if (st.flipped) { st.revealed = true; if (q.direction === 'ja2en') speak(w.headword); }
      },
      onCommit: (result) => {
        if (fc2) voice.stop();
        if (s.answered[q.qid]) return;               // double-registration guard
        if (result === 'skip') {                     // 後回し: nothing is recorded; the question moves to the end of the session
          if (!s.queue.some((x, i) => i !== idx && !s.answered[x.qid] && words[x.wordId])) { toast('最後の1問なので後回しにできません', 1400); show(); return; }
          const [it] = s.queue.splice(idx, 1); s.queue.push(it);
          undoStack.push({ skip: true, qid: q.qid, from: idx });
          $('#last', el).innerHTML = answerStripHTML('skip', esc(w.headword), esc(meanings.join('、')), true);
          s.updatedAt = Date.now(); busy = busy.then(() => db.put('sessions', s)).catch((e) => toast('保存に失敗: ' + e.message));
          idx = s.queue.findIndex((x) => !s.answered[x.qid] && words[x.wordId]);
          show(); return;
        }
        const ms = Math.round(performance.now() - st.t0);
        const correct = result !== 'dont', hint = result === 'vague';
        s.answered[q.qid] = { correct, near: false, hint, answer: { know: 'わかる', vague: '曖昧', dont: 'わからない' }[result], grade: result, revealed: st.revealed, ms, at: Date.now() };
        $('#last', el).innerHTML = answerStripHTML(result, esc(w.headword), esc(meanings.join('、')), st.revealed);
        s.cursor = idx + 1; s.activeMs += Math.min(ms, 120000); s.updatedAt = Date.now();
        const entry = { idx, qid: q.qid, wordId: w.id, snap: null, attemptIds: [], ms };
        undoStack.push(entry);
        const nextIdx = s.queue.findIndex((x) => !s.answered[x.qid] && words[x.wordId]);
        if (nextIdx < 0) { s.status = 'done'; s.endedAt = Date.now(); }
        busy = busy.then(async () => {
          entry.snap = await snapshotMastery(w.id, q.skills);
          const out = await recordAnswer({ sessionId: s.id, qid: q.qid, wordId: w.id, direction: q.direction, format: 'flash', self: true, revealed: st.revealed, grade: result,
            prompt: q.direction === 'ja2en' ? meanings.join('、') : w.headword, answer: s.answered[q.qid]?.answer, ms, results: q.skills.map((sk) => ({ skill: sk, correct, hint })) });
          entry.attemptIds = out._attemptIds;
          await db.put('sessions', s);
        }).catch((e) => toast('保存に失敗: ' + e.message));
        idx = nextIdx;
        if (nextIdx < 0) busy.then(() => go(`#result?id=${s.id}`));
        else show();
      },
    });
    el._flashCur = st;
    if (fc2) { if (q.direction !== 'ja2en') voice.auto(w.headword); }
    else if (isAudio) speak(w.headword);
  }

  async function flashUndo() {
    const e = undoStack.pop(); if (!e) return;
    await busy;
    if (e.skip) {
      const at = s.queue.findIndex((x) => x.qid === e.qid); if (at >= 0) s.queue.splice(e.from, 0, s.queue.splice(at, 1)[0]);
      s.updatedAt = Date.now(); await db.put('sessions', s);
      idx = e.from; $('#fstage', el).innerHTML = ''; $('#last', el).innerHTML = ''; show(); toast('取り消しました', 1000); return;
    }
    if (e.snap) await undoAnswer(e.wordId, e.snap, e.attemptIds);
    delete s.answered[e.qid];
    s.activeMs -= Math.min(e.ms, 120000);
    s.status = 'active'; s.endedAt = null; s.updatedAt = Date.now();
    await db.put('sessions', s);
    idx = e.idx;
    $('#fstage', el).innerHTML = ''; $('#last', el).innerHTML = '';
    show(); toast('取り消しました', 1000);
  }

  function finish() {
    s.status = 'done'; s.endedAt = Date.now(); s.updatedAt = Date.now();
    db.put('sessions', s).then(() => go(`#result?id=${s.id}`));
  }

  async function show() {
    const q = s.queue[idx];
    const w = words[q.wordId];
    if (q.format === 'flash') return showFlash(q, w);
    const cfg = s.config;
    const answeredN = Object.keys(s.answered).length;
    const left = remaining(s);
    const meanings = allMeanings(w);
    const ctx = (w.senses || []).map((x) => x.context).filter(Boolean).join(' / ');
    const pos = [...new Set((w.senses || []).map((x) => POS_JA[x.pos] || x.pos).filter(Boolean))].join('・');
    const isAudio = q.direction.startsWith('audio');
    let hintLevel = 0, revealed = false;
    const t0 = performance.now();

    const promptHTML = q.direction === 'ja2en'
      ? `<div class="q-ja">${esc(meanings.join('、'))}</div>${pos || ctx ? `<div class="q-sub">${esc([pos, ctx].filter(Boolean).join('　'))}</div>` : ''}${w.isPhrase ? '<div class="q-sub">（熟語）</div>' : ''}`
      : q.direction === 'en2ja'
        ? `<div class="q-en">${esc(w.headword)}</div><button class="icon-btn" id="say" aria-label="発音">${icon('speaker', 24)}</button>`
        : `<button class="play" id="say" aria-label="もう一度聞く">${icon('speaker', 40)}</button><div class="q-sub">タップでもう一度</div>`;

    el.innerHTML = `
      <header class="qhead"><button class="xbtn" id="quit" aria-label="中断">✕</button><span class="qlabel">${DIRS[q.direction].label}・${FORMATS[q.format]}</span><span class="qleft">残り ${left}</span></header>
      <div class="progress"><i style="width:${(answeredN / s.queue.length) * 100}%"></i></div>
      <p class="small muted center">${answeredN + 1} / ${s.queue.length}</p>
      <div class="card qcard">${promptHTML}</div>
      <div id="ans"></div>
      <div id="fb"></div>`;

    $('#quit', el).onclick = () => { toast(`中断しました（残り${left}問）。学習タブから再開できます`); go('#study'); };
    $('#say', el)?.addEventListener('click', () => speak(w.headword));
    if (isAudio) speak(w.headword);

    const ans = $('#ans', el);
    if (q.format === 'typing') {
      ans.innerHTML = `
        <form id="tf" class="stack" autocomplete="off">
          <input id="inp" class="type-in" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" placeholder="英語を入力">
          <div id="hint" class="hintline"></div>
          <div class="row"><button type="button" class="btn grow" id="hbtn">ヒント</button><button type="button" class="btn grow" id="idk">わからない</button></div>
          <button class="btn primary">回答する</button>
        </form>`;
      const inp = $('#inp', ans);
      setTimeout(() => inp.focus(), 50);
      $('#hbtn', ans).onclick = () => { hintLevel = Math.min(2, hintLevel + 1); $('#hint', ans).textContent = hintText(w.headword, hintLevel); if (hintLevel >= 2) $('#hbtn', ans).disabled = true; inp.focus(); };
      $('#idk', ans).onclick = () => submitTyping('');
      $('#tf', ans).onsubmit = (e) => { e.preventDefault(); if (!inp.value.trim()) { inp.focus(); return; } submitTyping(inp.value); };
    } else if (q.format === 'choice') {
      const toEn = q.direction === 'ja2en';
      // other meanings of the same headword would also be correct -> never use them as distractors
      const others = shuffle(allWords.filter((x) => x.id !== w.id && x.headword.toLowerCase() !== w.headword.toLowerCase() && (toEn || allMeanings(x).length)));
      const same = others.filter((x) => x.isPhrase === w.isPhrase);
      const pool = [...same, ...others.filter((x) => x.isPhrase !== w.isPhrase)];
      const label = (x) => (toEn ? x.headword : allMeanings(x).slice(0, 3).join('、'));
      const seen = new Set([label(w)]);
      const opts = [w];
      for (const x of pool) { if (opts.length >= 4) break; const l = label(x); if (!seen.has(l)) { seen.add(l); opts.push(x); } }
      shuffle(opts);
      ans.classList.add('dock'); toEyeLine($('.qcard', el));   // 1.12: choices sit low, where the thumb reaches (undocked after answering)
      ans.innerHTML = `<div class="choices">${opts.map((x, i) => `<button class="choice ${toEn ? 'en' : ''}" data-id="${x.id}"><span class="cn">${i + 1}</span><span class="ctx">${esc(label(x))}</span></button>`).join('')}</div>`;
      ans.addEventListener('click', (e) => {
        const b = e.target.closest('.choice'); if (!b || revealed) return;
        revealed = true;
        const ok = b.dataset.id === w.id;
        $$('.choice', ans).forEach((c) => { c.disabled = true; if (c.dataset.id === w.id) c.classList.add('right'); });
        if (!ok) b.classList.add('wrongc');
        commit({ correct: ok, near: false, hint: false, answer: b.querySelector('.ctx').textContent, results: q.skills.map((sk) => ({ skill: sk, correct: ok, hint: false })) });
      });
    } else { // flash
      ans.innerHTML = `<button class="btn primary" id="reveal">答えを見る</button>`;
      $('#reveal', ans).onclick = () => {
        const ms = performance.now() - t0;
        revealed = true;
        ans.innerHTML = `
          <div class="card reveal">${q.direction === 'ja2en' ? `<div class="q-en">${esc(w.headword)}</div>` : `<div class="q-en sm">${esc(w.headword)}</div><div class="q-ja">${esc(meanings.join('、'))}</div>`}</div>
          <p class="small muted center">思い出せましたか？</p>
          <div class="evals"><button class="btn" data-e="no">✕ わからない</button><button class="btn" data-e="vague">△ あいまい</button><button class="btn primary" data-e="yes">○ わかった</button></div>`;
        if (q.direction === 'ja2en') speak(w.headword);
        ans.addEventListener('click', (e) => {
          const ev = e.target.dataset.e; if (!ev) return;
          const correct = ev !== 'no', hint = ev === 'vague';
          commit({ correct, near: false, hint, answer: { no: 'わからない', vague: 'あいまい', yes: 'わかった' }[ev], results: q.skills.map((sk) => ({ skill: sk, correct, hint })), ms, flash: true });
        });
      };
    }

    function submitTyping(value) {
      if (revealed) return; revealed = true;
      const answers = [w.headword, ...allAccepted(w), ...(isZh(langOf(w)) && w.ipa ? [w.ipa] : [])];
      const r = checkTyping(value, answers, s.config.caseSensitive, langOf(w));
      const hint = hintLevel > 0;
      let results;
      if (q.direction === 'ja2en') {
        if (r.result === 'correct') results = [{ skill: 'recall', correct: true, hint }, { skill: 'spelling', correct: true, hint }];
        else if (r.result === 'near') results = [{ skill: 'recall', correct: true, hint }, { skill: 'spelling', correct: false, hint }];
        else results = [{ skill: 'recall', correct: false, hint }];
      } else results = [{ skill: 'spelling', correct: r.result === 'correct', hint }];
      $('#inp', ans).disabled = true;
      $$('button', ans).forEach((b) => (b.disabled = true));
      commit({ correct: r.result === 'correct', near: r.result === 'near', reason: r.reason, hint, answer: value, target: r.target, results });
    }

    async function commit({ correct, near, reason, hint, answer, target, results, ms }) {
      ms = Math.round(ms ?? performance.now() - t0);
      const changes = await recordAnswer({ sessionId: s.id, qid: q.qid, wordId: w.id, direction: q.direction, format: q.format, prompt: q.direction === 'ja2en' ? meanings.join('、') : w.headword, answer, ms, results });
      s.answered[q.qid] = { correct, near, hint, answer, ms, at: Date.now() };
      s.cursor = idx + 1; s.activeMs += Math.min(ms, 120000); s.updatedAt = Date.now();
      const nextIdx = s.queue.findIndex((x) => !s.answered[x.qid] && words[x.wordId]);
      if (nextIdx < 0) { s.status = 'done'; s.endedAt = Date.now(); }
      await db.put('sessions', s);
      renderFeedback({ correct, near, reason, hint, answer, target, ms, changes, last: nextIdx < 0 });
      idx = nextIdx;
    }

    function renderFeedback({ correct, near, reason, hint, answer, target, ms, changes, last }) {
      const acc = allAccepted(w);
      const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
      let diff = '';
      if (q.format === 'typing' && !correct && answer) {
        if (near) {
          const d = diffHTML(normalize(answer, true), target || w.headword);
          diff = `<div class="diff"><div><span class="small muted">あなた</span> <code>${d.you}</code></div><div><span class="small muted">正しい</span> <code>${d.ok}</code></div></div>`;
        } else diff = `<div class="small"><span class="muted">あなた：</span>${esc(answer)}</div>`;
      }
      const verdict = correct ? (hint ? '正解（ヒントあり）' : '正解') : near ? (reason === 'accent' ? '惜しい（アクセント記号）' : reason === 'tone' ? '惜しい（声調）' : '惜しい（スペルミス）') : '不正解';
      const cls = correct ? 'ok' : near ? 'near' : 'ng';
      const lvl = Object.entries(changes).map(([sk, c]) => `<span>${SKILL_LABELS[sk]} ${esc(levelText(c.before, c.before ? 'rated' : 'unrated'))} → ${esc(levelText(c.after, 'pending'))}</span>`).join('');
      $('#fb', el).innerHTML = `
        <div class="card fb ${cls}">
          <div class="verdict">${icon(correct ? 'check' : near ? 'warn' : 'close', 20)}${verdict}</div>
          <div class="row"><b class="fb-en tl">${esc(w.headword)}</b>${w.ipa ? `<span class="small muted">${esc(isZh(langOf(w)) ? numToMarks(w.ipa) : w.ipa)}</span>` : ''}<button class="icon-btn" id="say2" aria-label="発音">${icon('speaker', 22)}</button></div>
          ${diff}
          <div class="fb-mean">${esc(meanings.join('、'))}</div>
          ${ex ? `<div class="ex"><div>${esc(ex.en)}</div>${ex.ja ? `<div class="muted small">${esc(ex.ja)}</div>` : ''}</div>` : ''}
          <details class="fb-more"><summary>詳しく</summary>
            ${acc.length ? `<div class="small"><span class="muted">別解：</span>${esc(acc.join(' / '))}</div>` : ''}
            <div class="small muted">回答時間 ${(ms / 1000).toFixed(1)}秒</div>
            <div class="small muted lvchg">${lvl}</div>
          </details>
        </div>
        <button class="btn primary" id="next">${last ? '結果を見る' : '次へ'}</button>`;
      $('#say2', el).onclick = () => speak(w.headword);
      $('#ans', el)?.classList.remove('dock');
      const next = $('#next', el);
      next.classList.add('dockbtn'); next.insertAdjacentHTML('afterend', '<div class="dockspace"></div>');
      next.onclick = () => (last ? go(`#result?id=${s.id}`) : show());
      next.focus({ preventScroll: true });
      $('#fb', el).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    }
  }
  show();
}

// ================= Result screen =================
export async function resultScreen(el, params) {
  const s = await db.get('sessions', params.get('id'));
  if (!s) { el.innerHTML = `<header class="top"><a href="#study" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>見つかりません</h1></header>`; return; }
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));
  const mastery = await loadAllMastery();
  const rows = s.queue.filter((q) => s.answered[q.qid]).map((q) => ({ q, a: s.answered[q.qid], w: words[q.wordId] }));
  const ok = rows.filter((r) => r.a.correct).length;
  const wrong = rows.filter((r) => !r.a.correct);
  const pct = rows.length ? Math.round((ok / rows.length) * 100) : 0;
  const lvNow = (r) => rawBasis(mastery[r.q.wordId], r.q.skills);
  const lt = (l, r) => (l ? LEVEL_LABELS[l] : r ? '判定保留' : '未評価');

  el.innerHTML = `
    <header class="top"><a href="#study" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>テスト結果</h1></header>
    ${s.status === 'done' ? `<div class="donemark">${icon('check', 30)}<span>${rows.length}問 完了</span></div>` : ''}
    <div class="stats">
      <div class="stat"><b>${pct}%</b><span>正答率</span></div>
      <div class="stat"><b>${ok}/${rows.length}</b><span>正解</span></div>
      <div class="stat"><b>${Math.round(s.activeMs / 60000) || '<1'}</b><span>分</span></div>
    </div>
    ${s.status !== 'done' ? `<div class="card warn">${s.status === 'abandoned' ? '途中で破棄したテストです' : '未回答の問題があります'}（${rows.length}/${s.queue.length}問）</div>` : ''}
    ${wrong.length ? `<button class="btn primary" id="retry" style="margin-top:12px">誤答した${wrong.length}問だけ再テスト</button>` : '<div class="card center" style="margin-top:12px">全問正解 🎉</div>'}
    <h2 class="sec">${wrong.length ? `間違えた単語（${wrong.length}）` : ''}</h2>
    ${wrong.map((r) => resRow(r, lvNow(r), lt)).join('')}
    <h2 class="sec">すべての問題</h2>
    ${rows.map((r) => resRow(r, lvNow(r), lt)).join('')}
    <a class="btn" href="#study" style="margin-top:16px">テスト設定に戻る</a>`;

  $('#retry', el)?.addEventListener('click', async () => {
    const act = await activeSession();
    if (act) { act.status = 'abandoned'; act.updatedAt = Date.now(); await db.put('sessions', act); }
    const ids = wrong.map((r) => r.q.wordId).filter((id) => words[id]);
    const sel = { list: ids.map((id) => words[id]), mastery, skills: s.queue[0].skills };
    const ns = await createSession({ ...s.config, count: 'all' }, sel, s.id, ids);
    go(`#session?id=${ns.id}`);
  });
}

function resRow({ q, a, w }, now, lt) {
  if (!w) return '';
  const mark = a.correct ? (a.hint ? '△' : '○') : a.near ? '△' : '✕';
  const cls = a.correct && !a.hint ? 'ok' : a.near || a.hint ? 'near' : 'ng';
  const changed = q.levelAtStart !== now;
  return `
    <a class="rrow" href="#word?id=${w.id}">
      <span class="mk ${cls}">${mark}</span>
      <span class="grow"><b>${esc(w.headword)}</b><span class="small muted"> ${esc(allMeanings(w).slice(0, 2).join('、'))}</span>
        ${!a.correct && q.format === 'typing' ? `<span class="small block">あなた：${esc(a.answer || '（わからない）')}</span>` : ''}</span>
      <span class="small ${changed ? '' : 'muted'} lvc">${esc(lt(q.levelAtStart))}${changed ? ` → <b>${esc(lt(now, true))}</b>` : ''}</span>
    </a>`;
}
