// 1.19.31: English–Japanese data (JSON / ZIP, one or several chapters) applied to one Video Lab material or a whole
// Lab folder — the same data and the same choices as the Studio folder. Only translations change (no audio, no
// subtitles, no timings); every material is one entry in its 訳の変更履歴, so each can be undone.
import { db } from './db.js';
import { readVideoJa, compareVideoCues, cueStamps, labJaEntries, applyJaChanges } from './video-ja.js';
import { readScriptJa, planScriptJa } from './video-script-ja.js';
import { readStudioJaFiles, readStudioJaText, englishChapter } from './studio-ja.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const key = entries => JSON.stringify(entries.map(e => [e.ja, e.cueIds.slice().sort()]));
export const scriptOrder = cues => cues.some(c => c.studioOrder != null)
  ? cues.slice().sort((a, b) => (a.studioOrder ?? Infinity) - (b.studioOrder ?? Infinity) || compareVideoCues(a, b)) : cues.slice().sort(compareVideoCues);

// mode: 'missing' = only subtitles without a translation; 'rematch' = also replace translations from an earlier data file;
// 'overwrite' = also replace translations that came with the material (Studio / subtitle file). all: hand corrections too.
export function planLabJa(video, cues, records, sections, { mode = 'rematch', all = false } = {}) {
  const ids = new Set([video.id, video.from?.material].filter(Boolean));
  const rows = sections.flatMap(({ data, index }) => {
    if (data?.materialId != null && !ids.has(data.materialId)) return [];
    const input = readScriptJa(data, data?.materialId ?? null);
    return input.rows.map(row => ({ ...row, chapter: row.chapter || input.sourceChapter, section: index }));
  });
  const base = scriptOrder(cues).filter(c => c.en);
  const { patch, reviewCueIds } = planScriptJa(base.map(c => ({ id: c.id, en: c.en, chapter: englishChapter(c.en) })), { rows }, { allowUnknownChapters: true });
  const current = labJaEntries(base, records), byId = new Map(base.map(c => [c.id, c]));
  const writable = id => {
    const { entries, link } = current.get(id), cue = byId.get(id);
    const hand = Boolean(link?.manual || cue.jaEdited);
    if (mode === 'missing') return !entries.length && !hand;
    if (all) return true;
    if (hand) return false;
    if (mode === 'overwrite') return true;
    // re-match: translations that came with the material (Studio transfer, legacy subtitle text) stay
    return !entries.length || Boolean(link && !link.studio);
  };
  // a translation shared by several subtitles is applied to all of them or to none (never half a group)
  const blocked = new Set();
  for (const [id, entries] of patch) if (entries.length && !writable(id)) for (const e of entries) e.cueIds.forEach(x => blocked.add(x));
  const changes = [];
  let kept = 0;
  for (const [id, entries] of patch) {
    if (!entries.length) continue;   // a blank translation in the data is not a delete instruction
    if (blocked.has(id) || entries.some(e => e.cueIds.some(x => blocked.has(x) || !byId.has(x)))) { kept++; continue; }
    const before = current.get(id).entries;
    if (key(before) === key(entries)) continue;
    changes.push({ cueId: id, before, after: entries.map(e => ({ ja: e.ja, cueIds: e.cueIds.slice().sort() })) });
  }
  // a subtitle whose old translation was shared with one that now changes must change in the same step
  const touched = new Set(changes.map(c => c.cueId));
  for (const id of [...touched]) for (const e of current.get(id).entries) for (const x of e.cueIds) if (!touched.has(x) && byId.has(x)) {
    const rest = current.get(x).entries.map(f => key([f]) === key([e]) ? { ja: f.ja, cueIds: f.cueIds.filter(y => !touched.has(y)) } : f).filter(f => f.cueIds.length);
    changes.push({ cueId: x, before: current.get(x).entries, after: rest }); touched.add(x);
  }
  const total = base.length, matched = patch.size;
  return { changes, counts: { total, matched, changed: changes.length, kept, review: reviewCueIds.size, unmatched: total - matched } };
}

async function labMaterial(id) {
  const video = await db.get('videos', id);
  if (!video) return null;
  const { blob, audioBlob, ...meta } = video;
  return { video: meta, cues: await db.byIndex('cues', 'videoId', id), records: await readVideoJa(id) };
}

// ---------- screens ----------
const toast = (text, ms = 3500) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); };
const pause = () => new Promise(r => setTimeout(r, 60));
function sheet(title, body, buttons) {
  const dlg = document.getElementById('dialog');
  if (dlg.open) { dlg.onclose = null; dlg.close(); }
  dlg.innerHTML = `<form method="dialog" class="dlg stack jp-sheet"><span class="dlg-global-close" hidden></span><h3>${esc(title)}</h3>${body}
    <div class="jp-grid">${buttons.map(([v, l, c = '']) => `<button class="btn sm ${c}" value="${v}">${esc(l)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise(resolve => { dlg.onclose = () => resolve({ value: dlg.returnValue, dlg }); dlg.showModal(); });
}

export async function openLabJaBatch(videoIds, title) {
  // 1) the data: files (JSON / ZIP, several) or pasted JSON
  let files = [];
  const pick = sheet('英日データで日本語訳を反映', `<p class="small">${esc(title)}（${videoIds.length}教材）。英文と日本語訳のJSON・ZIP（複数選択可・1つのJSONに複数章も可）を照合して、日本語訳だけを更新します。</p>
    <label class="btn primary" for="labJaFiles">JSONまたはZIPを選ぶ</label><input type="file" id="labJaFiles" accept=".json,.zip,application/json,application/zip" multiple hidden>
    <details><summary class="small">JSONを貼り付ける</summary><textarea id="labJaText" rows="6" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></details>`,
    [['text', '貼り付けたJSONを使う'], ['close', '閉じる', 'ghost']]);
  const dlg0 = document.getElementById('dialog');
  dlg0.querySelector('#labJaFiles').onchange = e => { files = [...e.target.files]; if (files.length) dlg0.close('files'); };
  const first = await pick;
  let sections;
  try {
    if (first.value === 'files') sections = await readStudioJaFiles(files);
    else if (first.value === 'text') sections = await readStudioJaText(first.dlg.querySelector('#labJaText').value);
    else return false;
  } catch (error) { toast(error.message, 6000); return false; }
  await pause();
  // 2) how
  const how = await sheet('反映のしかた', `<p class="small">英日データ ${sections.length}件</p><div class="stack small">
      <label class="chk"><input type="radio" name="mode" value="missing"> <span><b>未割当の字幕だけ</b><br><span class="muted">訳のない字幕だけに入れます。</span></span></label>
      <label class="chk"><input type="radio" name="mode" value="rematch" checked> <span><b>再照合（以前の英日データの訳を更新）</b><br><span class="muted">スタジオから来た訳・手で直した訳はそのまま。</span></span></label>
      <label class="chk"><input type="radio" name="mode" value="overwrite"> <span><b>上書き（英日対応済みの訳も置き換え）</b><br><span class="muted">データに一致した字幕は、スタジオから来た訳も置き換えます。一致しない字幕はそのまま。</span></span></label>
      <label class="chk"><input type="checkbox" name="all"> 手で直した訳（位置調整・修正）も上書きする</label>
      <span class="muted">教材ごとに「訳の変更履歴」から元に戻せます。</span></div>`, [['next', '候補を確認', 'primary'], ['close', '閉じる', 'ghost']]);
  if (how.value !== 'next') return false;
  const mode = how.dlg.querySelector('[name=mode]:checked')?.value || 'rematch', all = how.dlg.querySelector('[name=all]')?.checked;
  await pause();
  // 3) preview, one material at a time (text only)
  const plans = [];
  for (const id of videoIds) {
    const m = await labMaterial(id); if (!m) continue;
    try { plans.push({ id, name: m.video.name, ...planLabJa(m.video, m.cues, m.records, sections, { mode, all }) }); }
    catch (error) { plans.push({ id, name: m.video.name, error: error.message, changes: [], counts: {} }); }
    await new Promise(r => setTimeout(r, 0));
  }
  const n = plans.reduce((a, p) => a + p.changes.length, 0);
  const review = await sheet('反映内容の確認', `<p class="small">方法：<b>${mode === 'missing' ? '未割当の字幕だけ' : mode === 'overwrite' ? '上書き' : '再照合'}</b>・手で直した訳は${all ? '<b>上書きします</b>' : '保持します'}。更新する字幕 <b>${n}</b>行。</p>
    <div class="jp-list">${plans.map(p => `<div class="small"><b>${esc(p.name)}</b><br>${p.error ? `<span class="warn-text">${esc(p.error)}</span>` :
      `字幕 ${p.counts.total}行・データと一致 ${p.counts.matched}行・更新 ${p.counts.changed}行${p.counts.kept ? `・保持 ${p.counts.kept}行` : ''}${p.counts.review ? `・要確認 ${p.counts.review}行` : ''}`}</div>`).join('')}</div>`,
    n ? [['go', '反映する', 'primary'], ['close', 'キャンセル', 'ghost']] : [['close', '閉じる', 'ghost']]);
  if (review.value !== 'go') return false;
  await pause();
  // 4) write: planned again against the current data, material by material
  let done = 0, failed = 0;
  for (const p of plans.filter(x => x.changes.length)) {
    try {
      const m = await labMaterial(p.id);
      const fresh = planLabJa(m.video, m.cues, m.records, sections, { mode, all });
      if (fresh.changes.length) await applyJaChanges(p.id, fresh.changes, cueStamps(m.cues), { label: `英日データを反映（${fresh.changes.length}行）`, mode: 'import' });
      done++;
    } catch { failed++; }
  }
  toast(`${done}教材の日本語訳を更新しました${failed ? `（${failed}教材は失敗）` : ''}`, 4500);
  return true;
}
