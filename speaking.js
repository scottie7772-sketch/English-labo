// 瞬間作文 (Speaking Lab): Japanese prompt -> produce a sentence in the learning language.
// No AI API: answers are matched against registered answers; otherwise self-grading.
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, go, speak } from './ui.js';
import { icon } from './icons.js';
import { L, curLang, compareAnswer, stripAccents, isZh, langAttr } from './langs.js';
import { recordAnswer } from './judge.js';
import { speakingItems } from './content.js';
import { showFeedback, wordDiff } from './feedback.js';
import { shuffle } from './study.js';
import { newWord, newSense, saveWord, wordsByHead, findDuplicate } from './words.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const EN_CONTR = [[/\bi'm\b/g, 'i am'], [/\bi'll\b/g, 'i will'], [/\bi'd\b/g, 'i would'], [/\bi've\b/g, 'i have'], [/\byou're\b/g, 'you are'], [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'], [/\bhe's\b/g, 'he is'], [/\bshe's\b/g, 'she is'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'], [/\bcan't\b/g, 'cannot'], [/\bcan not\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bdidn't\b/g, 'did not'], [/\bhaven't\b/g, 'have not'], [/\bhasn't\b/g, 'has not'], [/\bwasn't\b/g, 'was not'], [/\bisn't\b/g, 'is not'], [/\baren't\b/g, 'are not'], [/\bshouldn't\b/g, 'should not'], [/\bwouldn't\b/g, 'would not'], [/\blet's\b/g, 'let us']];
function normSentence(s, lang) {
  let t = String(s || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”"]/g, '');
  if (lang === 'en') for (const [re, r] of EN_CONTR) t = t.replace(re, r);
  if (isZh(lang)) return t.replace(/[\s，。、！？,.!?~～]/g, '');
  return t.replace(/[¿¡.,!?;:]/g, '').replace(/\s+/g, ' ').trim();
}
// 'exact' | 'accent' | null
function matchSentence(input, item, lang) {
  const answers = [item.model, ...(item.alts || [])];
  const a = normSentence(input, lang);
  if (!a) return { res: null, best: item.model };
  for (const x of answers) if (normSentence(x, lang) === a) return { res: 'exact', best: x };
  if (lang === 'es') for (const x of answers) if (stripAccents(normSentence(x, lang)) === stripAccents(a)) return { res: 'accent', best: x };
  if (isZh(lang)) for (const x of answers) if (compareAnswer(input, x, lang) === 'exact') return { res: 'exact', best: x };
  // closest answer for the diff
  const words = new Set(a.split(' '));
  let best = item.model, bs = -1;
  for (const x of answers) { const sc = normSentence(x, lang).split(' ').filter((t) => words.has(t)).length; if (sc > bs) { bs = sc; best = x; } }
  return { res: null, best };
}

async function progressMap() { return Object.fromEntries((await db.all('speaking')).map((p) => [p.id, p])); }

// ================= Setup =================
export async function speakingScreen(el) {
  const lang = curLang();
  let items = [];
  try { items = await speakingItems(lang); } catch { el.innerHTML = '<div class="card warn">問題データを読み込めませんでした（初回はネット接続が必要です）</div>'; return; }
  const prog = await progressMap();
  const cfg = { level: 0, range: 'auto', count: 10, ...(await getSetting(`speakCfg`, {})) };
  const pick = () => items.filter((x) => (!cfg.level || x.level === cfg.level) && (cfg.range === 'all' ? true : cfg.range === 'wrong' ? prog[x.id]?.last === 'ng' || prog[x.id]?.last === 'near' : cfg.range === 'new' ? !prog[x.id] : prog[x.id]?.last !== 'ok' || !prog[x.id]));
  function draw() {
    const list = pick();
    const done = items.filter((x) => prog[x.id]?.last === 'ok').length;
    el.innerHTML = `
      <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>瞬間作文</h1><span class="grow"></span><span class="small muted">${L().name}</span></header>
      <p class="hint">日本語を見て、すぐに${esc(L().name)}で言う・書く練習です。登録済みの答えと一致すれば自動で正解。違う言い方をした場合は、模範解答と見比べて自分で判定します。</p>
      <div class="card stack">
        <div class="kv"><span>問題数</span><b>${items.length}問（正解済み ${done}）</b></div>
      </div>
      <div class="setlist">
        <div class="setrow"><span class="setlabel">レベル</span><div class="chips" id="lv">${[[0, 'すべて'], [1, '1 基本'], [2, '2 日常・仕事'], [3, '3 複文']].map(([v, l]) => `<button data-v="${v}" class="${cfg.level === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="setrow"><span class="setlabel">範囲</span><div class="chips" id="rg">${[['auto', 'まだ正解していない'], ['new', '未回答'], ['wrong', '前回まちがえた'], ['all', 'すべて']].map(([v, l]) => `<button data-v="${v}" class="${cfg.range === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="setrow"><span class="setlabel">問題数</span><div class="chips" id="ct">${[5, 10, 20, 0].map((v) => `<button data-v="${v}" class="${cfg.count === v ? 'on' : ''}">${v ? v + '問' : '全部'}</button>`).join('')}</div></div>
      </div>
      <p class="small muted">${SR ? '🎤 音声入力：この端末で使える場合があります（ホーム画面から開いたアプリでは使えないことがあります）' : '音声入力はこの環境では使えません。キーボードの音声入力（マイクのボタン）は使えます。'}</p>
      <div class="cta-bar"><div class="cta-count"><b>${Math.min(list.length, cfg.count || list.length)}</b><span>問</span></div><button class="btn primary cta" id="start" ${list.length ? '' : 'disabled'}>スタート</button></div>`;
    const bindChips = (id, key) => ($('#' + id, el).onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v == null) return; cfg[key] = isNaN(+v) ? v : +v; setSetting('speakCfg', cfg); draw(); });
    bindChips('lv', 'level'); bindChips('rg', 'range'); bindChips('ct', 'count');
    $('#start', el).onclick = () => {
      let q = shuffle(pick()); if (cfg.count) q = q.slice(0, cfg.count);
      sessionStorage.setItem('speakQueue', JSON.stringify({ lang, ids: q.map((x) => x.id), sid: uid('sp_') }));
      go('#speaking-run');
    };
  }
  draw();
}

// ================= Run =================
export async function speakingRun(el) {
  const st = JSON.parse(sessionStorage.getItem('speakQueue') || 'null');
  if (!st) return go('#speaking');
  const lang = st.lang;
  const all = Object.fromEntries((await speakingItems(lang)).map((x) => [x.id, x]));
  const queue = st.ids.map((id) => all[id]).filter(Boolean);
  const results = [];
  let i = 0, t0 = 0, rec = null;

  function show() {
    if (i >= queue.length) return finish();
    const it = queue[i];
    t0 = performance.now();
    el.innerHTML = `
      <div class="qrun">
      <header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button><span class="qcenter"><b>${i + 1} / ${queue.length}</b><small>瞬間作文・${esc(L(lang).name)}</small></span><span style="width:40px"></span></header>
      <div class="progress"><i style="width:${(i / queue.length) * 100}%"></i></div>
      <div class="sp-prompt"><span class="small muted">日本語</span><div class="sp-ja">${esc(it.ja)}</div>${it.note ? `<div class="small muted">${esc(it.note)}</div>` : ''}</div>
      <label class="field"><span>${esc(L(lang).name)}で</span>
        <textarea id="inp" rows="3" autocapitalize="${isZh(lang) ? 'off' : 'sentences'}" autocorrect="off" spellcheck="false" ${langAttr(lang)} placeholder="${isZh(lang) ? '漢字で入力（注音・ピンインキーボード）' : '声に出してから入力すると効果的'}"></textarea></label>
      <div class="row">
        ${SR ? `<button class="btn" id="mic">${icon('mic', 18)} 話す</button>` : ''}
        <button class="btn grow" id="giveup">わからない</button>
        <button class="btn primary grow" id="check">答え合わせ</button>
      </div>
      <div id="fb"></div></div>`;
    const inp = $('#inp', el);
    setTimeout(() => inp.focus(), 50);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); check(false); } });
    $('#check', el).onclick = () => check(false);
    $('#giveup', el).onclick = () => check(true);
    $('#quit', el).onclick = () => finish();
    $('#mic', el)?.addEventListener('click', () => {
      try {
        rec?.abort(); rec = new SR(); rec.lang = L(lang).speech; rec.interimResults = true; rec.maxAlternatives = 1;
        $('#mic', el).classList.add('on');
        rec.onresult = (e) => { inp.value = [...e.results].map((r) => r[0].transcript).join(' '); };
        rec.onend = () => $('#mic', el)?.classList.remove('on');
        rec.onerror = (e) => { toast(e.error === 'not-allowed' ? 'マイクが許可されていません' : '音声入力を使えませんでした。キーボードのマイクを使ってください'); };
        rec.start();
      } catch { toast('音声入力を使えませんでした'); }
    });
  }

  function check(gaveUp) {
    const it = queue[i];
    const val = $('#inp', el).value.trim();
    rec?.abort();
    const ms = Math.round(performance.now() - t0);
    const m = gaveUp ? { res: null, best: it.model } : matchSentence(val, it, lang);
    $$('#check, #giveup, #mic', el).forEach((b) => (b.disabled = true));
    $('#inp', el).readOnly = true;
    const answersHTML = `<div class="sp-model"><b ${langAttr(lang)}>${esc(it.model)}</b><button class="icon-btn" id="say" aria-label="読み上げ">${icon('speaker', 20)}</button></div>
      ${it.pinyin ? `<div class="small muted">${esc(it.pinyin)}</div>` : ''}
      ${(it.alts || []).length ? `<div class="small"><span class="muted">別の言い方：</span>${it.alts.map(esc).join(' ／ ')}</div>` : ''}
      ${(it.chunks || []).length ? `<div class="chunks">${it.chunks.map((c, k) => `<button class="chunk" data-k="${k}">${esc(c)}<span>＋</span></button>`).join('')}</div>` : ''}`;
    const host = $('#fb', el);
    if (m.res === 'exact') return grade('ok', val, ms, answersHTML, '正解');
    // not an exact match: show model and let the user judge (another correct phrasing is not wrong)
    const d = val ? wordDiff(val, m.best) : null;
    host.innerHTML = `<div class="card stack sp-judge">
      ${m.res === 'accent' ? '<div class="verdict near">アクセント記号だけ違います</div>' : val ? '<div class="small muted">登録された答えと一致しませんでした。見比べて判定してください</div>' : ''}
      ${d && !isZh(lang) ? `<div class="diff"><div><span class="small muted">あなた</span> <code>${d.you}</code></div><div><span class="small muted">模範</span> <code>${d.target}</code></div></div>` : val ? `<div class="small"><span class="muted">あなた：</span>${esc(val)}</div>` : ''}
      ${answersHTML}
      <div class="row">
        ${val ? '<button class="btn grow" data-g="ok">正しく言えた</button>' : ''}
        <button class="btn grow" data-g="near">惜しい</button>
        <button class="btn grow" data-g="ng">言えなかった</button>
      </div></div>`;
    bindAnswers(it);
    host.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => grade(b.dataset.g, val, ms, answersHTML, null)));
    if (gaveUp) speak(it.model, 0.9, lang);
  }
  function bindAnswers(it) {
    $('#say', el)?.addEventListener('click', () => speak(it.model, 0.9, lang));
    $$('.chunk', el).forEach((b) => (b.onclick = async () => {
      const c = it.chunks[+b.dataset.k].replace(/（.*?）/g, '').trim();
      const exist = findDuplicate(await wordsByHead(lang), c, []);
      if (exist) return toast(`「${c}」は登録済みです`);
      await saveWord(newWord({ headword: c, lang, source: { type: 'speaking', itemId: it.id }, tags: ['瞬間作文'], senses: [newSense({ examples: [{ en: it.model, ja: it.ja }] })] }));
      b.classList.add('on'); toast(`「${c}」を単語リストに追加しました（意味はあとで入力）`);
    }));
  }
  async function grade(g, val, ms, answersHTML, autoTitle) {
    const it = queue[i];
    results.push({ id: it.id, g, val });
    await recordAnswer({ sessionId: st.sid, qid: it.id + ':' + i, wordId: it.id, direction: 'ja2x', format: 'speaking', mode: 'speaking', prompt: it.ja, answer: val || '（わからない）', ms,
      self: !autoTitle, grade: g === 'near' ? 'vague' : null, results: [{ skill: 'produce', correct: g !== 'ng', hint: g === 'near' }], srs: { kind: 'speaking', lang } });
    const p = (await db.get('speaking', it.id)) || { id: it.id, lang, attempts: 0, ok: 0, history: [] };
    p.attempts++; if (g === 'ok') p.ok++; p.last = g; p.lastAt = Date.now(); p.lastAnswer = val;
    p.history = [...p.history, { at: Date.now(), g, val, ms }].slice(-20);
    await db.put('speaking', p);
    if (autoTitle) {
      showFeedback($('#fb', el), { kind: 'ok', title: autoTitle, main: answersHTML }, () => { i++; show(); });
      bindAnswers(it); speak(it.model, 0.95, lang);
    } else { i++; show(); }
  }
  async function finish() {
    rec?.abort();
    const ok = results.filter((r) => r.g === 'ok').length;
    const wrong = results.filter((r) => r.g !== 'ok').map((r) => r.id);
    el.innerHTML = `
      <header class="top"><a href="${st.back || '#speaking'}" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
      <div class="donemark">${icon('check', 30)}<span>${results.length}問 完了</span></div>
      <div class="stats"><div class="stat"><b class="up">${ok}</b><span>言えた</span></div><div class="stat"><b class="mid">${results.filter((r) => r.g === 'near').length}</b><span>惜しい</span></div><div class="stat"><b class="down">${results.filter((r) => r.g === 'ng').length}</b><span>言えなかった</span></div></div>
      ${wrong.length ? '<button class="btn primary" id="again">言えなかった問題をもう一度</button>' : ''}
      <div class="card list">${results.map((r) => `<div class="rrow"><span class="mk ${r.g}">${r.g === 'ok' ? '○' : r.g === 'near' ? '△' : '✕'}</span><span class="grow"><b>${esc(all[r.id].ja)}</b><br><span class="small muted">${esc(all[r.id].model)}</span></span></div>`).join('')}</div>
      <a class="btn" href="${st.back || '#speaking'}" style="margin-top:12px">${st.back ? '課に戻る' : '瞬間作文に戻る'}</a>`;
    $('#again', el)?.addEventListener('click', () => { sessionStorage.setItem('speakQueue', JSON.stringify({ lang, ids: wrong, sid: uid('sp_'), back: st.back })); speakingRun(el); });
  }
  show();
}
