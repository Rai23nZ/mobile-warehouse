/* ═══════════════════════════════════════════════════════════════════════
   sync.js — обмен с сервером синхронизации.

   Работа идёт с мобильного интернета, который то есть, то нет. Поэтому
   отправка результатов НЕ бывает «нажал и надеемся»: отметки копятся в
   очереди, очередь переживает перезагрузку страницы и уходит сама, когда
   связь появляется. Проверяющий видит состояние отправки, а не узнаёт о
   потере в конце смены.

   Адрес сервера не секрет и лежит в открытом коде — так и задумано.
   Право создавать проверки даёт LEAD_KEY, который вводит только ведущий;
   право читать данные смены — код проверки вместе с номером магазина.
   ═══════════════════════════════════════════════════════════════════════ */

/* Несколько адресов, ведущих на один и тот же Worker. Первый — основной,
   остальные — на случай, если конкретный домен окажется недоступен из
   сети пользователя (блокировка по SNI/DNS и т.п.). Все адреса должны
   вести на один и тот же Worker с одной и той же D1-базой — это не
   разные серверы, а разные пути к одному. */
export const API_CANDIDATES = [
    'https://warehouse-sync.ru',
    'https://sync.warehouse-sync.ru',   // резервный route
    // 'https://reserveroute.online',
    'https://second.reserveroute.online',   // резервный route
    'https://api.reserveroute.ru',
    'https://warehouse-sync.cloudflare-uncommon.workers.dev', // как крайний случай
];

export const DEFAULT_API = API_CANDIDATES[0];

const LS_API      = 'wh_api_base';
const LS_QUEUE    = 'wh_sync_queue';
const LS_LEAD_TOK = 'wh_lead_token';       // + код проверки

const REQUEST_TIMEOUT   = 25000;           // мобильная сеть умеет висеть молча
const PROBE_TIMEOUT     = 8000;            // проверка запасных адресов — короче,
                                            // это обычно быстрый отказ (DNS/TCP),
                                            // а не зависание
const BATCH_ROWS        = 100;             // предел сервера на одну отправку
const RETRY_MS          = [3000, 8000, 20000, 45000];

/* Текущий рабочий адрес запоминается на устройстве: один раз найдя
   доступный домен, при следующих запусках сразу идём в него, а не
   перебираем заново с первого. */
let apiBase = localStorage.getItem(LS_API) || DEFAULT_API;
if (!API_CANDIDATES.includes(apiBase)) apiBase = DEFAULT_API;

export const getApiBase = () => apiBase;
export function setApiBase(url) {
    apiBase = (url || DEFAULT_API).replace(/\/+$/, '');
    localStorage.setItem(LS_API, apiBase);
}

/* ── Низкий уровень ────────────────────────────────────────────────── */

class HttpError extends Error {
    constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}
export { HttpError };

/* Один запрос к конкретному адресу base. Ничего не знает о переборе —
   просто пытается достучаться и бросает HttpError(0, ...) при любой
   сетевой проблеме (в отличие от HttpError с ненулевым status — это
   ответ сервера, значит адрес рабочий). */
async function fetchOnce(base, path, { method = 'GET', headers = {}, body, raw = false } = {}, timeout = REQUEST_TIMEOUT) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res;
    try {
        res = await fetch(base + path, { method, headers, body, signal: ac.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new HttpError(0, navigator.onLine
                ? 'Сервер не ответил вовремя. Возможно, его адрес недоступен из этой сети'
                : 'Нет подключения к интернету');
        }
        throw new HttpError(0, navigator.onLine
            ? 'Не удалось связаться с сервером. Проверьте адрес и доступность сети'
            : 'Нет подключения к интернету');
    } finally {
        clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch (e) {}
        throw new HttpError(res.status, msg || `Ошибка сервера ${res.status}`);
    }
    if (raw) return text;
    try { return JSON.parse(text); } catch (e) { return text; }
}

/* Публичный уровень: сначала пробуем текущий рабочий адрес. Если он
   недоступен на СЕТЕВОМ уровне (status === 0 — DNS/TCP/таймаут, а не
   ответ сервера вроде 404/500), пробуем по очереди остальные кандидаты
   с укороченным таймаутом. Как только один сработал — запоминаем его
   как новый рабочий адрес и им же отвечаем на текущий запрос.

   Если ответ пришёл именно ОТ сервера (status !== 0), переключаться
   некуда и незачем: сервер найден, просто вернул ошибку (например,
   протухший токен) — эту ошибку и нужно показать как есть. */
async function request(path, opts = {}) {
    try {
        return await fetchOnce(apiBase, path, opts, REQUEST_TIMEOUT);
    } catch (primaryErr) {
        if (primaryErr.status !== 0) throw primaryErr;
        if (API_CANDIDATES.length < 2) throw primaryErr;

        for (const candidate of API_CANDIDATES) {
            if (candidate === apiBase) continue;
            try {
                const result = await fetchOnce(candidate, path, opts, PROBE_TIMEOUT);
                console.warn(`[sync] ${apiBase} недоступен, переключаюсь на ${candidate}`);
                setApiBase(candidate);
                return result;
            } catch (e) {
                continue; // этот тоже недоступен — пробуем следующий
            }
        }
        /* Ни один адрес не ответил — возвращаем исходную ошибку,
           она честнее всего описывает происходящее («нет сети» /
           «сервер недоступен»). */
        throw primaryErr;
    }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const health = () => request('/health');

/* ── Хранение права ведущего ───────────────────────────────────────────
   Токен живёт только на устройстве ведущего и намеренно НЕ попадает в
   снимок сессии: иначе он уехал бы вместе с выгруженным файлом. */
export const saveLeadToken = (code, token) => localStorage.setItem(LS_LEAD_TOK + '_' + code, token);
export const loadLeadToken = (code) => localStorage.getItem(LS_LEAD_TOK + '_' + code) || '';
export const dropLeadToken = (code) => localStorage.removeItem(LS_LEAD_TOK + '_' + code);

/* ── Ведущий ───────────────────────────────────────────────────────── */

/* assignments: [{ checker, isLead, zoneSpec, items }] — без пулов,
   пулы уходят отдельно кусками */
export async function createSession(leadKey, payload) {
    const res = await request('/session/create', {
        method: 'POST',
        headers: { ...jsonHeaders, 'X-Lead-Key': leadKey },
        body: JSON.stringify(payload)
    });
    if (res && res.code && res.leadToken) saveLeadToken(res.code, res.leadToken);
    return res;
}

/* parts — массив строк, уже нарезанный chunkPool() */
export async function uploadPool(code, leadToken, idx, parts, onProgress) {
    for (let p = 0; p < parts.length; p++) {
        await request(`/session/${code}/pool/${idx}/${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Lead-Token': leadToken },
            body: parts[p]
        });
        onProgress && onProgress(p + 1, parts.length);
    }
}

export const getProgress = (code, leadToken) =>
    request(`/session/${code}/progress`, { headers: { 'X-Lead-Token': leadToken } });

export const closeSession = (code, leadToken) =>
    request(`/session/${code}/close`, { method: 'POST', headers: { 'X-Lead-Token': leadToken } });

export const deleteSession = (code, leadToken) =>
    request(`/session/${code}`, { method: 'DELETE', headers: { 'X-Lead-Token': leadToken } });

/* Результаты выгружаются страницами: смена может дать тысячи строк */
export async function fetchAllResults(code, leadToken, onProgress) {
    const rows = [];
    let offset = 0, total = null;
    do {
        const page = await request(`/session/${code}/results?offset=${offset}&limit=1000`, {
            headers: { 'X-Lead-Token': leadToken }
        });
        total = page.total;
        rows.push(...page.rows);
        offset += page.rows.length;
        onProgress && onProgress(rows.length, total);
        if (!page.rows.length) break;
    } while (rows.length < total);
    return rows;
}

/* ── Проверяющий ───────────────────────────────────────────────────── */

export const getInfo = (code, store) =>
    request(`/session/${code}/info?store=${encodeURIComponent(store)}`);

export const getAssignment = (code, store, idx) =>
    request(`/session/${code}/assignment/${idx}?store=${encodeURIComponent(store)}`);

/* Куски пула склеиваются в общий список товаров */
export async function getPool(code, store, idx, parts, onProgress) {
    const pool = [];
    for (let p = 0; p < parts; p++) {
        const text = await request(
            `/session/${code}/pool/${idx}/${p}?store=${encodeURIComponent(store)}`, { raw: true }
        );
        pool.push(...JSON.parse(text));
        onProgress && onProgress(p + 1, parts);
    }
    return pool;
}

/* ══════════════════════════════════════════════════════════════════════
   ОЧЕРЕДЬ ОТПРАВКИ РЕЗУЛЬТАТОВ
   ══════════════════════════════════════════════════════════════════════ */

let ctx = null;                 // { code, store, idx }
let queue = [];                 // [{ tovar, uch, status, reason, found, comment, at }]
let sending = false;
let retryTimer = null;
let retryStep = 0;
let stateHandler = null;
let lastError = '';

export function onSyncState(fn) { stateHandler = fn; emit(); }

/* Состояние публикуется при изменениях очереди, но вход в наряд происходит
   ПОСЛЕ initQueue — к этому моменту приложение ещё не считает себя внутри
   проверки, и индикатор остаётся пустым. Явный пинок закрывает этот зазор. */
export const refreshSyncState = () => emit();

function emit() {
    if (!stateHandler) return;
    stateHandler({
        pending: queue.length,
        sending,
        online: navigator.onLine,
        error: lastError
    });
}

const queueKey = () => ctx ? `${LS_QUEUE}_${ctx.code}_${ctx.idx}` : null;

function persist() {
    const key = queueKey();
    if (!key) return;
    try {
        if (queue.length) localStorage.setItem(key, JSON.stringify(queue));
        else localStorage.removeItem(key);
    } catch (e) {
        /* Место кончилось. Очередь остаётся в памяти и уйдёт, если связь
           появится до перезагрузки, — но пользователя надо предупредить. */
        console.warn('[sync] очередь не сохранена:', e);
        lastError = 'Не удалось сохранить очередь отправки';
        emit();
    }
}

/* Вызывается при входе в проверку. Поднимает недосланное с прошлого раза. */
export function initQueue(context) {
    ctx = context ? { ...context } : null;
    queue = [];
    retryStep = 0;
    lastError = '';
    const key = queueKey();
    if (key) {
        try { queue = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { queue = []; }
    }
    emit();
    if (queue.length) scheduleFlush(500);
}

export function resetQueue() {
    const key = queueKey();
    if (key) localStorage.removeItem(key);
    ctx = null; queue = []; retryStep = 0; lastError = '';
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    emit();
}

export const queueSize = () => queue.length;
export const syncContext = () => ctx;

/* Одна запись на участок: повторная отметка вытесняет прежнюю,
   отправлять оба состояния незачем. */
export function enqueueZone(tovar, zone) {
    if (!ctx) return;
    const row = {
        tovar,
        uch    : zone.uch,
        status : zone.status,
        reason : zone.reason || null,
        found  : zone.found || null,
        comment: zone.comment || '',
        at     : zone.at || new Date().toISOString()
    };
    const i = queue.findIndex(q => q.tovar === row.tovar && q.uch === row.uch);
    if (i === -1) queue.push(row); else queue[i] = row;
    persist();
    emit();
    scheduleFlush(1500);
}

let flushTimer = null;
function scheduleFlush(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flushQueue(); }, delay);
}

export async function flushQueue(opts = {}) {
    if (!ctx || sending) return { ok: true, sent: 0 };
    if (!queue.length && !opts.state) return { ok: true, sent: 0 };
    if (!navigator.onLine) { emit(); return { ok: false, sent: 0, reason: 'офлайн' }; }

    sending = true; emit();
    let sent = 0;

    try {
        while (queue.length) {
            const batch = queue.slice(0, BATCH_ROWS);
            await request(`/session/${ctx.code}/results?store=${encodeURIComponent(ctx.store)}`, {
                method: 'POST', headers: jsonHeaders,
                body: JSON.stringify({ idx: ctx.idx, rows: batch })
            });
            queue = queue.slice(batch.length);
            sent += batch.length;
            persist();
            emit();
        }
        if (opts.state || opts.startedAt || opts.finishedAt) {
            await request(`/session/${ctx.code}/results?store=${encodeURIComponent(ctx.store)}`, {
                method: 'POST', headers: jsonHeaders,
                body: JSON.stringify({
                    idx: ctx.idx, rows: [],
                    state: opts.state, startedAt: opts.startedAt, finishedAt: opts.finishedAt
                })
            });
        }
        retryStep = 0;
        lastError = '';
        return { ok: true, sent };
    } catch (e) {
        lastError = e.message || 'Ошибка отправки';
        /* 4xx, кроме «слишком много строк», повторять бессмысленно:
           проверка закрыта или код больше не подходит. */
        const hopeless = e.status >= 400 && e.status < 500 && e.status !== 413 && e.status !== 429;
        if (!hopeless) {
            const wait = RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)];
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => { retryTimer = null; flushQueue(); }, wait);
        }
        return { ok: false, sent, error: lastError, hopeless };
    } finally {
        sending = false;
        emit();
    }
}

/* Отправить состояние наряда: начал работу / сдал */
export const sendAssignmentState = (state, times = {}) =>
    flushQueue({ state, startedAt: times.startedAt, finishedAt: times.finishedAt });

/* ── Поводы попробовать ещё раз ────────────────────────────────────── */
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { retryStep = 0; flushQueue(); });
    window.addEventListener('offline', emit);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') flushQueue();
    });
    /* Редкий фоновый пинок: связь может вернуться без события online
       (например, сменилась вышка) */
    setInterval(() => { if (queue.length) flushQueue(); }, 60000);
}
