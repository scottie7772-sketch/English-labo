// Mini games: chunk puzzle / Verb Swipe / visual prepositions. All answers go through recordAnswer (mastery + review schedule).
import { db, uid, getSetting, setSetting } from './db.js';
import { $, esc, toast, go, speak } from './ui.js';
import { icon } from './icons.js';
import { curLang, langOf } from './langs.js';
import { recordAnswer } from './judge.js';
import { puzzles, visuals, swipeSets } from './content.js';
import { renderPuzzle } from './puzzle.js';
import { renderVerbSwipe, isSwipeable, VS_DEFAULTS } from './verbswipe.js';
import { renderVisual, sceneSVG } from './prepviz.js';
import { showFeedback } from './feedback.js';
import { shuffle, allMeanings } from './study.js';

export const GAMES = {
  puzzle: { name: '語順・チャンクパズル', icon: 'puzzle', desc: 'タイルを並べて文を作る' },
  swipe: { name: 'Verb Swipe', icon: 'swipe', desc: '動詞を長押し→小辞へスワイプ' },
  visual: { name: '前置詞の図解', icon: 'path', desc: '動きの図から前置詞を選ぶ' },
};

// order: due first, then never answered, then the rest (random within groups)
async function orderByReview(items) {
  const revs = Object.fromEntries((await db.all('reviews')).map((r) => [r.id, r]));
  const now = Date.now();
  const due = shuffle(items.filter((x) => revs[x.id] && revs[x.id].due <= now));
  const fresh = shuffle(items.filter((x) => !revs[x.id]));
  const rest = items.filter((x) => revs[x.id] && revs[x.id].due > now).sort((a, b) => revs[a.id].due - revs[b.id].due);
  return { list: [...due, ...fresh, ...rest], due: due.length, fresh: fresh.length };
}
export async function gameItems(type) {
  if (type === 'puzzle') return puzzles();
  if (type === 'visual') return visuals();
  const sets = await swipeSets();
  return (await db.all('words')).filter((w) => langOf(w) === 'en' && isSwipeable(w, sets));
}

export async function gamesScreen(el) {
  const counts = {};
  for (const k of Object.keys(GAMES)) { try { counts[k] = await orderByReview(await gameItems(k)); } catch { counts[k] = null; } }
  const vsLevel = await getSetting('vsLevel', 4);
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>ゲーム</h1></header>
    ${curLang() !== 'en' ? '<p class="notice info">ゲームの教材は今は英語だけです（スペイン語・華語はレッスン・単語帳・瞬間作文・リスニングで学べます）</p>' : ''}
    <nav class="menu">${Object.entries(GAMES).map(([k, g]) => {
      const c = counts[k];
      return `<a class="mitem" href="#game?type=${k}">${icon(g.icon, 22)}<span class="grow"><b>${g.name}</b><small>${c ? `${c.list.length}問・復習${c.due}・未挑戦${c.fresh}` : '読み込めません'}</small></span>${icon('chevron', 18)}</a>`;
    }).join('')}</nav>
    <details class="card details"><summary>Verb Swipe の設定</summary>
      <div class="fgrp"><span>使う方向</span><div class="seg" id="vsl"><button data-v="4" class="${vsLevel === 4 ? 'on' : ''}">4方向（初級）</button><button data-v="8" class="${vsLevel === 8 ? 'on' : ''}">8方向</button></div></div>
      <div class="fgrp"><span>長押しの時間</span><div class="seg" id="vsp">${[0.2, 0.28, 0.4, 0.6].map((v) => `<button data-v="${v}">${v}秒</button>`).join('')}</div></div>
      <p class="hint">セットA：上 up／下 down／左 in／右 out／右上 over／右下 off／左上 on／左下 through。セットB：左 back／右 away ほか固定。</p>
    </details>
    <p class="hint">教材はAI作成・未検証です。誤りに気づいたら教えてください。</p>`;
  const press = await getSetting('vsPress', VS_DEFAULTS.pressMs);
  el.querySelectorAll('#vsp button').forEach((b) => b.classList.toggle('on', +b.dataset.v * 1000 === press));
  $('#vsl', el).onclick = async (e) => { const v = +e.target.dataset.v; if (!v) return; await setSetting('vsLevel', v); gamesScreen(el); };
  $('#vsp', el).onclick = async (e) => { const v = +e.target.dataset.v; if (!v) return; await setSetting('vsPress', Math.round(v * 1000)); gamesScreen(el); };
}

// one game question; shared with lessons. returns a Promise of { ok }
export async function playGameItem(type, item, host, fbHost, ctx = {}) {
  const sid = ctx.sid || uid('g_');
  return new Promise(async (resolve) => {
    const done = async (r, rec, fb) => {
      await recordAnswer({ sessionId: sid, qid: `${item.id}:${Date.now()}`, ...rec, ms: r.ms, mode: ctx.mode || 'game' });
      showFeedback(fbHost, fb, () => resolve({ ok: r.ok }));
    };
    if (type === 'puzzle') {
      renderPuzzle(host, item, (r) => (speak(r.target, 0.9, item.lang || 'en'), done(r,
        { wordId: item.id, direction: 'ja2x', format: 'puzzle', prompt: item.ja, answer: r.answer, results: [{ skill: item.unit === 'word' ? 'produce' : 'build', correct: r.ok, hint: false }], srs: { kind: 'puzzle', lang: item.lang || 'en' }, sub: { wrongPositions: r.wrongPositions } },
        { kind: r.ok ? 'ok' : 'ng', title: r.ok ? '正解' : '不正解', main: `<b>${esc(r.target)}</b>`, sub: esc(item.explain || ''), more: item.explainMore ? esc(item.explainMore) : '' })));
    } else if (type === 'swipe') {
      const sets = await swipeSets();
      const pool = ctx.pool || (await gameItems('swipe'));
      const opt = { level: await getSetting('vsLevel', 4), pressMs: await getSetting('vsPress', VS_DEFAULTS.pressMs) };
      renderVerbSwipe(host, item, pool, sets, (r) => {
        const real = !r.ok && pool.find((w) => w.phrasal && `${w.phrasal.verb} ${w.phrasal.particles[0]}` === r.said);
        speak(r.target);
        done(r,
          { wordId: item.id, direction: 'ja2en', format: 'verbswipe', prompt: allMeanings(item).join('、'), answer: r.said, results: [{ skill: 'build', correct: r.ok, hint: false }], sub: { verbOk: r.verbOk, particleOk: r.particleOk, verb: r.verb, particle: r.particle, pressMs: r.pressMs } },
          { kind: r.ok ? 'ok' : 'ng', title: r.ok ? '正解' : r.verbOk ? '動詞は合っています' : r.particleOk ? '小辞は合っています' : '不正解',
            main: `<b>${esc(r.target)}</b>　${esc(allMeanings(item).join('、'))}`,
            sub: `${r.example ? esc(r.example.en) + (r.example.ja ? `<br><span class="muted">${esc(r.example.ja)}</span>` : '') : ''}${real ? `<br><span class="small">${esc(r.said)} は「${esc(allMeanings(real).join('、'))}」</span>` : ''}` });
      }, opt);
    } else if (type === 'visual') {
      const all = ctx.pool || (await visuals());
      renderVisual(host, item, all, (r) => { speak(item.phrase); done(r,
        { wordId: item.id, direction: 'img', format: 'visual-' + r.format, prompt: item.phrase, answer: r.answer, results: [{ skill: 'select', correct: r.ok, hint: false }], srs: { kind: 'visual', lang: 'en' } },
        { kind: r.ok ? 'ok' : 'ng', title: r.ok ? '正解' : '不正解', main: `<b>${esc(item.phrase)}</b>　${esc(item.ja)}`, sub: r.format === 'prep2img' ? '' : '' }); });
    }
  });
}

export async function gameRun(el, params) {
  const type = params.get('type');
  if (!GAMES[type]) return go('#games');
  const all = await gameItems(type);
  if (!all.length) { el.innerHTML = `<header class="top"><a href="#games" class="back">${icon('back', 24)}</a><h1>${GAMES[type].name}</h1></header><p class="empty">問題がありません（英語の句動詞を登録すると Verb Swipe に出ます）</p>`; return; }
  const { list } = await orderByReview(all);
  const queue = list.slice(0, 10);
  const sid = uid('g_');
  const res = [];
  let i = 0;
  const next = async () => {
    if (i >= queue.length) return finish();
    el.innerHTML = `<div class="qrun">
      <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button><span class="qcenter"><b>${i + 1} / ${queue.length}</b><small>${GAMES[type].name}</small></span><span style="width:40px"></span></header>
      <div class="progress"><i style="width:${(i / queue.length) * 100}%"></i></div>
      <div id="q"></div><div id="fb"></div></div>`;
    $('#quit', el).onclick = finish;
    const r = await playGameItem(type, queue[i], $('#q', el), $('#fb', el), { sid, pool: all });
    res.push({ item: queue[i], ok: r.ok }); i++; next();
  };
  const finish = () => {
    const ok = res.filter((r) => r.ok).length;
    const label = (it) => type === 'puzzle' ? it.ja : type === 'swipe' ? `${it.headword}　${allMeanings(it).join('、')}` : it.phrase;
    el.innerHTML = `<header class="top"><a href="#games" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
      <div class="donemark">${icon('check', 30)}<span>${res.length}問中 ${ok}問 正解</span></div>
      <div class="card list">${res.map((r) => `<div class="rrow"><span class="mk ${r.ok ? 'ok' : 'ng'}">${r.ok ? '○' : '✕'}</span><span class="grow small">${esc(label(r.item))}</span></div>`).join('')}</div>
      <p class="hint">まちがえた問題は復習予定が早まり、レッスンや次回のゲームで先に出ます。</p>
      <div class="row"><a class="btn grow" href="#games">ゲーム一覧</a><a class="btn primary grow" href="#game?type=${type}&r=${Date.now()}">もう一度</a></div>`;
  };
  next();
}
