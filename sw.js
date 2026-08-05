/* ═══════════════════════════════════════════════════════════════════════
   Service Worker — реальный офлайн-режим.

   Раньше здесь был пустой обработчик fetch «чтобы Chrome признал PWA»:
   значок на домашнем экране появлялся, но без сети приложение открывалось
   без стилей и иконок, потому что они грузились с CDN. Теперь оболочка
   кэшируется целиком, а картинки товаров — по мере обращения и прогревом
   из js/images.js.

   При изменении файлов оболочки поднимать SHELL_VERSION.

   Фотографии товаров живут ОТДЕЛЬНО от оболочки и переживают её
   обновления: их сотни мегабайт, и перекачивать их из-за правки в css
   недопустимо. Обновляются они точечно — по data/img-rev.json, командой
   evict-images от страницы. Смена IMG_CACHE — аварийный рубильник на
   случай, когда переснято столько, что дешевле собрать кэш заново.
   ═══════════════════════════════════════════════════════════════════════ */

const SHELL_VERSION = 'shell-v18';
const IMG_CACHE     = 'imgs-v3';
const MISS_CACHE    = 'imgs-miss-v1';   // артикулы, у которых фото нет вовсе
const DATA_CACHE    = 'data-v1';

/* Среднее фото ~47 КБ, то есть предел — около 190 МБ. Прежние 1500 (~70 МБ)
   были меньше крупного наряда: прогрев успевал вытеснить собственное
   начало раньше, чем кладовщик до него доходил. */
const MAX_IMAGES    = 4000;
const TIGHT_RESERVE = 300 * 1024 * 1024;   // ближе к концу квоты чистим заранее
const TIGHT_DROP    = 300;                 // сколько сносим при нехватке места
const TIGHT_FLOOR   = 200;                 // ниже этого кэш фото трогать бесполезно
const CHECK_EVERY   = 200;                 // как часто пересчитывать кэш целиком
const MISSING_TTL   = 24 * 60 * 60 * 1000; // срок годности пометки «фото нет»

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
    './js/images.js',
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
        const keep = [SHELL_VERSION, IMG_CACHE, MISS_CACHE, DATA_CACHE];
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

    /* Фото товара — это ровно img/<Сеть>/<Артикул>.jpg. Проверка по одному
       лишь расширению цепляла бы и icon-512.png, и img/empty.jpg: они часть
       оболочки, и в кэше фотографий им делать нечего — их бы оттуда
       вытеснило по лимиту вместе с товарными снимками. */
    const isPhoto = /\/img\/[^/]+\/[^/]+\.(jpe?g|png|webp)$/i.test(url.pathname);
    const isData  = url.pathname.includes('/data/');
    /* Код и стили должны быть той же версии, что и разметка. Раньше HTML
       брался из сети, а модули из кэша — и первая загрузка после каждого
       обновления могла смешать новую разметку со старым кодом. Теперь они
       обновляются вместе; офлайн по-прежнему работает из кэша. */
    const isCode  = /\/(js|css)\/[^/]+\.(js|css)$/i.test(url.pathname);

    if (isPhoto)                      event.respondWith(handleImage(req));
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

/* Справочники товаров и ревизия фотографий: сначала сеть, кэш — как
   запасной вариант. База дополняется по несколько раз в неделю, и
   обновление должно доезжать до устройства простой заменой файла, без
   поднятия SHELL_VERSION. HEAD-запросы пропускаем к сети напрямую: по ним
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

/* ═══════════════════════════════════════════════════════════════════════
   ФОТОГРАФИИ ТОВАРОВ

   Сначала кэш, иначе сеть с сохранением: их тысячи, и именно они нужны
   офлайн в зале. Совпадение по ТОЧНОМУ адресу — без ignoreSearch. Прежний
   ignoreSearch здесь и убивал обновление фото: адрес с новой датой в `?v=`
   попадал в запись, сохранённую со старой, и снимок оставался прежним
   навсегда. Версии в адресе больше нет, а точное сравнение не даёт
   завести её снова незаметно.
   ═══════════════════════════════════════════════════════════════════════ */
async function handleImage(req) {
    const cache  = await caches.open(IMG_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;

    if (await isKnownMissing(req)) return emptyPhoto();

    try {
        const res = await fetch(req);
        if (res && res.ok) {
            cache.put(req, res.clone())
                 .then(afterStore)                  // без await — не задерживаем ответ
                 .catch(onPutFailed);
            return res;
        }
        /* Фото у артикула может не быть вовсе — это норма, а не сбой.
           Запоминаем, чтобы не ходить в сеть за ним при каждом показе, но
           не навсегда: снимок могут добавить, и пометка не должна его
           прятать. Обновление ревизии снимает пометки сразу. */
        if (res && res.status === 404) {
            await rememberMissing(req);
            return emptyPhoto();
        }
        return res;
    } catch (e) {
        return emptyPhoto(true);         // сети нет — заглушка с пометкой об этом
    }
}

/* Заглушка вместо снимка. На экране оба случая выглядят одинаково — серый
   прямоугольник, — но для прогрева разница принципиальная, и различает их
   заголовок:

     X-Wh-Empty    у артикула фото нет и не будет — норма, идём дальше;
     X-Wh-Offline  связи нет — перебирать остаток наряда бессмысленно.

   Без него прогрев в зале без сети покорно тянул бы весь наряд, раз за
   разом получая заглушку и считая её успехом. */
async function emptyPhoto(offline) {
    const shell = await caches.open(SHELL_VERSION);
    const res   = await shell.match('./img/empty.jpg', { ignoreSearch: true });
    if (!res) return new Response('', { status: 504 });

    const headers = new Headers(res.headers);
    headers.set(offline ? 'X-Wh-Offline' : 'X-Wh-Empty', '1');
    return new Response(res.body, { status: 200, headers });
}

async function isKnownMissing(req) {
    try {
        const cache = await caches.open(MISS_CACHE);
        const rec   = await cache.match(req);
        if (!rec) return false;
        if (Date.now() - Number(rec.headers.get('X-Wh-At') || 0) < MISSING_TTL) return true;
        await cache.delete(req);
        return false;
    } catch (e) {
        return false;
    }
}

async function rememberMissing(req) {
    try {
        const cache = await caches.open(MISS_CACHE);
        await cache.put(req, new Response('', { headers: { 'X-Wh-At': String(Date.now()) } }));
    } catch (e) {
        /* Не записалось — будет лишний запрос, и только */
    }
}

/* «img/Сеть/Артикул.jpg» — ключ, не зависящий ни от того, в каком
   подкаталоге лежит сайт, ни от того, закодировал ли браузер апостроф
   в O'Stin. Страница присылает сеть и артикул, здесь они сходятся. */
function photoKey(url) {
    try {
        return decodeURI(new URL(url).pathname).split('/').slice(-3).join('/');
    } catch (e) {
        return '';
    }
}
const photoKeyOf = (network, article) => `img/${network}/${article}.jpg`;

/* Снимки активного наряда: их не вытесняем, пока наряд открыт. Список
   присылает страница при входе на рабочий экран. Перезапуск воркера его
   обнуляет — вытеснение просто вернётся к обычному «самые давние». */
let pinned = new Set();

/* Сколько снимков лежит в кэше. Считается один раз и дальше ведётся на
   сложении: cache.keys() на четырёх тысячах записей — не та работа,
   которую можно делать после КАЖДОЙ сохранённой картинки, а прогрев
   наряда сохраняет их сотнями подряд. -1 — ещё не считали. */
let imageCount = -1;
let sinceScan  = 0;

async function afterStore() {
    if (imageCount >= 0) imageCount++;
    sinceScan++;
    if (imageCount < 0 || imageCount > MAX_IMAGES || sinceScan >= CHECK_EVERY) {
        await trimImageCache();
    }
}

let trimming = false;
async function trimImageCache() {
    if (trimming) return;
    trimming = true;
    sinceScan = 0;
    try {
        const cache = await caches.open(IMG_CACHE);
        const keys  = await cache.keys();
        imageCount  = keys.length;

        let excess = keys.length - MAX_IMAGES;
        /* Место у браузера кончается — снимаем запас заранее, пока смена не
           упёрлась в квоту. Но только если кэш фотографий и правда велик:
           когда в нём полсотни записей, квоту занял кто-то другой, и
           стирать рабочие снимки бессмысленно — а без этого условия
           прогрев на переполненном телефоне стирал бы сам себя. */
        if (keys.length > TIGHT_FLOOR && await storageTight()) {
            excess = Math.max(excess, Math.min(TIGHT_DROP, keys.length - TIGHT_FLOOR));
        }
        if (excess <= 0) return;

        // порядок keys() — порядок добавления, вытесняем самые давние
        let dropped = 0;
        for (const req of keys) {
            if (dropped >= excess) break;
            if (pinned.has(photoKey(req.url))) continue;
            await cache.delete(req);
            dropped++;
        }
        imageCount = keys.length - dropped;
    } catch (e) {
        console.warn('[sw] trimImageCache:', e);
        imageCount = -1;
    } finally {
        trimming = false;
    }
}

/* Квота у браузера не бесконечная, и упереться в неё посреди смены хуже,
   чем потерять три сотни давних снимков заранее. */
async function storageTight() {
    try {
        if (!navigator.storage || !navigator.storage.estimate) return false;
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return quota > 0 && quota - usage < TIGHT_RESERVE;
    } catch (e) {
        return false;
    }
}

/* Запись не прошла — почти всегда это исчерпанная квота. Раньше такой
   отказ уходил в никуда необработанным промисом. */
function onPutFailed(err) {
    console.warn('[sw] запись фото в кэш:', err);
    trimImageCache();
}

async function listCachedArticles(network) {
    const cache  = await caches.open(IMG_CACHE);
    const keys   = await cache.keys();
    const prefix = `img/${network}/`;
    const out    = [];
    for (const req of keys) {
        const key = photoKey(req.url);
        if (key.startsWith(prefix)) out.push(key.slice(prefix.length).replace(/\.jpg$/i, ''));
    }
    return out;
}

async function evictImages(network, articles) {
    if (!network || !Array.isArray(articles) || !articles.length) return 0;
    const want  = new Set(articles.map(a => photoKeyOf(network, a)));
    const cache = await caches.open(IMG_CACHE);
    const keys  = await cache.keys();

    let n = 0;
    for (const req of keys) {
        if (!want.has(photoKey(req.url))) continue;
        await cache.delete(req);
        n++;
    }
    imageCount = keys.length - n;
    return n;
}

async function evictNetwork(network) {
    if (!network) return 0;
    const prefix = `img/${network}/`;
    const cache  = await caches.open(IMG_CACHE);
    const keys   = await cache.keys();

    let n = 0;
    for (const req of keys) {
        if (!photoKey(req.url).startsWith(prefix)) continue;
        await cache.delete(req);
        n++;
    }
    imageCount = keys.length - n;
    return n;
}

/* ---------- Просьбы от страницы ---------- */
self.addEventListener('message', event => {
    const data = event.data;
    if (data === 'skipWaiting') { self.skipWaiting(); return; }
    if (!data || typeof data !== 'object') return;

    const port  = event.ports && event.ports[0];
    const reply = value => { if (port) port.postMessage(value); };
    const run   = promise => event.waitUntil(promise.then(reply, err => {
        console.warn('[sw]', data.type, err);
        reply(null);
    }));

    switch (data.type) {
        case 'cached-articles':                     // что уже есть — чтобы не греть заново
            run(listCachedArticles(data.network));
            break;
        case 'evict-images':                        // переснятые снимки
            run(evictImages(data.network, data.articles));
            break;
        case 'evict-network':                       // устройство отстало слишком сильно
            run(evictNetwork(data.network));
            break;
        case 'drop-missing':                        // пометки «фото нет» больше не верны
            run(caches.delete(MISS_CACHE));
            break;
        case 'pin-images':
            pinned = new Set((data.articles || []).map(a => photoKeyOf(data.network, a)));
            reply(pinned.size);
            break;
    }
});
