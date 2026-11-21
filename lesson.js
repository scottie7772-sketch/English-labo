// Lessons (Duolingo-style): due reviews first, then new / learning items, in varying formats.
// A wrong item comes back 3 questions later in a different format (once).
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, go, speak } from './ui.js';
import { icon } from './icons.js';
import { L, curLang, langOf, numToMarks, isZh, langAttr } from './langs.js';
import { recordAnswer } from './judge.js';
import { loadAllMastery, effLevel } from './mastery.js';
import { showFeedback } from './feedback.js';
import { shuffle, allMeanings, checkTyping, diffHTML, normalize } from './study.js';
import { puzzles, visuals, swipeSets } from './content.js';
import { isSwipeable } from './verbswipe.js';
import { playGameItem } from './games.js';
import { QUALITY_JA } from './srs.js';
import { lessonStats, streakDays } from './progress.js';

const DAY = 86400000;
const FORMAT_JA = { mcR: '意味を選ぶ', mcP: '語句を選ぶ', type: '入力', audio: '聞いて意味', cloze: '穴埋め', swipe: 'Verb Swipe', puzzle: 'パズル', visual: '図解' };
const accepted = (w) => [...new Set((w.senses || []).flatMap((s) => s.accepted || []))];
const exampleOf = (w) => (w.senses || []).flatMap((s) => s.examples || []).find((x) => x.en || x.text);
const exText = (ex) => ex?.text || ex?.en || '';

export { lessonStats, streakDays };

export async function lessonScreen(el) {
  const lang = curLang();
  const st = await lessonStats(lang);
  const sk = await streakDays();
  const size = await getSetting('lessonSize', 12);
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>レッスン</h1><span class="grow"></span><span class="small muted">${L().name}</span></header>
    <section class="kpis">
      <div class="kpi"><b class="c-review">${st.due}</b><span>今日の復習</span></div>
      <div class="kpi"><b>${st.fresh}</b><span>未学習</span></div>
      <div class="kpi"><b>${icon('flame', 18)} ${sk.n}</b><span>連続日数</span></div>
    </section>
    <p class="hint">復習期限が来た語を先に出し、残りを新しい語・学習中の語で埋めます。形式（意味を選ぶ・語句を選ぶ・穴埋め・聞いて意味・入力${lang === 'en' ? '・パズル・Verb Swipe・図解' : ''}）は習得の段階に合わせて変わり、まちがえた語は数問後に別の形式でもう一度出ます。</p>
    <details class="card details"><summary>設定</summary>
      <div class="fgrp"><span>1レッスンの問題数</span><div class="seg" id="sz">${[8, 12, 15, 20].map((v) => `<button data-v="${v}" class="${size === v ? 'on' : ''}">${v}問</button>`).join('')}</div></div>
      <p class="hint">復習の間隔：まちがえた→当日中、正解→1日→3日→前回×2.5前後（ヒント・曖昧・遅い正解は短め）。予定日は単語の詳細画面で変更できます。</p>
    </details>
    <div class="actbar stack">
      <button class="btn" id="rev" ${st.due ? '' : 'disabled'}>復習だけ（${st.due}件）</button>
      <button class="btn primary big" id="go">${icon('lesson', 20)} レッスンを始める（${size}問）</button>
    </div>`;
  $('#go', el).onclick = () => go('#lesson-run');
  $('#rev', el).onclick = () => go('#lesson-run?only=review');
  $('#sz', el).onclick = async (e) => { const v = +e.target.dataset.v; if (!v) return; await setSetting('lessonSize', v); lessonScreen(el); };
}

// ---------- building the lesson ----------
function chooseFormat(w, rec, review, canSwipe, avoid) {
  const lv = (s) => effLevel(rec?.[s]);
  const tried = (s) => rec?.[s]?.stats?.attempts > 0;
  const hasEx = (() => { const t = exText(exampleOf(w)); return t && t.toLowerCase().includes(w.headword.toLowerCase()); })();
  let opts;
  if (!tried('recognition') || lv('recognition') && lv('recognition') < 3) opts = ['mcR', 'mcR', 'audio'];
  else if (!tried('select') || lv('select') < 3) opts = ['mcP', ...(hasEx ? ['cloze'] : []), ...(canSwipe ? ['swipe', 'swipe'] : [])];
  else opts = ['type', 'audio', ...(hasEx ? ['cloze'] : []), ...(canSwipe ? ['swipe'] : [])];
  const pool = opts.filter((f) => f !== avoid && f !== review?.lastFormat);
  return shuffle(pool.length ? pool : opts)[0];
}

async function buildLesson(lang, size, onlyReview, tag = null) {
  const [words0, revs, mastery] = await Promise.all([db.all('words'), db.all('reviews'), loadAllMastery()]);
  const words = words0.filter((w) => !w.slim && langOf(w) === lang && allMeanings(w).length && (!tag || (w.tags || []).includes(tag)));
  const R = Object.fromEntries(revs.map((r) => [r.id, r]));
  const now = Date.now();
  const sets = lang === 'en' ? await swipeSets().catch(() => null) : null;
  const q = [];
  const pushWord = (w) => q.push({ type: 'word', w, format: chooseFormat(w, mastery[w.id], R[w.id], sets && isSwipeable(w, sets)) });
  // 1) due words (most overdue first)
  words.filter((w) => R[w.id] && R[w.id].due <= now).sort((a, b) => R[a.id].due - R[b.id].due).slice(0, size).forEach(pushWord);
  // 2) English extras: due puzzles / visuals (and one new)
  let extras = [];
  if (lang === 'en' && !tag) {
    const [pz, vz] = await Promise.all([puzzles().catch(() => []), visuals().catch(() => [])]);
    const duePz = pz.filter((x) => R[x.id] && R[x.id].due <= now), dueVz = vz.filter((x) => R[x.id] && R[x.id].due <= now);
    extras = [...duePz.map((item) => ({ type: 'puzzle', item })), ...dueVz.map((item) => ({ type: 'visual', item }))];
    if (!onlyReview) {
      const np = shuffle(pz.filter((x) => !R[x.id]))[0], nv = shuffle(vz.filter((x) => !R[x.id]))[0];
      if (np) extras.push({ type: 'puzzle', item: np, fresh: true }); if (nv) extras.push({ type: 'visual', item: nv, fresh: true });
    }
    extras = extras.slice(0, Math.max(2, Math.round(size / 4)));
  }
  // 3) fill with learning (low level, scheduled later) and new words
  if (!onlyReview) {
    const inQ = new Set(q.map((x) => x.w.id));
    const learning = shuffle(words.filter((w) => !inQ.has(w.id) && R[w.id] && R[w.id].due > now && Math.min(...['recognition', 'recall'].map((s) => effLevel(mastery[w.id]?.[s]) || 1)) <= 3));
    const fresh = shuffle(words.filter((w) => !inQ.has(w.id) && !R[w.id]));
    const room = size - q.length - extras.length;
    const nNew = Math.min(fresh.length, Math.max(3, Math.ceil(room / 2)));
    [...fresh.slice(0, nNew), ...learning, ...fresh.slice(nNew)].slice(0, Math.max(0, room)).forEach(pushWord);
  }
  // interleave extras
  const out = q.slice(0, Math.max(0, size - extras.length));
  extras.forEach((x, k) => out.splice(Math.min(out.length, 2 + k * 3), 0, x));
  return { queue: out.slice(0, size), pool: words, sets };
}

// ---------- run ----------
export async function lessonRun(el, params) {
  const lang = curLang();
  const onlyReview = params.get('only') === 'review';
  const size = await getSetting('lessonSize', 12);
  const tag = params.get('tag');
  const { queue, pool } = await buildLesson(lang, size, onlyReview, tag);
  if (!queue.length) { el.innerHTML = `<header class="top"><a href="#lesson" class="back">${icon('back', 24)}</a><h1>レッスン</h1></header><p class="empty">${onlyReview ? '今日の復習はありません' : '出題できる語がありません。単語を追加してください'}</p>`; return; }
  const sid = uid('ln_');
  const total0 = queue.length;
  const res = [];
  const retried = new Set();
  let i = 0, combo = 0;

  const frame = () => {
    el.innerHTML = `<div class="qrun eye">
      <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button><span class="qcenter"><b>${Math.min(res.length + 1, queue.length)} / ${queue.length}</b><small id="fmt"></small></span><span class="combo" id="combo">${combo >= 3 ? `${icon('flame', 16)}${combo}` : ''}</span></header>
      <div class="progress"><i style="width:${(res.length / queue.length) * 100}%"></i></div>
      <div id="q"></div><div id="fb"></div></div>`;
    $('#quit', el).onclick = finish;
  };
  async function next() {
    if (i >= queue.length) return finish();
    const it = queue[i];
    frame();
    let ok;
    if (it.type === 'word') ok = await askWord(it);
    else { $('#fmt', el).textContent = FORMAT_JA[it.type]; ok = (await playGameItem(it.type, it.item, $('#q', el), $('#fb', el), { sid, mode: 'lesson' })).ok; }
    res.push({ it, ok });
    combo = ok ? combo + 1 : 0;
    // wrong -> again 3 questions later, in a different format (once)
    const key = it.type === 'word' ? it.w.id : it.item.id;
    if (!ok && !retried.has(key)) {
      retried.add(key);
      const alt = { mcR: 'audio', audio: 'mcR', mcP: 'mcR', cloze: 'mcP', type: 'mcP', swipe: 'mcP' }[it.format] || 'mcR';
      const again = it.type === 'word' ? { ...it, format: alt, retry: true } : { ...it, retry: true };
      queue.splice(Math.min(queue.length, i + 4), 0, again);
    }
    i++; next();
  }

  // one word question in the chosen format
  function askWord(it) {
    const { w } = it; let fmt = it.format;
    const meanings = allMeanings(w);
    const mean = meanings.join('、');
    const zh = isZh(langOf(w));
    const reading = zh && w.ipa ? `<div class="fc-read">${esc(numToMarks(w.ipa))}</div>` : '';
    const t0 = performance.now();
    const host = $('#q', el), fbHost = $('#fb', el);
    if (fmt === 'swipe') {
      $('#fmt', el).textContent = FORMAT_JA.swipe;
      return playGameItem('swipe', w, host, fbHost, { sid, mode: 'lesson', pool: pool.filter((x) => x.phrasal) }).then((r) => r.ok);
    }
    $('#fmt', el).textContent = FORMAT_JA[fmt] + (it.retry ? '・もう一度' : '');
    const others = shuffle(pool.filter((x) => x.id !== w.id && x.headword.toLowerCase() !== w.headword.toLowerCase() && !allMeanings(x).some((m) => meanings.includes(m))));
    const pickOpts = (lab) => { const seen = new Set([lab(w)]); const o = [w]; for (const x of others) { if (o.length >= 4) break; const l = lab(x); if (l && !seen.has(l)) { seen.add(l); o.push(x); } } return shuffle(o); };
    return new Promise((resolve) => {
      const finishQ = async ({ correct, near = false, reason = null, answer, skills, hint = false }) => {
        const ms = Math.round(performance.now() - t0);
        const out = await recordAnswer({ sessionId: sid, qid: `${w.id}:${i}`, wordId: w.id, direction: fmt, format: fmt === 'type' ? 'typing' : 'choice', mode: 'lesson', prompt: fmt === 'mcR' || fmt === 'audio' ? w.headword : mean, answer, ms,
          results: skills.map((s) => ({ skill: s.skill ?? s, correct: s.correct ?? correct, hint })), srs: { kind: 'word', lang: langOf(w), near } });
        const ex = exampleOf(w);
        const rv = out._review;
        speak(w.headword, 0.95, langOf(w));
        showFeedback(fbHost, {
          kind: correct ? 'ok' : near ? 'near' : 'ng',
          title: correct ? '正解' : near ? (reason === 'accent' ? '惜しい（アクセント記号）' : reason === 'tone' ? '惜しい（声調）' : '惜しい（スペル）') : '不正解',
          main: `<b class="tl">${esc(w.headword)}</b>${zh && w.ipa ? ` <span class="muted">${esc(numToMarks(w.ipa))}</span>` : ''}　${esc(mean)}`,
          sub: ex ? `${esc(exText(ex))}${ex.ja ? `<br><span class="muted">${esc(ex.ja)}</span>` : ''}` : '',
          more: rv ? `<span class="small muted">次の復習：${rv.intervalDays < 1 ? '今日中' : `${Math.round(rv.intervalDays)}日後`}（${QUALITY_JA[rv.quality]}）</span>` : '',
        }, () => resolve(correct));
      };
      const choiceUI = (promptHTML, opts, lab, isRight, skills) => {
        host.innerHTML = `<div class="lq lq-choice">${promptHTML}<div class="choices">${opts.map((o, k) => `<button class="choice" data-k="${k}"><span class="ctx ${lab === 'head' ? 'tl' : ''}">${esc(lab === 'head' ? o.headword : allMeanings(o).join('、'))}</span></button>`).join('')}</div></div>`;
        host.querySelector('.choices').onclick = (e) => {
          const b = e.target.closest('.choice'); if (!b || b.disabled) return;
          const o = opts[+b.dataset.k], correct = o === w;
          $$('.choice', host).forEach((x) => { x.disabled = true; x.classList.add(opts[+x.dataset.k] === w ? 'right' : x === b ? 'wrong' : 'dim'); });
          finishQ({ correct, answer: lab === 'head' ? o.headword : allMeanings(o).join('、'), skills });
        };
      };
      if (fmt === 'mcR') {
        choiceUI(`<div class="lq-prompt"><span class="small muted">意味は？</span><div class="fc-en">${esc(w.headword)}</div>${reading}<button class="icon-btn" id="say">${icon('speaker', 22)}</button></div>`, pickOpts((x) => allMeanings(x).join('、')), 'mean', null, ['recognition']);
        $('#say', host).onclick = () => speak(w.headword, 0.95, langOf(w));
      } else if (fmt === 'audio') {
        choiceUI(`<div class="lq-prompt"><span class="small muted">聞いて意味を選ぶ</span><button class="ls-play" id="say">${icon('speaker', 30)}</button></div>`, pickOpts((x) => allMeanings(x).join('、')), 'mean', null, ['listening']);
        $('#say', host).onclick = () => speak(w.headword, 0.9, langOf(w));
        setTimeout(() => speak(w.headword, 0.9, langOf(w)), 250);
      } else if (fmt === 'mcP') {
        choiceUI(`<div class="lq-prompt"><span class="small muted">${esc(L(langOf(w)).name)}は？</span><div class="fc-ja">${esc(mean)}</div></div>`, pickOpts((x) => x.headword.toLowerCase()), 'head', null, ['select']);
      } else if (fmt === 'cloze') {
        const ex = exampleOf(w); const t = exText(ex);
        const idx = t.toLowerCase().indexOf(w.headword.toLowerCase());
        const blanked = esc(t.slice(0, idx)) + '<span class="blank">＿＿＿</span>' + esc(t.slice(idx + w.headword.length));
        choiceUI(`<div class="lq-prompt"><span class="small muted">空欄に入るのは？</span><div class="cloze tl">${blanked}</div>${ex.ja ? `<div class="small muted">${esc(ex.ja)}</div>` : ''}</div>`, pickOpts((x) => x.headword.toLowerCase()), 'head', null, ['select']);
      } else {   // type
        host.innerHTML = `<div class="lq"><div class="lq-prompt"><span class="small muted">${esc(L(langOf(w)).name)}で入力</span><div class="fc-ja">${esc(mean)}</div></div>
          <form id="tf" class="stack"><input id="inp" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="${esc(L(langOf(w)).placeholder)}" ${langAttr(langOf(w))}>
          <div class="row"><button type="button" class="btn grow" id="dk">わからない</button><button class="btn primary grow">答え合わせ</button></div></form></div>`;
        const inp = $('#inp', host); setTimeout(() => inp.focus(), 50);
        const submit = (giveUp) => {
          const val = giveUp ? '' : inp.value;
          const r = checkTyping(val, [w.headword, ...accepted(w), ...(zh && w.ipa ? [w.ipa] : [])], false, langOf(w));
          inp.disabled = true; $$('button', host).forEach((b) => (b.disabled = true));
          if (r.result === 'near' && !r.reason) { const d = diffHTML(normalize(val, true), r.target); host.insertAdjacentHTML('beforeend', `<div class="diff"><div><span class="small muted">あなた</span> <code>${d.you}</code></div><div><span class="small muted">正しい</span> <code>${d.ok}</code></div></div>`); }
          const correct = r.result === 'correct', near = r.result === 'near';
          finishQ({ correct, near, reason: r.reason, answer: val || '（わからない）', skills: correct ? ['recall', 'spelling'] : near ? [{ skill: 'recall', correct: true }, { skill: 'spelling', correct: false }] : ['recall'] });
        };
        $('#tf', host).onsubmit = (e) => { e.preventDefault(); submit(false); };
        $('#dk', host).onclick = () => submit(true);
      }
    });
  }

  async function finish() {
    const ok = res.filter((r) => r.ok).length;
    const first = res.filter((r) => !r.it.retry);
    const sk = await streakDays();
    const label = (it) => it.type === 'word' ? `${it.w.headword}　${allMeanings(it.w).join('、')}` : it.type === 'puzzle' ? it.item.ja : it.item.phrase;
    el.innerHTML = `<header class="top"><a href="#lesson" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>レッスン完了</h1></header>
      <div class="donemark">${icon('check', 30)}<span>${res.length}問 ・ 1回目の正解 ${first.filter((r) => r.ok).length}/${first.length}</span></div>
      <section class="kpis"><div class="kpi"><b class="up">${ok}</b><span>正解</span></div><div class="kpi"><b class="down">${res.length - ok}</b><span>まちがい</span></div><div class="kpi"><b>${icon('flame', 18)} ${sk.n}</b><span>連続日数</span></div></section>
      <div class="card list">${res.map((r) => `<div class="rrow"><span class="mk ${r.ok ? 'ok' : 'ng'}">${r.ok ? '○' : '✕'}</span><span class="grow small">${esc(label(r.it))}${r.it.retry ? ' <span class="muted">（再出題）</span>' : ''}</span><span class="small muted">${FORMAT_JA[r.it.type === 'word' ? r.it.format : r.it.type]}</span></div>`).join('')}</div>
      <div class="row actbar"><a class="btn grow" href="#home">ホーム</a><a class="btn primary grow" href="#lesson-run?r=${Date.now()}">次のレッスン</a></div>`;
  }
  next();
}
