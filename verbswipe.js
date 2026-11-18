// Verb Swipe Puzzle: long-press a verb, a ring of particles appears around the finger,
// swipe toward a particle and release. Tap a verb = ring stays open, then tap a particle.
import { $, $$, esc } from './ui.js';
import { shuffle } from './study.js';

export const DIRS8 = ['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft'];
const VEC = { up: [0, -1], upRight: [0.71, -0.71], right: [1, 0], downRight: [0.71, 0.71], down: [0, 1], downLeft: [-0.71, 0.71], left: [-1, 0], upLeft: [-0.71, -0.71] };
export const VS_DEFAULTS = { pressMs: 280, moveTol: 10, selectDist: 45, ring: 92, level: 4 };

export const isSwipeable = (w, sets) => !!(w.phrasal?.verb && w.phrasal.particles?.length === 1 && Object.values(sets).some((s) => Object.values(s).includes(w.phrasal.particles[0])));
function setFor(w, sets) {
  const p = w.phrasal.particles[0];
  if (w.swipe?.set && Object.values(sets[w.swipe.set] || {}).includes(p)) return w.swipe.set;
  return Object.keys(sets).find((k) => Object.values(sets[k]).includes(p));
}

// w: word with phrasal; pool: other phrasal words (for distractor verbs); onAnswer(result)
export function renderVerbSwipe(host, w, pool, sets, onAnswer, opt = {}) {
  const O = { ...VS_DEFAULTS, ...opt };
  const setName = setFor(w, sets), set = sets[setName];
  const verb = w.phrasal.verb, particle = w.phrasal.particles[0];
  const accept = [[verb, particle], ...(w.swipe?.accept || [])].map((a) => a.join(' '));
  const verbs = [verb, ...shuffle([...new Set(pool.map((x) => x.phrasal?.verb).filter((v) => v && v !== verb))]).slice(0, 3)];
  const tiles = shuffle(verbs);
  // active directions: correct particle + 3 others (level 4) or all 8
  const dirOf = Object.fromEntries(Object.entries(set).map(([d, p]) => [p, d]));
  const others = shuffle(DIRS8.filter((d) => d !== dirOf[particle]));
  const active = new Set(O.level >= 8 ? DIRS8 : [dirOf[particle], ...others.slice(0, 3)]);
  const ex = (w.senses || []).flatMap((s) => s.examples || [])[0];
  const meaning = (w.senses || []).flatMap((s) => s.meanings || []).join('、');
  const t0 = performance.now();
  let done = false;

  host.innerHTML = `
    <div class="vs">
      <div class="vs-prompt"><span class="small muted">${esc(w.swipe?.scene || '')}</span><div class="vs-ja">${esc(meaning)}</div>
        <div class="vs-preview" id="vsPrev">&nbsp;</div></div>
      <div class="vs-grid" id="vsGrid">${tiles.map((v) => `<button class="vs-tile" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>
      <p class="hint center">動詞を長押し→小辞の方向へスワイプして離す（タップでも選べます）<br><span class="vs-set s${setName}">セット${setName}</span></p>
    </div>`;
  const ring = document.createElement('div');
  ring.className = `vs-ring s${setName}`; ring.hidden = true;
  ring.innerHTML = `<i class="vs-center"></i>` + DIRS8.map((d) => `<button class="vs-petal ${active.has(d) ? '' : 'off'}" data-d="${d}" style="--x:${VEC[d][0]};--y:${VEC[d][1]}">${esc(set[d])}</button>`).join('');
  document.body.appendChild(ring);
  const prev = $('#vsPrev', host);
  let st = null;   // { verb, x0, y0, timer, open, dir, mode: 'press'|'tap', t }

  const openRing = (x, y) => {
    const r = O.ring + 30, W = innerWidth, H = innerHeight;
    const cx = Math.min(W - r, Math.max(r, x)), cy = Math.min(H - r, Math.max(r, y));
    ring.style.left = cx + 'px'; ring.style.top = cy + 'px'; ring.style.setProperty('--r', O.ring + 'px');
    ring.hidden = false; st.open = true; st.cx = cx; st.cy = cy;
    prev.textContent = st.verb + ' …';
  };
  const closeRing = () => { ring.hidden = true; $$('.vs-petal', ring).forEach((p) => p.classList.remove('hi')); prev.innerHTML = '&nbsp;'; $$('.vs-tile', host).forEach((t) => t.classList.remove('on')); };
  const dirAt = (x, y) => {
    const dx = x - st.cx, dy = y - st.cy; if (Math.hypot(dx, dy) < O.selectDist) return null;
    const ang = (Math.atan2(dx, -dy) * 180) / Math.PI;   // 0 = up, clockwise
    const d = DIRS8[Math.round(((ang + 360) % 360) / 45) % 8];
    return active.has(d) ? d : null;
  };
  const highlight = (d) => { st.dir = d; $$('.vs-petal', ring).forEach((p) => p.classList.toggle('hi', p.dataset.d === d)); prev.textContent = d ? `${st.verb} ${set[d]}` : st.verb + ' …'; };
  const commit = (v, p) => {
    if (done) return; done = true; closeRing(); ring.remove(); cleanupDoc();
    const said = `${v} ${p}`;
    const ok = accept.includes(said);
    $$('.vs-tile', host).forEach((t) => { t.disabled = true; if (t.dataset.v === v) t.classList.add(ok ? 'right' : 'wrong'); });
    prev.innerHTML = `<b class="${ok ? 'up' : 'down'}">${esc(said)}</b>`;
    onAnswer({ ok, verb: v, particle: p, said, verbOk: v === verb || accept.some((a) => a.startsWith(v + ' ')), particleOk: p === particle || accept.some((a) => a.endsWith(' ' + p)), target: `${verb} ${particle}`, ms: Math.round(performance.now() - t0), pressMs: st?.pressMs || 0, example: ex });
  };

  // ---- touch (iPhone) ----
  const pt = (e) => (e.touches?.[0] || e.changedTouches?.[0] || e);
  const start = (e, tile) => {
    if (done) return;
    if (e.touches && e.touches.length > 1) { cancel(); return; }
    if (st?.mode === 'tap' && st.open) return;   // ring already open by tap: petals handle it
    const p = pt(e);
    st = { verb: tile.dataset.v, x0: p.clientX, y0: p.clientY, open: false, dir: null, mode: 'press', t: performance.now() };
    tile.classList.add('on');
    st.timer = setTimeout(() => { if (st && !st.open) { st.pressMs = Math.round(performance.now() - st.t); openRing(st.x0, st.y0); } }, O.pressMs);
  };
  const move = (e) => {
    if (!st || st.mode !== 'press') return;
    if (e.touches && e.touches.length > 1) return cancel();
    const p = pt(e);
    if (!st.open) { if (Math.hypot(p.clientX - st.x0, p.clientY - st.y0) > O.moveTol) cancel(); return; }
    highlight(dirAt(p.clientX, p.clientY));
  };
  const end = (e, tile) => {
    if (!st || st.mode !== 'press') return;
    clearTimeout(st.timer);
    if (!st.open) {   // short tap -> ring stays open at the tile, choose by tapping
      const r = tile.getBoundingClientRect();
      st.mode = 'tap'; openRing(r.left + r.width / 2, r.top + r.height / 2);
      return;
    }
    if (st.dir) commit(st.verb, set[st.dir]); else { closeRing(); st = null; }   // released near center = cancel
  };
  const cancel = () => { if (st) clearTimeout(st.timer); closeRing(); st = null; };

  $$('.vs-tile', host).forEach((tile) => {
    tile.addEventListener('touchstart', (e) => { e.preventDefault(); start(e, tile); }, { passive: false });
    tile.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
    tile.addEventListener('touchend', (e) => { e.preventDefault(); end(e, tile); }, { passive: false });
    tile.addEventListener('touchcancel', cancel);
    tile.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; tile.setPointerCapture(e.pointerId); start(e, tile); });
    tile.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e); });
    tile.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') end(e, tile); });
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  ring.addEventListener('click', (e) => {
    const p = e.target.closest('.vs-petal');
    if (st?.mode !== 'tap') return;
    if (p && !p.classList.contains('off')) commit(st.verb, set[p.dataset.d]);
  });
  const outside = (e) => { if (st?.mode === 'tap' && st.open && !ring.contains(e.target) && !e.target.closest('.vs-tile')) cancel(); };
  document.addEventListener('click', outside, true);
  function cleanupDoc() { document.removeEventListener('click', outside, true); }
  // remove the ring if the screen changes
  const obs = new MutationObserver(() => { if (!document.body.contains(host) || !host.querySelector('.vs')) { ring.remove(); cleanupDoc(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });
}
