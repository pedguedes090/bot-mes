import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
    let server, base, db;

    it('GET /api/overview returns KPIs', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/overview`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.uptime_seconds, 60);
        assert.strictEqual(data.events.processed, 90);
        assert.strictEqual(data.messaging.sent, 50);
        assert.strictEqual(data.database.users, 5);

        server.close();
    });

    it('GET /api/users returns user list', async () => {
        db = mockDb();
        db.ensureUser('u1', 'Alice');
        db.ensureUser('u2', 'Bob');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/users?limit=10`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.users.length, 2);
        assert.strictEqual(data.limit, 10);

        server.close();
    });

    it('GET /api/users/:id returns single user', async () => {
        db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/users/u1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.id, 'u1');

        server.close();
    });

    it('GET /api/users/:id returns 404 for unknown user', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/users/unknown`);
        assert.strictEqual(res.status, 404);

        server.close();
    });

    it('POST /api/users/:id/block blocks a user', async () => {
        db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/users/u1/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocked: true }),
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.blocked, true);
        assert.strictEqual(db.getUser('u1').is_blocked, 1);

        server.close();
    });

    it('POST /api/users/:id/admin grants admin', async () => {
        db = mockDb();
        db.ensureUser('u1', 'Alice');
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/users/u1/admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin: true }),
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.admin, true);
        assert.strictEqual(db.getUser('u1').is_admin, 1);

        server.close();
    });

    it('GET /api/threads returns thread list', async () => {
        db = mockDb();
        db.ensureThread('t1', 'General', false);
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/threads`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.threads.length, 1);

        server.close();
    });

    it('GET /api/threads/:id returns single thread', async () => {
        db = mockDb();
        db.ensureThread('t1', 'General', false);
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/threads/t1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.id, 't1');

        server.close();
    });

    it('GET /api/messages requires thread parameter', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/messages`);
        assert.strictEqual(res.status, 400);

        server.close();
    });

    it('GET /api/messages returns messages for a thread', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/messages?thread=t1`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.messages));

        server.close();
    });

    it('GET /dashboard returns HTML', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/dashboard`);
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('text/html'));
        const html = await res.text();
        assert.ok(html.includes('Bot Admin Dashboard'));

        server.close();
    });

    it('returns 404 for unknown API routes', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/nonexistent`);
        assert.strictEqual(res.status, 404);

        server.close();
    });

    it('handles CORS preflight', async () => {
        db = mockDb();
        const handler = createDashboardHandler(db, mockMetrics(), mockLogger());
        const ctx = await startTestServer(handler);
        server = ctx.server; base = ctx.base;

        const res = await fetch(`${base}/api/overview`, { method: 'OPTIONS' });
        assert.strictEqual(res.status, 204);
        assert.ok(res.headers.get('access-control-allow-origin'));

        server.close();
    });
});
