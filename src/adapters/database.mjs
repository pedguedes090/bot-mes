import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

const MIGRATIONS = [
    // v1: Initial schema
    `
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT,
        is_e2ee INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);

    CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        prefix TEXT DEFAULT '!',
        language TEXT DEFAULT 'vi',
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0,
        first_seen TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1');
    `,
];

export class Database {
    #db;
    #logger;
    #stmts = {};

    constructor(dbPath, logger) {
        this.#logger = logger.child('db');
        this.#db = new DatabaseSync(dbPath);
        this.#db.exec('PRAGMA journal_mode = WAL');    // Better concurrent read perf
        this.#db.exec('PRAGMA synchronous = NORMAL');  // Good balance safety/speed
        this.#db.exec('PRAGMA foreign_keys = ON');
        this.#migrate();
        this.#prepareStatements();
        this.#logger.info('Database ready', { path: dbPath });
    }

    #migrate() {
        for (const sql of MIGRATIONS) {
            this.#db.exec(sql);
        }
        this.#logger.debug('Migrations applied', { version: SCHEMA_VERSION });
    }

    #prepareStatements() {
        this.#stmts = {
            insertMsg: this.#db.prepare(
                `INSERT OR IGNORE INTO messages (id, thread_id, sender_id, text, is_e2ee, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ),
            getMsgsByThread: this.#db.prepare(
                `SELECT * FROM messages WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?`
            ),
            upsertThread: this.#db.prepare(
                `INSERT INTO threads (id, name, is_group) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, name),
                 updated_at = datetime('now')`
            ),
            getThread: this.#db.prepare(`SELECT * FROM threads WHERE id = ?`),
            setThreadField: this.#db.prepare(
                `UPDATE threads SET updated_at = datetime('now') WHERE id = ?`
            ),
            upsertUser: this.#db.prepare(
                `INSERT INTO users (id, name) VALUES (?, ?)
                 ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, name),
                 updated_at = datetime('now')`
            ),
            getUser: this.#db.prepare(`SELECT * FROM users WHERE id = ?`),
            setSetting: this.#db.prepare(
                `INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            ),
            getSetting: this.#db.prepare(`SELECT value FROM settings WHERE key = ?`),
        };
    }

    // --- Messages ---

    saveMessage(msg, isE2EE = false) {
        const id = msg.messageId || msg.id || '';
        if (!id) return;
        const threadId = String(msg.threadId || msg.chatJid || '');
        const senderId = String(msg.senderId || '');
        const timestamp = Number(msg.timestamp || msg.timestampMs || Date.now());
        this.#stmts.insertMsg.run(id, threadId, senderId, msg.text || null, isE2EE ? 1 : 0, timestamp);
    }

    getMessages(threadId, limit = 50) {
        return this.#stmts.getMsgsByThread.all(String(threadId), limit);
    }

    // --- Threads ---

    ensureThread(threadId, name = null, isGroup = false) {
        this.#stmts.upsertThread.run(String(threadId), name, isGroup ? 1 : 0);
    }

    getThread(threadId) {
        return this.#stmts.getThread.get(String(threadId)) || null;
    }

    listThreads(limit = 50, offset = 0) {
        return this.#db.prepare(
            `SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        ).all(limit, offset);
    }

    setThreadPrefix(threadId, prefix) {
        this.#db.prepare(`UPDATE threads SET prefix = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(prefix, String(threadId));
    }

    setThreadEnabled(threadId, enabled) {
        this.#db.prepare(`UPDATE threads SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(enabled ? 1 : 0, String(threadId));
    }

    // --- Users ---

    ensureUser(userId, name = null) {
        this.#stmts.upsertUser.run(String(userId), name);
    }

    getUser(userId) {
        return this.#stmts.getUser.get(String(userId)) || null;
    }

    listUsers(limit = 50, offset = 0) {
        return this.#db.prepare(
            `SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        ).all(limit, offset);
    }

    setAdmin(userId, isAdmin) {
        this.#db.prepare(`UPDATE users SET is_admin = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(isAdmin ? 1 : 0, String(userId));
    }

    setBlocked(userId, isBlocked) {
        this.#db.prepare(`UPDATE users SET is_blocked = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(isBlocked ? 1 : 0, String(userId));
    }

    isBlocked(userId) {
        const user = this.getUser(userId);
        return user?.is_blocked === 1;
    }

    // --- Settings ---

    set(key, value) {
        this.#stmts.setSetting.run(key, String(value));
    }

    get(key, fallback = null) {
        const row = this.#stmts.getSetting.get(key);
        return row?.value ?? fallback;
    }

    // --- Stats ---

    stats() {
        const msgCount = this.#db.prepare('SELECT COUNT(*) as c FROM messages').get();
        const threadCount = this.#db.prepare('SELECT COUNT(*) as c FROM threads').get();
        const userCount = this.#db.prepare('SELECT COUNT(*) as c FROM users').get();
        return {
            messages: msgCount.c,
            threads: threadCount.c,
            users: userCount.c,
        };
    }

    close() {
        this.#db.close();
        this.#logger.info('Database closed');
    }
}
