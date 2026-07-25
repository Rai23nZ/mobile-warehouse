/* ═══════════════════════════════════════════════════════════════════════
   csv.js — чтение и запись CSV

   Чистые функции без обращений к DOM: их можно проверять отдельно от
   интерфейса.
   ═══════════════════════════════════════════════════════════════════════ */

/* Синонимы заголовков. Точное совпадение имеет приоритет над вхождением
   подстроки: иначе колонка «Наименование товара», стоящая раньше настоящей
   «Товар», перехватывала ключ по подстроке «товар». */
export const HEADER_KEYS = {
    tovar: ['товар', 'штрихкод', 'артикул', 'штрих-код', 'sku'],
    name : ['наименование', 'название', 'наименование товара'],
    tm   : ['тм', 'бренд', 'марка', 'торговая марка'],
    uch  : ['уч. скан.', 'участок', 'уч.скан.', 'зона'],
    kol  : ['кол-во', 'количество', 'кол во', 'колво'],
    napr : ['направление', 'категория'],
    pol  : ['пол', 'гендер', 'пол/категория']
};

export const HEADER_TITLES = {
    tovar: 'Товар', name: 'Наименование', tm: 'ТМ', uch: 'Участок',
    kol: 'Кол-во', napr: 'Направление', pol: 'Пол'
};

export const BOM = '﻿';   // без него Excel читает кириллицу как мусор

/* ── Разбор ────────────────────────────────────────────────────────── */

/* Разделитель считаем только вне кавычек и только по первой записи */
export function detectDelimiter(text) {
    const counts = { ';': 0, '\t': 0, ',': 0 };
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === '\n') break;
        if (ch in counts) counts[ch]++;
    }
    const best = Object.keys(counts).reduce((a, b) => counts[b] > counts[a] ? b : a, ';');
    return counts[best] > 0 ? best : ';';
}

/* Токенизация всего текста целиком.

   Раньше файл сначала резался по '\n', и только потом каждая строка
   разбиралась с учётом кавычек. Из-за этого поле вида
   "Куртка, модель\n2024" разваливало запись на две. Здесь перевод строки
   внутри кавычек — обычный символ, а не конец записи. */
export function parseCsv(text, delimiter) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);          // BOM из Excel
    const delim = delimiter || detectDelimiter(text);
    const rows  = [[]];
    let field = '', quoted = false;

    const endField = () => { rows[rows.length - 1].push(field.trim()); field = ''; };
    const endRow   = () => { endField(); rows.push([]); };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        }
        else if (ch === '"')     quoted = true;
        else if (ch === delim)   endField();
        else if (ch === '\n')    endRow();
        else if (ch !== '\r')    field += ch;
    }
    endField();
    return rows.filter(r => r.some(c => c !== ''));                   // пустые строки долой
}

export function cleanValue(v) {
    return v ? String(v).trim().replace(/^["']|["']$/g, '').replace(/""/g, '"') : '';
}

/* Точное совпадение заголовка приоритетнее вхождения подстроки */
export function findHeaderIndex(headers, keywords) {
    const norm = headers.map(h => String(h || '').toLowerCase().trim());
    const keys = keywords.map(k => k.toLowerCase());
    const exact = norm.findIndex(h => keys.includes(h));
    if (exact !== -1) return exact;
    return norm.findIndex(h => h && keys.some(k => h.includes(k)));
}

/* «1 250», «1 250,00», «12.0» → 1250 / 12 */
export function parseQuantity(raw) {
    const v = cleanValue(raw).replace(/[\s ]/g, '').replace(',', '.');
    if (!v) return 0;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
}

/* Участки: числовые по возрастанию, нечисловые — в конец по алфавиту.
   Прежний `parseInt(a.uch) - parseInt(b.uch)` на значении вида «A-12»
   давал NaN и непредсказуемый порядок. */
export function compareZones(a, b) {
    const an = parseInt(a.uch, 10), bn = parseInt(b.uch, 10);
    const aOk = Number.isFinite(an), bOk = Number.isFinite(bn);
    if (aOk && bOk) return an - bn;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return String(a.uch).localeCompare(String(b.uch), 'ru', { numeric: true });
}

/* Собирает товары из разобранных строк.
   Возвращает { headers, idx, products, stats } либо бросает ошибку. */
export function buildProducts(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('Файл пуст');

    const headers = rows[0];
    const idx = {};
    Object.keys(HEADER_KEYS).forEach(k => { idx[k] = findHeaderIndex(headers, HEADER_KEYS[k]); });
    if (idx.tovar === -1) {
        throw new Error('Не найден столбец «Товар». Заголовки в файле: ' + headers.join(' | '));
    }

    const byId = new Map();
    let dataRows = 0, zoneRows = 0, skipped = 0;

    for (let r = 1; r < rows.length; r++) {
        const cells   = rows[r];
        const barcode = cleanValue(cells[idx.tovar]);
        if (!barcode) { skipped++; continue; }
        dataRows++;

        let p = byId.get(barcode);
        if (!p) {
            p = {
                tovar: barcode,
                name : cleanValue(cells[idx.name]),
                tm   : cleanValue(cells[idx.tm]),
                napr : cleanValue(cells[idx.napr]),
                pol  : cleanValue(cells[idx.pol]),
                ost_plan: 0,
                zones: []
            };
            byId.set(barcode, p);
        }

        const zoneNumber = cleanValue(cells[idx.uch]);
        const quantity   = parseQuantity(cells[idx.kol]);
        if (zoneNumber && quantity > 0) {
            const existing = p.zones.find(z => z.uch === zoneNumber);
            if (existing) existing.kol += quantity;
            else p.zones.push({ uch: zoneNumber, kol: quantity, checked: false, status: 'waiting', comment: '' });
            /* План наращивается в обоих случаях. Раньше при дублирующихся
               строках на один участок количество попадало в зону, но не в
               план: факт никогда не сходился с планом, из-за чего у таких
               товаров не срабатывали ни автопереход, ни финальный модал. */
            p.ost_plan += quantity;
            zoneRows++;
        }
    }

    const products = [...byId.values()];
    products.forEach(p => p.zones.sort(compareZones));

    return {
        headers, idx, products,
        stats: {
            products: products.length,
            dataRows, zoneRows, skipped,
            noZones: products.filter(p => !p.zones.length).length
        }
    };
}

/* Порядок товаров для проверки: по номеру первого участка, затем по артикулу */
export function compareProductsForRoute(a, b) {
    const key = p => {
        const n = parseInt(p.zones[0]?.uch, 10);
        return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    };
    const ak = key(a), bk = key(b);
    return ak !== bk ? ak - bk : a.tovar.localeCompare(b.tovar, undefined, { numeric: true });
}

/* ── Выгрузка ──────────────────────────────────────────────────────── */

/* Полное квотирование по RFC 4180. Раньше заменялись только «;», а перевод
   строки в комментарии разрывал запись и сдвигал все последующие колонки. */
export function csvEscape(value) {
    const v = String(value ?? '');
    return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
export function csvRow(cells) { return cells.map(csvEscape).join(';'); }

/* В отчёт идут и незакрытые участки: прерванная проверка раньше нигде не
   фиксировалась, и получатель не мог отличить «проверено, всё на месте»
   от «до этой позиции просто не дошли». */
export const ZONE_STATUS_LABEL = { not_confirmed: 'РАСХОЖДЕНИЕ', waiting: 'НЕ ПРОВЕРЕНО' };

const REPORT_HEAD = ['Товар', 'Наименование', 'ТМ', 'Направление', 'Пол',
                     'Участок', 'Кол-во план', 'Статус', 'Причина'];

export function buildReport(products) {
    const lines = [csvRow(REPORT_HEAD)];
    let issues = 0, pending = 0;

    products.forEach(p => {
        p.zones.forEach(z => {
            const label = ZONE_STATUS_LABEL[z.status];
            if (!label) return;                        // confirmed в отчёт не идёт
            if (z.status === 'not_confirmed') issues++; else pending++;
            lines.push(csvRow([p.tovar, p.name, p.tm, p.napr, p.pol,
                               z.uch, z.kol, label, z.comment || '']));
        });
    });

    return {
        issues, pending, rows: lines.length - 1,
        text: BOM + lines.join('\r\n') + '\r\n'
    };
}
