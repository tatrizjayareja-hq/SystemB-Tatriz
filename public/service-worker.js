const CACHE_NAME = 'tatriz-cache-v1';
const urlsToCache = [
  '/',
  '/img/Tatriz SystemB.png'
];

// Proses Instalasi PWA di Browser HP
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Sistem Fetching (Menyerahkan pengaturan rute halaman sepenuhnya ke Server Node.js)
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});