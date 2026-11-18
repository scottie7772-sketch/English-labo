// Quick Flashcards: swipe-based fast self-check (linked to mastery / attempts / sessions)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, speak } from './ui.js';
import { LEVEL_LABELS, SKILL_LABELS } from './mastery.js';
import { recordAnswer, snapshotMastery, undoAnswer } from './judge.js';
import { selectWords, shuffle, allMeanings } from './study.js';
import { makeSwipeCard, swipeCardHTML } from './swipecard.js';
import { icon } from './icons.js';

const QDIRS = { en2ja: { label: '英→日', skill: 'recognition' }, ja2en: { label: '日→英', skill: 'recall' } };
const ORDERS = [['random', 'ランダム'], ['registered', '登録順'], ['weak', '苦手順']];
const COUNTS = [10, 20, 30, 50, 'all', 'custom'];
const TIMES = [0, 3, 5, 10, 15, 'custom'];          // minutes, 0 = no limit
const CARD_TIMES = [0, 5, 8, 15, 'custom'];         // seconds, 0 = no limit
export const QUICK_DEFAULTS = Object.freeze({
  direction: 'en2ja', order: 'random', levels: [], bookmarkedOnly: false, tag: '', deck: '',
  count: 'all', customCount: 20, time: 0, customTime: 7, cardTime: 0, customCardTime: 10,
});
const POS_JA = { noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞', 'phrasal verb': '句動詞', idiom: 'イディオム', phrase: '熟語' };

// one running screen at a time: clear timers when leaving
let cleanup = null;
function setCleanup(fn) { cleanup?.(); cleanup = fn; }
addEventListener('hashchange', () => { if (!location.hash.startsWith('#quick-run')) setCleanup(null); });

const fmtClock = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const limitMs = (c) => (c.time === 'custom' ? c.customTime : c.time) * 60000;
const cardLimitMs = (c) => (c.cardTime === 'custom' ? c.customCardTime : c.cardTime) * 1000;
const counts = (s) => {
  const v = Object.values(s.answered);
  const know = v.filter((a) => a.result === 'know').length, dont = v.filter((a) => a.result === 'dont').length, vague = v.filter((a) => a.result === 'vague').length;
  return { know, vague, dont, unanswered: s.queue.length - know - dont - vague, timeout: v.filter((a) => a.result === 'timeout').length };
};
async function activeQuick() {
  return (await db.byIndex('sessions', 'status', 'active')).filter((x) => x.mode === 'quick').sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}
export const getSwipe = () => getSetting('swipeVague', 'right'); // 'right' = 右スワイプで「曖昧」（↑わかる・↓わからない は固定）

// ================= Setup =================
export async function quickSetup(el) {
  setCleanup(null);
  const cfg = { ...QUICK_DEFAULTS, ...(await getSetting('quickLast', {})) };
  const active = await activeQuick();
  const swipe = await getSwipe();
  let sel;
  const selCfg = () => ({ direction: cfg.direction, format: 'flash', levels: cfg.levels, order: cfg.order, bookmarkedOnly: cfg.bookmarkedOnly, tag: cfg.tag, deck: cfg.deck });

  async function refresh() { sel = await selectWords(selCfg()); draw(); }
  function draw() {
    const n = cfg.count === 'all' ? sel.list.length : Math.min(sel.list.length, cfg.count === 'custom' ? cfg.customCount : cfg.count);
    const chips = (id, arr, cur, lab) => `<div class="chips" id="${id}">${arr.map((v) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${lab(v)}</button>`).join('')}</div>`;
    el.innerHTML = `
      <header class="top"><a href="#study" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>Quick Flashcards</h1></header>
      ${active ? `<div class="card stack resume"><b>途中のカード</b><span class="small muted">${QDIRS[active.config.direction].label}　残り ${counts(active).unanswered - counts(active).timeout} 枚</span>
        <div class="row"><a class="btn primary grow" href="#quick-run?id=${active.id}">続きから</a><button class="btn sm" id="end">終了して結果へ</button></div></div>` : ''}
      <h2 class="sec">出題方向</h2>
      <div class="card"><div class="seg" data-k="direction">${Object.entries(QDIRS).map(([k, d]) => `<button data-v="${k}" class="${cfg.direction === k ? 'on' : ''}">${d.label}</button>`).join('')}</div>
        <p class="hint" style="margin-top:8px">英→和と和→英の習得度は別々に記録されます</p></div>
      <h2 class="sec">習得度（複数可・未選択で全単語）</h2>
      <div class="card"><div class="chips" id="levels">${[1, 2, 3, 4, 5].map((l) => `<button data-l="${l}" class="${cfg.levels.includes(l) ? 'on' : ''}">${LEVEL_LABELS[l]}</button>`).join('')}</div></div>
      <h2 class="sec">絞り込み・順番</h2>
      <div class="card stack">
        <label class="chk"><input type="checkbox" id="bm" ${cfg.bookmarkedOnly ? 'checked' : ''}> ブックマークのみ</label>
        <div class="row"><select id="tag" class="grow"><option value="">タグ：すべて</option>${sel.tags.map((t) => `<option ${cfg.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <select id="deck" class="grow"><option value="">単語集：すべて</option>${sel.decks.map((d) => `<option value="${d.id}" ${cfg.deck === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
        <div class="seg" data-k="order">${ORDERS.map(([v, l]) => `<button data-v="${v}" class="${cfg.order === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <h2 class="sec">枚数</h2>
      <div class="card stack">${chips('count', COUNTS, cfg.count, (v) => (v === 'all' ? '全問' : v === 'custom' ? '指定' : v + '枚'))}
        ${cfg.count === 'custom' ? `<input type="number" id="cc" min="1" inputmode="numeric" value="${cfg.customCount}">` : ''}</div>
      <h2 class="sec">制限時間</h2>
      <div class="card stack">${chips('time', TIMES, cfg.time, (v) => (v === 0 ? 'なし' : v === 'custom' ? '任意' : v + '分'))}
        ${cfg.time === 'custom' ? `<label class="field"><span>分</span><input type="number" id="ct" min="1" inputmode="numeric" value="${cfg.customTime}"></label>` : ''}
        <span class="small muted">1枚ごとの制限（時間切れは未回答）</span>
        ${chips('ctime', CARD_TIMES, cfg.cardTime, (v) => (v === 0 ? 'なし' : v === 'custom' ? '任意' : v + '秒'))}
        ${cfg.cardTime === 'custom' ? `<label class="field"><span>秒</span><input type="number" id="cct" min="2" inputmode="numeric" value="${cfg.customCardTime}"></label>` : ''}
      </div>

      <p class="hint center">↑ わかる　↓ わからない・スキップ　${swipe === 'right' ? '→' : '←'} 曖昧（<a class="link" href="#settings">曖昧の左右は設定で変更</a>）</p>
      <div class="cta-bar"><div class="cta-count"><b>${n}</b><span>枚</span><small>対象 ${sel.list.length}語</small></div>
        <button class="btn primary cta" id="start" ${n ? '' : 'disabled'}>スタート</button></div>`;
    bind();
  }
  function bind() {
    el.querySelectorAll('.seg[data-k]').forEach((s) => s.addEventListener('click', (e) => { const v = e.target.dataset.v; if (!v) return; cfg[s.dataset.k] = v; refresh(); }));
    $('#levels', el).onclick = (e) => { const l = +e.target.dataset.l; if (!l) return; cfg.levels = cfg.levels.includes(l) ? cfg.levels.filter((x) => x !== l) : [...cfg.levels, l].sort(); refresh(); };
    const num = (v) => (v === 'all' || v === 'custom' ? v : +v);
    $('#count', el).onclick = (e) => { const v = e.target.dataset.v; if (v) { cfg.count = num(v); draw(); } };
    $('#time', el).onclick = (e) => { const v = e.target.dataset.v; if (v) { cfg.time = num(v); draw(); } };
    $('#ctime', el).onclick = (e) => { const v = e.target.dataset.v; if (v) { cfg.cardTime = num(v); draw(); } };
    $('#cc', el)?.addEventListener('change', (e) => { cfg.customCount = Math.max(1, +e.target.value || 1); draw(); });
    $('#ct', el)?.addEventListener('change', (e) => { cfg.customTime = Math.max(1, +e.target.value || 1); });
    $('#cct', el)?.addEventListener('change', (e) => { cfg.customCardTime = Math.max(2, +e.target.value || 2); });
    $('#bm', el).onchange = (e) => { cfg.bookmarkedOnly = e.target.checked; refresh(); };
    $('#tag', el).onchange = (e) => { cfg.tag = e.target.value; refresh(); };
    $('#deck', el).onchange = (e) => { cfg.deck = e.target.value; refresh(); };
    $('#end', el)?.addEventListener('click', async () => { active.status = 'done'; active.endedAt = Date.now(); await db.put('sessions', active); go(`#quick-result?id=${active.id}`); });
    $('#start', el).onclick = async () => {
      if (active) { active.status = 'done'; active.endedAt = Date.now(); await db.put('sessions', active); }
      await setSetting('quickLast', cfg);
      const s = await createQuick(cfg, sel.list);
      go(`#quick-run?id=${s.id}`);
    };
  }
  await refresh();
}

async function createQuick(cfg, list, retryOf = null) {
  const n = cfg.count === 'all' || retryOf ? list.length : Math.min(list.length, cfg.count === 'custom' ? cfg.customCount : cfg.count);
  const skill = QDIRS[cfg.direction].skill;
  const now = Date.now();
  const s = {
    id: uid('qs_'), mode: 'quick', status: 'active', config: { ...cfg }, retryOf,
    queue: list.slice(0, n).map((w) => ({ qid: uid('q_'), wordId: w.id, direction: cfg.direction, skill })),
    answered: {}, startedAt: now, updatedAt: now, endedAt: null, elapsedMs: 0, activeMs: 0,
  };
  await db.put('sessions', s);
  return s;
}

// ================= Run =================
export async function quickRun(el, params) {
  const s = await db.get('sessions', params.get('id'));
  if (!s || s.status !== 'active') { go(s ? `#quick-result?id=${s.id}` : '#quick'); return; }
  const words = Object.fromEntries((await db.all('words')).map((w) => [w.id, w]));
  const vagueRight = (await getSwipe()) === 'right';
  const cfg = s.config, LIMIT = limitMs(cfg), CARD = cardLimitMs(cfg);
  const undo = [];
  let idx = nextIdx(0), running = true, cardMs = 0, last = performance.now(), busy = Promise.resolve(), ended = false;
  let cur = null;            // { card, ctl, flipped, qid }

  function nextIdx(from) { for (let i = from; i < s.queue.length; i++) if (!s.answered[s.queue[i].qid] && words[s.queue[i].wordId]) return i; return -1; }
  if (idx < 0) return finish();

  el.innerHTML = `
    <div class="qrun">
    <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">✕</button>
      <b id="clock" class="clock"></b>
      <button class="xbtn" id="pause" aria-label="一時停止">❚❚</button></header>
    <div class="progress"><i id="prog"></i></div>
    <div class="row between small muted" style="margin:6px 2px"><span id="pos"></span><span id="tally"></span></div>
    <div class="cardbar"><i id="cbar"></i></div>
    <div class="qstage" id="stage"></div>
    <p class="hint center">タップで答え ・ ↑わかる ・ ↓わからない ・ ${vagueRight ? '→' : '←'}曖昧</p>
    <div class="qbtns3">
      <button class="btn qb dont" data-r="dont"><b>↓</b>わからない</button>
      <button class="btn qb vague" data-r="vague"><b>${vagueRight ? '→' : '←'}</b>曖昧</button>
      <button class="btn qb know" data-r="know"><b>↑</b>わかる</button>
      <button class="btn qb" id="undo" aria-label="取り消し">↩︎</button>
    </div>
    <div class="pauseov" id="pov" hidden><div class="card center stack"><b>一時停止中</b><button class="btn primary" id="resume">再開</button><button class="btn" id="quit2">終了して結果へ</button></div></div>
    </div>`;
  document.body.classList.add('noscroll');

  const stage = $('#stage', el);
  function updateTop() {
    const c = counts(s);
    $('#clock', el).textContent = LIMIT ? `残り ${fmtClock(LIMIT - s.elapsedMs)}` : fmtClock(s.elapsedMs);
    $('#prog', el).style.width = `${((s.queue.length - c.unanswered + c.timeout) / s.queue.length) * 100}%`;
    $('#pos', el).textContent = `${Math.min(s.queue.length, Object.keys(s.answered).length + 1)} / ${s.queue.length}`;
    $('#tally', el).textContent = `○${c.know}　△${c.vague}　✕${c.dont}${c.timeout ? '　未' + c.timeout : ''}`;
    $('#cbar', el).style.width = CARD ? `${Math.max(0, 100 - (cardMs / CARD) * 100)}%` : '0';
    $('#undo', el).disabled = !undo.length;
  }

  function faces(w) {
    const mean = esc(allMeanings(w).join('、'));
    const pos = [...new Set((w.senses || []).map((x) => POS_JA[x.pos] || x.pos).filter(Boolean))].join('・');
    const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
    const en = `<div class="fc-en">${esc(w.headword)}</div>`;
    const ja = `<div class="fc-ja">${mean}</div>${pos ? `<div class="q-sub">${esc(pos)}</div>` : ''}`;
    const exH = ex ? `<div class="fc-ex">${esc(ex.en)}${ex.ja ? `<br><span class="muted">${esc(ex.ja)}</span>` : ''}</div>` : '';
    return cfg.direction === 'en2ja' ? { front: en, back: `${en}${ja}${exH}` } : { front: ja, back: `${ja}${en}${exH}` };
  }

  // render card for queue index i (inserted underneath any card that is flying away)
  function showCard(i) {
    const q = s.queue[i], w = words[q.wordId];
    const f = faces(w);
    stage.insertAdjacentHTML('afterbegin', swipeCardHTML(f.front, vagueRight));
    const card = stage.firstElementChild;
    const state = { card, flipped: false, qid: q.qid, i };
    state.ctl = makeSwipeCard(card, {
      vagueRight,
      canInteract: () => running && !ended,
      onTap: () => {
        state.flipped = !state.flipped;
        card.classList.add('flipping');
        setTimeout(() => { $('.face', card).innerHTML = state.flipped ? f.back : f.front; card.classList.remove('flipping'); }, 90);
        if (state.flipped) { state.revealed = true; speak(w.headword); }
      },
      onCommit: (result) => answer(state, result),
    });
    cur = state; cardMs = 0;
    updateTop();
  }

  function answer(state, result) {
    if (ended || s.answered[state.qid]) return;          // double-registration guard
    const q = s.queue[state.i], w = words[q.wordId];
    const ms = Math.round(cardMs);
    const revealed = !!state.revealed;
    s.answered[q.qid] = { result, ms, revealed, at: Date.now() };
    if (result !== 'timeout') s.activeMs += ms;
    const entry = { i: state.i, qid: q.qid, wordId: w.id, snap: null, attemptIds: [] };
    undo.push(entry);
    busy = busy.then(async () => {
      if (result !== 'timeout') {
        entry.snap = await snapshotMastery(w.id, [q.skill]);
        const out = await recordAnswer({ sessionId: s.id, qid: q.qid, wordId: w.id, direction: q.direction, format: 'swipe', mode: 'quick', self: true, revealed, grade: result,
          prompt: q.direction === 'en2ja' ? w.headword : allMeanings(w).join('、'), answer: { know: 'わかる', vague: '曖昧', dont: 'わからない' }[result], ms,
          results: [{ skill: q.skill, correct: result !== 'dont', hint: result === 'vague' }] });
        entry.attemptIds = out._attemptIds;
        if (s.answered[q.qid]) s.answered[q.qid].change = out[q.skill];
      }
      s.updatedAt = Date.now();
      await db.put('sessions', s);
    }).catch((e) => toast('保存に失敗: ' + e.message));
    idx = nextIdx(state.i + 1);
    if (idx < 0) setTimeout(finish, 200); else showCard(idx);
  }

  function byButton(result) {
    if (!running || ended || !cur || cur.ctl.done) return;
    cur.ctl.commit(result);
  }
  function timeoutCard() {
    if (!cur || cur.ctl.done) return;
    cur.card.remove();
    answer(cur, 'timeout');
  }

  async function doUndo() {
    const e = undo.pop(); if (!e) return;
    await busy;
    if (e.snap) await undoAnswer(e.wordId, e.snap, e.attemptIds);
    const a = s.answered[e.qid];
    if (a && a.result !== 'timeout') s.activeMs -= a.ms;
    delete s.answered[e.qid];
    s.updatedAt = Date.now();
    await db.put('sessions', s);
    stage.innerHTML = ''; idx = e.i; showCard(idx); toast('取り消しました', 1000);
  }

  function setPaused(p) {
    if (ended) return;
    running = !p; last = performance.now();
    $('#pov', el).hidden = !p;
    $('#pause', el).textContent = p ? '▶︎' : '❚❚';
    if (p) { s.updatedAt = Date.now(); db.put('sessions', s); }
  }

  async function finish() {
    if (ended) return; ended = true; running = false;
    setCleanup(null);
    await busy;
    s.status = 'done'; s.endedAt = Date.now(); s.updatedAt = Date.now();
    await db.put('sessions', s);
    go(`#quick-result?id=${s.id}`);
  }

  const iv = setInterval(() => {
    const now = performance.now(), d = now - last; last = now;
    if (!running || ended) return;
    s.elapsedMs += d; cardMs += d;
    if (LIMIT && s.elapsedMs >= LIMIT) { s.elapsedMs = LIMIT; toast('時間になりました'); finish(); return; }
    if (CARD && cardMs >= CARD) timeoutCard();
    updateTop();
  }, 200);
  const onVis = () => { if (document.hidden && running) setPaused(true); };
  document.addEventListener('visibilitychange', onVis);
  setCleanup(() => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); document.body.classList.remove('noscroll'); if (!ended) { s.updatedAt = Date.now(); db.put('sessions', s); } });

  $('#pause', el).onclick = () => setPaused(running);
  $('#resume', el).onclick = () => setPaused(false);
  $('#quit', el).onclick = $('#quit2', el).onclick = () => { finish(); };   // results are already saved: no confirmation
  $('#undo', el).onclick = doUndo;
  el.querySelectorAll('.qb[data-r]').forEach((b) => (b.onclick = () => byButton(b.dataset.r)));
  showCard(idx);
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
  const dontIds = s.queue.filter((q) => s.answered[q.qid]?.result === 'dont' && words[q.wordId]).map((q) => q.wordId);
  const weakIds = s.queue.filter((q) => ['dont', 'vague'].includes(s.answered[q.qid]?.result) && words[q.wordId]).map((q) => q.wordId);
  const revealedKnow = Object.values(s.answered).filter((a) => a.result === 'know' && a.revealed).length;
  const lt = (l) => (l ? LEVEL_LABELS[l] : '判定保留');
  let cmp = '';
  if (prev) {
    const pk = counts(prev), d = rate(s) - rate(prev);
    cmp = `<div class="card small">前回（${new Date(prev.startedAt).toLocaleDateString('ja-JP')}）：わかる ${pk.know} / 曖昧 ${pk.vague || 0} / わからない ${pk.dont}・${rate(prev)}%　→　今回 ${rate(s)}%
      <b class="${d >= 0 ? 'up' : 'down'}">（${d >= 0 ? '+' : ''}${d}）</b></div>`;
  }
  el.innerHTML = `
    <header class="top"><a href="#quick" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
    <div class="donemark">${icon('check', 30)}<span>${c.know + c.vague + c.dont}枚 完了</span></div>
    <div class="stats stats4">
      <div class="stat"><b class="up">${c.know}</b><span>わかる</span></div>
      <div class="stat"><b class="mid">${c.vague}</b><span>曖昧</span></div>
      <div class="stat"><b class="down">${c.dont}</b><span>わからない</span></div>
      <div class="stat"><b>${c.unanswered}</b><span>未回答</span></div>
    </div>
    <p class="small muted center">わかる ${c.know} のうち、答えを見てから ${revealedKnow}・見ずに ${c.know - revealedKnow}</p>
    <div class="card stack" style="margin-top:10px">
      <div class="kv"><span>学習時間</span><b>${fmtClock(s.elapsedMs)}</b></div>
      <div class="kv"><span>1枚あたり平均</span><b>${avg.toFixed(1)}秒</b></div>
      <div class="kv"><span>方向</span><b>${QDIRS[s.config.direction].label}（${SKILL_LABELS[QDIRS[s.config.direction].skill]}の習得度に記録）</b></div>
    </div>
    ${cmp}
    ${dontIds.length ? `<button class="btn primary" id="again">わからなかった${dontIds.length}枚だけ再学習</button>` : ''}
    ${weakIds.length > dontIds.length ? `<button class="btn" id="again2" style="margin-top:8px">わからない＋曖昧の${weakIds.length}枚を再学習</button>` : ''}
    <h2 class="sec">カード一覧</h2>
    ${s.queue.map((q) => {
      const a = s.answered[q.qid], w = words[q.wordId]; if (!w) return '';
      const mk = !a || a.result === 'timeout' ? ['未', 'muted'] : a.result === 'know' ? [a.revealed ? '○見' : '○', 'ok'] : a.result === 'vague' ? ['△', 'near'] : ['✕', 'ng'];
      const ch = a?.change && a.change.before !== a.change.after ? `${lt(a.change.before)} → <b>${lt(a.change.after)}</b>` : '';
      return `<a class="rrow" href="#word?id=${w.id}"><span class="mk ${mk[1]}">${mk[0]}</span><span class="grow"><b>${esc(w.headword)}</b> <span class="small muted">${esc(allMeanings(w).slice(0, 2).join('、'))}</span></span><span class="small lvc">${ch}</span></a>`;
    }).join('')}
    <p class="hint">「○見」＝答えを表示してから「わかる」。習得度の判定では、自己申告の「わかる」は0.8回分、「曖昧」は0.4回分（連続正答はリセット）として数えます。自己申告だけでは「ほぼ習得」までで、「習得済み」にはテストでの正解と7日以上空けた正解が必要です。</p>
    <a class="btn" href="#quick" style="margin-top:12px">設定に戻る</a>`;
  const again = async (ids) => { const ns = await createQuick({ ...s.config, count: 'all' }, shuffle(ids.map((id) => words[id])), s.id); go(`#quick-run?id=${ns.id}`); };
  $('#again', el)?.addEventListener('click', () => again(dontIds));
  $('#again2', el)?.addEventListener('click', () => again(weakIds));
}

// One-tap start from Home / Review
export async function startQuick(overrides = {}) {
  const cfg = { ...QUICK_DEFAULTS, ...(await getSetting('quickLast', {})), ...overrides };
  const sel = await selectWords({ direction: cfg.direction, format: 'flash', levels: cfg.levels, order: cfg.order, bookmarkedOnly: cfg.bookmarkedOnly, recentWrong: cfg.recentWrong, tag: cfg.tag, deck: cfg.deck });
  if (!sel.list.length) { toast('対象の単語がありません'); return; }
  for (const x of await db.byIndex('sessions', 'status', 'active')) if (x.mode === 'quick') { x.status = 'done'; x.endedAt = Date.now(); await db.put('sessions', x); }
  const s = await createQuick(cfg, sel.list);
  go(`#quick-run?id=${s.id}`);
}
