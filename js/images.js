/* ═══════════════════════════════════════════════════════════════════════
   images.js — фотографии товаров на устройстве.

   Снимки лежат в img/<Сеть>/<Артикул>.jpg, их десятки тысяч, и в зале они
   нужны офлайн. Держит их Service Worker в отдельном кэше; здесь — две
   вещи, которых он сам сделать не может.

   1. ПРОГРЕВ. При входе на рабочий экран фото текущей выборки скачиваются
      заранее, пока связь ещё есть. Без этого снимок появляется только
      тогда, когда кладовщик до него долистал, — а в зале без сети он уже
      не появится вовсе.

   2. ОБНОВЛЕНИЕ. Кэш фото намеренно вечный: перекачивать сотни мегабайт
      при каждом обновлении оболочки нельзя. Значит устройству нужно
      сказать, какие именно снимки переснимали. Это и есть
      data/img-rev.json: номер ревизии на каждую сеть плюс список
      артикулов с ревизией, в которой их фото заменили. Новых фото в
      списке нет и быть не должно — их на устройстве всё равно ещё нет,
      они скачаются сами при первом показе или прогреве.

   Почему не версия в URL. Раньше к адресу дописывалось `?v=25_07_2026`,
   но Service Worker искал ответ с ignoreSearch и разницы в версии не
   замечал: смена даты не обновляла ни одного снимка. Даже будь она
   исправна, подъём общей версии обесценивал бы кэш всех четырёх сетей
   разом — сотня новых фото стоила бы полной перекачки в зале. Теперь
   версии в адресе нет вовсе: устаревшая запись удаляется из кэша по
   имени, точечно.
   ═══════════════════════════════════════════════════════════════════════ */

import { store } from './store.js';

const REV_URL     = 'data/img-rev.json';
const REV_KEY     = 'wh_img_rev';        // localStorage: { «Сеть»: номер ревизии }
const SW_TIMEOUT  = 8000;                // ответа от SW ждём не дольше этого
const REV_TIMEOUT = 5000;                // столько ждём файл ревизии, дальше греем как есть
const CONCURRENCY = 6;                   // больше — канал забивается ровно тогда,
                                         // когда пользователь начинает работать
const SLOW_HEAD   = 40;                  // сколько греем при экономии трафика
const FAIL_STREAK = 8;                   // столько отказов подряд — связи больше нет

/* Адреса без версии: одна и та же картинка обязана иметь один и тот же
   ключ кэша при рендере и при прогреве, иначе она качается дважды. */
export const imgUrl   = tovar => photoUrl(store.network, tovar);
export const emptyUrl = ()    => 'img/empty.jpg';

const photoUrl = (network, tovar) => `img/${network}/${tovar}.jpg`;

/* ── Разговор с Service Worker ─────────────────────────────────────────
   Кэшем фото владеет он: имя кэша, правила вытеснения и удаление записей
   живут в sw.js, чтобы не разъехаться в двух местах. Отсюда только
   просьбы. Контроллера может не быть (первый запуск до активации) — тогда
   кэша ещё нет и просить нечего. */
function askSw(message) {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return Promise.resolve(null);

    return new Promise(resolve => {
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        const timer  = setTimeout(() => finish(null), SW_TIMEOUT);

        try {
            const channel = new MessageChannel();
            channel.port1.onmessage = ev => { clearTimeout(timer); finish(ev.data); };
            sw.postMessage(message, [channel.port2]);
        } catch (e) {
            clearTimeout(timer);
            console.warn('[images] обращение к SW:', e);
            finish(null);
        }
    });
}

/* ── Ревизия фотографий ───────────────────────────────────────────────── */
function readSeen() {
    try { return JSON.parse(localStorage.getItem(REV_KEY) || '{}') || {}; }
    catch (e) { return {}; }
}

function writeSeen(network, rev) {
    try {
        const seen = readSeen();
        seen[network] = rev;
        localStorage.setItem(REV_KEY, JSON.stringify(seen));
    } catch (e) {
        /* Хранилище может быть заполнено или отключено. Тогда сверка
           повторится при следующем запуске: лишняя работа, но не ошибка. */
        console.warn('[images] отметка ревизии:', e);
    }
}

/* Сверяет ревизию фото сети с той, на которой остановилось устройство, и
   выбрасывает из кэша только переснятые снимки. Файл идёт по обычному
   пути data/ — «сначала сеть, кэш запасным вариантом», поэтому офлайн
   просто ничего не происходит. */
async function syncRevision(network) {
    let manifest;
    /* Таймаут обязателен: без сети запрос висит до собственного истечения
       браузера — на мёртвом соединении это секунды, — и всё это время
       прогрев стоит и ждёт. Тот же приём, что в catalog.js. */
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(), REV_TIMEOUT);
    try {
        const res = await fetch(REV_URL, { cache: 'no-cache', signal: ac.signal });
        if (!res.ok) return;                       // файла нет — механизм просто спит
        manifest = await res.json();
    } catch (e) {
        return;                                    // офлайн: обновлять всё равно нечем
    } finally {
        clearTimeout(timer);
    }

    const info = manifest && manifest.networks && manifest.networks[network];
    if (!info || typeof info.rev !== 'number') return;

    const seen = readSeen()[network];
    if (seen === info.rev) return;                 // ничего не менялось — ноль работы

    /* Первая встреча с сетью: что лежит в кэше, снято по нынешней
       ревизии либо его нет вовсе. Инвалидировать нечего. */
    if (typeof seen !== 'number') { writeSeen(network, info.rev); return; }

    /* История замен подрезается, иначе список растёт без конца. base —
       самая ранняя ревизия, которая в нём ещё представлена полностью.
       Устройство отстало сильнее — вычислить точечно нечего, сносим фото
       этой сети целиком: перекачается только то, что реально понадобится. */
    const base = typeof info.base === 'number' ? info.base : 1;
    if (seen < base - 1) {
        await askSw({ type: 'evict-network', network });
    } else {
        const changed = info.changed || {};
        const stale   = Object.keys(changed).filter(a => changed[a] > seen);
        if (stale.length) await askSw({ type: 'evict-images', network, articles: stale });
    }

    /* Пометки «фото нет» сняты вместе с ревизией: артикул мог получить
       снимок именно в ней, а пометка прятала бы его до истечения срока. */
    await askSw({ type: 'drop-missing' });
    writeSeen(network, info.rev);
}

/* ── Прогрев ──────────────────────────────────────────────────────────── */
let warmToken = 0;

/* Прогрев продолжается и после ухода с рабочего экрана, если его не
   остановить: очередь ничего не знает о том, что наряд уже сменился. */
export function cancelWarm() { warmToken++; }

function isSlowLink() {
    const c = navigator.connection;
    if (!c) return false;
    return !!c.saveData || /2g$/.test(c.effectiveType || '');
}

/* Прогрев идёт через fetch, а не через `new Image()`, по двум причинам.

   Первая — решающая. Картинку, которую браузер уже держит в собственной
   памяти, он отдаёт элементу <img> напрямую, не спрашивая Service Worker.
   Тогда снимок показан, прогрев считает его сделанным — а в кэше
   устройства его нет, и в зале без сети на этом месте пусто. Ровно это и
   происходит после обновления ревизии: старый кадр ещё в памяти вкладки,
   а из кэша он только что удалён. fetch до воркера доходит всегда.

   Вторая — дешевизна: `new Image()` каждый снимок ещё и раскодирует,
   а прогреву нужны только байты.

   no-cache — не «не кэшировать», а «переспросить у сервера». Мы здесь
   только потому, что в кэше устройства снимка нет; отдать вместо него
   старую копию из HTTP-кэша браузера значило бы не обновить ничего. */
async function loadOne(url) {
    try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res || !res.ok) return 'fail';
        if (res.headers.get('X-Wh-Offline')) return 'fail';    // связь пропала
        const empty = res.headers.get('X-Wh-Empty');           // фото у артикула нет вовсе
        await res.blob();                              // дочитываем: иначе SW не успеет сохранить
        return empty ? 'empty' : 'ok';
    } catch (e) {
        return 'fail';                                 // сети нет
    }
}

async function cachedArticles(network) {
    const list = await askSw({ type: 'cached-articles', network });
    return new Set(Array.isArray(list) ? list : []);
}

/* Точка входа: вызывается на КАЖДОМ входе на рабочий экран — по наряду
   с сервера, из своего файла, при восстановлении сессии и из снимка.
   Раньше прогрев висел на одном сценарии из четырёх, и проверяющий,
   зашедший по коду смены, оставался без фотографий.

   Порядок важен: сначала сверка ревизии (она удаляет устаревшее), потом
   прогрев (он это устаревшее перекачивает). Наоборот — качали бы дважды. */
export async function prepareImages(onNote) {
    const token   = ++warmToken;
    const network = store.network;
    const order   = [...store.order];
    if (!order.length) return;

    try {
        await syncRevision(network);
    } catch (e) {
        console.warn('[images] ревизия:', e);
    }
    if (token !== warmToken || store.network !== network) return;

    /* С текущего товара, а не с начала списка: после восстановления
       сессии кладовщик продолжает с середины, и греть заново то, что он
       уже прошёл, — значит подавать нужное последним. */
    const start = Math.min(Math.max(0, store.currentIndex | 0), order.length - 1);
    const queue = order.slice(start).concat(order.slice(0, start));

    const have = await cachedArticles(network);
    if (token !== warmToken) return;

    /* Пиновка: пока наряд активен, его снимки не вытесняются по лимиту.
       Без этого прогрев наряда крупнее лимита вытесняет сам себя ещё до
       того, как человек дошёл до первой полки. Ответа не ждём. */
    askSw({ type: 'pin-images', network, articles: order });

    const missing = queue.filter(k => k && !have.has(k));
    if (!missing.length) return;                   // всё уже на устройстве — молча
    if (!navigator.onLine) return;                 // в зале без сети греть нечем

    const slow = isSlowLink();
    const plan = slow ? missing.slice(0, SLOW_HEAD) : missing;
    const note = typeof onNote === 'function' ? onNote : () => {};

    note(slow ? `📷 Экономия трафика: греем ${plan.length} ближайших фото`
              : `⏳ Фото товаров: ${plan.length} шт., качаем…`);

    /* Артикул без снимка — не сбой: таких в базе хватает, и отказом сети
       они не считаются. А вот подряд идущие отказы означают, что связь
       кончилась: дальше перебирать наряд бессмысленно, каждый запрос
       будет ждать своего таймаута. */
    let done = 0, empty = 0, streak = 0, lost = false;
    const pool = [...plan];
    const worker = async () => {
        while (pool.length && !lost) {
            if (token !== warmToken) return;
            const key = pool.shift();
            const state = await loadOne(photoUrl(network, key));
            if (state === 'ok')         { done++;  streak = 0; }
            else if (state === 'empty') { empty++; streak = 0; }
            else if (++streak >= FAIL_STREAK) lost = true;
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (token !== warmToken) return;

    if (lost)            note(`📷 Связь пропала, успели загрузить ${done} фото`);
    else if (empty)      note(`📷 Фото готовы: ${done}, без снимка: ${empty}`);
    else                 note(`📷 Фото готовы: ${done}`);
}
