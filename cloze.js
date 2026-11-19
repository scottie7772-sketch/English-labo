// Subtitle cloze (穴埋め): tokenize a subtitle, keep "holes" (hidden word ranges) on the cue, find automatic candidates.
// Holes are stored on the cue record: cue.holes = [{ s, e, text, auto, ok, ng, last }]  (s..e = token indexes, inclusive)
import { esc } from './ui.js';
import { isZh } from './langs.js';

// tokens: [{ w: 'came', pre: '', post: '' }] — words only; spaces are restored on render
export function tokenize(text, lang = 'en') {
  if (isZh(lang)) return [...String(text)].filter((ch) => ch.trim()).map((ch) => ({ w: ch, pre: '', post: '', cjk: true }));
  return String(text).split(/\s+/).filter(Boolean).map((tk) => {
    const m = tk.match(/^([^\p{L}\p{N}']*)([\p{L}\p{N}][\p{L}\p{N}'’\-]*)([^\p{L}\p{N}']*)$/u);
    return m ? { w: m[2], pre: m[1], post: m[3] } : { w: '', pre: tk, post: '' };
  });
}
const norm = (s) => String(s).toLowerCase().replace(/[’]/g, "'");

// A small built-in list of words that are frequent in business / TOEIC-type English (original selection, not from a book).
export const TOEIC_WORDS = new Set(`
account accounting accommodate accurate acquire additional address adjust admission advance advertise affordable agenda agreement allocate alternative annual anticipate apparently applicant appointment appreciate approve approximately arrange assess assign assist attach attend audit authorize available budget candidate capacity colleague commute compensation complaint complete complimentary conduct conference confirm consecutive consider construction consult contract contribute convenient coordinate correspondence customer deadline decline dedicated delay deliver department deposit description designate determine distribute dividend eligible employee enclose enhance ensure equipment estimate evaluate exceed executive expand expense expertise facility feature feedback figure finance forecast former fund headquarters hire implement improve incentive increase indicate inform initial inquiry install instruction insurance inventory invoice issue itinerary launch lease load maintain maintenance manufacture merchandise merger negotiate notify objective obtain operate opportunity order organize outstanding overtime participant payment payroll pending performance permit personnel position postpone potential prefer premises prepare present previous priority procedure proceed productive profit promote proposal provide purchase qualify quarter quote receipt recently recommend recruit reduce refund register regulation reimburse reject relocate reminder renovate rent replace report representative request require reservation resign resolve respond responsible resume retail retire revenue review revise salary schedule shipment shortage submit subscription supervisor supplier supply survey temporary transfer upcoming update urgent vacancy vendor venue warehouse warranty workshop
`.trim().split(/\s+/));
const PARTICLES = new Set(['up', 'down', 'in', 'out', 'off', 'on', 'over', 'away', 'back', 'through', 'around', 'across', 'into', 'after', 'for', 'about', 'along', 'apart', 'aside', 'forward', 'together']);
const COMMON_VERBS = new Set(['get', 'got', 'gets', 'getting', 'take', 'took', 'taken', 'takes', 'taking', 'put', 'puts', 'putting', 'come', 'came', 'comes', 'coming', 'go', 'went', 'goes', 'going', 'gone', 'look', 'looked', 'looks', 'looking', 'turn', 'turned', 'turns', 'turning', 'bring', 'brought', 'brings', 'set', 'sets', 'setting', 'give', 'gave', 'given', 'gives', 'make', 'made', 'makes', 'run', 'ran', 'runs', 'running', 'carry', 'carried', 'figure', 'figured', 'find', 'found', 'pick', 'picked', 'work', 'worked', 'call', 'called', 'hand', 'handed', 'show', 'showed', 'shown', 'fill', 'filled', 'sign', 'signed', 'drop', 'dropped', 'break', 'broke', 'broken', 'hold', 'held', 'keep', 'kept', 'move', 'moved', 'cut', 'pass', 'passed', 'pull', 'pulled', 'push', 'pushed', 'throw', 'threw', 'thrown', 'back', 'backed', 'check', 'checked', 'sort', 'sorted', 'point', 'pointed', 'catch', 'caught', 'deal', 'dealt', 'end', 'ended', 'hang', 'figure', 'wrap', 'wrapped', 'lay', 'laid', 'log', 'logged', 'shut', 'slow', 'calm', 'cheer', 'clean', 'clear', 'fall', 'fell', 'grow', 'grew', 'stand', 'stood', 'sit', 'sat', 'wake', 'woke', 'try', 'tried', 'think', 'thought', 'reach', 'reached', 'speak', 'spoke']);

// candidates in one cue. vocab: [{ headword, isPhrase }] of the same language. unit: 'word' | 'phrase'
export function candidates(cueText, vocab, unit = 'phrase', lang = 'en') {
  const toks = tokenize(cueText, lang);
  const words = toks.map((t) => norm(t.w));
  const out = [];
  const taken = new Set();
  const add = (s, e, why) => { for (let i = s; i <= e; i++) if (taken.has(i)) return; for (let i = s; i <= e; i++) taken.add(i); out.push({ s, e, text: toks.slice(s, e + 1).map((t) => t.w).join(isZh(lang) ? '' : ' '), why }); };
  // 1) registered phrases / words (longest first)
  const heads = vocab.map((v) => ({ v, parts: isZh(lang) ? [...v.headword] : norm(v.headword).split(/\s+/) })).filter((x) => x.parts.length && (unit === 'phrase' ? true : x.parts.length === 1)).sort((a, b) => b.parts.length - a.parts.length);
  for (const { v, parts } of heads) {
    if (parts.some((p) => /[~〜…]/.test(p))) continue;
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, k) => words[i + k] === p || (k === 0 && words[i + k].replace(/(ed|s|ing)$/, '') === p.replace(/e$/, '')))) add(i, i + parts.length - 1, '単語帳の語');
    }
  }
  if (lang === 'en') {
    // 2) verb + particle (phrasal verb pattern), also verb + object pronoun + particle
    if (unit === 'phrase') for (let i = 0; i < words.length - 1; i++) {
      if (!COMMON_VERBS.has(words[i])) continue;
      if (PARTICLES.has(words[i + 1])) add(i, i + 1, '句動詞');
      else if (i + 2 < words.length && /^(it|them|him|her|me|us|you|this|that)$/.test(words[i + 1]) && PARTICLES.has(words[i + 2])) add(i, i + 2, '句動詞');
    }
    // 3) TOEIC-type words (also simple inflections)
    words.forEach((w, i) => { const base = [w, w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/ed$/, ''), w.replace(/d$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e'), w.replace(/ied$/, 'y')]; if (base.some((b) => TOEIC_WORDS.has(b))) add(i, i, 'TOEIC頻出'); });
  }
  return out.sort((a, b) => a.s - b.s);
}

// HTML of a subtitle with holes. revealed: Set of hole indexes shown. editing: tokens are tappable to toggle holes.
export function clozeHTML(text, holes = [], { lang = 'en', revealed = new Set(), editing = false, cueId = '' } = {}) {
  const toks = tokenize(text, lang);
  const sep = isZh(lang) ? '' : ' ';
  let html = '', i = 0;
  while (i < toks.length) {
    const hi = holes.findIndex((h) => h.s === i);
    if (hi >= 0 && !editing) {
      const h = holes[hi];
      const shown = revealed.has(hi);
      const first = toks[h.s], last = toks[h.e];
      html += `${esc(first.pre)}<button class="hole ${shown ? 'shown' : ''} ${h.last === 'ng' ? 'wasng' : ''}" data-cue="${cueId}" data-hole="${hi}">${shown ? esc(h.text) : '_____'}</button>${esc(last.post)}${sep}`;
      i = h.e + 1; continue;
    }
    const t = toks[i];
    const inHole = holes.some((h) => i >= h.s && i <= h.e);
    html += editing && t.w ? `${esc(t.pre)}<span class="ctok ${inHole ? 'on' : ''}" data-cue="${cueId}" data-t="${i}">${esc(t.w)}</span>${esc(t.post)}${sep}` : `${esc(t.pre)}${esc(t.w)}${esc(t.post)}${sep}`;
    i++;
  }
  return html.trim();
}

// toggle token i of a cue in edit mode. Adjacent tokens join one hole (phrase unit) when unit === 'phrase'.
export function toggleToken(cue, i, unit = 'phrase', lang = 'en') {
  const toks = tokenize(cue.en, lang);
  const holes = (cue.holes || []).map((h) => ({ ...h }));
  const at = holes.findIndex((h) => i >= h.s && i <= h.e);
  const textOf = (s, e) => toks.slice(s, e + 1).map((t) => t.w).join(isZh(lang) ? '' : ' ');
  if (at >= 0) {   // remove this token from its hole (split if in the middle)
    const h = holes.splice(at, 1)[0];
    if (h.s < i) holes.push({ ...h, e: i - 1, text: textOf(h.s, i - 1), auto: false });
    if (i < h.e) holes.push({ ...h, s: i + 1, text: textOf(i + 1, h.e), auto: false });
  } else {
    let s = i, e = i;
    if (unit === 'phrase') {
      const left = holes.findIndex((h) => h.e === i - 1), right = holes.findIndex((h) => h.s === i + 1);
      if (left >= 0) s = holes[left].s; if (right >= 0) e = holes[right].e;
      for (const k of [left, right].filter((x) => x >= 0).sort((a, b) => b - a)) holes.splice(k, 1);
    }
    holes.push({ s, e, text: textOf(s, e), auto: false });
  }
  cue.holes = holes.filter((h) => h.text).sort((a, b) => a.s - b.s);
  return cue.holes;
}
