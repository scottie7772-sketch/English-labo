// Minimal in-memory IndexedDB for the Node tests (only what db.js / common-idb.js use).
// Transactions work on a copy and commit when no request is pending; abort discards every write.
const databases = new Map();   // name -> { version, stores: Map(name -> { keyPath, autoIncrement, next, indexes: Map, data: Map }) }
const clone = v => structuredClone(v);
const typeRank = k => typeof k === 'number' ? 1 : typeof k === 'string' ? 2 : Array.isArray(k) ? 3 : 4;
export function cmp(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (Array.isArray(a)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  return a < b ? -1 : a > b ? 1 : 0;
}
const pathValue = (v, path) => Array.isArray(path) ? path.map(p => pathValue(v, p)) : path.split('.').reduce((x, k) => x?.[k], v);
const validKey = k => typeof k === 'number' || typeof k === 'string' || (Array.isArray(k) && k.every(validKey));
const inRange = (k, q) => q == null ? true : q instanceof FakeKeyRange ? q.includes(k) : cmp(k, q) === 0;
class FakeKeyRange {
  constructor(lower, upper, lo = false, uo = false) { Object.assign(this, { lower, upper, lowerOpen: lo, upperOpen: uo }); }
  includes(k) {
    if (this.lower !== undefined) { const c = cmp(k, this.lower); if (c < 0 || (c === 0 && this.lowerOpen)) return false; }
    if (this.upper !== undefined) { const c = cmp(k, this.upper); if (c > 0 || (c === 0 && this.upperOpen)) return false; }
    return true;
  }
  static lowerBound(x, open) { return new FakeKeyRange(x, undefined, open); }
  static upperBound(x, open) { return new FakeKeyRange(undefined, x, false, open); }
  static bound(a, b, lo, uo) { return new FakeKeyRange(a, b, lo, uo); }
  static only(x) { return new FakeKeyRange(x, x); }
}
const copyStores = stores => new Map([...stores].map(([n, s]) => [n, { ...s, indexes: new Map(s.indexes), data: new Map([...s.data].map(([k, v]) => [JSON.stringify(k), v])) }]));

class Request { constructor(tx) { this.transaction = tx; this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; } }
// Like real IndexedDB, transactions run in the order they were created: a transaction starts only after the earlier
// readwrite transactions finished (so a read right after a write sees it, and two writes never lose each other).
class Tx {
  constructor(db, names, mode, upgrade = false) {
    this.db = db; this.mode = mode; this.names = names; this.queue = []; this.done = false; this.error = null;
    this.oncomplete = this.onerror = this.onabort = null;
    this.upgrade = upgrade; this.started = false; this.work = null;
    if (upgrade) { this.work = copyStores(db.info.stores); this.started = true; }
    else {
      this.after = db.info.chain || null;
      if (mode !== 'readonly') db.info.chain = new Promise((resolve) => { this.release = resolve; });
    }
    this.schedule();
  }
  objectStore(name) {
    if (!this.upgrade && !this.names.includes(name)) throw new Error('NotFoundError: ' + name);
    if (!(this.work || this.db.info.stores).has(name)) throw new Error('NotFoundError: ' + name);
    return new Store(this, name);
  }
  request(run) {
    if (this.done) throw new Error('TransactionInactiveError');
    const req = new Request(this);
    this.queue.push({ req, run });
    this.schedule();
    return req;
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.step(); }, 0);
  }
  step() {
    if (this.done) return;
    if (!this.started) {
      if (this.after) { const a = this.after; this.after = null; a.then(() => this.schedule()); return; }
      this.work = copyStores(this.db.info.stores); this.started = true;   // a snapshot taken when the transaction starts (after earlier writes)
    }
    if (this.queue.length) {
      const { req, run } = this.queue.shift();
      try { req.result = run(); } catch (error) { req.error = error; this.abort(error); req.onerror?.({ target: req }); return; }
      try { req.onsuccess?.({ target: req }); } catch (error) { this.abort(error); return; }
      this.schedule();
      return;
    }
    // nothing pending: commit after the callbacks' microtasks had their chance to queue more requests or abort
    setTimeout(() => {
      if (this.done) return;
      if (this.queue.length) return this.schedule();
      this.done = true;
      if (this.mode !== 'readonly') this.db.info.stores = new Map([...this.work].map(([n, s]) => [n, { ...s, data: new Map([...s.data].map(([k, v]) => [JSON.parse(k), v])) }]));
      this.release?.();
      this.oncomplete?.({ target: this });
    }, 0);
  }
  abort(error = null) {
    if (this.done) return;
    this.done = true; this.queue = []; this.error = error; this.release?.();
    setTimeout(() => this.onabort?.({ target: this }), 0);
  }
}
class Store {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  get s() { return (this.tx.work || this.tx.db.info.stores).get(this.name); }   // before the transaction starts only the schema (indexes) is read
  get keyPath() { return this.s.keyPath; }
  createIndex(name, keyPath, opts = {}) { this.s.indexes.set(name, { keyPath, multiEntry: Boolean(opts.multiEntry) }); return {}; }
  write(value, key, add) {
    if (this.tx.mode === 'readonly') throw new Error('ReadOnlyError');
    const s = this.s; value = clone(value);
    let k = s.keyPath ? pathValue(value, s.keyPath) : key;
    if (k == null && s.autoIncrement) { k = s.next = (s.next || 0) + 1; if (s.keyPath) value[s.keyPath] = k; }
    else if (typeof k === 'number' && s.autoIncrement) s.next = Math.max(s.next || 0, k);
    if (!validKey(k)) throw new Error('DataError: invalid key');
    if (add && s.data.has(JSON.stringify(k))) throw new Error('ConstraintError');
    s.data.set(JSON.stringify(k), value);
    return k;
  }
  put(v, k) { return this.tx.request(() => this.write(v, k, false)); }
  add(v, k) { return this.tx.request(() => this.write(v, k, true)); }
  delete(k) { return this.tx.request(() => { if (this.tx.mode === 'readonly') throw new Error('ReadOnlyError'); for (const key of [...this.s.data.keys()]) if (inRange(JSON.parse(key), k)) this.s.data.delete(key); }); }
  clear() { return this.tx.request(() => { this.s.data.clear(); }); }
  entries(q) { return [...this.s.data].map(([k, v]) => [JSON.parse(k), v]).filter(([k]) => inRange(k, q)).sort((a, b) => cmp(a[0], b[0])); }
  get(k) { return this.tx.request(() => { const v = this.s.data.get(JSON.stringify(k)); return v === undefined ? undefined : clone(v); }); }
  getAll(q) { return this.tx.request(() => this.entries(q).map(([, v]) => clone(v))); }
  getAllKeys(q) { return this.tx.request(() => this.entries(q).map(([k]) => k)); }
  count(q) { return this.tx.request(() => this.entries(q).length); }
  openCursor(q, dir = 'next') { return cursor(this.tx, () => this.entries(q).map(([k, v]) => ({ key: k, primaryKey: k, value: v })), dir, this); }
  index(name) { return new Index(this, name); }
}
class Index {
  constructor(store, name) { this.store = store; this.def = store.s.indexes.get(name); if (!this.def) throw new Error('NotFoundError index ' + name); }
  entries(q) {
    const out = [];
    for (const [pk, v] of this.store.entries()) {
      const key = pathValue(v, this.def.keyPath);
      const keys = this.def.multiEntry && Array.isArray(key) ? key : [key];
      for (const k of keys) if (validKey(k) && inRange(k, q)) out.push({ key: k, primaryKey: pk, value: v });
    }
    return out.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey));
  }
  getAll(q) { return this.store.tx.request(() => this.entries(q).map(e => clone(e.value))); }
  count(q) { return this.store.tx.request(() => this.entries(q).length); }
  openCursor(q, dir = 'next') { return cursor(this.store.tx, () => this.entries(q), dir, this.store); }
  openKeyCursor(q, dir = 'next') { return cursor(this.store.tx, () => this.entries(q), dir, this.store, true); }
}
function cursor(tx, list, dir, store, keyOnly = false) {
  let items = null, i = -1;
  const req = tx.request(() => advance());
  function advance() {
    if (!items) { items = list(); if (dir.startsWith('prev')) items.reverse(); }
    i++;
    if (i >= items.length) return null;
    const e = items[i];
    return { key: e.key, primaryKey: e.primaryKey, value: keyOnly ? undefined : clone(e.value),
      continue() { tx.queue.push({ req, run: () => advance() }); tx.schedule(); },
      delete() { return store.delete(e.primaryKey); },
      update(v) { return store.put(v); } };
  }
  return req;
}
class DB {
  constructor(name, info) { this.name = name; this.info = info; this.onversionchange = null; this.closed = false; }
  get version() { return this.info.version; }
  get objectStoreNames() { const names = [...this.info.stores.keys()]; return { contains: n => names.includes(n), length: names.length, item: i => names[i] }; }
  transaction(names, mode = 'readonly') { return new Tx(this, Array.isArray(names) ? names : [names], mode); }
  close() { this.closed = true; }
}
export const fakeIndexedDB = {
  open(name, version = 1) {
    const req = new Request(null);
    req.onupgradeneeded = req.onblocked = null;
    setTimeout(() => {
      let info = databases.get(name);
      if (!info) { info = { version: 0, stores: new Map() }; databases.set(name, info); }
      const db = new DB(name, info);
      req.result = db;
      if (version > info.version) {
        const old = info.version;
        const up = new Tx(db, [], 'versionchange', true);
        db.createObjectStore = (n, opts = {}) => {
          up.work.set(n, { keyPath: opts.keyPath ?? null, autoIncrement: Boolean(opts.autoIncrement), next: 0, indexes: new Map(), data: new Map() });
          return new Store(up, n);
        };
        req.transaction = up;
        up.oncomplete = () => { info.version = version; req.transaction = null; req.onsuccess?.({ target: req }); };
        req.onupgradeneeded?.({ target: req, oldVersion: old, newVersion: version });
      } else req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
  deleteDatabase(name) { databases.delete(name); const r = new Request(null); setTimeout(() => r.onsuccess?.({}), 0); return r; },
};
export function installFakeIndexedDB() {
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.IDBKeyRange = FakeKeyRange;
  if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  }
  if (typeof globalThis.HTMLMediaElement === 'undefined') globalThis.HTMLMediaElement = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
}
installFakeIndexedDB();
