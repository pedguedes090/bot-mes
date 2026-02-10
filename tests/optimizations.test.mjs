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
