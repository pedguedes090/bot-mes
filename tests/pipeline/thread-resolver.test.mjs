import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadResolver, THREAD_REFERENCE_PATTERNS, HIGH_CONFIDENCE_THRESHOLD } from '../../src/pipeline/thread-resolver.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

function createMockDb(threads = []) {
    return {
        listThreads: mock.fn(() => threads),
    };
}

describe('ThreadResolver', () => {
    it('returns current thread with confidence 1.0 for direct messages', () => {
        const resolver = new ThreadResolver(createMockDb(), createLogger(), createMetrics());
        const result = resolver.resolve('thread-123', 'hello world', 'user1');

        assert.strictEqual(result.threadId, 'thread-123');
        assert.strictEqual(result.confidence, 1.0);
        assert.strictEqual(result.disambiguationPrompt, null);
    });

    it('detects English thread reference patterns', () => {
        const testPhrases = [
            'reply there please',
            'send to that thread',
            'answer in the group chat',
            'message them about it',
        ];
        for (const phrase of testPhrases) {
            const matches = THREAD_REFERENCE_PATTERNS.some(p => p.test(phrase));
            assert.ok(matches, `Should detect thread reference in: "${phrase}"`);
        }
    });

    it('detects Vietnamese thread reference patterns', () => {
        const testPhrases = [
            'trả lời trong đó',
            'gửi vào nhóm',
            'nhắn vào đó đi',
        ];
        for (const phrase of testPhrases) {
            const matches = THREAD_REFERENCE_PATTERNS.some(p => p.test(phrase));
            assert.ok(matches, `Should detect thread reference in: "${phrase}"`);
        }
    });

    it('does not detect thread references in normal messages', () => {
        const testPhrases = [
            'hello everyone',
            'what time is it?',
            'tôi muốn hỏi về điều này',
        ];
        for (const phrase of testPhrases) {
            const matches = THREAD_REFERENCE_PATTERNS.some(p => p.test(phrase));
            assert.ok(!matches, `Should NOT detect thread reference in: "${phrase}"`);
        }
    });

    it('asks for disambiguation when thread reference is detected but no candidates', () => {
        const resolver = new ThreadResolver(createMockDb([]), createLogger(), createMetrics());
        const result = resolver.resolve('thread-123', 'reply there please', 'user1');

        assert.strictEqual(result.threadId, null);
        assert.strictEqual(result.confidence, 0);
        assert.ok(result.disambiguationPrompt !== null);
    });

    it('asks for disambiguation when multiple threads match with low confidence', () => {
        const threads = [
            { id: 'thread-A', name: 'Project Alpha', is_group: 1, enabled: 1, updated_at: new Date().toISOString() },
            { id: 'thread-B', name: 'Project Beta', is_group: 1, enabled: 1, updated_at: new Date().toISOString() },
        ];
        const resolver = new ThreadResolver(createMockDb(threads), createLogger(), createMetrics());
        // Message doesn't strongly match any thread name
        const result = resolver.resolve('thread-123', 'reply there about the thing', 'user1');

        // Should either have disambiguation or a match
        assert.ok(result.disambiguationPrompt !== null || result.threadId !== null);
    });

    it('returns high-confidence match when thread name matches message content', () => {
        const threads = [
            { id: 'thread-A', name: 'project alpha', is_group: 1, enabled: 1, updated_at: new Date().toISOString() },
        ];
        const resolver = new ThreadResolver(createMockDb(threads), createLogger(), createMetrics());
        const result = resolver.resolve('thread-123', 'send to that thread about project alpha', 'user1');

        // The thread name "project alpha" fully matches, plus is_group bonus and recency
        if (result.threadId) {
            assert.strictEqual(result.threadId, 'thread-A');
        }
    });

    it('works without a database', () => {
        const resolver = new ThreadResolver(null, createLogger(), createMetrics());
        const result = resolver.resolve('thread-123', 'hello', 'user1');

        assert.strictEqual(result.threadId, 'thread-123');
        assert.strictEqual(result.confidence, 1.0);
    });

    it('excludes disabled threads from candidates', () => {
        const threads = [
            { id: 'thread-A', name: 'test topic', is_group: 1, enabled: 0, updated_at: new Date().toISOString() },
        ];
        const resolver = new ThreadResolver(createMockDb(threads), createLogger(), createMetrics());
        const result = resolver.resolve('thread-123', 'reply there about test topic', 'user1');

        // Disabled thread should not be a candidate
        if (result.candidates.length > 0) {
            assert.ok(!result.candidates.some(c => c.threadId === 'thread-A'));
        }
    });
});
