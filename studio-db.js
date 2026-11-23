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

// ---- 1.16: one copy of each sound. After a set is sent to the learning app, an audio source keeps only
// labRef = { videoId } and its sound is read from the learning app's store (ell-db / vblobs). The blob is never saved twice.
import { db as labDb } from './db.js';
const fromLab = new WeakSet();   // blobs that were read from the learning app (not to be saved here)
async function hydrate(src) {
  if (src && src.labRef && !src.blob) {
    try { const r = await labDb.get('vblobs', src.labRef.videoId); if (r?.blob) { src.blob = r.blob; fromLab.add(r.blob); } else src.labMissing = true; } catch { src.labMissing = true; }
  }
  return src;
}
const strip = (v) => {
  if (!v || !v.labRef) return v;
  const { blob, labMissing, labRef, ...rest } = v;
  if (blob && !fromLab.has(blob)) return { ...rest, blob };   // the sound was changed here (cut, converted): it is the studio's own again
  return { ...rest, labRef };
};
// 1.17.2: a file read back from this database is never written again (iPhone can make it unplayable: "再生できません",
// "再生もできませんでした" until the app is reopened). When only the details of such a source change (chosen sound track,
// notes…), they are kept beside it (localStorage) and laid over the record when it is read.
const fromIdb = new WeakSet();
const META = 'st-srcmeta';
const metaAll = () => { try { return JSON.parse(localStorage.getItem(META) || '{}'); } catch { return {}; } };
const metaSave = (m) => { try { localStorage.setItem(META, JSON.stringify(m)); return true; } catch { return false; } };
function withMeta(src) {
  if (!src) return src;
  if (src.blob && !src.labRef) fromIdb.add(src.blob);
  const m = metaAll()[src.id];
  if (m && src.blob && m._size === src.blob.size) { const { _size, ...rest } = m; Object.assign(src, rest); }
  return src;
}
{
  const { get, all, byIndex, put } = sdb;
  const prep = (v) => hydrate(v).then(withMeta);
  sdb.get = async (s, k) => { const v = await get(s, k); return s === 'sources' ? prep(v) : v; };
  sdb.all = async (s) => { const v = await all(s); return s === 'sources' ? Promise.all(v.map(prep)) : v; };
  sdb.byIndex = async (s, i, x) => { const v = await byIndex(s, i, x); return s === 'sources' ? Promise.all(v.map(prep)) : v; };
  sdb.put = (s, v) => {
    if (s !== 'sources' || !v) return put(s, v);
    const m = metaAll();
    if (v.blob && fromIdb.has(v.blob) && !v.labRef) {   // same file as saved: keep only the details
      const { blob, ...rest } = v;
      m[v.id] = { ...JSON.parse(JSON.stringify(rest)), _size: blob.size };
      if (metaSave(m)) return Promise.resolve(v.id);
    } else if (m[v.id]) { delete m[v.id]; metaSave(m); }
    return put(s, strip(v));
  };
}
export const sourceStripped = strip;

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
export async function commit(set, label, { blocks = [], order, guardedSet }, sources = {}) {
  for (const b of blocks) { const e = checkBlock(b, sources); if (e.length) throw new Error(`保存できません：${e[0]}`); }
  const current = Object.fromEntries((await Promise.all(blocks.map((b) => sdb.get('blocks', b.id)))).filter(Boolean).map((b) => [b.id, b]));
  const stale = '教材が更新されました。照合候補を出し直してください';
  const newIds = new Set(guardedSet?.newIds || []);
  if (guardedSet && blocks.some(b => newIds.has(b.id) ? Boolean(current[b.id]) : current[b.id]?.rev !== b.rev))
    throw new Error(stale);
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
  let rejected = false;
  await sdb.tx(['blocks', 'blockRevs', 'oplog', 'sets'], 'readwrite', (t) => {
    const sets = t.objectStore('sets');
    const write = (fresh) => {
      for (const b of writes) { t.objectStore('blocks').put(b); t.objectStore('blockRevs').put(snap(b)); }
      const r = t.objectStore('oplog').add(op);
      r.onsuccess = () => {
        opId = r.result;
        Object.assign(set, {...fresh, order:orderAfter, undo:[...(fresh.undo || []), opId].slice(-UNDO_MAX),
          redo:[], updatedAt:Date.now()});
        sets.put(set);
      };
    };
    if (!guardedSet) return write(set);
    const request = sets.get(set.id);
    request.onsuccess = () => {
      const fresh = request.result;
      const changed = !fresh || fresh.updatedAt !== guardedSet.updatedAt ||
        ['order','undo','redo'].some(key => JSON.stringify(fresh[key] || []) !== JSON.stringify(guardedSet[key]));
      if (changed) { rejected = true; t.abort(); return; }
      write(fresh);
    };
  }).catch(error => { throw rejected ? new Error(stale) : error; });
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

const sameEnds = async (a, b) => {
  const n = Math.min(65536, a.size);
  const [x, y, z, w] = await Promise.all([a.slice(0, n).arrayBuffer(), b.slice(0, n).arrayBuffer(), a.slice(a.size - n).arrayBuffer(), b.slice(b.size - n).arrayBuffer()]);
  const eq = (p, q) => { const u = new Uint8Array(p), v = new Uint8Array(q); if (u.length !== v.length) return false; for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false; return true; };
  return eq(x, y) && eq(z, w);
};
// an audio source whose identical copy is in the learning app: keep only the reference (frees the studio copy)
export async function linkToLab(src) {
  if (!src || src.labRef || !src.stored || src.kind !== 'audio' || !src.blob) return false;
  const vids = (await labDb.all('videos')).filter((v) => v.from?.media === src.id).sort((a, b) => (b.from?.updatedAt || b.createdAt || 0) - (a.from?.updatedAt || a.createdAt || 0));
  for (const v of vids) {
    const r = await labDb.get('vblobs', v.id);
    if (!r?.blob || r.blob.size !== src.blob.size) continue;
    try { if (!(await sameEnds(r.blob, src.blob))) continue; } catch { continue; }
    const { blob, ...rest } = src;
    await sdb.put('sources', { ...rest, labRef: { videoId: v.id, at: Date.now() }, size: r.blob.size });   // saved without the studio's copy
    src.labRef = { videoId: v.id }; src.blob = r.blob; fromLab.add(r.blob);
    return true;
  }
  return false;
}
// before the learning app deletes sounds: studio sources that point at them get their own copy back (nothing is lost)
export async function releaseLabRefs(videoIds = null) {
  const all = await sdb.all('sources'); let n = 0;
  for (const src of all) {
    if (!src.labRef || (videoIds && !videoIds.includes(src.labRef.videoId))) continue;
    const { labRef, labMissing, ...rest } = src;
    if (src.blob) rest.blob = new File([await src.blob.arrayBuffer()], src.name || 'audio', { type: src.mime || src.blob.type || 'audio/mp4' });
    else rest.stored = false;
    await sdb.put('sources', rest); n++;
  }
  return n;
}
