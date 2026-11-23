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

export function planJaWrites(materialId, cues, records, patch, expected, { clear = false } = {}) {
  const current = new Map(cues.map(c => [c.id, c]));
  const links = new Map(records.filter(r => r.cueId).map(r => [r.cueId, r]));
  const texts = new Map(records.filter(r => typeof r.ja === 'string').map(r => [r.ja, r]));
  const groupKey = (textId, cueIds) => JSON.stringify([textId, cueIds]);
  const groups = new Map(records.filter(r => r.textId).map(r => [groupKey(r.textId, r.cueIds), r]));
  const used = new Set(), puts = new Map(), deletes = new Set();
  const needsReview = [];
  if (clear) {
    patch = new Map([...links.keys()].map(id => [id, []]));
    for (const cue of cues) if (cue.ja) patch.set(cue.id, []);
  }
  const eligible = new Set();
  for (const [id, stamp] of expected) if (current.has(id) && stamp === digest(current.get(id))) eligible.add(id);
  const groupCache = new WeakMap();
  for (const [cueId, values] of patch) {
    const cue = current.get(cueId), old = links.get(cueId);
    if (!cue || (!clear && !eligible.has(cueId))) {
      if (clear && old) { deletes.add(old.id); links.delete(cueId); }
      else needsReview.push(cueId);
      continue;
    }
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
    if (!refs.length && !cue.ja) {
      if (old) deletes.add(old.id);
      links.delete(cueId);
      continue;
    }
    const row = { id, materialId, cueId, revision, refs };
    if (!old || old.revision !== revision || JSON.stringify(old.refs) !== JSON.stringify(refs)) puts.set(id, row);
    links.set(cueId, row);
  }
  for (const link of links.values()) for (const id of link.refs) used.add(id);
  const textUsed = new Set();
  for (const row of groups.values()) {
    if (used.has(row.id)) textUsed.add(row.textId);
    else deletes.add(row.id);
  }
  for (const row of texts.values()) if (!textUsed.has(row.id)) deletes.add(row.id);
  return { puts, deletes, needsReview };
}

export const compareVideoCues = (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
