// Word-order / chunk puzzle: tap tiles to build the sentence. Used by Games and Lessons.
import { $, $$, esc } from './ui.js';
import { icon } from './icons.js';
import { shuffle } from './study.js';

const norm = (s) => String(s).toLowerCase().replace(/[.,!?¿¡。，！？]/g, '').replace(/\s+/g, ' ').trim();
export const puzzleAnswerText = (pz, order) => order.map((i) => pz.tiles[i]).join(' ').replace(/\s+([,.!?])/g, '$1');

// onAnswer({ ok, answer, target, ms, wrongPositions })
export function renderPuzzle(host, pz, onAnswer) {
  const pool = shuffle([...pz.tiles.map((t, i) => ({ t, i })), ...(pz.extra || []).map((t, k) => ({ t, i: 1000 + k }))]);
  const tileText = (i) => (i >= 1000 ? pz.extra[i - 1000] : pz.tiles[i]);
  let order = [], history = [], done = false;
  const t0 = performance.now();
  host.innerHTML = `
    <div class="pz">
      <div class="pz-ja"><span class="small muted">日本語に合うように並べる</span><div>${esc(pz.ja)}</div>${pz.scene ? `<small class="muted">${esc(pz.scene)}</small>` : ''}</div>
      <div class="pz-answer" id="ans" aria-label="回答欄"></div>
      <div class="pz-pool" id="pool"></div>
      <div class="row"><button class="btn" id="pzUndo" aria-label="ひとつ戻す">${icon('undo', 18)}</button><button class="btn" id="pzReset">リセット</button><button class="btn primary grow" id="pzCheck" disabled>確認</button></div>
    </div>`;
  const draw = () => {
    $('#ans', host).innerHTML = order.length ? order.map((i, k) => `<button class="ptile in" data-k="${k}">${esc(tileText(i))}</button>`).join('') : '<span class="muted small">下のタイルをタップ</span>';
    $('#pool', host).innerHTML = pool.map((p) => `<button class="ptile ${order.includes(p.i) ? 'used' : ''}" data-i="${p.i}" ${order.includes(p.i) ? 'disabled' : ''}>${esc(p.t)}</button>`).join('');
    $('#pzCheck', host).disabled = !order.length || done;
    $('#pzUndo', host).disabled = !history.length || done;
  };
  draw();
  $('#pool', host).onclick = (e) => { const b = e.target.closest('.ptile'); if (!b || done) return; history.push([...order]); order.push(+b.dataset.i); draw(); };
  $('#ans', host).onclick = (e) => { const b = e.target.closest('.ptile'); if (!b || done) return; history.push([...order]); order.splice(+b.dataset.k, 1); draw(); };
  $('#pzUndo', host).onclick = () => { if (history.length) { order = history.pop(); draw(); } };
  $('#pzReset', host).onclick = () => { if (order.length) { history.push([...order]); order = []; draw(); } };
  $('#pzCheck', host).onclick = () => {
    if (done) return; done = true;
    const answer = order.map(tileText).join(' ');
    const targets = pz.answers.map((a) => a.map((i) => pz.tiles[i]).join(' '));
    const hit = targets.findIndex((t) => norm(t) === norm(answer));
    const target = targets[hit >= 0 ? hit : 0];
    const tgtOrder = pz.answers[hit >= 0 ? hit : 0];
    const wrongPositions = order.map((i, k) => (tgtOrder[k] === i ? -1 : k)).filter((k) => k >= 0);
    $$('#ans .ptile', host).forEach((b, k) => b.classList.add(hit >= 0 || !wrongPositions.includes(k) ? 'right' : 'wrong'));
    draw();
    $$('#ans .ptile', host).forEach((b, k) => b.classList.add(hit >= 0 || !wrongPositions.includes(k) ? 'right' : 'wrong'));
    onAnswer({ ok: hit >= 0, answer, target: target.replace(/\s+([,.!?])/g, '$1'), ms: Math.round(performance.now() - t0), wrongPositions });
  };
}
