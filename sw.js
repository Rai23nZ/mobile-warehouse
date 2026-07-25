/* ═══════════════════════════════════════════════════════════════════════
   Service Worker — реальный офлайн-режим.

   Раньше здесь был пустой обработчик fetch «чтобы Chrome признал PWA»:
   значок на домашнем экране появлялся, но без сети приложение открывалось
   без стилей и иконок, потому что они грузились с CDN. Теперь оболочка
   кэшируется целиком, а картинки товаров — по мере обращения.

   При изменении файлов оболочки поднимать SHELL_VERSION.
   ═══════════════════════════════════════════════════════════════════════ */

const SHELL_VERSION = 'shell-v3';
const IMG_CACHE     = 'imgs-v1';
const MAX_IMAGES    = 1500;          // мягкий предел, чтобы кэш не рос бесконечно

const SHELL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/app.css',
    './js/store.js',
    './js/csv.js',
    './js/ui.js',
    './js/app.js',
    './img/empty.jpg',
    './icon-192.png',
    './icon-512.png'
];

/* ---------- Установка: складываем оболочку в кэш ---------- */
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_VERSION);
        // addAll падает целиком, если хоть один файл недоступен, — кладём поштучно
        await Promise.all(SHELL_ASSETS.map(url =>
            cache.add(new Request(url, { cache: 'reload' }))
                 .catch(err => console.warn('[sw] не удалось закэшировать', url, err))
        ));
        await self.skipWaiting();
    })());
});

/* ---------- Активация: сносим кэши прошлых версий ---------- */
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter(k => k !== SHELL_VERSION && k !== IMG_CACHE)
                .map(k => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

/* ---------- Сеть ---------- */
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // чужие домены не трогаем

    const isImage = req.destination === 'image' || /\.(jpe?g|png|webp|gif|svg)$/i.test(url.pathname);
    if (isImage)              event.respondWith(handleImage(req));
    else if (req.mode === 'navigate') event.respondWith(handleNavigate(req));
    else                      event.respondWith(handleAsset(req));
});

/* HTML — сначала сеть: иначе страница отстаёт на одну перезагрузку и может
   разойтись по версии с закэшированными css/js. Без сети отдаём кэш. */
async function handleNavigate(req) {
    const cache = await caches.open(SHELL_VERSION);
    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
    } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true })
                    || await cache.match('./index.html', { ignoreSearch: true });
        if (cached) return cached;
        return offlineResponse();
    }
}

/* Остальная оболочка (css/js/иконки) — сначала кэш: файлы precache-ятся при
   установке, обновляются поднятием SHELL_VERSION. ignoreSearch снимает
   промах кэша из-за строки версии `?v=…`. */
async function handleAsset(req) {
    const cache  = await caches.open(SHELL_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (e) {
        return offlineResponse();
    }
}

function offlineResponse() {
    return new Response('Офлайн: ресурс недоступен', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

/* Картинки товаров: сначала кэш, иначе сеть с сохранением.
   Их тысячи, они не меняются, и именно они нужны офлайн в зале. */
async function handleImage(req) {
    const cache  = await caches.open(IMG_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
        const res = await fetch(req);
        if (res && res.ok) {
            cache.put(req, res.clone());
            trimImageCache();               // без await — не задерживаем ответ
        }
        return res;
    } catch (e) {
        const shell    = await caches.open(SHELL_VERSION);
        const fallback = await shell.match('./img/empty.jpg', { ignoreSearch: true });
        return fallback || new Response('', { status: 504 });
    }
}

let trimming = false;
async function trimImageCache() {
    if (trimming) return;
    trimming = true;
    try {
        const cache = await caches.open(IMG_CACHE);
        const keys  = await cache.keys();
        if (keys.length > MAX_IMAGES) {
            // вытесняем самые давние записи (порядок keys() — порядок добавления)
            await Promise.all(keys.slice(0, keys.length - MAX_IMAGES).map(k => cache.delete(k)));
        }
    } catch (e) {
        console.warn('[sw] trimImageCache:', e);
    } finally {
        trimming = false;
    }
}

/* Позволяет странице попросить немедленную активацию новой версии */
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});
