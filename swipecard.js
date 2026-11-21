// Shared 3-direction swipe card (left / up / right) with tap-to-flip.
// iPhone Safari + home-screen PWA: Touch Events (preventDefault) + touch-action:none; Pointer Events for mouse.
//
// Directions: → right = わかる / ← left = わからない（knowRight=false で左右入れ替え）/ ↑ up = 曖昧. ↓ down does nothing.
// makeSwipeCard(card, { knowRight, onTap, onCommit, canInteract })
//   onCommit(result) is called exactly once per card: 'know' | 'vague' | 'dont'
//   returns { commit(result) }  (for buttons)

const TAP_MOVE = 10;        // px: below this it's a tap
const TAP_MS = 450;
const DIST_X = 80;          // px needed to commit left/right
const DIST_UP = 70;         // px needed to commit up / down
const FLICK_V = 0.55;       // px/ms: a fast flick commits with a shorter distance
const FLICK_MIN = 35;

// Which direction gives which result. setting 'swipeKnow': 'right' | 'left' (older) | 'up' (1.12, one-handed: ↑わかる ↓わからない →後回し)
export function swipeMap(setting) {
  if (setting === 'up') return { up: 'know', down: 'dont', right: 'skip' };
  return setting === 'left' ? { left: 'know', right: 'dont', up: 'vague' } : { right: 'know', left: 'dont', up: 'vague' };
}
export const isOneHand = (map) => map.up === 'know';
const ARROW = { up: '↑', down: '↓', left: '←', right: '→' };
export const RESULT_JA = { know: 'わかる', dont: 'わからない', vague: '曖昧', skip: '後回し' };
export const arrowOf = (map, result) => ARROW[Object.keys(map).find((d) => map[d] === result)] || '';
// the hint line under the card
export const swipeHint = (map) => `タップで答え ・ ${['up', 'down', 'left', 'right'].filter((d) => map[d]).map((d) => ARROW[d] + RESULT_JA[map[d]]).join(' ・ ')}`;

export function makeSwipeCard(card, { knowRight = true, map = null, pads = [], onTap, onCommit, canInteract = () => true, revealOnCommit = null }) {
  let id = null, x0 = 0, y0 = 0, t0 = 0, dx = 0, dy = 0, axis = null, done = false;
  let lastX = 0, lastY = 0, lastT = 0, vx = 0, vy = 0;
  map = map || swipeMap(knowRight ? 'right' : 'left');
  const resultFor = (dir) => map[dir] || null;
  const dirFor = (result) => Object.keys(map).find((d) => map[d] === result) || 'up';

  function setStamp(dir, strength) {
    card.dataset.dir = dir || '';
    card.dataset.res = (dir && resultFor(dir)) || '';
    card.style.setProperty('--s', String(Math.min(1, strength)));
  }
  function reset() {
    card.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1.2)';
    card.style.transform = '';
    setStamp(null, 0);
  }
  function commit(result) {
    if (done) return;
    done = true;
    card.classList.add('gone');
    // like paper flashcards: the card shows its answer while it flies away
    if (revealOnCommit && result !== 'skip') { const f = card.querySelector('.face'); if (f) f.innerHTML = revealOnCommit(); card.classList.add('revealed'); }
    const dir = dirFor(result);
    card.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
    const tx = dir === 'right' ? window.innerWidth : dir === 'left' ? -window.innerWidth : dx;
    const ty = dir === 'up' ? -window.innerHeight * 0.9 : dir === 'down' ? window.innerHeight * 0.9 : dy;
    const vert = dir === 'up' || dir === 'down';
    card.style.transform = `translate(${vert ? dx * 0.3 : tx}px, ${ty}px) rotate(${vert ? 0 : (tx > 0 ? 18 : -18)}deg)`;
    card.style.opacity = '0';
    setStamp(dir, 1);
    onCommit(result);                       // caller shows the next card right away (underneath)
    setTimeout(() => card.remove(), 220);
  }

  function start(x, y, t) {
    if (done || id !== null || !canInteract()) return false;
    id = 1; x0 = lastX = x; y0 = lastY = y; t0 = lastT = t;
    dx = dy = vx = vy = 0; axis = null;
    card.style.transition = 'none';
    return true;
  }
  function move(x, y, t) {
    if (id === null || done) return;
    dx = x - x0; dy = y - y0;
    const dt = t - lastT;
    if (dt > 0) { vx = (x - lastX) / dt; vy = (y - lastY) / dt; }
    lastX = x; lastY = y; lastT = t;
    // lock the axis once the finger has clearly moved (prevents diagonal mis-detection)
    if (!axis && Math.hypot(dx, dy) > TAP_MOVE) axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : dy < 0 ? 'up' : 'down';
    if (axis === 'x') {
      card.style.transform = `translate(${dx}px, ${dy * 0.15}px) rotate(${dx / 16}deg)`;
      setStamp(dx > 0 ? 'right' : 'left', Math.abs(dx) / DIST_X);
    } else if (axis === 'up') {
      card.style.transform = `translate(${dx * 0.15}px, ${Math.min(0, dy)}px)`;
      setStamp('up', -Math.min(0, dy) / DIST_UP);
    } else if (axis === 'down' && map.down) {
      card.style.transform = `translate(${dx * 0.15}px, ${Math.max(0, dy)}px)`;
      setStamp('down', Math.max(0, dy) / DIST_UP);
    } else if (axis === 'down') {
      card.style.transform = `translateY(${Math.max(0, dy) * 0.25}px)`;   // downward does nothing
      setStamp(null, 0);
    }
  }
  function end(t, cancelled, tapAt = null) {
    if (id === null) return;
    id = null;
    if (done) return;
    if (cancelled) { reset(); return; }
    const dur = t - t0;
    if (!axis && dur < TAP_MS && Math.hypot(dx, dy) < TAP_MOVE) { reset(); if (!(tapAt && tapAt())) onTap?.(); return; }
    if (axis === 'x' && resultFor(dx > 0 ? 'right' : 'left') && (Math.abs(dx) > DIST_X || (Math.abs(dx) > FLICK_MIN && Math.abs(vx) > FLICK_V && Math.sign(vx) === Math.sign(dx)))) {
      commit(resultFor(dx > 0 ? 'right' : 'left')); return;
    }
    if (axis === 'up' && map.up && (-dy > DIST_UP || (-dy > FLICK_MIN && vy < -FLICK_V))) { commit(map.up); return; }
    if (axis === 'down' && map.down && (dy > DIST_UP || (dy > FLICK_MIN && vy > FLICK_V))) { commit(map.down); return; }
    reset();
  }

  // Touch Events on iPhone (reliable in Safari / home-screen PWA; preventDefault stops page scroll),
  // Pointer Events for mouse / pen.
  const onButton = (e) => !!e.target.closest?.('[data-nosw]');   // buttons on the card (bookmark) are not swipes
  card.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || onButton(e)) return;
    const p = e.changedTouches[0];
    if (start(p.clientX, p.clientY, e.timeStamp)) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchmove', (e) => {
    if (id === null || onButton(e)) return;
    e.preventDefault();
    const p = e.changedTouches[0];
    move(p.clientX, p.clientY, e.timeStamp);
  }, { passive: false });
  card.addEventListener('touchend', (e) => { if (id !== null) { e.preventDefault(); end(e.timeStamp, false); } }, { passive: false });
  card.addEventListener('touchcancel', (e) => end(e.timeStamp, true));
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || onButton(e)) return;
    if (start(e.clientX, e.clientY, e.timeStamp)) card.setPointerCapture?.(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e.clientX, e.clientY, e.timeStamp); });
  card.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') end(e.timeStamp, false); });
  card.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') end(e.timeStamp, true); });
  card.addEventListener('contextmenu', (e) => e.preventDefault());
  // extra touch areas (the one-handed pad at the bottom): a swipe there moves the card; a tap presses the button under the finger
  for (const pad of pads) {
    let tapTarget = null;
    pad.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) return;
      const p = e.changedTouches[0]; tapTarget = e.target.closest('button');
      if (start(p.clientX, p.clientY, e.timeStamp)) e.preventDefault();
    }, { passive: false });
    pad.addEventListener('touchmove', (e) => { if (id === null) return; e.preventDefault(); const p = e.changedTouches[0]; move(p.clientX, p.clientY, e.timeStamp); }, { passive: false });
    pad.addEventListener('touchend', (e) => { if (id !== null) { e.preventDefault(); end(e.timeStamp, false, () => { if (!tapTarget || tapTarget.disabled) return false; tapTarget.click(); return true; }); } }, { passive: false });
    pad.addEventListener('touchcancel', (e) => end(e.timeStamp, true));
  }
  return { commit, get done() { return done; } };
}

// card HTML skeleton with direction labels
export function swipeCardHTML(inner, knowRight = true, extra = '') {
  const map = typeof knowRight === 'object' ? knowRight : swipeMap(knowRight ? 'right' : 'left');
  const st = (d) => (map[d] ? `<span class="stamp s-${d === 'up' ? 'upv' : d} k-${map[d]}">${RESULT_JA[map[d]]}</span>` : '');
  return `<div class="fcard">${extra}${st('left')}${st('right')}${st('up')}${st('down')}
    <div class="face">${inner}</div></div>`;
}

// Answer strip shown right after each judgment (so you can check the answer without tapping first)
export function answerStripHTML(result, headword, meaning, revealed) {
  const m = { know: ['○', 'わかる', 'ok'], vague: ['△', '曖昧', 'near'], dont: ['✕', 'わからない', 'ng'], skip: ['→', '後回し（記録なし）', ''] }[result] || ['・', '', ''];
  return `<div class="lastcard ${m[2]}"><span class="lmark">${m[0]}</span><span class="grow"><b>${headword}</b><span>${meaning}</span></span><small>${m[1]}${revealed ? '' : '・答え未表示'}</small></div>`;
}

// ---- one-handed pad (1.12): buttons where the right thumb rests (iPhone keyboard: めくる ≈ between な and は,
// わかる above, わからない below, 後回し on the right, the rarely used ones on the left). The whole pad is also a swipe area.
export function oneHandPadHTML({ vague = true, undoHTML = '↩︎' } = {}) {
  return `<div class="qpad" id="qpad">
    <button class="btn qb know pk-up" data-r="know"><b>↑</b>わかる</button>
    <button class="btn qb pk-mid" data-flip><b>⇅</b>めくる</button>
    <button class="btn qb dont pk-down" data-r="dont"><b>↓</b>わからない</button>
    <button class="btn qb skip pk-right" data-r="skip"><b>→</b>後回し</button>
    ${vague ? '<button class="btn qb vague pk-left" data-r="vague"><b>△</b>曖昧</button>' : ''}
    <button class="btn qb pk-undo" id="undo" aria-label="取り消し">${undoHTML}</button>
  </div>`;
}
// card area = what is left between the top of the card and the pad
export function fitStage(stage, pad) {
  const fit = () => {
    if (!stage.isConnected) return removeEventListener('resize', fit);
    const r = stage.getBoundingClientRect(), box = stage.parentElement.getBoundingClientRect();
    const after = Math.max(0, box.bottom - r.bottom);
    stage.style.height = `${Math.max(160, innerHeight - pad.offsetHeight - r.top - after - 6)}px`;
  };
  fit(); requestAnimationFrame(fit); addEventListener('resize', fit);
}
