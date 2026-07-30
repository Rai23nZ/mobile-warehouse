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

/* Адреса сервера синхронизации, в порядке предпочтения.

   ВНИМАНИЕ: это НЕ разные пути к одному серверу. Первый адрес — своя
   машина в Москве со своей базой SQLite; остальные ведут на Worker в
   Cloudflare со своей базой D1. Данные между ними не общие: смена,
   созданная на одном, на другом не существует.

   Пока первый адрес отвечает, до остальных дело не доходит. Но если он
   станет недоступен посреди работы, приложение уйдёт на Cloudflare и
   получит «Проверка не найдена». Правильное решение — запоминать, на
   каком адресе живёт конкретная смена, и держаться его; перебор оставить
   только для поиска проверки по коду и для создания новой.

   `api.reserveroute.ru` убран: домен reserveroute.ru переводится под
   GitHub Pages для sklad.reserveroute.ru, и маршрут Worker на нём
   больше не поддерживается. */
export const API_CANDIDATES = [
    'https://ru.warehouse-sync.ru',           // своя машина, Москва — основной
    'https://warehouse-sync.ru',              // Cloudflare Worker
    'https://sync.warehouse-sync.ru',         // он же, запасной маршрут
    'https://second.reserveroute.online',     // он же, запасной маршрут
    'https://warehouse-sync.cloudflare-uncommon.workers.dev'  // крайний случай
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
        /* Устройство внутри смены: запасные адреса ей не помогут — там
           другая база, и этой проверки в ней нет. Перебор дал бы только
           четыре подряд таймаута перед тем же самым отказом. */
        if (pinnedApi) throw primaryErr;

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

/* ── Явный перебор адресов ─────────────────────────────────────────────
   Адреса нигде не показываются: пользователю видны только номер по
   порядку и результат. Перебор идёт строго по списку, чтобы номер в
   счётчике всегда означал одно и то же.

   onStep(номер, всего, состояние) — состояние: 'probing' | 'ok' | 'fail'
   Возвращает { ok, index, total }. Первый ответивший адрес становится
   текущим. */
export async function probeServers(onStep) {
    /* Внутри живой смены перебирать нечего. На /health отвечают все
       адреса, поэтому «нашли рабочий сервер» означало бы тихий переезд в
       чужую базу — и проверка, целая на своём сервере, переставала
       находиться. Проверяем только тот адрес, где смена живёт. */
    const list  = pinnedApi ? [pinnedApi] : API_CANDIDATES;
    const total = API_CANDIDATES.length;   // номер по-прежнему означает место в общем списке

    for (const base of list) {
        const num = API_CANDIDATES.indexOf(base) + 1;
        onStep && onStep(num, total, 'probing');
        try {
            const res = await fetchOnce(base, '/health', {}, PROBE_TIMEOUT);
            if (!res || res.ok !== true) throw new HttpError(0, 'не похоже на наш сервер');
            setApiBase(base);
            serverConfirmed = true;
            onStep && onStep(num, total, 'ok');
            return { ok: true, index: num, total, info: res };
        } catch (e) {
            onStep && onStep(num, total, 'fail');
        }
    }
    serverConfirmed = false;
    return { ok: false, index: 0, total, pinned: !!pinnedApi };
}

/* Флаг «в этом запуске приложения рабочий адрес уже подтверждён» —
   чтобы не гонять полный перебор перед каждым действием. */
let serverConfirmed = false;
export const isServerConfirmed = () => serverConfirmed;

/* Перед важным действием: если адрес ещё не подтверждён, пробуем текущий
   одним быстрым запросом, и лишь при неудаче перебираем остальные. */
export async function ensureServer(onStep) {
    if (serverConfirmed) return { ok: true, index: API_CANDIDATES.indexOf(apiBase) + 1, total: API_CANDIDATES.length };
    try {
        const res = await fetchOnce(apiBase, '/health', {}, PROBE_TIMEOUT);
        if (res && res.ok === true) {
            serverConfirmed = true;
            return { ok: true, index: API_CANDIDATES.indexOf(apiBase) + 1, total: API_CANDIDATES.length };
        }
    } catch (e) { /* переходим к полному перебору */ }
    return probeServers(onStep);
}

/* ── Хранение права ведущего ───────────────────────────────────────────
   Токен живёт только на устройстве ведущего и намеренно НЕ попадает в
   снимок сессии: иначе он уехал бы вместе с выгруженным файлом. */
export const saveLeadToken = (code, token) => localStorage.setItem(LS_LEAD_TOK + '_' + code, token);
export const loadLeadToken = (code) => localStorage.getItem(LS_LEAD_TOK + '_' + code) || '';
export const dropLeadToken = (code) => localStorage.removeItem(LS_LEAD_TOK + '_' + code);

/* ── Реестр проверок, которые ведёт это устройство ─────────────────────
   Токен без кода бесполезен, а код нигде не хранился: он существовал
   только в имени ключа `wh_lead_token_<КОД>` и в оперативной памяти
   вкладки. Стоило странице перезагрузиться — и сводка становилась
   недостижимой, хотя право на неё лежало тут же, в localStorage.

   Здесь же запоминается АДРЕС сервера. Базы у адресов раздельные, смена
   с одного на другом не существует, и без этой записи восстановление
   упиралось бы в «Проверка не найдена» на исправном сервере с целыми
   данными. */
const LS_LEAD_BOARDS  = 'wh_lead_boards';
const MAX_LEAD_BOARDS = 5;

function readLeadBoards() {
    try {
        const list = JSON.parse(localStorage.getItem(LS_LEAD_BOARDS) || '[]');
        return Array.isArray(list) ? list.filter(x => x && x.code) : [];
    } catch (e) { return []; }
}

function writeLeadBoards(list) {
    try { localStorage.setItem(LS_LEAD_BOARDS, JSON.stringify(list.slice(0, MAX_LEAD_BOARDS))); }
    catch (e) { console.warn('[sync] реестр проверок не сохранён:', e); }
}

/* rec: { code, store, network, mode, leadName }. Адрес и время проставляем
   сами — вызывающему их знать незачем. */
export function rememberLeadSession(rec) {
    if (!rec || !rec.code) return;
    const entry = { ...rec, api: apiBase, savedAt: new Date().toISOString() };
    writeLeadBoards([entry, ...readLeadBoards().filter(x => x.code !== rec.code)]);
}

export const leadSessions = () => readLeadBoards();
export const leadSessionByCode = (code) => readLeadBoards().find(x => x.code === code) || null;

export function forgetLeadSession(code) {
    writeLeadBoards(readLeadBoards().filter(x => x.code !== code));
}

/* ── Привязка к адресу ─────────────────────────────────────────────────
   Пока устройство внутри конкретной смены, уходить на другой адрес
   нельзя: там своя база и свой набор проверок. Перебор остаётся доступен
   для поиска и создания, но увести живую смену он больше не может. */
let pinnedApi = null;

export function pinApi(url) {
    if (!url) return;
    const next = url.replace(/\/+$/, '');
    if (next !== apiBase) { setApiBase(next); serverConfirmed = false; }
    pinnedApi = next;
}
export function unpinApi() { pinnedApi = null; }
export const pinnedApiBase = () => pinnedApi;

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

/* Восстановление права на свою проверку по ключу ведущего. Нужно, когда
   токена на устройстве нет: сменился ноутбук, стёрты данные сайта, смена
   создавалась не отсюда. Возвращает тот же токен и заодно сохраняет его. */
export async function reclaimSession(code, store, leadKey) {
    const res = await request(`/session/${code}/reclaim?store=${encodeURIComponent(store)}`, {
        method: 'POST', headers: { 'X-Lead-Key': leadKey }
    });
    if (res && res.leadToken) saveLeadToken(code, res.leadToken);
    return res;
}

/* Список проверок магазина — для ведущего, забывшего код */
export const listSessions = (store, leadKey) =>
    request(`/sessions?store=${encodeURIComponent(store)}`, { headers: { 'X-Lead-Key': leadKey } });

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

/* Поиск проверки по всем адресам.

   Единственное место, где перебор уместен и обязателен. Смена живёт на
   одном конкретном сервере, у остальных своя база; обычный request() при
   404 никуда не переключается — и правильно делает, иначе он терял бы
   смену на ровном месте. Но когда проверку ищут ПО КОДУ, опросить нужно
   всех: иначе ведущий, создавший смену на московской машине, и
   проверяющий, чьё устройство помнит адрес Cloudflare, никогда не
   встретятся.

   Найденный адрес закрепляется: дальше устройство работает только с ним. */
export async function findSessionAnywhere(code, store, onStep) {
    const order = [apiBase, ...API_CANDIDATES.filter(b => b !== apiBase)];
    const total = API_CANDIDATES.length;
    let lastErr = null;

    for (const base of order) {
        const num = API_CANDIDATES.indexOf(base) + 1;
        onStep && onStep(num, total, 'probing');
        try {
            const info = await fetchOnce(
                base, `/session/${code}/info?store=${encodeURIComponent(store)}`, {}, PROBE_TIMEOUT);
            onStep && onStep(num, total, 'ok');
            pinApi(base);
            serverConfirmed = true;
            return { info, api: base };
        } catch (e) {
            /* 403 — код существует, но не подходит к магазину. Это ответ
               по существу, а не «не тот сервер»: продолжать перебор
               бессмысленно, а сообщение полезно показать как есть. */
            if (e.status === 403) throw e;
            lastErr = e;
            onStep && onStep(num, total, 'fail');
        }
    }
    throw lastErr || new HttpError(404, 'Проверка не найдена ни на одном сервере.');
}

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
    if (ctx && ctx.api) pinApi(ctx.api);
    const key = queueKey();
    if (key) {
        try { queue = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { queue = []; }
    }
    emit();
    if (queue.length) scheduleFlush(500);
}

/* Поднять очередь под уже восстановленную сессию, если она ещё не поднята.

   Без этого перезагрузка страницы посреди наряда означала тихую потерю
   работы: store.session возвращался из localStorage, приложение считало
   себя внутри проверки, а очередь оставалась без контекста — enqueueZone
   выходил на первой же строке, отметки никуда не уходили, и при этом
   индикатор показывал «отправлено», потому что в очереди действительно
   было пусто. Заодно поднимается всё, что не успело уйти до перезагрузки. */
export function ensureQueue(context) {
    if (!context || !context.code) return;
    if (ctx && ctx.code === context.code && ctx.idx === context.idx) {
        if (context.api) pinApi(context.api);
        emit();
        return;
    }
    initQueue(context);
}

export function resetQueue() {
    const key = queueKey();
    if (key) localStorage.removeItem(key);
    ctx = null; queue = []; retryStep = 0; lastError = '';
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    unpinApi();
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
