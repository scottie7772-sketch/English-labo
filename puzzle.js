// Word-order / chunk puzzle: tap tiles to build the sentence. Used by Games and Lessons.
import { $, $$, esc } from './ui.js';
import { icon } from './icons.js';
import { shuffle } from './study.js';

const norm = (s) => { const t = String(s).toLowerCase().replace(/[.,!?¿¡。，！？、]/g, '').replace(/\s+/g, ' ').trim(); return /[\u3400-\u9fff]/.test(t) ? t.replace(/\s/g, '') : t; };
const joinTiles = (arr) => (arr.some((x) => /[\u3400-\u9fff]/.test(x)) ? arr.join('') : arr.join(' ').replace(/\s+([,.!?])/g, '$1'));
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
      <p class="hint center" id="pzHint"></p>
      <div class="row"><button class="btn" id="pzUndo" aria-label="ひとつ戻す">${icon('undo', 18)}</button><button class="btn" id="pzReset">リセット</button><button class="btn primary grow" id="pzCheck" disabled>確認</button></div>
    </div>`;
  let picked = -1;   // index in `order` of the selected placed tile
  const draw = () => {
    $('#ans', host).innerHTML = order.length ? order.map((i, k) => `<button class="ptile in ${k === picked ? 'picked' : ''}" data-k="${k}">${esc(tileText(i))}</button>`).join('') : '<span class="muted small">下のタイルをタップ</span>';
    $('#pool', host).innerHTML = pool.map((p) => `<button class="ptile ${order.includes(p.i) ? 'used' : ''}" data-i="${p.i}" ${order.includes(p.i) ? 'disabled' : ''}>${esc(p.t)}</button>`).join('');
    $('#pzCheck', host).disabled = !order.length || done;
    $('#pzUndo', host).disabled = !history.length || done;
    $('#pzHint', host).textContent = picked >= 0 ? '入れ替えたいタイルをタップ（同じタイルをもう一度で下に戻す／下のタイルをタップでこの前に入れる）' : order.length > 1 ? '並べたタイルはタップで選んで入れ替え、ドラッグで移動できます' : '';
  };
  draw();
  const commit = (next) => { history.push([...order]); order = next; picked = -1; draw(); };
  $('#pool', host).onclick = (e) => {
    const b = e.target.closest('.ptile'); if (!b || done || b.disabled) return;
    const n = [...order];
    if (picked >= 0) n.splice(picked, 0, +b.dataset.i); else n.push(+b.dataset.i);
    commit(n);
  };
  // tap on a placed tile: select / swap / return to pool
  const tapPlaced = (k) => {
    if (done) return;
    if (picked < 0) { picked = k; draw(); return; }
    if (picked === k) { const n = [...order]; n.splice(k, 1); commit(n); return; }
    const n = [...order]; [n[picked], n[k]] = [n[k], n[picked]]; commit(n);
  };
  // drag a placed tile to a new position (touch on iPhone, pointer for mouse)
  const ans = $('#ans', host);
  let drag = null;
  const pt = (e) => e.touches?.[0] || e.changedTouches?.[0] || e;
  const insertIndex = (x, y) => {
    const tiles = $$('.ptile.in', ans).filter((t) => +t.dataset.k !== drag.k);
    for (const t of tiles) { const r = t.getBoundingClientRect(); if (y < r.top) return +t.dataset.k; if (y <= r.bottom && x < r.left + r.width / 2) return +t.dataset.k; }
    return order.length;
  };
  const start = (e) => {
    const t = e.target.closest('.ptile.in'); if (!t || done) return;
    const p = pt(e); drag = { k: +t.dataset.k, el: t, x0: p.clientX, y0: p.clientY, moving: false, ghost: null, to: null };
  };
  const move = (e) => {
    if (!drag) return;
    const p = pt(e);
    if (!drag.moving) {
      if (Math.hypot(p.clientX - drag.x0, p.clientY - drag.y0) < 8) return;
      drag.moving = true; picked = -1;
      const r = drag.el.getBoundingClientRect();
      drag.ghost = drag.el.cloneNode(true); drag.ghost.classList.add('ghost');
      Object.assign(drag.ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
      drag.dx = p.clientX - r.left; drag.dy = p.clientY - r.top;
      document.body.appendChild(drag.ghost); drag.el.classList.add('dragging');
    }
    e.preventDefault();
    drag.ghost.style.left = p.clientX - drag.dx + 'px'; drag.ghost.style.top = p.clientY - drag.dy + 'px';
    drag.to = insertIndex(p.clientX, p.clientY);
    $$('.ptile.in', ans).forEach((t) => t.classList.toggle('insbefore', +t.dataset.k === drag.to));
    ans.classList.toggle('insend', drag.to === order.length);
  };
  const end = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moving) { tapPlaced(d.k); return; }
    e.preventDefault();
    d.ghost.remove(); ans.classList.remove('insend');
    if (d.to == null) { draw(); return; }
    const n = [...order]; const [x] = n.splice(d.k, 1); n.splice(d.to > d.k ? d.to - 1 : d.to, 0, x);
    commit(n);
  };
  ans.addEventListener('touchstart', start, { passive: true });
  ans.addEventListener('touchmove', move, { passive: false });
  ans.addEventListener('touchend', end, { passive: false });
  ans.addEventListener('touchcancel', () => { if (drag?.ghost) drag.ghost.remove(); drag = null; draw(); });
  ans.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') start(e); });
  addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch' && drag) move(e); });
  addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch' && drag) end(e); });
  $('#pzUndo', host).onclick = () => { if (history.length) { order = history.pop(); picked = -1; draw(); } };
  $('#pzReset', host).onclick = () => { if (order.length) commit([]); };
  $('#pzCheck', host).onclick = () => {
    if (done) return; done = true;
    const answer = joinTiles(order.map(tileText));
    const targets = pz.answers.map((a) => joinTiles(a.map((i) => pz.tiles[i])));
    const hit = targets.findIndex((t) => norm(t) === norm(answer));
    const target = targets[hit >= 0 ? hit : 0];
    const tgtOrder = pz.answers[hit >= 0 ? hit : 0];
    const wrongPositions = order.map((i, k) => (tgtOrder[k] === i ? -1 : k)).filter((k) => k >= 0);
    $$('#ans .ptile', host).forEach((b, k) => b.classList.add(hit >= 0 || !wrongPositions.includes(k) ? 'right' : 'wrong'));
    draw();
    $$('#ans .ptile', host).forEach((b, k) => b.classList.add(hit >= 0 || !wrongPositions.includes(k) ? 'right' : 'wrong'));
    onAnswer({ ok: hit >= 0, answer, target, ms: Math.round(performance.now() - t0), wrongPositions });
  };
}
