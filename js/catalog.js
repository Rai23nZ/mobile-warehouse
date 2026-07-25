/* ═══════════════════════════════════════════════════════════════════════
   catalog.js — справочник товаров сети: поиск артикула по штрихкоду.

   База естественным образом разделена по сетям, а сеть выбирается на
   экране маршрута, поэтому в память попадает только нужный файл
   (25–50 тыс. строк вместо всей базы). Никакого шага сборки: обновление
   базы — это замена файла в data/.

   Разобранный индекс кладётся в IndexedDB вместе с размером и датой
   исходного файла. При следующем запуске они сверяются: файл не менялся —
   индекс поднимается готовым; изменился — переиндексация идёт сама.

   Формат data/{Сеть}.csv:
       артикул;наименование;ШК_1;ШК_2;…
   Число колонок со штрихкодами произвольное — всё, что правее
   наименования, считается штрихкодами.
   ═══════════════════════════════════════════════════════════════════════ */

import { parseCsv, cleanValue, findHeaderIndex } from './csv.js';

const DB_NAME    = 'wh_catalog';
const DB_VERSION = 1;
const STORE      = 'indexes';

const state = {
    network: null,
    byBarcode: new Map(),      // ШК -> { tovar, name }
    ready: false,
    size: 0                    // число артикулов
};

export const isReady        = () => state.ready;
export const catalogNetwork = () => state.network;
export const catalogSize    = () => state.size;

/* ── IndexedDB: одна запись на сеть ────────────────────────────────────
   Индекс хранится единым массивом пар, а не отдельными записями на
   штрихкод: одна операция чтения вместо ста тысяч. */
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'network' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function idbGet(network) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(network);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => reject(req.error);
        });
    } catch (e) { console.warn('[catalog] чтение кэша:', e); return null; }
}

async function idbPut(record) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(record);
            tx.oncomplete = resolve;
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) { console.warn('[catalog] запись кэша:', e); }
}

export async function clearCache() {
    try {
        const db = await openDb();
        await new Promise(resolve => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = resolve;
            tx.onerror    = resolve;
        });
    } catch (e) { /* нечего чистить */ }
}

/* ── Разбор файла ──────────────────────────────────────────────────── */
function buildIndex(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { entries: [], products: 0 };

    // Заголовок распознаём мягко: если первая строка на него не похожа,
    // считаем колонки позиционными (артикул, наименование, ШК…).
    const head    = rows[0];
    const iTovar  = findHeaderIndex(head, ['артикул', 'код товара', 'код', 'товар']);
    const iName   = findHeaderIndex(head, ['наименование', 'название']);
    const hasHead = iTovar !== -1 || iName !== -1;

    const colTovar = hasHead && iTovar !== -1 ? iTovar : 0;
    const colName  = hasHead && iName  !== -1 ? iName  : 1;
    const firstBc  = Math.max(colTovar, colName) + 1;

    const entries = [];
    const seenArticles = new Set();

    for (let r = hasHead ? 1 : 0; r < rows.length; r++) {
        const cells = rows[r];
        const tovar = cleanValue(cells[colTovar]);
        if (!tovar) continue;
        const name = cleanValue(cells[colName]);
        seenArticles.add(tovar);

        // всё правее наименования — штрихкоды, сколько бы их ни было
        for (let c = firstBc; c < cells.length; c++) {
            const bc = normalizeBarcode(cells[c]);
            if (bc) entries.push([bc, { tovar, name }]);
        }
    }
    return { entries, products: seenArticles.size };
}

/* Сканер и файл базы могут разойтись в мелочах: пробелы, ведущие нули,
   неразрывные пробелы из Excel. Приводим к одному виду с обеих сторон. */
export function normalizeBarcode(raw) {
    return cleanValue(raw).replace(/[\s ‑-]/g, '');
}

/* ── Загрузка ──────────────────────────────────────────────────────────
   Кэш отдаётся СРАЗУ, а версия файла сверяется фоном. Обратный порядок
   (сначала спросить сеть, потом отдать кэш) означал бы, что офлайн база
   недоступна ровно столько, сколько браузер отваливает неудачный запрос,
   — а офлайн здесь основной режим работы.

   Возвращает { ok, products, cached, reason }. Отсутствие файла ошибкой
   не считается: у сети может просто ещё не быть базы (как у Demix). */
export async function loadForNetwork(network, onProgress) {
    if (state.ready && state.network === network) {
        return { ok: true, products: state.size, cached: true };
    }
    state.network   = network;
    state.byBarcode = new Map();
    state.ready     = false;
    state.size      = 0;

    const cached = await idbGet(network);
    if (cached) {
        state.byBarcode = new Map(cached.entries);
        state.size      = cached.products;
        state.ready     = true;
        refreshInBackground(network, cached, onProgress);   // намеренно без await
        return { ok: true, products: cached.products, cached: true };
    }
    return fetchAndIndex(network, onProgress);
}

/* HEAD с таймаутом: без него офлайн-запрос висит до собственного
   истечения браузера и задерживает всё, что за ним стоит. */
async function headMeta(url, timeoutMs = 4000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(url, { method: 'HEAD', signal: ac.signal });
        if (!r.ok) return { missing: true };
        return {
            size    : r.headers.get('content-length') || '',
            modified: r.headers.get('last-modified')  || ''
        };
    } catch (e) {
        return null;                                   // офлайн либо таймаут
    } finally {
        clearTimeout(timer);
    }
}

/* Сверка версии файла с тем, из чего собран кэш. Файл не изменился,
   недоступен или удалён — молча оставляем то, что уже работает. */
async function refreshInBackground(network, cached, onProgress) {
    const meta = await headMeta(`data/${network}.csv`);
    if (!meta || meta.missing) return;
    if (meta.size === cached.size && meta.modified === cached.modified) return;
    if (state.network !== network) return;             // пользователь успел сменить сеть
    await fetchAndIndex(network, onProgress, meta);
}

async function fetchAndIndex(network, onProgress, knownMeta) {
    const url = `data/${network}.csv`;
    try {
        onProgress && onProgress('Загрузка базы товаров…');
        const res = await fetch(url);
        if (!res.ok) {
            state.ready = true;
            return { ok: false, products: 0, cached: false, reason: 'нет файла ' + url };
        }
        const meta = knownMeta || {
            size    : res.headers.get('content-length') || '',
            modified: res.headers.get('last-modified')  || ''
        };
        const text = await res.text();

        onProgress && onProgress('Индексация базы товаров…');
        await new Promise(r => setTimeout(r, 0));      // даём кадру отрисоваться
        const { entries, products } = buildIndex(text);

        if (state.network !== network) return { ok: false, products: 0, cached: false, reason: 'сеть сменилась' };
        state.byBarcode = new Map(entries);
        state.size      = products;
        state.ready     = true;

        await idbPut({ network, size: meta.size, modified: meta.modified, products, entries });
        return { ok: true, products, cached: false };
    } catch (e) {
        console.warn('[catalog] загрузка:', e);
        state.ready = true;                            // офлайн и без кэша — «ШК нет»
        return { ok: false, products: 0, cached: false, reason: e.message };
    }
}

/* Поиск. Возвращает { tovar, name } либо null, если такого ШК нет. */
export function findByBarcode(barcode) {
    const bc = normalizeBarcode(barcode);
    if (!bc) return null;
    return state.byBarcode.get(bc) || null;
}
