/* ═══════════════════════════════════════════════════════════════════════
   app.js — точка входа: импорт, фильтры, рендер, навигация, выгрузка.
   ═══════════════════════════════════════════════════════════════════════ */

import {
    store, allProducts, currentProduct, isProductDone, countCompleted,
    findNextIncomplete, isSecondRound, startSecondRound,
    setProducts, setOrder, clampIndex,
    serialize, deserialize, normalizePayload, loadStoredPayload, savedAtLabel,
    autoSave, scheduleSave, flushSave, clearSaved, clearLegacy, hasLegacy,
    onSaveError, onSaveRecovered, isStorageBroken,
    inSession, zoneModeUch, setSession, setPoolFromServer
} from './store.js';

import {
    enqueueZone, initQueue, onSyncState, refreshSyncState,
    flushQueue, resetQueue, sendAssignmentState
} from './sync.js';
import * as lead from './lead.js';

import {
    buildProducts, buildReport, compareProductsForRoute, HEADER_TITLES
} from './csv.js';

import { REASONS, reasonLabel, reasonNeedsScan, NO_ARTICLE } from './reasons.js';
import { loadForNetwork, findByBarcode, normalizeBarcode, catalogSize } from './catalog.js';
import { scanBarcode, cancelScan, toggleTorch, isScannerOpen } from './scanner.js';

import {
    el, cacheDom, showScreen, getScreen, defaultBadgeFor, setStatusBadge,
    openModal, closeModal, isModalOpen, anyModalOpen,
    showToast, showError, hideError, showLoading, hideLoading,
    svgIcon, toggleImageZoom, isZoomOpen,
    stamp, downloadBlob, escapeHtml, bindActions
} from './ui.js';

/* ── Регистрация Service Worker ───────────────────────────────────── */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .catch(err => console.warn('Ошибка регистрации Service Worker:', err));

    /* Обновление оболочки: страница могла загрузиться с новым index.html,
       но со старыми модулями из кэша прежней версии. Перезагружаемся, чтобы
       код и разметка снова были одной версии. Флаг в sessionStorage не даёт
       зациклиться, если что-то пойдёт не так. */
    navigator.serviceWorker.addEventListener('message', ev => {
        if (!ev.data || ev.data.type !== 'sw-updated') return;
        const seen = sessionStorage.getItem('wh_sw_reloaded');
        if (seen === ev.data.version) return;
        sessionStorage.setItem('wh_sw_reloaded', ev.data.version);

        /* Посреди проверки не дёргаем: сначала дописываем несохранённое */
        if (getScreen() === 'work') {
            flushSave();
            showToast('Установлено обновление. Перезагрузите приложение, когда будет удобно.', 8000);
            return;
        }
        location.reload();
    });
}

/* ══════════════════════════════════════════════════════════════════════
   PIN-КОД ЗАПУСКА

   Это не защита данных, а заслон от случайного запуска посторонним:
   хеш лежит в открытом коде и обходится за секунды, а сами данные всё
   равно приходят из файла пользователя и никуда не отправляются.
   Экран назван соответственно, чтобы не создавать ложного впечатления.
   ══════════════════════════════════════════════════════════════════════ */
// ОБНОВЛЕНО: Новый хэш для пин-кода 2026
const AUTH_HASH = '158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab';

async function sha256(message) {
    const buf  = new TextEncoder().encode(message);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkAuth() {
    const input = el['auth-password'].value.trim();
    if (!input) return;
    if (await sha256(input) === AUTH_HASH) {
        sessionStorage.setItem('wh_auth_passed', 'true');
        el['auth-error'].classList.add('hidden');
        goToUploadScreen(true);
    } else {
        el['auth-error'].classList.remove('hidden');
        el['auth-password'].value = '';
        el['auth-password'].focus();
    }
}

/* ── Переходы между экранами ──────────────────────────────────────── */

/* Кнопка «домой». Если работа шла по наряду от ведущего, уводим на выбор
   роли: возвращаться к загрузке своего файла посреди смены незачем. */
function goToUploadScreen(skipConfirm = false) {
    if (!skipConfirm && getScreen() === 'work' &&
        !confirm('Вернуться на стартовый экран? Текущий прогресс проверки будет сохранён.')) return;
    flushSave();
    if (inSession()) flushQueue();

    if (lead.boardContext()) { lead.showBoard(lead.boardContext().code, lead.boardContext()); return; }
    if (inSession()) { lead.showRoleScreen(resumeLabel()); return; }
    showScreen('upload');
    setStatusBadge(defaultBadgeFor('upload'));
    checkRestorable();
}

/* Подпись для баннера «есть незаконченная работа» на экране выбора роли */
function resumeLabel() {
    try {
        const p = loadStoredPayload();
        if (!p) return null;
        const who = p.session ? `${p.session.checker}, магазин ${p.session.store}` : 'свой файл';
        return `${who} · ${p.products.length} товаров · ${savedAtLabel(p)}`;
    } catch (e) { return null; }
}

/* Пул пришёл с сервера — входим в рабочий экран по наряду */
function onPoolReady(pool, session) {
    setPoolFromServer(pool, session);
    autoSave();
    refreshSyncState();          // теперь inSession() истинно — индикатор оживает
    goToWorkScreen();
    showToast(`Наряд «${session.checker}»: ${pool.length} артикулов`, 3000);
}

/* ── Индикатор отправки ───────────────────────────────────────────── */
function paintSyncBadge(s) {
    const b = el['sync-badge'];
    if (!b) return;
    if (!inSession()) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');

    let text, cls;
    if (!s.online)       { text = 'нет сети';            cls = 'bg-amber-500'; }
    else if (s.sending)  { text = 'отправка…';           cls = 'bg-indigo-400'; }
    else if (s.pending)  { text = 'ждёт ' + s.pending;   cls = 'bg-amber-500'; }
    else if (s.error)    { text = 'сбой отправки';       cls = 'bg-rose-600'; }
    else                 { text = 'отправлено';          cls = 'bg-emerald-600'; }

    b.textContent = text;
    b.className = 'text-[10px] px-1.5 py-1 rounded-full font-medium whitespace-nowrap ' + cls;
    b.title = s.error || 'Отправка результатов ведущему';
}

function goToWorkScreen() {
    showScreen('work');
    setStatusBadge(isStorageBroken() ? 'НЕ СОХРАНЯЕТСЯ' : defaultBadgeFor('work'), isStorageBroken());
    renderProduct();
    prepareCatalog();       // справочник ШК нужен и после восстановления сессии
}

/* ── Восстановление сессии ────────────────────────────────────────── */
function checkRestorable() {
    try {
        const payload = loadStoredPayload();
        if (!payload) { el['restore-banner'].classList.add('hidden'); return; }
        el['restore-info'].textContent =
            `Сохранено: ${savedAtLabel(payload)} · товаров: ${payload.products.length}`;
        el['restore-banner'].classList.remove('hidden');
    } catch (e) {
        console.warn('checkRestorable:', e);
    }
}

function restoreSession() {
    try {
        const payload = loadStoredPayload();
        if (!payload) return showToast('Нет данных для восстановления');
        const wasLegacy = hasLegacy();
        deserialize(payload);
        el['restore-banner'].classList.add('hidden');
        autoSave();                          // сразу перезаписываем в схеме v2
        if (wasLegacy) clearLegacy();        // старые ключи только занимают квоту
        goToWorkScreen();
        showToast(wasLegacy ? '✅ Сессия восстановлена и перенесена в новый формат'
                            : '✅ Сессия восстановлена', 2500);
    } catch (e) {
        showToast('Ошибка восстановления: ' + e.message, 5000);
    }
}

function clearSavedSession() {
    clearSaved();
    el['restore-banner'].classList.add('hidden');
    showToast('Сохранённый прогресс удалён');
}

function saveSessionSnapshot() {
    if (!store.byId.size) { showToast('Нет данных для сохранения'); return; }
    try {
        downloadBlob(JSON.stringify(serialize(), null, 2), 'application/json',
                     `wh_session_${stamp()}.json`);
        showToast('💾 Снимок сессии сохранён', 2500);
    } catch (e) {
        showToast('Ошибка сохранения: ' + e.message);
    }
}

/* ── Импорт ───────────────────────────────────────────────────────── */
async function handleCsvSelect(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    showLoading(); hideError();
    try {
        const { headers, idx, products, stats } = buildProducts(await file.text());
        setProducts(products);
        hideLoading();
        showScreen('filter');
        setStatusBadge(defaultBadgeFor('filter'));
        renderImportSummary(headers, idx, stats);
        populateFilters();
    } catch (err) {
        showError(err.message);
    } finally {
        ev.target.value = '';                // позволяет выбрать тот же файл повторно
    }
}

/* Обработчик, которого раньше не существовало: ссылка на него в
   инициализации роняла весь DOMContentLoaded, из-за чего не работала ни
   загрузка снимка, ни баннер восстановления после перезагрузки. */
async function handleSessionFileSelect(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    showLoading(); hideError();
    try {
        deserialize(normalizePayload(JSON.parse(await file.text())));
        hideLoading();
        autoSave();
        goToWorkScreen();
        showToast(`✅ Снимок загружен: ${store.order.length} товаров`, 3000);
    } catch (err) {
        showError('Не удалось прочитать снимок сессии: ' + err.message);
    } finally {
        ev.target.value = '';
    }
}

/* Сводка импорта: ошибка сопоставления колонок раньше обнаруживалась
   только по мусору на рабочем экране, когда работа уже шла. */
function renderImportSummary(headers, idx, stats) {
    const box = el['import-summary'];
    if (!box) return;

    const mapped = Object.keys(HEADER_TITLES).map(k => {
        const found = idx[k] !== -1;
        return `<li class="flex justify-between gap-2">
                  <span class="text-slate-500">${HEADER_TITLES[k]}</span>
                  <span class="${found ? 'text-slate-800 font-semibold' : 'text-rose-600 font-semibold'}">
                    ${found ? escapeHtml(headers[idx[k]]) : 'не найден'}
                  </span>
                </li>`;
    }).join('');

    box.innerHTML = `
        <div class="font-bold text-sm text-slate-900 mb-2">Файл разобран</div>
        <div class="text-xs text-slate-600 mb-3">
            Артикулов: <b>${stats.products}</b> · строк с участками: <b>${stats.zoneRows}</b>
            ${stats.skipped ? ` · пропущено строк без артикула: <b>${stats.skipped}</b>` : ''}
            ${stats.noZones ? `<br><span class="text-amber-700">Без участков сканирования: <b>${stats.noZones}</b> — они сразу считаются закрытыми.</span>` : ''}
        </div>
        <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Сопоставление колонок</div>
        <ul class="text-xs space-y-1">${mapped}</ul>`;
    box.classList.remove('hidden');
}

/* ── Фильтры ──────────────────────────────────────────────────────── */
function populateFilters() {
    const selNapr = el['filter-napravlenie'], selTm = el['filter-tm'], selPol = el['filter-pol'];

    const refreshSelect = (sel, values) => {
        const prev = sel.value;
        sel.innerHTML = '<option value="">-- Все позиции --</option>';
        [...values].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).forEach(v => {
            const opt = document.createElement('option');
            opt.value = opt.textContent = v;
            sel.appendChild(opt);
        });
        if ([...values].includes(prev)) sel.value = prev;
    };

    const rebuild = () => {
        const napr = selNapr.value, tm = selTm.value, pol = selPol.value;
        const filtered = allProducts().filter(p =>
            (!napr || p.napr === napr) && (!tm || p.tm === tm) && (!pol || p.pol === pol));
        const sets = { napr: new Set(), tm: new Set(), pol: new Set() };
        filtered.forEach(p => { sets.napr.add(p.napr); sets.tm.add(p.tm); sets.pol.add(p.pol); });
        refreshSelect(selNapr, sets.napr);
        refreshSelect(selTm,   sets.tm);
        refreshSelect(selPol,  sets.pol);
    };

    const all = { napr: new Set(), tm: new Set(), pol: new Set() };
    allProducts().forEach(p => { all.napr.add(p.napr); all.tm.add(p.tm); all.pol.add(p.pol); });
    refreshSelect(selNapr, all.napr);
    refreshSelect(selTm,   all.tm);
    refreshSelect(selPol,  all.pol);

    [selNapr, selTm, selPol].forEach(s => {
        s.removeEventListener('change', rebuild);
        s.addEventListener('change', rebuild);
    });
}

function startVerification() {
    const napr = el['filter-napravlenie'].value;
    const tm   = el['filter-tm'].value;
    const pol  = el['filter-pol'].value;
    store.network = document.querySelector('input[name="network"]:checked').value;

    const list = allProducts()
        .filter(p => (!napr || p.napr === napr) && (!tm || p.tm === tm) && (!pol || p.pol === pol))
        .sort(compareProductsForRoute);

    if (!list.length) { showToast('Нет товаров по этому фильтру!'); return; }

    setOrder(list.map(p => p.tovar));
    autoSave();
    goToWorkScreen();
    preloadImages(store.order);
}

/* Справочник грузится в фоне: он нужен только при первом расхождении,
   а до него у кладовщика обычно есть время. Отсутствие файла ошибкой не
   считается — у сети может ещё не быть базы. */
async function prepareCatalog() {
    const res = await loadForNetwork(store.network, msg => showToast(msg, 4000));
    if (res.ok && !res.cached) showToast(`📚 База ${store.network}: ${res.products} артикулов`, 2500);
    else if (!res.ok) console.warn('[catalog]', res.reason);
}

/* ── Изображения ──────────────────────────────────────────────────── */
const ASSET_VERSION = '25_07_2026';
const imgUrl   = tovar => `img/${store.network}/${tovar}.jpg?v=${ASSET_VERSION}`;
const emptyUrl = ()    => `img/empty.jpg?v=${ASSET_VERSION}`;

/* Предзагрузка теперь идёт по тому же URL, что и рендер (раньше отличалась
   на `?v=`, из-за чего каждая картинка качалась дважды), и с ограничением
   параллелизма — иначе тысячи одновременных запросов забивают канал ровно
   в тот момент, когда пользователь начинает работать. */
async function preloadImages(keys, concurrency = 6) {
    new Image().src = emptyUrl();
    const queue = [...keys];
    if (!queue.length) return;
    showToast('⏳ Оптимизация медиа…');
    const worker = async () => {
        while (queue.length) {
            const key = queue.shift();
            await new Promise(done => {
                const im = new Image();
                im.onload = im.onerror = done;
                im.src = imgUrl(key);
            });
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
}

/* ══════════════════════════════════════════════════════════════════════
   РЕНДЕР

   Отметка участка правит только свою строку. Прежний вариант делал
   zones-list.innerHTML = '' и пересобирал список целиком: на каждом тапе
   прокрутка съезжала наверх, и у товара с десятком участков пользователь
   заново искал своё место.
   ══════════════════════════════════════════════════════════════════════ */
const ZONE_ROW_BASE = 'work-zone-row zone-item flex items-center justify-between border-2 rounded-xl transition ';
const ZONE_BORDER = {
    confirmed    : 'border-emerald-500 bg-emerald-50/50',
    not_confirmed: 'border-rose-500 bg-rose-50',
    waiting      : 'border-slate-200'
};

let zoneRows = [];          // [{ row, btnCheck, btnReject }] — параллельно p.zones
let autoAdvanceTimer = null;

function renderProduct() {
    const p = currentProduct();
    if (!p) return;

    const img = el['view-image'];
    if (img && p.tovar) {
        img.onerror = function () { this.src = emptyUrl(); this.onerror = null; };
        img.src = imgUrl(p.tovar);
        img.alt = `Фото товара ${p.tovar}`;
    }

    const second = isSecondRound();
    el['incomplete-banner'].classList.toggle('hidden', !second);
    if (second) {
        el['incomplete-banner-text'].textContent =
            `Незавершённых: ${store.order.length} из ${store.initialOrder.length}`;
    }

    el['view-napr'].textContent    = p.napr || '—';
    el['view-pol'].textContent     = p.pol  || '—';
    el['view-tm-name'].textContent = p.tm   || '—';
    el['view-tovar'].textContent   = p.tovar;
    el['view-name'].textContent    = p.name || '—';
    el['view-name'].title          = p.name || '';
    el['count-plan'].textContent   = p.ost_plan;

    renderZones(p);
    updateTotals();
    updateProgress();
}

function renderZones(p) {
    const container = el['zones-list'];
    container.textContent = '';
    zoneRows = [];

    if (!p.zones.length) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-slate-400 text-center p-4';
        empty.textContent = 'У этой позиции нет участков сканирования — проверять нечего';
        container.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    p.zones.forEach((z, i) => {
        const row = document.createElement('div');

        const left = document.createElement('div');
        left.className = 'text-sm text-slate-700';
        left.textContent = 'Участок: ';
        const strong = document.createElement('strong');
        strong.textContent = z.uch;
        left.appendChild(strong);

        const right = document.createElement('div');
        right.className = 'flex gap-2';

        const btnCheck = document.createElement('button');
        btnCheck.type = 'button';
        btnCheck.addEventListener('click', () => toggleZone(i));

        const btnReject = document.createElement('button');
        btnReject.type = 'button';
        btnReject.className = 'p-1.5 text-rose-500';
        btnReject.title = 'Отметить расхождение';
        btnReject.setAttribute('aria-label', `Отметить расхождение по участку ${z.uch}`);
        btnReject.appendChild(svgIcon('i-cancel', 20));
        btnReject.addEventListener('click', () => openDiscrepancyModal(i));

        right.append(btnCheck, btnReject);
        row.append(left, right);
        frag.appendChild(row);

        zoneRows.push({ row, btnCheck, btnReject });
        paintZone(i, z);
    });
    container.appendChild(frag);
}

/* Точечная перерисовка одной строки — прокрутка не трогается */
function paintZone(i, zone) {
    const refs = zoneRows[i];
    const z    = zone || currentProduct()?.zones[i];
    if (!refs || !z) return;

    refs.row.className = ZONE_ROW_BASE + (ZONE_BORDER[z.status] || ZONE_BORDER.waiting);
    refs.btnCheck.className = 'px-3 py-2 rounded-xl font-bold text-xs ' +
        (z.checked ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700');
    refs.btnCheck.textContent = z.checked ? `✓ ${z.kol}` : `Ожидает (${z.kol})`;
    refs.btnCheck.setAttribute('aria-pressed', String(!!z.checked));
    refs.btnCheck.setAttribute('aria-label',
        `Участок ${z.uch}, ${z.kol} шт, ${z.checked ? 'подтверждён' : 'ожидает подтверждения'}`);
}

function toggleZone(i) {
    const p = currentProduct();
    const z = p.zones[i];
    z.checked = !z.checked;
    z.status  = z.checked ? 'confirmed' : 'waiting';
    /* Снятие отметки возвращает участок в исходное состояние: иначе
       причина и найденный товар от прежнего расхождения остались бы
       висеть на подтверждённом участке и попали бы в отчёт. */
    if (!z.checked) { z.comment = ''; z.reason = null; z.found = null; }
    z.at = new Date().toISOString();
    paintZone(i, z);
    updateTotals();
    updateProgress();
    scheduleSave();
    pushZone(p, z);
}

function updateTotals() {
    const p = currentProduct();
    if (!p) return;

    const fact = p.zones.reduce((s, z) => s + (z.checked ? z.kol : 0), 0);
    el['count-fact'].textContent = fact;

    const allDone = p.zones.every(z => z.status !== 'waiting');
    const isMatch = fact === p.ost_plan && p.ost_plan > 0;
    const panel   = el['totals-panel'];

    if (isMatch && allDone) {
        panel.className = 'grid grid-cols-2 rounded-xl bg-emerald-50 border-2 border-emerald-500 text-emerald-900 transition-all duration-300 p-2';
        cancelAutoAdvance();
        const idxSnap = store.currentIndex;
        autoAdvanceTimer = setTimeout(() => {
            autoAdvanceTimer = null;
            if (store.currentIndex === idxSnap) autoNextProduct();
        }, 700);
    } else {
        panel.className = 'grid grid-cols-2 rounded-xl bg-slate-100 border-2 border-transparent transition-all duration-300 p-2';
    }
}

function updateProgress() {
    const total     = store.order.length;
    const completed = countCompleted();
    const pct       = total ? Math.round((completed / total) * 100) : 0;   // защита от NaN%
    el['progress-text'].textContent   = `${total ? store.currentIndex + 1 : 0} из ${total}`;
    el['completed-count'].textContent = `${completed} из ${total}`;
    el['progress-bar'].style.width    = `${pct}%`;
}

/* ── Навигация ────────────────────────────────────────────────────── */
function cancelAutoAdvance() {
    if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
}

function autoNextProduct() {
    const next = findNextIncomplete(store.currentIndex + 1);
    if (next !== -1) { store.currentIndex = next; renderProduct(); return; }

    if (!startSecondRound()) { showAllDoneModal(); return; }
    flushSave();
    showToast(`↩ Второй круг: ${store.order.length} товаров`, 3000);
    renderProduct();
}

function nextProductManual() {
    cancelAutoAdvance();
    if (store.currentIndex < store.order.length - 1) store.currentIndex++;
    else { store.currentIndex = 0; showToast('🔄 Начало списка', 2000); }
    renderProduct();
}

function prevProduct() {
    cancelAutoAdvance();
    if (store.currentIndex > 0) { store.currentIndex--; renderProduct(); }
    else showToast('⛔ Это начало списка', 2000);
}

/* ══════════════════════════════════════════════════════════════════════
   ОКНО «НЕ ПОДТВЕРЖДЕНО»

   Шаг 1 — причина плитками: все восемь видны сразу, попадание одним
   касанием. Шаг 2 открывается только для трёх причин, связанных со
   штрихкодом, — для остальных сканировать нечего, и лишний экран там
   только мешал бы.
   ══════════════════════════════════════════════════════════════════════ */
const disc = {
    zoneIndex: null,
    reason   : null,
    found    : null,      // { barcode, tovar, name, kol } | null
    step     : 1,
    maxQty   : 1
};

/* Плитки строятся один раз при запуске */
function buildReasonTiles() {
    const box = el['reason-tiles'];
    box.textContent = '';
    REASONS.forEach(r => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'reason-tile';
        tile.dataset.action = 'pick-reason';
        tile.dataset.reason = r.id;
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', 'false');
        if (r.needsScan) tile.appendChild(svgIcon('i-scan', 18));   // ведёт на шаг 2
        tile.appendChild(document.createTextNode(r.label));
        box.appendChild(tile);
    });
}

function openDiscrepancyModal(i) {
    cancelAutoAdvance();
    const p = currentProduct();
    const z = p.zones[i];

    disc.zoneIndex = i;
    disc.maxQty    = Math.max(1, z.kol);
    /* Повторное открытие подставляет уже записанное: если кладовщик
       ошибся плиткой, он должен видеть, что было выбрано. */
    disc.reason = z.reason || null;
    disc.found  = z.found ? { ...z.found } : null;

    el['modalProductName'].textContent = p.name || p.tovar;
    el['disc-zone-info'].textContent   = `Участок ${z.uch} · план ${z.kol} шт`;
    el['disc-comment'].value           = z.comment || '';
    el['disc-manual-row'].classList.add('hidden');
    el['disc-manual-input'].value      = '';

    paintReasonTiles();
    renderFound();
    goStep(disc.reason && reasonNeedsScan(disc.reason) ? 2 : 1);
    openModal('discrepancyModal');
}

function paintReasonTiles() {
    [...el['reason-tiles'].children].forEach(tile => {
        tile.setAttribute('aria-checked', String(tile.dataset.reason === disc.reason));
    });
}

function goStep(n) {
    disc.step = n;
    el['disc-step1'].classList.toggle('hidden', n !== 1);
    el['disc-step2'].classList.toggle('hidden', n !== 2);
    el['disc-left-btn'].textContent = n === 2 ? '← Назад' : 'Отмена';
    if (n === 2) el['disc-chosen-reason'].textContent = reasonLabel(disc.reason);
    updateSaveButton();
    el['discrepancyModal'].querySelector('.disc-body')?.scrollTo(0, 0);
}

/* Причина обязательна всегда; для трёх «штрихкодных» причин обязателен
   ещё и отсканированный товар. */
function canSave() {
    if (!disc.reason) return false;
    if (reasonNeedsScan(disc.reason) && !disc.found) return false;
    return true;
}

function updateSaveButton() { el['disc-save-btn'].disabled = !canSave(); }

function pickReason(id) {
    disc.reason = id;
    paintReasonTiles();
    if (reasonNeedsScan(id)) goStep(2);
    else { disc.found = null; renderFound(); updateSaveButton(); }
}

function discLeft() {
    if (disc.step === 2) goStep(1);
    else closeModal('discrepancyModal');
}

/* ── Что оказалось вместо ─────────────────────────────────────────── */
function renderFound() {
    const box = el['disc-found'];
    if (!disc.found) { box.classList.add('hidden'); return; }

    const { barcode, tovar, name, kol } = disc.found;
    el['disc-found-tovar'].textContent = tovar || NO_ARTICLE;
    el['disc-found-name'].textContent  = name || (tovar ? '' : 'артикул по этому ШК не найден в базе');
    el['disc-found-bc'].textContent    = 'ШК ' + barcode;

    /* Фото ищется только в папке выбранной сети. Файла нет — остаётся
       белый прямоугольник без надписей. */
    const img = el['disc-found-img'];
    img.hidden = true;
    if (tovar) {
        img.onload  = () => { img.hidden = false; };
        img.onerror = () => { img.hidden = true; };
        img.src = imgUrl(tovar);
        img.alt = 'Фото товара ' + tovar;
    } else {
        img.removeAttribute('src');
    }

    el['disc-qty'].value    = kol;
    el['disc-qty'].max      = disc.maxQty;
    el['disc-qty-hint'].textContent = `от 1 до ${disc.maxQty} (план участка)`;
    box.classList.remove('hidden');
    updateQtyButtons();
    updateSaveButton();
}

function setFoundByBarcode(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) return;
    const hit = findByBarcode(barcode);
    // повторное сканирование заменяет ранее найденный товар
    disc.found = {
        barcode,
        tovar: hit ? hit.tovar : '',
        name : hit ? hit.name  : '',
        kol  : 1                       // от минимума диапазона, поднимает пользователь
    };
    renderFound();
    showToast(hit ? `✅ ${hit.tovar}` : `⚠️ ШК ${barcode} не найден в базе`, hit ? 1800 : 3000);
}

async function doScan() {
    const code = await scanBarcode();
    if (code) setFoundByBarcode(code);
}

function toggleManualInput() {
    const row = el['disc-manual-row'];
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) el['disc-manual-input'].focus();
}

function manualFind() {
    const v = el['disc-manual-input'].value;
    if (!normalizeBarcode(v)) { showToast('Введите штрихкод'); return; }
    setFoundByBarcode(v);
    el['disc-manual-input'].value = '';
    el['disc-manual-row'].classList.add('hidden');
}

/* ── Количество ───────────────────────────────────────────────────── */
function clampQty(v) {
    const n = Math.round(Number(v) || 0);
    return Math.min(Math.max(1, n), disc.maxQty);
}

function setQty(v) {
    if (!disc.found) return;
    disc.found.kol = clampQty(v);
    el['disc-qty'].value = disc.found.kol;
    updateQtyButtons();
}

function updateQtyButtons() {
    const q = disc.found ? disc.found.kol : 1;
    const down = el['disc-found'].querySelector('[data-action="qty-down"]');
    const up   = el['disc-found'].querySelector('[data-action="qty-up"]');
    if (down) down.disabled = q <= 1;
    if (up)   up.disabled   = q >= disc.maxQty;
}

/* ── Сохранение ───────────────────────────────────────────────────── */
function saveDiscrepancy() {
    if (!canSave()) {
        showToast(disc.reason ? 'Отсканируйте товар, который оказался вместо нужного'
                              : 'Выберите причину', 3000);
        return;
    }
    const p = currentProduct();
    const z = p.zones[disc.zoneIndex];
    z.status  = 'not_confirmed';
    z.checked = true;
    z.reason  = disc.reason;
    z.found   = disc.found ? { ...disc.found } : null;
    z.comment = el['disc-comment'].value.trim();      // в отчёт пойдёт, только если непустой
    z.at      = new Date().toISOString();

    closeModal('discrepancyModal');
    paintZone(disc.zoneIndex, z);
    updateTotals();
    updateProgress();
    flushSave();                       // расхождение сохраняем немедленно
    pushZone(p, z);
}

/* Отметка уходит на сервер, если работа идёт по наряду от ведущего.
   Вне проверки ничего не отправляется — приложение работает как раньше. */
function pushZone(product, zone) {
    if (!inSession()) return;
    enqueueZone(product.tovar, zone);
}

/* ── Завершение и отчёт ───────────────────────────────────────────── */
function showAllDoneModal() {
    const list       = store.initialOrder.map(k => store.byId.get(k)).filter(Boolean);
    const withIssues = list.filter(p => p.zones.some(z => z.status === 'not_confirmed')).length;
    el['allDoneText'].textContent =
        `Всего: ${list.length}. Без замечаний: ${list.length - withIssues}. С расхождениями: ${withIssues}.`;
    openModal('allDoneModal');
}

function exportDiscrepancies() {
    /* Охват отчёта — строго текущий маршрут. `initialOrder` и есть
       отфильтрованный срез, заданный пользователем на экране маршрута;
       если фильтр не выбирался, туда попали все артикулы файла.
       Порядок строк повторяет порядок проверки, а не порядок вставки в Map. */
    const ordered = store.initialOrder
        .map(k => store.byId.get(k))
        .filter(Boolean);

    if (!ordered.length) { showToast('Маршрут не запускался — выгружать нечего'); return; }

    const report = buildReport(ordered);
    if (!report.rows) { showToast('✅ Расхождений и незакрытых участков нет'); return; }

    downloadBlob(report.text, 'text/csv;charset=utf-8;', `errors_${stamp()}.csv`);
    showToast(`✅ Экспорт: расхождений ${report.issues}, не проверено ${report.pending}`, 3500);
}

function copyBarcode() {
    const b = el['view-tovar'].textContent;
    if (!b) return;
    navigator.clipboard.writeText(b)
        .then(() => showToast('📋 Скопировано'))
        .catch(() => showToast('Не удалось скопировать'));
}

/* ══════════════════════════════════════════════════════════════════════
   ЖЕСТЫ

   Раньше учитывалось только расстояние: медленное перетаскивание пальцем
   во время чтения карточки переключало товар. Добавлены порог по времени
   и требование явного преобладания горизонтали; жесты, начатые на кнопке
   или внутри прокручиваемого списка, игнорируются.
   ══════════════════════════════════════════════════════════════════════ */
const SWIPE_MIN_PX = 60, SWIPE_MAX_MS = 500, SWIPE_RATIO = 2;

function initSwipe() {
    const zone = el['screen-work'];
    let x0 = 0, y0 = 0, t0 = 0, valid = false;

    zone.addEventListener('touchstart', e => {
        const t = e.changedTouches[0];
        x0 = t.screenX; y0 = t.screenY; t0 = Date.now();
        valid = !e.target.closest('button, a, input, textarea, select, #zones-list');
    }, { passive: true });

    zone.addEventListener('touchend', e => {
        if (!valid || anyModalOpen() || isZoomOpen()) return;
        const t  = e.changedTouches[0];
        const dx = t.screenX - x0, dy = t.screenY - y0;
        if (Date.now() - t0 > SWIPE_MAX_MS) return;
        if (Math.abs(dx) < SWIPE_MIN_PX) return;
        if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
        dx < 0 ? nextProductManual() : prevProduct();
    }, { passive: true });
}

/* ══════════════════════════════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
   ══════════════════════════════════════════════════════════════════════ */
const ACTIONS = {
    'auth'          : checkAuth,
    'home'          : () => goToUploadScreen(),
    'snapshot'      : saveSessionSnapshot,
    'restore'       : restoreSession,
    'clear-session' : clearSavedSession,
    'start'         : startVerification,
    'prev'          : prevProduct,
    'next'          : nextProductManual,
    'export'        : exportDiscrepancies,
    'copy'          : copyBarcode,
    'zoom-open'     : () => toggleImageZoom(true),
    'zoom-close'    : () => toggleImageZoom(false),
    'alldone-close' : () => closeModal('allDoneModal'),
    'alldone-export': () => { exportDiscrepancies(); closeModal('allDoneModal'); },

    // окно «Не подтверждено»
    'pick-reason'   : node => pickReason(node.dataset.reason),
    'disc-left'     : discLeft,
    'modal-save'    : saveDiscrepancy,
    'disc-scan'     : doScan,
    'disc-manual'   : toggleManualInput,
    'disc-manual-find': manualFind,
    'qty-up'        : () => setQty((disc.found ? disc.found.kol : 1) + 1),
    'qty-down'      : () => setQty((disc.found ? disc.found.kol : 1) - 1),

    // слой сканирования
    'scan-close'    : cancelScan,
    'scan-torch'    : toggleTorch,
    'scan-manual'   : () => {
        cancelScan();
        el['disc-manual-row'].classList.remove('hidden');
        setTimeout(() => el['disc-manual-input'].focus(), 50);
    },

    // выбор роли
    'role-lead'   : () => lead.showLeadScreen(),
    'role-join'   : () => lead.showJoinScreen(),
    'role-solo'   : () => { showScreen('upload'); setStatusBadge(defaultBadgeFor('upload')); checkRestorable(); },
    'role-resume' : () => restoreSession(),

    // создание проверки
    'lead-add'    : () => lead.addChecker(),
    'lead-del'    : node => lead.removeChecker(Number(node.dataset.checker)),
    'lead-back'   : () => lead.showRoleScreen(resumeLabel()),
    'lead-create' : () => lead.createSession(),

    // сводка ведущего
    'board-refresh': () => lead.refreshBoard(),
    'board-mywork' : () => lead.leadGoToOwnWork(),
    'board-finish' : finishAndErase,

    // присоединение
    'join-find' : () => lead.findSession(),
    'join-start': () => lead.startJoined(),
    'join-back' : () => lead.showRoleScreen(resumeLabel()),
    'join-scan' : async () => {
        const code = await scanBarcode();
        if (code) lead.applyScannedJoin(code);
    }
};

/* ── Завершение смены ─────────────────────────────────────────────────
   Отчёт сначала оказывается на устройстве, и лишь потом отдельным
   подтверждением стираются данные: истории не ведётся, вернуть нечем. */
async function finishAndErase() {
    const ctx = lead.boardContext();
    if (!ctx) return;

    const notDone = (ctx.assignments || []).filter(a => a.state !== 'done');
    if (notDone.length && !confirm(
        `Не отметились как сдавшие: ${notDone.map(a => a.checker).join(', ')}.\n` +
        'Их результаты попадут в отчёт в том виде, в каком успели дойти. Продолжить?')) return;

    try {
        showToast('Сборка отчёта…', 6000);
        const res = await lead.finishSession(msg => showToast(msg, 6000));
        if (!res) return;

        downloadBlob(res.reportCsv,   'text/csv;charset=utf-8;', `отчёт_${res.stamp}_${stamp()}.csv`);
        downloadBlob(res.coverageCsv, 'text/csv;charset=utf-8;', `покрытие_${res.stamp}_${stamp()}.csv`);

        const s = res.stat;
        const ok = confirm(
            `Отчёт скачан.\n\n` +
            `Участков всего: ${s.total}\n` +
            `Подтверждено: ${s.done}\n` +
            `Расхождений: ${s.issues}\n` +
            `Не проверено: ${s.pending}\n\n` +
            `Удалить данные проверки с сервера? Отменить это будет нельзя.`
        );
        if (!ok) { showToast('Данные оставлены на сервере', 3000); return; }

        await lead.eraseSession();
        resetQueue();
        setSession(null);
        clearSaved();
        showToast('Проверка завершена, данные стёрты', 3000);
        lead.showRoleScreen(null);
    } catch (e) {
        showToast('Не удалось завершить: ' + e.message, 6000);
    }
}

function onLeadFieldChange(e) {
    const node = e.target;
    if (!node.dataset || node.dataset.checker === undefined) return;
    lead.updateChecker(Number(node.dataset.checker), node.dataset.field, node.value);
}

function init() {
    cacheDom();
    bindActions(ACTIONS);
    buildReasonTiles();

    // ручной ввод ШК: Enter вместо кнопки «Найти»
    el['disc-manual-input'].addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); manualFind(); }
    });
    // правка количества с клавиатуры тоже должна попадать в диапазон
    el['disc-qty'].addEventListener('change', e => setQty(e.target.value));

    onSaveError(() => {
        setStatusBadge('НЕ СОХРАНЯЕТСЯ', true);
        showToast('⚠️ Память устройства заполнена — прогресс НЕ сохраняется. Сделайте снимок сессии!', 8000);
    });
    onSaveRecovered(() => setStatusBadge(defaultBadgeFor(getScreen())));
    onSyncState(paintSyncBadge);
    lead.setHooks({ onPoolReady });

    /* Поля проверяющих создаются на лету, поэтому слушаем всплытие,
       а не вешаем обработчики на каждый элемент */
    el['lead-checkers'].addEventListener('input',  onLeadFieldChange);
    el['lead-checkers'].addEventListener('change', onLeadFieldChange);
    el['screen-lead'].addEventListener('change', e => {
        if (e.target.name === 'lead-mode') lead.setMode(e.target.value);
    });
    el['lead-csv'].addEventListener('change', lead.handleLeadCsv);
    el['join-code'].addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); lead.findSession(); }
    });

    if (sessionStorage.getItem('wh_auth_passed') === 'true') lead.showRoleScreen(resumeLabel());
    else showScreen('auth');

    el['auth-password'].addEventListener('keydown', e => {
        if (e.key === 'Enter') checkAuth();
    });
    el['csv-file'].addEventListener('change', handleCsvSelect);
    el['session-file'].addEventListener('change', handleSessionFileSelect);

    /* Escape закрывает верхний слой — раньше модалку нельзя было закрыть
       с клавиатуры вообще */
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (isScannerOpen())                      cancelScan();
        else if (isZoomOpen())                    toggleImageZoom(false);
        else if (isModalOpen('discrepancyModal')) closeModal('discrepancyModal');
        else if (isModalOpen('allDoneModal'))     closeModal('allDoneModal');
    });

    /* Отложенная запись не должна теряться при сворачивании приложения или
       закрытии вкладки: pagehide и visibilitychange — единственные события,
       на которые можно рассчитывать в мобильных браузерах. */
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSave();
    });

    initSwipe();
    checkRestorable();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
