/* ═══════════════════════════════════════════════════════════════════════
   store.js — состояние приложения и его сохранение

   Единый источник истины: товары лежат в Map по ключу `tovar`, а рабочие
   списки — это массивы КЛЮЧЕЙ, не объектов. Благодаря этому идентичность
   переживает JSON-сериализацию и после восстановления сессии не возникает
   расходящихся копий одного товара.
   ═══════════════════════════════════════════════════════════════════════ */

export const SCHEMA_VERSION = 3;

const LS_KEY      = 'wh_session_v3';
const LS_META_KEY = 'wh_session_meta_v3';
const LS_KEY_V2   = 'wh_session_v2';        // читаются только для миграции
const LS_META_V2  = 'wh_session_meta_v2';
const LS_KEY_V1   = 'wh_session_v1';
const LS_META_V1  = 'wh_session_meta_v1';

/* Поля зоны, добавленные схемой v3. Держим в одном месте, чтобы миграция
   и разбор CSV заполняли зону одинаково.
     reason  — идентификатор причины из js/reasons.js
     found   — что оказалось вместо: { barcode, tovar, name, kol } | null
     comment — свободный текст, в отчёт идёт только если непустой         */
export function withV3Fields(zone) {
    if (!('reason' in zone)) zone.reason = null;
    if (!('found'  in zone)) zone.found  = null;
    if (!('comment' in zone)) zone.comment = '';
    return zone;
}

export const store = {
    byId        : new Map(),   // tovar -> Product (единственное место, где лежат данные)
    order       : [],          // ключи активного списка (сужается на «втором круге»)
    initialOrder: [],          // ключи стартового среза — знаменатель прогресса
    currentIndex: 0,
    network     : 'FunDay'
};

export const allProducts    = ()  => [...store.byId.values()];
export const productAt      = (i) => store.byId.get(store.order[i]);
export const currentProduct = ()  => productAt(store.currentIndex);

export function clampIndex(i) {
    if (!store.order.length) return 0;
    return Math.min(Math.max(0, i | 0), store.order.length - 1);
}

/* Товар без участков сканирования проверять нечего — считаем закрытым.
   Прежняя проверка `zones.length > 0 && …` делала его вечно незавершённым,
   и приложение бесконечно крутило «второй круг». */
export function isProductDone(p) {
    if (!p) return true;
    if (!p.zones.length) return true;
    return p.zones.every(z => z.status !== 'waiting');
}

export function countCompleted() {
    return store.order.filter(k => isProductDone(store.byId.get(k))).length;
}

export function findNextIncomplete(from) {
    for (let i = from; i < store.order.length; i++) {
        if (!isProductDone(productAt(i))) return i;
    }
    return -1;
}

export function isSecondRound() {
    return store.order.length < store.initialOrder.length;
}

/* Пересобирает активный список из незавершённых, сохраняя исходный порядок.
   Возвращает false, если незавершённых не осталось. */
export function startSecondRound() {
    const incomplete = new Set(store.order.filter(k => !isProductDone(store.byId.get(k))));
    if (!incomplete.size) return false;
    store.order        = store.initialOrder.filter(k => incomplete.has(k));
    store.currentIndex = 0;
    return true;
}

export function setProducts(products) {
    store.byId        = new Map(products.map(p => [p.tovar, p]));
    store.order       = [];
    store.initialOrder = [];
    store.currentIndex = 0;
}

export function setOrder(keys) {
    store.order        = [...keys];
    store.initialOrder = [...keys];
    store.currentIndex = 0;
}

/* ── Сериализация ──────────────────────────────────────────────────── */
export function serialize() {
    return {
        version     : SCHEMA_VERSION,
        savedAt     : new Date().toISOString(),
        products    : allProducts(),      // данные — ровно один раз
        order       : store.order,        // дальше только ключи
        initialOrder: store.initialOrder,
        currentIndex: store.currentIndex,
        network     : store.network
    };
}

export function deserialize(p) {
    if (!p || !Array.isArray(p.products)) throw new Error('неизвестный формат данных');
    const products = p.products.filter(x => x && x.tovar);
    products.forEach(prod => (prod.zones || []).forEach(withV3Fields));   // добор полей v3
    store.byId = new Map(products.map(x => [x.tovar, x]));
    if (!store.byId.size) throw new Error('в файле нет ни одного товара');

    const known = k => store.byId.has(k);
    store.order        = (p.order        || []).filter(known);
    store.initialOrder = (p.initialOrder || []).filter(known);
    if (!store.order.length)        store.order        = [...store.byId.keys()];
    if (!store.initialOrder.length) store.initialOrder = [...store.order];
    store.currentIndex = clampIndex(p.currentIndex);
    store.network      = p.network || 'FunDay';
}

/* Миграция со схемы v1. Там три массива (rawProducts / filteredProducts /
   initialFilteredList) сериализовались независимо, поэтому один товар мог
   существовать в трёх расходящихся копиях. Для каждого ключа берём копию
   с наибольшим числом обработанных зон — так возвращается максимум
   прогресса, который прежняя схема теряла. */
export function migrateV1(payloadV1) {
    const decided = x => (x.zones || []).filter(z => z.status && z.status !== 'waiting').length;
    const best = new Map();
    [].concat(payloadV1.rawProducts || [], payloadV1.initialFilteredList || [], payloadV1.filteredProducts || [])
      .forEach(x => {
          if (!x || !x.tovar) return;
          const cur = best.get(x.tovar);
          if (!cur || decided(x) > decided(cur)) best.set(x.tovar, x);
      });
    return {
        version     : SCHEMA_VERSION,
        savedAt     : payloadV1.savedAt || null,
        products    : [...best.values()],
        order       : (payloadV1.filteredProducts    || []).map(x => x && x.tovar).filter(Boolean),
        initialOrder: (payloadV1.initialFilteredList || []).map(x => x && x.tovar).filter(Boolean),
        currentIndex: payloadV1.currentIndex || 0,
        network     : 'FunDay'
    };
}

/* Приводит любой поддерживаемый формат (v3 / v2 / v1) к текущей схеме.
   Отличие v2 от v3 — только в наборе полей зоны, поэтому отдельная
   функция миграции не нужна: недостающие поля добирает deserialize(). */
export function normalizePayload(parsed) {
    if (!parsed) return null;
    return Array.isArray(parsed.products) ? parsed : migrateV1(parsed);
}

/* ── Запись и чтение ───────────────────────────────────────────────── */
let saveErrorHandler = null;
let saveOkHandler    = null;
let storageBroken    = false;

export function onSaveError(fn) { saveErrorHandler = fn; }
export function onSaveRecovered(fn) { saveOkHandler = fn; }
export const isStorageBroken = () => storageBroken;

/* Ищем сохранённое от новой схемы к старым */
export function loadStoredPayload() {
    for (const key of [LS_KEY, LS_KEY_V2, LS_KEY_V1]) {
        const raw = localStorage.getItem(key);
        if (raw) return normalizePayload(JSON.parse(raw));
    }
    return null;
}

export function savedAtLabel(payload) {
    const meta = localStorage.getItem(LS_META_KEY)
              || localStorage.getItem(LS_META_V2)
              || localStorage.getItem(LS_META_V1)
              || (payload && payload.savedAt);
    return meta ? new Date(meta).toLocaleString('ru-RU') : 'неизвестно';
}

export function autoSave() {
    if (!store.byId.size) return;
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(serialize()));
        localStorage.setItem(LS_META_KEY, new Date().toISOString());
        if (storageBroken) { storageBroken = false; saveOkHandler && saveOkHandler(); }
    } catch (e) {
        /* Раньше ошибка квоты уходила в console.warn, и пользователь
           продолжал работу в уверенности, что всё сохраняется. */
        console.warn('autoSave failed:', e);
        if (!storageBroken) {
            storageBroken = true;
            saveErrorHandler && saveErrorHandler(e);
        }
    }
}

/* Серия быстрых тапов раньше давала серию полных сериализаций всего
   набора товаров. Запись откладывается и схлопывается в одну. */
let saveTimer = null;
export function scheduleSave(delay = 400) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; autoSave(); }, delay);
}
export function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    autoSave();
}

export function clearSaved() {
    [LS_KEY, LS_META_KEY, LS_KEY_V2, LS_META_V2, LS_KEY_V1, LS_META_V1]
        .forEach(k => localStorage.removeItem(k));
}

/* После успешного переноса в текущую схему старые ключи только занимают
   квоту, а места в localStorage здесь и так в обрез. */
export function clearLegacy() {
    if (!localStorage.getItem(LS_KEY)) return;      // переноса не было — не трогаем
    [LS_KEY_V2, LS_META_V2, LS_KEY_V1, LS_META_V1].forEach(k => localStorage.removeItem(k));
}

export const hasLegacy = () =>
    !!(localStorage.getItem(LS_KEY_V2) || localStorage.getItem(LS_KEY_V1));
