// Small IndexedDB helper for the NEW databases (ell-studio, later ell-media).
// The existing learning database (ell-db / db.js) is not touched by this file.
export function makeDB(name, version, stores) {
  let dbp = null;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [s, def] of Object.entries(stores)) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
        for (const [iname, kp, opts] of def.indexes || []) os.createIndex(iname, kp, opts || {});
      }
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('データベースが他の画面で使用中です。ほかのタブを閉じてください'));
  }));
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(names, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(names, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('保存を取り消しました'));
      try { out = fn(t); } catch (e) { t.abort(); rej(e); }
    });
  }
  return {
    name, open, tx,
    async get(s, k) { const db = await open(); return req(db.transaction(s).objectStore(s).get(k)); },
    async all(s) { const db = await open(); return req(db.transaction(s).objectStore(s).getAll()); },
    async byIndex(s, i, v) { const db = await open(); return req(db.transaction(s).objectStore(s).index(i).getAll(v)); },
    async put(s, v) { const db = await open(); return req(db.transaction(s, 'readwrite').objectStore(s).put(v)); },
    async del(s, k) { const db = await open(); return req(db.transaction(s, 'readwrite').objectStore(s).delete(k)); },
  };
}
export const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
