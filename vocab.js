// Phase 2: Vocabulary Manager screens
import { maStatus, mountMAAudio, showMAPhrase } from './ma-phrases-ui.js';
import { maLinks, playMA } from './ma-phrases.js';
import { unlock } from './word-audio.js';
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, speak, fmtDate } from './ui.js';
import { SKILLS, SKILL_LABELS, LEVEL_LABELS, effLevel, status, source, overall, filterLevel, levelText, loadAllMastery, loadWordMastery, setManual, setLock, resetToAuto } from './mastery.js';
import { icon } from './icons.js';
import { L, curLang, langOf, numToMarks, LANGS, isZh, langAttr } from './langs.js';
import { setDue } from './srs.js';
import { scanWords } from './datacheck.js';
import { EXTRA_SKILLS } from './mastery.js';
import { newWord, newSense, saveWord, toggleBookmark, deleteWord, headKey, splitList, parseBulk, csvToEntries, analyzeCSV, entryIssues, registerEntries, wordsByHead, findDuplicate, meaningsOf, splitWord } from './words.js';

const POS_JA = { noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞', preposition: '前置詞', conjunction: '接続詞', pronoun: '代名詞', 'phrasal verb': '句動詞', idiom: 'イディオム', phrase: '熟語' };
const POS_OPTIONS = ['', 'noun', 'verb', 'adjective', 'adverb', 'phrasal verb', 'idiom', 'phrase', 'preposition', 'conjunction'];
const posJa = (p) => POS_JA[p] || p || '';
const SOURCE_JA = { manual: '手動', ma: 'MAフレーズ', bulk: '一括登録', csv: 'CSV', ocr: 'OCR', video: '動画字幕', mistake: '学習中の誤答', paste: '英文から選択', seed: '初期データ' };

// 1.18.5: the speaker buttons play the original recording when the word is in a matched material (setting on), else TTS
async function sayOrig(text, tts = () => speak(text)) {
  let on = true; try { on = localStorage.getItem('fc-orig') !== '0'; } catch {}
  if (on) { try { const m = await import('./word-audio.js'); await m.prepare(); if (await m.play(text)) return; } catch {} }
  tts();
}
const DEFAULT_FILTER = { q: '', bm: 'all', kind: 'all', levels: [], skill: 'overall', tag: '', deck: '', sort: 'new', st: 'all', src: '', au: 'all' };
// 1.18.5: where a word came from (registration route + the list / material name) and whether its original recording exists
const srcKey = (w) => `${w.source?.type || 'manual'}|${w.source?.note || ''}`;
const srcText = (k) => { const [t, n] = k.split('|'); return (SOURCE_JA[t] || t) + (n ? `・${n}` : ''); };
let filter = null;
async function getFilter() { if (!filter) filter = { ...DEFAULT_FILTER, ...(await getSetting('vocabFilter', {})), q: '' }; return filter; }
const saveFilter = () => setSetting('vocabFilter', { ...filter, q: '' });

function lvOf(records, skill) {
  return skill === 'overall' ? overall(records).level : effLevel(records?.[skill]);
}
function chip(lv, records, small = false) {
  return `<span class="lv lv${lv}${small ? ' sm' : ''}"><i></i>${esc(levelText(lv, records))}</span>`;
}

// ================= List =================
export async function vocabList(el) {
  const f = await getFilter();
  const [words0, mastery, decks] = await Promise.all([db.all('words'), loadAllMastery(), db.all('decks')]);
  const words = words0.filter((w) => langOf(w) === curLang());
  const tags = [...new Set(words.flatMap((w) => w.tags || []))].sort();

  el.innerHTML = `
    <header class="top"><h1>単語帳</h1><span class="grow"></span>
      <button class="btn sm ghost" id="selMode">選ぶ</button><button class="icon-btn" id="add" aria-label="追加">${icon('plus', 26)}</button></header>
    <div class="searchbar"><input id="q" type="search" placeholder="検索（${esc(L().name)}・日本語）" value="${esc(f.q)}" autocapitalize="off" autocorrect="off"></div>
    <details class="card filters" ${hasFilter(f) ? 'open' : ''}>
      <summary>絞り込み <span class="muted small" id="fsum"></span></summary>
      <div class="fgrp"><span>ブックマーク</span>${seg('bm', [['all', 'すべて'], ['yes', '済み'], ['no', '未']], f.bm)}</div>
      <div class="fgrp"><span>種類</span>${seg('kind', [['all', 'すべて'], ['word', '単語'], ['phrase', '熟語']], f.kind)}</div>
      <div class="fgrp"><span>軽量化</span>${seg('st', [['all', 'すべて'], ['active', '出題する語'], ['slim', '軽量化済み']], f.st || 'all')}</div>
      <div class="fgrp"><span>習得度の基準</span>
        <select id="skill">${[['overall', '総合（最も低いスキル）'], ...SKILLS.map((s) => [s, SKILL_LABELS[s]])].map(([v, l]) => `<option value="${v}" ${f.skill === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="fgrp"><span>習得度（複数可）</span><div class="chips" id="levels">
        ${[1, 2, 3, 4, 5].map((l) => `<button data-l="${l}" class="${f.levels.includes(l) ? 'on' : ''}">${LEVEL_LABELS[l]}</button>`).join('')}
      </div><p class="hint">未評価・判定保留は「未習得」に含まれます</p></div>
      <div class="fgrp"><span>タグ</span><select id="tag"><option value="">すべて</option>${tags.map((t) => `<option ${f.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="fgrp"><span>出元（登録元・教材）</span><select id="src"><option value="">すべて</option>${[...new Set(words.map(srcKey))].sort((a, b) => srcText(a).localeCompare(srcText(b), 'ja')).map((k) => `<option value="${esc(k)}" ${f.src === k ? 'selected' : ''}>${esc(srcText(k))}（${words.filter((w) => srcKey(w) === k).length}）</option>`).join('')}</select></div>
      <div class="fgrp"><span>元の録音</span>${seg('au', [['all', 'すべて'], ['yes', 'あり'], ['no', 'なし（読み上げ）'], ['bad', '参照切れ・未確定']], f.au || 'all')}</div>
      <div class="fgrp"><span>単語集</span><select id="deck"><option value="">すべて</option>${decks.map((d) => `<option value="${d.id}" ${f.deck === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <a href="#decks" class="link small">単語集を管理</a></div>
      <div class="fgrp"><span>並び順</span><select id="sort">${[['new', '新しい順'], ['old', '古い順'], ['abc', 'ABC順'], ['weak', '習得度が低い順'], ['src', '出元順']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button class="btn ghost" id="clear">条件をクリア</button>
    </details>
    ${await (async () => { const n = (await scanWords()).flagged.length; return n ? `<a class="notice warn" href="#datacheck">${icon('warn', 18)}<span>列がずれて登録された可能性のある項目が${n}件あります。データ点検で確認できます</span></a>` : ''; })()}
    <p class="muted small" id="count"></p>
    <div id="list"></div>`;

  // original recordings (text index; only read when the filter / sort needs it)
  const wa = f.au !== 'all' || f.src || f.sort === 'src' ? await import('./word-audio.js').then((m) => m.prepare().then(() => m)).catch(() => null) : await import('./word-audio.js').then((m) => (m.prepare().then(() => { if (f.au !== 'all') draw(true); }), m)).catch(() => null);
  const headCount = {};
  words.forEach((w) => { const k = headKey(w.headword); headCount[k] = (headCount[k] || 0) + 1; });
  const listEl = $('#list', el);
  function draw(keep) {
    const q = f.q.trim().toLowerCase();
    let rows = words.filter((w) => {
      if (f.bm === 'yes' && !w.bookmarked) return false;
      if (f.bm === 'no' && w.bookmarked) return false;
      if (f.kind === 'word' && w.isPhrase) return false;
      if (f.kind === 'phrase' && !w.isPhrase) return false;
      if (f.st === 'slim' && !w.slim) return false;
      if (f.st === 'active' && w.slim) return false;
      if (f.tag && !(w.tags || []).includes(f.tag)) return false;
      if (f.deck && !(w.deckIds || []).includes(f.deck)) return false;
      if (f.levels.length && !f.levels.includes(filterLevel(lvOf(mastery[w.id], f.skill)))) return false;
      if (f.src && srcKey(w) !== f.src) return false;
      const hasA = (w.ma ? maLinks(w).length > 0 : Boolean(w.audio?.word?.state === 'confirmed') || wa?.has(w.headword));   // 1.19.31: a registered sound counts too
      if (f.au === 'yes' && !hasA) return false;
      if (f.au === 'no' && hasA) return false;
      if (f.au === 'bad' && !['broken', 'unsure'].includes(wa?.status?.(w.headword, w))) return false;   // 1.19.36
      if (q) {
        const hay = (w.headword + ' ' + (w.senses || []).flatMap((s) => s.meanings || []).join(' ') + ' ' + srcText(srcKey(w)) + ' ' + (w.tags || []).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const cmp = {
      new: (a, b) => b.createdAt - a.createdAt, old: (a, b) => a.createdAt - b.createdAt,
      abc: (a, b) => a.headword.localeCompare(b.headword),
      src: (a, b) => srcText(srcKey(a)).localeCompare(srcText(srcKey(b)), 'ja') || a.headword.localeCompare(b.headword),
      weak: (a, b) => filterLevel(lvOf(mastery[a.id], f.skill)) - filterLevel(lvOf(mastery[b.id], f.skill)) || a.headword.localeCompare(b.headword),
    }[f.sort];
    rows.sort(cmp);
    $('#count', el).textContent = `${rows.length} / ${words.length} 件`;
    $('#fsum', el).textContent = hasFilter(f) ? '（条件あり）' : '';
    if (!words.length) { listEl.innerHTML = `<div class="card center muted">まだ単語がありません。右上の＋から追加できます。</div>`; return; }
    // long lists are drawn in steps: the first rows at once, more when the end comes near (less work and memory)
    const want = keep ? shown : 0; rowsNow = rows; shown = 0; listEl.innerHTML = ''; more(want);
  }
  const PAGE = 80;
  let shown = 0, rowsNow = [], sel = null;   // sel: chosen word ids while in "選ぶ" mode
  const rowHTML = (w) => {
      const lv = lvOf(mastery[w.id], f.skill);
      return `
      <div class="wcard ${sel?.has(w.id) ? 'picked' : ''}" data-id="${w.id}">
        ${sel ? `<input type="checkbox" class="wsel" data-sel="${w.id}" ${sel.has(w.id) ? 'checked' : ''} aria-label="選ぶ">` : ''}
        <a class="wmain" href="#word?id=${encodeURIComponent(w.id)}">
          <b class="tl">${esc(w.headword)}</b>${w.ipa && isZh(langOf(w)) ? `<span class="small muted"> ${esc(numToMarks(w.ipa))}</span>` : ''}${w.review === 'unverified' ? '<span class="tagp ai">未検証</span>' : ''}${w.isPhrase ? '<span class="tagp">熟語</span>' : ''}${headCount[headKey(w.headword)] > 1 ? '<span class="tagp">多義</span>' : ''}${w.slim ? '<span class="tagp slim">軽量</span>' : ''}
          <span class="mean">${w.ma ? `<small>優先度 ${w.ma.priority}・${maStatus(w)}</small><br>` : ''}${esc((w.senses || []).flatMap((s) => s.meanings || []).join('、') || '（意味未入力）')}</span>${f.sort === 'src' || f.src || f.au !== 'all' ? `<small class="muted wsrc">${w.audio?.word?.state === 'confirmed' || wa?.has(w.headword) ? '🔊 ' : ''}${['broken', 'unsure'].includes(wa?.status?.(w.headword, w)) ? `⚠${wa.STATE_LABEL[wa.status(w.headword, w)]} ` : ''}${esc(srcText(srcKey(w)))}</small>` : ''}
        </a>
        <div class="wact">
          <button class="icon-btn spk" data-say="${esc(w.headword)}" aria-label="発音">${icon('speaker', 22)}</button>
          <span class="grow"></span>
          <label class="lvsel">${chip(lv, mastery[w.id])}
            <select data-lv="${w.id}" aria-label="習得度">
              ${lv === 0 ? `<option value="0" selected>${esc(levelText(0, mastery[w.id]))}</option>` : ''}
              ${[1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${lv === l ? 'selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('')}
            </select></label>
          <button class="bm ${w.bookmarked ? 'on' : ''}" data-bm="${w.id}" aria-label="ブックマーク">${bmIcon(w.bookmarked)}</button>
        </div>
      </div>`;
  };
  function more(want = 0) {
    listEl.querySelector('.wmore')?.remove();
    const next = rowsNow.slice(shown, shown + Math.max(PAGE, want - shown)); shown += next.length;
    listEl.insertAdjacentHTML('beforeend', next.map(rowHTML).join('') + (shown < rowsNow.length ? '<div class="wmore" aria-hidden="true"></div>' : ''));
    const s = listEl.querySelector('.wmore'); if (s) io.observe(s);
  }
  const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); more(); } }, { rootMargin: '1200px 0px' });
  draw();

  $('#q', el).addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  el.querySelectorAll('.seg[data-k]').forEach((s) => s.addEventListener('click', (e) => {
    const v = e.target.dataset.v; if (!v) return;
    f[s.dataset.k] = v; $$('button', s).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); saveFilter(); draw();
  }));
  $('#levels', el).addEventListener('click', (e) => {
    const l = +e.target.dataset.l; if (!l) return;
    f.levels = f.levels.includes(l) ? f.levels.filter((x) => x !== l) : [...f.levels, l];
    e.target.classList.toggle('on'); saveFilter(); draw();
  });
  for (const k of ['skill', 'tag', 'deck', 'sort', 'src']) $('#' + k, el).addEventListener('change', (e) => { f[k] = e.target.value; saveFilter(); draw(); });
  $('#clear', el).onclick = () => { filter = { ...DEFAULT_FILTER }; saveFilter(); vocabList(el); };
  $('#add', el).onclick = addMenu;
  // ---- 1.16: choose several words → lighten (remove examples etc.) / bring back ----
  const isMastered = (w) => filterLevel(lvOf(mastery[w.id], 'overall')) === 5;
  const selBar = () => {
    let bar = $('#selbar', el);
    if (!sel) { bar?.remove(); document.body.classList.remove('selecting'); return; }
    document.body.classList.add('selecting');
    if (!bar) { el.insertAdjacentHTML('beforeend', '<div class="wselbar" id="selbar"></div>'); bar = $('#selbar', el); }
    const chosen = words.filter((w) => sel.has(w.id));
    bar.innerHTML = `<span class="small"><b>${sel.size}</b>語</span>
      <button class="btn sm" data-a="all">表示中を全部</button><button class="btn sm" data-a="done">習得済みだけ</button><button class="btn sm" data-a="none">解除</button>
      <button class="btn sm primary" data-a="slim" ${chosen.some((w) => !w.slim) ? '' : 'disabled'}>軽量化</button>
      <button class="btn sm" data-a="back" ${chosen.some((w) => w.slim) ? '' : 'disabled'}>出題に戻す</button><button class="btn sm danger" data-a="del" ${sel.size ? '' : 'disabled'}>削除</button><button class="btn sm ghost" data-a="end">終了</button>`;
    bar.onclick = async (e) => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === 'all') rowsNow.forEach((w) => sel.add(w.id));
      if (a === 'done') { sel.clear(); rowsNow.filter(isMastered).forEach((w) => sel.add(w.id)); }
      if (a === 'none') sel.clear();
      if (a === 'end') { sel = null; $('#selMode', el).textContent = '選ぶ'; }
      if (a === 'slim') { if (await slimWords(words.filter((w) => sel.has(w.id) && !w.slim), isMastered)) { vocabList(el); return; } }
      if (a === 'del') {   // 1.18.5: delete many words at once (e.g. words registered without a meaning)
        const list = words.filter((w) => sel.has(w.id));
        if (!(await confirmDialog({ title: `${list.length}語を削除`, body: `<p>単語・習得度・復習予定が削除されます（元に戻せません）。</p><p class="small muted">${list.slice(0, 8).map((w) => esc(w.headword)).join('、')}${list.length > 8 ? ' …' : ''}</p>`, okLabel: '削除', danger: true }))) return;
        for (const w of list) await deleteWord(w.id);
        toast(`${list.length}語を削除しました`, 2500); sel = null; vocabList(el); return;
      }
      if (a === 'back') { const list = words.filter((w) => sel.has(w.id) && w.slim); for (const w of list) { delete w.slim; await db.put('words', w); } toast(`${list.length}語を出題に戻しました（消した例文などは戻りません）`, 3000); }
      draw(true); selBar();
    };
  };
  $('#selMode', el).onclick = () => { sel = sel ? null : new Set(); $('#selMode', el).textContent = sel ? '終了' : '選ぶ'; draw(true); selBar(); };

  listEl.addEventListener('click', async (e) => {
    if (sel) {   // choosing: a tap on the row ticks it
      const card = e.target.closest('.wcard'); if (!card || e.target.closest('select, [data-say], [data-bm]')) return;
      e.preventDefault(); const id = card.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      card.classList.toggle('picked', sel.has(id)); const cb = card.querySelector('.wsel'); if (cb) cb.checked = sel.has(id);
      selBar(); return;
    }
    const bm = e.target.closest('[data-bm]');
    if (bm) {
      const id = bm.dataset.bm;
      const on = await toggleBookmark(id);
      const w = words.find((x) => x.id === id); w.bookmarked = on;
      bm.classList.toggle('on', on); bm.innerHTML = bmIcon(on);
      if (f.bm !== 'all') draw(true);
      return;
    }
    const spk = e.target.closest('[data-say]');
    if (!spk) return;
    const w = words.find(x => x.id === spk.closest('.wcard').dataset.id);
    if (w?.ma) {
      unlock();
      if (!(await playMA(w)) && !(await playMA(w, 'example'))) await showMAPhrase(w.id);
    } else sayOrig(spk.dataset.say);
  });
  listEl.addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-lv]'); if (!s) return;
    const id = s.dataset.lv, l = +s.value; if (!l) return;
    await setManual(id, SKILLS, l, { lock: false, reason: 'list' });
    Object.assign(mastery, { [id]: await loadWordMastery(id) });
    toast(`「${words.find((w) => w.id === id).headword}」を${LEVEL_LABELS[l]}に変更（4スキルすべて）`);
    draw(true);
  });
}

function hasFilter(f) { return f.bm !== 'all' || f.kind !== 'all' || f.levels.length || f.tag || f.deck || (f.st && f.st !== 'all') || f.src || (f.au && f.au !== 'all'); }

// 1.16: lighten mastered words. Keeps the headword, meanings, part of speech, mastery and (by default) every answer record;
// removes examples, their translations, context notes and links to videos (the videos themselves stay).
// The word leaves the normal question pool and can be seen with 絞り込み → 軽量化済み.
const extraOf = (w) => ({ ex: (w.senses || []).flatMap((x) => x.examples || []), ctx: (w.senses || []).map((x) => x.context || '').filter(Boolean), refs: w.videoRefs || [], note: w.note || w.memo || '' });
const bytesOf = (o) => new Blob([JSON.stringify(o)]).size;
async function slimWords(list, isMastered) {
  if (!list.length) return false;
  const notDone = list.filter((w) => !isMastered(w)).length;
  const extra = list.reduce((a, w) => a + bytesOf(extraOf(w)), 0);
  const nAtt = Object.values(await db.countEach('attempts', 'wordId', list.map((w) => w.id))).reduce((a, n) => a + n, 0);
  const ok = await confirmDialog({ title: `${list.length}語を軽量化`, okLabel: '軽量化する',
    body: `<p class="small">消すもの：例文・例文の訳・文脈・補足・動画へのリンク（動画そのものは残ります）<br>残すもの：見出し語・意味・品詞・習得度・復習の記録</p>
      ${notDone ? `<p class="warn-text small">うち${notDone}語は、まだ「習得済み」ではありません。</p>` : ''}
      <p class="small">減る量の見込み：約${Math.max(1, Math.round(extra / 1024))}KB</p>
      <label class="chk small"><input type="checkbox" id="slimHist"> 解答記録（${nAtt}件・約${Math.max(1, Math.round((nAtt * 150) / 1024))}KB）も要約にする（回数・正答数・最初と最後の日だけ残す。元に戻せません）</label>
      <p class="hint">軽量化した語は、テスト・単語帳・レッスン・ゲームに出なくなります（「出題に戻す」でまた出せます。消した例文は戻りません）。念のため、先に設定からバックアップを作っておくと安心です。</p>` });
  if (!ok) return false;
  const hist = !!$('#slimHist')?.checked;
  let n = 0, fail = 0;
  for (const w0 of list) {
    try {
      const w = structuredClone(await db.get('words', w0.id)); if (!w) continue;
      const removed = [];
      for (const x of w.senses || []) { if (x.examples?.length) { x.examples = []; removed.push('例文'); } if (x.context) { x.context = ''; removed.push('文脈'); } }
      if (w.videoRefs?.length) { w.videoRefs = []; removed.push('動画リンク'); }
      for (const k of ['note', 'memo']) if (w[k]) { delete w[k]; removed.push('補足'); }
      w.slim = { at: Date.now(), removed: [...new Set(removed)] };
      if (hist) {   // one transaction per word: the word and its records change together or not at all
        const atts = await db.byIndex('attempts', 'wordId', w.id);
        const at = atts.map((a) => a.at).filter(Boolean);
        w.slim.hist = { n: atts.length, ok: atts.filter((a) => a.correct).length, first: at.length ? Math.min(...at) : null, last: at.length ? Math.max(...at) : null };
        await db.tx(['words', 'attempts'], 'readwrite', (t) => { t.objectStore('words').put(w); atts.forEach((a) => t.objectStore('attempts').delete(a.id)); });
      } else await db.put('words', w);
      n++;
    } catch { fail++; }
  }
  toast(`${n}語を軽量化しました${fail ? `（${fail}語は失敗・そのまま）` : ''}`, 3000);
  return true;
}
function seg(k, opts, cur) { return `<div class="seg" data-k="${k}">${opts.map(([v, l]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
function bmIcon(on) { return `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 3h12v18l-6-4.5L6 21z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`; }

async function addMenu() {
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <form method="dialog" class="dlg stack">
      <h3>単語を追加</h3>
      <a class="btn" href="#word?new=1">1語ずつ追加</a>
      <a class="btn" href="#vocab-bulk">まとめて追加（1行1語）</a>
      <a class="btn" href="#vocab-paste">英文を貼り付けて選ぶ</a>
      <a class="btn" href="#vocab-csv">CSVファイルから</a>
      <a class="btn" href="#ma-phrases">MAフレーズを登録</a>
      <button class="btn ghost" value="cancel">閉じる</button>
    </form>`;
  dlg.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => dlg.close()));
  dlg.showModal();
}

// ================= Detail / Edit =================
export async function wordDetail(el, params) {
  const isNew = params.get('new') === '1';
  const w = isNew ? newWord({ headword: params.get('h') || '', source: { type: params.get('src') || 'manual' } }) : await db.get('words', params.get('id'));
  if (!w) { el.innerHTML = `<header class="top"><a href="#vocab" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>見つかりません</h1></header>`; return; }
  const decks = await db.all('decks');
  const mastery = isNew ? {} : await loadWordMastery(w.id);
  const hist = isNew ? [] : (await db.byIndex('masteryChanges', 'wordId', w.id)).sort((a, b) => b.at - a.at).slice(0, 20);
  const rev = isNew ? null : await db.get('reviews', w.id);
  const nextDue = rev ? rev.due : null;
  const wl = langOf(w);
  const allStats = SKILLS.map((s) => mastery[s]?.stats).filter(Boolean);
  const att = allStats.reduce((a, s) => a + (s.attempts || 0), 0), cor = allStats.reduce((a, s) => a + (s.correct || 0), 0);
  const lastAt = Math.max(0, ...allStats.map((s) => s.lastAt || 0)) || null;
  const ms = allStats.filter((s) => s.avgMs).map((s) => s.avgMs);
  const ov = overall(mastery);
  const siblings = ((await wordsByHead(wl)).get(headKey(w.headword)) || []).filter((x) => x.id !== w.id);
  const vrefs = isNew ? [] : (w.videoRefs?.length ? w.videoRefs : w.source?.type === 'video' ? [w.source] : []);
  const vnames = vrefs.length ? await (await import('./video.js')).videoNames() : {};

  el.innerHTML = `
    <header class="top"><a href="${isNew ? '#vocab' : '#vocab'}" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>${isNew ? '単語を追加' : '単語の詳細'}</h1><span class="grow"></span>
      ${isNew ? '' : `<button class="bm big ${w.bookmarked ? 'on' : ''}" id="bm">${bmIcon(w.bookmarked)}</button>`}</header>

    <form id="f" class="stack" autocomplete="off">
      <div class="card stack">
        <div class="kv"><span>言語</span><b>${esc(L(wl).name)}</b></div>
        <label class="field"><span>${wl === 'en' ? '英単語・熟語' : wl === 'es' ? 'スペイン語' : wl === 'zh-CN' ? '中国語（簡体字）' : '華語（繁体字）'}</span>
          <div class="row"><input name="headword" value="${esc(w.headword)}" required autocapitalize="off" autocorrect="off" spellcheck="false" class="big-input">
          <button type="button" class="icon-btn" id="say" aria-label="発音">${icon('speaker', 22)}</button></div></label>
        <label class="field"><span>${isZh(wl) ? 'ピンイン（hǎo でも hao3 でも可。入力テストの正解にもなります）' : '発音記号（任意）'}</span><input name="ipa" value="${esc(w.ipa)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        ${w.review === 'unverified' ? '<label class="chk"><input type="checkbox" id="verified"> 内容を確認した（未検証の印を外す）</label>' : ''}
      </div>

      <h2 class="sec">意味・用法 <span class="muted small">（意味ごとに分けて管理）</span></h2>
      <div id="senses"></div>
      ${isNew ? '' : `<div class="row"><a class="btn grow" href="#word?new=1&h=${encodeURIComponent(w.headword)}">＋ 別の意味を新しい項目で追加</a>${meaningsOf(w).length > 1 || (w.senses || []).length > 1 ? '<button type="button" class="btn grow" id="split">意味ごとに分ける</button>' : ''}</div>
      <p class="hint">1つの項目＝1つの意味のまとまりです。似た訳（例：割り当てる／配分する）は同じ項目に並べ、意味が違うもの（例：妥協する／損なう）は別項目にします。</p>`}
      ${siblings.length ? `<div class="card stack"><span class="small muted">同じ見出し語の他の意味</span>${siblings.map((x) => `<a class="link" href="#word?id=${x.id}">${esc(x.headword)}：${esc(meaningsOf(x).join('、') || '（意味未入力）')}</a>`).join('')}</div>` : ''}

      <h2 class="sec">分類</h2>
      <div class="card stack">
        <label class="field"><span>タグ（カンマ区切り）</span><input name="tags" value="${esc((w.tags || []).join(', '))}" autocapitalize="off"></label>
        <div class="field"><span>単語集</span>
          ${decks.length ? `<div class="chips">${decks.map((d) => `<label class="chk"><input type="checkbox" name="deck" value="${d.id}" ${(w.deckIds || []).includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div>` : '<span class="small">単語集はまだありません（<a href="#decks" class="link">作成</a>）</span>'}
        </div>
      </div>

      <button class="btn primary" type="submit">${isNew ? '登録する' : '保存する'}</button>
    </form>

    ${isNew ? '' : `
    <h2 class="sec">習得度</h2>
    <div class="card stack">
      <div class="kv"><span>総合（最も低いスキル）</span>${chip(ov.level, mastery)}</div>
      ${ov.avg != null ? `<p class="hint">参考：平均 ${ov.avg.toFixed(1)}。総合は平均ではなく最低値で表示しています。</p>` : ''}
      ${SKILLS.map((s) => skillRow(s, mastery[s])).join('')}
      ${EXTRA_SKILLS.filter((s) => mastery[s]).map((s) => `<div class="kv"><span>${SKILL_LABELS[s]}（レッスン・ゲーム）</span>${chip(effLevel(mastery[s]), { [s]: mastery[s] }, true)}</div>`).join('')}
      <p class="hint">「手動」は次に自動判定が出るまで有効。「固定」にすると学習しても変わりません（記録は続きます）。</p>
    </div>

    <h2 class="sec">学習データ</h2>
    <div class="card stack">
      <div class="kv"><span>正答率</span><b>${att ? Math.round((cor / att) * 100) + '%（' + cor + '/' + att + '）' : '—'}</b></div>
      <div class="kv"><span>平均回答時間</span><b>${ms.length ? (ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) + '秒' : '—'}</b></div>
      <div class="kv"><span>最終学習日</span><b>${fmtDate(lastAt, false)}</b></div>
      <div class="kv"><span>次回復習予定</span><b>${fmtDate(nextDue, false)}${rev ? `<span class="small muted">（間隔${rev.intervalDays < 1 ? '1日未満' : Math.round(rev.intervalDays) + '日'}）</span>` : ''}</b></div>
      <div class="row"><span class="small muted grow">復習予定を変更</span><button type="button" class="btn sm" data-due="0">今日</button><button type="button" class="btn sm" data-due="3">3日後</button><button type="button" class="btn sm" data-due="14">2週間後</button></div>
      <div class="kv"><span>登録日時</span><b>${fmtDate(w.createdAt)}</b></div>
      <div class="kv"><span>登録元</span><b>${esc(SOURCE_JA[w.source?.type] || w.source?.type || '—')}${w.source?.note ? '（' + esc(w.source.note) + '）' : ''}</b></div>
    </div>

    ${w.ma ? '<div class="card" id="maAudio"></div>' : ''}
    <div id="waBox">${isNew ? '' : (await import('./audio-words-ui.js')).wordAudioHTML(w)}</div>
    ${vrefs.length ? `<h2 class="sec">元の動画</h2><div class="card stack">${vrefs.map((r) => vnames[r.videoId]
      ? `<a class="vref" href="#video-play?id=${r.videoId}&t=${r.time}">${icon('play', 14)} <b>${esc(vnames[r.videoId].name)}</b> <span class="muted small">${Math.floor(r.time / 60)}:${String(Math.floor(r.time % 60)).padStart(2, '0')}</span>${r.text ? `<span class="small block">${esc(r.text)}</span>` : ''}</a>`
      : `<div class="small muted">（動画は削除済み）${esc(r.text || '')}</div>`).join('')}</div>` : ''}

    ${hist.length ? `<h2 class="sec">習得度の変更履歴</h2><div class="card">${hist.map((h) => `<div class="hrow"><span>${fmtDate(h.at)}・${SKILL_LABELS[h.skill]}</span><b>${esc(histText(h))}</b></div>`).join('')}</div>` : ''}

    <button class="btn danger" id="del" style="margin-top:22px">この単語を削除</button>`}
  `;

  const sensesEl = $('#senses', el);
  const senses = structuredClone(w.senses?.length ? w.senses : [newSense()]);
  function drawSenses() {
    sensesEl.innerHTML = senses.map((s, i) => `
      <div class="card stack sense" data-i="${i}">
        <div class="row between"><b class="small muted">意味 ${i + 1}</b>${senses.length > 1 ? `<button type="button" class="link small danger-text" data-rm="${i}">削除</button>` : ''}</div>
        <label class="field"><span>日本語訳（「/」で複数）</span><input data-k="meanings" value="${esc((s.meanings || []).join(' / '))}"></label>
        <label class="field"><span>品詞</span><select data-k="pos">${[...new Set([...POS_OPTIONS, s.pos || ''])].map((p) => `<option value="${esc(p)}" ${s.pos === p ? 'selected' : ''}>${p ? esc(posJa(p)) : '—'}</option>`).join('')}</select></label>
        ${wl === 'es' ? `<label class="field"><span>性（名詞のみ）</span><select data-k="gender">${[['', '—'], ['m', '男性名詞'], ['f', '女性名詞']].map(([v, l]) => `<option value="${v}" ${s.gender === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>例文</span><textarea data-k="ex_en" rows="2" autocapitalize="off" ${langAttr(wl)}>${esc(s.examples?.[0]?.en || '')}</textarea></label>
        <label class="field"><span>例文の日本語訳</span><textarea data-k="ex_ja" rows="2">${esc(s.examples?.[0]?.ja || '')}</textarea></label>
        <details><summary class="small muted">テスト用の詳細設定</summary>
          <label class="field"><span>別解（和→英テストで正解にする表現、「/」区切り）</span><input data-k="accepted" value="${esc((s.accepted || []).join(' / '))}" autocapitalize="off"></label>
          <label class="field"><span>出題時のヒント文脈（例：仕事を〜）</span><input data-k="context" value="${esc(s.context || '')}"></label>
        </details>
      </div>`).join('');
  }
  function readSenses() {
    $$('.sense', sensesEl).forEach((card) => {
      const s = senses[+card.dataset.i];
      const v = (k) => $(`[data-k=${k}]`, card).value.trim();
      s.meanings = splitList(v('meanings').replace(/,/g, '/'));
      s.pos = v('pos'); s.context = v('context');
      const g = $('[data-k=gender]', card); if (g) s.gender = g.value;
      s.accepted = v('accepted').split(/\s*[\/／]\s*/).filter(Boolean);
      const en = v('ex_en'), ja = v('ex_ja');
      const rest = (s.examples || []).slice(1);
      s.examples = en || ja ? [{ en, ja }, ...rest] : rest;
    });
  }
  drawSenses();
  $('#split', el)?.addEventListener('click', () => splitDialog(w, el, params));
  sensesEl.addEventListener('click', (e) => { const i = e.target.dataset.rm; if (i != null) { readSenses(); senses.splice(+i, 1); drawSenses(); } });
  if (w.ma) mountMAAudio($('#maAudio', el), w).catch(err => toast(err.message));
  $('#say', el).onclick = async () => {
    if (w.ma) {
      unlock();
      if (!await playMA(w) && !await playMA(w, 'example')) toast('フレーズ音声は未確定、または参照切れです。MA原音声欄を確認してください');
      return;
    }
    if (!isNew) { try { const m = await import('./word-audio.js'); if (await m.playWord(await db.get('words', w.id) || w)) return; } catch {} } sayOrig($('[name=headword]', el).value, () => speak($('[name=headword]', el).value, 0.95, wl)); };

  // 1.19.31: the word's sounds (references). Changes are saved at once; w.audio follows so 保存する keeps them.
  if (!isNew && $('#waBox', el)) {
    const wa = await import('./audio-words-ui.js');
    const redraw = async () => { const fresh = await db.get('words', w.id); w.audio = fresh?.audio; $('#waBox', el).innerHTML = wa.wordAudioHTML(w); wa.bindWordAudio($('#waBox', el), w.id, redraw); };
    wa.bindWordAudio($('#waBox', el), w.id, redraw);
  }
  $('#f', el).onsubmit = async (e) => {
    e.preventDefault();
    readSenses();
    const fd = new FormData(e.target);
    const head = fd.get('headword').trim();
    if (!head) return toast('英単語を入力してください');
    const newMeanings = senses.flatMap((x) => x.meanings);
    const dup = findDuplicate(await wordsByHead(wl), head, newMeanings, w.id);
    if (dup) {
      const ok = await confirmDialog({ title: '同じ意味の項目があります', body: `<p>「${esc(dup.headword)}：${esc(meaningsOf(dup).join('、'))}」と意味が重なっています。それでも登録しますか？</p><p class="hint">意味が違う場合は、重ならない訳にしてください。同じ見出し語でも、意味が違えば別の項目として登録できます。</p>`, okLabel: '登録する', cancelLabel: 'やめる' });
      if (!ok) return;
    }
    w.headword = head; w.ipa = fd.get('ipa').trim();
    if ($('#verified', el)?.checked) w.review = 'verified';
    w.senses = senses.filter((s, i) => s.meanings.length || s.examples.length || i === 0);
    w.tags = splitList(fd.get('tags'));
    w.deckIds = fd.getAll('deck');
    if (w.ma) {
      const current = await db.get('words', w.id);
      if (current?.ma) w.ma = current.ma;
    }
    await saveWord(w);
    toast(isNew ? '登録しました' : '保存しました');
    if (isNew) go(`#word?id=${w.id}`); else wordDetail(el, new URLSearchParams(`id=${w.id}`));
  };

  if (isNew) return;
  el.querySelectorAll('[data-due]').forEach((b) => (b.onclick = async () => { await setDue(w.id, Date.now() + +b.dataset.due * 86400000 - (b.dataset.due === '0' ? 60000 : 0), { kind: 'word', lang: wl }); toast('復習予定を変更しました'); wordDetail(el, params); }));
  $('#bm', el).onclick = async (e) => {
    const on = await toggleBookmark(w.id); w.bookmarked = on;
    const b = e.currentTarget; b.classList.toggle('on', on); b.innerHTML = bmIcon(on);
  };
  el.querySelectorAll('[data-skill]').forEach((row) => {
    const skill = row.dataset.skill;
    $('select', row).addEventListener('change', async (e) => {
      const l = +e.target.value; if (!l) return;
      await setManual(w.id, [skill], l, { lock: !!mastery[skill]?.locked });
      wordDetail(el, params);
    });
    $('[data-act=lock]', row)?.addEventListener('click', async () => { await setLock(w.id, skill, !mastery[skill]?.locked); wordDetail(el, params); });
    $('[data-act=auto]', row)?.addEventListener('click', async () => { await resetToAuto(w.id, skill); wordDetail(el, params); });
  });
  $('#del', el).onclick = async () => {
    const ok = await confirmDialog({ title: `「${w.headword}」を削除`, body: '<p>単語・習得度・復習予定が削除されます。過去の回答記録は学習履歴として残ります。</p>', okLabel: '削除', danger: true });
    if (!ok) return;
    await deleteWord(w.id); toast('削除しました'); go('#vocab');
  };
}

function splitDialog(w, el, params) {
  const ms = meaningsOf(w);
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>「${esc(w.headword)}」を意味ごとに分ける</h3>
    <p class="hint">それぞれの訳を、どの項目に入れるか選びます。同じ番号の訳は同じ項目になります。例文・学習記録は項目1に残ります。</p>
    ${ms.map((m, i) => `<div class="row between"><span>${esc(m)}</span><select data-i="${i}" style="width:auto">${ms.map((_, g) => `<option value="${g}" ${g === Math.min(i, 1) ? 'selected' : ''}>項目${g + 1}</option>`).join('')}</select></div>`).join('')}
    <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">分ける</button></div></form>`;
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const groups = [];
    $$('select[data-i]', dlg).forEach((sel) => { const g = +sel.value; (groups[g] ||= []).push(ms[+sel.dataset.i]); });
    const gs = groups.filter((g) => g?.length);
    if (gs.length < 2 || !groups[0]?.length) return toast('項目1と、少なくとも1つの別項目に訳を入れてください');
    const created = await splitWord(w.id, gs);
    toast(`${created.length + 1}つの項目に分けました（新しい項目には例文を追加してください）`);
    wordDetail(el, params);
  };
  dlg.showModal();
}

function skillRow(skill, m) {
  const lv = effLevel(m), src = source(m), st = status(m);
  const srcText = { locked: '🔒 手動固定', manual: '✋ 手動', auto: '自動判定', none: st === 'pending' ? `判定保留（回答${m.stats.attempts}回）` : '未評価' }[src];
  return `
    <div class="skill" data-skill="${skill}">
      <div class="row between"><b>${SKILL_LABELS[skill]}</b><span class="small muted">${srcText}</span></div>
      <div class="row">
        <select class="grow">${lv === 0 ? `<option value="0" selected>${st === 'pending' ? '判定保留' : '未評価'}</option>` : ''}${[1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${lv === l ? 'selected' : ''}>${l}：${LEVEL_LABELS[l]}</option>`).join('')}</select>
        <button class="btn sm" data-act="lock">${m?.locked ? '固定解除' : '固定'}</button>
        ${m?.manualLevel != null ? '<button class="btn sm" data-act="auto">自動に戻す</button>' : ''}
      </div>
      ${m?.stats?.attempts ? `<p class="hint">回答${m.stats.attempts}回・正答${m.stats.correct}・連続正答${m.stats.streak}${m.autoLevel ? '・自動判定 ' + LEVEL_LABELS[m.autoLevel] : ''}</p>` : ''}
    </div>`;
}
function histText(h) {
  const t = (l) => (l ? LEVEL_LABELS[l] : '未評価');
  const r = { import: '移行時', split: '分割時', list: '一覧から', lock: '固定', unlock: '固定解除', auto: '自動に戻す', manual: '' }[h.reason] ?? '';
  return `${t(h.from)} → ${t(h.to)}${h.locked ? ' 🔒' : ''}${r ? '（' + r + '）' : ''}`;
}

// ================= Bulk add =================
export async function vocabBulk(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>まとめて追加</h1></header>
    <div class="card stack">
      <p class="small muted">1行に1語。英語と意味の間はカンマ（,）・タブ・スペースのどれでも可（例：put off 延期する）。意味が複数なら「/」で区切ります。先頭の番号は自動で外します。</p>
      <textarea id="t" rows="10" placeholder="postpone, 延期する&#10;take over, 引き継ぐ / 乗っ取る&#10;in advance, 前もって" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <label class="field"><span>タグ（任意・全件に付与）</span><input id="tags" autocapitalize="off"></label>
      <label class="chk"><input type="checkbox" id="bm"> 全件ブックマークする</label>
      <button class="btn primary" id="prev">確認する</button>
    </div>
    <div id="out"></div>`;
  $('#prev', el).onclick = () => previewAndRegister(el, parseBulk($('#t', el).value), { type: 'bulk' }, { tags: splitList($('#tags', el).value), bookmarked: $('#bm', el).checked });
}

// shared preview -> register. Rows with problems are listed with the reason and NOT registered unless ticked.
const FIELD_JA = { headword: '英語（見出し語）', meanings: '意味', example_en: '例文', example_ja: '例文の訳', pos: '品詞', tags: 'タグ' };
async function previewAndRegister(el, entries, src, extra = {}, csv = null) {
  const out = $('#out', el);
  const lang = curLang();
  const notes = csv ? csv.analysis.notes : [];
  let rows = [];
  if (!entries.length) {
    const why = csv ? (notes.join('。') || '読み取れる行がありません')
      : '入力が空です。1行に「英語, 意味」の形で入力してください（例：postpone, 延期する）';
    out.innerHTML = `<div class="card warn stack"><b>登録できる行がありません</b><span class="small">${esc(why)}</span>
      ${csv ? mapHTML(csv.analysis) : ''}
      <a class="btn" href="#word?new=1">1語ずつ追加する</a></div>`;
    bindMap();
    return;
  }
  const byHead = await wordsByHead(lang);
  rows = entries.map((e) => {
    const dup = findDuplicate(byHead, e.headword, e.meanings || []);
    const issues = entryIssues(e, e.lang || lang);
    if (!dup) { const k = headKey(e.headword); if (!byHead.has(k)) byHead.set(k, []); byHead.get(k).push({ id: '_', headword: e.headword, senses: [{ meanings: e.meanings || [] }] }); }
    return { e, dup, issues, on: !dup && !issues.length };
  });
  const draw = () => {
    const n = rows.filter((r) => r.on).length;
    const bad = rows.filter((r) => r.issues.length).length;
    out.innerHTML = `
      ${notes.length ? `<div class="notice info small">${notes.map(esc).join('<br>')}</div>` : ''}
      ${csv ? mapHTML(csv.analysis) : ''}
      <h2 class="sec">確認（${n}件を登録${bad ? ` / 要確認 ${bad}件` : ''}${rows.some((r) => r.dup) ? ` / 重複 ${rows.filter((r) => r.dup).length}件` : ''}）</h2>
      ${bad ? '<p class="hint">要確認の行は、列のずれなどの可能性があるため登録しません。正しければチェックを入れてください。値の自動補完はしていません。</p>' : ''}
      <div class="card">${rows.map((r, i) => `<label class="prow ${r.dup ? 'dup' : ''} ${r.issues.length ? 'bad' : ''}">
        <input type="checkbox" data-i="${i}" ${r.on ? 'checked' : ''} ${r.dup ? 'disabled' : ''}>
        <span class="grow"><b>${esc(r.e.headword)}</b> <span>${esc((r.e.meanings || []).join('、') || '（意味なし）')}</span>
        ${r.e.example_en ? `<span class="small muted block">例文：${esc(r.e.example_en)}</span>` : ''}
        ${r.dup ? '<em>同じ意味で登録済み</em>' : ''}${r.issues.map((x) => `<em class="warn-text">${esc(x)}</em>`).join('')}</span></label>`).join('')}</div>
      ${rows.some((r) => r.on && !(r.e.meanings || []).length) ? '<p class="hint">意味がない単語は、あとで詳細画面から追加してください（意味がないとテストに出せません）。</p>' : ''}
      <button class="btn primary" id="reg" ${n ? '' : 'disabled'}>${n}件を登録</button>`;
    out.querySelectorAll('input[data-i]').forEach((c) => (c.onchange = () => { rows[+c.dataset.i].on = c.checked; draw(); }));
    bindMap();
    $('#reg', out).onclick = async () => {
      const r = await registerEntries(rows.filter((x) => x.on).map((x) => x.e), src, extra);
      // duplicates (not registered again): put the existing word into this deck too
      let linked = r.linked || 0;
      if (extra.deckIds?.length) for (const x of rows.filter((y) => !y.on && y.dup && y.dup.id !== '_')) { const cur = await db.get('words', x.dup.id); if (!cur) continue; const add = extra.deckIds.filter((d) => !(cur.deckIds || []).includes(d)); if (add.length) { cur.deckIds = [...(cur.deckIds || []), ...add]; await db.put('words', cur); linked++; } }
      toast(`${r.added}件を登録しました${r.skipped ? `（${r.skipped}件スキップ）` : ''}${linked ? `・登録済みの${linked}件を単語集に追加` : ''}`, 3500);
      go('#vocab');
    };
  };
  draw();
  out.scrollIntoView({ behavior: 'smooth' });

  function mapHTML(a) {
    if (!a.columns.length) return '';
    const opt = (field) => `<select data-f="${field}"><option value="">使わない</option>${a.columns.map((c, i) => `<option value="${i}" ${a.map[field] === i ? 'selected' : ''}>${esc(c.name)}${c.sample ? '：' + esc(c.sample.slice(0, 24)) : ''}</option>`).join('')}</select>`;
    return `<details class="card details" ${a.entries.length && !rows.some((r) => r.issues.length) ? '' : 'open'}><summary>読み取った列${a.header ? '' : '（列名なし）'}</summary>
      ${['headword', 'meanings', 'example_en', 'example_ja'].map((f) => `<label class="field"><span>${FIELD_JA[f]}</span>${opt(f)}</label>`).join('')}
      <p class="hint">違っていたら列を選び直してください。すぐに確認画面が更新されます。</p></details>`;
  }
  function bindMap() {
    if (!csv) return;
    out.querySelectorAll('select[data-f]').forEach((sel) => (sel.onchange = () => {
      const m = {}; out.querySelectorAll('select[data-f]').forEach((x) => { if (x.value !== '') m[x.dataset.f] = +x.value; });
      for (const k of ['pos', 'tags', 'bookmarked', 'accepted', 'ipa', 'lang', 'gender']) if (csv.analysis.map[k] != null) m[k] = csv.analysis.map[k];
      const a = analyzeCSV(csv.text, m);
      previewAndRegister(el, a.entries, src, extra, { text: csv.text, analysis: a });
    }));
  }
}

// ================= CSV import =================
export async function vocabCSV(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>CSVから追加</h1></header>
    <div class="card stack">
      <p class="small muted">列名（headword / meanings / example_en、「英語」「熟語」「意味」「例文」など）があれば列名で、なければ中身から列を判断します。番号の列は自動で飛ばします。読み取った列は確認画面で変更できます。</p>
      <label class="btn" for="file">📂 CSVファイルを選ぶ</label>
      <input type="file" id="file" accept=".csv,text/csv,text/plain" hidden>
      <label class="field"><span>タグ（任意・全件に付与）</span><input id="tags" autocapitalize="off"></label>
      <label class="field"><span>単語集（任意・元データごとにまとめるとき）</span><input id="deckName" list="deckList" autocapitalize="off" placeholder="例：金の熟語 E"></label>
      <datalist id="deckList">${(await db.all('decks')).map((d) => `<option value="${esc(d.name)}">`).join('')}</datalist>
    </div>
    <div id="out"></div>`;
  // the deck by name (made if new); same-headword words already registered are added to it too
  const deckIdOf = async (name) => {
    name = (name || '').trim(); if (!name) return [];
    const ds = await db.all('decks'); let d = ds.find((x) => x.name === name);
    if (!d) { d = { id: uid('d_'), name, createdAt: Date.now() }; await db.put('decks', d); }
    return [d.id];
  };
  // from the studio inside this app: the pasted CSV comes in directly
  let pending = null; try { pending = JSON.parse(sessionStorage.getItem('ell-pending-csv') || 'null'); sessionStorage.removeItem('ell-pending-csv'); } catch {}
  if (pending?.text) {
    $('#deckName', el).value = pending.deck || '';
    const a = analyzeCSV(pending.text);
    previewAndRegister(el, a.entries, { type: 'studio', note: pending.note || pending.deck || '' }, { tags: [], deckIds: await deckIdOf(pending.deck) }, { text: pending.text, analysis: a });
  }
  $('#file', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    if (/\.(xlsx|xls|numbers)$/i.test(f.name)) { $('#out', el).innerHTML = '<div class="card warn">Excel・Numbersのファイルは直接読めません。Numbersなら「共有 → 書き出す → CSV」で書き出したファイルを選んでください。</div>'; return; }
    const text = await f.text();
    const a = analyzeCSV(text);
    previewAndRegister(el, a.entries, { type: 'csv', note: f.name }, { tags: splitList($('#tags', el).value), deckIds: await deckIdOf($('#deckName', el).value) }, { text, analysis: a });
  };
}

// ================= Paste text & select =================
export async function vocabPaste(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>英文から選んで追加</h1></header>
    <div class="card stack">
      <textarea id="t" rows="6" placeholder="英文を貼り付け" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <button class="btn" id="go">単語を選ぶ</button>
    </div>
    <div id="pick"></div>
    <div id="out"></div>`;
  $('#go', el).onclick = () => {
    const text = $('#t', el).value.trim();
    if (!text) return;
    const sentences = text.match(/[^.!?。]+[.!?。]?/g) || [text];
    let n = 0;
    $('#pick', el).innerHTML = `
      <p class="hint">語をタップして選択。隣り合った語を続けて選ぶと熟語になります。</p>
      <div class="card ptext">${sentences.map((s, si) => s.split(/(\s+)/).map((tok) => {
        if (!tok.trim()) return tok;
        const m = tok.match(/^([^A-Za-z']*)([A-Za-z][A-Za-z'\-]*)([^A-Za-z']*)$/);
        if (!m) return esc(tok);
        return `${esc(m[1])}<span class="tok" data-n="${n++}" data-s="${si}">${esc(m[2])}</span>${esc(m[3])}`;
      }).join('')).join('')}</div>
      <button class="btn primary" id="next">選んだ語で登録へ</button>`;
    const pick = $('#pick', el);
    pick.addEventListener('click', (e) => { const t = e.target.closest('.tok'); if (t) t.classList.toggle('on'); });
    $('#next', pick).onclick = () => {
      const toks = $$('.tok', pick);
      const groups = []; let cur = null;
      toks.forEach((t, i) => {
        if (t.classList.contains('on')) {
          if (cur && +toks[i - 1]?.dataset.n === +t.dataset.n - 1 && toks[i - 1].classList.contains('on') && toks[i - 1].dataset.s === t.dataset.s) cur.words.push(t.textContent);
          else { cur = { words: [t.textContent], s: +t.dataset.s }; groups.push(cur); }
        } else cur = null;
      });
      if (!groups.length) return toast('語を選んでください');
      const entries = groups.map((g) => ({ headword: g.words.join(' '), meanings: [], example_en: sentences[g.s].trim(), example_ja: '' }));
      previewAndRegister(el, entries, { type: 'paste' });
      $('#out', el).insertAdjacentHTML('afterbegin', '<p class="hint">選んだ文が例文として保存されます。意味は登録後に入力してください。</p>');
    };
  };
}

// ================= Decks =================
export async function decksScreen(el) {
  const [decks, words] = await Promise.all([db.all('decks'), db.all('words')]);
  decks.sort((a, b) => a.createdAt - b.createdAt);
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>単語集</h1></header>
    <form class="card row" id="new"><input name="name" placeholder="新しい単語集の名前" class="grow" required><button class="btn primary sm">作成</button></form>
    <div id="dl">${decks.map((d) => `
      <div class="card row between" data-id="${d.id}">
        <div><b>${esc(d.name)}</b><div class="small muted">${words.filter((w) => (w.deckIds || []).includes(d.id)).length}語</div></div>
        <div class="row"><button class="btn sm" data-act="rename">名前変更</button><button class="btn sm danger" data-act="del">削除</button></div>
      </div>`).join('') || '<p class="muted center">単語集はまだありません</p>'}</div>
    <p class="hint">単語を単語集に入れるには、単語の詳細画面で選びます。</p>`;
  $('#new', el).onsubmit = async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim(); if (!name) return;
    await db.put('decks', { id: uid('d_'), name, createdAt: Date.now() });
    decksScreen(el);
  };
  $('#dl', el).addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const id = e.target.closest('[data-id]').dataset.id;
    const d = decks.find((x) => x.id === id);
    if (act === 'rename') {
      const name = prompt('新しい名前', d.name);
      if (name?.trim()) { d.name = name.trim(); await db.put('decks', d); decksScreen(el); }
    } else if (act === 'del') {
      if (!(await confirmDialog({ title: `「${d.name}」を削除`, body: '<p>単語集だけを削除します。単語自体は消えません。</p>', okLabel: '削除', danger: true }))) return;
      await db.delete('decks', id);
      const ws = words.filter((w) => (w.deckIds || []).includes(id)).map((w) => ({ ...w, deckIds: w.deckIds.filter((x) => x !== id) }));
      if (ws.length) await db.putMany('words', ws);
      decksScreen(el);
    }
  });
}
