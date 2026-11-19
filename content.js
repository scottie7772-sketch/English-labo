// Static content packs (JSON files in /content). Code and content are separate; packs are AI-made = 未検証.
import { importPackWords } from './words.js';

const cache = {};
export async function loadPack(name) {
  if (!cache[name]) cache[name] = fetch(`./content-${name}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).catch((e) => { delete cache[name]; throw e; });
  return cache[name];
}
// words from packs are registered once (duplicates skipped). Safe to call at every start.
export async function seedContent() {
  let n = 0;
  for (const [file, key] of [['en-pack-v1', 'pack:en-v1'], ['es-v1', 'pack:es-v1'], ['zh-v1', 'pack:zh-v1']]) {
    try { n += await importPackWords(`./content-${file}.json`, key); } catch { /* offline first run: try next time */ }
  }
  const { seedCourse, COURSE_LANGS } = await import('./course.js');
  for (const l of COURSE_LANGS) { try { n += await seedCourse(l); } catch { /* next time */ } }
  return n;
}
// puzzles / visual items of the English pack, with stable ids
export async function puzzles() { const p = await loadPack('en-pack-v1'); return (p.puzzles || []).map((x, i) => ({ id: x.id || `pz_${i + 1}`, lang: 'en', ...x })); }
export async function visuals() { const p = await loadPack('en-pack-v1'); return (p.visual || []).map((x, i) => ({ id: x.id || `vz_${i + 1}`, lang: 'en', ...x })); }
export async function swipeSets() { return (await loadPack('en-pack-v1')).swipeSets; }
export async function speakingItems(lang) {
  const { coursePhrases } = await import('./course.js');
  return [...(await loadPack('speaking-v1')).items.filter((x) => x.lang === lang), ...(await coursePhrases(lang))];
}
export async function listeningItems(lang) { return (await loadPack('listening-v1')).items.filter((x) => x.lang === lang); }
