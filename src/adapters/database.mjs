import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 2;

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
    // v2: Add username and profile_pic to users
    `
    ALTER TABLE users ADD COLUMN username TEXT;
    ALTER TABLE users ADD COLUMN profile_pic TEXT;
    INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '2');
    `,
];

export class Database {
    #db;
    #logger;
    #stmts = {};
    #maintenanceTimer = null;

    constructor(dbPath, logger) {
        this.#logger = logger.child('db');
        this.#db = new DatabaseSync(dbPath);
        this.#db.exec('PRAGMA journal_mode = WAL');    // Better concurrent read perf
        this.#db.exec('PRAGMA synchronous = NORMAL');  // Good balance safety/speed
        this.#db.exec('PRAGMA foreign_keys = ON');
        this.#db.exec('PRAGMA cache_size = -2000');    // ~2MB page cache
        this.#db.exec('PRAGMA temp_store = MEMORY');   // Temp tables in RAM
        this.#migrate();
        this.#prepareStatements();
        this.#startMaintenance();
        this.#logger.info('Database ready', { path: dbPath });
    }

    #migrate() {
        let currentVersion = 0;
        try {
            const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
            if (row) currentVersion = parseInt(row.value, 10);
        } catch {
            // Settings table or key might not exist yet -> version 0
        }

        this.#logger.info('Current DB schema version', { version: currentVersion });

        for (let i = 0; i < MIGRATIONS.length; i++) {
            const migrationVer = i + 1;
            if (currentVersion >= migrationVer) continue;

            this.#logger.info(`Applying migration v${migrationVer}`);
            try {
                this.#db.exec(MIGRATIONS[i]);
            } catch (err) {
                // Handle partial migration state (e.g. column added but version not updated)
                if (err.message.includes('duplicate column name')) {
                    this.#logger.warn(`Migration v${migrationVer} partial error (safe to ignore): ${err.message}`);
                } else {
                    throw err;
                }
            }
        }
        this.#logger.debug('Migrations completed', { targetVersion: SCHEMA_VERSION });
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
                `INSERT INTO users (id, name, username, profile_pic) VALUES (?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET 
                    name = coalesce(excluded.name, name),
                    username = coalesce(excluded.username, username),
                    profile_pic = coalesce(excluded.profile_pic, profile_pic),
                    updated_at = datetime('now')`
            ),
            getUser: this.#db.prepare(`SELECT * FROM users WHERE id = ?`),
            setSetting: this.#db.prepare(
                `INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            ),
            getSetting: this.#db.prepare(`SELECT value FROM settings WHERE key = ?`),
            // Previously ad-hoc statements — now prepared once
            listThreads: this.#db.prepare(
                `SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?`
            ),
            listUsers: this.#db.prepare(
                `SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?`
            ),
            setThreadPrefix: this.#db.prepare(
                `UPDATE threads SET prefix = ?, updated_at = datetime('now') WHERE id = ?`
            ),
            setThreadEnabled: this.#db.prepare(
                `UPDATE threads SET enabled = ?, updated_at = datetime('now') WHERE id = ?`
            ),
            setAdmin: this.#db.prepare(
                `UPDATE users SET is_admin = ?, updated_at = datetime('now') WHERE id = ?`
            ),
            setBlocked: this.#db.prepare(
                `UPDATE users SET is_blocked = ?, updated_at = datetime('now') WHERE id = ?`
            ),
            countMessages: this.#db.prepare('SELECT COUNT(*) as c FROM messages'),
            countThreads: this.#db.prepare('SELECT COUNT(*) as c FROM threads'),
            countUsers: this.#db.prepare('SELECT COUNT(*) as c FROM users'),
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
        return this.#stmts.listThreads.all(limit, offset);
    }

    setThreadPrefix(threadId, prefix) {
        this.#stmts.setThreadPrefix.run(prefix, String(threadId));
    }

    setThreadEnabled(threadId, enabled) {
        this.#stmts.setThreadEnabled.run(enabled ? 1 : 0, String(threadId));
    }

    // --- Users ---

    ensureUser(userId, name = null, username = null, profilePic = null) {
        this.#stmts.upsertUser.run(String(userId), name, username, profilePic);
    }

    getUser(userId) {
        return this.#stmts.getUser.get(String(userId)) || null;
    }

    listUsers(limit = 50, offset = 0) {
        return this.#stmts.listUsers.all(limit, offset);
    }

    setAdmin(userId, isAdmin) {
        this.#stmts.setAdmin.run(isAdmin ? 1 : 0, String(userId));
    }

    setBlocked(userId, isBlocked) {
        this.#stmts.setBlocked.run(isBlocked ? 1 : 0, String(userId));
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
        const msgCount = this.#stmts.countMessages.get();
        const threadCount = this.#stmts.countThreads.get();
        const userCount = this.#stmts.countUsers.get();
        return {
            messages: msgCount.c,
            threads: threadCount.c,
            users: userCount.c,
        };
    }

    close() {
        if (this.#maintenanceTimer) {
            clearInterval(this.#maintenanceTimer);
            this.#maintenanceTimer = null;
        }
        this.#db.close();
        this.#logger.info('Database closed');
    }

    // --- Maintenance ---

    #startMaintenance() {
        // Run WAL checkpoint and old message pruning every 30 minutes
        this.#maintenanceTimer = setInterval(() => {
            this.#runMaintenance();
        }, 30 * 60 * 1000);
        this.#maintenanceTimer.unref();
    }

    #runMaintenance() {
        try {
            // Checkpoint WAL to prevent unbounded WAL file growth (reclaims RSS)
            this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            // Prune messages older than 7 days to prevent unbounded DB growth
            this.#db.exec("DELETE FROM messages WHERE timestamp < (strftime('%s','now','-7 days') * 1000)");
            this.#logger.debug('Database maintenance completed');
        } catch (err) {
            this.#logger.warn('Database maintenance error', { error: err.message });
        }
    }
}
