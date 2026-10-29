// JP Reader offline cache 76232733f295
const CACHE = 'jpr-76232733f295';
const FILES = ["./","background.js","content/content.js","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","index.html","lib/anki.js","lib/archive.js","lib/deinflect.js","lib/dictionary.js","lib/engine.js","lib/epub.js","lib/frequency.js","lib/jiten.js","lib/kana.js","lib/recommend.js","lib/settings.js","lib/shared.js","lib/subtitles.js","lib/sync.js","lib/tokenizer.js","manifest.webmanifest","pages/api.js","pages/bulk.html","pages/bulk.js","pages/options.html","pages/options.js","pages/reader.html","pages/reader.js","pages/recommend.html","pages/recommend.js","pages/ui.css","pages/video.html","pages/video.js","web/frame-shim.js","web/frame.css","web/platform.js","web/settings.html","web/settings.js","web/shell.js"];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/data/')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
