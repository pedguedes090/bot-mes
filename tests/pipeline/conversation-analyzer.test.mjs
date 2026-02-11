import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationAnalyzer } from '../../src/pipeline/conversation-analyzer.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

function createMockGemini(enabled = true) {
    return {
        get enabled() { return enabled; },
        _callAPIForPipeline: mock.fn(async () => JSON.stringify({
            intent: 'question',
            tone: 'casual',
            questions_asked: ['What time is it?'],
            decisions_made: [],
            unresolved_items: ['Time query'],
            entities: { people: ['user1'], dates: [], products: [], numbers: [] },
            summary: 'User asking about time',
            confidence: 0.85,
        })),
    };
}

describe('ConversationAnalyzer', () => {
    it('uses heuristic analysis for small contexts (<=3 messages)', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'What time is it?', timestamp: 1000 },
            ],
            messageCount: 1,
            formatted: '[user1]: What time is it?',
        };

        const result = await analyzer.analyze(context);

        assert.strictEqual(result.intent, 'question');
        assert.strictEqual(result.confidence, 0.5); // Heuristic confidence
        assert.ok(Array.isArray(result.questionsAsked));
    });

    it('detects greeting intent', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'Xin chào mọi người', timestamp: 1000 },
            ],
            messageCount: 1,
            formatted: '[user1]: Xin chào mọi người',
        };

        const result = await analyzer.analyze(context);
        assert.strictEqual(result.intent, 'greeting');
    });

    it('detects casual tone', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'oke bro 😂', timestamp: 1000 },
            ],
            messageCount: 1,
            formatted: '[user1]: oke bro 😂',
        };

        const result = await analyzer.analyze(context);
        assert.strictEqual(result.tone, 'casual');
    });

    it('detects formal tone', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'Kính gửi quý anh chị, vui lòng xem xét', timestamp: 1000 },
            ],
            messageCount: 1,
            formatted: '[user1]: Kính gửi quý anh chị, vui lòng xem xét',
        };

        const result = await analyzer.analyze(context);
        assert.strictEqual(result.tone, 'formal');
    });

    it('extracts questions from messages', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'What is this?', timestamp: 1000 },
                { senderId: 'user2', text: 'No idea', timestamp: 2000 },
                { senderId: 'user1', text: 'Can you check?', timestamp: 3000 },
            ],
            messageCount: 3,
            formatted: '[user1]: What is this?\n[user2]: No idea\n[user1]: Can you check?',
        };

        const result = await analyzer.analyze(context);
        assert.ok(result.questionsAsked.length >= 1);
    });

    it('falls back to heuristic when Gemini is disabled', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(false), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: Array.from({ length: 10 }, (_, i) => ({
                senderId: `user${i % 2}`, text: `msg ${i}`, timestamp: i * 1000,
            })),
            messageCount: 10,
            formatted: 'test context',
        };

        const result = await analyzer.analyze(context);
        assert.ok(result.confidence <= 1.0);
        assert.ok(result.intent);
    });

    it('handles Gemini API errors gracefully', async () => {
        const gemini = {
            get enabled() { return true; },
            _callAPIForPipeline: mock.fn(async () => { throw new Error('API error'); }),
        };
        const analyzer = new ConversationAnalyzer(gemini, createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: Array.from({ length: 10 }, (_, i) => ({
                senderId: 'user1', text: `message ${i}`, timestamp: i * 1000,
            })),
            messageCount: 10,
            formatted: 'test',
        };

        // Should not throw, falls back to heuristic
        const result = await analyzer.analyze(context);
        assert.ok(result.intent);
        assert.ok(result.confidence <= 1.0);
    });

    it('returns structured entities object', async () => {
        const analyzer = new ConversationAnalyzer(createMockGemini(), createLogger(), createMetrics());

        const context = {
            threadId: 'thread-123',
            messages: [
                { senderId: 'user1', text: 'Meeting at 3pm with 5 people', timestamp: 1000 },
            ],
            messageCount: 1,
            formatted: '[user1]: Meeting at 3pm with 5 people',
        };

        const result = await analyzer.analyze(context);
        assert.ok(result.entities);
        assert.ok(Array.isArray(result.entities.people));
        assert.ok(Array.isArray(result.entities.dates));
        assert.ok(Array.isArray(result.entities.products));
        assert.ok(Array.isArray(result.entities.numbers));
    });
});
