// Release integrity: hashes, generated service worker block, install/update behaviour, version reporting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const lib = await import('../tools/release-lib.mjs');
const { checkRelease } = await import('../tools/check-release.mjs');

// 1. the repository itself is consistent
assert.deepEqual(checkRelease(root).problems, []);

// 2. a changed file (without regenerating) is detected; regenerating fixes it; regenerating twice changes nothing
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
for (const f of fs.readdirSync(root)) if (fs.statSync(path.join(root, f)).isFile() && !f.endsWith('.zip')) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
fs.writeFileSync(path.join(tmp, 'cloze.js'), fs.readFileSync(path.join(tmp, 'cloze.js'), 'utf8') + '\n// edit\n');
assert.ok(checkRelease(tmp).problems.some((p) => /cloze\.js/.test(p)));
const build = (dir) => { const rel = lib.buildRelease(dir); fs.writeFileSync(path.join(dir, 'sw.js'), lib.applyToSw(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'), rel)); fs.writeFileSync(path.join(dir, 'release.json'), lib.stringify(rel)); return rel; };
const r1 = build(tmp);
assert.deepEqual(checkRelease(tmp).problems, []);
assert.notEqual(r1.id, lib.buildRelease(root).id);       // any byte change -> new release id -> new cache name
assert.equal(build(tmp).id, r1.id);
// a module that imports a file outside the release is reported
fs.writeFileSync(path.join(tmp, 'cloze.js'), "import './not-shipped.js';\n" + fs.readFileSync(path.join(tmp, 'cloze.js'), 'utf8'));
build(tmp);
assert.ok(checkRelease(tmp).problems.some((p) => /not-shipped\.js/.test(p)));
// version constants are read from the code, so the displayed version cannot drift from release.json
const c = lib.constants(root);
assert.deepEqual([c.version, c.studio], [lib.buildRelease(root).version, lib.buildRelease(root).studio]);

// 3. service worker behaviour with a fake browser
const bytes = (s) => new TextEncoder().encode(s);
async function simulate({ served, files, preexisting = {} }) {
  const rel = { id: 'rel-new', files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, lib.sha256(bytes(t))])) };
  const code = lib.applyToSw(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), rel);
  const store = new Map(Object.entries(preexisting).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const handlers = {}, sent = [];
  const caches = {
    open: async (k) => { if (!store.has(k)) store.set(k, new Map()); const m = store.get(k); return { put: async (u, r) => m.set(u.href ?? u, r), match: async (u) => m.get(u.href ?? u) }; },
    keys: async () => [...store.keys()], delete: async (k) => store.delete(k),
  };
  const fakeResponse = (t) => ({ ok: true, text: t, clone() { return this; }, arrayBuffer: async () => bytes(t).buffer });
  let fetched = [];
  const self = { registration: { scope: 'https://x.test/app/' }, addEventListener: (t, f) => { handlers[t] = f; } };
  vm.runInNewContext(code, { self, caches, crypto: globalThis.crypto, URL, TextEncoder, fetch: async (u) => { const name = String(u.url ?? u.href ?? u).replace('https://x.test/app/', ''); fetched.push(name); return name in served ? fakeResponse(served[name]) : { ok: false, status: 404 }; }, Response: undefined, Object, Promise, Array, decodeURIComponent, Uint8Array, console });
  const wait = async (type) => { let p; handlers[type]({ waitUntil: (x) => { p = x; } }); return p; };
  const request = (name, method = 'GET') => ({ method, url: 'https://x.test/app/' + name });
  const respond = async (name) => { let p = null; handlers.fetch({ request: request(name), respondWith: (x) => { p = x; } }); return p && await p; };
  return { store, handlers, sent, install: () => wait('install'), activate: () => wait('activate'), respond, fetched: () => fetched, self,
    message: (data) => handlers.message({ data, source: { postMessage: (m) => sent.push(m) } }) };
}
const files = { 'index.html': '<html>new</html>', 'app.js': 'new app', 'studio-main.js': 'new studio' };
// 3a. good release installs into a cache named after the release id; every file served from it
let sw = await simulate({ served: files, files, preexisting: { 'ell-shell-rel-old': { 'https://x.test/app/app.js': fakeOld('old app') }, 'other-app': { x: 1 } } });
function fakeOld(t) { return { ok: true, text: t }; }
await sw.install();
assert.deepEqual([...sw.store.get('ell-shell-rel-new').keys()].sort(), Object.keys(files).map((n) => 'https://x.test/app/' + n).sort());
assert.equal((await sw.respond('app.js')).text, 'new app');
assert.equal((await sw.respond('')).text, '<html>new</html>');          // "./" -> index.html
assert.equal(await sw.respond('release.json'), null);                    // never served from the shell cache
assert.equal(await sw.respond('unknown.js'), null);
// 3b. activation removes only older Englabo caches
await sw.activate();
assert.deepEqual([...sw.store.keys()].sort(), ['ell-shell-rel-new', 'other-app']);
// 3c. one file differs from the hash list (stale CDN copy) -> install fails, nothing half-installed, running release untouched
sw = await simulate({ served: { ...files, 'app.js': 'STALE app' }, files, preexisting: { 'ell-shell-rel-old': { 'https://x.test/app/app.js': fakeOld('old app') } } });
await assert.rejects(sw.install(), /Release mismatch: app\.js/);
assert.equal(sw.store.has('ell-shell-rel-new'), false);
assert.equal(sw.store.get('ell-shell-rel-old').get('https://x.test/app/app.js').text, 'old app');
sw = await simulate({ served: { 'index.html': files['index.html'] }, files });
await assert.rejects(sw.install(), /HTTP 404/);
assert.equal(sw.store.has('ell-shell-rel-new'), false);
// 3d. evicted cache entry falls back to the network instead of an error
sw = await simulate({ served: files, files });
await sw.install(); sw.store.get('ell-shell-rel-new').delete('https://x.test/app/app.js');
assert.equal((await sw.respond('app.js')).text, 'new app');
// 3e. pages can ask which release serves them
sw.message('release'); assert.equal(JSON.stringify(sw.sent), JSON.stringify([{ release: 'rel-new' }]));
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert.ok(!/skipWaiting|clients\.claim/.test(swSource.replace(/\/\/.*$/gm, '')), 'a new release must wait until every screen is closed');

// 4. version / release reporting in the pages (update-manager.js)
const setNav = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
const um = await import('../update-manager.js');
const listeners = new Set();
const controllerWith = (id) => ({ postMessage: () => queueMicrotask(() => { for (const f of [...listeners]) f({ data: { release: id } }); }) });
const serviceWorker = (id) => ({ controller: id && controllerWith(id), addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: c.version, id: 'rel-new', studio: c.studio }) });
setNav({ serviceWorker: serviceWorker('rel-new') });
assert.equal(await um.loadedRelease(), 'rel-new');
assert.match(await um.releaseLabel(), /配信ID rel-ne · 最新/);
setNav({ serviceWorker: serviceWorker('rel-old') });
assert.match(await um.releaseLabel(), /更新あり/);                         // same version number, different files -> flagged
setNav({ serviceWorker: serviceWorker(null) });
assert.match(await um.releaseLabel(), /未適用/);
setNav({});
assert.equal(await um.loadedRelease(), null);
console.log('release-integrity: ok');
