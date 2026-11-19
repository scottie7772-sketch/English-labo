// Word / phrase list from transcripts (pure functions, testable without a browser)
export const STOP = new Set('a an the and or but if so to of in on at by for with from as is am are was were be been being do does did have has had i you he she it we they me him her us them my your his its our their this that these those there here what who which when where why how not no yes oh ok okay will would can could shall should may might must just very also too then than um uh well'.split(' '));
// basic words (roughly junior-high level) hidden by default in word mode
export const BASIC = new Set(`about above across after again against age ago all almost alone along already always among angry animal another answer any anyone anything apple arm around arrive art ask aunt away baby back bad bag ball bank bath beautiful because become bed before begin behind believe best better between big bike bird birthday black blue boat body book born both box boy bread break breakfast bring brother brown build bus busy buy cake call camera can't car card care carry cat catch chair change cheap child children city class classmate clean clear climb clock close cloud club cold color come computer cook cool corner could country cousin cry cup cut dad dance dark daughter day dear decide desk die different difficult dinner dish doctor dog door down draw dream dress drink drive drop during each ear early earth east easy eat egg eight end english enjoy enough enter even evening ever every everyone everything example eye face fall family famous far fast father favorite feel few find fine finish fire first fish five floor flower fly food foot forget four free friend from front fruit full fun future game garden girl give glad glass go good great green group grow guitar hair half hand happen happy hard hat hate head hear heart heavy hello help high hold holiday home homework hope horse hospital hot hour house hundred hungry hurry idea important interesting into job join juice keep key kid kind kitchen know lake land language large last late learn leave left leg lesson let letter library life light like line listen little live long look lose lot love low lunch make man many map may maybe meet member milk mind minute miss moment money month more morning most mother mountain mouth move movie much music name near need never new news next nice night nine noon north nose nothing now number often old once one only open other out over own page paper parent park party pass pay pen people person piano picture place plan play please point police poor popular present pretty problem put question quick quiet rain read ready real really red remember rest restaurant rice rich ride right river road room run sad same say school sea season second see sell send seven shall ship shoe shop short show sick side sing sister sit six sky sleep slow small smile snow some someone something sometimes son song soon sorry sound south speak special sport spring stand star start station stay still stop store story street student study summer sun sure swim table take talk tall teach teacher team tell ten tennis test thank thing think third thousand three through time tired today together tomorrow tonight town train tree trip try turn twelve twenty two uncle under understand until up use usually visit wait wake walk wall want warm wash watch water way wear weather week weekend welcome west wet white why wife win window winter wish without woman word work world worry write wrong year yellow yesterday young`.split(/\s+/));

export const norm = (w) => w.replace(/[’]/g, "'").replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
const ABBR = /\b(Mr|Mrs|Ms|Dr|St|vs|etc)\./g;
export function sentences(text) {
  const t = String(text || '').replace(ABBR, '$1․');
  return (t.match(/[^.!?]+(?:[.!?]+|$)/g) || []).map((x) => x.replace(/․/g, '.').trim()).filter(Boolean);
}
// very small lemmatiser: enough to group plays/played/playing, stories/story, stopped/stop
export function lemma(w) {
  w = w.toLowerCase();
  if (w.length <= 3) return w;
  const irr = { went: 'go', gone: 'go', did: 'do', done: 'do', made: 'make', took: 'take', taken: 'take', got: 'get', found: 'find', thought: 'think', paid: 'pay', said: 'say', told: 'tell', came: 'come', saw: 'see', seen: 'see', knew: 'know', known: 'know', bought: 'buy', brought: 'bring', felt: 'feel', left: 'leave', kept: 'keep', met: 'meet', sent: 'send', spent: 'spend', built: 'build', taught: 'teach', caught: 'catch', wrote: 'write', written: 'write', gave: 'give', given: 'give', began: 'begin', begun: 'begin', children: 'child', men: 'man', women: 'woman', people: 'person' };
  if (irr[w]) return irr[w];
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|zz)es$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w) && !/(us|is|ss)$/.test(w)) return w.slice(0, -1);
  const fix = (b) => (/([bdgklmnprt])\1$/.test(b) && !/(ll|ss)$/.test(b) ? b.slice(0, -1) : /[^aeiou][aeiou][cvz]$|[^aeiou]at$|(us|iv|ag|ak|ar|ok|ur|it)$/.test(b) && !/(ing|en|er)$/.test(b) ? b + 'e' : b);
  if (/ied$/.test(w)) return w.slice(0, -3) + 'y';
  if (/ed$/.test(w) && w.length > 4) return fix(w.slice(0, -2));
  if (/ing$/.test(w) && w.length > 5) return fix(w.slice(0, -3));
  return w;
}
const content = (s) => s.toLowerCase().split(/[\s,]+/).map(norm).filter((w) => w && !STOP.has(w) && !/^(x|do|doing|one's|someone|something|sb|sth)$/.test(w));

// items: [{ text, ja }] in order → phrase entries { phrase, ex, exJa, at }
// a headword is a short sentence (1–5 words, or the part before a comma) followed by a sentence that uses its words
export function extractPhrases(items) {
  const ss = [];
  items.forEach((it, bi) => sentences(it.text).forEach((s) => ss.push({ s, bi, ja: it.ja || '' })));
  const out = [], seen = new Set();
  const uses = (head, s) => { const ws = content(head); const ls = new Set(s.toLowerCase().split(/[\s,]+/).map(norm).map(lemma)); return ws.length > 0 && ws.every((w) => ls.has(lemma(w)) || ls.has(w)); };
  for (let i = 0; i < ss.length; i++) {
    let head = ss[i].s, ex = null, exJa = '';
    const comma = head.match(/^([^,]{2,40}),\s*(.+)$/);   // "Along with, send a resume along with ..."
    if (comma && comma[1].split(/\s+/).length <= 6 && uses(comma[1], comma[2])) { head = comma[1]; ex = comma[2]; exJa = ss[i].ja; }
    else {
      if (head.split(/\s+/).length > 6) continue;
      for (const j of [i + 1, i + 2]) if (ss[j] && ss[j].s.split(/\s+/).length > head.split(/\s+/).length && uses(head, ss[j].s)) { ex = ss[j].s; exJa = ss[j].bi !== ss[i].bi ? ss[j].ja : ''; break; }
      if (!ex) continue;
    }
    const phrase = head.replace(/[.!?…]+$/, '').replace(/^(\w)/, (c) => (/^I\b/.test(head) ? c : c.toLowerCase())).trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key); out.push({ phrase, ex, exJa, at: ss[i].bi });
  }
  return out;
}
// word entries with noise removed: names (capitalised inside a sentence), contractions, numbers; inflections grouped
export function extractWords(items, { hideBasic = true, showCommon = false } = {}) {
  const map = new Map();
  items.forEach((it, bi) => sentences(it.text).forEach((s) => s.split(/\s+/).forEach((raw, k) => {
    const w = norm(raw); if (!w || w.length < 2 || /\d/.test(w) || w.includes("'")) return;
    if (k > 0 && /^[A-Z]/.test(w) && w !== 'I') return;   // probably a name or a place
    const lw = w.toLowerCase(); const lm = lemma(lw);
    if (!showCommon && (STOP.has(lw) || STOP.has(lm))) return;
    if (hideBasic && (BASIC.has(lw) || BASIC.has(lm))) return;
    if (!map.has(lm)) map.set(lm, { w: lm, forms: new Set(), n: 0, first: bi, ex: s, exJa: it.ja || '' });
    const e = map.get(lm); e.n++; e.forms.add(lw);
  })));
  // show a real form: the base form if it occurred, otherwise the shortest form seen
  return [...map.values()].map((e) => ({ ...e, w: e.forms.has(e.w) ? e.w : [...e.forms].sort((a, b) => a.length - b.length)[0] }));
}
