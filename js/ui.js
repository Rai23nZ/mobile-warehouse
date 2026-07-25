/* ═══════════════════════════════════════════════════════════════════════
   ui.js — всё, что касается DOM: экраны, модальные окна, тосты, иконки.

   Логика приложения сюда не попадает: модуль ничего не знает про товары
   и участки.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Кэш узлов ─────────────────────────────────────────────────────────
   Раньше на каждую отрисовку приходились десятки getElementById. */
export const el = {};

const CACHED_IDS = [
    'screen-auth', 'screen-role', 'screen-lead', 'screen-board', 'screen-join',
    'screen-upload', 'screen-filter', 'screen-work', 'footer-work',
    'auth-password', 'auth-error', 'sync-badge',

    // выбор роли
    'role-resume', 'role-resume-info',

    // создание проверки
    'lead-key-row', 'lead-key', 'lead-store', 'lead-network', 'lead-name',
    'lead-csv', 'lead-csv-info', 'lead-mode-hint', 'lead-checkers',
    'lead-coverage', 'lead-create-btn',

    // сводка ведущего
    'board-code', 'board-store', 'board-qr', 'board-list', 'board-updated',

    // присоединение
    'join-store', 'join-code', 'join-error', 'join-pick',
    'join-session-info', 'join-list', 'join-start-btn',

    'csv-file', 'session-file', 'loading-msg', 'error-card', 'error-text', 'import-summary',
    'restore-banner', 'restore-info',
    'filter-napravlenie', 'filter-tm', 'filter-pol',
    'view-image', 'view-napr', 'view-pol', 'view-tm-name', 'view-tovar', 'view-name',
    'count-plan', 'count-fact', 'totals-panel', 'zones-list',
    'incomplete-banner', 'incomplete-banner-text',
    'progress-text', 'completed-count', 'progress-bar',
    'status-badge', 'btn-save-session',
    'toast', 'toast-text',
    'allDoneModal', 'allDoneText',
    'imageZoomOverlay', 'zoom-image-target',

    // окно «Не подтверждено»
    'discrepancyModal', 'modalProductName', 'disc-zone-info',
    'disc-step1', 'disc-step2', 'reason-tiles', 'disc-chosen-reason',
    'disc-scan-btn', 'disc-manual-row', 'disc-manual-input',
    'disc-found', 'disc-found-img', 'disc-found-tovar', 'disc-found-name', 'disc-found-bc',
    'disc-qty', 'disc-qty-hint', 'disc-comment',
    'disc-left-btn', 'disc-save-btn',

    // слой сканирования
    'scannerOverlay', 'scanner-video', 'scanner-hint', 'scanner-error', 'scanner-torch'
];

export function cacheDom() {
    CACHED_IDS.forEach(id => { el[id] = document.getElementById(id); });
}

/* ── Экраны ────────────────────────────────────────────────────────────
   Раньше переключение было россыпью classList.add/remove в пяти местах,
   и состояние экрана существовало только в DOM. */
const SCREENS = ['auth', 'role', 'lead', 'board', 'join', 'upload', 'filter', 'work'];
const BADGE_BY_SCREEN = {
    work : 'Проверка',
    filter: 'Данные готовы',
    lead : 'Настройка',
    board: 'Ведущий',
    join : 'Подключение'
};

let currentScreen = 'auth';
export const getScreen = () => currentScreen;

export function showScreen(name) {
    currentScreen = name;
    SCREENS.forEach(s => el['screen-' + s].classList.toggle('hidden', s !== name));
    el['footer-work'].classList.toggle('hidden', name !== 'work');

    const showSnapshot = name === 'work';
    el['btn-save-session'].classList.toggle('hidden', !showSnapshot);
    el['btn-save-session'].classList.toggle('flex',    showSnapshot);
}

export function setStatusBadge(text, alarm = false) {
    const badge = el['status-badge'];
    if (!badge) return;
    badge.textContent = text;
    badge.classList.toggle('bg-rose-600', alarm);
    badge.classList.toggle('bg-indigo-500', !alarm);
}

export function defaultBadgeFor(screen) { return BADGE_BY_SCREEN[screen] || 'Ожидание'; }

/* ── Модальные окна ────────────────────────────────────────────────────
   Единый механизм через classList. Раньше экраны управлялись классом
   `hidden`, а модалки — inline style.display, и работало это лишь потому,
   что инлайн-стиль перебивает класс. */
let lastFocused = null;

export function openModal(id, focusId) {
    const m = el[id];
    if (!m) return;
    lastFocused = document.activeElement;
    m.classList.remove('hidden');
    m.classList.add('flex');
    const target = focusId && el[focusId];
    if (target) setTimeout(() => target.focus(), 30);
}

export function closeModal(id) {
    const m = el[id];
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
}

export function isModalOpen(id) {
    return el[id] && !el[id].classList.contains('hidden');
}

export function anyModalOpen() {
    return isModalOpen('discrepancyModal') || isModalOpen('allDoneModal');
}

/* ── Тосты ─────────────────────────────────────────────────────────────
   Раньше каждый тост заводил свой таймер: второй тост подряд гасился
   таймером первого, не дожив свою длительность. */
let toastTimer = null;

export function showToast(text, duration = 2500) {
    const t = el['toast'], label = el['toast-text'];
    if (!t || !label) return;
    label.textContent = text;
    t.classList.remove('translate-y-20', 'opacity-0');
    t.classList.add('translate-y-0', 'opacity-100');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastTimer = null;
        t.classList.remove('translate-y-0', 'opacity-100');
        t.classList.add('translate-y-20', 'opacity-0');
    }, duration);
}

/* ── Сообщения об ошибках импорта ──────────────────────────────────── */
export function showError(message) {
    el['error-text'].textContent = message;
    el['error-card'].classList.remove('hidden');
    el['loading-msg'].classList.add('hidden');
}
export function hideError()   { el['error-card'].classList.add('hidden'); }
export function showLoading() { el['loading-msg'].classList.remove('hidden'); }
export function hideLoading() { el['loading-msg'].classList.add('hidden'); }

/* ── Иконки из SVG-спрайта ────────────────────────────────────────── */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgIcon(symbolId, size = 24) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `icon icon-${size}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${symbolId}`);
    svg.appendChild(use);
    return svg;
}

/* ── Полноэкранный просмотр фото ─────────────────────────────────── */
export function toggleImageZoom(show) {
    const overlay = el['imageZoomOverlay'];
    const zoomImg = el['zoom-image-target'];
    const curImg  = el['view-image'];
    if (!overlay || !zoomImg || !curImg) return;

    if (show) {
        zoomImg.src = curImg.src;
        zoomImg.alt = curImg.alt || 'Увеличенное фото';
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
        setTimeout(() => { if (!overlay.classList.contains('active')) zoomImg.src = ''; }, 250);
    }
}
export const isZoomOpen = () => el['imageZoomOverlay']?.classList.contains('active');

/* ── Выгрузка файлов ─────────────────────────────────────────────── */
export function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function downloadBlob(content, mime, filename) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);   // ранний revoke обрывал скачивание
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── Делегирование кликов ──────────────────────────────────────────────
   Один слушатель вместо inline-onclick на каждой кнопке: разметка не
   содержит исполняемого кода, и для страницы становится возможен CSP. */
export function bindActions(handlers) {
    document.addEventListener('click', ev => {
        const node = ev.target.closest('[data-action]');
        if (!node) return;
        const fn = handlers[node.dataset.action];
        if (!fn) return;
        ev.preventDefault();
        fn(node, ev);
    });
}
