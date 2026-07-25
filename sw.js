/* ═══════════════════════════════════════════════════════════════════════
   Service Worker — реальный офлайн-режим.

   Раньше здесь был пустой обработчик fetch «чтобы Chrome признал PWA»:
   значок на домашнем экране появлялся, но без сети приложение открывалось
   без стилей и иконок, потому что они грузились с CDN. Теперь оболочка
   кэшируется целиком, а картинки товаров — по мере обращения.

   При изменении файлов оболочки поднимать SHELL_VERSION.
   ═══════════════════════════════════════════════════════════════════════ */

const SHELL_VERSION = 'shell-v8';
const IMG_CACHE     = 'imgs-v1';
const DATA_CACHE    = 'data-v1';
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
    './js/reasons.js',
    './js/catalog.js',
    './js/scanner.js',
    './js/assign.js',
    './js/sync.js',
    './js/lead.js',
    './vendor/zxing.min.js',
    './vendor/qrcode.min.js',
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
        const keep = [SHELL_VERSION, IMG_CACHE, DATA_CACHE];
        const stale = keys.filter(k => !keep.includes(k));
        await Promise.all(stale.map(k => caches.delete(k)));
        await self.clients.claim();

        /* Страница, открытая до обновления, уже держит в памяти СТАРЫЕ модули,
           хотя index.html мог прийти новый (он раздаётся «сначала сеть»).
           Такое сочетание ломается непредсказуемо, поэтому просим клиентов
           перезагрузиться. Условие про stale отсекает первую установку:
           там обновлять нечего. */
        if (stale.length) {
            const clients = await self.clients.matchAll({ type: 'window' });
            clients.forEach(c => c.postMessage({ type: 'sw-updated', version: SHELL_VERSION }));
        }
    })());
});

/* ---------- Сеть ---------- */
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // чужие домены не трогаем

    const isImage = req.destination === 'image' || /\.(jpe?g|png|webp|gif|svg)$/i.test(url.pathname);
    const isData  = url.pathname.includes('/data/');
    /* Код и стили должны быть той же версии, что и разметка. Раньше HTML
       брался из сети, а модули из кэша — и первая загрузка после каждого
       обновления могла смешать новую разметку со старым кодом. Теперь они
       обновляются вместе; офлайн по-прежнему работает из кэша. */
    const isCode  = /\/(js|css)\/[^/]+\.(js|css)$/i.test(url.pathname);

    if (isImage)                      event.respondWith(handleImage(req));
    else if (isData)                  event.respondWith(handleData(req));
    else if (req.mode === 'navigate') event.respondWith(handleNavigate(req));
    else if (isCode)                  event.respondWith(handleCode(req));
    else                              event.respondWith(handleAsset(req));
});

/* Сначала сеть, кэш — запасной путь. Вендоренные библиотеки сюда не
   попадают: они не меняются и остаются на кэш-первом пути. */
async function handleCode(req) {
    const cache = await caches.open(SHELL_VERSION);
    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || offlineResponse();
    }
}

/* Справочники товаров: сначала сеть, кэш — как запасной вариант.
   База дополняется по несколько раз в неделю, и обновление должно
   доезжать до устройства простой заменой файла, без поднятия
   SHELL_VERSION. HEAD-запросы пропускаем к сети напрямую: по ним
   catalog.js сверяет размер и дату файла со своим индексом. */
async function handleData(req) {
    const cache = await caches.open(DATA_CACHE);
    try {
        const res = await fetch(req);
        if (res && res.ok && req.method === 'GET') cache.put(req, res.clone());
        return res;
    } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || new Response('', { status: 504 });
    }
}

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
