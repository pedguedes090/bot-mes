import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ContextLoader, DEFAULT_MIN_MESSAGES, DEFAULT_MAX_MESSAGES } from '../../src/pipeline/context-loader.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

function createMockDb(messages = []) {
    return {
        getMessages: mock.fn(() => messages),
    };
}

describe('ContextLoader', () => {
    it('loads messages from database and formats them', () => {
        const messages = [
            { sender_id: 'user2', text: 'older msg', timestamp: 1000 },
            { sender_id: 'user1', text: 'newer msg', timestamp: 2000 },
        ];
        const loader = new ContextLoader(createMockDb(messages), createLogger(), createMetrics());
        const context = loader.load('thread-123', 'current msg', 'user1');

        assert.strictEqual(context.threadId, 'thread-123');
        assert.ok(context.formatted.includes('[user2]: older msg'));
        assert.ok(context.formatted.includes('[user1]: newer msg'));
        assert.ok(context.formatted.includes('[user1]: current msg'));
        assert.strictEqual(context.messageCount, 3); // 2 from DB + 1 current
    });

    it('works without database', () => {
        const loader = new ContextLoader(null, createLogger(), createMetrics());
        const context = loader.load('thread-123', 'hello', 'user1');

        assert.strictEqual(context.messageCount, 1);
        assert.ok(context.formatted.includes('[user1]: hello'));
    });

    it('handles empty thread gracefully', () => {
        const loader = new ContextLoader(createMockDb([]), createLogger(), createMetrics());
        const context = loader.load('thread-123', 'first message', 'user1');

        assert.strictEqual(context.messageCount, 1);
    });

    it('caches results and returns cached context on second call', () => {
        const db = createMockDb([{ sender_id: 'user1', text: 'test', timestamp: 1000 }]);
        const metrics = createMetrics();
        const loader = new ContextLoader(db, createLogger(), metrics);

        loader.load('thread-123');
        loader.load('thread-123'); // Should hit cache

        const incCalls = metrics.inc.mock.calls.map(c => c.arguments[0]);
        assert.ok(incCalls.includes('context_loader.cache_miss'));
        assert.ok(incCalls.includes('context_loader.cache_hit'));
    });

    it('invalidate clears cache for a thread', () => {
        const db = createMockDb([{ sender_id: 'user1', text: 'test', timestamp: 1000 }]);
        const metrics = createMetrics();
        const loader = new ContextLoader(db, createLogger(), metrics);

        loader.load('thread-123');
        loader.invalidate('thread-123');
        loader.load('thread-123'); // Should be a cache miss again

        const missCalls = metrics.inc.mock.calls
            .filter(c => c.arguments[0] === 'context_loader.cache_miss');
        assert.strictEqual(missCalls.length, 2);
    });

    it('exports correct default constants', () => {
        assert.strictEqual(DEFAULT_MIN_MESSAGES, 30);
        assert.strictEqual(DEFAULT_MAX_MESSAGES, 200);
    });

    it('requests up to maxMessages from database', () => {
        const db = createMockDb([]);
        const loader = new ContextLoader(db, createLogger(), createMetrics(), { maxMessages: 100 });
        loader.load('thread-123');

        assert.strictEqual(db.getMessages.mock.callCount(), 2); // initial load + cache store
        assert.strictEqual(db.getMessages.mock.calls[0].arguments[1], 100);
    });
});
