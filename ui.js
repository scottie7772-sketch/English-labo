// Shared UI helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

// options: { title, body(html), okLabel, cancelLabel, danger, requireText }
export function confirmDialog({ title, body = '', okLabel = 'OK', cancelLabel = 'キャンセル', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    if (dlg.open) { dlg.onclose = null; dlg.close(); }   // Safari can still report the previous dialog as open inside its close event
    dlg.innerHTML = `
      <form method="dialog" class="dlg">
        <h3>${esc(title)}</h3>
        <div class="dlg-body">${body}</div>
        ${requireText ? `<label class="field"><span>確認のため「${esc(requireText)}」と入力</span><input name="confirm" autocomplete="off" autocapitalize="off"></label>` : ''}
        <div class="row end">
          ${cancelLabel ? `<button value="cancel" class="btn ghost">${esc(cancelLabel)}</button>` : ''}
          <button value="ok" class="btn ${danger ? 'danger' : 'primary'}" ${requireText ? 'disabled' : ''}>${esc(okLabel)}</button>
        </div>
      </form>`;
    const ok = dlg.querySelector('button[value=ok]');
    if (requireText) dlg.querySelector('input').addEventListener('input', (e) => { ok.disabled = e.target.value.trim() !== requireText; });
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
  });
}

export function go(hash) { location.hash = hash; }

// Text-to-speech (iOS built-in voices, free, on-device)
// lang: 'en' | 'es' | 'zh-TW' (default: Han characters -> zh-TW, otherwise the current learning language)
import { L, curLang, hasHan, isZh } from './langs.js';
const voices = {};
function pickVoices() {
  const all = speechSynthesis.getVoices();
  for (const code of ['en', 'es', 'zh-TW', 'zh-CN']) {
    const d = L(code); const want = [d.speech, ...d.speechAlt];
    let v = null;
    for (const w of want) { const c = all.filter((x) => x.lang?.replace('_', '-').toLowerCase().startsWith(w.toLowerCase())); v = (code === 'en' && c.find((x) => /Samantha|Alex|Ava|Allison/.test(x.name))) || c[0]; if (v) break; }
    voices[code] = v || null;
  }
}
if ('speechSynthesis' in window) { pickVoices(); speechSynthesis.onvoiceschanged = pickVoices; }
export function speakLang(text) { return hasHan(text) && !/[\u3040-\u30ff]/.test(text) ? (isZh(curLang()) ? curLang() : 'zh-TW') : curLang(); }
export function speak(text, rate = 0.95, lang = null, { pitch = 1, onend = null, queue = false } = {}) {
  if (!('speechSynthesis' in window) || !text) { onend?.(); return; }
  if (!queue) speechSynthesis.cancel();
  const code = lang || speakLang(text);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = L(code).speech; u.rate = rate; u.pitch = pitch; if (voices[code]) u.voice = voices[code];
  if (onend) { u.onend = onend; u.onerror = onend; }
  speechSynthesis.speak(u);
  return u;
}
export const hasVoice = (code) => !!voices[code];

export function fmtDate(ts, withTime = true) {
  if (!ts) return '—';
  const o = withTime ? { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'numeric', day: 'numeric' };
  return new Date(ts).toLocaleString('ja-JP', o);
}

// swipe a row to the left → a red "削除" button appears; tapping it calls onDelete(row) (which asks for confirmation)
export function swipeToDelete(rows, onDelete, { width = 88 } = {}) {
  for (const row of rows) {
    if (row.parentElement?.classList.contains('swrap')) continue;
    const wrap = document.createElement('div'); wrap.className = 'swrap';
    row.before(wrap); wrap.appendChild(row);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'swdel'; del.textContent = '削除'; wrap.appendChild(del);
    let x0 = 0, y0 = 0, dx = 0, on = false, moved = false, open = false;
    const set = (x, anim) => { row.style.transition = anim ? 'transform .18s' : 'none'; row.style.transform = x ? `translateX(${x}px)` : ''; };
    row.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; on = null; moved = false; }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
      if (on === null) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; on = Math.abs(mx) > Math.abs(my); }
      if (!on) return;
      e.preventDefault(); moved = true;
      dx = Math.max(-width - 30, Math.min(0, (open ? -width : 0) + mx)); set(dx, false);
    }, { passive: false });
    row.addEventListener('touchend', () => { if (!on) return; open = dx < -width / 2; set(open ? -width : 0, true); });
    row.addEventListener('click', (e) => { if (moved || open) { e.preventDefault(); e.stopPropagation(); if (open && !moved) { open = false; set(0, true); } moved = false; } }, true);
    del.addEventListener('click', async () => { const done = await onDelete(row); if (!done) { open = false; set(0, true); } });
  }
}
