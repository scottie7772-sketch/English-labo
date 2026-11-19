// Learning languages: definitions, current language, answer normalization per language.
// Words without `lang` are English (existing data is unchanged).
import { getSetting, setSetting } from './db.js';

export const LANGS = {
  en: { code: 'en', name: '英語', short: 'EN', ch: '英', speech: 'en-US', speechAlt: ['en-GB', 'en'], placeholder: '英語' },
  es: { code: 'es', name: 'スペイン語', short: 'ES', ch: '西', speech: 'es-MX', speechAlt: ['es-US', 'es-ES', 'es'], placeholder: 'スペイン語' },
  'zh-CN': { code: 'zh-CN', name: '中国語', short: '中', ch: '中', speech: 'zh-CN', speechAlt: ['cmn-CN', 'zh-Hans', 'zh'], placeholder: '中国語（漢字またはピンイン）', reading: 'ピンイン' },
  'zh-TW': { code: 'zh-TW', name: '台湾華語', short: '華', ch: '華', speech: 'zh-TW', speechAlt: ['zh-HK', 'zh-CN', 'zh'], placeholder: '華語（漢字またはピンイン）', reading: 'ピンイン' },
};
export const LANG_CODES = Object.keys(LANGS);

let cur = 'en';
let enabled = ['en', 'es', 'zh-TW', 'zh-CN'];
export const isZh = (code) => code === 'zh-TW' || code === 'zh-CN';
export const htmlLang = (code) => (code === 'zh-TW' ? 'zh-Hant-TW' : code === 'zh-CN' ? 'zh-Hans-CN' : code);
export const langAttr = (code) => (isZh(code) ? `lang="${htmlLang(code)}"` : '');
const listeners = new Set();
export const curLang = () => cur;
export const L = (code = cur) => LANGS[code] || LANGS.en;
export const langOf = (w) => (w && w.lang) || 'en';
export const enabledLangs = () => enabled;
export async function loadLang() {
  enabled = (await getSetting('enabledLangs', ['en', 'es', 'zh-TW', 'zh-CN'])).filter((c) => LANGS[c]);
  // the 中国語 (Mainland) mode was added in v1.2: turn it on once for people who saved their language list before
  if (!(await getSetting('langs:zhCN', false))) { if (!enabled.includes('zh-CN')) enabled.push('zh-CN'); await setSetting('enabledLangs', enabled); await setSetting('langs:zhCN', true); }
  if (!enabled.includes('en')) enabled.unshift('en');
  cur = await getSetting('currentLang', 'en');
  if (!enabled.includes(cur)) cur = 'en';
  document.body.dataset.lang = cur;
}
export async function setLang(code) {
  if (!LANGS[code]) return;
  cur = code; document.body.dataset.lang = code;
  await setSetting('currentLang', code);
  listeners.forEach((f) => f(code));
}
export async function setEnabled(list) {
  enabled = ['en', ...list.filter((c) => c !== 'en' && LANGS[c])];
  await setSetting('enabledLangs', enabled);
  if (!enabled.includes(cur)) await setLang('en');
}
export const onLangChange = (f) => listeners.add(f);

export function langSwitchHTML() {
  if (enabled.length < 2) return '';
  return `<div class="langsw" role="group" aria-label="学習する言語">${enabled.map((c) => `<button data-langsw="${c}" class="${c === cur ? 'on' : ''}" lang="${htmlLang(c)}">${LANGS[c].short}</button>`).join('')}</div>`;
}

// ---------- Spanish ----------
export const stripAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');

// ---------- Mandarin (pinyin) ----------
const TONE_MARKS = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' };
const MARK_TO = {};
for (const [v, marks] of Object.entries(TONE_MARKS)) [...marks].forEach((m, i) => (MARK_TO[m] = [v, i + 1]));
// "qǐfēi" / "qi3fei1" / "qi3 fei1" -> { base: "qifei", tones: "31" }  (neutral/none = 5, unknown = 0)
export function pinyinKey(s) {
  let t = String(s).toLowerCase().replace(/v/g, 'ü').replace(/u:/g, 'ü').replace(/[\s'’\-·]/g, '');
  const sylls = [];
  // split by tone numbers if present
  if (/[1-5]/.test(t)) {
    for (const m of t.matchAll(/([a-zü]+)([1-5]?)/g)) sylls.push({ s: m[1], tone: +m[2] || 0 });
    const base = sylls.map((x) => x.s).join('').replace(/ü/g, 'u');
    return { base, tones: sylls.map((x) => x.tone).join(''), marked: true };
  }
  let base = '', tones = '';
  for (const ch of t) {
    if (MARK_TO[ch]) { base += MARK_TO[ch][0]; tones += MARK_TO[ch][1]; } else base += ch;
  }
  return { base: base.replace(/ü/g, 'u').replace(/[^a-z]/g, ''), tones, marked: !!tones };
}
const HAN = /[\u3400-\u9fff]/;
export const hasHan = (s) => HAN.test(String(s));
// tone-number pinyin -> tone marks ("hao3" -> "hǎo")
export function numToMarks(s) {
  return String(s).replace(/([a-zü:v]+)([1-5])/gi, (_, syl, n) => {
    syl = syl.replace(/v|u:/gi, 'ü'); n = +n; if (n === 5) return syl;
    const lower = syl.toLowerCase();
    let idx = lower.search(/[ae]/); if (idx < 0) idx = lower.indexOf('ou'); if (idx < 0) { for (let i = lower.length - 1; i >= 0; i--) if ('aeiouü'.includes(lower[i])) { idx = i; break; } }
    if (idx < 0) return syl;
    const v = lower[idx]; return syl.slice(0, idx) + (TONE_MARKS[v]?.[n - 1] || v) + syl.slice(idx + 1);
  });
}

// ---------- generic comparison per language ----------
// returns 'exact' | 'accent' | 'tone' | null (not equal)
export function compareAnswer(input, answer, lang, { caseSensitive = false } = {}) {
  const clean = (x) => { let t = String(x || '').replace(/[‘’ʼ]/g, "'").replace(/[¿¡]/g, '').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!?。！？]+$/, ''); return caseSensitive ? t : t.toLowerCase(); };
  const a = clean(input), b = clean(answer);
  if (!a) return null;
  if (a === b || a.replace(/[-\s]+/g, ' ') === b.replace(/[-\s]+/g, ' ')) return 'exact';
  if (lang === 'es') { if (stripAccents(a) === stripAccents(b)) return 'accent'; return null; }
  if (isZh(lang)) {
    const strip = (x) => x.replace(/[，。、！？\s]/g, '');
    if (hasHan(a) || hasHan(b)) return hasHan(a) && hasHan(b) && strip(a) === strip(b) ? 'exact' : null;
    const ka = pinyinKey(a), kb = pinyinKey(b);
    if (!ka.base || ka.base !== kb.base) return null;
    if (ka.tones && ka.tones.replace(/5/g, '') === kb.tones.replace(/5/g, '')) return 'exact';
    return 'tone';
  }
  return null;
}
