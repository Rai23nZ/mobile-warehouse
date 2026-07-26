/* ═══════════════════════════════════════════════════════════════════════
   main.js — запуск сервера синхронизации на своей машине.

   Тот же самый server/worker.js, что работает в Cloudflare, только
   вместо D1 — локальная SQLite, а вместо платформы Cloudflare — Bun.
   Логика не продублирована: она по-прежнему одна.

   Слушаем только 127.0.0.1: наружу смотрит Caddy, он же держит HTTPS.
   Сервер напрямую из интернета недоступен — на нём нет ни TLS, ни
   защиты от лишнего трафика.

   Переменные окружения (см. /etc/warehouse-sync.env):
     LEAD_KEYS  список «метка:ключ» через запятую — обязателен
     LEAD_KEY   старый одиночный ключ, необязателен
     DB_PATH    файл базы, по умолчанию ./warehouse.db
     PORT       порт, по умолчанию 8787
   ═══════════════════════════════════════════════════════════════════════ */

import worker from '../worker.js';
import { openDatabase } from './sqlite-d1.js';

const DB_PATH = process.env.DB_PATH || './warehouse.db';
const PORT    = Number(process.env.PORT || 8787);

const env = {
    DB       : openDatabase(DB_PATH),
    LEAD_KEYS: process.env.LEAD_KEYS || '',
    LEAD_KEY : process.env.LEAD_KEY  || ''
};

if (!env.LEAD_KEYS && !env.LEAD_KEY) {
    console.error('LEAD_KEYS не задан — создать проверку будет невозможно.');
    console.error('Задайте его в /etc/warehouse-sync.env и перезапустите службу.');
}

/* В Cloudflare ctx.waitUntil продлевает жизнь запроса ради фоновой
   работы. Здесь процесс живёт постоянно, поэтому достаточно не дать
   необработанной ошибке уронить сервер. */
const ctx = {
    waitUntil(promise) { Promise.resolve(promise).catch(e => console.warn('[фон]', e)); }
};

const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    async fetch(request) {
        const started = Date.now();
        try {
            const res = await worker.fetch(request, env, ctx);
            logLine(request, res.status, started);
            return res;
        } catch (e) {
            console.error('[сбой]', e);
            logLine(request, 500, started);
            return new Response(JSON.stringify({ error: 'Сбой на сервере' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8',
                           'Access-Control-Allow-Origin': '*' }
            });
        }
    }
});

/* Короткий журнал: по нему видно, доходят ли запросы и какие именно.
   Коды проверок и токены в журнал не пишем. */
function logLine(request, status, started) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/session\/[A-Z0-9]{6}/i, '/session/******');
    console.log(`${request.method} ${path} → ${status} (${Date.now() - started} мс)`);
}

console.log(`сервер синхронизации слушает 127.0.0.1:${server.port}`);
console.log(`база: ${DB_PATH}`);
console.log(`ключей ведущих задано: ${(env.LEAD_KEYS.split(/[,\n;]+/).filter(s => s.trim()).length) + (env.LEAD_KEY ? 1 : 0)}`);
