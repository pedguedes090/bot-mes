import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MessageComposer } from '../../src/pipeline/message-composer.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

describe('MessageComposer', () => {
    it('composes a message using Gemini', async () => {
        const gemini = {
            get enabled() { return true; },
            _callAPIForPipeline: mock.fn(async () => 'Chào bạn! Mình là Hoàng 😊'),
        };
        const composer = new MessageComposer(gemini, createLogger(), createMetrics());

        const plan = {
            action: 'greet',
            keyPoints: ['Chào hỏi'],
            tone: 'casual',
            lengthGuidance: 'concise',
            includeGreeting: true,
            avoidRepeating: [],
            searchQuery: null,
        };
        const context = {
            threadId: 'thread-123',
            messages: [{ senderId: 'user1', text: 'hello', timestamp: 1000 }],
            messageCount: 1,
            formatted: '[user1]: hello',
        };

        const result = await composer.compose(plan, context);

        assert.strictEqual(result, 'Chào bạn! Mình là Hoàng 😊');
        assert.strictEqual(gemini._callAPIForPipeline.mock.callCount(), 1);
    });

    it('throws when Gemini is not enabled', async () => {
        const gemini = { get enabled() { return false; } };
        const composer = new MessageComposer(gemini, createLogger(), createMetrics());

        await assert.rejects(
            () => composer.compose({}, { formatted: '' }),
            /Gemini not available/
        );
    });

    it('includes search context in prompt when provided', async () => {
        let capturedPrompt;
        const gemini = {
            get enabled() { return true; },
            _callAPIForPipeline: mock.fn(async (_sys, user) => {
                capturedPrompt = user;
                return 'reply with search';
            }),
        };
        const composer = new MessageComposer(gemini, createLogger(), createMetrics());

        const plan = {
            action: 'answer_question',
            keyPoints: ['Answer'],
            tone: 'casual',
            lengthGuidance: 'concise',
            includeGreeting: false,
            avoidRepeating: [],
            searchQuery: null,
        };
        const context = { formatted: '[user1]: test', threadId: 't', messages: [], messageCount: 0 };

        await composer.compose(plan, context, 'Search result: temperature is 25°C');

        assert.ok(capturedPrompt.includes('Search result: temperature is 25°C'));
    });

    it('includes plan details in the prompt to Gemini', async () => {
        let capturedPrompt;
        const gemini = {
            get enabled() { return true; },
            _callAPIForPipeline: mock.fn(async (_sys, user) => {
                capturedPrompt = user;
                return 'composed reply';
            }),
        };
        const composer = new MessageComposer(gemini, createLogger(), createMetrics());

        const plan = {
            action: 'answer_question',
            keyPoints: ['Explain the topic'],
            tone: 'formal',
            lengthGuidance: 'detailed',
            includeGreeting: false,
            avoidRepeating: ['Already known fact'],
            searchQuery: null,
        };
        const context = { formatted: '[user1]: explain', threadId: 't', messages: [], messageCount: 0 };

        await composer.compose(plan, context);

        assert.ok(capturedPrompt.includes('answer_question'));
        assert.ok(capturedPrompt.includes('formal'));
        assert.ok(capturedPrompt.includes('detailed'));
        assert.ok(capturedPrompt.includes('Explain the topic'));
        assert.ok(capturedPrompt.includes('Already known fact'));
        assert.ok(capturedPrompt.includes('Hoàng'));
    });
});
