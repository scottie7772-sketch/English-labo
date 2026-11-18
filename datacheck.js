// データ点検: finds words whose fields look shifted (number as headword, English in the meaning, Japanese in the example ...).
// Read-only until the user ticks rows and presses 実行. Every repair is snapshotted first and can be undone.
import { db, getMeta, setMeta } from './db.js';
import { $, $$, esc, toast, confirmDialog, fmtDate } from './ui.js';
import { icon } from './icons.js';
import { L, langOf } from './langs.js';
import { SKILLS, EXTRA_SKILLS, mid } from './mastery.js';
import { entryIssues, meaningsOf, headKey, splitList, saveWord, hasJa } from './words.js';

const SOURCE_JA = { manual: '手動', bulk: 'まとめて追加', csv: 'CSV', ocr: 'OCR', video: '動画字幕', mistake: '学習中の誤答', paste: '英文から選択', seed: '初期データ', listening: 'リスニング', speaking: '瞬間作文' };
const ALL_SKILLS = [...SKILLS, ...EXTRA_SKILLS, 'reading'];
const exOf = (w) => w.senses?.[0]?.examples?.[0] || {};

export async function scanWords() {
  const words = await db.all('words');
  const mastery = await db.all('mastery');
  const attemptsBy = {}; mastery.forEach((m) => { attemptsBy[m.wordId] = (attemptsBy[m.wordId] || 0) + (m.stats?.attempts || 0); });
  const flagged = [];
  const issuesOf = (w) => entryIssues({ headword: w.headword, meanings: meaningsOf(w), example_en: exOf(w).en || '' }, langOf(w));
  const good = new Map();   // headKey -> words without problems (per language)
  for (const w of words) if (!issuesOf(w).length) { const k = langOf(w) + '|' + headKey(w.headword); if (!good.has(k)) good.set(k, []); good.get(k).push(w); }
  for (const w of words) {
    const issues = issuesOf(w);
    if (!issues.length) continue;
    const ms = meaningsOf(w), ex = exOf(w);
    const history = attemptsBy[w.id] || 0;
    let action = null;
    const twin = ms.length ? (good.get(langOf(w) + '|' + headKey(ms[0])) || [])[0] : null;
    const headerLike = issues.some((x) => x.startsWith('見出し行'));
    if (twin) {
      const tm = meaningsOf(twin);
      const own = hasJa(ex.en) ? splitList(ex.en) : [];
      const extra = own.filter((m) => !tm.some((t) => t.includes(m) || m.includes(t)));
      action = { kind: 'delete', twin, text: `正しい項目「${twin.headword}：${tm.join('、') || '（意味なし）'}」があるので、この項目を削除${extra.length ? `（この項目の訳「${extra.join('、')}」は正しい項目にありません。必要なら正しい項目に手で追加してください）` : ''}` };
    }
    else if (headerLike) action = { kind: 'delete', text: '列名の行なので削除' };
    else if (ms.length && !ms.some(hasJa) && ex.en && hasJa(ex.en)) {
      const after = { headword: ms.join(' '), meanings: splitList(ex.en), exEn: ex.ja && !hasJa(ex.ja) ? ex.ja : '', exJa: '' };
      action = { kind: 'fix', after, text: `見出し語「${after.headword}」・意味「${after.meanings.join('、')}」に直す${after.exEn ? `（例文：${after.exEn}）` : '（例文は空にする）'}` };
    }
    flagged.push({ w, issues, history, action });
  }
  return { flagged, total: words.length };
}

export async function dataCheckScreen(el) {
  const { flagged, total } = await scanWords();
  const last = await getMeta('repair:last', null);
  const groups = {};
  for (const f of flagged) { const k = `${SOURCE_JA[f.w.source?.type] || f.w.source?.type || '不明'}${f.w.source?.note ? '（' + f.w.source.note + '）' : ''}`; (groups[k] ||= []).push(f); }
  const sel = new Set(flagged.filter((f) => f.action && !f.history).map((f) => f.w.id));
  el.innerHTML = `
    <header class="top"><a href="#settings" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>データ点検</h1></header>
    <p class="hint">全${total}項目を調べました。列がずれて登録された可能性のある項目を、登録元ごとに表示します。チェックを入れて「実行」を押すまで、データは変更しません。実行前の状態は保存され、元に戻せます。</p>
    ${last ? `<div class="card stack"><div class="kv"><span>前回の修正</span><b>${fmtDate(last.at)}・${last.words.length}項目</b></div><button class="btn" id="undo">${icon('undo', 18)} 前回の修正を元に戻す</button></div>` : ''}
    ${flagged.length ? Object.entries(groups).map(([g, list]) => `
      <h2 class="sec">登録元：${esc(g)} <span class="muted small">${list.length}件</span></h2>
      <div class="card list">${list.map((f) => `
        <label class="dcrow">
          <input type="checkbox" data-id="${f.w.id}" ${f.action ? '' : 'disabled'} ${sel.has(f.w.id) ? 'checked' : ''}>
          <span class="grow">
            <b>${esc(f.w.headword)}</b> <span>${esc(meaningsOf(f.w).join('、') || '（意味なし）')}</span> <span class="tagp">${esc(L(langOf(f.w)).short)}</span>
            ${exOf(f.w).en ? `<span class="small muted block">例文欄：${esc(exOf(f.w).en)}${exOf(f.w).ja ? ' / ' + esc(exOf(f.w).ja) : ''}</span>` : ''}
            <span class="small block warn-text">${f.issues.map(esc).join('・')}</span>
            <span class="small block">${f.action ? '→ ' + esc(f.action.text) : '→ 自動では直せません。<a class="link" href="#word?id=' + f.w.id + '">詳細画面で編集</a>'}</span>
            ${f.history ? `<span class="small block danger-text">学習記録が${f.history}回あります（初期状態では選択していません）</span>` : ''}
            <span class="small muted block">登録 ${fmtDate(f.w.createdAt)}</span>
          </span>
        </label>`).join('')}</div>`).join('') : '<p class="empty">問題のありそうな項目は見つかりませんでした</p>'}
    ${flagged.some((f) => f.action) ? '<div class="cta-bar"><div class="cta-count"><b id="nsel"></b><span>件</span></div><button class="btn primary cta" id="run">選んだ項目を修正</button></div>' : ''}`;
  const upd = () => { const n = $('#nsel', el); if (n) n.textContent = sel.size; const r = $('#run', el); if (r) r.disabled = !sel.size; };
  upd();
  $$('input[data-id]', el).forEach((c) => (c.onchange = () => { c.checked ? sel.add(c.dataset.id) : sel.delete(c.dataset.id); upd(); }));
  $('#undo', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '前回の修正を元に戻す', body: `<p>${last.words.length}項目を修正前の状態に戻します。</p>`, okLabel: '元に戻す' }))) return;
    await db.tx(['words', 'mastery', 'reviews'], 'readwrite', (t) => {
      last.words.forEach((w) => t.objectStore('words').put(w));
      last.mastery.forEach((m) => t.objectStore('mastery').put(m));
      last.reviews.forEach((r) => t.objectStore('reviews').put(r));
    });
    await setMeta('repair:last', null);
    toast('元に戻しました'); dataCheckScreen(el);
  });
  $('#run', el)?.addEventListener('click', async () => {
    const todo = flagged.filter((f) => sel.has(f.w.id) && f.action);
    const del = todo.filter((f) => f.action.kind === 'delete'), fix = todo.filter((f) => f.action.kind === 'fix');
    const ok = await confirmDialog({ title: '選んだ項目を修正', okLabel: '実行', body: `<p>削除 ${del.length}件・修正 ${fix.length}件。</p><p class="hint">実行前の状態を保存するので、この画面の「元に戻す」で戻せます。念のため、設定からJSONバックアップも保存しておくと安全です。</p>` });
    if (!ok) return;
    // snapshot everything that will change
    const snap = { at: Date.now(), words: todo.map((f) => structuredClone(f.w)), mastery: [], reviews: [] };
    for (const f of del) {
      for (const s of ALL_SKILLS) { const m = await db.get('mastery', mid(f.w.id, s)); if (m) snap.mastery.push(m); }
      const r = await db.get('reviews', f.w.id); if (r) snap.reviews.push(r);
    }
    await setMeta('repair:last', snap);
    await db.tx(['words', 'mastery', 'reviews'], 'readwrite', (t) => {
      for (const f of del) {
        t.objectStore('words').delete(f.w.id); t.objectStore('reviews').delete(f.w.id);
        for (const s of ALL_SKILLS) t.objectStore('mastery').delete(mid(f.w.id, s));
      }
    });
    for (const f of fix) {
      const w = f.w, a = f.action.after, s0 = w.senses[0];
      w.headword = a.headword; s0.meanings = a.meanings;
      s0.examples = a.exEn ? [{ en: a.exEn, ja: a.exJa }, ...(s0.examples || []).slice(1)] : (s0.examples || []).slice(1);
      w.repairedAt = Date.now();
      await saveWord(w);
    }
    toast(`削除${del.length}件・修正${fix.length}件を行いました`);
    dataCheckScreen(el);
  });
}
