import { db } from './db.js';
import { $, esc, toast } from './ui.js';
import { loadWordMastery, levelText, overall } from './mastery.js';
import { meaningsOf } from './words.js';
import { parseMA, readMAStudyZip, importMA, maLinks, validMALink, playMA, saveMABoundary, maMaterial, chapterFor, indexChapter, indexStudioChapter } from './ma-phrases.js';
import { unlock, playRef } from './word-audio.js';

export async function maImportScreen(el) {
  el.innerHTML = `<header class="top"><a href="#vocab" class="back">‹ 戻る</a><h1>MAフレーズ</h1></header>
    <form class="card stack">
      <label class="field">MAフレーズ集ZIP<input type="file" name="zip" accept=".zip,application/zip"></label>
      <p class="hint">MA_Phrase_Study.zip はこの欄だけで登録できます。個別ファイルを使う場合は下の欄を選んでください。</p>
      <label class="field">フレーズCSV<input type="file" name="csv" accept=".csv,text/csv"></label>
      <label class="field">原文TXT（任意）<input type="file" name="en" accept=".txt,text/plain"></label>
      <label class="field">和訳TXT（任意）<input type="file" name="ja" accept=".txt,text/plain"></label>
      <p class="hint">CSVの必須列は phrase、meaning、priority（1〜3）です。id は再インポート時も同じ値を使ってください。同じ id の行を追加すると使用例を複数登録できます。</p>
      <p class="hint">使用例は example_en と example_ja、出典は chapter と position、前後の文は before と after、異形は variants（| 区切り）。TXTを使う場合は原文・和訳を同じ順で空行区切りにし、CSVの paragraph に原文の段落番号（1から）を指定できます。CSVに使用例がない場合は、フレーズが含まれる段落を取り込みます。</p>
      <button class="btn primary">端末に登録</button>
      <button type="button" id="maRescan" class="btn">登録済みのMAフレーズを音声と再照合</button><output aria-live="polite"></output>
    </form>`;
  const form = $('form', el), out = $('output', form), button = $('button', form);
  const rescan = $('#maRescan', form);
  const scan = async message => {
    const summary = { lab: 0, studio: 0, chapters: 0, matches: 0, count: 0, unavailable: 0, failed: 0 };
    const collect = async (kind, run) => {
      try {
        const result = await run();
        if (!result) return;
        summary[kind]++;
        if (result.chapters.length) summary.chapters++;
        summary.matches += result.stats.matches;
        summary.count += result.count;
        summary.unavailable += result.stats.unavailable;
      } catch { summary.failed++; }
    };
    out.textContent = message + ' 音声を照合中…';
    for (const id of await db.keys('videos')) {
      if (!out.isConnected) return;
      const video = await db.get('videos', id);
      if (maMaterial(video)) await collect('lab', async () => indexChapter(id, await chapterFor(video)));
    }
    const { sdb } = await import('./studio-db.js');
    for (const set of await sdb.all('sets')) {
      if (!out.isConnected) return;
      await collect('studio', () => indexStudioChapter(set));
    }
    const s = summary;
    out.textContent = message + ` ラボ ${s.lab}教材・スタジオ ${s.studio}教材・章特定 ${s.chapters}教材・字幕一致 ${s.matches}件・再生可 ${s.count}件・音声区間なし／未確定 ${s.unavailable}件・エラー ${s.failed}教材。`;
  };
  const run = async task => {
    button.disabled = rescan.disabled = true;
    try { await task(); }
    catch (err) { out.textContent = err.message; }
    finally { button.disabled = rescan.disabled = false; }
  };
  rescan.onclick = () => run(async () => {
    if (!(await db.all('words')).some(w => w.ma)) throw Error('先にMAフレーズ集を登録してください');
    await scan('再照合の結果');
  });
  form.onsubmit = e => {
    e.preventDefault();
    return run(async () => {
      const files = ['csv', 'en', 'ja'].map(name => form.elements[name].files[0]);
      const zip = form.elements.zip.files[0];
      if (zip && files.some(Boolean)) throw Error('ZIPと個別ファイルのどちらかを選んでください');
      if (!zip && !files[0]) throw Error('ZIPまたはCSVを選んでください');
      const items = zip ? await readMAStudyZip(zip) : parseMA(...await Promise.all(files.map(file => file?.text() || '')));
      const n = await importMA(items);
      const message = `${n}件を登録・更新しました。単語集「MAフレーズ」で学習できます。`;
      await scan(message);
    });
  };
}

const confirmedPhrase = link => link.manual?.state === 'confirmed' ? link.manual : link.phrase;
const formatStatus = (w, links, broken, videoId) => {
  const entries = Object.entries(w.ma.chapters || {}).filter(([id]) => !videoId || id === videoId).map(([, value]) => value);
  const result = [];
  if (links.length > broken) result.push('紐づけ済み');
  if (broken || entries.some(c => c.stale)) result.push('参照切れ');
  if (entries.some(c => c.candidates.length) || (!videoId && maLinks(w, null, true).length > maLinks(w).length)) result.push('候補あり');
  return result.join('・') || '未紐づけ';
};

export function maStatus(w) {
  return formatStatus(w, maLinks(w), 0, null);
}

export async function showMAPhrase(wordId, videoId = null, pause = null) {
  const w = await db.get('words', wordId);
  if (!w?.ma) return;
  const mastery = await loadWordMastery(w.id);
  const dlg = $('#dialog');
  if (dlg.open) return;
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(w.headword)}</h3>
    <p>${esc(meaningsOf(w).join('、'))}</p>
    <p>優先度 ${w.ma.priority}・${esc(levelText(overall(mastery).level, mastery))}</p>
    <div data-ma-panel></div>
    <a class="btn" href="#word?id=${encodeURIComponent(w.id)}">単語帳で開く</a>
    <button class="btn ghost">閉じる</button></form>`;
  $('a', dlg).onclick = () => dlg.close();
  dlg.showModal();
  await mountMAAudio($('[data-ma-panel]', dlg), w, { videoId, pause, adjust: false });
}

export async function mountMAAudio(root, w, { videoId = null, pause = null, adjust = true } = {}) {
  const links = maLinks(w, videoId, true);
  const valid = await Promise.all(links.map(validMALink));
  if (!root.isConnected) return;
  root.innerHTML = `<div class="stack"><b>MA原音声</b>
    <p class="small">優先度 ${w.ma.priority}・${formatStatus(w, links, valid.filter(x => !x).length, videoId)}</p>
    ${links.map((link, i) => {
      const phrase = confirmedPhrase(link);
      const saved = link.manual || phrase;
      return `<section class="stack" data-ma-source="${link.ref.origin.from === 'studio' ? 'studio' : 'lab'}"><small>${link.ref.origin.from === 'studio' ? 'スタジオ' : 'Video Lab'}・${esc(link.ref.origin.title)}</small><div>${esc(link.ref.origin.text)}</div>
        ${valid[i] ? `<div class="row wrap">
          <button type="button" class="btn sm" data-ma-play="${i}:example">▶ ${link.legacy ? '字幕の音声を試聴（境界未確認）' : link.context ? '使用例を含む字幕' : '使用例'}</button>
          ${phrase ? `<button type="button" class="btn sm" data-ma-play="${i}:word">▶ フレーズ</button>` : '<span class="small">フレーズ単体の時刻は未確定</span>'}
        </div>
        ${adjust ? `<details data-ma-edge="${i}"><summary>フレーズの境界を調整</summary>
          <div class="row wrap"><label>開始（秒）<input type="number" step="0.001" data-edge="start" value="${saved?.start ?? link.ref.start}"></label>
          <label>終了（秒）<input type="number" step="0.001" data-edge="end" value="${saved?.end ?? link.ref.end}"></label></div>
          <div class="row wrap"><button type="button" class="btn sm" data-action="preview">試聴</button>
          <button type="button" class="btn sm" data-action="draft">下書き保存</button>
          <button type="button" class="btn sm" data-action="confirm">境界を確定</button></div>
        </details>` : ''}` : '<small>参照切れ</small>'}</section>`;
    }).join('')}
    ${adjust && w.ma.examples.length ? `<details><summary>本文での使用例（${w.ma.examples.length}件）</summary>
    ${w.ma.examples.map(e => `<p><small>${esc(e.source || [e.chapter, e.position].filter(Boolean).join('・'))}</small><br>${esc(e.en)}<br>${esc(e.ja)}</p>`).join('')}</details>` : ''}</div>`;
  root.onclick = async e => {
    const target = e.target.closest('button');
    if (!target) return;
    if (target.dataset.maPlay) {
      const [i, kind] = target.dataset.maPlay.split(':');
      unlock();
      pause?.();
      if (!await playMA(w, kind, { link: links[i] })) toast('元音声を再生できません。教材と参照を確認してください');
    }
    if (target.dataset.action) {
      unlock();
      const box = target.closest('[data-ma-edge]'), link = links[box.dataset.maEdge];
      const start = $('[data-edge="start"]', box).valueAsNumber, end = $('[data-edge="end"]', box).valueAsNumber;
      try {
        if (target.dataset.action === 'preview') {
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < link.ref.start || end > link.ref.end || end - start < .08) throw new Error('使用例の範囲内で開始・終了を指定してください');
          if (!await validMALink(link) || !await playRef({ ...link.ref, start, end, limit: { min: start, max: end } })) throw new Error('元音声を再生できません');
        } else {
          await saveMABoundary(w.id, link, start, end, target.dataset.action === 'confirm');
          const fresh = await db.get('words', w.id);
          // Keep the form's copy in sync so saving other word fields cannot revert the boundary.
          w.ma = fresh.ma;
          await mountMAAudio(root, w, { videoId, pause, adjust });
        }
      } catch (err) { toast(err.message); }
    }
  };
}
