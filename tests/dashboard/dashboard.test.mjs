import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDashboardHandler } from '../../src/dashboard/handler.mjs';

// Minimal mock logger
function mockLogger() {
    return {
        child: () => mockLogger(),
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    };
}

// Minimal mock metrics
function mockMetrics() {
    return {
        snapshot: () => ({
            uptime_seconds: 60,
            'events.received': 100,
            'events.processed': 90,
            'events.blocked': 5,
            'events.deduplicated': 3,
            'events.dropped': 2,
            'messages.sent': 50,
            'media.sent': 10,
            'errors.handler': 1,
            'errors.total': 2,
        }),
    };
}

// Minimal mock database
function mockDb() {
    const users = new Map();
    const threads = new Map();
    const messages = new Map();

    return {
        getUser: (id) => users.get(id) || null,
        ensureUser: (id, name) => {
            if (!users.has(id)) users.set(id, { id, name, is_admin: 0, is_blocked: 0, first_seen: '2024-01-01' });
        },
        listUsers: (limit, offset) => [...users.values()].slice(offset, offset + limit),
        setBlocked: (id, blocked) => { const u = users.get(id); if (u) u.is_blocked = blocked ? 1 : 0; },
        setAdmin: (id, admin) => { const u = users.get(id); if (u) u.is_admin = admin ? 1 : 0; },
        getThread: (id) => threads.get(id) || null,
        ensureThread: (id, name, isGroup) => {
            if (!threads.has(id)) threads.set(id, { id, name, is_group: isGroup ? 1 : 0, prefix: '!', enabled: 1 });
        },
        listThreads: (limit, offset) => [...threads.values()].slice(offset, offset + limit),
        getMessages: (threadId, limit) => (messages.get(threadId) || []).slice(0, limit),
        stats: () => ({ messages: 100, threads: 10, users: 5 }),
    };
}

// Helper: start a test server and return its base URL
function startTestServer(handler) {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            if (!handler(req, res)) {
                res.writeHead(404);
                res.end('Not handled');
            }
        });
        server.listen(0, () => {
            const port = server.address().port;
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

describe('Dashboard API', () => {
    let server;
    const envFilePath = resolve(process.cwd(), '.env');
    let envBackup = null;

    beforeEach(() => {
        if (existsSync(envFilePath)) {
            envBackup = readFileSync(envFilePath, 'utf-8');
        } else {
            envBackup = null;
        }
    });

    afterEach(() => {
        if (server) {
            try { server.close(); } catch { /* ignore */ }
            server = null;
        }
        // Restore .env file to original state
        if (envBackup !== null) {
            writeFileSync(envFilePath, envBackup, 'utf-8');
        } else if (existsSync(envFilePath)) {
            unlinkSync(envFilePath);
        }
    });

    it('GET /api/overview returns KPIs', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/overview`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.uptime_seconds, 60);
        assert.strictEqual(data.events.processed, 90);
        assert.strictEqual(data.messaging.sent, 50);
        assert.strictEqual(data.database.users, 5);
    });

    it('GET /api/users returns user list', async () => {
        const db = mockDb();
        db.ensureUser('u1', 'Alice');
        db.ensureUser('u2', 'Bob');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/users?limit=10`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.users.length, 2);
        assert.strictEqual(data.limit, 10);
    });

    it('GET /api/users/:id returns single user', async () => {
        const db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/users/u1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.id, 'u1');
    });

    it('GET /api/users/:id returns 404 for unknown user', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/users/unknown`);
        assert.strictEqual(res.status, 404);
    });

    it('POST /api/users/:id/block blocks a user', async () => {
        const db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/users/u1/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocked: true }),
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.blocked, true);
        assert.strictEqual(db.getUser('u1').is_blocked, 1);
    });

    it('POST /api/users/:id/admin grants admin', async () => {
        const db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/users/u1/admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin: true }),
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.admin, true);
        assert.strictEqual(db.getUser('u1').is_admin, 1);
    });

    it('GET /api/threads returns thread list', async () => {
        const db = mockDb();
        db.ensureThread('t1', 'General', false);
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/threads`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.threads.length, 1);
    });

    it('GET /api/threads/:id returns single thread', async () => {
        const db = mockDb();
        db.ensureThread('t1', 'General', false);
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/threads/t1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.id, 't1');
    });

    it('GET /api/messages requires thread parameter', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/messages`);
        assert.strictEqual(res.status, 400);
    });

    it('GET /api/messages returns messages for a thread', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/messages?thread=t1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.messages));
    });

    it('GET /dashboard returns HTML', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/dashboard`);
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('text/html'));
        const html = await res.text();
        assert.ok(html.includes('Bot Admin Dashboard'));
    });

    it('returns 404 for unknown API routes', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/nonexistent`);
        assert.strictEqual(res.status, 404);
    });

    it('handles CORS preflight', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/overview`, { method: 'OPTIONS' });
        assert.strictEqual(res.status, 204);
        assert.ok(res.headers.get('access-control-allow-origin'));
    });

    it('GET /api/env returns editable env vars', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/env`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.env);
        assert.ok('LOG_LEVEL' in data.env);
        assert.ok('MAX_CONCURRENT_HANDLERS' in data.env);
        // Sensitive keys must not be exposed
        assert.ok(!('FB_COOKIES' in data.env));
        assert.ok(!('FB_C_USER' in data.env));
        assert.ok(!('FB_XS' in data.env));
    });

    it('POST /api/env updates env vars and returns applied keys', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const originalLogLevel = process.env.LOG_LEVEL;
        const originalSendRate = process.env.SEND_RATE_PER_SEC;
        try {
            const res = await fetch(`${ctx.base}/api/env`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ LOG_LEVEL: 'debug', SEND_RATE_PER_SEC: '10' }),
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.ok, true);
            assert.ok(data.applied.includes('LOG_LEVEL'));
            assert.ok(data.applied.includes('SEND_RATE_PER_SEC'));
            assert.strictEqual(process.env.LOG_LEVEL, 'debug');
            assert.strictEqual(process.env.SEND_RATE_PER_SEC, '10');
        } finally {
            if (originalLogLevel !== undefined) process.env.LOG_LEVEL = originalLogLevel;
            else delete process.env.LOG_LEVEL;
            if (originalSendRate !== undefined) process.env.SEND_RATE_PER_SEC = originalSendRate;
            else delete process.env.SEND_RATE_PER_SEC;
        }
    });

    it('POST /api/env ignores sensitive keys', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const originalLogLevel = process.env.LOG_LEVEL;
        try {
            const res = await fetch(`${ctx.base}/api/env`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ FB_COOKIES: 'hacked', LOG_LEVEL: 'warn' }),
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.ok(!data.applied.includes('FB_COOKIES'));
            assert.ok(data.applied.includes('LOG_LEVEL'));
        } finally {
            if (originalLogLevel !== undefined) process.env.LOG_LEVEL = originalLogLevel;
            else delete process.env.LOG_LEVEL;
        }
    });

    it('POST /api/env rejects invalid body', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/env`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json',
        });
        assert.strictEqual(res.status, 400);
    });

    it('GET /api/overview includes memory metrics', async () => {
        const db = mockDb();
        const metricsObj = mockMetrics();
        // Augment snapshot with memory
        const origSnapshot = metricsObj.snapshot;
        metricsObj.snapshot = () => ({
            ...origSnapshot(),
            memory_rss: 50_000_000,
            memory_heap_used: 30_000_000,
            memory_heap_total: 60_000_000,
            memory_external: 1_000_000,
        });
        const handler = createDashboardHandler(db, metricsObj, mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/overview`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.memory);
        assert.strictEqual(data.memory.rss, 50_000_000);
        assert.strictEqual(data.memory.heap_used, 30_000_000);
    });

    it('GET /api/env masks GEMINI_API_KEY value', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const originalKey = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = 'super-secret-key-12345';
        try {
            const res = await fetch(`${ctx.base}/api/env`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.ok('GEMINI_API_KEY' in data.env);
            // Value must be masked, not the actual key
            assert.strictEqual(data.env.GEMINI_API_KEY, '********');
            assert.notStrictEqual(data.env.GEMINI_API_KEY, 'super-secret-key-12345');
        } finally {
            if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
            else delete process.env.GEMINI_API_KEY;
        }
    });

    it('GET /api/env includes GEMINI_ENABLED key', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/api/env`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok('GEMINI_ENABLED' in data.env);
    });

    it('POST /api/env can toggle GEMINI_ENABLED', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const original = process.env.GEMINI_ENABLED;
        try {
            const res = await fetch(`${ctx.base}/api/env`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ GEMINI_ENABLED: 'false' }),
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.ok(data.applied.includes('GEMINI_ENABLED'));
            assert.strictEqual(process.env.GEMINI_ENABLED, 'false');
        } finally {
            if (original !== undefined) process.env.GEMINI_ENABLED = original;
            else delete process.env.GEMINI_ENABLED;
        }
    });

    it('GET /dashboard HTML includes Gemini toggle', async () => {
        const db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server;

        const res = await fetch(`${ctx.base}/dashboard`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('gemini-toggle'));
        assert.ok(html.includes('toggleGemini'));
    });
});
