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

export function makeSwipeCard(card, { knowRight = true, onTap, onCommit, canInteract = () => true }) {
  let id = null, x0 = 0, y0 = 0, t0 = 0, dx = 0, dy = 0, axis = null, done = false;
  let lastX = 0, lastY = 0, lastT = 0, vx = 0, vy = 0;
  const knowDir = knowRight ? 'right' : 'left', dontDir = knowRight ? 'left' : 'right';
  const resultFor = (dir) => (dir === 'up' ? 'vague' : dir === knowDir ? 'know' : dir === dontDir ? 'dont' : null);
  const dirFor = (result) => (result === 'vague' ? 'up' : result === 'know' ? knowDir : dontDir);

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
    } else if (axis === 'down') {
      card.style.transform = `translateY(${Math.max(0, dy) * 0.25}px)`;   // downward does nothing
      setStamp(null, 0);
    }
  }
  function end(t, cancelled) {
    if (id === null) return;
    id = null;
    if (done) return;
    if (cancelled) { reset(); return; }
    const dur = t - t0;
    if (!axis && dur < TAP_MS && Math.hypot(dx, dy) < TAP_MOVE) { reset(); onTap?.(); return; }
    if (axis === 'x' && (Math.abs(dx) > DIST_X || (Math.abs(dx) > FLICK_MIN && Math.abs(vx) > FLICK_V && Math.sign(vx) === Math.sign(dx)))) {
      commit(resultFor(dx > 0 ? 'right' : 'left')); return;
    }
    if (axis === 'up' && (-dy > DIST_UP || (-dy > FLICK_MIN && vy < -FLICK_V))) { commit('vague'); return; }
    reset();
  }

  // Touch Events on iPhone (reliable in Safari / home-screen PWA; preventDefault stops page scroll),
  // Pointer Events for mouse / pen.
  card.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) return;
    const p = e.changedTouches[0];
    if (start(p.clientX, p.clientY, e.timeStamp)) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchmove', (e) => {
    if (id === null) return;
    e.preventDefault();
    const p = e.changedTouches[0];
    move(p.clientX, p.clientY, e.timeStamp);
  }, { passive: false });
  card.addEventListener('touchend', (e) => { if (id !== null) { e.preventDefault(); end(e.timeStamp, false); } }, { passive: false });
  card.addEventListener('touchcancel', (e) => end(e.timeStamp, true));
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (start(e.clientX, e.clientY, e.timeStamp)) card.setPointerCapture?.(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e.clientX, e.clientY, e.timeStamp); });
  card.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') end(e.timeStamp, false); });
  card.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') end(e.timeStamp, true); });
  card.addEventListener('contextmenu', (e) => e.preventDefault());
  return { commit, get done() { return done; } };
}

// card HTML skeleton with direction labels
export function swipeCardHTML(inner, knowRight = true) {
  return `<div class="fcard">
    <span class="stamp s-left ${knowRight ? 'k-dont' : 'k-know'}">${knowRight ? 'わからない' : 'わかる'}</span>
    <span class="stamp s-right ${knowRight ? 'k-know' : 'k-dont'}">${knowRight ? 'わかる' : 'わからない'}</span>
    <span class="stamp s-upv k-vague">曖昧</span>
    <div class="face">${inner}</div></div>`;
}

// Answer strip shown right after each judgment (so you can check the answer without tapping first)
export function answerStripHTML(result, headword, meaning, revealed) {
  const m = { know: ['○', 'わかる', 'ok'], vague: ['△', '曖昧', 'near'], dont: ['✕', 'わからない', 'ng'] }[result] || ['・', '', ''];
  return `<div class="lastcard ${m[2]}"><span class="lmark">${m[0]}</span><span class="grow"><b>${headword}</b><span>${meaning}</span></span><small>${m[1]}${revealed ? '' : '・答え未表示'}</small></div>`;
}
