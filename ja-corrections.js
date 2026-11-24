// 1.19.30: hand-corrected English–Japanese pairs as a small JSON (no audio, no timings).
// The same file can be read back into Video Lab / Studio, or merged into the original MA English–Japanese JSON.
import { normalizeScriptJa } from './video-script-ja.js';

export const CORRECTIONS_FORMAT = 'englabo-ja-corrections';
export const isCorrections = data => data?.format === CORRECTIONS_FORMAT;
const key = text => normalizeScriptJa(String(text || ''));

// rows: the material in reading order [{ id, en, itemId? }]
// units: [{ ids: [row ids, consecutive], ja, removed }]
export function buildCorrections({ source, materialId = null, studioSetId = null, title = '', appVersion = '', rows, units }) {
  const index = new Map(rows.map((row, i) => [row.id, i]));
  const keys = rows.map(row => key(row.en));
  const starts = new Map();
  keys.forEach((k, i) => { if (!starts.has(k)) starts.set(k, []); starts.get(k).push(i); });
  const items = units.map(unit => {
    const at = unit.ids.map(id => index.get(id)).filter(i => i != null).sort((a, b) => a - b);
    if (!at.length) return null;
    const first = at[0], last = at.at(-1), seq = at.map(i => keys[i]);
    const same = (starts.get(seq[0]) || []).filter(p => seq.every((k, j) => keys[p + j] === k));
    const item = {
      en: at.map(i => rows[i].en).join(' '),
      ...(at.length > 1 ? { enLines: at.map(i => rows[i].en) } : {}),
      ja: unit.removed ? '' : unit.ja,
      ...(unit.removed ? { removed: true } : {}),
      position: first + 1,
      occurrence: same.indexOf(first) + 1, occurrences: same.length,
      before: rows[first - 1]?.en ?? null, after: rows[last + 1]?.en ?? null,
    };
    if (source === 'lab') item.cueIds = at.map(i => rows[i].id);
    const itemIds = at.map(i => source === 'studio' ? rows[i].id : rows[i].itemId).filter(Boolean);
    if (itemIds.length === at.length) item.itemIds = itemIds;
    return item;
  }).filter(Boolean).sort((a, b) => a.position - b.position);
  return { format: CORRECTIONS_FORMAT, version: 1, source, materialId, studioSetId, title, appVersion,
    exportedAt: new Date().toISOString(), note: '手動で修正した英日対応のみ。音声・再生時刻は含みません。', items };
}

export function readCorrections(data) {
  if (!isCorrections(data) || data.version !== 1 || !Array.isArray(data.items)) throw new Error('修正内容のJSON（englabo-ja-corrections）ではありません');
  data.items.forEach((item, i) => {
    if (typeof item?.en !== 'string' || typeof item.ja !== 'string') throw new Error(`修正 ${i + 1}件目の英文・訳文を確認してください`);
  });
  return data;
}

// Find the rows of the current material that a correction belongs to.
// Identifiers first (same material), then the English with its neighbours and its occurrence number.
// target: { source: 'lab'|'studio', materialId, studioSetId, rows: [{ id, en, itemId? }] }
export function matchCorrections(data, target) {
  readCorrections(data);
  const rows = target.rows, index = new Map(rows.map((row, i) => [row.id, i]));
  const byItem = new Map(rows.filter(r => r.itemId).map((row, i) => [row.itemId, row.id]));
  const keys = rows.map(row => key(row.en));
  const matched = [], skipped = [], taken = new Set();
  for (const item of data.items) {
    const lines = item.enLines?.length ? item.enLines : [item.en];
    const seq = lines.map(key);
    const check = ids => ids.length === seq.length && ids.every((id, j) => index.has(id) && keys[index.get(id)] === seq[j]) &&
      ids.every((id, j) => !j || index.get(id) === index.get(ids[j - 1]) + 1);
    let ids = null, how = '';
    const sameMaterial = target.source === 'lab' ? data.materialId && data.materialId === target.materialId : data.studioSetId && data.studioSetId === target.studioSetId;
    if (sameMaterial && target.source === 'lab' && item.cueIds && check(item.cueIds)) { ids = item.cueIds; how = '字幕ID'; }
    else if (item.itemIds && (target.source === 'studio' || byItem.size)) {
      const mapped = target.source === 'studio' ? item.itemIds : item.itemIds.map(id => byItem.get(id));
      if (mapped.every(Boolean) && check(mapped)) { ids = mapped; how = 'スタジオの行ID'; }
    }
    if (!ids) {
      const found = [];
      for (let p = 0; p + seq.length <= rows.length; p++) if (seq.every((k, j) => keys[p + j] === k)) found.push(p);
      let pick = found;
      if (pick.length > 1) {
        const ctx = pick.filter(p => (item.before == null || key(rows[p - 1]?.en) === key(item.before)) &&
          (item.after == null || key(rows[p + seq.length]?.en) === key(item.after)));
        if (ctx.length) pick = ctx;
      }
      if (pick.length > 1 && item.occurrences === found.length && item.occurrence >= 1) pick = [found[item.occurrence - 1]];
      if (pick.length === 1) { ids = seq.map((_, j) => rows[pick[0] + j].id); how = found.length > 1 ? '英文と前後の文脈' : '英文'; }
      else { skipped.push({ item, reason: found.length ? `同じ英文が${found.length}か所あり特定できません` : '対応する英文がありません' }); continue; }
    }
    if (ids.some(id => taken.has(id))) { skipped.push({ item, reason: 'ほかの修正と同じ字幕です' }); continue; }
    ids.forEach(id => taken.add(id));
    matched.push({ item, ids, how });
  }
  return { matched, skipped };
}

// Merge corrections into the original MA English–Japanese JSON ({ chapter, items: [{ en, ja }] } or an array).
// Only items whose English equals the corrected English are changed; nothing else in the file is touched.
export function applyCorrectionsToMa(maData, data) {
  readCorrections(data);
  const out = structuredClone(maData);
  const list = Array.isArray(out) ? out : out?.items ?? out?.translations ?? out?.cues;
  if (!Array.isArray(list)) throw new Error('英日対応JSONの items が見つかりません');
  const enOf = row => { const en = row?.en ?? row?.english ?? row?.text; return Array.isArray(en) ? en.join(' ') : en || ''; };
  const keys = list.map(row => key(enOf(row)));
  const applied = [], skipped = [], used = new Set();
  for (const item of data.items) {
    const k = key(item.en);
    const found = keys.flatMap((x, i) => x === k ? [i] : []);
    let pick = found;
    if (pick.length > 1) {
      const ctx = pick.filter(i => (item.before == null || !keys[i - 1] || keys[i - 1] === key(item.before) || key(item.before).endsWith(keys[i - 1])) &&
        (item.after == null || !keys[i + 1] || keys[i + 1] === key(item.after) || key(item.after).startsWith(keys[i + 1])));
      if (ctx.length) pick = ctx;
    }
    if (pick.length > 1 && item.occurrences === found.length) pick = [found[item.occurrence - 1]];
    if (pick.length !== 1 || used.has(pick[0])) {
      skipped.push({ item, reason: !found.length ? '同じ英文の項目がありません（英文の区切りが違う可能性）' : '同じ英文が複数あり特定できません' });
      continue;
    }
    const row = list[pick[0]];
    const field = ['ja', 'japanese', 'translation'].find(f => typeof row[f] === 'string') || 'ja';
    used.add(pick[0]);
    if (row[field] !== item.ja) { applied.push({ index: pick[0], before: row[field] ?? '', after: item.ja }); row[field] = item.ja; }
  }
  return { data: out, applied, skipped };
}
