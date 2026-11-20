// Network-first for app files (updates appear automatically when online), cache fallback for offline.
const CACHE = 'ell-shell-v80';
const SHELL = ['./', './index.html', './app.css', './app.js', './db.js', './backup.js', './ui.js', './mastery.js', './words.js', './vocab.js', './seed.js', './judge.js', './study.js', './quick.js', './video.js', './swipecard.js', './icons.js', './hub.js', './langs.js', './srs.js', './content.js', './feedback.js', './pick.js', './speaking.js', './listening.js', './puzzle.js', './verbswipe.js', './prepviz.js', './games.js', './lesson.js', './datacheck.js', './cloze.js', './course.js', './content-course-es-v1.json', './content-course-zh-CN-v1.json', './content-course-zh-TW-v1.json', './asr.js', './content-en-pack-v1.json', './content-es-v1.json', './content-zh-v1.json', './content-speaking-v1.json', './content-listening-v1.json', './manifest.webmanifest', './studio.css', './studio-main.js', './studio-db.js', './studio-ops.js', './studio-subs.js', './studio-words.js', './studio-names.js', './studio-align.js', './media-probe.js', './media-audio.js', './storage.js', './common-idb.js', './common-pack.js', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    }
  })());
});
