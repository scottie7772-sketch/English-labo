// Phase 2: Vocabulary Manager screens
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, speak, fmtDate } from './ui.js';
import { SKILLS, SKILL_LABELS, LEVEL_LABELS, effLevel, status, source, overall, filterLevel, levelText, loadAllMastery, loadWordMastery, setManual, setLock, resetToAuto } from './mastery.js';
import { newWord, newSense, saveWord, toggleBookmark, deleteWord, existingHeadMap, headKey, splitList, parseBulk, csvToEntries, registerEntries } from './words.js';

const POS_JA = { noun: '名詞', verb: '動詞', adjective: '形容詞', adverb: '副詞', preposition: '前置詞', conjunction: '接続詞', pronoun: '代名詞', 'phrasal verb': '句動詞', idiom: 'イディオム', phrase: '熟語' };
const POS_OPTIONS = ['', 'noun', 'verb', 'adjective', 'adverb', 'phrasal verb', 'idiom', 'phrase', 'preposition', 'conjunction'];
const posJa = (p) => POS_JA[p] || p || '';
const SOURCE_JA = { manual: '手動', bulk: '一括登録', csv: 'CSV', ocr: 'OCR', video: '動画字幕', mistake: '学習中の誤答', paste: '英文から選択', seed: '初期データ' };

const DEFAULT_FILTER = { q: '', bm: 'all', kind: 'all', levels: [], skill: 'overall', tag: '', deck: '', sort: 'new' };
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
  const [words, mastery, decks] = await Promise.all([db.all('words'), loadAllMastery(), db.all('decks')]);
  const tags = [...new Set(words.flatMap((w) => w.tags || []))].sort();

  el.innerHTML = `
    <header class="top"><h1>単語・熟語</h1><span class="grow"></span>
      <button class="icon-btn" id="add" aria-label="追加">＋</button></header>
    <div class="searchbar"><input id="q" type="search" placeholder="検索（英語・日本語）" value="${esc(f.q)}" autocapitalize="off" autocorrect="off"></div>
    <details class="card filters" ${hasFilter(f) ? 'open' : ''}>
      <summary>絞り込み <span class="muted small" id="fsum"></span></summary>
      <div class="fgrp"><span>ブックマーク</span>${seg('bm', [['all', 'すべて'], ['yes', '済み'], ['no', '未']], f.bm)}</div>
      <div class="fgrp"><span>種類</span>${seg('kind', [['all', 'すべて'], ['word', '単語'], ['phrase', '熟語']], f.kind)}</div>
      <div class="fgrp"><span>習得度の基準</span>
        <select id="skill">${[['overall', '総合（最も低いスキル）'], ...SKILLS.map((s) => [s, SKILL_LABELS[s]])].map(([v, l]) => `<option value="${v}" ${f.skill === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="fgrp"><span>習得度（複数可）</span><div class="chips" id="levels">
        ${[1, 2, 3, 4, 5].map((l) => `<button data-l="${l}" class="${f.levels.includes(l) ? 'on' : ''}">${LEVEL_LABELS[l]}</button>`).join('')}
      </div><p class="hint">未評価・判定保留は「未習得」に含まれます</p></div>
      <div class="fgrp"><span>タグ</span><select id="tag"><option value="">すべて</option>${tags.map((t) => `<option ${f.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="fgrp"><span>単語集</span><select id="deck"><option value="">すべて</option>${decks.map((d) => `<option value="${d.id}" ${f.deck === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <a href="#decks" class="link small">単語集を管理</a></div>
      <div class="fgrp"><span>並び順</span><select id="sort">${[['new', '新しい順'], ['old', '古い順'], ['abc', 'ABC順'], ['weak', '習得度が低い順']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button class="btn ghost" id="clear">条件をクリア</button>
    </details>
    <p class="muted small" id="count"></p>
    <div id="list"></div>`;

  const listEl = $('#list', el);
  function draw() {
    const q = f.q.trim().toLowerCase();
    let rows = words.filter((w) => {
      if (f.bm === 'yes' && !w.bookmarked) return false;
      if (f.bm === 'no' && w.bookmarked) return false;
      if (f.kind === 'word' && w.isPhrase) return false;
      if (f.kind === 'phrase' && !w.isPhrase) return false;
      if (f.tag && !(w.tags || []).includes(f.tag)) return false;
      if (f.deck && !(w.deckIds || []).includes(f.deck)) return false;
      if (f.levels.length && !f.levels.includes(filterLevel(lvOf(mastery[w.id], f.skill)))) return false;
      if (q) {
        const hay = (w.headword + ' ' + (w.senses || []).flatMap((s) => s.meanings || []).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const cmp = {
      new: (a, b) => b.createdAt - a.createdAt, old: (a, b) => a.createdAt - b.createdAt,
      abc: (a, b) => a.headword.localeCompare(b.headword),
      weak: (a, b) => filterLevel(lvOf(mastery[a.id], f.skill)) - filterLevel(lvOf(mastery[b.id], f.skill)) || a.headword.localeCompare(b.headword),
    }[f.sort];
    rows.sort(cmp);
    $('#count', el).textContent = `${rows.length} / ${words.length} 件`;
    $('#fsum', el).textContent = hasFilter(f) ? '（条件あり）' : '';
    if (!words.length) { listEl.innerHTML = `<div class="card center muted">まだ単語がありません。右上の＋から追加できます。</div>`; return; }
    listEl.innerHTML = rows.map((w) => {
      const lv = lvOf(mastery[w.id], f.skill);
      return `
      <div class="wcard" data-id="${w.id}">
        <a class="wmain" href="#word?id=${w.id}">
          <b>${esc(w.headword)}</b>${w.isPhrase ? '<span class="tagp">熟語</span>' : ''}
          <span class="mean">${esc((w.senses || []).flatMap((s) => s.meanings || []).join('、') || '（意味未入力）')}</span>
        </a>
        <div class="wact">
          <button class="icon-btn spk" data-say="${esc(w.headword)}" aria-label="発音">🔊</button>
          <span class="grow"></span>
          <label class="lvsel">${chip(lv, mastery[w.id])}
            <select data-lv="${w.id}" aria-label="習得度">
              ${lv === 0 ? `<option value="0" selected>${esc(levelText(0, mastery[w.id]))}</option>` : ''}
              ${[1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${lv === l ? 'selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('')}
            </select></label>
          <button class="bm ${w.bookmarked ? 'on' : ''}" data-bm="${w.id}" aria-label="ブックマーク">${bmIcon(w.bookmarked)}</button>
        </div>
      </div>`;
    }).join('');
  }
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
  for (const k of ['skill', 'tag', 'deck', 'sort']) $('#' + k, el).addEventListener('change', (e) => { f[k] = e.target.value; saveFilter(); draw(); });
  $('#clear', el).onclick = () => { filter = { ...DEFAULT_FILTER }; saveFilter(); vocabList(el); };
  $('#add', el).onclick = addMenu;

  listEl.addEventListener('click', async (e) => {
    const bm = e.target.closest('[data-bm]');
    if (bm) {
      const id = bm.dataset.bm;
      const on = await toggleBookmark(id);
      const w = words.find((x) => x.id === id); w.bookmarked = on;
      bm.classList.toggle('on', on); bm.innerHTML = bmIcon(on);
      if (f.bm !== 'all') draw();
      return;
    }
    const spk = e.target.closest('[data-say]');
    if (spk) speak(spk.dataset.say);
  });
  listEl.addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-lv]'); if (!s) return;
    const id = s.dataset.lv, l = +s.value; if (!l) return;
    await setManual(id, SKILLS, l, { lock: false, reason: 'list' });
    Object.assign(mastery, { [id]: await loadWordMastery(id) });
    toast(`「${words.find((w) => w.id === id).headword}」を${LEVEL_LABELS[l]}に変更（4スキルすべて）`);
    draw();
  });
}

function hasFilter(f) { return f.bm !== 'all' || f.kind !== 'all' || f.levels.length || f.tag || f.deck; }
function seg(k, opts, cur) { return `<div class="seg" data-k="${k}">${opts.map(([v, l]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
function bmIcon(on) { return `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 3h12v18l-6-4.5L6 21z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`; }

async function addMenu() {
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <form method="dialog" class="dlg stack">
      <h3>単語を追加</h3>
      <a class="btn" href="#word?new=1">✏️ 1語ずつ追加</a>
      <a class="btn" href="#vocab-bulk">📋 まとめて追加（1行1語）</a>
      <a class="btn" href="#vocab-paste">📰 英文を貼り付けて選ぶ</a>
      <a class="btn" href="#vocab-csv">📄 CSVファイルから</a>
      <button class="btn ghost" value="cancel">閉じる</button>
    </form>`;
  dlg.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => dlg.close()));
  dlg.showModal();
}

// ================= Detail / Edit =================
export async function wordDetail(el, params) {
  const isNew = params.get('new') === '1';
  const w = isNew ? newWord({ headword: params.get('h') || '', source: { type: params.get('src') || 'manual' } }) : await db.get('words', params.get('id'));
  if (!w) { el.innerHTML = `<header class="top"><a href="#vocab" class="back">‹</a><h1>見つかりません</h1></header>`; return; }
  const decks = await db.all('decks');
  const mastery = isNew ? {} : await loadWordMastery(w.id);
  const hist = isNew ? [] : (await db.byIndex('masteryChanges', 'wordId', w.id)).sort((a, b) => b.at - a.at).slice(0, 20);
  const reviews = isNew ? [] : await db.byIndex('reviews', 'wordId', w.id);
  const nextDue = reviews.length ? Math.min(...reviews.map((r) => r.due)) : null;
  const allStats = SKILLS.map((s) => mastery[s]?.stats).filter(Boolean);
  const att = allStats.reduce((a, s) => a + (s.attempts || 0), 0), cor = allStats.reduce((a, s) => a + (s.correct || 0), 0);
  const lastAt = Math.max(0, ...allStats.map((s) => s.lastAt || 0)) || null;
  const ms = allStats.filter((s) => s.avgMs).map((s) => s.avgMs);
  const ov = overall(mastery);

  el.innerHTML = `
    <header class="top"><a href="${isNew ? '#vocab' : '#vocab'}" class="back">‹</a><h1>${isNew ? '単語を追加' : '単語の詳細'}</h1><span class="grow"></span>
      ${isNew ? '' : `<button class="bm big ${w.bookmarked ? 'on' : ''}" id="bm">${bmIcon(w.bookmarked)}</button>`}</header>

    <form id="f" class="stack" autocomplete="off">
      <div class="card stack">
        <label class="field"><span>英単語・熟語</span>
          <div class="row"><input name="headword" value="${esc(w.headword)}" required autocapitalize="off" autocorrect="off" spellcheck="false" class="big-input">
          <button type="button" class="icon-btn" id="say">🔊</button></div></label>
        <label class="field"><span>発音記号（任意）</span><input name="ipa" value="${esc(w.ipa)}" autocapitalize="off"></label>
      </div>

      <h2 class="sec">意味・用法 <span class="muted small">（意味ごとに分けて管理）</span></h2>
      <div id="senses"></div>
      <button type="button" class="btn ghost" id="addSense">＋ 別の意味・用法を追加</button>

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
      <p class="hint">「手動」は次に自動判定が出るまで有効。「固定」にすると学習しても変わりません（記録は続きます）。</p>
    </div>

    <h2 class="sec">学習データ</h2>
    <div class="card stack">
      <div class="kv"><span>正答率</span><b>${att ? Math.round((cor / att) * 100) + '%（' + cor + '/' + att + '）' : '—'}</b></div>
      <div class="kv"><span>平均回答時間</span><b>${ms.length ? (ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) + '秒' : '—'}</b></div>
      <div class="kv"><span>最終学習日</span><b>${fmtDate(lastAt, false)}</b></div>
      <div class="kv"><span>次回復習予定</span><b>${fmtDate(nextDue, false)}</b></div>
      <div class="kv"><span>登録日時</span><b>${fmtDate(w.createdAt)}</b></div>
      <div class="kv"><span>登録元</span><b>${esc(SOURCE_JA[w.source?.type] || w.source?.type || '—')}${w.source?.note ? '（' + esc(w.source.note) + '）' : ''}</b></div>
    </div>

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
        <label class="field"><span>英文例</span><textarea data-k="ex_en" rows="2" autocapitalize="off">${esc(s.examples?.[0]?.en || '')}</textarea></label>
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
      s.accepted = v('accepted').split(/\s*[\/／]\s*/).filter(Boolean);
      const en = v('ex_en'), ja = v('ex_ja');
      const rest = (s.examples || []).slice(1);
      s.examples = en || ja ? [{ en, ja }, ...rest] : rest;
    });
  }
  drawSenses();
  $('#addSense', el).onclick = () => { readSenses(); senses.push(newSense()); drawSenses(); };
  sensesEl.addEventListener('click', (e) => { const i = e.target.dataset.rm; if (i != null) { readSenses(); senses.splice(+i, 1); drawSenses(); } });
  $('#say', el).onclick = () => speak($('[name=headword]', el).value);

  $('#f', el).onsubmit = async (e) => {
    e.preventDefault();
    readSenses();
    const fd = new FormData(e.target);
    const head = fd.get('headword').trim();
    if (!head) return toast('英単語を入力してください');
    const dup = (await existingHeadMap()).get(headKey(head));
    if (dup && dup.id !== w.id) {
      const ok = await confirmDialog({ title: '同じ見出し語があります', body: `<p>「${esc(dup.headword)}」はすでに登録されています。別の単語として登録しますか？</p><p class="hint">同じ単語の別の意味なら、既存の単語に「意味」を追加する方が管理しやすくなります。</p>`, okLabel: '登録する', cancelLabel: 'やめる' });
      if (!ok) return;
    }
    w.headword = head; w.ipa = fd.get('ipa').trim();
    w.senses = senses.filter((s, i) => s.meanings.length || s.examples.length || i === 0);
    w.tags = splitList(fd.get('tags'));
    w.deckIds = fd.getAll('deck');
    await saveWord(w);
    toast(isNew ? '登録しました' : '保存しました');
    if (isNew) go(`#word?id=${w.id}`); else wordDetail(el, new URLSearchParams(`id=${w.id}`));
  };

  if (isNew) return;
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
  const r = { import: '移行時', list: '一覧から', lock: '固定', unlock: '固定解除', auto: '自動に戻す', manual: '' }[h.reason] ?? '';
  return `${t(h.from)} → ${t(h.to)}${h.locked ? ' 🔒' : ''}${r ? '（' + r + '）' : ''}`;
}

// ================= Bulk add =================
export async function vocabBulk(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back">‹</a><h1>まとめて追加</h1></header>
    <div class="card stack">
      <p class="small muted">1行に1語。英語と意味の間はカンマ（,）かタブ。意味が複数なら「/」で区切ります。</p>
      <textarea id="t" rows="10" placeholder="postpone, 延期する&#10;take over, 引き継ぐ / 乗っ取る&#10;in advance, 前もって" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <label class="field"><span>タグ（任意・全件に付与）</span><input id="tags" autocapitalize="off"></label>
      <label class="chk"><input type="checkbox" id="bm"> 全件ブックマークする</label>
      <button class="btn primary" id="prev">確認する</button>
    </div>
    <div id="out"></div>`;
  $('#prev', el).onclick = () => previewAndRegister(el, parseBulk($('#t', el).value), { type: 'bulk' }, { tags: splitList($('#tags', el).value), bookmarked: $('#bm', el).checked });
}

// shared preview -> register
async function previewAndRegister(el, entries, src, extra = {}) {
  const out = $('#out', el);
  if (!entries.length) { out.innerHTML = '<div class="card warn">登録できる行がありません</div>'; return; }
  const exist = await existingHeadMap();
  const seen = new Set();
  const rows = entries.map((e) => { const k = headKey(e.headword); const dup = exist.has(k) || seen.has(k); seen.add(k); return { ...e, dup }; });
  const n = rows.filter((r) => !r.dup).length;
  out.innerHTML = `
    <h2 class="sec">確認（${n}件を登録 / 重複${rows.length - n}件はスキップ）</h2>
    <div class="card">${rows.map((r) => `<div class="prow ${r.dup ? 'dup' : ''}"><b>${esc(r.headword)}</b><span>${esc(r.meanings.join('、') || '（意味なし）')}</span>${r.dup ? '<em>登録済み</em>' : ''}</div>`).join('')}</div>
    ${rows.some((r) => !r.dup && !r.meanings.length) ? '<p class="hint">意味がない単語は、あとで詳細画面から追加してください（意味がないとテストに出せません）。</p>' : ''}
    <button class="btn primary" id="reg" ${n ? '' : 'disabled'}>${n}件を登録</button>`;
  out.scrollIntoView({ behavior: 'smooth' });
  $('#reg', out).onclick = async () => {
    const r = await registerEntries(entries, src, extra);
    toast(`${r.added}件を登録しました${r.skipped ? `（${r.skipped}件スキップ）` : ''}`);
    go('#vocab');
  };
}

// ================= CSV import =================
export async function vocabCSV(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back">‹</a><h1>CSVから追加</h1></header>
    <div class="card stack">
      <p class="small muted">1行目に見出しがあれば列名で読み取ります（headword / meanings / pos / example_en / example_ja / tags / bookmarked。「英語」「意味」など日本語の列名も可）。見出しがない場合は「英語, 意味, 例文, 例文訳」の順とみなします。</p>
      <label class="btn" for="file">📂 CSVファイルを選ぶ</label>
      <input type="file" id="file" accept=".csv,text/csv,text/plain" hidden>
      <label class="field"><span>タグ（任意・全件に付与）</span><input id="tags" autocapitalize="off"></label>
    </div>
    <div id="out"></div>`;
  $('#file', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const entries = csvToEntries(await f.text());
    previewAndRegister(el, entries, { type: 'csv', note: f.name }, { tags: splitList($('#tags', el).value) });
  };
}

// ================= Paste text & select =================
export async function vocabPaste(el) {
  el.innerHTML = `
    <header class="top"><a href="#vocab" class="back">‹</a><h1>英文から選んで追加</h1></header>
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
    <header class="top"><a href="#vocab" class="back">‹</a><h1>単語集</h1></header>
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
