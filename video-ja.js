import { db, uid } from './db.js';

const linkId = (materialId, cueId) => JSON.stringify([materialId, cueId]);
const digest = cue => {
  // A content check only. Keeping it separate from seek times allows boundary adjustments.
  const value = JSON.stringify([cue.en, cue.translationRevision || '', cue.segments?.length || 1,
    cue.sourceSegments?.map(g => g.media) || []]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b ^ value.charCodeAt(i), 31);
  }
  return a.toString(36) + ':' + b.toString(36);
};

export const readVideoJa = materialId => db.byIndex('videoJa', 'materialId', materialId);
export function videoJaView(cues, records) {
  const cuesById = new Map(cues.map(c => [c.id, c]));
  const links = new Map(), texts = new Map(), groups = new Map(), review = [];
  for (const row of records) {
    if (row.kind) continue;   // 1.19.30: change history rows live beside the translations
    if (row.cueId) links.set(row.cueId, row);
    else if (row.textId) groups.set(row.id, row);
    else texts.set(row.id, row.ja);
  }
  const matched = new Set();
  for (const link of links.values()) {
    const cue = cuesById.get(link.cueId);
    if (cue && link.revision === digest(cue)) matched.add(link.cueId);
    else if (link.refs.length) review.push(link.cueId);
  }
  for (const cue of cues) if (cue.legacyJaReview && !links.has(cue.id)) review.push(cue.id);
  const suspect = new Set(review.flatMap(id => links.get(id)?.refs || []));
  const textFor = ref => texts.get(groups.get(ref)?.textId);
  return {
    review,
    get(cue) {
      if (!cue) return '';
      const link = links.get(cue.id);
      if (!link) return cue.legacyJaReview ? '' : (cue.ja || '');
      return matched.has(cue.id) ? link.refs.filter(id => !suspect.has(id)).map(textFor).filter(Boolean).join('\n') : '';
    },
    needsReview(cue) {
      return Boolean(cue.legacyJaReview && !links.has(cue.id)) ||
        Boolean(links.get(cue.id)?.refs.some(id => suspect.has(id)));
    },
    draft(cue) {
      const link = links.get(cue.id);
      return link ? link.refs.map(textFor).filter(Boolean).join('\n') : (cue.ja || '');
    },
  };
}

export function parseJaPatch(text, materialId) {
  const data = JSON.parse(text);
  if (!data || data.materialId !== materialId) throw new Error('教材IDが一致しません。この教材から書き出した字幕IDを使ってください');
  if (!Array.isArray(data.translations) || Object.keys(data).some(k => !['materialId', 'translations'].includes(k))) {
    throw new Error('materialId と translations のJSONを指定してください');
  }
  const patch = new Map();
  for (const row of data.translations) {
    if (!row || typeof row.ja !== 'string' || !Array.isArray(row.cueIds) || !row.cueIds.length ||
        row.cueIds.some(id => typeof id !== 'string' || !id.trim()) ||
        Object.keys(row).some(k => !['cueIds', 'ja'].includes(k))) {
      throw new Error('訳文ごとに cueIds と ja を指定してください');
    }
    const cueIds = [...new Set(row.cueIds)].sort();
    const value = { ja: row.ja.trim(), cueIds };
    for (const id of cueIds) {
      const values = patch.get(id) || [];
      if (value.ja) values.push(value);
      patch.set(id, values);
    }
  }
  return patch;
}

export function planJaWrites(materialId, cues, records, patch, expected, { clear = false, fromStudio = false, replaceStudio = false, atomic = false,
  protectManual = false, missingOnly = false, linkFlags = null } = {}) {
  records = records.filter(r => !r.kind);
  const current = new Map(cues.map(c => [c.id, c]));
  const links = new Map(records.filter(r => r.cueId).map(r => [r.cueId, r]));
  const texts = new Map(records.filter(r => typeof r.ja === 'string').map(r => [r.ja, r]));
  const groupKey = (textId, cueIds) => JSON.stringify([textId, cueIds]);
  const groups = new Map(records.filter(r => r.textId).map(r => [groupKey(r.textId, r.cueIds), r]));
  const used = new Set(), puts = new Map(), deletes = new Set();
  const needsReview = [], skipped = [];
  if (clear) {
    patch = new Map([...links.keys()].map(id => [id, []]));
    for (const cue of cues) if (cue.ja) patch.set(cue.id, []);
  }
  if (replaceStudio) {
    patch = new Map(patch);
    for (const [id, link] of links) if (link.studio && !patch.has(id) && current.has(id)) patch.set(id, []);
  }
  const eligible = new Set();
  for (const [id, stamp] of expected) if (current.has(id) && stamp === digest(current.get(id))) eligible.add(id);
  if (atomic && [...patch.keys()].some(id => !eligible.has(id))) return { puts, deletes, needsReview: [...patch.keys()] };
  const groupCache = new WeakMap();
  for (const [cueId, values] of patch) {
    const cue = current.get(cueId), old = links.get(cueId);
    if (!cue || (!clear && !eligible.has(cueId))) {
      if (clear && old) { deletes.add(old.id); links.delete(cueId); }
      else needsReview.push(cueId);
      continue;
    }
    if (fromStudio && (cue.jaEdited || (old && !old.studio))) continue;
    // 1.19.30: hand-corrected translations are never replaced by matching or re-import
    if (protectManual && (cue.jaEdited || old?.manual)) { skipped.push(cueId); continue; }
    if (missingOnly && (old ? old.refs.length || old.manual : cue.ja)) { skipped.push(cueId); continue; }
    const entries = values.map(value => typeof value === 'string' ? { ja: value, cueIds: [cueId] } : value);
    if (!clear && entries.some(entry => {
      if (!groupCache.has(entry)) groupCache.set(entry, { valid: entry.cueIds.every(id => eligible.has(id)) });
      return !groupCache.get(entry).valid;
    })) {
      needsReview.push(cueId);
      continue;
    }
    const refs = [...new Set(entries.map(entry => {
      const memo = groupCache.get(entry);
      if (memo?.id) return memo.id;
      const { ja, cueIds } = entry;
      if (!texts.has(ja)) {
        const row = { id: uid('ja_'), materialId, ja };
        texts.set(ja, row); puts.set(row.id, row);
      }
      const textId = texts.get(ja).id, key = groupKey(textId, cueIds);
      if (!groups.has(key)) {
        const row = { id: uid('jag_'), materialId, textId, cueIds };
        groups.set(key, row); puts.set(row.id, row);
      }
      const id = groups.get(key).id;
      if (memo) memo.id = id;
      return id;
    }))];
    const id = linkId(materialId, cueId), revision = digest(cue);
    const flags = linkFlags ? linkFlags(cueId, old) : fromStudio ? { studio: true } : {};
    // A hand removal is kept as an empty link, so a later Studio transfer does not bring the translation back.
    const keepRemoval = !fromStudio && (old?.studio || old?.refs.length === 0 || flags.manual);
    if (!refs.length && !keepRemoval && (fromStudio || !cue.ja)) {
      if (old) deletes.add(old.id);
      links.delete(cueId);
      continue;
    }
    const row = { id, materialId, cueId, revision, refs, ...flags };
    const flagKey = link => JSON.stringify([Boolean(link.studio), Boolean(link.manual), link.base ?? null]);
    if (!old || old.revision !== revision || flagKey(old) !== flagKey(row) || JSON.stringify(old.refs) !== JSON.stringify(refs)) puts.set(id, row);
    links.set(cueId, row);
  }
  for (const link of links.values()) for (const id of link.refs) used.add(id);
  const textUsed = new Set();
  for (const row of groups.values()) {
    if (used.has(row.id)) textUsed.add(row.textId);
    else deletes.add(row.id);
  }
  for (const row of texts.values()) if (!textUsed.has(row.id)) deletes.add(row.id);
  return { puts, deletes, needsReview, skipped };
}

export const compareVideoCues = (a, b) => a.start - b.start || (a.studioOrder ?? Infinity) - (b.studioOrder ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const videoJaSource = (materialId, cues) => ({
  materialId,
  // Preserve the visible position even where a legacy Japanese-only row is skipped.
  cues: cues.flatMap(({ id, en }, index) => en?.trim() ? [{ cueId: id, en, order: index + 1 }] : []),
});

export const cueStamps = cues => new Map(cues.map(c => [c.id, digest(c)]));

export async function saveVideoJa(materialId, patch, expected, options = {}) {
  return db.tx(['videos', 'cues', 'videoJa'], 'readwrite', tx => new Promise((resolve, reject) => {
    const store = tx.objectStore('videoJa');
    const video = tx.objectStore('videos').get(materialId);
    const cues = tx.objectStore('cues').index('videoId').getAll(materialId);
    const records = store.index('materialId').getAll(materialId);
    let pending = 3;
    for (const req of [video, cues, records]) {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        if (--pending) return;
        if (!video.result) { reject(new Error('教材が見つかりません')); return; }
        try {
          const result = planJaWrites(materialId, cues.result, records.result, patch, expected, options);
          for (const row of result.puts.values()) store.put(row);
          for (const id of result.deletes) store.delete(id);
          resolve(result);
        } catch (error) { reject(error); }
      };
    }
  }));
}

export function removeVideoJaInTx(tx, materialId) {
  const cursor = tx.objectStore('videoJa').index('materialId').openCursor(materialId);
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (row) { row.delete(); row.continue(); }
  };
}

export function studioJaPatch(cues, spans) {
  const ids = new Map(cues.filter(cue => cue.itemId).map(cue => [cue.itemId, cue.id]));
  const patch = new Map();
  for (const span of spans || []) {
    if (!Array.isArray(span?.ids) || !Array.isArray(span.texts)) continue;
    const cueIds = [...new Set(span.ids.map(id => ids.get(id)).filter(Boolean))].sort();
    const entries = span.texts.filter(ja => typeof ja === 'string' && ja.trim()).map(ja => ({ ja, cueIds }));
    if (entries.length) for (const id of cueIds) patch.set(id, entries);
  }
  return patch;
}

// ================= 1.19.30: position editor, save history, manual protection =================
const HISTORY_MAX = 40;   // per material; text only (no audio, no timings)
function recordMaps(records) {
  const links = new Map(), groups = new Map(), texts = new Map();
  for (const row of records) {
    if (row.kind) continue;
    if (row.cueId) links.set(row.cueId, row);
    else if (row.textId) groups.set(row.id, row);
    else if (typeof row.ja === 'string') texts.set(row.id, row);
  }
  return { links, groups, texts };
}
// The translations a subtitle currently shows, as patch entries [{ ja, cueIds }] (cueIds sorted, entries in stored order).
function entriesOf(maps, cue) {
  const link = maps.links.get(cue.id);
  if (!link) return cue.ja ? [{ ja: cue.ja, cueIds: [cue.id] }] : [];
  return link.refs.flatMap(ref => {
    const group = maps.groups.get(ref), ja = group && maps.texts.get(group.textId)?.ja;
    return ja ? [{ ja, cueIds: group.cueIds.slice() }] : [];
  });
}
const entriesKey = entries => JSON.stringify(entries.map(e => [e.ja, e.cueIds]));
const entriesText = entries => entries.map(e => e.ja).join('\n');

// Rows for the shared position editor (ja-position.js). Shared translations (one text for several subtitles) are
// kept as groups, never flattened into duplicated copies.
export function labJaRows(cues, records) {
  const maps = recordMaps(records);
  const groups = new Map(), keyOf = new Map();
  const rows = cues.map(cue => {
    const entries = entriesOf(maps, cue), own = [], keys = [];
    for (const entry of entries) {
      if (entry.cueIds.length > 1) {
        // a plain key: it is also written into HTML attributes by the editor
        const id = JSON.stringify([entry.cueIds, entry.ja]);
        if (!keyOf.has(id)) { keyOf.set(id, 'g' + (keyOf.size + 1)); groups.set(keyOf.get(id), { text: entry.ja, members: entry.cueIds.slice(), cueIds: entry.cueIds.slice() }); }
        keys.push(keyOf.get(id));
      } else own.push(entry.ja);
    }
    return { id: cue.id, en: cue.en || '', own: own.join('\n'), groups: keys, entries };
  });
  return { rows, groups };
}
// Editor result -> per-subtitle entries for saveJaEdit.
export function labJaChanges(rows, groups, changes) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return changes.map(change => ({
    cueId: change.id,
    before: byId.get(change.id).entries,
    after: [...change.after.groups.map(key => ({ ja: groups.get(key).text, cueIds: groups.get(key).cueIds.slice() })),
      ...(change.after.own ? [{ ja: change.after.own, cueIds: [change.id] }] : [])],
  }));
}

// Reads the material inside the transaction and runs fn synchronously in the last success event, so the writes
// it queues belong to the same transaction on every browser (no await between read and write).
function withMaterial(tx, materialId, fn) {
  return new Promise((resolve, reject) => {
    const video = tx.objectStore('videos').get(materialId);
    const cues = tx.objectStore('cues').index('videoId').getAll(materialId);
    const records = tx.objectStore('videoJa').index('materialId').getAll(materialId);
    let pending = 3;
    for (const req of [video, cues, records]) {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        if (--pending) return;
        try { resolve(fn({ video: video.result, cues: cues.result, records: records.result })); } catch (error) { reject(error); }
      };
    }
  });
}
const STALE = '編集を始めた後に字幕または訳が変更されました。保存を中止しました（何も変更していません）';
// Write a set of per-subtitle translation changes as ONE operation: everything or nothing, plus one history entry.
// changes: [{ cueId, before: entries, after: entries }]  expected: Map cueId -> stamp taken when editing started.
// mode 'manual' (editor, hand correction) | 'studio' (accept the Studio text) | 'base' (only record the agreed text)
export function applyJaChanges(materialId, changes, expected, { label = '訳の位置調整', mode = 'manual', history = true, base = null } = {}) {
  return db.tx(['videos', 'cues', 'videoJa'], 'readwrite', tx => withMaterial(tx, materialId, ({ video, cues, records }) => {
    if (!video) throw new Error('教材が見つかりません');
    const maps = recordMaps(records), byId = new Map(cues.map(c => [c.id, c]));
    const ids = new Set(changes.flatMap(c => [c.cueId, ...c.after.flatMap(e => e.cueIds), ...c.before.flatMap(e => e.cueIds)]));
    for (const id of ids) {
      const cue = byId.get(id);
      if (!cue || !expected.has(id) || expected.get(id) !== digest(cue)) throw new Error(STALE);
    }
    for (const change of changes) if (entriesKey(entriesOf(maps, byId.get(change.cueId))) !== entriesKey(change.before)) throw new Error(STALE);
    const patch = new Map(changes.map(c => [c.cueId, c.after.map(e => ({ ja: e.ja, cueIds: e.cueIds.slice().sort() }))]));
    const oldText = link => link ? entriesText(entriesOf(maps, byId.get(link.cueId) || { id: link.cueId })) : '';
    const linkFlags = (cueId, old) => {
      const prior = old?.base ?? (old?.studio ? oldText(old) : undefined);
      const agreed = base?.get(cueId);
      if (mode === 'studio') return { studio: true, base: agreed ?? entriesText(patch.get(cueId)) };
      const keep = agreed ?? prior;
      return { ...(mode === 'manual' || old?.manual ? { manual: true } : {}), ...(old?.studio && mode === 'base' ? { studio: true } : {}), ...(keep != null ? { base: keep } : {}) };
    };
    const plan = planJaWrites(materialId, cues, records, patch, expected, { atomic: true, linkFlags });
    if (plan.needsReview.length) throw new Error(STALE);
    const store = tx.objectStore('videoJa');
    for (const row of plan.puts.values()) store.put(row);
    for (const id of plan.deletes) store.delete(id);
    let entry = null;
    if (history) {
      entry = { id: uid('jah_'), materialId, kind: 'history', at: Date.now(), label, mode,
        items: changes.map(c => ({ cueId: c.cueId, stamp: expected.get(c.cueId), before: c.before, after: patch.get(c.cueId),
          link: maps.links.has(c.cueId) ? { studio: Boolean(maps.links.get(c.cueId).studio), manual: Boolean(maps.links.get(c.cueId).manual), base: maps.links.get(c.cueId).base ?? null } : null })) };
      store.put(entry);
      const old = records.filter(r => r.kind === 'history').sort((a, b) => a.at - b.at);
      for (const row of old.slice(0, Math.max(0, old.length + 1 - HISTORY_MAX))) store.delete(row.id);
    }
    return { history: entry, puts: plan.puts.size, deletes: plan.deletes.size };
  }));
}
export const readJaHistory = async materialId => (await readVideoJa(materialId)).filter(r => r.kind === 'history').sort((a, b) => b.at - a.at);

// Undo (or redo) a saved change, also after the app was restarted. Refused when any of its subtitles changed afterwards.
export function revertJaHistory(materialId, historyId, { redo = false } = {}) {
  return db.tx(['videos', 'cues', 'videoJa'], 'readwrite', tx => withMaterial(tx, materialId, ({ video, cues, records }) => {
    const entry = records.find(r => r.id === historyId && r.kind === 'history');
    if (!video || !entry) throw new Error('履歴が見つかりません');
    if (Boolean(entry.undone) !== redo) throw new Error(redo ? 'この操作はやり直し済みです' : 'この操作はすでに元に戻しています');
    const maps = recordMaps(records), byId = new Map(cues.map(c => [c.id, c]));
    const from = redo ? 'before' : 'after', to = redo ? 'after' : 'before';
    const expected = new Map();
    for (const item of entry.items) {
      const ids = [item.cueId, ...item.before.flatMap(e => e.cueIds), ...item.after.flatMap(e => e.cueIds)];
      for (const id of ids) {
        const cue = byId.get(id);
        if (!cue) throw new Error('字幕が削除されています。元に戻せません');
        expected.set(id, digest(cue));
      }
      if (byId.get(item.cueId) && digest(byId.get(item.cueId)) !== item.stamp) throw new Error('英文が変更されています。元に戻せません');
      const sorted = list => entriesKey(list.map(e => ({ ja: e.ja, cueIds: e.cueIds.slice().sort() })));
      if (sorted(entriesOf(maps, byId.get(item.cueId))) !== sorted(item[from])) throw new Error('その後に訳が変更されています。元に戻せません');
    }
    const patch = new Map(entry.items.map(item => [item.cueId, item[to].map(e => ({ ja: e.ja, cueIds: e.cueIds.slice().sort() }))]));
    const flags = new Map(entry.items.map(item => [item.cueId, item.link]));
    const linkFlags = (cueId, old) => {
      if (redo) return { ...(entry.mode === 'studio' ? { studio: true } : { manual: true }), ...(old?.base != null ? { base: old.base } : {}) };
      const was = flags.get(cueId);
      return was ? { ...(was.studio ? { studio: true } : {}), ...(was.manual ? { manual: true } : {}), ...(was.base != null ? { base: was.base } : {}) } : {};
    };
    const plan = planJaWrites(materialId, cues, records, patch, expected, { atomic: true, linkFlags });
    if (plan.needsReview.length) throw new Error('字幕が変更されています。元に戻せません');
    const store = tx.objectStore('videoJa');
    for (const row of plan.puts.values()) store.put(row);
    for (const id of plan.deletes) store.delete(id);
    // Links removed by the plan for subtitles that had no link before the change.
    if (!redo) for (const item of entry.items) if (!item.link && !item.before.length) {
      const id = JSON.stringify([materialId, item.cueId]);
      if (!plan.puts.has(id)) store.delete(id);
    }
    store.put({ ...entry, undone: !redo, revertedAt: Date.now() });
    return entry;
  }));
}

// Hand-corrected subtitles (for the correction export and for protection checks).
export function labManualCueIds(cues, records) {
  const { links } = recordMaps(records);
  return new Set(cues.filter(c => c.jaEdited || links.get(c.id)?.manual).map(c => c.id));
}
export function labJaEntries(cues, records) {
  const maps = recordMaps(records);
  return new Map(cues.map(c => [c.id, { entries: entriesOf(maps, c), link: maps.links.get(c.id) || null }]));
}
export const jaDigest = digest;
// Translation units [{ ids, texts }] (from a correction file) -> changes for applyJaChanges. A shared Lab translation
// that loses some of its subtitles is re-made for the remaining ones, never left pointing at a subtitle that dropped it.
export function labPatchUnits(cues, records, units) {
  const maps = recordMaps(records), byId = new Map(cues.map(c => [c.id, c]));
  const after = new Map();
  for (const unit of units) {
    const cueIds = unit.ids.slice().sort();
    for (const id of unit.ids) after.set(id, unit.texts.filter(t => t.trim()).map(ja => ({ ja, cueIds: unit.ids.length > 1 ? cueIds : [id] })));
  }
  const targets = new Set(after.keys());
  for (const cue of cues) {
    if (targets.has(cue.id)) continue;
    const entries = entriesOf(maps, cue);
    if (!entries.some(e => e.cueIds.some(id => targets.has(id)))) continue;
    after.set(cue.id, entries.map(e => {
      if (!e.cueIds.some(id => targets.has(id))) return e;
      const rest = e.cueIds.filter(id => !targets.has(id));
      return { ja: e.ja, cueIds: rest };
    }));
  }
  return [...after].map(([cueId, list]) => ({ cueId, before: entriesOf(maps, byId.get(cueId)), after: list }));
}
