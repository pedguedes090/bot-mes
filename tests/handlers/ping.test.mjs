import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PingHandler } from '../../src/handlers/ping.mjs';

describe('PingHandler', () => {
    it('matches "ping" text', () => {
        assert.strictEqual(PingHandler.match('message', { text: 'ping' }), true);
        assert.strictEqual(PingHandler.match('message', { text: '  Ping  ' }), true);
        assert.strictEqual(PingHandler.match('e2eeMessage', { text: 'PING' }), true);
    });

    it('does not match other text', () => {
        assert.strictEqual(PingHandler.match('message', { text: 'hello' }), false);
        assert.strictEqual(PingHandler.match('message', { text: '' }), false);
        assert.strictEqual(PingHandler.match('message', { text: 'ping!' }), false);
    });

    it('does not match missing text', () => {
        assert.strictEqual(PingHandler.match('message', {}), false);
    });

    it('sends pong for regular message', async () => {
        const adapter = { sendMessage: mock.fn(async () => { }) };
        const msg = { threadId: 123n, text: 'ping' };

        await PingHandler.handle('message', msg, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendMessage.mock.calls[0].arguments[0], 123n);
        assert.ok(adapter.sendMessage.mock.calls[0].arguments[1].includes('pong'));
    });

    it('sends pong for e2ee message', async () => {
        const adapter = { sendE2EEMessage: mock.fn(async () => { }) };
        const msg = { chatJid: '123@msgr.fb', text: 'ping' };

        await PingHandler.handle('e2eeMessage', msg, adapter);

        assert.strictEqual(adapter.sendE2EEMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendE2EEMessage.mock.calls[0].arguments[0], '123@msgr.fb');
    });
});
