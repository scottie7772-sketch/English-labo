// 金フレ型: フォルダの全体スクリプトの保存・教材ごとの範囲特定・範囲だけの適用（保存まわり）。
// 範囲の計算そのものは studio-kinfure-range.js（純関数）。MA型・会話型の処理には触れない。
import { sdb, newBlock, commit } from './studio-db.js';
import { parseKinfureScript, locateRange, tagRowsToScript, rangeFromNumbers, kfKey } from './studio-kinfure-range.js';

const scriptKey = (folderId) => 'studio-folder-kf:' + folderId;

// 全体スクリプトは「フォルダに1つ」だけ保存する（教材ごとに複製しない）。
export async function saveKfScript(folderId, name, rows) {
  const lines = rows.map((r) => ({ text: String(r.text || ''), ...(r.ja ? { ja: r.ja } : {}), ...(r.rep ? { rep: r.rep } : {}), ...(r.kind ? { kind: r.kind } : {}) }))
    .filter((r) => r.text.trim());
  if (!lines.length) throw new Error('スクリプトの行がありません');
  const rec = { key: scriptKey(folderId), folderId, name, rows: lines, savedAt: Date.now() };
  await sdb.put('meta', rec);
  return rec;
}
const cache = new Map();
export async function loadKfScript(folderId) {
  const rec = await sdb.get('meta', scriptKey(folderId));
  if (!rec) return null;
  const hit = cache.get(folderId);
  if (hit?.savedAt === rec.savedAt) return hit.script;
  const script = parseKinfureScript(rec.rows);
  script.name = rec.name; script.savedAt = rec.savedAt; script.folderId = folderId;
  cache.set(folderId, { savedAt: rec.savedAt, script });
  return script;
}

const live = async (set) => {
  const all = await sdb.byIndex('blocks', 'setId', set.id);
  const byId = new Map(all.map((b) => [b.id, b]));
  return set.order.map((id) => byId.get(id)).filter((b) => b && !b.deleted);
};
export const isScriptRow = (b) => !b.asr && b.text?.trim() && (b.script || b.kf || b.lineage?.op === 'create' || b.aligned);

// 範囲特定に使う「文字起こしの並び」: 既存のASR結果を再利用する。照合済みの行はスクリプトの文を持つ強い証拠として足す。
export function cuesOf(blocks) {
  return blocks.filter((b) => b.segments?.length && b.text?.trim() && (b.asr || b.aligned))
    .map((b) => ({ text: b.text, start: b.segments[0].start, end: b.segments.at(-1).end, src: b.segments[0].sourceId }))
    .sort((a, b) => (a.src === b.src ? a.start - b.start : String(a.src).localeCompare(String(b.src))));
}
export async function cuesOfSet(set) { return cuesOf(await live(set)); }

// 教材のスクリプト行に、全体スクリプトの行番号を割り当てる（保存済みの kf タグを優先、無いものは文の一致から）。
export function tagsFor(blocks, script) {
  const rows = blocks.filter(isScriptRow);
  const mine = (b) => b.kf?.i != null && (b.kf.at == null || b.kf.at === script.savedAt);
  const untagged = rows.filter((b) => !mine(b));
  const guessed = tagRowsToScript(untagged, script), map = new Map();
  untagged.forEach((b, k) => map.set(b.id, guessed[k]));
  for (const b of rows) if (mine(b)) map.set(b.id, b.kf.i);
  return map;
}

// 範囲を適用する計画（保存はしない）。範囲の外の「手を付けていない・音声のない」スクリプト行だけを外し、
// 範囲内でまだ教材にない行を加える。音声が割り当て済み・手動修正・日本語訳つき（作成後に変わったもの）などは残す。
export function planApply(blocks, script, range) {
  const tags = tagsFor(blocks, script);
  const inRange = (i) => i >= range.startLine && i <= range.endLine;
  const remove = [], keptOutside = [];
  const present = new Set();
  for (const b of blocks) {
    if (!isScriptRow(b)) continue;
    const i = tags.get(b.id);
    if (i == null) continue;                                  // 全体スクリプトに対応しない行（手で足した行など）は触らない
    if (inRange(i)) { present.add(i); continue; }
    const untouched = !b.segments?.length && !b.aligned && b.sync !== 'manual' && !b.holes?.length && b.lineage?.op === 'create' && !b.userDel;
    (untouched ? remove : keptOutside).push(b);
  }
  const add = [];
  for (let i = range.startLine; i <= range.endLine; i++) if (!present.has(i)) add.push(i);
  return { remove, add, keptOutside, tags, present };
}

// 追加する行をどこに差し込むか: 直前の（全体スクリプト上で前の）既存行の後ろ。無ければ最初のスクリプト行の前。
export function newOrder(order, blocksById, tags, removeIds, addRows) {
  const kept = order.filter((id) => !removeIds.has(id));
  const anchors = kept.map((id) => ({ id, i: tags.get(id) })).filter((x) => x.i != null).sort((a, b) => a.i - b.i);
  const result = kept.slice();
  const placed = new Map();   // 全体スクリプトの行番号 → 追加した行のid
  const after = (i) => {
    let prev = null;
    for (const a of anchors) { if (a.i < i) prev = a.id; else break; }
    for (let k = i - 1; k >= 0; k--) if (placed.has(k)) { if (!prev || result.indexOf(placed.get(k)) > result.indexOf(prev)) prev = placed.get(k); break; }
    return prev;
  };
  for (const row of addRows) {
    const prev = after(row.kf.i);
    let at;
    if (prev) at = result.indexOf(prev) + 1;
    else { const first = result.findIndex((id) => tags.has(id)); at = first < 0 ? result.length : first; }
    result.splice(at, 0, row.id);
    placed.set(row.kf.i, row.id);
  }
  return result;
}

export async function applyKfRange(set, script, range, { manual = false, confidence = null } = {}) {
  const blocks = await live(set);
  const plan = planApply(blocks, script, range);
  const addRows = plan.add.map((i) => {
    const l = script.lines[i];
    return newBlock(set.id, { segments: [], text: l.text, ja: l.ja || '', script: true, kf: { i, at: script.savedAt }, cueRefs: { en: [], ja: [] }, sync: 'auto',
      ...(l.rep > 1 ? { rep: l.rep } : {}), ...(l.kind ? { kind: l.kind } : {}) });
  });
  const removeIds = new Set(plan.remove.map((b) => b.id));
  const order = newOrder(set.order, null, plan.tags, removeIds, addRows);
  const changes = { blocks: [...addRows, ...plan.remove.map((b) => ({ ...b, deleted: true }))], order };
  if (changes.blocks.length) await commit(set, '金フレ範囲を適用', changes, {});
  const fresh = await sdb.get('sets', set.id);
  await sdb.put('sets', { ...fresh, kfRange: { folderId: script.folderId, scriptAt: script.savedAt, startN: range.startN, endN: range.endN,
    startLine: range.startLine, endLine: range.endLine, manual, confidence, at: Date.now() } });
  Object.assign(set, { kfRange: { folderId: script.folderId, startN: range.startN, endN: range.endN, startLine: range.startLine, endLine: range.endLine, manual, confidence } });
  return { removed: plan.remove.length, added: addRows.length, keptOutside: plan.keptOutside.length };
}

export { locateRange, rangeFromNumbers, kfKey, parseKinfureScript };
