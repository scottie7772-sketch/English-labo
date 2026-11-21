// 入門コース (Spanish / Mainland Mandarin / Taiwan Mandarin): units of vocabulary, grammar patterns and phrases,
// built on the existing engines (word cards / lessons / chunk puzzles / 瞬間作文). Content = content-course-<lang>-v1.json (AI-made, 未検証).
import { db, uid, getMeta, setMeta } from './db.js';
import { $, $$, esc, toast, go, speak } from './ui.js';
import { icon } from './icons.js';
import { L, curLang, langOf, isZh, langAttr, numToMarks, COURSE_LANGS } from './langs.js';
import { registerEntries, wordsByHead, findDuplicate, saveWord, meaningsOf } from './words.js';
import { loadAllMastery, effLevel } from './mastery.js';
import { playGameItem } from './games.js';
import { startQuick } from './quick.js';

export { COURSE_LANGS };
const tagOf = (u) => `入門U${u.no}`;
const cache = {};
export async function coursePack(lang) {
  if (!COURSE_LANGS.includes(lang)) return null;
  if (!cache[lang]) cache[lang] = fetch(`./content-course-${lang}-v1.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).catch((e) => { delete cache[lang]; throw e; });
  return cache[lang];
}
export async function coursePhrases(lang) { const p = await coursePack(lang).catch(() => null); return p ? p.units.flatMap((u) => u.phrases) : []; }

// register the course vocabulary once per language; words that already exist just get the unit tag
export async function seedCourse(lang) {
  const key = `course:${lang}-v1`;
  if (await getMeta(key, false)) return 0;
  const pack = await coursePack(lang);
  let added = 0;
  for (const u of pack.units) {
    const tags = ['入門', tagOf(u), 'AI作成・未検証'];
    const entries = u.vocab.map((v) => ({ lang, headword: v.headword, meanings: v.meanings, pos: v.pos, ipa: v.pinyin || '', gender: v.gender || '', tags,
      example_en: v.examples?.[0]?.text || '', example_ja: v.examples?.[0]?.ja || '', origin: 'ai', review: 'unverified' }));
    const r = await registerEntries(entries, { type: 'seed', note: pack.title }, { lang });
    added += r.added;
    if (r.skipped) {   // existing items: add the unit tag (nothing else is changed)
      const byHead = await wordsByHead(lang);
      for (const v of u.vocab) {
        const w = findDuplicate(byHead, v.headword, v.meanings);
        if (w && !(w.tags || []).includes(tagOf(u))) { w.tags = [...new Set([...(w.tags || []), '入門', tagOf(u)])]; await saveWord(w); }
      }
    }
  }
  await setMeta(key, Date.now());
  return added;
}

async function unitProgress(pack) {
  const [words, mastery, speaking, reviews] = await Promise.all([db.all('words'), loadAllMastery(), db.all('speaking'), db.all('reviews')]);
  const sp = Object.fromEntries(speaking.map((x) => [x.id, x]));
  const rv = Object.fromEntries(reviews.map((x) => [x.id, x]));
  return pack.units.map((u) => {
    const ws = words.filter((w) => langOf(w) === pack.lang && (w.tags || []).includes(tagOf(u)));
    const learned = ws.filter((w) => (mastery[w.id]?.recognition?.stats?.attempts || 0) + (mastery[w.id]?.recall?.stats?.attempts || 0) > 0).length;
    const strong = ws.filter((w) => effLevel(mastery[w.id]?.recognition) >= 3).length;
    const phr = u.phrases.filter((p) => sp[p.id]?.last === 'ok').length;
    const puz = u.puzzles.filter((p) => rv[p.id]?.lastQuality && rv[p.id].lastQuality !== 'again').length;
    const total = ws.length + u.phrases.length + u.puzzles.length;
    const pct = total ? Math.round(((learned + strong) / 2 + phr + puz) / total * 100) : 0;
    return { u, ws, learned, strong, phr, puz, pct };
  });
}

// ================= Course top =================
export async function courseScreen(el) {
  const lang = curLang();
  if (!COURSE_LANGS.includes(lang)) {
    el.innerHTML = `<header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>入門コース</h1></header>
      <p class="empty">入門コースはスペイン語・中国語・台湾華語にあります。上の切り替えで言語を選んでください。</p>`;
    return;
  }
  let pack;
  try { pack = await coursePack(lang); await seedCourse(lang); } catch { el.innerHTML = '<div class="card warn">コースのデータを読み込めませんでした（初回はネット接続が必要です）</div>'; return; }
  const prog = await unitProgress(pack);
  const next = prog.find((p) => p.pct < 80) || prog[prog.length - 1];
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>入門コース</h1><span class="grow"></span></header>
    <p class="hint">${esc(pack.title)}。単元ごとに「単語 → 文法 → フレーズ」の順に進みます。順番どおりでなくても開けます。内容はAI作成で未検証です。</p>
    <a class="action primary" href="#course-unit?id=${next.u.id}">${icon('lesson', 20)}<span class="grow"><b>次はここ：第${next.u.no}課 ${esc(next.u.title)}</b><small>${esc(next.u.goal)}</small></span>${icon('chevron', 18)}</a>
    <div class="unitcards">${prog.map((p) => `
      <a class="unitcard ${p === next ? 'next' : ''}" href="#course-unit?id=${p.u.id}">
        <span class="uno">${p.u.no}</span>
        <span class="grow"><b>${esc(p.u.title)}</b><small>${esc(p.u.goal)}</small>
          <span class="ubar"><i style="width:${p.pct}%"></i></span>
          <small class="muted">単語 ${p.learned}/${p.ws.length}・フレーズ ${p.phr}/${p.u.phrases.length}・パズル ${p.puz}/${p.u.puzzles.length}</small></span>
        <b class="upct">${p.pct}%</b>
      </a>`).join('')}</div>`;
}

// ================= Unit =================
export async function courseUnit(el, params) {
  const lang = curLang();
  const pack = await coursePack(lang).catch(() => null);
  const u = pack?.units.find((x) => x.id === params.get('id'));
  if (!u) return go('#course');
  await seedCourse(lang);
  const [p] = (await unitProgress({ ...pack, units: [u] }));
  const zh = isZh(lang);
  const read = (x) => (zh && x ? `<span class="pinyin">${esc(numToMarks(x))}</span>` : '');
  const sayBtn = (t) => `<button class="icon-btn say" data-say="${esc(t)}" aria-label="読み上げ">${icon('speaker', 18)}</button>`;
  const nextU = pack.units.find((x) => x.no === u.no + 1);
  el.innerHTML = `
    <header class="top"><a href="#course" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>第${u.no}課</h1><span class="grow"></span></header>
    <div class="unithead"><b>${esc(u.title)}</b><small>${esc(u.goal)}</small><span class="ubar"><i style="width:${p.pct}%"></i></span></div>
    <details class="card details" ${p.pct ? '' : 'open'}><summary>この課のポイント</summary><ul class="pts">${u.intro.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>

    <h2 class="sec"><span class="stepno">1</span>単語 <span class="muted small">${p.learned}/${p.ws.length} 学習済み</span></h2>
    <div class="card list">${u.vocab.map((v) => `<div class="vrow"><span class="grow"><b class="tl" ${langAttr(lang)}>${esc(v.headword)}</b> ${read(v.pinyin)}${v.gender ? ` <span class="tagp">${v.gender === 'm' ? '男性' : '女性'}</span>` : ''}<br><span class="small muted">${esc(v.meanings.join('、'))}</span></span>${sayBtn(v.headword)}</div>`).join('')}</div>
    <div class="row"><button class="btn grow" id="cards">${icon('cards', 18)} カードで覚える</button><a class="btn primary grow" href="#lesson-run?tag=${encodeURIComponent(tagOf(u))}">${icon('lesson', 18)} レッスンで練習</a></div>

    <h2 class="sec"><span class="stepno">2</span>文法パターン</h2>
    ${u.grammar.map((g) => `<div class="card stack gram"><b>${esc(g.pattern)}</b><p class="small">${esc(g.explain)}</p>
      ${g.examples.map((x) => `<div class="exrow"><span class="grow"><span class="tl" ${langAttr(lang)}>${esc(x.text)}</span>${x.pinyin ? `<br>${read(x.pinyin)}` : ''}<br><span class="small muted">${esc(x.ja)}</span></span>${sayBtn(x.text)}</div>`).join('')}</div>`).join('')}
    <button class="btn" id="puz">${icon('puzzle', 18)} 並べ替えパズル（${u.puzzles.length}問・${p.puz}問正解済み）</button>

    <h2 class="sec"><span class="stepno">3</span>フレーズ <span class="muted small">${p.phr}/${u.phrases.length} 言えた</span></h2>
    <div class="card list">${u.phrases.map((x) => `<div class="exrow"><span class="grow"><span class="tl" ${langAttr(lang)}>${esc(x.model)}</span>${x.pinyin ? `<br>${read(x.pinyin)}` : ''}<br><span class="small muted">${esc(x.ja)}</span></span>${sayBtn(x.model)}</div>`).join('')}</div>
    <button class="btn primary" id="speak">${icon('mic', 18)} 日本語を見て言ってみる（瞬間作文）</button>
    ${nextU ? `<a class="btn" href="#course-unit?id=${nextU.id}" style="margin-top:14px">次の課：${esc(nextU.title)} →</a>` : ''}`;
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-say]'); if (b) speak(b.dataset.say, zh ? 0.8 : 0.9, lang); });
  $('#cards', el).onclick = () => startQuick({ tag: tagOf(u) });
  $('#speak', el).onclick = () => { sessionStorage.setItem('speakQueue', JSON.stringify({ lang, ids: u.phrases.map((x) => x.id), sid: uid('sp_'), back: `#course-unit?id=${u.id}` })); go('#speaking-run'); };
  $('#puz', el).onclick = () => go(`#course-puzzle?id=${u.id}`);
}

// ================= Unit puzzles =================
export async function coursePuzzle(el, params) {
  const lang = curLang();
  const pack = await coursePack(lang).catch(() => null);
  const u = pack?.units.find((x) => x.id === params.get('id'));
  if (!u) return go('#course');
  const sid = uid('cz_'); const res = []; let i = 0;
  const next = async () => {
    if (i >= u.puzzles.length) return finish();
    el.innerHTML = `<div class="qrun"><header class="qhead"><button class="xbtn" id="quit" aria-label="終了">${icon('close', 18)}</button><span class="qcenter"><b>${i + 1} / ${u.puzzles.length}</b><small>第${u.no}課 並べ替え</small></span><span style="width:40px"></span></header>
      <div class="progress"><i style="width:${(i / u.puzzles.length) * 100}%"></i></div><div id="q"></div><div id="fb"></div></div>`;
    $('#quit', el).onclick = finish;
    const r = await playGameItem('puzzle', u.puzzles[i], $('#q', el), $('#fb', el), { sid, mode: 'course' });
    res.push(r.ok); i++; next();
  };
  const finish = () => {
    el.innerHTML = `<header class="top"><a href="#course-unit?id=${u.id}" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>結果</h1></header>
      <div class="donemark">${icon('check', 30)}<span>${res.length}問中 ${res.filter(Boolean).length}問 正解</span></div>
      <div class="row"><a class="btn grow" href="#course-unit?id=${u.id}">課に戻る</a><a class="btn primary grow" href="#course-puzzle?id=${u.id}&r=${Date.now()}">もう一度</a></div>`;
  };
  next();
}
