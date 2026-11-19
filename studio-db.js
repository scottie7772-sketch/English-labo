// Studio data (database "ell-studio", separate from the learning database).
// Blocks keep their current state; every state is also frozen in blockRevs ("id@rev").
// One user action = one op (with before/after revision ids) -> exact Undo / Redo. Versions = frozen order + revision ids.
import { makeDB, newId } from './common-idb.js';

export const sdb = makeDB('ell-studio', 1, {
  sources:   { keyPath: 'id' },                                     // original media (immutable), blob only when stored
  sets:      { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },
  tracks:    { keyPath: 'id', indexes: [['setId', 'setId']] },     // original subtitle files (raw text kept)
  blocks:    { keyPath: 'id', indexes: [['setId', 'setId']] },
  blockRevs: { keyPath: 'id', indexes: [['blockId', 'blockId']] },
  oplog:     { keyPath: 'id', autoIncrement: true, indexes: [['setId', 'setId']] },
  versions:  { keyPath: 'id', indexes: [['setId', 'setId']] },
  meta:      { keyPath: 'key' },
});
export { newId };

export const UNDO_MAX = 200;
const revId = (b) => `${b.id}@${b.rev}`;
const snap = (b) => ({ ...structuredClone(b), id: revId(b), blockId: b.id });
const fromSnap = (s) => { const b = structuredClone(s); b.id = s.blockId; delete b.blockId; return b; };

// ---------- block helpers ----------
export const tokensOf = (text) => String(text || '').split(/\s+/).filter(Boolean);
export const blockDur = (b) => (b.segments || []).reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
export const blockStart = (b) => b.segments?.[0]?.start ?? 0;
export function newBlock(setId, fields) {
  const b = { setId, rev: 0, deleted: false, segments: [], text: '', ja: '', jaStatus: 'ok', holes: [], cueRefs: { en: [], ja: [] }, lineage: { op: 'create', from: [], at: Date.now() }, sync: 'auto', ...fields };
  if (!b.id) b.id = newId('b_');
  b.setId = setId;
  return b;
}
// invariants checked before anything is saved
export function checkBlock(b, sources = {}) {
  const errs = [];
  for (const s of b.segments || []) {
    if (!(s.end > s.start)) errs.push('区間の終わりが始まりより前です');
    if (s.start < 0) errs.push('区間が0秒より前です');
    const d = sources[s.sourceId]?.duration;
    if (d && s.end > d + 0.05) errs.push('区間が元ファイルの長さを超えています');
  }
  const n = tokensOf(b.text).length;
  for (const h of b.holes || []) if (h.s < 0 || h.e >= n || h.s > h.e) errs.push('穴埋めの位置が英文と合いません');
  return errs;
}

// ---------- commit one operation ----------
// changes: { blocks: [blockStateAfter...], order: newOrder|undefined }, label: text for history
export async function commit(set, label, { blocks = [], order }, sources = {}) {
  for (const b of blocks) { const e = checkBlock(b, sources); if (e.length) throw new Error(`保存できません：${e[0]}`); }
  const current = Object.fromEntries((await Promise.all(blocks.map((b) => sdb.get('blocks', b.id)))).filter(Boolean).map((b) => [b.id, b]));
  const entries = [];
  const writes = [];
  for (const b of blocks) {
    const prev = current[b.id];
    const next = { ...structuredClone(b), rev: (prev?.rev || 0) + 1 };
    entries.push({ id: b.id, before: prev ? revId(prev) : null, after: revId(next) });
    writes.push(next);
  }
  const orderBefore = set.order.slice();
  const orderAfter = order ? order.slice() : orderBefore;
  const op = { setId: set.id, at: Date.now(), label, blocks: entries, orderBefore, orderAfter };
  let opId;
  await sdb.tx(['blocks', 'blockRevs', 'oplog', 'sets'], 'readwrite', (t) => {
    for (const b of writes) { t.objectStore('blocks').put(b); t.objectStore('blockRevs').put(snap(b)); }
    const r = t.objectStore('oplog').add(op);
    r.onsuccess = () => {
      opId = r.result;
      set.order = orderAfter; set.undo = [...(set.undo || []), opId].slice(-UNDO_MAX); set.redo = []; set.updatedAt = Date.now();
      t.objectStore('sets').put(set);
    };
  });
  return { opId, blocks: writes };
}

async function applyRevs(set, entries, field, order) {
  const snaps = await Promise.all(entries.map((e) => (e[field] ? sdb.get('blockRevs', e[field]) : null)));
  await sdb.tx(['blocks', 'sets'], 'readwrite', (t) => {
    entries.forEach((e, i) => {
      if (snaps[i]) t.objectStore('blocks').put(fromSnap(snaps[i]));
      else t.objectStore('blocks').put({ ...(snaps[i] || {}), id: e.id, setId: set.id, rev: 0, deleted: true, segments: [], text: '', ja: '', holes: [], cueRefs: { en: [], ja: [] } });
    });
    set.order = order.slice(); set.updatedAt = Date.now();
    t.objectStore('sets').put(set);
  });
}
export async function undo(set) {
  const id = (set.undo || []).at(-1); if (id == null) return null;
  const op = await sdb.get('oplog', id);
  set.undo = set.undo.slice(0, -1); set.redo = [...(set.redo || []), id];
  await applyRevs(set, op.blocks, 'before', op.orderBefore);
  return op;
}
export async function redo(set) {
  const id = (set.redo || []).at(-1); if (id == null) return null;
  const op = await sdb.get('oplog', id);
  set.redo = set.redo.slice(0, -1); set.undo = [...(set.undo || []), id];
  await applyRevs(set, op.blocks, 'after', op.orderAfter);
  return op;
}

// ---------- versions ----------
export async function saveVersion(set, label = '', auto = false) {
  const blocks = await liveBlocks(set);
  const list = await sdb.byIndex('versions', 'setId', set.id);
  const v = { id: newId('v_'), setId: set.id, number: list.length + 1, label, auto, at: Date.now(), order: set.order.slice(), revs: Object.fromEntries(blocks.map((b) => [b.id, revId(b)])) };
  await sdb.put('versions', v);
  return v;
}
// restoring = a normal (undoable) operation that brings the blocks back to the version's revisions
export async function restoreVersion(set, v) {
  const snaps = await Promise.all(Object.values(v.revs).map((r) => sdb.get('blockRevs', r)));
  const restored = snaps.filter(Boolean).map((s) => ({ ...fromSnap(s), deleted: false }));
  const inVersion = new Set(Object.keys(v.revs));
  const nowLive = await liveBlocks(set);
  const removed = nowLive.filter((b) => !inVersion.has(b.id)).map((b) => ({ ...b, deleted: true }));
  return commit(set, `版${v.number}に戻す`, { blocks: [...restored, ...removed], order: v.order });
}

export async function liveBlocks(set) {
  const all = Object.fromEntries((await sdb.byIndex('blocks', 'setId', set.id)).map((b) => [b.id, b]));
  return set.order.map((id) => all[id]).filter((b) => b && !b.deleted);
}
export async function allBlocksMap(setId) { return Object.fromEntries((await sdb.byIndex('blocks', 'setId', setId)).map((b) => [b.id, b])); }
export async function sourcesMap() { return Object.fromEntries((await sdb.all('sources')).map((s) => [s.id, s])); }
