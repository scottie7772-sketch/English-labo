// IndexedDB wrapper + schema migrations
export const DB_NAME = 'ell-db';
export const DB_VERSION = 1;

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
  cues:           { keyPath: 'id', indexes: [['videoId', 'videoId']] },
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

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, (err) => { try { t.abort(); } catch {} reject(err); });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export const db = {
  get: (store, key) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).get(key))),
  all: (store) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).getAll())),
  count: (store) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).count())),
  byIndex: (store, index, query) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).index(index).getAll(query))),
  put: (store, value) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).put(value))),
  putMany: (store, values) => tx([store], 'readwrite', async (t) => { const os = t.objectStore(store); for (const v of values) os.put(v); }),
  delete: (store, key) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).delete(key))),
  clear: (store) => tx([store], 'readwrite', (t) => wrap(t.objectStore(store).clear())),
  tx,
};

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
