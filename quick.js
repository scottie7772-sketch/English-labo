// 単語帳（Quick Flashcards）: swipe cards in units, with music-player-like repeat modes.
// Linked to mastery / attempts / sessions exactly like before (self-report weights in judge.js).
import { db, uid, getSetting, setSetting, attemptsSince } from './db.js';
import { $, $$, esc, toast, go, speak } from './ui.js';
import { LEVEL_LABELS, SKILL_LABELS, effLevel, filterLevel, loadAllMastery } from './mastery.js';
import { recordAnswer, snapshotMastery, undoAnswer } from './judge.js';
import { shuffle, allMeanings } from './study.js';
import { toggleBookmark } from './words.js';
import { makeSwipeCard, swipeCardHTML, answerStripHTML, swipeMap, isOneHand, swipeHint, oneHandPadHTML, fitStage, fc2FaceHTML, fc2CardHTML, fitBig, fc2Setup, fc2Fit, fc2Voice } from './swipecard.js';
import { icon } from './icons.js';

import { L, curLang, langOf, numToMarks, isZh } from './langs.js';
const QDIRS = { en2ja: { get label() { return `${L().ch}→日`; }, skill: 'recognition' }, ja2en: { get label() { return `日→${L().ch}`; }, skill: 'recall' } };
const RANGES = [
  ['auto', 'おまかせ', '習得済み以外'], ['unlearned', '未学習', ''], ['weak', '苦手', ''], ['learning', '学習中', ''],
  ['mastered', '習得済み', 'ほぼ習得以上'], ['bookmark', 'ブックマーク', ''], ['all', 'すべて', ''],
];
const ORDERS = [['random', 'ランダム'], ['old', '古い順'], ['new', '新しい順'], ['weak', '苦手順'], ['bookmark', 'ブックマーク優先']];
export const REPEATS = {
  five: { label: '5語リピート', desc: 'いま出ている5語を繰り返す' },
  all: { label: '全リピート', desc: '選んだ単元を最後まで行ったら最初から' },
  next: { label: '次の単元へ', desc: '単元が終わったら次の単元へ自動で進む（最後で終了）' },
  end: { label: '単元で終了', desc: '今の単元が終わったら終了' },
};
export const QUICK_DEFAULTS = Object.freeze({
  range: 'auto', order: 'random', direction: 'en2ja', units: [0],
  unitSize: 30, autoFlip: 10, cardTime: 0, time: 0, showTimer: true, repeat: 'end',
});
const POS_JA = { noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞', pronoun: '代名詞', number: '数詞', measure: '量詞', 'phrasal verb': '句動詞', idiom: 'イディオム', phrase: '熟語', conjunction: '接続詞', preposition: '前置詞' };

let cleanup = null;
function setCleanup(fn) { cleanup?.(); cleanup = fn; }
addEventListener('hashchange', () => { if (!location.hash.startsWith('#quick-run')) setCleanup(null); });

const fmtClock = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const counts = (s) => {
  const v = Object.values(s.answered);
  const n = (r) => v.filter((a) => a.result === r).length;
  return { know: n('know'), vague: n('vague'), dont: n('dont'), timeout: n('timeout'), unanswered: n('timeout') };
};
async function activeQuick() {
  return (await db.byIndex('sessions', 'status', 'active')).filter((x) => x.mode === 'quick' && (x.lang || 'en') === curLang()).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}
export const getSwipe = () => getSetting('swipeKnow', 'up');
async function loadCfg() { return { ...QUICK_DEFAULTS, ...(await getSetting('quickCfg', {})) }; }

// ---------- word list for a range + order ----------
async function buildList(cfg, extra = {}) {
  const [words0, mastery] = await Promise.all([db.all('words'), loadAllMastery()]);
  const words = words0.filter((w) => !w.slim && langOf(w) === curLang());
  const skill = QDIRS[cfg.direction].skill;
  const lv = (w) => filterLevel(effLevel(mastery[w.id]?.[skill]));
  const attempts = (w) => mastery[w.id]?.[skill]?.stats?.attempts || 0;
  const usable = words.filter((w) => allMeanings(w).length);
  const test = {
    // 苦手 = 回答して習得度が低い語＋手動で苦手にした語（一度も回答していない語は「未学習」）
    auto: (w) => lv(w) <= 3, unlearned: (w) => attempts(w) === 0, weak: (w) => lv(w) <= 2 && (attempts(w) > 0 || mastery[w.id]?.[skill]?.manualLevel != null), learning: (w) => lv(w) === 3,
    mastered: (w) => lv(w) >= 4, bookmark: (w) => w.bookmarked, all: () => true,
  };
  const countsByRange = Object.fromEntries(RANGES.map(([k]) => [k, usable.filter(test[k]).length]));
  let list = usable.filter(test[cfg.range] || test.all);
  if (extra.tag) list = list.filter((w) => (w.tags || []).includes(extra.tag));
  if (extra.recentWrong) {
    const weekAgo = Date.now() - 7 * 86400000;
    const ids = new Set((await attemptsSince(weekAgo)).filter((a) => !a.correct).map((a) => a.wordId));
    list = list.filter((w) => ids.has(w.id));
  }
  const byOld = (a, b) => a.createdAt - b.createdAt;
  if (cfg.order === 'random') shuffle(list);
  else if (cfg.order === 'old') list.sort(byOld);
  else if (cfg.order === 'new') list.sort((a, b) => -byOld(a, b));
  else if (cfg.order === 'weak') list.sort((a, b) => lv(a) - lv(b) || byOld(a, b));
  else if (cfg.order === 'bookmark') list.sort((a, b) => (b.bookmarked ? 1 : 0) - (a.bookmarked ? 1 : 0) || byOld(a, b));
  const size = Math.max(1, +cfg.unitSize || 30);
  const units = [];
  for (let i = 0; i < list.length; i += size) units.push({ label: `${i + 1}〜${Math.min(i + size, list.length)}語`, ids: list.slice(i, i + size).map((w) => w.id) });
  return { list, units, countsByRange, total: usable.length };
}

// ================= Setup (minimal) =================
export async function quickSetup(el) {
  setCleanup(null);
  const cfg = await loadCfg();
  const active = await activeQuick();
  let data;
  let detailsOpen = false;

  async function refresh() { data = await buildList(cfg); cfg.units = cfg.units.filter((i) => i < data.units.length); if (!cfg.units.length && data.units.length) cfg.units = [0]; draw(); }
  const chips = (id, arr, cur, lab) => `<div class="chips" id="${id}">${arr.map((v) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${lab(v)}</button>`).join('')}</div>`;
  function draw() {
    const nWords = cfg.units.reduce((t, i) => t + (data.units[i]?.ids.length || 0), 0);
    el.innerHTML = `
      <header class="top"><a href="#study" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>フラッシュカード</h1><span class="grow"></span><span class="small muted">スワイプで確認</span></header>
      ${active && active.units ? `<div class="resume-bar"><span class="grow"><b>途中のフラッシュカード</b><small>${QDIRS[active.config.direction].label}・${esc(REPEATS[active.config.repeat]?.label || '')}・${Object.keys(active.answered).length}枚済み</small></span>
        <button class="btn sm ghost" id="end">終了</button><a class="btn sm primary" href="#quick-run?id=${active.id}">再開</a></div>` : ''}
      <div class="setlist">
        <div class="setrow"><span class="setlabel">問題範囲</span>
          <div class="chips" id="range">${RANGES.map(([k, l]) => `<button data-v="${k}" class="${cfg.range === k ? 'on' : ''}">${l}<span class="cnt">${data.countsByRange[k]}</span></button>`).join('')}</div></div>
        <div class="setrow"><span class="setlabel">並び順</span>${chips('order', ORDERS.map((o) => o[0]), cfg.order, (v) => ORDERS.find((o) => o[0] === v)[1])}</div>
        <div class="setrow"><span class="setlabel">出題形式</span>
          <div class="seg" data-k="direction">${Object.entries(QDIRS).map(([k, d]) => `<button data-v="${k}" class="${cfg.direction === k ? 'on' : ''}">${d.label}</button>`).join('')}</div></div>
        ${data.units.length > 1 ? `<div class="setrow"><span class="setlabel">単元（${cfg.unitSize}語ずつ・複数選択可）</span>
          <div class="unitlist" id="units">${data.units.map((u, i) => `<label class="unit"><input type="checkbox" value="${i}" ${cfg.units.includes(i) ? 'checked' : ''}><span>単元${i + 1}</span><small>${u.label}</small></label>`).join('')}</div></div>` : ''}
      </div>

      <details class="card details" id="det" ${detailsOpen ? 'open' : ''}><summary>詳細設定<span class="muted small">　語数・自動めくり・時間・リピート</span></summary>
        <div class="fgrp"><span>1単元の語数</span>${chips('usize', [10, 20, 30, 50], cfg.unitSize, (v) => v + '語')}</div>
        <div class="fgrp"><span>自動めくり（答えを自動で表示）</span>${chips('flip', [0, 5, 10, 15], cfg.autoFlip, (v) => (v ? v + '秒' : 'オフ'))}</div>
        <div class="fgrp"><span>1枚の制限時間（過ぎたら未回答で次へ）</span>${chips('ctime', [0, 10, 15, 30], cfg.cardTime, (v) => (v ? v + '秒' : 'オフ'))}</div>
        <div class="fgrp"><span>全体の制限時間</span>${chips('time', [0, 3, 5, 10, 15], cfg.time, (v) => (v ? v + '分' : 'なし'))}</div>
        <label class="chk"><input type="checkbox" id="showTimer" ${cfg.showTimer ? 'checked' : ''}> 学習中に時間を表示する</label>
        <div class="fgrp"><span>単元が終わったとき（学習中もリピートボタンで変更可）</span>
          <div class="seg wrap" data-k="repeat">${Object.entries(REPEATS).map(([k, r]) => `<button data-v="${k}" class="${cfg.repeat === k ? 'on' : ''}">${r.label}</button>`).join('')}</div></div>
        <button class="btn ghost" id="reset">初期設定に戻す</button>
      </details>

      <div class="cta-bar"><div class="cta-count"><b>${nWords}</b><span>語</span><small>${cfg.units.length}単元・${QDIRS[cfg.direction].label}・${REPEATS[cfg.repeat].label}</small></div>
        <button class="btn primary cta" id="start" ${nWords ? '' : 'disabled'}>スタート</button></div>`;
    bind();
  }
  function bind() {
    const keepOpen = () => { detailsOpen = $('#det', el)?.open || false; };
    $('#range', el).onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (!v) return; keepOpen(); cfg.range = v; cfg.units = [0]; refresh(); };
    $('#order', el).onclick = (e) => { const v = e.target.dataset.v; if (!v) return; keepOpen(); cfg.order = v; cfg.units = [0]; refresh(); };
    el.querySelectorAll('.seg[data-k]').forEach((s) => s.addEventListener('click', (e) => { const v = e.target.dataset.v; if (!v) return; keepOpen(); cfg[s.dataset.k] = v; if (s.dataset.k === 'direction') { cfg.units = [0]; refresh(); } else draw(); }));
    $('#units', el)?.addEventListener('change', () => { cfg.units = $$('#units input:checked', el).map((x) => +x.value); keepOpen(); draw(); });
    const num = (id, key, after) => { $('#' + id, el).onclick = (e) => { const v = e.target.dataset.v; if (v == null) return; keepOpen(); cfg[key] = +v; after ? after() : draw(); }; };
    num('usize', 'unitSize', () => { cfg.units = [0]; refresh(); });
    num('flip', 'autoFlip'); num('ctime', 'cardTime'); num('time', 'time');
    $('#showTimer', el).onchange = (e) => { cfg.showTimer = e.target.checked; };
    $('#reset', el).onclick = async () => { Object.assign(cfg, QUICK_DEFAULTS, { units: [0] }); await setSetting('quickCfg', cfg); toast('初期設定に戻しました（10秒で自動めくり・30語）'); detailsOpen = true; refresh(); };
    $('#end', el)?.addEventListener('click', async () => { active.status = 'done'; active.endedAt = Date.now(); await db.put('sessions', active); go(`#quick-result?id=${active.id}`); });
    $('#start', el).onclick = async () => {
      if (active) { active.status = 'done'; active.endedAt = Date.now(); await db.put('sessions', active); }
      await setSetting('quickCfg', { ...cfg });           // 次回もこの設定
      const s = await createQuick(cfg, data.units);
      go(`#quick-run?id=${s.id}`);
    };
  }
  await refresh();
}

async function createQuick(cfg, units, retryOf = null) {
  const now = Date.now();
  const checked = (cfg.units || [0]).filter((i) => units[i]);
  const s = {
    id: uid('qs_'), mode: 'quick', lang: curLang(), status: 'active', config: { ...cfg }, retryOf,
    units, checked: checked.length ? checked : [0],
    play: { u: 0, pos: 0 },                 // u = index into checked, pos = index in that unit
    queue: [], answered: {}, startedAt: now, updatedAt: now, endedAt: null, elapsedMs: 0, activeMs: 0, laps: 0,
  };
  await db.put('sessions', s);
  return s;
}

// ================= Run =================
export async function quickRun(el, params) {
  const s = await db.get('sessions', params.get('id'));
  if (!s || s.status !== 'active') { go(s ? `#quick-result?id=${s.id}` : '#quick'); return; }
  if (!s.units) { s.status = 'done'; await db.put('sessions', s); go(`#quick-result?id=${s.id}`); return; }   // pre-v0.9 session
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));
  const swipeSet = await getSwipe(), map = swipeMap(swipeSet), oneHand = isOneHand(map), knowRight = swipeSet === 'right';
  const cfg = s.config;
  const skill = QDIRS[cfg.direction].skill;
  const undo = [];
  let running = true, cardMs = 0, last = performance.now(), busy = Promise.resolve(), ended = false, cur = null;

  const unitOf = () => s.units[s.checked[s.play.u]];
  const curWordId = () => unitOf()?.ids[s.play.pos];

  // advance the play head according to the repeat mode. returns false when the session should end
  function advance() {
    const unit = unitOf(); const len = unit.ids.length;
    if (cfg.repeat === 'five') {
      const block = Math.floor(s.play.pos / 5) * 5, end = Math.min(block + 5, len);
      s.play.pos = s.play.pos + 1 >= end ? block : s.play.pos + 1;
      if (s.play.pos === block) s.laps++;
      return true;
    }
    if (s.play.pos + 1 < len) { s.play.pos++; return true; }
    if (cfg.repeat === 'end') return false;
    if (cfg.repeat === 'next') { if (s.play.u + 1 >= s.checked.length) return false; s.play.u++; s.play.pos = 0; return true; }
    s.play.u = (s.play.u + 1) % s.checked.length; s.play.pos = 0; if (s.play.u === 0) s.laps++;   // all
    return true;
  }
  function skipMissing() {   // words deleted meanwhile
    let guard = 0;
    while (!words[curWordId()] && guard++ < 5000) if (!advance()) return false;
    return !!words[curWordId()];
  }

  el.innerHTML = `
    <div class="qrun ${oneHand ? 'onehand' : ''}">
    <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button>
      <span class="qcenter"><b id="pos"></b><small id="clock"></small></span>
      <button class="xbtn" id="gear" aria-label="設定">${icon('gear', 18)}</button>
      <button class="xbtn" id="pause" aria-label="一時停止">${icon('pause', 18)}</button></header>
    <div class="progress"><i id="prog"></i></div>
    <div class="row between small muted" style="margin:6px 2px"><span id="unitlbl"></span><span id="tally"></span></div>
    <div class="cardbar"><i id="cbar"></i></div>
    <div class="qstage stacked" id="stage"></div>
    <div class="laststrip" id="last"></div>
    <div class="player">
      <button class="repeat-btn" id="repeat" aria-label="リピート設定">${icon('review', 20)}<span id="replbl"></span></button>
      <span class="hint">${oneHand ? swipeHint(map) : `タップで答え・${knowRight ? '←わからない →わかる' : '←わかる →わからない'}・↑曖昧`}</span>
    </div>
    <div class="qbtns3">
      <button class="btn qb ${knowRight ? 'dont' : 'know'}" data-r="${knowRight ? 'dont' : 'know'}"><b>←</b>${knowRight ? 'わからない' : 'わかる'}</button>
      <button class="btn qb vague" data-r="vague"><b>↑</b>曖昧</button>
      <button class="btn qb ${knowRight ? 'know' : 'dont'}" data-r="${knowRight ? 'know' : 'dont'}"><b>→</b>${knowRight ? 'わかる' : 'わからない'}</button>
      ${oneHand ? '' : `<button class="btn qb" id="undo" aria-label="取り消し">${icon('undo', 20)}</button>`}
    </div>
    ${oneHand ? '<button id="undo" hidden></button>' : ''}
    <div class="pauseov" id="pov" hidden><div class="card center stack"><b>一時停止中</b><button class="btn primary" id="resume">再開</button><button class="btn" id="quit2">終了して結果へ</button></div></div>
    </div>`;
  document.body.classList.add('noscroll');
  const stage = $('#stage', el), pad = $('#qpad', el), qrun = $('.qrun', el);
  if (pad) fitStage(stage, pad);
  // 1.14: one-handed mode uses the new single-card design (swipe ↑↓ anywhere, rarely used controls in •••)
  const fc2 = oneHand, voice = fc2Voice(qrun, (t) => speak(t));
  if (fc2) {
    fc2Setup(qrun, {
      info: () => `${$('#unitlbl', el).textContent}　${$('#tally', el).textContent}`,
      items: [
        { label: '直前の回答を取り消す', run: () => doUndo(), disabled: () => !undo.length },
        { label: '一時停止', run: () => $('#pause', el).click() },
        { label: '表示・リピートの設定', run: () => openSheet(), text: () => `表示・リピートの設定（${REPEATS[cfg.repeat].label}）` },
      ],
    });
    fc2Fit(stage);
  }

  function updateTop() {
    const c = counts(s), unit = unitOf();
    $('#pos', el).textContent = `${s.play.pos + 1} / ${unit.ids.length}`;
    $('#clock', el).textContent = cfg.showTimer ? (cfg.time ? `残り ${fmtClock(cfg.time * 60000 - s.elapsedMs)}` : fmtClock(s.elapsedMs)) : '';
    $('#prog', el).style.width = `${((s.play.pos) / unit.ids.length) * 100}%`;
    $('#unitlbl', el).textContent = `単元${s.checked[s.play.u] + 1}（${unit.label}）${s.laps ? `・${s.laps}周目済み` : ''}${cfg.repeat === 'five' ? `・${Math.floor(s.play.pos / 5) * 5 + 1}〜${Math.min(Math.floor(s.play.pos / 5) * 5 + 5, unit.ids.length)}語目` : ''}`;
    $('#tally', el).textContent = `○${c.know} △${c.vague} ✕${c.dont}${c.timeout ? ' 未' + c.timeout : ''}`;
    $('#cbar', el).style.width = cfg.cardTime ? `${Math.max(0, 100 - (cardMs / (cfg.cardTime * 1000)) * 100)}%` : '0';
    $('#undo', el).disabled = !undo.length;
    $('#replbl', el).textContent = REPEATS[cfg.repeat].label;
    $('#repeat', el).classList.toggle('on', cfg.repeat !== 'end');
  }

  function faces(w) {
    const mean = esc(allMeanings(w).join('、'));
    const pos = [...new Set((w.senses || []).map((x) => POS_JA[x.pos] || x.pos).filter(Boolean))].join('・');
    const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
    const posTag = pos ? `<div class="q-sub">${esc(pos)}</div>` : '';
    const en = `<div class="fc-en">${esc(w.headword)}</div>${w.ipa && isZh(langOf(w)) ? `<div class="fc-read">${esc(numToMarks(w.ipa))}</div>` : ''}`;
    const ja = `<div class="fc-ja">${mean}</div>`;
    const exH = ex ? `<div class="fc-ex">${esc(ex.en)}${ex.ja ? `<br><span class="muted">${esc(ex.ja)}</span>` : ''}</div>` : '';
    const tapHint = '<div class="tap-hint">タップで答えを表示</div>';
    return cfg.direction === 'en2ja'
      ? { front: `${en}${posTag}${tapHint}`, back: `${en}${posTag}${ja}${exH}` }
      : { front: `${ja}${posTag}${tapHint}`, back: `${ja}${en}${exH}` };
  }
  const bmBtn = (on) => `<button class="cardbm ${on ? 'on' : ''}" data-nosw aria-label="ブックマーク">${icon('bookmark', 22)}</button>`;

  // show the card at the play head (reuse = an existing queue entry when undoing)
  function showCard(reuse = null) {
    const wordId = reuse ? reuse.wordId : curWordId();
    const w = words[wordId];
    const entry = reuse || { qid: uid('q_'), wordId, direction: cfg.direction, skill, unit: s.checked[s.play.u], pos: s.play.pos };
    if (!reuse) s.queue.push(entry);
    const f = faces(w);
    stage.insertAdjacentHTML('afterbegin', fc2
      ? fc2CardHTML(fc2FaceHTML(w, cfg.direction, allMeanings(w), { reading: w.ipa && isZh(langOf(w)) ? numToMarks(w.ipa) : '' }), bmBtn(w.bookmarked))
      : swipeCardHTML(f.front, map, bmBtn(w.bookmarked)));
    const card = stage.firstElementChild;
    const st = { card, entry, flipped: false, revealed: false };
    const setFace = fc2
      ? (back) => { st.flipped = back; card.classList.toggle('revealed', back); if (back) { st.revealed = true; if (cfg.direction === 'ja2en') voice.tap(w.headword); } }
      : (back) => { st.flipped = back; card.classList.add('flipping'); setTimeout(() => { $('.face', card).innerHTML = back ? f.back : f.front; card.classList.remove('flipping'); }, 90); if (back) { st.revealed = true; speak(w.headword); } };
    st.flip = () => setFace(!st.flipped);
    st.autoFlip = () => { if (!st.flipped) setFace(true); };
    // fc2: tapping the English reads it aloud (again and again); tapping elsewhere shows the answer
    const onTap = fc2 ? (t) => { const sayEl = t?.closest?.('[data-say]'); if (sayEl) voice.tap(sayEl.classList.contains('fc2-audio') ? w.headword : sayEl.textContent); else st.flip(); } : st.flip;
    st.ctl = makeSwipeCard(card, { map, paper: fc2, pads: fc2 ? [qrun] : pad ? [pad] : [], canInteract: () => running && !ended, onTap, onCommit: (r) => { if (fc2) voice.stop(); answer(st, r); }, revealOnCommit: () => f.back });
    if (fc2) { fitBig(card); if (cfg.direction !== 'ja2en') voice.auto(w.headword); }
    const bmb = $('.cardbm', card);
    bmb.onclick = async (e) => { e.stopPropagation(); const on = await toggleBookmark(w.id); w.bookmarked = on; bmb.classList.toggle('on', on); toast(on ? 'ブックマークしました' : 'ブックマークを外しました', 1000); };
    cur = st; cardMs = 0;
    updateTop();
  }

  // 後回し (one-handed mode, swipe →): nothing is recorded; the word moves to the end of its unit (or its block of 5)
  function postpone(st) {
    const q = st.entry, unit = unitOf(), ids = unit.ids, pos = s.play.pos;
    const end = cfg.repeat === 'five' ? Math.min(Math.floor(pos / 5) * 5 + 5, ids.length) : ids.length;
    if (end - pos <= 1) { toast('最後の1語なので後回しにできません', 1400); stage.innerHTML = ''; s.queue.pop(); showCard(); return; }
    ids.splice(end - 1, 0, ids.splice(pos, 1)[0]);
    s.queue.pop();                              // this card was shown but not answered
    undo.push({ skip: true, u: s.checked[s.play.u], from: pos, to: end - 1, play: { ...s.play }, laps: s.laps });
    $('#last', el).innerHTML = answerStripHTML('skip', esc(words[q.wordId].headword), esc(allMeanings(words[q.wordId]).join('、')), true);
    s.updatedAt = Date.now(); busy = busy.then(() => db.put('sessions', s)).catch((e) => toast('保存に失敗: ' + e.message));
    showCard();
  }

  function answer(st, result) {
    const q = st.entry;
    if (ended || s.answered[q.qid]) return;
    if (result === 'skip') return postpone(st);
    const w = words[q.wordId];
    const ms = Math.round(cardMs);
    s.answered[q.qid] = { result, ms, revealed: st.revealed, at: Date.now() };
    if (result !== 'timeout') { s.activeMs += ms; $('#last', el).innerHTML = answerStripHTML(result, esc(w.headword), esc(allMeanings(w).join('、')), st.revealed); }
    const entry = { q, play: { ...s.play }, laps: s.laps, snap: null, attemptIds: [], ms, result };
    undo.push(entry);
    busy = busy.then(async () => {
      if (result !== 'timeout') {
        entry.snap = await snapshotMastery(w.id, [skill]);
        const out = await recordAnswer({ sessionId: s.id, qid: q.qid, wordId: w.id, direction: cfg.direction, format: 'swipe', mode: 'quick', self: true, revealed: st.revealed, grade: result,
          prompt: cfg.direction === 'en2ja' ? w.headword : allMeanings(w).join('、'), answer: { know: 'わかる', vague: '曖昧', dont: 'わからない' }[result], ms,
          results: [{ skill, correct: result !== 'dont', hint: result === 'vague' }] });
        entry.attemptIds = out._attemptIds;
        if (s.answered[q.qid]) s.answered[q.qid].change = out[skill];
      }
      s.updatedAt = Date.now(); await db.put('sessions', s);
    }).catch((e) => toast('保存に失敗: ' + e.message));
    if (!advance() || !skipMissing()) { setTimeout(finish, 200); return; }
    showCard();
  }

  async function doUndo() {
    const e = undo.pop(); if (!e) return;
    await busy;
    if (e.skip) {                                // put the postponed word back where it was
      const ids = s.units[e.u].ids; ids.splice(e.from, 0, ids.splice(e.to, 1)[0]);
      const lastQ = s.queue[s.queue.length - 1]; if (lastQ && !s.answered[lastQ.qid]) s.queue.pop();
      s.play = { ...e.play }; s.laps = e.laps; s.updatedAt = Date.now(); await db.put('sessions', s);
      stage.innerHTML = ''; $('#last', el).innerHTML = ''; showCard(); toast('取り消しました', 900); return;
    }
    if (e.snap) await undoAnswer(e.q.wordId, e.snap, e.attemptIds);
    if (e.result !== 'timeout') s.activeMs -= e.ms;
    delete s.answered[e.q.qid];
    // drop the card currently shown (not answered yet), go back to the undone one
    const lastQ = s.queue[s.queue.length - 1];
    if (lastQ && lastQ.qid !== e.q.qid && !s.answered[lastQ.qid]) s.queue.pop();
    s.play = { ...e.play }; s.laps = e.laps;
    s.updatedAt = Date.now(); await db.put('sessions', s);
    stage.innerHTML = ''; $('#last', el).innerHTML = '';
    showCard(e.q); toast('取り消しました', 900);
  }

  function setPaused(p) {
    if (ended) return;
    running = !p; last = performance.now();
    $('#pov', el).hidden = !p;
    $('#pause', el).innerHTML = icon(p ? 'play' : 'pause', 18);
    if (p) { s.updatedAt = Date.now(); db.put('sessions', s); }
  }
  async function finish() {
    if (ended) return; ended = true; running = false;
    // the card on screen that was never answered is not part of the session
    const lastQ = s.queue[s.queue.length - 1];
    if (lastQ && !s.answered[lastQ.qid]) s.queue.pop();
    setCleanup(null);
    await busy;
    s.status = 'done'; s.endedAt = Date.now(); s.updatedAt = Date.now();
    await db.put('sessions', s);
    go(`#quick-result?id=${s.id}`);
  }

  // ---- repeat / settings sheet (also reachable from the gear) ----
  function openSheet() {
    const wasRunning = running; running = false;
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack sheet">
      <h3>リピートと範囲</h3>
      <div class="replist">${Object.entries(REPEATS).map(([k, r]) => `<label class="repopt"><input type="radio" name="rep" value="${k}" ${cfg.repeat === k ? 'checked' : ''}><span><b>${r.label}</b><small>${r.desc}</small></span></label>`).join('')}</div>
      ${s.units.length > 1 ? `<span class="setlabel">出題する単元（チェックしたものを順に）</span>
        <div class="unitlist">${s.units.map((u, i) => `<label class="unit"><input type="checkbox" name="unit" value="${i}" ${s.checked.includes(i) ? 'checked' : ''}><span>単元${i + 1}</span><small>${u.label}</small></label>`).join('')}</div>` : ''}
      <span class="setlabel">自動めくり</span>
      <div class="seg" id="sflip">${[0, 5, 10, 15].map((v) => `<button type="button" data-v="${v}" class="${cfg.autoFlip === v ? 'on' : ''}">${v ? v + '秒' : 'オフ'}</button>`).join('')}</div>
      <div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn primary" value="ok">適用</button></div></form>`;
    let flip = cfg.autoFlip;
    $('#sflip', dlg).onclick = (e) => { const v = e.target.dataset.v; if (v == null) return; flip = +v; $$('#sflip button', dlg).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); };
    dlg.returnValue = '';
    dlg.onclose = async () => {
      running = wasRunning; last = performance.now();
      if (dlg.returnValue !== 'ok') return;
      cfg.repeat = $('input[name=rep]:checked', dlg)?.value || cfg.repeat;
      cfg.autoFlip = flip;
      const picked = $$('input[name=unit]:checked', dlg).map((x) => +x.value);
      if (picked.length && picked.join() !== s.checked.join()) {
        const curUnit = s.checked[s.play.u];
        s.checked = picked;
        if (picked.includes(curUnit)) s.play.u = picked.indexOf(curUnit);
        else {   // current unit removed: jump to the first picked unit
          s.play = { u: 0, pos: 0 };
          const q = s.queue[s.queue.length - 1]; if (q && !s.answered[q.qid]) s.queue.pop();
          stage.innerHTML = ''; skipMissing(); showCard();
        }
      }
      await setSetting('quickCfg', { ...(await loadCfg()), repeat: cfg.repeat, autoFlip: cfg.autoFlip });
      s.updatedAt = Date.now(); await db.put('sessions', s);
      updateTop(); toast(`${REPEATS[cfg.repeat].label}にしました`, 1200);
    };
    dlg.showModal();
  }

  // ---- timers ----
  const iv = setInterval(() => {
    const now = performance.now(), d = now - last; last = now;
    if (!running || ended) return;
    s.elapsedMs += d; cardMs += d;
    if (cfg.time && s.elapsedMs >= cfg.time * 60000) { s.elapsedMs = cfg.time * 60000; toast('時間になりました'); finish(); return; }
    if (cfg.autoFlip && cardMs >= cfg.autoFlip * 1000) cur?.autoFlip();
    if (cfg.cardTime && cardMs >= cfg.cardTime * 1000 && cur && !cur.ctl.done) { cur.card.remove(); answer(cur, 'timeout'); }
    updateTop();
  }, 200);
  const onVis = () => { if (document.hidden && running) setPaused(true); };
  document.addEventListener('visibilitychange', onVis);
  setCleanup(() => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); document.body.classList.remove('noscroll'); if (!ended) { s.updatedAt = Date.now(); db.put('sessions', s); } });

  $('#pause', el).onclick = () => setPaused(running);
  $('#resume', el).onclick = () => setPaused(false);
  $('#quit', el).onclick = $('#quit2', el).onclick = () => finish();
  $('#undo', el).onclick = doUndo;
  $('#gear', el).onclick = openSheet;
  $('#repeat', el).onclick = openSheet;
  el.querySelectorAll('.qb[data-r]').forEach((b) => (b.onclick = () => { if (running && cur && !cur.ctl.done) cur.ctl.commit(b.dataset.r); }));
  $('[data-flip]', el)?.addEventListener('click', () => { if (running && cur && !cur.ctl.done) cur.flip(); });

  // resume: if the last queued card was not answered, show it again; otherwise show the play head
  const lastQ = s.queue[s.queue.length - 1];
  if (lastQ && !s.answered[lastQ.qid] && words[lastQ.wordId]) showCard(lastQ);
  else { if (!skipMissing()) return finish(); showCard(); }
}

// ================= Result =================
export async function quickResult(el, params) {
  setCleanup(null);
  const s = await db.get('sessions', params.get('id'));
  if (!s) { go('#quick'); return; }
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));
  const c = counts(s);
  const answered = Object.values(s.answered).filter((a) => a.result !== 'timeout');
  const avg = answered.length ? answered.reduce((a, b) => a + b.ms, 0) / answered.length / 1000 : 0;
  const prev = (await db.all('sessions')).filter((x) => x.mode === 'quick' && x.status === 'done' && x.id !== s.id && x.config.direction === s.config.direction && x.startedAt < s.startedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
  const rate = (x) => { const k = counts(x); const n = k.know + k.dont + k.vague; return n ? Math.round((k.know / n) * 100) : 0; };
  // latest judgment per word (repeats can show a word several times)
  const latest = new Map();
  for (const q of s.queue) { const a = s.answered[q.qid]; if (a && a.result !== 'timeout') latest.set(q.wordId, { q, a }); }
  const dontIds = [...latest].filter(([id, x]) => x.a.result === 'dont' && words[id]).map(([id]) => id);
  const weakIds = [...latest].filter(([id, x]) => x.a.result !== 'know' && words[id]).map(([id]) => id);
  const revealedKnow = answered.filter((a) => a.result === 'know' && a.revealed).length;
  const lt = (l) => (l ? LEVEL_LABELS[l] : '判定保留');
  let cmp = '';
  if (prev) {
    const d = rate(s) - rate(prev);
    cmp = `<div class="card small">前回（${new Date(prev.startedAt).toLocaleDateString('ja-JP')}）${rate(prev)}% → 今回 ${rate(s)}% <b class="${d >= 0 ? 'up' : 'down'}">（${d >= 0 ? '+' : ''}${d}）</b></div>`;
  }
  el.innerHTML = `
    <header class="top"><a href="#quick" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
    <div class="donemark">${icon('check', 30)}<span>${c.know + c.vague + c.dont}枚 完了（${latest.size}語）</span></div>
    <div class="stats stats4">
      <div class="stat"><b class="up">${c.know}</b><span>わかる</span></div>
      <div class="stat"><b class="mid">${c.vague}</b><span>曖昧</span></div>
      <div class="stat"><b class="down">${c.dont}</b><span>わからない</span></div>
      <div class="stat"><b>${c.timeout}</b><span>時間切れ</span></div>
    </div>
    <p class="small muted center">わかる ${c.know} のうち、答えを見てから ${revealedKnow}・見ずに ${c.know - revealedKnow}</p>
    <div class="card stack" style="margin-top:10px">
      <div class="kv"><span>学習時間</span><b>${fmtClock(s.elapsedMs)}</b></div>
      <div class="kv"><span>1枚あたり平均</span><b>${avg.toFixed(1)}秒</b></div>
      <div class="kv"><span>方向</span><b>${QDIRS[s.config.direction].label}（${SKILL_LABELS[QDIRS[s.config.direction].skill]}に記録）</b></div>
    </div>
    ${cmp}
    ${dontIds.length ? `<button class="btn primary" id="again">わからなかった${dontIds.length}語だけ再学習</button>` : ''}
    ${weakIds.length > dontIds.length ? `<button class="btn" id="again2" style="margin-top:8px">わからない＋曖昧の${weakIds.length}語を再学習</button>` : ''}
    <h2 class="sec">単語（最後の判定）</h2>
    ${[...latest].map(([id, { a }]) => {
      const w = words[id]; if (!w) return '';
      const mk = a.result === 'know' ? [a.revealed ? '○見' : '○', 'ok'] : a.result === 'vague' ? ['△', 'near'] : ['✕', 'ng'];
      const ch = a.change && a.change.before !== a.change.after ? `${lt(a.change.before)} → <b>${lt(a.change.after)}</b>` : '';
      return `<a class="rrow" href="#word?id=${w.id}"><span class="mk ${mk[1]}">${mk[0]}</span><span class="grow"><b>${esc(w.headword)}</b> <span class="small muted">${esc(allMeanings(w).slice(0, 2).join('、'))}</span></span><span class="small lvc">${ch}</span></a>`;
    }).join('')}
    <p class="hint">「わかる」は自己申告なので0.8回分、「曖昧」は0.4回分として習得度を判定します。自己申告だけでは「ほぼ習得」まで。「習得済み」にはテストでの正解と7日以上空けた正解が必要です。</p>
    <a class="btn" href="#quick" style="margin-top:12px">フラッシュカードに戻る</a>`;
  const again = async (ids) => {
    const cfg = { ...s.config, units: [0], repeat: 'end' };
    const ns = await createQuick(cfg, [{ label: `${ids.length}語`, ids: shuffle([...ids]) }], s.id);
    go(`#quick-run?id=${ns.id}`);
  };
  $('#again', el)?.addEventListener('click', () => again(dontIds));
  $('#again2', el)?.addEventListener('click', () => again(weakIds));
}

// One-tap start from Home / Review (uses the saved settings; range from the caller)
export async function startQuick(overrides = {}) {
  const base = await loadCfg();
  const map = (o) => (o.bookmarkedOnly ? 'bookmark' : o.levels?.length && o.levels.every((l) => l <= 2) ? 'weak' : base.range);
  const cfg = { ...base, range: overrides.tag ? 'all' : map(overrides), units: [0], ...(overrides.tag ? { order: 'old' } : {}) };
  const data = await buildList(cfg, { recentWrong: overrides.recentWrong, tag: overrides.tag });
  if (!data.list.length) { toast('対象の単語がありません'); return; }
  for (const x of await db.byIndex('sessions', 'status', 'active')) if (x.mode === 'quick') { x.status = 'done'; x.endedAt = Date.now(); await db.put('sessions', x); }
  // whole range as consecutive units
  const s = await createQuick({ ...cfg, units: data.units.map((_, i) => i), repeat: cfg.repeat === 'five' ? 'next' : cfg.repeat }, data.units);
  go(`#quick-run?id=${s.id}`);
}
