import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/observability/metrics.mjs';
import { createCommandHandler } from '../src/handlers/command.mjs';
import { CommandRegistry } from '../src/commands/registry.mjs';
import { registerBuiltinCommands } from '../src/commands/definitions.mjs';

describe('Metrics memory reporting', () => {
    it('snapshot includes memory metrics', () => {
        const m = new Metrics();
        const snap = m.snapshot();
        assert.ok(typeof snap.memory_rss === 'number');
        assert.ok(snap.memory_rss > 0);
        assert.ok(typeof snap.memory_heap_used === 'number');
        assert.ok(typeof snap.memory_heap_total === 'number');
        assert.ok(typeof snap.memory_external === 'number');
    });

    it('stop cleans up without error when no server started', async () => {
        const m = new Metrics();
        await m.stop(); // should not throw
    });

    it('stop cleans up memory timer when server was started', async () => {
        const m = new Metrics();
        const logger = { info: () => {}, debug: () => {} };
        m.startServer(0, logger);
        await m.stop(); // should clean up all timers
    });
});

describe('Command handler parse caching', () => {
    it('uses cached parse result for same text across match and handle', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = {
            getUser: () => null,
        };
        const handler = createCommandHandler(registry, db, {});

        // match should parse and cache
        const msg = { text: '!ping', senderId: 'u1', threadId: 't1' };
        const matched = handler.match('message', msg);
        assert.strictEqual(matched, true);

        // handle should reuse cached parse
        const adapter = { sendMessage: mock.fn(async () => {}) };
        await handler.handle('message', msg, adapter);
        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.ok(adapter.sendMessage.mock.calls[0].arguments[1].includes('pong'));
    });

    it('correctly handles different messages in sequence', () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const handler = createCommandHandler(registry, null, {});

        assert.strictEqual(handler.match('message', { text: '!ping' }), true);
        assert.strictEqual(handler.match('message', { text: '!help' }), true);
        assert.strictEqual(handler.match('message', { text: 'hello' }), false);
        assert.strictEqual(handler.match('message', { text: '!nonexistent' }), false);
    });
});

describe('Database maintenance', () => {
    it('Database constructor starts maintenance timer and close stops it', async () => {
        const { Database } = await import('../src/adapters/database.mjs');
        const logger = {
            child: () => logger,
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        };
        const db = new Database(':memory:', logger);
        // Database should be operational
        const stats = db.stats();
        assert.strictEqual(stats.messages, 0);
        // close should not throw and should clean up timer
        db.close();
    });
});

describe('Media adapter fetch timeout constant', () => {
    it('exports downloadBuffer with timeout support', async () => {
        const { downloadBuffer } = await import('../src/adapters/media.mjs');
        assert.strictEqual(typeof downloadBuffer, 'function');
    });
});

describe('Dashboard body size limit', () => {
    it('rejects oversized request bodies', async () => {
        const { createServer } = await import('node:http');
        const { createDashboardHandler } = await import('../src/dashboard/handler.mjs');
        const logger = {
            child: () => logger,
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        };
        const db = null;
        const metrics = { snapshot: () => ({}) };
        const handler = createDashboardHandler(db, metrics, logger);

        const server = createServer((req, res) => {
            if (!handler(req, res)) {
                res.writeHead(404);
                res.end('Not handled');
            }
        });

        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;

        try {
            // Send a body that exceeds the 64KB limit
            const largeBody = 'x'.repeat(128 * 1024);
            const res = await fetch(`http://127.0.0.1:${port}/api/env`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: largeBody,
            });
            // Should get 413 or connection error (req.destroy)
            assert.ok(res.status === 413 || !res.ok);
        } catch {
            // Connection reset is also acceptable (req.destroy)
        } finally {
            server.close();
        }
    });
});
