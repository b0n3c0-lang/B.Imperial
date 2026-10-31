// Service Worker — Barbearia Imperial
// Estratégia: rede primeiro (pega sempre a versão nova quando há internet) e cache como reserva (funciona offline).
const CACHE_NAME = 'barbearia-imperial-v2';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './logo.webp', './icon-192.png', './icon-512.png'];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('Sem cache de', url, err.message))))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n.startsWith('barbearia-imperial') && n !== CACHE_NAME).map((n) => caches.delete(n)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    const key = url.origin + url.pathname; // ignora ?action=... nos atalhos
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const update = fetch(request, { cache: 'no-cache' }).then((response) => {
            if (response && response.ok) cache.put(key, response.clone());
            return response;
        });
        event.waitUntil(update.catch(() => {}));
        try {
            return await Promise.race([
                update,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS))
            ]);
        } catch (err) {
            const cached = await cache.match(key);
            if (cached) return cached;
            if (request.mode === 'navigate') {
                const shell = await cache.match(new URL('./index.html', self.location.href).href);
                if (shell) return shell;
            }
            return Response.error();
        }
    })());
});
