/* ═══════════════════════════════════════════════════════════════════════
   sqlite-d1.js — обёртка над локальной SQLite, повторяющая интерфейс D1.

   Смысл: `server/worker.js` переносится на свой сервер БЕЗ ЕДИНОЙ ПРАВКИ.
   Он написан против D1 (`env.DB.prepare().bind().first()/all()/run()` и
   `env.DB.batch()`), а здесь ровно этот набор реализован поверх
   встроенной в Bun библиотеки SQLite.

   Так проверенный на Cloudflare код остаётся единственным местом, где
   живёт логика: разграничение прав, защита чужих отметок, подчистка
   брошенных смен. Дублировать её на сервере не нужно.
   ═══════════════════════════════════════════════════════════════════════ */

import { Database } from 'bun:sqlite';

/* Таблицы создаются при первом запуске: одной ручной операцией меньше,
   и невозможна ситуация «сервер поднят, а схемы нет». */
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS sessions (
        code TEXT PRIMARY KEY, store TEXT NOT NULL, network TEXT NOT NULL,
        lead_name TEXT NOT NULL, mode TEXT NOT NULL, lead_token TEXT NOT NULL,
        master_name TEXT, master_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS assignments (
        code TEXT NOT NULL, idx INTEGER NOT NULL, checker TEXT NOT NULL,
        is_lead INTEGER NOT NULL DEFAULT 0, zone_spec TEXT NOT NULL,
        items INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new',
        started_at TEXT, finished_at TEXT, PRIMARY KEY (code, idx))`,
    `CREATE TABLE IF NOT EXISTS pool_chunks (
        code TEXT NOT NULL, idx INTEGER NOT NULL, part INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY (code, idx, part))`,
    `CREATE TABLE IF NOT EXISTS results (
        code TEXT NOT NULL, idx INTEGER NOT NULL, tovar TEXT NOT NULL,
        uch TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, found TEXT,
        comment TEXT, at TEXT NOT NULL, PRIMARY KEY (code, tovar, uch))`,
    `CREATE INDEX IF NOT EXISTS idx_assign_code  ON assignments(code)`,
    `CREATE INDEX IF NOT EXISTS idx_results_code ON results(code)`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_code  ON pool_chunks(code, idx)`
];

/* Подготовленный запрос. У D1 `bind()` возвращает НОВЫЙ объект, а не
   меняет исходный, — повторяем это поведение, иначе один и тот же
   `prepare()` с разными параметрами вёл бы себя иначе, чем в облаке. */
class Statement {
    constructor(db, sql, params = []) {
        this.db = db; this.sql = sql; this.params = params;
    }

    bind(...params) { return new Statement(this.db, this.sql, params); }

    /* Синхронное исполнение — нужно внутри транзакции batch() */
    execSync() {
        const stmt = this.db.query(this.sql);
        const isRead = /^\s*(select|with|pragma)/i.test(this.sql);
        if (isRead) return { results: stmt.all(...this.params), success: true };
        const info = stmt.run(...this.params);
        return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }

    /* D1 возвращает промисы. Методы объявлены async, чтобы `await` в
       worker.js работал одинаково и там, и здесь. */
    async first() {
        const row = this.db.query(this.sql).get(...this.params);
        return row ?? null;                    // D1 отдаёт null, а не undefined
    }

    async all() {
        return { results: this.db.query(this.sql).all(...this.params), success: true };
    }

    async run() { return this.execSync(); }
}

class D1Compatible {
    constructor(db) { this.db = db; }

    prepare(sql) { return new Statement(this.db, sql); }

    /* D1 выполняет batch одной транзакцией: либо всё, либо ничего.
       Для нас это важно при создании проверки — сессия и наряды должны
       появиться вместе, иначе получится смена без нарядов. */
    async batch(statements) {
        const run = this.db.transaction(list => list.map(s => s.execSync()));
        return run(statements);
    }

    /* Не входит в интерфейс D1, используется только при запуске */
    applySchema() { SCHEMA.forEach(sql => this.db.run(sql)); }
}

export function openDatabase(path) {
    const db = new Database(path, { create: true });

    /* WAL — чтобы чтение не блокировалось записью: ведущий обновляет
       сводку, пока проверяющие шлют отметки.
       busy_timeout — вместо мгновенной ошибки «database is locked»
       подождать освобождения; при нашей нагрузке этого достаточно.
       foreign_keys на будущее: связей пока нет, но привычка полезная. */
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA foreign_keys = ON');

    const wrapped = new D1Compatible(db);
    wrapped.applySchema();
    return wrapped;
}
