/* ═══════════════════════════════════════════════════════════════════════
   lead.js — экраны ведущего и присоединения проверяющего.

   Ведущий загружает файл у себя, раздаёт наряды и получает код смены.
   Проверяющие вводят номер магазина и код (или считывают QR) — и получают
   свой пул товаров с сервера. Файл им пересылать не нужно.
   ═══════════════════════════════════════════════════════════════════════ */

import {
    buildAssignments, analyzeCoverage, chunkPool, collectZones,
    MODE_NAPR, MODE_UCH
} from './assign.js';
import { buildProducts, csvRow, BOM, ZONE_STATUS_LABEL } from './csv.js';
import { reasonLabel, NO_ARTICLE } from './reasons.js';
import * as api from './sync.js';
import {
    el, showScreen, setStatusBadge, defaultBadgeFor,
    showToast, escapeHtml, svgIcon
} from './ui.js';

const LS_LEAD_KEY = 'wh_lead_key';
const LS_LAST_STORE = 'wh_last_store';
const LS_CHECKER = 'wh_checker_name';

/* Состояние экрана создания проверки */
const draft = {
    products: [],          // разобранный CSV ведущего
    fileName: '',
    fileHash: '',
    mode: MODE_NAPR,
    checkers: [],          // [{ name, isLead, napr, tm, pol }]
    assignments: null,     // результат buildAssignments
    facets: { napr: [], tm: [], pol: [] }
};

/* Состояние присоединения */
const join = { info: null, pickedIdx: null };

/* Куда возвращаться и что делать после входа в наряд —
   задаётся из app.js, чтобы модуль не знал про рабочий экран. */
let hooks = { onPoolReady: null, onLeaveSession: null };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

/* ══════════════════════════════════════════════════════════════════════
   ВЫБОР РОЛИ
   ══════════════════════════════════════════════════════════════════════ */
export function showRoleScreen(resumeInfo) {
    showScreen('role');
    setStatusBadge(defaultBadgeFor('role'));
    const box = el['role-resume'];
    if (resumeInfo) {
        el['role-resume-info'].textContent = resumeInfo;
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
    }
}

/* ══════════════════════════════════════════════════════════════════════
   СОЗДАНИЕ ПРОВЕРКИ
   ══════════════════════════════════════════════════════════════════════ */
export function showLeadScreen() {
    showScreen('lead');
    setStatusBadge(defaultBadgeFor('lead'));

    el['lead-api'].value = api.getApiBase();
    el['lead-api-status'].textContent = '';

    const savedKey = localStorage.getItem(LS_LEAD_KEY) || '';
    el['lead-key'].value = savedKey;
    el['lead-key-row'].classList.toggle('hidden', !!savedKey);
    el['lead-store'].value = localStorage.getItem(LS_LAST_STORE) || '';
    if (!el['lead-name'].value) el['lead-name'].value = localStorage.getItem(LS_CHECKER) || '';

    if (!draft.checkers.length) {
        draft.checkers = [{ name: el['lead-name'].value || '', isLead: true, napr: '', tm: '', pol: '' }];
    }
    renderModeHint();
    renderCheckers();
}

/* Проверка связи с сервером до того, как ведущий соберёт все наряды и
   упрётся в молчание при создании проверки. */
export async function pingServer() {
    const url = el['lead-api'].value.trim();
    if (url) api.setApiBase(url);
    const out = el['lead-api-status'];
    out.textContent = 'Проверка…';
    const t0 = performance.now();
    try {
        const r = await api.health();
        const ms = Math.round(performance.now() - t0);
        out.textContent = r && r.ok
            ? `✅ сервер отвечает за ${ms} мс · ${r.db}`
            : '⚠️ странный ответ сервера';
    } catch (e) {
        out.textContent = '❌ ' + e.message;
    }
}

export function setMode(mode) {
    draft.mode = mode === MODE_UCH ? MODE_UCH : MODE_NAPR;
    renderModeHint();
    renderCheckers();
}

function renderModeHint() {
    el['lead-mode-hint'].textContent = draft.mode === MODE_UCH
        ? 'Участки делятся по порядку поровну — по количеству участков. Направление, ТМ и пол не учитываются: проверяющий обходит свои участки подряд.'
        : 'Каждому задаётся своя область: направление, торговая марка, пол. Артикул целиком достаётся одному проверяющему.';
}

/* Разбор файла ведущим. Хеш нужен, чтобы позже отличить «тот же файл»
   от «похожего»: наряды считаются именно от этой выгрузки. */
export async function handleLeadCsv(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const { products, stats } = buildProducts(text);
        draft.products = products;
        draft.fileName = file.name;
        draft.fileHash = await sha256Short(text);

        const f = { napr: new Set(), tm: new Set(), pol: new Set() };
        products.forEach(p => { f.napr.add(p.napr); f.tm.add(p.tm); f.pol.add(p.pol); });
        draft.facets = {
            napr: [...f.napr].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')),
            tm  : [...f.tm].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')),
            pol : [...f.pol].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'))
        };

        el['lead-csv-info'].textContent =
            `${stats.products} артикулов · ${collectZones(products).length} участков · ${stats.zoneRows} строк с участками`;
        renderCheckers();
    } catch (e) {
        el['lead-csv-info'].textContent = 'Ошибка чтения: ' + e.message;
        draft.products = [];
    } finally {
        ev.target.value = '';
    }
}

async function sha256Short(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function addChecker() {
    if (draft.checkers.length >= 12) { showToast('Больше 12 проверяющих не поддерживается'); return; }
    draft.checkers.push({ name: '', isLead: false, napr: '', tm: '', pol: '' });
    renderCheckers();
}

export function removeChecker(i) {
    if (draft.checkers[i] && draft.checkers[i].isLead) { showToast('Ведущего убрать нельзя'); return; }
    draft.checkers.splice(i, 1);
    renderCheckers();
}

export function updateChecker(i, field, value) {
    if (!draft.checkers[i]) return;
    draft.checkers[i][field] = value;
    if (draft.checkers[i].isLead && field === 'name') el['lead-name'].value = value;
    recalc();
}

function selectHtml(i, field, label, values, current) {
    const opts = ['<option value="">— все —</option>'].concat(
        values.map(v => `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`)
    ).join('');
    return `<select data-checker="${i}" data-field="${field}" aria-label="${label}"
                    class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-2 text-[11px]">${opts}</select>`;
}

function renderCheckers() {
    const box = el['lead-checkers'];
    box.innerHTML = draft.checkers.map((c, i) => {
        const filters = draft.mode === MODE_NAPR
            ? `<div class="flex gap-1 mt-1.5">
                   ${selectHtml(i, 'napr', 'Направление', draft.facets.napr, c.napr)}
                   ${selectHtml(i, 'tm',   'Торговая марка', draft.facets.tm,  c.tm)}
                   ${selectHtml(i, 'pol',  'Пол',          draft.facets.pol, c.pol)}
               </div>`
            : '';
        return `
        <div class="border border-slate-200 rounded-xl p-2.5">
            <div class="flex gap-2 items-center">
                <input type="text" data-checker="${i}" data-field="name" value="${escapeHtml(c.name)}"
                       placeholder="Фамилия И.О." autocomplete="off"
                       class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg py-2 px-2.5 text-sm">
                ${c.isLead
                    ? '<span class="text-[10px] font-bold text-indigo-600 uppercase flex-shrink-0">вы</span>'
                    : `<button type="button" data-action="lead-del" data-checker="${i}"
                               aria-label="Убрать проверяющего" class="p-1.5 text-rose-500 flex-shrink-0">✕</button>`}
            </div>
            ${filters}
            <div class="text-[10px] text-slate-400 mt-1.5" data-balance="${i}"></div>
        </div>`;
    }).join('');
    recalc();
}

/* Пересчёт нарядов и покрытия при каждом изменении: перекос и дыры
   должны быть видны ДО старта, а не при сборке отчёта. */
function recalc() {
    const box = el['lead-coverage'];
    if (!draft.products.length) {
        draft.assignments = null;
        box.innerHTML = '<p class="text-[11px] text-slate-400">Загрузите файл, чтобы увидеть распределение</p>';
        return;
    }
    draft.assignments = buildAssignments(draft.products, draft.mode, draft.checkers);
    const cov = analyzeCoverage(draft.products, draft.assignments, draft.mode);

    draft.assignments.forEach((a, i) => {
        const node = el['lead-checkers'].querySelector(`[data-balance="${i}"]`);
        if (!node) return;
        node.textContent = draft.mode === MODE_UCH
            ? `участки ${a.zoneSpec.from ?? '—'}–${a.zoneSpec.to ?? '—'} · ${a.items} арт. · ${a.units} шт`
            : `${a.items} арт. · ${a.units} шт`;
    });

    const warn = [];
    if (cov.uncovered.length) {
        warn.push(`<div class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
            ⚠ Не попали ни в один наряд: <b>${cov.uncovered.length}</b> — ${escapeHtml(cov.uncoveredKind)}</div>`);
    }
    if (cov.overlaps.length) {
        warn.push(`<div class="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">
            ⚠ Пересечение объёмов: <b>${cov.overlaps.length}</b> артикулов достались более чем одному</div>`);
    }
    if (cov.spread.ratio && cov.spread.ratio >= 1.5) {
        warn.push(`<div class="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2">
            Нагрузка распределена неравномерно: от ${cov.spread.min} до ${cov.spread.max} шт (в ${cov.spread.ratio} раза)</div>`);
    }
    if (!warn.length) {
        warn.push('<div class="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">Распределение полное, пересечений нет</div>');
    }
    box.innerHTML = warn.join('');
}

/* ── Создание на сервере ───────────────────────────────────────────── */
export async function createSession() {
    const key   = (el['lead-key'].value || localStorage.getItem(LS_LEAD_KEY) || '').trim();
    const store = el['lead-store'].value.trim();
    const name  = el['lead-name'].value.trim();
    const network = el['lead-network'].value;

    if (!key)   return showToast('Введите ключ ведущего');
    if (!store) return showToast('Укажите номер магазина');
    if (!name)  return showToast('Укажите своё ФИО');
    if (!draft.products.length) return showToast('Загрузите файл инвентаризации');

    draft.checkers[0].name = name;
    if (draft.checkers.some(c => !c.name.trim())) return showToast('У всех проверяющих должно быть ФИО');
    recalc();
    if (!draft.assignments) return showToast('Не удалось построить наряды');

    const empty = draft.assignments.filter(a => !a.items);
    if (empty.length && !confirm(`У ${empty.length} проверяющих пустой наряд. Всё равно создать?`)) return;

    const btn = el['lead-create-btn'];
    btn.disabled = true;
    const restore = () => { btn.disabled = false; btn.textContent = 'Создать'; };

    try {
        btn.textContent = 'Создание…';
        const res = await api.createSession(key, {
            store, network, leadName: name, mode: draft.mode,
            masterName: draft.fileName, masterHash: draft.fileHash,
            assignments: draft.assignments.map(a => ({
                checker: a.checker, isLead: a.isLead, zoneSpec: a.zoneSpec, items: a.items
            }))
        });

        localStorage.setItem(LS_LEAD_KEY, key);
        localStorage.setItem(LS_LAST_STORE, store);
        localStorage.setItem(LS_CHECKER, name);
        el['lead-key-row'].classList.add('hidden');

        /* Пулы уходят по одному куску за запрос: у D1 предел 2 МБ
           на значение, а наряд одного проверяющего может быть большим. */
        let total = 0, done = 0;
        const chunked = draft.assignments.map(a => chunkPool(a.pool));
        chunked.forEach(parts => total += parts.length);
        for (let i = 0; i < chunked.length; i++) {
            await api.uploadPool(res.code, res.leadToken, i, chunked[i], () => {
                done++;
                btn.textContent = `Отправка ${done}/${total}`;
            });
        }

        showBoard(res.code, { store, network, mode: draft.mode, leadName: name });
        showToast('✅ Проверка создана: ' + res.code, 3000);
    } catch (e) {
        showToast('Не удалось создать: ' + e.message, 5000);
    } finally {
        restore();
    }
}

/* ══════════════════════════════════════════════════════════════════════
   СВОДКА ВЕДУЩЕГО
   ══════════════════════════════════════════════════════════════════════ */
let boardCtx = null;      // { code, store, network, mode, leadName }

export const boardContext = () => boardCtx;

export function showBoard(code, meta) {
    boardCtx = { code, ...meta };
    showScreen('board');
    setStatusBadge(defaultBadgeFor('board'));

    el['board-code'].textContent = code;
    el['board-store'].textContent = `магазин ${meta.store} · ${meta.network} · ` +
        (meta.mode === MODE_UCH ? 'деление по участкам' : 'деление по направлениям');
    renderQr(code, meta.store);
    refreshBoard();
}

/* QR несёт код и магазин — проверяющему не придётся вводить ничего */
async function renderQr(code, store) {
    const box = el['board-qr'];
    box.innerHTML = '';
    try {
        if (!window.qrcode) await loadScript('vendor/qrcode.min.js');
        const qr = window.qrcode(0, 'M');
        qr.addData(`WH:${store}:${code}`);
        qr.make();
        box.innerHTML = qr.createImgTag(5, 8);
        const img = box.querySelector('img');
        if (img) { img.alt = `QR для присоединения к проверке ${code}`; img.style.display = 'block'; }
    } catch (e) {
        box.innerHTML = '<p class="text-[10px] text-slate-400">QR недоступен — сообщите код голосом</p>';
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('не загрузился ' + src));
        document.head.appendChild(s);
    });
}

export async function refreshBoard() {
    if (!boardCtx) return;
    const token = api.loadLeadToken(boardCtx.code);
    if (!token) { el['board-list'].innerHTML = '<p class="text-xs text-rose-600">Нет прав на эту проверку — токен утерян</p>'; return; }
    try {
        const p = await api.getProgress(boardCtx.code, token);
        boardCtx.assignments = p.assignments;
        el['board-list'].innerHTML = p.assignments.map(a => {
            const state = a.state === 'done' ? 'сдал'
                        : a.state === 'in_progress' ? 'в работе' : 'не начал';
            const color = a.state === 'done' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                        : a.state === 'in_progress' ? 'text-indigo-700 bg-indigo-50 border-indigo-200'
                        : 'text-slate-500 bg-slate-50 border-slate-200';
            const time = a.startedAt
                ? new Date(a.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                  + (a.finishedAt ? '–' + new Date(a.finishedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '')
                : '';
            return `<div class="border rounded-xl p-2.5 ${color}">
                <div class="flex justify-between items-start gap-2">
                    <div class="min-w-0">
                        <div class="font-bold text-sm truncate">${escapeHtml(a.checker)}${a.isLead ? ' (вы)' : ''}</div>
                        <div class="text-[11px]">${a.items} арт. · обработано ${a.decided} · расхождений ${a.issues}</div>
                    </div>
                    <div class="text-right flex-shrink-0">
                        <div class="text-[11px] font-bold uppercase">${state}</div>
                        <div class="text-[10px] opacity-70">${time}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
        el['board-updated'].textContent = 'обновлено ' + new Date().toLocaleTimeString('ru-RU');
    } catch (e) {
        el['board-updated'].textContent = 'не обновилось: ' + e.message;
    }
}

/* ══════════════════════════════════════════════════════════════════════
   ПРИСОЕДИНЕНИЕ
   ══════════════════════════════════════════════════════════════════════ */
export function showJoinScreen() {
    showScreen('join');
    setStatusBadge(defaultBadgeFor('join'));
    el['join-store'].value = localStorage.getItem(LS_LAST_STORE) || '';
    el['join-error'].classList.add('hidden');
    el['join-pick'].classList.add('hidden');
    join.info = null; join.pickedIdx = null;
}

/* QR несёт строку WH:<магазин>:<код> */
export function applyScannedJoin(text) {
    const m = /^WH:([^:]+):([A-Z0-9]{6})$/i.exec(String(text || '').trim());
    if (!m) { showToast('Это не QR проверки'); return false; }
    el['join-store'].value = m[1];
    el['join-code'].value = m[2].toUpperCase();
    findSession();
    return true;
}

export async function findSession() {
    const store = el['join-store'].value.trim();
    const code  = el['join-code'].value.trim().toUpperCase();
    const err = el['join-error'];
    err.classList.add('hidden');
    el['join-pick'].classList.add('hidden');

    if (!store || code.length !== 6) {
        err.textContent = 'Укажите номер магазина и шестизначный код';
        err.classList.remove('hidden');
        return;
    }
    try {
        const info = await api.getInfo(code, store);
        join.info = { ...info, store, code };
        localStorage.setItem(LS_LAST_STORE, store);

        el['join-session-info'].textContent =
            `Магазин ${info.store} · ${info.network} · ведущий ${info.leadName} · ` +
            (info.mode === MODE_UCH ? 'деление по участкам' : 'деление по направлениям');

        const mine = localStorage.getItem(LS_CHECKER);
        el['join-list'].innerHTML = info.assignments.map(a => `
            <label class="net-option" style="justify-content:flex-start">
                <input type="radio" name="join-who" value="${a.idx}" class="w-4 h-4"
                       ${a.checker === mine ? 'checked' : ''}>
                <span class="min-w-0">
                    <span class="text-xs font-bold text-slate-800 block truncate">${escapeHtml(a.checker)}${a.isLead ? ' (ведущий)' : ''}</span>
                    <span class="text-[10px] text-slate-500">${a.items} артикулов · ${
                        a.state === 'done' ? 'уже сдал' : a.state === 'in_progress' ? 'в работе' : 'не начинал'}</span>
                </span>
            </label>`).join('');
        el['join-pick'].classList.remove('hidden');
    } catch (e) {
        err.textContent = e.message;
        err.classList.remove('hidden');
    }
}

export async function startJoined() {
    if (!join.info) return;
    const picked = document.querySelector('input[name="join-who"]:checked');
    if (!picked) { showToast('Выберите себя в списке'); return; }
    const idx = Number(picked.value);
    const btn = el['join-start-btn'];
    btn.disabled = true;

    try {
        btn.textContent = 'Получение задания…';
        const a = await api.getAssignment(join.info.code, join.info.store, idx);
        const pool = await api.getPool(join.info.code, join.info.store, idx, a.parts,
            (p, n) => { btn.textContent = `Загрузка ${p}/${n}`; });

        if (!pool.length) { showToast('В вашем наряде нет товаров', 4000); return; }

        localStorage.setItem(LS_CHECKER, a.checker);
        const session = {
            code   : join.info.code,
            store  : join.info.store,
            network: a.network || join.info.network,
            mode   : a.mode || join.info.mode,
            checker: a.checker,
            idx,
            isLead : !!a.isLead,
            leadName: join.info.leadName
        };
        api.initQueue({ code: session.code, store: session.store, idx });
        await api.sendAssignmentState('in_progress', { startedAt: new Date().toISOString() });
        hooks.onPoolReady && hooks.onPoolReady(pool, session);
    } catch (e) {
        showToast('Не удалось получить задание: ' + e.message, 5000);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Начать проверку';
    }
}

/* Ведущий переходит к собственному наряду: он такой же участник смены */
export async function leadGoToOwnWork() {
    if (!boardCtx) return;
    const own = (boardCtx.assignments || []).find(a => a.isLead) || { idx: 0 };
    el['join-store'].value = boardCtx.store;
    el['join-code'].value  = boardCtx.code;
    join.info = {
        code: boardCtx.code, store: boardCtx.store, network: boardCtx.network,
        mode: boardCtx.mode, leadName: boardCtx.leadName,
        assignments: boardCtx.assignments || []
    };
    join.pickedIdx = own.idx;

    try {
        const a = await api.getAssignment(boardCtx.code, boardCtx.store, own.idx);
        const pool = await api.getPool(boardCtx.code, boardCtx.store, own.idx, a.parts);
        if (!pool.length) { showToast('В вашем наряде нет товаров', 4000); return; }
        const session = {
            code: boardCtx.code, store: boardCtx.store, network: a.network,
            mode: a.mode, checker: a.checker, idx: own.idx, isLead: true,
            leadName: boardCtx.leadName
        };
        api.initQueue({ code: session.code, store: session.store, idx: own.idx });
        await api.sendAssignmentState('in_progress', { startedAt: new Date().toISOString() });
        hooks.onPoolReady && hooks.onPoolReady(pool, session);
    } catch (e) {
        showToast('Не удалось открыть свой наряд: ' + e.message, 5000);
    }
}

/* ══════════════════════════════════════════════════════════════════════
   ЗАВЕРШЕНИЕ: сводный отчёт и стирание

   Порядок принципиален. Истории мы не храним, поэтому сначала отчёт
   оказывается у ведущего на устройстве, и только потом — отдельным
   подтверждением — данные удаляются с сервера.

   Охват (что кому досталось) восстанавливается из пулов на сервере, а не
   из памяти: ведущий мог перезагрузить страницу и потерять исходный CSV.
   ══════════════════════════════════════════════════════════════════════ */

const REPORT_HEAD = [
    'Проверяющий', 'Товар', 'Наименование', 'ТМ', 'Направление', 'Пол',
    'Участок', 'Кол-во план', 'Статус', 'Причина',
    'Факт: ШК', 'Факт: артикул', 'Факт: наименование', 'Факт: кол-во',
    'Комментарий', 'Время отметки'
];

export async function finishSession(onStep) {
    if (!boardCtx) return null;
    const { code, store } = boardCtx;
    const token = api.loadLeadToken(code);
    if (!token) throw new Error('Нет прав на эту проверку — токен утерян');

    onStep && onStep('Закрытие приёма результатов…');
    try { await api.closeSession(code, token); } catch (e) { /* уже закрыта — не беда */ }

    onStep && onStep('Загрузка состава нарядов…');
    const info = await api.getInfo(code, store);
    const scope = [];                       // [{ checker, idx, product, zone }]
    for (const a of info.assignments) {
        const meta = await api.getAssignment(code, store, a.idx);
        const pool = await api.getPool(code, store, a.idx, meta.parts,
            (p, n) => onStep && onStep(`Наряд «${a.checker}»: ${p}/${n}`));
        pool.forEach(pr => pr.zones.forEach(z => {
            scope.push({ checker: a.checker, idx: a.idx, product: pr, zone: z });
        }));
    }

    onStep && onStep('Загрузка результатов…');
    const results = await api.fetchAllResults(code, token,
        (n, t) => onStep && onStep(`Результаты: ${n}/${t}`));
    const byKey = new Map(results.map(r => [r.tovar + ' ' + r.uch, r]));

    onStep && onStep('Сборка отчёта…');
    const lines = [csvRow(REPORT_HEAD)];
    const stat = { total: 0, done: 0, issues: 0, pending: 0 };
    const perChecker = new Map();

    for (const s of scope) {
        const r = byKey.get(s.product.tovar + ' ' + s.zone.uch);
        const status = r ? r.status : 'waiting';
        stat.total++;
        if (status === 'not_confirmed') stat.issues++;
        else if (status === 'waiting')  stat.pending++;
        else stat.done++;

        const c = perChecker.get(s.checker) || { done: 0, issues: 0, pending: 0, total: 0 };
        c.total++;
        if (status === 'not_confirmed') c.issues++;
        else if (status === 'waiting')  c.pending++;
        else c.done++;
        perChecker.set(s.checker, c);

        if (status === 'confirmed') continue;      // подтверждённое в отчёт не идёт
        const f = r && r.found;
        lines.push(csvRow([
            s.checker, s.product.tovar, s.product.name, s.product.tm,
            s.product.napr, s.product.pol, s.zone.uch, s.zone.kol,
            ZONE_STATUS_LABEL[status] || status,
            r ? reasonLabel(r.reason) : '',
            f ? f.barcode : '',
            f ? (f.tovar || NO_ARTICLE) : '',
            f ? (f.name || '') : '',
            f ? f.kol : '',
            r ? (r.comment || '') : '',
            r && r.at ? new Date(r.at).toLocaleString('ru-RU') : ''
        ]));
    }

    /* Второй лист отдельным файлом: сколько кто сделал и за какое время */
    const covHead = ['Проверяющий', 'Участков в наряде', 'Подтверждено', 'Расхождений',
                     'Не проверено', 'Начало', 'Окончание', 'Состояние'];
    const covLines = [csvRow(covHead)];
    info.assignments.forEach(a => {
        const c = perChecker.get(a.checker) || { total: 0, done: 0, issues: 0, pending: 0 };
        covLines.push(csvRow([
            a.checker, c.total, c.done, c.issues, c.pending,
            a.startedAt  ? new Date(a.startedAt).toLocaleString('ru-RU')  : '',
            a.finishedAt ? new Date(a.finishedAt).toLocaleString('ru-RU') : '',
            a.state === 'done' ? 'сдал' : a.state === 'in_progress' ? 'в работе' : 'не начинал'
        ]));
    });

    return {
        stat,
        stamp: `${store}_${code}`,
        reportCsv  : BOM + lines.join('\r\n') + '\r\n',
        coverageCsv: BOM + covLines.join('\r\n') + '\r\n'
    };
}

export async function eraseSession() {
    if (!boardCtx) return;
    const token = api.loadLeadToken(boardCtx.code);
    if (!token) throw new Error('Токен утерян — стереть нельзя');
    await api.deleteSession(boardCtx.code, token);
    api.dropLeadToken(boardCtx.code);
    boardCtx = null;
}

export { draft, join, MODE_NAPR, MODE_UCH };
