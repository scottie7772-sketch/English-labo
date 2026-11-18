// Shared instant feedback bar (lessons, games, speaking, listening)
import { $, esc } from './ui.js';
import { icon } from './icons.js';

// kind: 'ok' | 'near' | 'ng'
export function feedbackHTML({ kind, title, main = '', sub = '', more = '', nextLabel = '次へ' }) {
  return `<div class="fbbar ${kind}" role="status">
    <div class="fbbar-head">${icon(kind === 'ok' ? 'check' : kind === 'near' ? 'warn' : 'close', 22)}<b>${esc(title)}</b></div>
    ${main ? `<div class="fbbar-main">${main}</div>` : ''}
    ${sub ? `<div class="fbbar-sub">${sub}</div>` : ''}
    ${more ? `<details class="fbbar-more"><summary>詳しく</summary>${more}</details>` : ''}
    <button class="btn primary fbbar-next" id="fbNext">${esc(nextLabel)}</button></div>`;
}
export function showFeedback(host, opts, onNext) {
  host.innerHTML = feedbackHTML(opts);
  const b = $('#fbNext', host);
  b.focus({ preventScroll: true });
  b.onclick = () => { host.innerHTML = ''; onNext(); };
}
// word-level diff between the user's sentence and the target (for sentence answers)
export function wordDiff(you, target) {
  const tok = (s) => String(s).replace(/[¿¡]/g, '').split(/\s+/).filter(Boolean);
  const nz = (w) => w.toLowerCase().replace(/[.,!?;:"“”]/g, '');
  const a = tok(you), b = tok(target);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = nz(a[i]) === nz(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0; const outY = [], outT = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && nz(a[i]) === nz(b[j])) { outY.push(esc(a[i])); outT.push(esc(b[j])); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { outT.push(`<ins>${esc(b[j])}</ins>`); j++; }
    else { outY.push(`<del>${esc(a[i])}</del>`); i++; }
  }
  return { you: outY.join(' '), target: outT.join(' ') };
}
