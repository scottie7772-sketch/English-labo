// IndexedDB wrapper + schema migrations
export const DB_NAME = 'ell-db';
export const DB_VERSION = 3;

// store name -> { keyPath, autoIncrement, indexes: [[name, keyPath, opts]] }
export const STORES = {
  words:          { keyPath: 'id', indexes: [['createdAt', 'createdAt'], ['bookmarked', 'bookmarkedNum'], ['tags', 'tags', { multiEntry: true }], ['deckIds', 'deckIds', { multiEntry: true }]] },
  mastery:        { keyPath: 'id', indexes: [['wordId', 'wordId'], ['skill', 'skill']] },
  masteryChanges: { keyPath: 'id', autoIncrement: true, indexes: [['wordId', 'wordId'], ['at', 'at']] },
  reviews:        { keyPath: 'id', indexes: [['wordId', 'wordId'], ['due', 'due']] },
  sessions:       { keyPath: 'id', indexes: [['status', 'status'], ['startedAt', 'startedAt']] },
  attempts:       { keyPath: 'id', autoIncrement: true, indexes: [['wordId', 'wordId'], ['sessionId', 'sessionId'], ['at', 'at'], ['skillAt', ['skill', 'at']]] },
  decks:          { keyPath: 'id' },
  grammar:        { keyPath: 'id', indexes: [['category', 'category']] },
  listening:      { keyPath: 'id' },
  speaking:       { keyPath: 'id' },
  videos:         { keyPath: 'id' },
  vblobs:         { keyPath: 'id' },   // video/audio files, one record per video, written once (v2)
  cues:           { keyPath: 'id', indexes: [['videoId', 'videoId']] },
  videoJa:        { keyPath: 'id', indexes: [['materialId', 'materialId']] },
  imports:        { keyPath: 'id' },
  settings:       { keyPath: 'key' },
  meta:           { keyPath: 'key' },
};

// Future migrations: MIGRATIONS[n] runs when upgrading from version n-1 to n.
const MIGRATIONS = {
  1: (db) => {
    for (const [name, def] of Object.entries(STORES)) {
      if (db.objectStoreNames.contains(name)) continue;
      const os = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
      for (const [iname, kp, opts] of def.indexes || []) os.createIndex(iname, kp, opts || {});
    }
  },
  // v2: media files get their own store. On iPhone, putting a file that was read from the database back into it
  // (e.g. saving the play position together with the video) can make it unreadable after the app is reopened.
  3: (db) => {
    if (db.objectStoreNames.contains('videoJa')) return;
    db.createObjectStore('videoJa', { keyPath: 'id' }).createIndex('materialId', 'materialId');
  },
  2: (db) => { if (!db.objectStoreNames.contains('vblobs')) db.createObjectStore('vblobs', { keyPath: 'id' }); },
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (let v = e.oldVersion + 1; v <= DB_VERSION; v++) MIGRATIONS[v]?.(db, req.transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('別のタブでアプリが開いています。閉じてから再読み込みしてください。'));
  });
  return dbPromise;
}

// Closes the connection (the next call opens it again). Used by the tests to simulate an app restart.
export async function closeDB() {
  const p = dbPromise; dbPromise = null;
  try { (await p)?.close(); } catch {}
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out, started;
    // A callback that throws right away (after queueing a write) must abort the transaction too, or the write would still be committed.
    try { started = fn(t); } catch (err) { try { t.abort(); } catch {} reject(err); return; }
    Promise.resolve(started).then((v) => { out = v; }, (err) => { try { t.abort(); } catch {} reject(err); });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export const db = {
  get: (store, key) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).get(key))),
  keys: (store) => tx([store], 'readonly', t => wrap(t.objectStore(store).getAllKeys())),
  all: (store) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).getAll())),
  count: (store) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).count())),
  byIndex: (store, index, query) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).index(index).getAll(query))),
  // count records per key of an index, in one transaction: { key: n }
  countEach: (store, index, keys) => tx([store], 'readonly', async (t) => {
    const idx = t.objectStore(store).index(index), out = {};
    await Promise.all(keys.map(async (k) => { out[k] = await wrap(idx.count(k)); }));
    return out;
  }),
  put: (store, value) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).put(value))),
  putMany: (store, values) => tx([store], 'readwrite', async (t) => { const os = t.objectStore(store); for (const v of values) os.put(v); }),
  delete: (store, key) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).delete(key))),
  clear: (store) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).clear())),
  tx,
};

// ---- attempts: read only what is needed (the 'at' index) instead of every record ----
export const attemptsSince = (ts) => db.byIndex('attempts', 'at', IDBKeyRange.lowerBound(ts));
// Days with at least one answer, and the latest answer time. Reads only keys of the 'at' index:
// the first and last answer, then one count per calendar day in between (all requests in one transaction).
export async function attemptDays() {
  const r = await daysByCount();
  if (r) return r;
  const all = await db.all('attempts'), days = new Set(); let last = null;
  for (const a of all) if (typeof a.at === 'number') { days.add(new Date(a.at).toDateString()); if (last == null || a.at > last) last = a.at; }
  return { days, last };
}
function daysByCount() {
  return tx(['attempts'], 'readonly', (t) => new Promise((res, rej) => {
    const idx = t.objectStore('attempts').index('at'), num = IDBKeyRange.upperBound(Infinity);
    const edge = (dir) => new Promise((ok) => { const r = idx.openKeyCursor(num, dir); r.onsuccess = () => ok(r.result ? r.result.key : null); r.onerror = () => rej(r.error); });
    Promise.all([edge('next'), edge('prev')]).then(([first, last]) => {
      const days = new Set();
      if (first == null) return res({ days, last: null });
      if (last - first > 4000 * 86400000) return res(null);   // odd old timestamps: use the full read below
      const d0 = new Date(first), reqs = [];
      for (let d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()); d.getTime() <= last; d.setDate(d.getDate() + 1)) {
        const s = d.getTime(), e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), label = d.toDateString();
        reqs.push(new Promise((ok) => { const r = idx.count(IDBKeyRange.bound(s, e, false, true)); r.onsuccess = () => { if (r.result) days.add(label); ok(); }; r.onerror = () => rej(r.error); }));
      }
      Promise.all(reqs).then(() => res({ days, last }));
    });
  }));
}

export async function getSetting(key, fallback) {
  const r = await db.get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => db.put('settings', { key, value });
export async function getMeta(key, fallback) {
  const r = await db.get('meta', key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => db.put('meta', { key, value });

export function uid(prefix = '') {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}

export async function storageInfo() {
  const out = { persisted: null, usage: null, quota: null };
  try { out.persisted = await navigator.storage?.persisted?.(); } catch {}
  try { const e = await navigator.storage?.estimate?.(); if (e) { out.usage = e.usage; out.quota = e.quota; } } catch {}
  return out;
}
export async function requestPersist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
