// Listening Lab: hear a short text / dialogue, hold it in mind, answer questions about it.
// "Understood by listening" and "understood by reading the script" are recorded separately.
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, go, speak } from './ui.js';
import { icon } from './icons.js';
import { L, curLang } from './langs.js';
import { recordAnswer } from './judge.js';
import { listeningItems } from './content.js';
import { shuffle } from './study.js';
import { pickWordsDialog } from './pick.js';

const KIND_JA = { number: '数字', day: '曜日', time: '時刻', purpose: '目的', request: '依頼', place: '場所', reason: '理由' };
const LEVEL_JA = { 1: '1文', 2: '2〜3文', 3: '会話' };
const DEF = { level: 0, range: 'auto', count: 5, plays: 2, rate: 0.95, script: false, gap: 0.6 };

export async function listeningScreen(el) {
  const lang = curLang();
  let items = [];
  try { items = await listeningItems(lang); } catch { el.innerHTML = '<div class="card warn">問題データを読み込めませんでした（初回はネット接続が必要です）</div>'; return; }
  const prog = Object.fromEntries((await db.all('listening')).map((p) => [p.id, p]));
  const cfg = { ...DEF, ...(await getSetting('listenCfg', {})) };
  const pick = () => items.filter((x) => (!cfg.level || x.level === cfg.level) && (cfg.range === 'all' ? true : cfg.range === 'wrong' ? prog[x.id] && !prog[x.id].lastListenOk : cfg.range === 'new' ? !prog[x.id] : !prog[x.id]?.lastListenOk));
  // stats: listening vs reading
  const ps = Object.values(prog).filter((p) => items.some((x) => x.id === p.id));
  const listenOk = ps.filter((p) => p.lastListenOk).length, readOk = ps.filter((p) => !p.lastListenOk && p.lastReadOk).length, both = ps.filter((p) => !p.lastListenOk && p.lastReadOk === false).length;
  const kindStats = {};
  for (const p of ps) for (const [k, v] of Object.entries(p.kinds || {})) { kindStats[k] ||= { n: 0, ok: 0 }; kindStats[k].n += v.n; kindStats[k].ok += v.ok; }
  const chips = (id, arr, cur) => `<div class="chips" id="${id}">${arr.map(([v, l]) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  function draw() {
    const list = pick();
    el.innerHTML = `
      <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>リスニング</h1><span class="grow"></span><span class="small muted">${L().name}</span></header>
      <p class="hint">短い英文や会話を聞いて、数字・曜日・目的・依頼などを答えます。答えたあとにスクリプトを読み、「読めば分かったか」も記録して、聞き取りの問題か語彙・文法の問題かを分けます。</p>
      ${ps.length ? `<div class="card stack">
        <div class="kv"><span>聞いて正解</span><b class="up">${listenOk}</b></div>
        <div class="kv"><span>聞き取れず・読めば分かった（音の問題）</span><b class="mid">${readOk}</b></div>
        <div class="kv"><span>読んでも分からなかった（語彙・文法）</span><b class="down">${both}</b></div>
        ${Object.keys(kindStats).length ? `<div class="small muted">設問別の正答率：${Object.entries(kindStats).map(([k, v]) => `${KIND_JA[k] || k} ${Math.round((v.ok / v.n) * 100)}%`).join('・')}</div>` : ''}
      </div>` : ''}
      <div class="setlist">
        <div class="setrow"><span class="setlabel">長さ</span>${chips('lv', [[0, 'すべて'], [1, '1文'], [2, '2〜3文'], [3, '会話']], cfg.level)}</div>
        <div class="setrow"><span class="setlabel">範囲</span>${chips('rg', [['auto', 'まだ聞き取れていない'], ['new', '未回答'], ['wrong', '前回まちがえた'], ['all', 'すべて']], cfg.range)}</div>
        <div class="setrow"><span class="setlabel">問題数</span>${chips('ct', [[5, '5問'], [10, '10問'], [0, '全部']], cfg.count)}</div>
      </div>
      <details class="card details"><summary>詳細設定<span class="muted small">　再生回数・速度・スクリプト</span></summary>
        <div class="fgrp"><span>答える前に聞ける回数</span>${chips('pl', [[1, '1回'], [2, '2回'], [3, '3回'], [0, '制限なし']], cfg.plays)}</div>
        <div class="fgrp"><span>音声の速さ</span>${chips('rt', [[0.75, '0.75'], [0.85, '0.85'], [0.95, '標準'], [1.1, '1.1']], cfg.rate)}</div>
        <label class="chk"><input type="checkbox" id="sc" ${cfg.script ? 'checked' : ''}> 最初からスクリプトを表示（読解の記録になります）</label>
      </details>
      <div class="cta-bar"><div class="cta-count"><b>${Math.min(list.length, cfg.count || list.length)}</b><span>問</span></div><button class="btn primary cta" id="start" ${list.length ? '' : 'disabled'}>スタート</button></div>`;
    const bind = (id, key) => ($('#' + id, el).onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v == null) return; cfg[key] = isNaN(+v) ? v : +v; setSetting('listenCfg', cfg); draw(); });
    bind('lv', 'level'); bind('rg', 'range'); bind('ct', 'count'); bind('pl', 'plays'); bind('rt', 'rate');
    $('#sc', el).onchange = (e) => { cfg.script = e.target.checked; setSetting('listenCfg', cfg); };
    $('#start', el).onclick = () => {
      let q = shuffle(pick()); if (cfg.count) q = q.slice(0, cfg.count);
      sessionStorage.setItem('listenQueue', JSON.stringify({ lang, ids: q.map((x) => x.id), sid: uid('ls_') }));
      go('#listening-run');
    };
  }
  draw();
}

// play all lines in order; B speaker gets a different pitch
function playLines(item, rate, onEnd) {
  speechSynthesis.cancel();
  let k = 0;
  const next = () => {
    if (k >= item.lines.length) return onEnd?.();
    const ln = item.lines[k++];
    speak(ln.text, rate, item.lang, { pitch: ln.who === 'B' ? 1.3 : 0.95, queue: true, onend: () => setTimeout(next, 350) });
  };
  next();
}

export async function listeningRun(el) {
  const st = JSON.parse(sessionStorage.getItem('listenQueue') || 'null');
  if (!st) return go('#listening');
  const lang = st.lang;
  const cfg = { ...DEF, ...(await getSetting('listenCfg', {})) };
  const all = Object.fromEntries((await listeningItems(lang)).map((x) => [x.id, x]));
  const queue = st.ids.map((id) => all[id]).filter(Boolean);
  const results = [];
  let i = 0;

  function show() {
    if (i >= queue.length) return finish();
    const it = queue[i];
    let plays = 0, answered = false, scriptShown = cfg.script, t0 = performance.now(), playing = false;
    const picks = {};
    el.innerHTML = `
      <div class="qrun">
      <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button><span class="qcenter"><b>${i + 1} / ${queue.length}</b><small>リスニング・${LEVEL_JA[it.level]}</small></span><span style="width:40px"></span></header>
      <div class="progress"><i style="width:${(i / queue.length) * 100}%"></i></div>
      <div class="ls-player">
        <button class="ls-play" id="play" aria-label="再生">${icon('play', 34)}</button>
        <div class="small muted" id="plays"></div>
        <div class="seg sm" id="rate">${[0.75, 0.85, 0.95, 1.1].map((r) => `<button data-v="${r}" class="${cfg.rate === r ? 'on' : ''}">${r === 0.95 ? '1.0' : r}</button>`).join('')}</div>
      </div>
      <div class="ls-script ${scriptShown ? '' : 'hidden'}" id="script"></div>
      <button class="link small" id="showScript">${scriptShown ? '' : 'スクリプトを見る（読解として記録）'}</button>
      <div id="qs">${it.qs.map((q, qi) => `<div class="ls-q"><div class="ls-qt"><span class="kchip">${KIND_JA[q.kind] || ''}</span>${esc(q.ja)}</div>
        <div class="choices">${q.choices.map((c, ci) => `<button class="choice" data-q="${qi}" data-c="${ci}"><span class="ctx">${esc(c)}</span></button>`).join('')}</div></div>`).join('')}</div>
      <div id="fb"></div></div>`;
    const drawScript = (withJa) => {
      $('#script', el).innerHTML = it.lines.map((ln, li) => `<div class="ls-line">${it.lines.length > 1 ? `<b class="who">${ln.who}</b>` : ''}<span class="grow"><span class="ls-t" ${lang === 'zh-TW' ? 'lang="zh-Hant-TW"' : ''}>${esc(ln.text)}</span>${withJa ? `<span class="small muted ls-ja">${esc(ln.ja)}</span>` : ''}</span>${withJa ? `<button class="cbtn" data-pick="${li}">＋語</button>` : ''}</div>`).join('');
    };
    drawScript(false);
    const updPlays = () => { $('#plays', el).textContent = cfg.plays && !answered ? `あと${Math.max(0, cfg.plays - plays)}回` : `${plays}回再生`; $('#play', el).disabled = !answered && cfg.plays && plays >= cfg.plays; };
    updPlays();
    $('#play', el).onclick = () => {
      if (playing) { speechSynthesis.cancel(); playing = false; $('#play', el).innerHTML = icon('play', 34); return; }
      if (!answered && cfg.plays && plays >= cfg.plays) return;
      plays++; playing = true; $('#play', el).innerHTML = icon('pause', 34); updPlays();
      playLines(it, cfg.rate, () => { playing = false; const b = $('#play', el); if (b) b.innerHTML = icon('play', 34); });
    };
    $('#rate', el).onclick = (e) => { const v = e.target.dataset.v; if (!v) return; cfg.rate = +v; setSetting('listenCfg', cfg); $$('#rate button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); };
    $('#showScript', el).onclick = () => { scriptShown = true; $('#script', el).classList.remove('hidden'); $('#showScript', el).textContent = ''; };
    $('#quit', el).onclick = () => { speechSynthesis.cancel(); finish(); };
    $('#qs', el).onclick = (e) => {
      const b = e.target.closest('.choice'); if (!b || answered) return;
      const qi = +b.dataset.q; if (picks[qi] != null) return;
      picks[qi] = +b.dataset.c;
      $$(`.choice[data-q="${qi}"]`, el).forEach((x) => x.classList.toggle('picked', x === b));
      if (Object.keys(picks).length === it.qs.length) submit();
    };
    setTimeout(() => $('#play', el)?.click(), 300);

    async function submit() {
      answered = true; speechSynthesis.cancel(); updPlays();
      const ms = Math.round(performance.now() - t0);
      const okAll = it.qs.every((q, qi) => picks[qi] === q.answer);
      it.qs.forEach((q, qi) => $$(`.choice[data-q="${qi}"]`, el).forEach((x) => { const c = +x.dataset.c; x.classList.add(c === q.answer ? 'right' : c === picks[qi] ? 'wrong' : 'dim'); x.disabled = true; }));
      const viaReading = scriptShown;  // answered while looking at the script = reading comprehension
      const skill = viaReading ? 'reading' : 'listening';
      await recordAnswer({ sessionId: st.sid, qid: it.id + ':' + i, wordId: it.id, direction: 'audio', format: 'listening', mode: 'listening', prompt: it.lines.map((l) => l.text).join(' / '), answer: it.qs.map((q, qi) => q.choices[picks[qi]]).join(' / '), ms,
        results: [{ skill, correct: okAll, hint: plays > 2 }], srs: viaReading ? false : { kind: 'listening', lang }, sub: { plays, kinds: it.qs.map((q, qi) => [q.kind, picks[qi] === q.answer]) } });
      const p = (await db.get('listening', it.id)) || { id: it.id, lang, attempts: 0, history: [], kinds: {} };
      p.attempts++; p.lastAt = Date.now();
      if (!viaReading) p.lastListenOk = okAll;
      it.qs.forEach((q, qi) => { p.kinds[q.kind] ||= { n: 0, ok: 0 }; p.kinds[q.kind].n++; if (picks[qi] === q.answer) p.kinds[q.kind].ok++; });
      const entry = { at: Date.now(), ok: okAll, plays, viaReading, readOk: null };
      p.history = [...p.history, entry].slice(-20);
      await db.put('listening', p);
      results.push({ id: it.id, ok: okAll, viaReading, readOk: null });
      // reveal script with translation; ask whether reading made it clear
      scriptShown = true; $('#script', el).classList.remove('hidden'); $('#showScript', el).textContent = ''; drawScript(true);
      $('#script', el).onclick = async (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; const ln = it.lines[+b.dataset.pick]; await pickWordsDialog({ text: ln.text, ja: ln.ja, lang, source: { type: 'listening', itemId: it.id }, title: '聞き取れなかった語句を登録' }); };
      const fb = $('#fb', el);
      fb.innerHTML = `<div class="fbbar ${okAll ? 'ok' : 'ng'}"><div class="fbbar-head">${icon(okAll ? 'check' : 'close', 22)}<b>${okAll ? (viaReading ? '正解（スクリプトを見て）' : '正解') : '不正解'}</b></div>
        ${okAll && !viaReading ? '' : `<div class="fbbar-sub">スクリプトを読んで、内容は分かりましたか？</div><div class="row"><button class="btn grow" data-r="1">読めば分かった</button><button class="btn grow" data-r="0">読んでも分からない</button></div>`}
        <div class="row"><button class="btn grow" id="again">${icon('speaker', 18)} もう一度聞く</button><button class="btn primary grow" id="fbNext">次へ</button></div></div>`;
      fb.querySelectorAll('[data-r]').forEach((b) => (b.onclick = async () => {
        const ok = b.dataset.r === '1';
        entry.readOk = ok; p.lastReadOk = ok; results[results.length - 1].readOk = ok; await db.put('listening', p);
        await recordAnswer({ sessionId: st.sid, qid: it.id + ':r' + i, wordId: it.id, direction: 'text', format: 'reading', mode: 'listening', prompt: '', answer: ok ? '読めば分かった' : '読んでも分からない', ms: 0, self: true, results: [{ skill: 'reading', correct: ok, hint: false }], srs: false });
        fb.querySelectorAll('[data-r]').forEach((x) => { x.disabled = true; x.classList.toggle('on', x === b); });
      }));
      $('#again', el).onclick = () => playLines(it, cfg.rate);
      $('#fbNext', el).onclick = () => { speechSynthesis.cancel(); i++; show(); };
    }
  }
  function finish() {
    speechSynthesis.cancel();
    const ok = results.filter((r) => r.ok && !r.viaReading).length;
    const sound = results.filter((r) => !r.ok && r.readOk === true).length;
    const vocab = results.filter((r) => !r.ok && r.readOk === false).length;
    const wrong = results.filter((r) => !r.ok).map((r) => r.id);
    el.innerHTML = `
      <header class="top"><a href="#listening" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
      <div class="donemark">${icon('check', 30)}<span>${results.length}問 完了</span></div>
      <div class="stats"><div class="stat"><b class="up">${ok}</b><span>聞いて正解</span></div><div class="stat"><b class="mid">${sound}</b><span>音の問題</span></div><div class="stat"><b class="down">${vocab}</b><span>語彙・文法</span></div></div>
      <p class="hint">「音の問題」＝読めば分かった（聞き取りを練習）／「語彙・文法」＝読んでも分からなかった（語句を登録して覚える）</p>
      ${wrong.length ? '<button class="btn primary" id="again">まちがえた問題をもう一度</button>' : ''}
      <div class="card list">${results.map((r) => `<div class="rrow"><span class="mk ${r.ok ? 'ok' : 'ng'}">${r.ok ? '○' : '✕'}</span><span class="grow small">${esc(all[r.id].lines.map((l) => l.text).join(' '))}</span></div>`).join('')}</div>
      <a class="btn" href="#listening" style="margin-top:12px">リスニングに戻る</a>`;
    $('#again', el)?.addEventListener('click', () => { sessionStorage.setItem('listenQueue', JSON.stringify({ lang, ids: wrong, sid: uid('ls_') })); listeningRun(el); });
  }
  show();
}
