import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createChatHandler } from '../../src/handlers/chat.mjs';

// Minimal mock helpers
function createMockGemini({ enabled = true, shouldReply = true, needSearch = false, reply = 'yo bro!' } = {}) {
    return {
        get enabled() { return enabled; },
        decide: mock.fn(async () => ({ should_reply: shouldReply, need_search: needSearch, reason: 'test' })),
        generateReply: mock.fn(async () => reply),
    };
}

function createMockMetrics() {
    return { inc: mock.fn() };
}

function createMockDb(messages = []) {
    return {
        getMessages: mock.fn(() => messages),
    };
}

describe('AI Chat Handler', () => {
    it('does not match when gemini is disabled', () => {
        const handler = createChatHandler(createMockGemini({ enabled: false }), null, createMockMetrics());
        assert.strictEqual(handler.match('message', { text: 'hello' }), false);
    });

    it('does not match when message has no text', () => {
        const handler = createChatHandler(createMockGemini(), null, createMockMetrics());
        assert.strictEqual(handler.match('message', {}), false);
        assert.strictEqual(handler.match('message', { text: '' }), false);
        assert.strictEqual(handler.match('message', { text: '   ' }), false);
    });

    it('matches text messages when gemini is enabled', () => {
        const handler = createChatHandler(createMockGemini(), null, createMockMetrics());
        assert.strictEqual(handler.match('message', { text: 'hello world' }), true);
    });

    it('skips reply when gemini decides not to reply', async () => {
        const gemini = createMockGemini({ shouldReply: false });
        const metrics = createMockMetrics();
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, createMockDb(), metrics);

        await handler.handle('message', { threadId: '123', text: 'just chatting', senderId: 'user1' }, adapter);

        assert.strictEqual(gemini.decide.mock.callCount(), 1);
        assert.strictEqual(gemini.generateReply.mock.callCount(), 0);
        assert.strictEqual(adapter.sendMessage.mock.callCount(), 0);
    });

    it('generates and sends reply when gemini decides to reply', async () => {
        const gemini = createMockGemini({ shouldReply: true, reply: 'oke bro 👌' });
        const metrics = createMockMetrics();
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, createMockDb(), metrics);

        await handler.handle('message', { threadId: '456', text: 'hey bot', senderId: 'user1' }, adapter);

        assert.strictEqual(gemini.decide.mock.callCount(), 1);
        assert.strictEqual(gemini.generateReply.mock.callCount(), 1);
        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendMessage.mock.calls[0].arguments[0], '456');
        assert.strictEqual(adapter.sendMessage.mock.calls[0].arguments[1], 'oke bro 👌');
    });

    it('sends e2ee reply for e2ee messages', async () => {
        const gemini = createMockGemini({ shouldReply: true, reply: 'secret reply' });
        const adapter = { sendE2EEMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, createMockDb(), createMockMetrics());

        await handler.handle('e2eeMessage', { chatJid: '789@msgr.fb', text: 'hey', senderId: 'user1' }, adapter);

        assert.strictEqual(adapter.sendE2EEMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendE2EEMessage.mock.calls[0].arguments[0], '789@msgr.fb');
        assert.strictEqual(adapter.sendE2EEMessage.mock.calls[0].arguments[1], 'secret reply');
    });

    it('increments metrics for decisions and replies', async () => {
        const gemini = createMockGemini({ shouldReply: true });
        const metrics = createMockMetrics();
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, createMockDb(), metrics);

        await handler.handle('message', { threadId: '123', text: 'hello', senderId: 'user1' }, adapter);

        const incCalls = metrics.inc.mock.calls.map(c => c.arguments[0]);
        assert.ok(incCalls.includes('ai.decisions'));
        assert.ok(incCalls.includes('ai.replies'));
    });

    it('increments ai.skipped metric when not replying', async () => {
        const gemini = createMockGemini({ shouldReply: false });
        const metrics = createMockMetrics();
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, createMockDb(), metrics);

        await handler.handle('message', { threadId: '123', text: 'hello', senderId: 'user1' }, adapter);

        const incCalls = metrics.inc.mock.calls.map(c => c.arguments[0]);
        assert.ok(incCalls.includes('ai.skipped'));
    });

    it('includes recent messages in chat context', async () => {
        const gemini = createMockGemini({ shouldReply: true });
        const db = createMockDb([
            { sender_id: 'user2', text: 'older message' },
            { sender_id: 'user1', text: 'recent message' },
        ]);
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, db, createMockMetrics());

        await handler.handle('message', { threadId: '123', text: 'current msg', senderId: 'user1' }, adapter);

        // Verify that decide was called with context containing messages
        const decideArg = gemini.decide.mock.calls[0].arguments[0];
        assert.ok(decideArg.includes('recent message'));
        assert.ok(decideArg.includes('older message'));
        assert.ok(decideArg.includes('current msg'));
    });

    it('works without db', async () => {
        const gemini = createMockGemini({ shouldReply: true, reply: 'hi' });
        const adapter = { sendMessage: mock.fn(async () => {}) };
        const handler = createChatHandler(gemini, null, createMockMetrics());

        await handler.handle('message', { threadId: '123', text: 'hello', senderId: 'user1' }, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
    });

    it('handler name is ai-chat', () => {
        const handler = createChatHandler(createMockGemini(), null, createMockMetrics());
        assert.strictEqual(handler.name, 'ai-chat');
    });
});
