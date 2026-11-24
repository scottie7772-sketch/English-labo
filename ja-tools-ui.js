// 1.19.30: dialogs shared by Video Lab and Studio — Studio/Lab translation reflection, correction export / import,
// and the saved-change history of Video Lab (undo after saving, also after a restart).
import { db } from './db.js';
import { sdb, liveBlocks, commit } from './studio-db.js';
import { readVideoJa, compareVideoCues, applyJaChanges, readJaHistory, revertJaHistory, labManualCueIds, labJaEntries,
  labPatchUnits, cueStamps } from './video-ja.js';
import { studioJaManual, studioJaView, studioPatchUnits } from './studio-ja.js';
import { compareStudioLab, studioToLabChanges, labToStudioBlocks, labAgreedChanges, SYNC_STATUS } from './ja-sync.js';
import { buildCorrections, readCorrections, matchCorrections, applyCorrectionsToMa, isCorrections } from './ja-corrections.js';
import { APP_VERSION } from './app-version.js';
import { isSymbolRow } from './studio-ma-tools.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n = 60) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const toastMsg = (text, ms = 3000) => {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = text; t.hidden = false; clearTimeout(toastMsg.timer); toastMsg.timer = setTimeout(() => { t.hidden = true; }, ms);
};
const pause = () => new Promise(r => setTimeout(r, 60));   // Safari: let a dialog finish closing before the next one opens
function sheet(title, body, buttons) {
  const dlg = document.getElementById('dialog');
  if (dlg.open) { dlg.onclose = null; dlg.close(); }
  dlg.innerHTML = `<form method="dialog" class="dlg stack jp-sheet"><span class="dlg-global-close" hidden></span><h3>${esc(title)}</h3>${body}
    <div class="jp-grid">${buttons.map(([value, label, cls = '']) => `<button class="btn sm ${cls}" value="${value}">${esc(label)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise(resolve => { dlg.onclose = () => resolve({ value: dlg.returnValue, dlg }); dlg.showModal(); });
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
const pickFile = () => new Promise(resolve => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = () => resolve(input.files[0] || null); input.click();
});
const safeName = s => String(s || 'material').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

// ---------- loading (text only: media records are never read) ----------
export async function labMaterial(videoId) {
  const video = await db.get('videos', videoId);
  if (!video) throw new Error('教材が見つかりません');
  const { blob, audioBlob, ...meta } = video;
  const cues = (await db.byIndex('cues', 'videoId', videoId)).sort(compareVideoCues);
  const ordered = cues.some(c => c.studioOrder != null) ? cues.slice().sort((a, b) => (a.studioOrder ?? Infinity) - (b.studioOrder ?? Infinity) || compareVideoCues(a, b)) : cues;
  return { video: meta, cues: ordered, records: await readVideoJa(videoId) };
}
export async function studioMaterial(setId) {
  const set = await sdb.get('sets', setId);
  if (!set) throw new Error('スタジオの教材が見つかりません');
  return { set, blocks: await liveBlocks(set) };
}
const guardOf = set => ({ folder: set.folder, updatedAt: set.updatedAt, order: [...set.order], undo: [...(set.undo || [])], redo: [...(set.redo || [])] });
async function labVideosOf(setId) {
  return (await db.all('videos')).filter(v => v.from?.material === setId).map(({ blob, audioBlob, ...v }) => v)
    .sort((a, b) => (a.kind === 'multi' ? -1 : 0) - (b.kind === 'multi' ? -1 : 0) || String(a.name).localeCompare(String(b.name)));
}

// ================= Studio <-> Lab =================
export async function openJaSync({ setId, videoId = null, start = 'studio' }) {
  let changed = false;
  let material, videos;
  try { material = await studioMaterial(setId); videos = await labVideosOf(setId); }
  catch (error) { toastMsg(error.message, 4000); return false; }
  if (!videos.length) { await sheet('スタジオとLabの訳', '<p class="small">この教材から作ったLabの教材がありません。</p>', [['close', '閉じる']]); return false; }
  let direction = start === 'lab' ? 'toStudio' : 'toLab';
  let chosen = new Set(videoId ? [videoId] : videos.map(v => v.id));
  for (;;) {
    const pick = await sheet('スタジオとLabの訳を比較', `<p class="small">教材：${esc(material.set.title)}。訳だけを比較・反映します（音声認識・照合・教材化はやり直しません）。自動では同期しません。</p>
      <fieldset class="stack small"><legend>反映の方向</legend>
        <label class="chk"><input type="radio" name="dir" value="toLab" ${direction === 'toLab' ? 'checked' : ''}> スタジオ → Lab</label>
        <label class="chk"><input type="radio" name="dir" value="toStudio" ${direction === 'toStudio' ? 'checked' : ''}> Lab → スタジオ</label></fieldset>
      <fieldset class="stack small"><legend>Labの教材（反映先・または反映元）</legend>
        ${videos.map(v => `<label class="chk"><input type="checkbox" name="vid" value="${esc(v.id)}" ${chosen.has(v.id) ? 'checked' : ''}> ${esc(v.name)}${v.kind === 'multi' ? '（まとめ）' : ''}</label>`).join('')}</fieldset>
      <p class="small muted">Lab → スタジオは1教材ずつ反映します（最初にチェックした教材）。</p>`, [['compare', '比較する', 'primary'], ['close', '閉じる', 'ghost']]);
    if (pick.value !== 'compare') return changed;
    direction = pick.dlg.querySelector('[name=dir]:checked')?.value || direction;
    chosen = new Set([...pick.dlg.querySelectorAll('[name=vid]:checked')].map(x => x.value));
    if (!chosen.size) { toastMsg('Labの教材を選んでください'); await pause(); continue; }
    await pause();
    const targets = direction === 'toStudio' ? [videos.find(v => chosen.has(v.id))] : videos.filter(v => chosen.has(v.id));
    material = await studioMaterial(setId);
    const guard = guardOf(material.set);
    const loaded = [];
    for (const v of targets) {
      const lab = await labMaterial(v.id);
      loaded.push({ v, lab, units: compareStudioLab(material.blocks, lab.cues, lab.records), stamps: cueStamps(lab.cues) });
    }
    const wanted = direction;
    let k = 0;
    const unitHTML = (u, t, i) => {
      const checked = u.status === wanted;
      const usable = u.status !== 'en' && u.status !== 'same' && !(wanted === 'toStudio' && u.mixed);
      return `<div class="card stack small"><label class="chk">${usable ? `<input type="checkbox" name="u" value="${t}:${i}" ${checked ? 'checked' : ''}>` : ''}
        <b>${esc(SYNC_STATUS[u.status])}</b>${u.mixed && wanted === 'toStudio' ? '（個別訳と共有訳が混在：Labで整理してください）' : ''}</label>
        ${u.rows.map(r => `<div>${esc(clip(r.en, 70))}<br><span class="muted">スタジオ：${esc(r.S) || '（なし）'}</span><br><span class="muted">Lab：${esc(r.L) || '（なし）'}</span></div>`).join('')}
        ${u.status === 'conflict' ? `<span class="warn-text small">双方で変更されています。チェックすると${wanted === 'toLab' ? 'Lab' : 'スタジオ'}の訳を上書きします。</span>` : ''}
        ${u.status !== wanted && u.status !== 'conflict' && usable ? `<span class="small muted">反対側の方が新しい可能性があります（初期状態では反映しません）</span>` : ''}</div>`;
    };
    const body = loaded.map((x, t) => {
      const diff = x.units.filter(u => u.status !== 'same');
      k += diff.length;
      const count = s => x.units.filter(u => u.status === s).length;
      return `<details ${loaded.length === 1 ? 'open' : ''}><summary>${esc(x.v.name)}　差分 ${diff.length}件（一致 ${count('same')}・スタジオ側 ${count('toLab')}・Lab側 ${count('toStudio')}・競合 ${count('conflict')}・英文違い ${count('en')}）</summary>
        <div class="jp-list">${diff.map(u => unitHTML(u, t, x.units.indexOf(u))).join('') || '<p class="small muted">差分はありません</p>'}</div></details>`;
    }).join('');
    const review = await sheet(direction === 'toLab' ? 'スタジオ → Lab：反映内容の確認' : 'Lab → スタジオ：反映内容の確認',
      `<p class="small">チェックした項目だけを反映します。競合と反対側が新しい項目は初期状態でチェックしていません。</p>${body}`,
      k ? [['apply', '反映する', 'primary'], ['back', '戻る', 'ghost']] : [['back', '戻る', 'ghost']]);
    if (review.value !== 'apply') { await pause(); if (review.value === 'back') continue; return changed; }
    const picked = [...review.dlg.querySelectorAll('[name=u]:checked')].map(x => x.value.split(':').map(Number));
    await pause();
    if (!picked.length) { toastMsg('反映する項目がありません'); continue; }
    try {
      if (direction === 'toLab') {
        let n = 0;
        for (const [t, i] of picked.reduce((m, p) => m.set(p[0], [...(m.get(p[0]) || []), p[1]]), new Map())) {
          const x = loaded[t], units = i.map(j => x.units[j]);
          const { changes, base } = studioToLabChanges(material.blocks, x.lab.cues, x.lab.records, units);
          if (changes.length) { await applyJaChanges(x.v.id, changes, x.stamps, { label: 'スタジオの訳を反映', mode: 'studio', base }); n += units.length; }
        }
        toastMsg(`Labへ${n}件反映しました（Labの「訳の変更履歴」から戻せます）`, 4000);
      } else {
        const x = loaded[0], units = picked.map(([, i]) => x.units[i]);
        const { blocks, base } = labToStudioBlocks(material.blocks, x.lab.cues, x.lab.records, units);
        const set = await sdb.get('sets', setId);
        if (!set || JSON.stringify(guardOf(set)) !== JSON.stringify(guard)) throw new Error('スタジオの教材が変更されました。比較し直してください');
        if (blocks.length) await commit(set, 'Labの訳を反映', { blocks, guardedSet: guard });
        // Record the agreed text in Lab (no translation change there), for the next comparison.
        await applyJaChanges(x.v.id, labAgreedChanges(x.lab.cues, x.lab.records, units), x.stamps, { mode: 'base', history: false, base }).catch(() => {});
        toastMsg(`スタジオへ${units.length}件反映しました（スタジオの↶で戻せます）`, 4000);
      }
      changed = true;
      return changed;
    } catch (error) { toastMsg(error.message, 5000); return changed; }
  }
}

// ================= corrections =================
function labRows(cues) { return cues.filter(c => c.en).map(c => ({ id: c.id, en: c.en, itemId: c.itemId })); }
function studioRows(blocks) { return blocks.filter(b => (b.text || '').trim() && !isSymbolRow(b)).map(b => ({ id: b.id, en: b.text })); }
function labUnits(cues, records) {
  const manual = labManualCueIds(cues, records), entries = labJaEntries(cues, records), units = [], seen = new Set();
  for (const c of cues) {
    if (!manual.has(c.id) || !c.en) continue;
    const list = entries.get(c.id).entries;
    if (!list.length) { units.push({ ids: [c.id], ja: '', removed: true }); continue; }
    const own = list.filter(e => e.cueIds.length === 1).map(e => e.ja);
    if (own.length) units.push({ ids: [c.id], ja: own.join('\n') });
    for (const e of list.filter(e => e.cueIds.length > 1)) {
      const key = JSON.stringify(e.cueIds) + e.ja; if (seen.has(key)) continue; seen.add(key);
      units.push({ ids: e.cueIds, ja: e.ja });
    }
  }
  return units;
}
function studioUnits(blocks) {
  const units = [], view = studioJaView(blocks), byId = new Map(blocks.map(b => [b.id, b]));
  for (const b of blocks) {
    if (studioJaManual(b)) units.push({ ids: [b.id], ja: b.ja || '', removed: !b.ja });
    else if (b.jaImport?.owner === b.id && b.jaImport.manual && view.value(b))
      units.push({ ids: b.jaImport.members.map(m => m.id).filter(id => byId.has(id) && !studioJaManual(byId.get(id))), ja: b.jaImport.texts.join('\n') });
  }
  return units;
}
export async function exportCorrections(target) {
  if (target.kind === 'lab') {
    const { video, cues, records } = await labMaterial(target.videoId);
    return buildCorrections({ source: 'lab', materialId: video.id, studioSetId: video.from?.material || null, title: video.name, appVersion: APP_VERSION,
      rows: labRows(cues), units: labUnits(cues, records) });
  }
  const { set, blocks } = await studioMaterial(target.setId);
  return buildCorrections({ source: 'studio', studioSetId: set.id, title: set.title, appVersion: APP_VERSION, rows: studioRows(blocks), units: studioUnits(blocks) });
}
export async function importCorrections(target, data) {
  readCorrections(data);
  if (target.kind === 'lab') {
    const { video, cues, records } = await labMaterial(target.videoId);
    const result = matchCorrections(data, { source: 'lab', materialId: video.id, rows: labRows(cues) });
    const changes = labPatchUnits(cues, records, result.matched.map(m => ({ ids: m.ids, texts: m.item.removed ? [] : [m.item.ja] })));
    return { ...result, apply: () => applyJaChanges(video.id, changes, cueStamps(cues), { label: '修正JSONを取り込み' }) };
  }
  const { set, blocks } = await studioMaterial(target.setId);
  const guard = guardOf(set);
  const result = matchCorrections(data, { source: 'studio', studioSetId: set.id, rows: studioRows(blocks) });
  const changes = studioPatchUnits(blocks, result.matched.map(m => ({ ids: m.ids, texts: m.item.removed ? [] : [m.item.ja] })));
  return { ...result, apply: async () => {
    const fresh = await sdb.get('sets', set.id);
    if (!fresh || JSON.stringify(guardOf(fresh)) !== JSON.stringify(guard)) throw new Error('教材が変更されました。もう一度取り込んでください');
    return commit(fresh, '修正JSONを取り込み', { blocks: changes, guardedSet: guard });
  } };
}
async function readJsonFile(file) { try { return JSON.parse(await file.text()); } catch { throw new Error(file.name + '：JSONを読み取れません'); } }

export async function openJaCorrections(target) {
  let changed = false;
  for (;;) {
    let data;
    try { data = await exportCorrections(target); } catch (error) { toastMsg(error.message, 4000); return changed; }
    const r = await sheet('手動修正した訳', `<p class="small">手動で修正した英日対応：${data.items.length}件。英文・訳・前後の英文・字幕IDを書き出します（音声は含みません）。</p>
      <p class="small muted">同じ英文が複数ある場合は、前後の英文と何番目かで区別します。</p>`,
      [['export', '修正をJSONで書き出す', 'primary'], ['ma', '元のMA英日JSONに反映して書き出す'], ['import', '修正JSONを取り込む'], ['close', '閉じる', 'ghost']]);
    await pause();
    if (r.value === 'export') {
      if (!data.items.length) { toastMsg('手動修正した訳はまだありません'); continue; }
      download(`Englabo-${safeName(data.title)}-ja-corrections.json`, data);
      return changed;
    }
    if (r.value === 'ma') {
      if (!data.items.length) { toastMsg('手動修正した訳はまだありません'); continue; }
      const file = await pickFile(); if (!file) continue;
      try {
        const ma = await readJsonFile(file);
        if (isCorrections(ma)) throw new Error('元の英日対応JSON（MA）を選んでください');
        const out = applyCorrectionsToMa(ma, data);
        const go = await sheet('MA英日JSONへの反映', `<p class="small">${esc(file.name)}：変更 ${out.applied.length}件・反映できなかった修正 ${out.skipped.length}件。</p>
          ${out.skipped.length ? `<details><summary>反映できなかった修正</summary><ul class="small">${out.skipped.map(s => `<li>${esc(clip(s.item.en, 80))}<br>${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}
          <p class="small muted">元のファイルは変更しません。修正版を別のファイルとして書き出します。</p>`,
          out.applied.length ? [['save', '修正版を書き出す', 'primary'], ['back', '戻る', 'ghost']] : [['back', '戻る', 'ghost']]);
        if (go.value === 'save') download(file.name.replace(/\.json$/i, '') + '-corrected.json', out.data);
      } catch (error) { toastMsg(error.message, 5000); }
      await pause();
      continue;
    }
    if (r.value === 'import') {
      const file = await pickFile(); if (!file) continue;
      try {
        const json = await readJsonFile(file);
        const plan = await importCorrections(target, json);
        const go = await sheet('修正JSONの取り込み', `<p class="small">適用できる修正 ${plan.matched.length}件・適用できない修正 ${plan.skipped.length}件。手動修正として保存します（自動照合では上書きされません）。</p>
          <div class="jp-list">${plan.matched.map(m => `<div class="small"><b>${esc(clip(m.item.en, 70))}</b><br>${esc(m.item.ja) || '（訳を削除）'}<br><span class="muted">照合：${esc(m.how)}</span></div>`).join('')}</div>
          ${plan.skipped.length ? `<details><summary>適用できない修正</summary><ul class="small">${plan.skipped.map(s => `<li>${esc(clip(s.item.en, 80))}<br>${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}`,
          plan.matched.length ? [['apply', '取り込む', 'primary'], ['back', '戻る', 'ghost']] : [['back', '戻る', 'ghost']]);
        if (go.value === 'apply') { await plan.apply(); changed = true; toastMsg(`${plan.matched.length}件の修正を取り込みました`); }
      } catch (error) { toastMsg(error.message, 5000); }
      await pause();
      continue;
    }
    return changed;
  }
}

// ================= Video Lab: saved-change history =================
export async function openJaHistory(videoId) {
  let changed = false;
  for (;;) {
    const list = await readJaHistory(videoId);
    const when = t => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const r = await sheet('日本語訳の変更履歴', list.length ? `<p class="small">保存した訳の変更を元に戻せます（アプリを再起動した後も）。その後に同じ字幕の訳が変わった操作は戻せません。</p>
      <div class="jp-list">${list.map((h, i) => `<div class="card stack small"><b>${esc(h.label)}</b><span class="muted">${when(h.at)}・${h.items.length}行${h.undone ? '・元に戻し済み' : ''}</span>
        <details><summary>内容</summary>${h.items.slice(0, 30).map(it => `<div>前：${esc(it.before.map(e => e.ja).join(' / ')) || '（なし）'}<br>後：${esc(it.after.map(e => e.ja).join(' / ')) || '（なし）'}</div>`).join('')}${h.items.length > 30 ? '<div class="muted">…</div>' : ''}</details>
        <button class="btn sm" value="${h.undone ? 'redo' : 'undo'}:${i}">${h.undone ? 'やり直す' : '元に戻す'}</button></div>`).join('')}</div>` :
      '<p class="small">保存した変更はまだありません。</p>', [['close', '閉じる', 'ghost']]);
    const m = /^(undo|redo):(\d+)$/.exec(r.value);
    if (!m) return changed;
    await pause();
    try { await revertJaHistory(videoId, list[Number(m[2])].id, { redo: m[1] === 'redo' }); changed = true; toastMsg(m[1] === 'redo' ? 'やり直しました' : '元に戻しました'); }
    catch (error) { toastMsg(error.message, 5000); }
  }
}
