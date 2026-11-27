import { maLinks } from './ma-phrases.js';
import { resolveRef } from './audio-ref-model.js';
import { resolveAudio, playResolved, STATUS_TEXT } from './word-audio-resolve.js';
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

export function makeSwipeCard(card, { knowRight = true, map = null, pads = [], paper = false, onTap, onCommit, canInteract = () => true, revealOnCommit = null }) {
  let tapEl = null;
  const calm = paper && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = paper ? card.closest('.qrun') : null;
  let id = null, x0 = 0, y0 = 0, t0 = 0, dx = 0, dy = 0, axis = null, done = false;
  let lastX = 0, lastY = 0, lastT = 0, vx = 0, vy = 0;
  map = map || swipeMap(knowRight ? 'right' : 'left');
  const resultFor = (dir) => map[dir] || null;
  const dirFor = (result) => Object.keys(map).find((d) => map[d] === result) || 'up';

  function setStamp(dir, strength) {
    card.dataset.dir = dir || '';
    card.dataset.res = (dir && resultFor(dir)) || '';
    card.style.setProperty('--s', String(Math.min(1, strength)));
    if (root) { root.dataset.drag = dir || ''; root.style.setProperty('--drag', String(Math.min(1, strength))); }
  }
  // paper card (1.14): follows the finger up/down with a slight tilt; the edge and shade show it lifting
  const paperMove = (y) => `translateY(${y}px)${calm ? '' : ` rotateX(${Math.max(-7, Math.min(7, -y * 0.03)).toFixed(2)}deg)`}`;
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
    if (paper && result !== 'skip') card.classList.add('revealed');
    else if (revealOnCommit && result !== 'skip') { const f = card.querySelector('.face'); if (f) f.innerHTML = revealOnCommit(); card.classList.add('revealed'); }
    const dir = dirFor(result);
    card.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
    const tx = dir === 'right' ? window.innerWidth : dir === 'left' ? -window.innerWidth : dx;
    const ty = dir === 'up' ? -window.innerHeight * 0.9 : dir === 'down' ? window.innerHeight * 0.9 : dy;
    const vert = dir === 'up' || dir === 'down';
    card.style.transform = paper && vert ? paperMove(ty * 0.7) : `translate(${vert ? dx * 0.3 : tx}px, ${ty}px) rotate(${vert ? 0 : (tx > 0 ? 18 : -18)}deg)`;
    if (paper) card.style.transition = 'transform .24s cubic-bezier(.4,0,.8,.6), opacity .2s ease-in';
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
    } else if (paper && (axis === 'up' || axis === 'down')) {
      const y = axis === 'up' ? Math.min(0, dy) : Math.max(0, dy);
      card.style.transform = paperMove(y);
      setStamp(axis, Math.abs(y) / DIST_UP);
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
    if (!axis && dur < TAP_MS && Math.hypot(dx, dy) < TAP_MOVE) { reset(); if (!(tapAt && tapAt())) onTap?.(tapEl); return; }
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
    const p = e.changedTouches[0]; tapEl = e.target;
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
    tapEl = e.target;
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
      if (e.touches.length > 1 || card.contains(e.target) || e.target.closest?.('[data-nosw], .qhead, .sheet, .pauseov, .fc2-menu')) return;
      const p = e.changedTouches[0]; tapTarget = e.target.closest('button'); tapEl = e.target;
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

// ================= 1.14 flashcard design ("fc2"): one card, swipe ↑知ってる ↓わからない anywhere on the screen =================
const POS_ABBR = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.', number: 'num.', measure: 'meas.', 'phrasal verb': 'phr. v.', idiom: 'idiom', phrase: 'phrase' };
export const posAbbr = (w) => [...new Set((w.senses || []).map((x) => POS_ABBR[x.pos] || x.pos).filter(Boolean))].join(' / ');
const escH = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// the card face: the big line stays in the same place; the answer appears under it (nothing moves)
export function fc2FaceHTML(w, direction, meanings, { reading = '' } = {}) {
  const en = `<div class="fc2-en" data-say lang="en">${escH(w.headword)}</div>`;
  const ja = `<div class="fc2-ja">${escH(meanings.join('、'))}</div>`;
  const ex = (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en);
  const exH = ex ? `<div class="fc2-ex"><span data-say>${escH(ex.en)}</span>${ex.ja ? `<br><span class="fc2-exja">${escH(ex.ja)}</span>` : ''}</div>` : '';
  const pos = posAbbr(w), posH = `<div class="fc2-pos">${escH(pos)}</div>`;
  const read = reading ? `<div class="fc2-read">${escH(reading)}</div>` : '';
  let big, rev;
  if (direction === 'ja2en') { big = `<div class="fc2-en fc2-jabig">${escH(meanings.join('、'))}</div>`; rev = `${en}${read}${posH}${exH}`; }
  else if (direction && direction.startsWith('audio')) { big = '<div class="fc2-en fc2-audio" data-say aria-label="もう一度聞く">🔊</div>'; rev = `${en}${read}${posH}<i class="fc2-line"></i>${ja}${exH}`; }
  else { big = `${en}`; rev = `<i class="fc2-line"></i>${ja}${exH}`; }
  return `<div class="fc2-face"><div class="fc2-top">${big}</div>${direction === 'ja2en' || direction?.startsWith('audio') ? '' : read + posH}<div class="fc2-rev">${rev}</div></div>`;
}
export function fc2CardHTML(faceHTML, bmHTML = '') {
  return `<div class="fcard fc2-card">${bmHTML}<div class="face">${faceHTML}</div></div>`;
}
// font size from the real width: words / phrases / sentences, at most about 3 lines
export function fitBig(card) {
  const el = card.querySelector('.fc2-top .fc2-en'); if (!el || el.classList.contains('fc2-audio')) return;
  const t = el.textContent.trim(), words = t.split(/\s+/).length, ja = /[\u3040-\u30ff\u3400-\u9fff]/.test(t);
  let size = ja ? (t.length <= 8 ? 30 : t.length <= 16 ? 26 : 22)
    : words === 1 ? (t.length <= 9 ? 40 : 38) : words <= 3 && t.length <= 16 ? 36 : t.length <= 28 ? 32 : t.length <= 48 ? 28 : 26;
  const box = el.parentElement, min = ja ? 16 : 20;
  el.style.fontSize = `${size}px`;
  while (size > min && (el.scrollWidth > box.clientWidth + 1 || el.offsetHeight > box.clientHeight + 1)) { size -= 2; el.style.fontSize = `${size}px`; }
}
// header (✕ … ⋯), "9 / 36" + bar, the faint swipe guide, and a menu for the less used controls
export function fc2Setup(root, { items = [], info = () => '' } = {}) {
  root.classList.add('fc2');
  document.body.classList.add('fc2-on');
  const off = () => { document.body.classList.remove('fc2-on'); removeEventListener('hashchange', off); };
  addEventListener('hashchange', off);
  const head = root.querySelector('.qhead'), prog = root.querySelector('.progress'), pos = root.querySelector('#pos');
  head.insertAdjacentHTML('beforeend', '<button class="xbtn fc2-more" id="fc2More" aria-label="メニュー">•••</button>');
  const row = document.createElement('div'); row.className = 'fc2-prog'; prog.before(row); if (pos) row.appendChild(pos); row.appendChild(prog);
  root.insertAdjacentHTML('beforeend', `<div class="fc2-guide" aria-hidden="true"><i></i><div class="fc2-gl"><span class="g-up"><b>↑</b>知ってる</span><span class="g-dn"><b>↓</b>わからない</span></div><i></i></div>
    <div class="fc2-menu" id="fc2Menu" hidden><div class="fc2-mbox"><div class="fc2-minfo" id="fc2Info"></div>${items.map((it, i) => `<button class="fc2-mi" data-i="${i}">${it.label}</button>`).join('')}<button class="fc2-mi fc2-mclose">閉じる</button></div></div>`);
  const menu = root.querySelector('#fc2Menu');
  const open = () => { root.querySelector('#fc2Info').textContent = info(); items.forEach((it, i) => { const b = menu.querySelector(`[data-i="${i}"]`); b.disabled = !!it.disabled?.(); if (it.text) b.textContent = it.text(); }); menu.hidden = false; };
  root.querySelector('#fc2More').onclick = open;
  menu.onclick = (e) => { const b = e.target.closest('.fc2-mi'); if (e.target === menu || b?.classList.contains('fc2-mclose')) { menu.hidden = true; return; } if (b && !b.disabled) { menu.hidden = true; items[+b.dataset.i].run(); } };
}
// the card fills the space down to the guide (fixed height for this screen)
export function fc2Fit(stage) {
  const fit = () => {
    if (!stage.isConnected) return removeEventListener('resize', fit);
    const g = stage.closest('.qrun').querySelector('.fc2-guide');
    const top = stage.getBoundingClientRect().top, bottom = g ? g.getBoundingClientRect().top - 34 : innerHeight * 0.76;
    stage.style.height = `${Math.max(260, bottom - top)}px`;
  };
  fit(); requestAnimationFrame(fit); addEventListener('resize', fit);
}
// English read-aloud: once when a card appears (if the English is on the front), on every tap of the English text.
// iPhone may refuse speech before the first touch: then the first touch on the screen plays it.
export function fc2Voice(root, speakFn) {
  let pending = null, unlocked = false, wa = null, seq = 0;
  // 1.17.10: the original recording first (when the same word / sentence is in a matched material), else the synthetic voice
  // 1.19.31: a word that has its own registered sound (word.audio) plays exactly that range first
  // 1.19.42: 保存済みの参照がある単語は、全教材の索引を作らずに直接鳴らす。索引は、参照のない単語を鳴らすときに初めて作る（下の ready() の分岐）。
  import('./word-audio.js').then((m) => { wa = m; }).catch(() => {});
  const tell = (m) => { if (m) import('./ui.js').then((u) => u.toast(m, 3500)).catch(() => {}); };   // 1.19.36: say why the synthetic voice is used
  const tts = (text, onEnd) => {
    try { const u = speakFn(text); if (u) { u.onstart = () => { unlocked = true; pending = null; }; if (onEnd) { u.onend = onEnd; u.onerror = onEnd; } } else onEnd?.(); }
    catch { onEnd?.(); /* the cards still work without sound */ }
  };
  const say = (text, { w = null, waited = false, onEnd = null } = {}) => {
    if (!text) { onEnd?.(); return; }
    const my = ++seq;
    try { speechSynthesis.cancel(); } catch {}
    // 1.19.42: one resolver for every kind of material (word.audio, MA phrase links). Nothing is searched here.
    const res = resolveAudio(w, text);
    if (res.via) {
      playResolved(res, { onEnd, active: () => my === seq }).then((ok) => {
        if (my !== seq) return;
        if (ok) { unlocked = true; pending = null; return; }
        if (res.via === 'ma') { tell(res.kind === 'word' ? 'フレーズ音声は未確定、または参照切れです' : '使用例の元音声を再生できません'); return; }   // MA: no synthetic voice (unchanged)
        tell(STATUS_TEXT.broken + '：合成音声で読み上げます'); tts(text, onEnd);
      });
      return;
    }
    if (res.ma) { tell(res.reason); onEnd?.(); return; }
    if (res.status === 'unsure' || res.status === 'stale') tell(STATUS_TEXT[res.status] + '：合成音声で読み上げます');
    if (wa && origOn() && !wa.ready() && !waited) {   // 1.18.6: the list of recordings is still loading: wait a moment instead of using TTS
      Promise.race([wa.prepare(), new Promise((r) => setTimeout(r, 2500))]).then(() => { if (my === seq) { seq--; say(text, { w, waited: true, onEnd }); } else onEnd?.(); }); return;
    }
    if (wa?.has(text) && origOn()) { wa.play(text, { onEnd }).then((ok) => { if (ok) { unlocked = true; pending = null; } else if (my === seq) { tell(wa.note(text, true)); tts(text, onEnd); } else onEnd?.(); }); return; }
    wa?.stop(); if (wa && origOn()) tell(wa.note(text)); tts(text, onEnd);
  };
  // word, then the example (both from the registered sounds; the example only when it has its own sound)
  const both = (w, onEnd) => {
    if (w.ma) return say(w.headword, { w, onEnd });
    const a = resolveAudio(w, w.headword).ref, b = resolveAudio(w, (w.senses || []).flatMap(x => x.examples || []).find(x => x.en)?.en).ref;
    if (a && b) {
      const my = ++seq; try { speechSynthesis.cancel(); } catch {}
      const go = (m) => m.playRefs([a, b], { onEnd }).then((ok) => { if (ok) { unlocked = true; pending = null; } else if (my === seq) say(w.headword, { w, onEnd }); });
      return void (wa ? go(wa) : import('./word-audio.js').then((m) => { wa = m; go(m); }));
    }
    say(w.headword, { w, onEnd });
  };
  root.addEventListener('touchstart', () => { wa?.unlock(); if (!unlocked) { unlocked = true; if (pending) { const t = pending; pending = null; t(); } } }, { capture: true, passive: true });
  const ended = (fn) => new Promise((resolve) => fn(resolve));
  return {
    // shown with a new card. listening (audio…) directions always play; otherwise the 自動再生 setting decides
    auto(text, w = null, { listening = false } = {}) {
      if (!listening && !autoOn()) return Promise.resolve(false);
      return ended((resolve) => {
        const run = () => (w && seqOn() && !listening ? both(w, () => resolve(true)) : say(text, { w, onEnd: () => resolve(true) }));
        pending = run; run();
      });
    },
    tap(text, w = null) { pending = null; return ended((resolve) => say(text, { w, onEnd: () => resolve(true) })); },
    both(w) { pending = null; return ended((resolve) => both(w, () => resolve(true))); },
    example(w) { const ex = (w.ma ? maLinks(w)[0]?.ref : resolveRef(w, 'example')?.ref) || null; const text = ex?.origin?.text || (w.senses || []).flatMap((x) => x.examples || []).find((x) => x.en)?.en; pending = null; return ended((resolve) => say(text, { w, onEnd: () => resolve(true) })); },
    stop() { pending = null; seq++; wa?.stop(); try { speechSynthesis.cancel(); } catch {} },
  };
}
// 音声→ cards: the English appears under the speaker once the sound has played (setting), the answer stays hidden
export function showAfterAudio(card, w) {
  const top = card?.querySelector('.fc2-top');
  if (!top || top.querySelector('.fc2-after')) return;
  top.insertAdjacentHTML('beforeend', `<div class="fc2-after" lang="en">${escH(w.headword)}</div>`);
}
const flag = (key, dflt) => { try { const v = localStorage.getItem(key); return v == null ? dflt : v === '1'; } catch { return dflt; } };
// 1.19.31 settings: play the word when a card appears / then its example / in 音声→ cards, show the English after the sound
export const autoOn = () => flag('fc-auto', true);
export const seqOn = () => flag('fc-seq', false);
export const listenRevealOn = () => flag('fc-listen-en', false);
// setting: use the original recording on cards (on by default)
export const origOn = () => { try { return localStorage.getItem('fc-orig') !== '0'; } catch { return true; } };
