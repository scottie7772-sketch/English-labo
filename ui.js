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
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en'));
  voice = vs.find((v) => v.lang === 'en-US' && /Samantha|Alex|Ava|Allison/.test(v.name)) || vs.find((v) => v.lang === 'en-US') || vs[0] || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
export function speak(text, rate = 0.95) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = rate; if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export function fmtDate(ts, withTime = true) {
  if (!ts) return '—';
  const o = withTime ? { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'numeric', day: 'numeric' };
  return new Date(ts).toLocaleString('ja-JP', o);
}
