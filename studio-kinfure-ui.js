// 金フレ型: 全体スクリプトの登録と、範囲の確認・修正の画面（スタジオ単体・Englabo内スタジオ共通）。
import { $, $$, esc, toast, confirmDialog } from './ui.js';
import { sdb } from './studio-db.js';
import { parseScript } from './studio-subs.js';
import { saveKfScript, loadKfScript, cuesOfSet, applyKfRange, isScriptRow, locateRange, rangeFromNumbers } from './studio-kinfure.js';
import { coverageReport, nameHint, groupOfLine } from './studio-kinfure-range.js';

function dialog(title, body, buttons) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack st-action-dialog"><h3>${esc(title)}</h3>${body}<div class="st-dialog-actions">
    ${buttons.map(([value, label]) => `<button class="btn sm${value === 'ok' ? ' primary' : ''}" value="${value}">${esc(label)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue); dlg.showModal(); });
}
const LEVEL = { high: '確信度 高', mid: '確信度 中', low: '確信度 低（要確認）', none: '特定できません' };
const rowsOfCues = (cues) => cues.map((c) => ({ text: c.text, ja: c.ja, rep: c.rep, kind: c.kind }));

// ---------- 全体スクリプトの登録（フォルダに1つ。教材ごとには複製しない） ----------
export async function kfRegisterScript({ folderId, folderName, fromSet = null }) {
  const old = await loadKfScript(folderId);
  let rows = null, name = '';
  const info = old ? `登録済み：${esc(old.name || '全体スクリプト')}（${old.lines.length}行・${old.groups.length}件）。差し替えると、範囲は文の一致から再計算します。` : 'まだ登録されていません。';
  const body = `<p class="small">「${esc(folderName)}」に金フレ全体のスクリプトを<b>1回だけ</b>登録します。教材には、特定した範囲の行だけが入ります。端末内だけで処理します。</p>
    <p class="small muted">${info}</p>
    <label class="field"><span>ファイル（txt / csv / tsv / json）</span><input type="file" id="kfFile" accept=".txt,.csv,.tsv,.json,.lrc,.srt,.vtt,text/plain"></label>
    <label class="field"><span>または貼り付け（1行に1項目。「123. put off」のように番号があれば使います）</span><textarea id="kfText" rows="4" class="grow"></textarea></label>
    <p id="kfInfo" class="small"></p>`;
  const pending = dialog('金フレ全体スクリプトを登録', body, [['ok', '登録する'], ...(fromSet ? [['set', 'この教材のスクリプト行から作る']] : []), ['cancel', '閉じる']]);
  const show = (text, file = '') => {
    try {
      const cues = parseScript(text, file).cues;
      rows = rowsOfCues(cues); name = file || '貼り付け';
      const t = $('#kfInfo');
      if (t) t.textContent = `読み込み：${rows.length}行`;
    } catch (e) { rows = null; const t = $('#kfInfo'); if (t) t.textContent = '読み込めませんでした：' + e.message; }
  };
  $('#kfFile').onchange = async (e) => { const f = e.target.files?.[0]; if (f) show(await f.text(), f.name); };
  $('#kfText').oninput = (e) => show(e.target.value, '貼り付け.txt');
  const act = await pending;
  if (act === 'set' && fromSet) {
    const blocks = (await sdb.byIndex('blocks', 'setId', fromSet.id)).filter((b) => !b.deleted);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    rows = fromSet.order.map((id) => byId.get(id)).filter((b) => b && isScriptRow(b)).map((b) => ({ text: b.text, ja: b.ja, rep: b.rep, kind: b.kind }));
    name = fromSet.title;
  } else if (act !== 'ok') return null;
  if (!rows?.length) { toast('スクリプトの行がありません', 3500); return null; }
  if (old && !(await confirmDialog({ title: '全体スクリプトを差し替えますか', body: `<p class="small">いまの登録（${old.lines.length}行）を、${rows.length}行のものに置き換えます。教材に入っている行は消えません。</p>`, okLabel: '差し替える' }))) return null;
  await saveKfScript(folderId, name, rows);
  const script = await loadKfScript(folderId);
  toast(`登録しました（${script.lines.length}行・見出し語 ${script.groups.length}件${script.numbered ? '・番号あり' : '・番号なしのため連番'}）`, 4500);
  return script;
}

// ---------- 範囲の自動特定と確認 ----------
// members: フォルダ内の全教材（順序つき）。targets: 今回特定する教材（省略時は全部）。
export async function kfLocateFlow({ folderId, folderName, members, targets = members, onDone, registerFrom = null }) {
  let script = await loadKfScript(folderId);
  if (!script) {
    script = await kfRegisterScript({ folderId, folderName, fromSet: registerFrom });
    if (!script) return;
  }
  const t0 = performance.now();
  const rows = [];
  for (const set of members) {
    const isTarget = targets.includes(set);
    const fresh = (await sdb.get('sets', set.id)) || set;
    const saved = fresh.kfRange?.scriptAt === script.savedAt ? fresh.kfRange : null;
    if (!isTarget) { rows.push({ set: fresh, target: false, saved }); continue; }
    const cues = await cuesOfSet(fresh);
    const res = locateRange(script, cues, { hint: nameHint(fresh.title) });
    rows.push({ set: fresh, target: true, saved, cues: cues.length, res, cand: [res, ...res.alternatives].filter((c) => c.startN != null) });
  }
  const spent = performance.now() - t0;
  const state = rows.map((r) => {
    const base = r.saved || r.cand?.[0];
    return { ...r, a: base?.startN ?? '', b: base?.endN ?? '', apply: r.target && r.res?.ok && r.res.level !== 'low', pick: 0 };
  });
  const span = (r) => {
    if (r.target) { const g = rangeFromNumbers(script, +r.a, +r.b); return g && r.a !== '' && r.b !== '' ? g : null; }
    return r.saved ? { startLine: r.saved.startLine, endLine: r.saved.endLine, startN: r.saved.startN, endN: r.saved.endN } : null;
  };
  const label = (g) => g ? `No.${g.startN} ${esc(g.startLabel || '')} 〜 No.${g.endN} ${esc(g.endLabel || '')}（${g.groups}件・${g.lines}行）` : '範囲が決まっていません';
  const report = () => {
    const results = state.map((r) => ({ id: r.set.id, name: r.set.title }));
    const override = {}; state.forEach((r) => { const g = span(r); if (g) override[r.set.id] = g; });
    const none = results.filter((r) => !override[r.id]).map((r) => r.id);
    const rep = coverageReport(script, results.map((r) => (override[r.id] ? { ...r, startLine: 0 } : r)), override);
    const title = (id) => esc(state.find((r) => r.set.id === id)?.set.title || '');
    const lines = [];
    for (const o of rep.overlaps) lines.push(`重なり：「${title(o.a)}」と「${title(o.b)}」 No.${o.fromN}〜${o.toN}（${o.lines}行）。意図的な重複なら、そのままで構いません。`);
    for (const g of rep.gaps) lines.push(`どの音声にも入っていない番号：No.${g.fromN}〜${g.toN}（${g.lines}行）`);
    if (none.length) lines.push(`範囲が未定：${none.map(title).join('、')}`);
    return lines.length ? lines.map((x) => `<div>${x}</div>`).join('') : '重なり・欠落はありません。';
  };
  const rowHTML = (r, k) => {
    if (!r.target) return `<div class="small muted" style="padding:6px 0;border-bottom:1px solid #aaa4">${esc(r.set.title)}：${r.saved ? label(rangeFromNumbers(script, r.saved.startN, r.saved.endN)) + '（適用済み）' : '範囲は未適用'}</div>`;
    const res = r.res, level = res.level || 'none';
    return `<div class="stack" style="padding:8px 0;border-bottom:1px solid #aaa4" data-k="${k}">
      <label class="row"><input type="checkbox" data-ap="${k}" ${r.apply ? 'checked' : ''}> <b class="grow">${esc(r.set.title)}</b></label>
      <div class="small ${level === 'high' ? '' : 'warn-text'}" id="kfL${k}"></div>
      ${r.cues ? '' : '<div class="small warn-text">文字起こしがありません。先に「文字起こし」を実行するか、番号を手で入れてください。</div>'}
      ${r.cand?.length > 1 ? `<label class="field"><span>候補（${r.cand.length}件）</span><select data-pick="${k}">${r.cand.map((c, i) => `<option value="${i}">${i ? `候補${i + 1}` : '推定'}：No.${c.startN}〜${c.endN}（${c.lines}行）</option>`).join('')}<option value="m">手動</option></select></label>` : ''}
      <div class="row"><label class="field grow"><span>開始番号</span><input type="number" inputmode="numeric" data-a="${k}" value="${r.a}"></label>
        <label class="field grow"><span>終了番号</span><input type="number" inputmode="numeric" data-b="${k}" value="${r.b}"></label></div>
    </div>`;
  };
  const body = `<p class="small">「${esc(folderName)}」の全体スクリプト（${script.lines.length}行・${script.groups.length}件）から、各音声の範囲を文字起こしの並びで特定しました（${(spent / 1000).toFixed(1)}秒・端末内）。元の全体スクリプトは削除されません。</p>
    <div class="stack" style="max-height:48dvh;overflow:auto" id="kfRows">${state.map(rowHTML).join('')}</div>
    <div class="small" id="kfRep" style="padding-top:6px"></div>
    <p class="small muted">適用すると、範囲の外の「音声が付いていない・手を付けていない」スクリプト行だけを教材から外します（↶で戻せます）。音声割当済み・手動修正の行は残します。</p>`;
  const pending = dialog('金フレの範囲を確認', body, [['ok', '選択分に適用'], ['cancel', '閉じる']]);
  const refresh = (k) => {
    const r = state[k]; if (!r.target) return;
    const g = span(r), res = r.res;
    const conf = r.pick !== 'm' && r.cand?.[r.pick] === r.cand?.[0] && g && g.startN === r.cand[0].startN && g.endN === r.cand[0].endN ? `（${LEVEL[res.level]}・${res.matched ?? 0}行が一致）` : g ? '（手動）' : `（${LEVEL.none}${res.reason ? '：' + esc(res.reason) : ''}）`;
    const el = $(`#kfL${k}`); if (el) el.innerHTML = label(g) + ' ' + conf;
  };
  state.forEach((_, k) => refresh(k));
  const rep = () => { const e = $('#kfRep'); if (e) e.innerHTML = report(); };
  rep();
  const list = $('#kfRows');
  list.addEventListener('input', (e) => {
    const t = e.target, k = +(t.dataset.a ?? t.dataset.b ?? -1);
    if (k < 0) return;
    state[k][t.dataset.a != null ? 'a' : 'b'] = t.value === '' ? '' : +t.value;
    state[k].pick = 'm';
    const sel = list.querySelector(`[data-pick="${k}"]`); if (sel) sel.value = 'm';
    refresh(k); rep();
  });
  list.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ap != null) state[+t.dataset.ap].apply = t.checked;
    if (t.dataset.pick != null) {
      const k = +t.dataset.pick, r = state[k];
      if (t.value === 'm') { r.pick = 'm'; return; }
      const c = r.cand[+t.value]; r.pick = +t.value; r.a = c.startN; r.b = c.endN;
      list.querySelector(`[data-a="${k}"]`).value = r.a; list.querySelector(`[data-b="${k}"]`).value = r.b;
      refresh(k); rep();
    }
  });
  if (await pending !== 'ok') return;
  const chosen = state.filter((r) => r.target && r.apply && span(r));
  if (!chosen.length) return toast('適用する教材がありません', 3000);
  let removed = 0, added = 0, kept = 0;
  for (const [i, r] of chosen.entries()) {
    toast(`範囲を適用中 ${i + 1}/${chosen.length}：${r.set.title}`, 4000);
    const g = span(r), orig = r.cand?.[0];
    const manual = !(orig && g.startN === orig.startN && g.endN === orig.endN);
    const out = await applyKfRange(r.set, script, g, { manual, confidence: manual ? null : r.res.confidence });
    removed += out.removed; added += out.added; kept += out.keptOutside;
  }
  toast(`${chosen.length}教材に範囲を適用しました（外した行 ${removed}・追加 ${added}${kept ? `・音声割当済みなどで残した行 ${kept}` : ''}）`, 6000);
  onDone?.();
}
export { groupOfLine };
