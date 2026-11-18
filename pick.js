// "Tap words in a sentence and register them" dialog (listening scripts, speaking, video).
import { $, $$, esc, toast } from './ui.js';
import { newWord, newSense, saveWord, wordsByHead, findDuplicate, splitList } from './words.js';
import { hasHan } from './langs.js';

// text: sentence, ja: translation, lang, source: { type, ... }
export function pickWordsDialog({ text, ja = '', lang = 'en', source = { type: 'manual' }, title = '語句を登録' }) {
  const cjk = lang === 'zh-TW' || hasHan(text);
  let n = 0;
  const html = cjk
    ? [...text].map((ch) => (/[㐀-鿿]/.test(ch) ? `<span class="tok" data-n="${n++}">${esc(ch)}</span>` : esc(ch))).join('')
    : text.split(/(\s+)/).map((tk) => {
        if (!tk.trim()) return tk;
        const m = tk.match(/^([^\p{L}']*)([\p{L}][\p{L}'\-]*)([^\p{L}']*)$/u);
        return m ? `${esc(m[1])}<span class="tok" data-n="${n++}">${esc(m[2])}</span>${esc(m[3])}` : esc(tk);
      }).join('');
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(title)}</h3>
    <p class="hint">${cjk ? '字をタップ（続けて選ぶと語になります）' : '語をタップ（隣り合う語を続けて選ぶと熟語）'}</p>
    <div class="ptext" ${lang === 'zh-TW' ? 'lang="zh-Hant-TW"' : ''}>${html}</div>
    ${ja ? `<p class="small muted">${esc(ja)}</p>` : ''}
    <label class="field"><span>登録する語句（編集可）</span><input id="wh" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    ${lang === 'zh-TW' ? '<label class="field"><span>ピンイン（任意。hao3 のような数字でも可）</span><input id="wp" autocapitalize="off" autocorrect="off" spellcheck="false"></label>' : ''}
    <label class="field"><span>意味（「/」で複数・あとで入力も可）</span><input id="wm"></label>
    <label class="chk"><input type="checkbox" id="wb"> ブックマークする</label>
    <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">登録</button></div></form>`;
  const sync = () => {
    const on = $$('.tok.on', dlg).map((t) => +t.dataset.n); const all = $$('.tok', dlg);
    if (!on.length) return;
    $('#wh', dlg).value = all.slice(Math.min(...on), Math.max(...on) + 1).map((t) => t.textContent).join(cjk ? '' : ' ');
  };
  $('.ptext', dlg).onclick = (e) => { const t = e.target.closest('.tok'); if (t) { t.classList.toggle('on'); sync(); } };
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const head = $('#wh', dlg).value.trim();
      if (!head) { toast('語句を選んでください'); return resolve(null); }
      const meanings = splitList($('#wm', dlg).value);
      const ex = { en: text, ja };
      const exist = findDuplicate(await wordsByHead(lang), head, meanings);
      if (exist) {
        const s0 = exist.senses[0];
        if (!(s0.examples || []).some((x) => x.en === text)) s0.examples = [...(s0.examples || []), ex];
        s0.meanings.push(...meanings.filter((m) => !s0.meanings.includes(m)));
        if ($('#wb', dlg).checked) exist.bookmarked = true;
        await saveWord(exist); toast(`「${exist.headword}」は登録済み：例文を追加しました`); return resolve(exist);
      }
      const w = newWord({ headword: head, lang, bookmarked: $('#wb', dlg).checked, ipa: $('#wp', dlg)?.value.trim() || '', source, senses: [newSense({ meanings, examples: [ex] })] });
      await saveWord(w); toast(`「${w.headword}」を登録しました`); resolve(w);
    };
    dlg.showModal();
  });
}
