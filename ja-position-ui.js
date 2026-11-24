// 1.19.30: Japanese subtitle position editor, the same screen for Video Lab and Studio.
// Works on text only (ja-position.js). The caller saves the result and plays audio through the callbacks.
import { jaModel, isLocked, moveText, swapRows, splitRow, mergeInto, editText, rangeMove, sharedImpact, dissolve,
  jaChanges, jaBalance, rowText } from './ja-position.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n = 60) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const PUNCT = /[。、．，！？!?…」』）)]/;

/**
 * open({ title, rows, groups, center, play(i, mode), stop(), range: {a, b, d} | null, note })
 * rows: [{ id, en, own, groups }]  groups: Map key -> { text, members }
 * resolves { changes, model, state } when saved, null when closed without saving.
 */
export function openJaPositionEditor({ title = '日本語字幕の位置調整', rows, groups = new Map(), center = 0, play = null, stop = null, range = null, note = '' }) {
  const dlg = document.getElementById('dialog');
  if (dlg.open) { dlg.onclose = null; dlg.close(); }
  const model = jaModel(rows, groups);
  const n = model.ids.length;
  let state = model.initial;
  const past = [], future = [];
  let active = Math.max(0, Math.min(n - 1, center));
  let lo = Math.max(0, active - 3), hi = Math.min(n - 1, active + 3);
  const sel = new Map();               // row -> { start, end } remembered while buttons are tapped
  let panel = range ? 'range' : null;  // null | 'split' | 'range' | 'unshare:<key>' | 'compare' | 'discard'
  let rangeForm = range ? { a: range.a, b: range.b, d: range.d } : { a: active, b: Math.min(n - 1, active + 1), d: 1 };
  let splitPos = null, typing = null, message = '';
  let finish;
  const listeners = new AbortController(), on = { signal: listeners.signal };
  const done = new Promise(resolve => { finish = resolve; });

  const push = next => { past.push(state); if (past.length > 200) past.shift(); future.length = 0; state = next; sel.clear(); };
  const commitTyping = () => {
    if (!typing) return;
    const field = dlg.querySelector(`textarea[data-ja="${typing.i}"]`);
    const text = field ? field.value : state.own[typing.i];
    if (text !== typing.before.own[typing.i]) { past.push(typing.before); future.length = 0; }
    typing = null;
  };
  const apply = result => {
    commitTyping();
    if (result.error) { message = result.error; draw(); return false; }
    push(result.state); message = ''; draw(); return true;
  };
  const changes = () => jaChanges(model, state);
  const rowLabel = i => `#${i + 1}`;
  const membersLabel = key => {
    const m = model.groups.get(key).members;
    return m.length ? `${rowLabel(m[0])}〜${rowLabel(m.at(-1))} の${m.length}行` : '';
  };

  function rowHTML(i) {
    const locked = isLocked(model, state, i), own = state.own[i] || '';
    const changed = own.trim() !== model.initial.own[i].trim() || model.rowGroups[i].some(k => state.dissolved.has(k));
    const shared = model.rowGroups[i].filter(k => !state.dissolved.has(k)).map(k => `<div class="jp-shared small">
        <span>共有訳（${membersLabel(k)}）</span><span class="jp-shared-text">${esc(model.groups.get(k).text)}</span>
        <button type="button" class="btn xs" data-unshare="${esc(k)}">共有を解除…</button></div>`).join('');
    return `<div class="jp-row${i === active ? ' on' : ''}${changed ? ' changed' : ''}${locked ? ' locked' : ''}" data-row="${i}">
      <div class="jp-en"><button type="button" class="jp-pick" data-pick="${i}" aria-label="${rowLabel(i)}を対象にする">${rowLabel(i)}</button>
        <span class="grow" lang="en">${esc(model.en[i])}</span>${play ? `<button type="button" class="btn xs" data-play="${i}" aria-label="${rowLabel(i)}を再生">▶</button>` : ''}</div>
      ${shared}
      <textarea data-ja="${i}" rows="${Math.min(5, Math.max(2, Math.ceil(own.length / 22)))}" ${locked ? 'readonly' : ''} aria-label="${rowLabel(i)}の日本語訳" placeholder="${locked ? '' : '（訳なし）'}">${esc(own)}</textarea>
      ${changed ? `<div class="jp-was small muted">変更前：${esc(clip(rowText(model, model.initial, i), 80)) || '（なし）'}</div>` : ''}
    </div>`;
  }
  function selectionText() {
    const s = sel.get(active), text = state.own[active] || '';
    return s && s.end > s.start ? text.slice(s.start, s.end) : '';
  }
  function toolsHTML() {
    const i = active, locked = isLocked(model, state, i), has = Boolean(state.own[i]?.trim());
    const prev = i > 0, next = i < n - 1, part = selectionText();
    const dis = c => c ? '' : 'disabled';
    return `<div class="jp-target small"><b>${rowLabel(i)}</b>　${part ? `選択：「${esc(clip(part, 30))}」を移動` : '選択なし＝全文を移動'}${locked ? '　<span class="warn-text">共有訳の行です</span>' : ''}</div>
      <div class="jp-grid jp-grid4">
        <button type="button" class="btn sm" data-op="move:-1" ${dis(prev && has && !locked)} aria-label="前の行へ移動" title="前の行へ移動">↑ 前へ</button>
        <button type="button" class="btn sm" data-op="move:1" ${dis(next && has && !locked)} aria-label="次の行へ移動" title="次の行へ移動">↓ 次へ</button>
        <button type="button" class="btn sm" data-op="swap:-1" ${dis(prev && !locked)} aria-label="前の行と交換" title="前の行と交換">↑ 交換</button>
        <button type="button" class="btn sm" data-op="swap:1" ${dis(next && !locked)} aria-label="次の行と交換" title="次の行と交換">↓ 交換</button>
        <button type="button" class="btn sm" data-op="merge:-1" ${dis(prev && !locked)} aria-label="前の行の訳をこの行へ結合" title="前の行の訳をこの行へ結合">↑ 結合</button>
        <button type="button" class="btn sm" data-op="merge:1" ${dis(next && !locked)} aria-label="次の行の訳をこの行へ結合" title="次の行の訳をこの行へ結合">↓ 結合</button>
        <button type="button" class="btn sm" data-panel="split" ${dis(has && !locked && (state.own[i] || '').length > 1)} aria-label="分割位置を指定">分割…</button>
        <button type="button" class="btn sm" data-panel="range" aria-label="複数行をまとめて移動">範囲…</button>
        ${play ? `<button type="button" class="btn sm ghost" data-play-context="${i}" aria-label="前後の行を続けて試聴">▶ 前後</button>` : ''}
        <button type="button" class="btn sm ghost" data-op="undo" ${dis(past.length || typing)} aria-label="元に戻す">↶ 戻す</button>
        <button type="button" class="btn sm ghost" data-op="redo" ${dis(future.length)} aria-label="やり直す">↷</button>
        <button type="button" class="btn sm ghost" data-panel="compare" aria-label="変更前後を比較">比較 ${changes().length}</button>
      </div>`;
  }
  function splitHTML() {
    const text = state.own[active] || '';
    if (text.length < 2) return '<p class="small">分割できる訳がありません</p>';
    if (splitPos == null || splitPos <= 0 || splitPos >= text.length) {
      const s = sel.get(active);
      const caret = s && s.start > 0 && s.start < text.length ? s.start : null;
      const mid = Math.floor(text.length / 2);
      let best = null;
      for (let k = 1; k < text.length; k++) if (PUNCT.test(text[k - 1]) && (best == null || Math.abs(k - mid) < Math.abs(best - mid))) best = k;
      splitPos = caret ?? best ?? mid;
    }
    return `<div class="jp-panel stack"><b class="small">分割位置（${rowLabel(active)}）</b>
      <div class="jp-split"><span>${esc(text.slice(0, splitPos))}</span><i aria-hidden="true">｜</i><span>${esc(text.slice(splitPos))}</span></div>
      <input type="range" min="1" max="${text.length - 1}" value="${splitPos}" data-split-range aria-label="分割位置">
      <div class="jp-grid"><button type="button" class="btn xs" data-split-step="-1">◀ 1文字</button><button type="button" class="btn xs" data-split-step="1">1文字 ▶</button>
        <button type="button" class="btn xs" data-split-punct="-1">◀ 句読点</button><button type="button" class="btn xs" data-split-punct="1">句読点 ▶</button></div>
      <div class="jp-grid"><button type="button" class="btn sm" data-split="-1" ${active > 0 ? '' : 'disabled'}>前半を前の行へ</button><button type="button" class="btn sm" data-split="1" ${active < n - 1 ? '' : 'disabled'}>後半を次の行へ</button></div>
      <button type="button" class="btn sm ghost" data-panel="">閉じる</button></div>`;
  }
  function rangeLiveHTML() {
    const f = rangeForm, a = Math.min(f.a, f.b), b = Math.max(f.a, f.b);
    const preview = rangeMove(model, state, a, b, f.d);
    const where = `${rowLabel(a)}〜${rowLabel(b)}（${b - a + 1}行）`;
    let status = '';
    if (preview.error) status = `<p class="small warn-text">${esc(preview.error)}</p>`;
    else if (preview.needsChoice) status = `<p class="small">${preview.collisions.length ? `移動先に既存の訳があります：${preview.collisions.map(rowLabel).join('・')}。` : ''}${preview.overflow.length ? `${preview.overflow.length}行分は${f.d > 0 ? '最後' : '最初'}の行を超えるため、${f.d > 0 ? '最後' : '最初'}の行に結合されます。` : ''}どうしますか？（訳は削除されません）</p>`;
    else status = `<p class="small muted">${where}の訳 ${preview.moving}件を${Math.abs(f.d)}行${f.d > 0 ? '下' : '上'}へ移動します。</p>`;
    const actions = preview.error ? '<button type="button" class="btn sm ghost" data-panel="">閉じる</button>' : preview.needsChoice ?
      `<button type="button" class="btn sm" data-range-go="merge">結合して移動</button>${preview.overflow.length ? '' : '<button type="button" class="btn sm" data-range-go="swap">交換して移動</button>'}<button type="button" class="btn sm ghost" data-panel="">キャンセル</button>` :
      `<button type="button" class="btn sm primary" data-range-go="plain">移動する</button><button type="button" class="btn sm ghost" data-panel="">キャンセル</button>`;
    return `<div class="small muted">${esc(clip(model.en[a], 40))} 〜 ${esc(clip(model.en[b], 40))}</div>
      <div class="jp-range"><span class="small">移動</span><button type="button" class="btn xs" data-range-d="-1">↑ 上へ</button><b class="small">${Math.abs(f.d)}行${f.d > 0 ? '下' : '上'}</b><button type="button" class="btn xs" data-range-d="1">↓ 下へ</button></div>
      ${status}<div class="jp-grid">${actions}</div>`;
  }
  function rangeHTML() {
    const f = rangeForm;
    return `<div class="jp-panel stack"><b class="small">複数行の訳をまとめて移動</b>
      <div class="jp-range">
        <label class="small">開始行 <input type="number" inputmode="numeric" min="1" max="${n}" value="${f.a + 1}" data-range-a></label>
        <button type="button" class="btn xs" data-range-set="a">対象行</button>
        <label class="small">終了行 <input type="number" inputmode="numeric" min="1" max="${n}" value="${f.b + 1}" data-range-b></label>
        <button type="button" class="btn xs" data-range-set="b">対象行</button><button type="button" class="btn xs" data-range-set="end">末尾（${rowLabel(n - 1)}）</button>
      </div>
      <div class="jp-range-live stack">${rangeLiveHTML()}</div></div>`;
  }
  function unshareHTML(key) {
    const impact = sharedImpact(model, key);
    if (!impact) return '';
    return `<div class="jp-panel stack"><b class="small">共有を解除</b>
      <p class="small">「${esc(clip(impact.text, 80))}」は次の${impact.members.length}行で共有されています。</p>
      <ul class="small jp-impact">${impact.members.map(i => `<li>${rowLabel(i)} ${esc(clip(model.en[i], 50))}${i === impact.recipient ? '　<b>→ この行の訳になります</b>' : '　→ 空欄（必要なら分割・移動で割り当て）'}</li>`).join('')}</ul>
      ${impact.complete ? '' : '<p class="small warn-text">この訳はここに表示されていない字幕にも使われているため、解除できません。</p>'}
      <p class="small muted">影響はこの${impact.members.length}行だけです。ほかの字幕は変わりません。保存するまで確定しません。</p>
      <div class="jp-grid">${impact.complete ? `<button type="button" class="btn sm" data-unshare-go="${esc(key)}">共有を解除する</button>` : ''}<button type="button" class="btn sm ghost" data-panel="">やめる</button></div></div>`;
  }
  function compareHTML(saving) {
    const list = changes(), bal = jaBalance(model, state);
    return `<div class="jp-panel stack"><b class="small">変更前後の比較（${list.length}行）</b>
      ${bal.lost ? `<p class="small warn-text">直接編集で${bal.lost}文字減っています。削除してよいか確認してください。</p>` : ''}
      <div class="jp-compare">${list.length ? list.map(c => `<div class="small"><b>${rowLabel(c.index)}</b> ${esc(clip(c.en, 60))}<br>
        <span class="muted">前：${esc(rowText(model, model.initial, c.index)) || '（なし）'}</span><br><span>後：${esc(rowText(model, state, c.index)) || '（なし）'}</span></div>`).join('') : '<p class="small muted">変更はありません</p>'}</div>
      <div class="jp-grid">${saving && list.length ? '<button type="button" class="btn sm primary" data-save-go>この内容で保存</button>' : ''}<button type="button" class="btn sm ghost" data-panel="">編集に戻る</button></div></div>`;
  }
  function panelHTML() {
    if (panel === 'split') return splitHTML();
    if (panel === 'range') return rangeHTML();
    if (panel === 'compare' || panel === 'save') return compareHTML(panel === 'save');
    if (panel?.startsWith('unshare:')) return unshareHTML(panel.slice(8));
    if (panel === 'discard') return `<div class="jp-panel stack"><p class="small">保存していない変更（${changes().length}行）があります。</p>
      <div class="jp-grid"><button type="button" class="btn sm danger" data-discard>破棄して閉じる</button><button type="button" class="btn sm ghost" data-panel="">編集に戻る</button></div></div>`;
    return '';
  }

  let drawing = false;
  function draw() {
    if (drawing) return;
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
  }
  function drawNow() {
    const form = dlg.querySelector('.jp-form');
    const keep = form ? form.scrollTop : 0, keepD = dlg.scrollTop;
    // (the hidden marker stops ui.js from adding its generic close button, which would skip the unsaved-changes check)
    dlg.innerHTML = `<form class="dlg jp-form" novalidate><span class="dlg-global-close" hidden></span>
      <div class="jp-head"><h3>${esc(title)}</h3><span class="grow"></span><button type="button" class="btn sm ghost" data-close>閉じる</button><button type="button" class="btn sm primary" data-save ${changes().length ? '' : 'disabled'}>保存…</button></div>
      <p class="small muted">英文・音声・再生時刻は変わりません。行番号をタップして対象を選び、訳の一部を選択してから移動すると部分移動になります。${esc(note)}</p>
      ${lo > 0 ? `<button type="button" class="btn sm ghost jp-more" data-more="-1">▲ 前の行を表示（あと${lo}行）</button>` : ''}
      <div class="jp-rows">${Array.from({ length: hi - lo + 1 }, (_, k) => rowHTML(lo + k)).join('')}</div>
      ${hi < n - 1 ? `<button type="button" class="btn sm ghost jp-more" data-more="1">▼ 次の行を表示（あと${n - 1 - hi}行）</button>` : ''}
      <div class="jp-tools">${message ? `<p class="small warn-text" role="status">${esc(message)}</p>` : ''}${panelHTML() || toolsHTML()}</div>
    </form>`;
    const f = dlg.querySelector('.jp-form');
    f.scrollTop = keep; dlg.scrollTop = keepD;
  }
  const ensureVisible = list => { for (const i of list) { lo = Math.min(lo, i); hi = Math.max(hi, i); } };
  const setActive = i => { if (i === active) return; commitTyping(); active = i; splitPos = null; ensureVisible([i]); };

  function close(result) {
    stop?.();
    dlg.onclose = null; dlg.oncancel = null;
    listeners.abort();   // the dialog element is shared with every other dialog of the app
    if (dlg.open) dlg.close();
    finish(result);
  }
  function onSelection() {
    const field = document.activeElement;
    if (!field?.matches?.('textarea[data-ja]') || !dlg.contains(field)) return;
    const i = Number(field.dataset.ja);
    sel.set(i, { start: field.selectionStart, end: field.selectionEnd });
    if (i !== active) { commitTyping(); active = i; }
    const target = dlg.querySelector('.jp-target');
    if (target && !panel) {   // update the selection label without redrawing (the redraw would drop the selection)
      dlg.querySelectorAll('.jp-row.on').forEach(row => row.classList.toggle('on', Number(row.dataset.row) === active));
      dlg.querySelector(`.jp-row[data-row="${active}"]`)?.classList.add('on');
      const part = selectionText();
      target.innerHTML = `<b>${rowLabel(active)}</b>　${part ? `選択：「${esc(clip(part, 30))}」を移動` : '選択なし＝全文を移動'}`;
    }
  }
  document.addEventListener('selectionchange', onSelection, on);

  // Buttons must not take the focus (and with it the text selection) away from the translation being edited.
  dlg.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); }, on);
  dlg.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }, on);
  dlg.addEventListener('focusin', e => {
    const field = e.target.closest?.('textarea[data-ja]');
    if (!field || field.readOnly) return;
    const i = Number(field.dataset.ja);
    if (!typing || typing.i !== i) { commitTyping(); typing = { i, before: state }; }
  }, on);
  dlg.addEventListener('input', e => {
    const field = e.target.closest?.('textarea[data-ja]');
    if (field) {
      const i = Number(field.dataset.ja), r = editText(model, state, i, field.value);
      if (!r.error) state = r.state;
      sel.set(i, { start: field.selectionStart, end: field.selectionEnd });
      const save = dlg.querySelector('[data-save]'); if (save) save.disabled = !changes().length;
      return;
    }
    if (e.target.matches('[data-range-a],[data-range-b]')) {
      const raw = Math.trunc(Number(e.target.value));
      if (!raw) return;
      const v = Math.max(1, Math.min(n, raw)) - 1;
      if (e.target.matches('[data-range-a]')) rangeForm.a = v; else rangeForm.b = v;
      const live = dlg.querySelector('.jp-range-live'); if (live) live.innerHTML = rangeLiveHTML();
      return;
    }
    if (e.target.matches('[data-split-range]')) { splitPos = Number(e.target.value); const box = dlg.querySelector('.jp-split');
      const text = state.own[active] || ''; if (box) box.innerHTML = `<span>${esc(text.slice(0, splitPos))}</span><i aria-hidden="true">｜</i><span>${esc(text.slice(splitPos))}</span>`; }
  }, on);
  dlg.addEventListener('change', e => {
    // No redraw here: on iPhone the blur comes just before the tap on a button, and a redraw would swallow that tap.
    if (e.target.matches('textarea[data-ja]')) { commitTyping(); return; }
  }, on);
  dlg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !dlg.contains(b)) return;
    e.preventDefault();
    const d = b.dataset;
    if (d.close != null) { commitTyping(); if (changes().length) { panel = 'discard'; draw(); } else close(null); return; }
    if (d.discard != null) return close(null);
    if (d.save != null) { commitTyping(); panel = 'save'; message = ''; draw(); return; }
    if (d.saveGo != null) return close({ changes: changes(), model, state });
    if (d.more) { const k = Number(d.more); if (k < 0) lo = Math.max(0, lo - 5); else hi = Math.min(n - 1, hi + 5); draw(); return; }
    if (d.pick) { setActive(Number(d.pick)); draw(); return; }
    if (d.play) { play?.(Number(d.play), 'row'); return; }
    if (d.playContext) { play?.(Number(d.playContext), 'context'); return; }
    if (d.panel != null) {
      commitTyping(); message = '';
      panel = d.panel || null; splitPos = null;
      if (panel === 'range') rangeForm = { a: active, b: Math.max(active, Math.min(n - 1, rangeForm.b)), d: rangeForm.d || 1 };
      draw(); return;
    }
    if (d.unshare) {
      commitTyping(); message = '';
      const impact = sharedImpact(model, d.unshare);
      if (impact?.complete) ensureVisible(impact.members);
      panel = 'unshare:' + d.unshare; draw(); return;
    }
    if (d.unshareGo) { if (apply(dissolve(model, state, d.unshareGo))) { active = sharedImpact(model, d.unshareGo).recipient; panel = null; draw(); } return; }
    if (d.splitStep) { const text = state.own[active] || ''; splitPos = Math.max(1, Math.min(text.length - 1, splitPos + Number(d.splitStep))); draw(); return; }
    if (d.splitPunct) {
      const text = state.own[active] || '', dir = Number(d.splitPunct);
      for (let k = splitPos + dir; k > 0 && k < text.length; k += dir) if (PUNCT.test(text[k - 1])) { splitPos = k; break; }
      draw(); return;
    }
    if (d.split) { const dir = Number(d.split); if (apply(splitRow(model, state, active, splitPos, dir))) { panel = null; splitPos = null; draw(); } return; }
    if (d.rangeSet) { if (d.rangeSet === 'end') rangeForm.b = n - 1; else rangeForm[d.rangeSet] = active; draw(); return; }
    if (d.rangeD) {
      const k = rangeForm.d + Number(d.rangeD); rangeForm.d = k === 0 ? Number(d.rangeD) : Math.max(-(n - 1), Math.min(n - 1, k));
      const live = dlg.querySelector('.jp-range-live'); if (live) live.innerHTML = rangeLiveHTML(); else draw();
      return;
    }
    if (d.rangeGo) {
      const a = Math.min(rangeForm.a, rangeForm.b), z = Math.max(rangeForm.a, rangeForm.b);
      const result = rangeMove(model, state, a, z, rangeForm.d, d.rangeGo === 'plain' ? null : d.rangeGo);
      if (!result.state) { message = result.error || '移動方法を選んでください'; draw(); return; }
      if (apply(result)) { ensureVisible([a, z, Math.max(0, Math.min(n - 1, a + rangeForm.d)), Math.max(0, Math.min(n - 1, z + rangeForm.d))]); panel = 'compare'; draw(); }
      return;
    }
    if (d.op) {
      const [op, arg] = d.op.split(':'), k = Number(arg);
      if (op === 'undo') { commitTyping(); if (past.length) { future.push(state); state = past.pop(); sel.clear(); } message = ''; draw(); return; }
      if (op === 'redo') { if (future.length) { past.push(state); state = future.pop(); sel.clear(); } message = ''; draw(); return; }
      const s = sel.get(active) || { start: 0, end: 0 };
      const result = op === 'move' ? moveText(model, state, active, k, s.start, s.end)
        : op === 'swap' ? swapRows(model, state, active, k) : mergeInto(model, state, active, k);
      if (apply(result)) { ensureVisible([active + k]); draw(); }
    }
  }, on);
  dlg.oncancel = e => { e.preventDefault(); commitTyping(); if (changes().length) { panel = 'discard'; draw(); } else close(null); };
  dlg.onclose = () => close(null);
  draw();
  dlg.showModal();
  // Show the target row without moving the page behind the dialog.
  requestAnimationFrame(() => dlg.querySelector(`.jp-row[data-row="${active}"]`)?.scrollIntoView?.({ block: 'center' }));
  return done;
}
