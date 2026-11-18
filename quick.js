// Quick Flashcards: swipe-based fast self-check (linked to mastery / attempts / sessions)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, speak } from './ui.js';
import { LEVEL_LABELS, SKILL_LABELS } from './mastery.js';
import { recordAnswer, snapshotMastery, undoAnswer } from './judge.js';
import { selectWords, shuffle, allMeanings } from './study.js';

const QDIRS = { en2ja: { label: '英→和', skill: 'recognition' }, ja2en: { label: '和→英', skill: 'recall' } };
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
  const know = v.filter((a) => a.result === 'know').length, dont = v.filter((a) => a.result === 'dont').length;
  return { know, dont, unanswered: s.queue.length - know - dont, timeout: v.filter((a) => a.result === 'timeout').length };
};
async function activeQuick() {
  return (await db.byIndex('sessions', 'status', 'active')).filter((x) => x.mode === 'quick').sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}
export const getSwipe = () => getSetting('quickSwipe', 'right'); // 'right' = 右スワイプで「覚えている」

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
      <header class="top"><a href="#study" class="back">‹</a><h1>⚡ Quick Flashcards</h1></header>
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
      <div class="card center target"><b>${n}</b> 枚　<span class="muted small">（対象 ${sel.list.length}語）</span></div>
      <p class="hint center">${swipe === 'right' ? '右' : '左'}スワイプ＝覚えている／${swipe === 'right' ? '左' : '右'}スワイプ＝わからない（<a class="link" href="#settings">設定で変更</a>）</p>
      <button class="btn primary" id="start" ${n ? '' : 'disabled'}>スタート</button>`;
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
  const knowRight = (await getSwipe()) === 'right';
  const cfg = s.config, LIMIT = limitMs(cfg), CARD = cardLimitMs(cfg);
  const undo = [];
  let idx = nextIdx(0), running = true, flipped = false, cardMs = 0, last = performance.now(), busy = Promise.resolve(), ended = false;

  function nextIdx(from) { for (let i = from; i < s.queue.length; i++) if (!s.answered[s.queue[i].qid] && words[s.queue[i].wordId]) return i; return -1; }
  if (idx < 0) return finish();

  el.innerHTML = `
    <header class="top qtop"><button class="link" id="quit">終了</button>
      <span class="grow center"><b id="clock" class="clock"></b></span>
      <button class="link" id="pause">一時停止</button></header>
    <div class="progress"><i id="prog"></i></div>
    <div class="row between small muted" style="margin:6px 2px"><span id="pos"></span><span id="tally"></span></div>
    <div class="cardbar"><i id="cbar"></i></div>
    <div class="qstage" id="stage"></div>
    <p class="hint center" id="guide">タップで裏返す・${knowRight ? '→ 覚えている　← わからない' : '← 覚えている　→ わからない'}</p>
    <div class="qbtns">${knowRight
      ? `<button class="btn qb dont" data-r="dont">✕ わからない</button><button class="btn qb" id="undo" aria-label="取り消し">↩︎</button><button class="btn qb know" data-r="know">○ 覚えている</button>`
      : `<button class="btn qb know" data-r="know">○ 覚えている</button><button class="btn qb" id="undo" aria-label="取り消し">↩︎</button><button class="btn qb dont" data-r="dont">✕ わからない</button>`}</div>
    <div class="pauseov" id="pov" hidden><div class="card center stack"><b>一時停止中</b><button class="btn primary" id="resume">再開</button><button class="btn" id="quit2">終了して結果へ</button></div></div>`;

  const stage = $('#stage', el);
  function updateTop() {
    const c = counts(s);
    $('#clock', el).textContent = LIMIT ? `残り ${fmtClock(LIMIT - s.elapsedMs)}` : fmtClock(s.elapsedMs);
    $('#prog', el).style.width = `${((s.queue.length - c.unanswered + c.timeout) / s.queue.length) * 100}%`;
    $('#pos', el).textContent = `${Math.min(s.queue.length, Object.keys(s.answered).length + 1)} / ${s.queue.length}`;
    $('#tally', el).textContent = `○${c.know}　✕${c.dont}${c.timeout ? '　未' + c.timeout : ''}`;
    $('#cbar', el).style.width = CARD ? `${Math.max(0, 100 - (cardMs / CARD) * 100)}%` : '0';
    $('#undo', el).disabled = !undo.length;
  }

  function showCard() {
    const q = s.queue[idx], w = words[q.wordId];
    flipped = false; cardMs = 0;
    const mean = esc(allMeanings(w).join('、'));
    const pos = [...new Set((w.senses || []).map((x) => POS_JA[x.pos] || x.pos).filter(Boolean))].join('・');
    const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
    const en = `<div class="fc-en">${esc(w.headword)}</div>`;
    const ja = `<div class="fc-ja">${mean}</div>${pos ? `<div class="q-sub">${esc(pos)}</div>` : ''}`;
    const exH = ex ? `<div class="fc-ex">${esc(ex.en)}${ex.ja ? `<br><span class="muted">${esc(ex.ja)}</span>` : ''}</div>` : '';
    const front = cfg.direction === 'en2ja' ? en : ja;
    const back = cfg.direction === 'en2ja' ? `${en}${ja}${exH}` : `${ja}${en}${exH}`;
    stage.innerHTML = `<div class="fcard" id="card"><span class="stamp know">覚えている</span><span class="stamp dont">わからない</span>
      <div class="face" id="face">${front}</div></div>`;
    const card = $('#card', stage);
    card._front = front; card._back = back;
    attachSwipe(card);
    updateTop();
  }
  function flip() {
    const card = $('#card', stage); if (!card) return;
    flipped = !flipped;
    card.classList.add('flipping');
    setTimeout(() => { $('#face', card).innerHTML = flipped ? card._back : card._front; card.classList.remove('flipping'); }, 120);
    if (flipped) speak(words[s.queue[idx].wordId].headword);
  }

  function attachSwipe(card) {
    let x0 = 0, y0 = 0, dx = 0, dy = 0, down = false;
    card.addEventListener('pointerdown', (e) => { if (!running) return; down = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; });
    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      const knowSide = knowRight ? dx > 0 : dx < 0;
      card.classList.toggle('to-know', Math.abs(dx) > 30 && knowSide);
      card.classList.toggle('to-dont', Math.abs(dx) > 30 && !knowSide);
    });
    const end = () => {
      if (!down) return; down = false;
      card.style.transition = '';
      if (Math.abs(dx) > 90) answer((dx > 0) === knowRight ? 'know' : 'dont', dx > 0 ? 1 : -1);
      else { card.style.transform = ''; card.classList.remove('to-know', 'to-dont'); if (Math.abs(dx) < 8 && Math.abs(dy) < 8) flip(); }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function answer(result, dir) {
    if (!running || ended || idx < 0) return;
    const q = s.queue[idx], w = words[q.wordId];
    const ms = Math.round(cardMs);
    const card = $('#card', stage);
    if (card && result !== 'timeout') {
      const side = dir ?? ((result === 'know') === knowRight ? 1 : -1);
      card.classList.add(result === 'know' ? 'to-know' : 'to-dont');
      card.style.transform = `translateX(${side * 140}%) rotate(${side * 20}deg)`; card.style.opacity = '0';
    }
    s.answered[q.qid] = { result, ms, flipped, at: Date.now() };
    s.activeMs += result === 'timeout' ? 0 : ms;
    const entry = { idx, qid: q.qid, wordId: w.id, snap: null, attemptIds: [] };
    undo.push(entry);
    // save immediately (serialized so Undo always sees finished writes)
    busy = busy.then(async () => {
      if (result !== 'timeout') {
        entry.snap = await snapshotMastery(w.id, [q.skill]);
        const out = await recordAnswer({ sessionId: s.id, qid: q.qid, wordId: w.id, direction: q.direction, format: 'swipe', mode: 'quick', self: true,
          prompt: q.direction === 'en2ja' ? w.headword : allMeanings(w).join('、'), answer: result === 'know' ? '覚えている' : 'わからない', ms,
          results: [{ skill: q.skill, correct: result === 'know', hint: false }] });
        entry.attemptIds = out._attemptIds;
        s.answered[q.qid].change = out[q.skill];
      }
      s.updatedAt = Date.now();
      await db.put('sessions', s);
    }).catch((e) => toast('保存に失敗: ' + e.message));
    idx = nextIdx(idx + 1);
    setTimeout(() => (idx < 0 ? finish() : showCard()), result === 'timeout' ? 0 : 160);
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
    idx = e.idx; showCard(); toast('取り消しました', 1200);
  }

  function setPaused(p) {
    if (ended) return;
    running = !p; last = performance.now();
    $('#pov', el).hidden = !p;
    $('#pause', el).textContent = p ? '再開' : '一時停止';
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

  // timers
  const iv = setInterval(() => {
    const now = performance.now(), d = now - last; last = now;
    if (!running || ended) return;
    s.elapsedMs += d; cardMs += d;
    if (LIMIT && s.elapsedMs >= LIMIT) { s.elapsedMs = LIMIT; toast('時間になりました'); finish(); return; }
    if (CARD && cardMs >= CARD) answer('timeout');
    updateTop();
  }, 200);
  const onVis = () => { if (document.hidden && running) setPaused(true); };
  document.addEventListener('visibilitychange', onVis);
  setCleanup(() => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); if (!ended) { s.updatedAt = Date.now(); db.put('sessions', s); } });

  $('#pause', el).onclick = () => setPaused(running);
  $('#resume', el).onclick = () => setPaused(false);
  $('#quit', el).onclick = $('#quit2', el).onclick = async () => {
    setPaused(true);
    if (await confirmDialog({ title: '終了しますか？', body: '<p>ここまでの結果は保存されています。残りは未回答になります。</p>', okLabel: '終了して結果へ', cancelLabel: '続ける' })) finish();
  };
  $('#undo', el).onclick = doUndo;
  el.querySelectorAll('.qb[data-r]').forEach((b) => (b.onclick = () => answer(b.dataset.r)));
  showCard();
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
  const rate = (x) => { const k = counts(x); return k.know + k.dont ? Math.round((k.know / (k.know + k.dont)) * 100) : 0; };
  const dontIds = s.queue.filter((q) => s.answered[q.qid]?.result === 'dont' && words[q.wordId]).map((q) => q.wordId);
  const lt = (l) => (l ? LEVEL_LABELS[l] : '判定保留');
  let cmp = '';
  if (prev) {
    const pk = counts(prev), d = rate(s) - rate(prev);
    cmp = `<div class="card small">前回（${new Date(prev.startedAt).toLocaleDateString('ja-JP')}）：覚えている ${pk.know} / わからない ${pk.dont}・${rate(prev)}%　→　今回 ${rate(s)}%
      <b class="${d >= 0 ? 'up' : 'down'}">（${d >= 0 ? '+' : ''}${d}）</b></div>`;
  }
  el.innerHTML = `
    <header class="top"><a href="#quick" class="back">‹</a><h1>結果</h1></header>
    <div class="stats">
      <div class="stat"><b class="up">${c.know}</b><span>覚えている</span></div>
      <div class="stat"><b class="down">${c.dont}</b><span>わからない</span></div>
      <div class="stat"><b>${c.unanswered}</b><span>未回答</span></div>
    </div>
    <div class="card stack" style="margin-top:10px">
      <div class="kv"><span>学習時間</span><b>${fmtClock(s.elapsedMs)}</b></div>
      <div class="kv"><span>1枚あたり平均</span><b>${avg.toFixed(1)}秒</b></div>
      <div class="kv"><span>方向</span><b>${QDIRS[s.config.direction].label}（${SKILL_LABELS[QDIRS[s.config.direction].skill]}の習得度に記録）</b></div>
    </div>
    ${cmp}
    ${dontIds.length ? `<button class="btn primary" id="again">わからなかった${dontIds.length}枚だけ再学習</button>` : ''}
    <h2 class="sec">カード一覧</h2>
    ${s.queue.map((q) => {
      const a = s.answered[q.qid], w = words[q.wordId]; if (!w) return '';
      const mk = !a || a.result === 'timeout' ? ['未', 'muted'] : a.result === 'know' ? ['○', 'ok'] : ['✕', 'ng'];
      const ch = a?.change && a.change.before !== a.change.after ? `${lt(a.change.before)} → <b>${lt(a.change.after)}</b>` : '';
      return `<a class="rrow" href="#word?id=${w.id}"><span class="mk ${mk[1]}">${mk[0]}</span><span class="grow"><b>${esc(w.headword)}</b> <span class="small muted">${esc(allMeanings(w).slice(0, 2).join('、'))}</span></span><span class="small lvc">${ch}</span></a>`;
    }).join('')}
    <p class="hint">「覚えている」は自己申告なので、習得度の判定では0.8回分として数えます。自己申告だけでは「ほぼ習得」までで、「習得済み」になるにはテストでの正解と、7日以上空けた復習での正解が必要です。</p>
    <a class="btn" href="#quick" style="margin-top:12px">設定に戻る</a>`;
  $('#again', el)?.addEventListener('click', async () => {
    const ns = await createQuick({ ...s.config, count: 'all' }, shuffle(dontIds.map((id) => words[id])), s.id);
    go(`#quick-run?id=${ns.id}`);
  });
}
