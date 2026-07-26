/* ═══════════════════════════════════════════════════════════════════════
   assign.js — разбиение проверки на наряды.

   Два режима, смешанного нет:

   MODE_NAPR — ведущий задаёт каждому проверяющему фильтр по направлению,
               ТМ и полу. Единица работы — артикул со всеми его участками.
               Покрытие считается по артикулам.

   MODE_UCH  — участки сканирования делятся по порядку на равные по
               КОЛИЧЕСТВУ группы, без привязки к атрибутам товара.
               Единица работы — пара (артикул, участок): один и тот же
               артикул может попасть к двум проверяющим разными участками.
               Покрытие считается по участкам.

   Чистые функции без обращений к DOM и к сети.
   ═══════════════════════════════════════════════════════════════════════ */

import { compareZones, compareProductsForRoute } from './csv.js';

export const MODE_NAPR = 'napr';
export const MODE_UCH  = 'uch';

/* ── Участки ───────────────────────────────────────────────────────── */

/* Все различные участки файла, в том же порядке, в каком идёт проверка:
   числовые по возрастанию, нечисловые следом по алфавиту. */
export function collectZones(products) {
    const seen = new Set();
    products.forEach(p => p.zones.forEach(z => seen.add(z.uch)));
    return [...seen].sort((a, b) => compareZones({ uch: a }, { uch: b }));
}

/* Непрерывные группы, поровну по числу участков.
   Остаток раздаётся первым группам: при 10 участках на 3 проверяющих
   выйдет 4 + 3 + 3, а не 3 + 3 + 4. */
export function splitZonesEqually(zones, groups) {
    const n = Math.max(1, Math.floor(groups));
    const base = Math.floor(zones.length / n);
    const extra = zones.length % n;
    const out = [];
    let pos = 0;
    for (let i = 0; i < n; i++) {
        const size = base + (i < extra ? 1 : 0);
        out.push(zones.slice(pos, pos + size));
        pos += size;
    }
    return out;
}

/* ── Пулы товаров ──────────────────────────────────────────────────── */

/* Глубокая копия: наряды не должны делить объекты зон между собой,
   иначе отметка одного проверяющего протекла бы в пул другого. */
function cloneZone(z) {
    return {
        uch: z.uch, kol: z.kol,
        checked: false, status: 'waiting',
        reason: null, found: null, comment: '', at: null
    };
}

/* Пул под набор участков. План пересчитывается ТОЛЬКО по своим участкам —
   иначе факт никогда не сойдётся с планом, и у проверяющего не сработают
   ни зелёная панель, ни автопереход, ни финальное окно. */
export function poolForZones(products, zoneKeys) {
    const want = zoneKeys instanceof Set ? zoneKeys : new Set(zoneKeys);
    const pool = [];
    
    for (const p of products) {
        const zones = p.zones.filter(z => want.has(z.uch)).map(cloneZone);
        if (!zones.length) continue;
        
        /* РАЗДЕЛЕНИЕ: каждый участок становится отдельным шагом маршрута.
           Создаем уникальный ID, чтобы Map в store.js не перезаписал артикул */
        for (const z of zones) {
            pool.push({
                id: p.tovar + '::' + z.uch,
                tovar: p.tovar, 
                name: p.name, 
                tm: p.tm, 
                napr: p.napr, 
                pol: p.pol,
                ost_plan: z.kol,
                zones: [z]
            });
        }
    }
    
    /* СТРОГАЯ СОРТИРОВКА: по участкам, а при совпадении — по артикулу */
    pool.sort((a, b) => {
        const cmp = compareZones({ uch: a.zones[0].uch }, { uch: b.zones[0].uch });
        return cmp !== 0 ? cmp : a.tovar.localeCompare(b.tovar, undefined, { numeric: true });
    });
    
    return pool;
}

/* Пул под фильтр: артикул берётся целиком, со всеми своими участками */
export function poolForFilter(products, spec) {
    const { napr, tm, pol } = spec || {};
    const pool = [];
    
    for (const p of products) {
        if (napr && p.napr !== napr) continue;
        if (tm   && p.tm   !== tm)   continue;
        if (pol  && p.pol  !== pol)  continue;
        
        const zones = p.zones.map(cloneZone);
        pool.push({
            tovar: p.tovar, name: p.name, tm: p.tm, napr: p.napr, pol: p.pol,
            ost_plan: zones.reduce((s, z) => s + z.kol, 0),
            zones
        });
    }
    
    /* СОРТИРОВКА ПО НАПРАВЛЕНИЮ: карточка ориентируется на первый (наименьший) участок */
    pool.sort(compareProductsForRoute);
    return pool;
}

/* ── Построение нарядов ────────────────────────────────────────────── */

/* checkers: [{ name, isLead }] — порядок задаёт порядок участков */
export function buildByZones(products, checkers) {
    const zones  = collectZones(products);
    const groups = splitZonesEqually(zones, checkers.length);

    return checkers.map((c, i) => {
        const list = groups[i] || [];
        const pool = poolForZones(products, list);
        return {
            checker : c.name,
            isLead  : !!c.isLead,
            zoneSpec: {
                kind: MODE_UCH,
                list,
                from: list[0] || null,
                to  : list[list.length - 1] || null
            },
            pool,
            items : pool.length,
            zonesCount: list.length,
            units : pool.reduce((s, p) => s + p.ost_plan, 0)
        };
    });
}

/* specs: [{ name, isLead, napr, tm, pol }] */
export function buildByFilter(products, specs) {
    return specs.map(s => {
        const pool = poolForFilter(products, s);
        return {
            checker : s.name,
            isLead  : !!s.isLead,
            zoneSpec: { kind: MODE_NAPR, napr: s.napr || '', tm: s.tm || '', pol: s.pol || '' },
            pool,
            items : pool.length,
            zonesCount: pool.reduce((n, p) => n + p.zones.length, 0),
            units : pool.reduce((s2, p) => s2 + p.ost_plan, 0)
        };
    });
}

export function buildAssignments(products, mode, checkers) {
    return mode === MODE_UCH ? buildByZones(products, checkers)
                             : buildByFilter(products, checkers);
}

/* ── Покрытие ──────────────────────────────────────────────────────────
   Считается ДО начала работы, чтобы перекос и дыры в распределении были
   видны ведущему сразу, а не обнаруживались при сборке отчёта. */
export function analyzeCoverage(products, assignments, mode) {
    const report = {
        mode,
        totalProducts: products.length,
        totalZones   : collectZones(products).length,
        uncovered    : [],     // артикулы или участки, не попавшие никому
        overlaps     : [],     // попавшие более чем одному
        balance      : assignments.map(a => ({
            checker: a.checker, items: a.items, zones: a.zonesCount, units: a.units
        }))
    };

    if (mode === MODE_UCH) {
        /* Участки делятся без пересечений по построению, поэтому
           проверяем лишь товары, у которых участков нет вовсе. */
        report.uncovered = products.filter(p => !p.zones.length).map(p => p.tovar);
        report.uncoveredKind = 'артикулы без участков сканирования';
    } else {
        const count = new Map();          // артикул -> сколько нарядов его взяли
        assignments.forEach(a => a.pool.forEach(p => {
            count.set(p.tovar, (count.get(p.tovar) || 0) + 1);
        }));
        products.forEach(p => {
            const n = count.get(p.tovar) || 0;
            if (n === 0) report.uncovered.push(p.tovar);
            else if (n > 1) report.overlaps.push({ tovar: p.tovar, times: n });
        });
        report.uncoveredKind = 'артикулы, не попавшие ни в один наряд';
    }

    /* Насколько неравномерно легла нагрузка. При делении поровну по числу
       участков это ожидаемо: участки различаются по наполнению. */
    const units = report.balance.map(b => b.units);
    const max = units.length ? Math.max(...units) : 0;
    const min = units.length ? Math.min(...units) : 0;
    report.spread = { min, max, ratio: min > 0 ? +(max / min).toFixed(2) : null };

    return report;
}

/* ── Нарезка пула для передачи на сервер ───────────────────────────────
   У D1 предел 2 МБ на одно значение, а наряд единственного проверяющего
   содержит весь файл целиком. Режем по размеру JSON, а не по числу
   товаров: строки наименований сильно различаются по длине. */
export function chunkPool(pool, maxBytes = 700 * 1024) {
    const parts = [];
    let buf = [], size = 2;                    // квадратные скобки массива
    for (const item of pool) {
        const piece = JSON.stringify(item);
        if (buf.length && size + piece.length + 1 > maxBytes) {
            parts.push('[' + buf.join(',') + ']');
            buf = []; size = 2;
        }
        buf.push(piece);
        size += piece.length + 1;
    }
    if (buf.length) parts.push('[' + buf.join(',') + ']');
    return parts;
}
