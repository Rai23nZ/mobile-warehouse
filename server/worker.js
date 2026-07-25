/* ═══════════════════════════════════════════════════════════════════════
   worker.js — серверная часть синхронизации проверок.
   Разворачивается в Cloudflare Workers, данные хранит в D1.

   Привязки, которые должны быть настроены в панели Cloudflare:
     D1 database  → имя переменной  DB
     Secret       → имя переменной  LEAD_KEY

   ── Модель доступа ─────────────────────────────────────────────────────
   LEAD_KEY    знает только ведущий, вводит один раз на своём устройстве.
               Нужен единственно для создания проверки — чтобы посторонний,
               узнавший адрес, не мог плодить смены в базе.
   leadToken   выдаётся при создании проверки, живёт на устройстве ведущего.
               Даёт право управлять ЭТОЙ проверкой: наряды, сводка,
               завершение, стирание.
   code+store  знают все участники смены. Дают право получить свой наряд
               и отправлять результаты по своим участкам.

   Что эта схема НЕ делает: она не подтверждает, кто именно работает.
   Выбор ФИО из списка — подпись в отчёте, а не вход в личный кабинет.

   ── Ограничения бесплатного тарифа, учтённые в коде ────────────────────
   10 мс процессорного времени на запрос → Worker остаётся тонким:
       агрегаты считает SQL, куски пула не разбираются, а проходят
       насквозь как текст;
   50 запросов к базе за вызов          → результаты пишутся одним
       многострочным INSERT, не построчно;
   2 МБ на значение                     → пул товаров хранится кусками.
   ═══════════════════════════════════════════════════════════════════════ */

const CODE_ALPHABET  = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // без 0/O и 1/I
const CODE_LEN       = 6;
const TOKEN_LEN      = 32;
const MAX_ASSIGNMENTS = 12;
const MAX_CHUNK_BYTES = 900 * 1024;    // с запасом от предела D1 в 2 МБ
const MAX_RESULT_ROWS = 100;           // 100 строк × 9 полей < предела на параметры
const SESSION_TTL_H   = 36;            // брошенные смены подчищаются

const CORS = {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Lead-Key,X-Lead-Token',
    'Access-Control-Max-Age'      : '86400'
};

/* ── Ответы ─────────────────────────────────────────────────────────── */
const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
});
const fail = (status, message) => json({ error: message }, status);

/* ── Мелкие утилиты ─────────────────────────────────────────────────── */
function randomFrom(alphabet, len) {
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    let out = '';
    for (const b of buf) out += alphabet[b % alphabet.length];
    return out;
}

/* Сравнение без ранней остановки: чтобы время ответа не подсказывало,
   сколько первых символов ключа угадано. */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

const nowIso = () => new Date().toISOString();

/* ── Доступ ─────────────────────────────────────────────────────────── */
async function loadSession(env, code) {
    if (!code || code.length !== CODE_LEN) return null;
    return env.DB.prepare('SELECT * FROM sessions WHERE code = ?').bind(code).first();
}

/* Проверяющий: знает код и номер магазина */
async function requireSession(env, code, store) {
    const s = await loadSession(env, code);
    if (!s) return { error: fail(404, 'Проверка не найдена. Проверьте код.') };
    if (String(s.store) !== String(store)) {
        return { error: fail(403, 'Код не подходит к этому номеру магазина.') };
    }
    return { session: s };
}

/* Ведущий: дополнительно предъявляет токен своей проверки */
async function requireLead(env, request, code) {
    const s = await loadSession(env, code);
    if (!s) return { error: fail(404, 'Проверка не найдена.') };
    const token = request.headers.get('X-Lead-Token');
    if (!safeEqual(token || '', s.lead_token)) {
        return { error: fail(403, 'Нет прав на управление этой проверкой.') };
    }
    return { session: s };
}

/* ── Обработчики ────────────────────────────────────────────────────── */

/* POST /session/create
   Заголовок X-Lead-Key. Тело:
   { store, network, leadName, mode, masterName, masterHash,
     assignments: [{ checker, isLead, zoneSpec, items }] }               */
async function createSession(request, env) {
    if (!safeEqual(request.headers.get('X-Lead-Key') || '', env.LEAD_KEY || '')) {
        return fail(403, 'Неверный ключ ведущего.');
    }
    let body;
    try { body = await request.json(); } catch (e) { return fail(400, 'Тело запроса не разобрано.'); }

    const { store, network, leadName, mode, masterName, masterHash, assignments } = body || {};
    if (!store || !network || !leadName) return fail(400, 'Не заданы магазин, сеть или ведущий.');
    if (mode !== 'napr' && mode !== 'uch') return fail(400, 'Режим должен быть napr или uch.');
    if (!Array.isArray(assignments) || !assignments.length) return fail(400, 'Нет ни одного наряда.');
    if (assignments.length > MAX_ASSIGNMENTS) return fail(400, `Слишком много нарядов, максимум ${MAX_ASSIGNMENTS}.`);

    const code      = randomFrom(CODE_ALPHABET, CODE_LEN);
    const leadToken = randomFrom(CODE_ALPHABET + 'abcdefghijkmnpqrstuvwxyz', TOKEN_LEN);
    const created   = nowIso();

    const stmts = [
        env.DB.prepare(
            `INSERT INTO sessions
               (code, store, network, lead_name, mode, lead_token, master_name, master_hash, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,'active',?)`
        ).bind(code, String(store), network, leadName, mode, leadToken,
               masterName || null, masterHash || null, created)
    ];

    assignments.forEach((a, i) => {
        stmts.push(env.DB.prepare(
            `INSERT INTO assignments (code, idx, checker, is_lead, zone_spec, items, state)
             VALUES (?,?,?,?,?,?, 'new')`
        ).bind(code, i, String(a.checker || '').trim() || `Проверяющий ${i + 1}`,
               a.isLead ? 1 : 0, JSON.stringify(a.zoneSpec || {}), Number(a.items) || 0));
    });

    await env.DB.batch(stmts);
    return json({ code, leadToken, createdAt: created });
}

/* POST /session/:code/pool/:idx/:part   — заголовок X-Lead-Token
   Тело приходит СЫРЫМ ТЕКСТОМ и кладётся в базу без разбора:
   так расход процессорного времени не зависит от размера пула. */
async function putPoolChunk(request, env, code, idx, part) {
    const guard = await requireLead(env, request, code);
    if (guard.error) return guard.error;

    const payload = await request.text();
    if (!payload) return fail(400, 'Пустой кусок пула.');
    if (payload.length > MAX_CHUNK_BYTES) return fail(413, 'Кусок пула слишком велик.');

    await env.DB.prepare(
        `INSERT INTO pool_chunks (code, idx, part, payload) VALUES (?,?,?,?)
         ON CONFLICT(code, idx, part) DO UPDATE SET payload = excluded.payload`
    ).bind(code, idx, part, payload).run();

    return json({ ok: true, bytes: payload.length });
}

/* GET /session/:code/info?store=NNNN — что видит присоединяющийся */
async function sessionInfo(env, code, store) {
    const guard = await requireSession(env, code, store);
    if (guard.error) return guard.error;
    const s = guard.session;

    const { results: rows } = await env.DB.prepare(
        `SELECT idx, checker, is_lead, items, state, started_at, finished_at
           FROM assignments WHERE code = ? ORDER BY idx`
    ).bind(code).all();

    return json({
        code: s.code, store: s.store, network: s.network, leadName: s.lead_name,
        mode: s.mode, masterName: s.master_name, masterHash: s.master_hash,
        status: s.status, createdAt: s.created_at,
        assignments: rows.map(r => ({
            idx: r.idx, checker: r.checker, isLead: !!r.is_lead, items: r.items,
            state: r.state, startedAt: r.started_at, finishedAt: r.finished_at
        }))
    });
}

/* GET /session/:code/assignment/:idx?store=NNNN — наряд и число кусков пула */
async function getAssignment(env, code, store, idx) {
    const guard = await requireSession(env, code, store);
    if (guard.error) return guard.error;

    const a = await env.DB.prepare(
        'SELECT * FROM assignments WHERE code = ? AND idx = ?'
    ).bind(code, idx).first();
    if (!a) return fail(404, 'Наряд не найден.');

    const c = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM pool_chunks WHERE code = ? AND idx = ?'
    ).bind(code, idx).first();

    return json({
        idx: a.idx, checker: a.checker, isLead: !!a.is_lead,
        zoneSpec: JSON.parse(a.zone_spec || '{}'),
        items: a.items, state: a.state, parts: c.n,
        network: guard.session.network, mode: guard.session.mode,
        store: guard.session.store
    });
}

/* GET /session/:code/pool/:idx/:part?store=NNNN — кусок пула как есть */
async function getPoolChunk(env, code, store, idx, part) {
    const guard = await requireSession(env, code, store);
    if (guard.error) return guard.error;

    const row = await env.DB.prepare(
        'SELECT payload FROM pool_chunks WHERE code = ? AND idx = ? AND part = ?'
    ).bind(code, idx, part).first();
    if (!row) return fail(404, 'Кусок пула не найден.');

    return new Response(row.payload, {
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
    });
}

/* POST /session/:code/results?store=NNNN
   { idx, rows: [{tovar, uch, status, reason, found, comment, at}],
     state?, startedAt?, finishedAt? }                                    */
async function postResults(request, env, code, store) {
    const guard = await requireSession(env, code, store);
    if (guard.error) return guard.error;
    if (guard.session.status !== 'active') return fail(409, 'Проверка уже завершена.');

    let body;
    try { body = await request.json(); } catch (e) { return fail(400, 'Тело запроса не разобрано.'); }

    const idx  = Number(body.idx);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!Number.isInteger(idx) || idx < 0) return fail(400, 'Не указан номер наряда.');
    if (rows.length > MAX_RESULT_ROWS) return fail(413, `За раз не больше ${MAX_RESULT_ROWS} строк.`);

    const stmts = [];

    if (rows.length) {
        /* Одна многострочная вставка вместо построчной: на вызов Worker
           отпущено не более 50 обращений к базе.
           Ключ строки — (code, tovar, uch). Условие в DO UPDATE не даёт
           одному наряду переписать результат чужого: участок принадлежит
           ровно одному проверяющему. */
        const tuples = rows.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
        const binds  = [];
        for (const r of rows) {
            binds.push(code, idx, String(r.tovar || ''), String(r.uch || ''),
                       String(r.status || ''), r.reason || null,
                       r.found ? JSON.stringify(r.found) : null,
                       r.comment || null, r.at || nowIso());
        }
        stmts.push(env.DB.prepare(
            `INSERT INTO results (code, idx, tovar, uch, status, reason, found, comment, at)
             VALUES ${tuples}
             ON CONFLICT(code, tovar, uch) DO UPDATE SET
               status  = excluded.status,
               reason  = excluded.reason,
               found   = excluded.found,
               comment = excluded.comment,
               at      = excluded.at
             WHERE results.idx = excluded.idx`
        ).bind(...binds));
    }

    const sets = [], vals = [];
    if (body.state)      { sets.push('state = ?');       vals.push(String(body.state)); }
    if (body.startedAt)  { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(body.startedAt); }
    if (body.finishedAt) { sets.push('finished_at = ?'); vals.push(body.finishedAt); }
    if (sets.length) {
        vals.push(code, idx);
        stmts.push(env.DB.prepare(
            `UPDATE assignments SET ${sets.join(', ')} WHERE code = ? AND idx = ?`
        ).bind(...vals));
    }

    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: rows.length });
}

/* GET /session/:code/progress — сводка по нарядам, считает SQL */
async function getProgress(request, env, code) {
    const guard = await requireLead(env, request, code);
    if (guard.error) return guard.error;

    const { results: rows } = await env.DB.prepare(
        `SELECT a.idx, a.checker, a.is_lead, a.items, a.state, a.started_at, a.finished_at,
                COUNT(r.tovar)                                            AS decided,
                SUM(CASE WHEN r.status = 'not_confirmed' THEN 1 ELSE 0 END) AS issues
           FROM assignments a
           LEFT JOIN results r ON r.code = a.code AND r.idx = a.idx
          WHERE a.code = ?
          GROUP BY a.idx
          ORDER BY a.idx`
    ).bind(code).all();

    return json({
        code, status: guard.session.status,
        assignments: rows.map(r => ({
            idx: r.idx, checker: r.checker, isLead: !!r.is_lead, items: r.items,
            state: r.state, startedAt: r.started_at, finishedAt: r.finished_at,
            decided: r.decided || 0, issues: r.issues || 0
        }))
    });
}

/* GET /session/:code/results?offset=&limit= — выгрузка для сводного отчёта */
async function getResults(request, env, code, url) {
    const guard = await requireLead(env, request, code);
    if (guard.error) return guard.error;

    const limit  = Math.min(Number(url.searchParams.get('limit')) || 1000, 2000);
    const offset = Number(url.searchParams.get('offset')) || 0;

    const { results: rows } = await env.DB.prepare(
        `SELECT r.idx, r.tovar, r.uch, r.status, r.reason, r.found, r.comment, r.at,
                a.checker
           FROM results r
           LEFT JOIN assignments a ON a.code = r.code AND a.idx = r.idx
          WHERE r.code = ?
          ORDER BY r.tovar, r.uch
          LIMIT ? OFFSET ?`
    ).bind(code, limit, offset).all();

    const total = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM results WHERE code = ?'
    ).bind(code).first();

    return json({
        total: total.n, offset, limit,
        rows: rows.map(r => ({
            idx: r.idx, checker: r.checker, tovar: r.tovar, uch: r.uch,
            status: r.status, reason: r.reason,
            found: r.found ? JSON.parse(r.found) : null,
            comment: r.comment, at: r.at
        }))
    });
}

/* POST /session/:code/close — проверка закрыта, приём результатов прекращён */
async function closeSession(request, env, code) {
    const guard = await requireLead(env, request, code);
    if (guard.error) return guard.error;
    await env.DB.prepare("UPDATE sessions SET status = 'closed' WHERE code = ?").bind(code).run();
    return json({ ok: true, status: 'closed' });
}

/* DELETE /session/:code — стирание. Вызывается ПОСЛЕ того, как ведущий
   скачал сводный отчёт: истории мы не храним, восстановить будет нечем. */
async function deleteSession(request, env, code) {
    const guard = await requireLead(env, request, code);
    if (guard.error) return guard.error;
    await env.DB.batch([
        env.DB.prepare('DELETE FROM results     WHERE code = ?').bind(code),
        env.DB.prepare('DELETE FROM pool_chunks WHERE code = ?').bind(code),
        env.DB.prepare('DELETE FROM assignments WHERE code = ?').bind(code),
        env.DB.prepare('DELETE FROM sessions    WHERE code = ?').bind(code)
    ]);
    return json({ ok: true, deleted: code });
}

/* Подчистка брошенных смен: если ведущий забыл нажать «завершить»,
   данные не должны лежать в базе вечно. */
async function sweepStale(env) {
    const edge = new Date(Date.now() - SESSION_TTL_H * 3600 * 1000).toISOString();
    const { results: old } = await env.DB.prepare(
        'SELECT code FROM sessions WHERE created_at < ? LIMIT 5'
    ).bind(edge).all();
    for (const s of old) {
        await env.DB.batch([
            env.DB.prepare('DELETE FROM results     WHERE code = ?').bind(s.code),
            env.DB.prepare('DELETE FROM pool_chunks WHERE code = ?').bind(s.code),
            env.DB.prepare('DELETE FROM assignments WHERE code = ?').bind(s.code),
            env.DB.prepare('DELETE FROM sessions    WHERE code = ?').bind(s.code)
        ]);
    }
    return old.length;
}

/* ── Маршрутизация ──────────────────────────────────────────────────── */
export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

        const url   = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const store = url.searchParams.get('store');
        const M     = request.method;

        try {
            if (!parts.length) {
                return new Response('warehouse sync worker', { headers: CORS });
            }

            if (parts[0] === 'health') {
                let db;
                try {
                    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first();
                    db = 'база привязана, активных проверок: ' + r.n;
                } catch (e) { db = 'ОШИБКА БАЗЫ: ' + e.message; }
                return json({ ok: true, db, leadKey: env.LEAD_KEY ? 'секрет задан' : 'СЕКРЕТ НЕ ЗАДАН', time: nowIso() });
            }

            if (parts[0] !== 'session') return fail(404, 'Неизвестный путь.');

            // POST /session/create
            if (parts[1] === 'create' && M === 'POST') {
                ctx.waitUntil(sweepStale(env).catch(() => {}));
                return createSession(request, env);
            }

            const code = (parts[1] || '').toUpperCase();
            const tail = parts[2];

            if (!tail) {
                if (M === 'DELETE') return deleteSession(request, env, code);
                return fail(404, 'Неизвестный путь.');
            }

            if (tail === 'info'       && M === 'GET')  return sessionInfo(env, code, store);
            if (tail === 'progress'   && M === 'GET')  return getProgress(request, env, code);
            if (tail === 'results'    && M === 'GET')  return getResults(request, env, code, url);
            if (tail === 'results'    && M === 'POST') return postResults(request, env, code, store);
            if (tail === 'close'      && M === 'POST') return closeSession(request, env, code);

            if (tail === 'assignment' && M === 'GET') {
                return getAssignment(env, code, store, Number(parts[3]));
            }
            if (tail === 'pool') {
                const idx = Number(parts[3]), part = Number(parts[4]);
                if (!Number.isInteger(idx) || !Number.isInteger(part)) return fail(400, 'Неверный номер наряда или куска.');
                if (M === 'POST') return putPoolChunk(request, env, code, idx, part);
                if (M === 'GET')  return getPoolChunk(env, code, store, idx, part);
            }

            return fail(404, 'Неизвестный путь.');
        } catch (e) {
            return fail(500, 'Сбой на сервере: ' + e.message);
        }
    }
};
