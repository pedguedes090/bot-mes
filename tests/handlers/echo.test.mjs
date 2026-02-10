import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EchoHandler } from '../../src/handlers/echo.mjs';

describe('EchoHandler', () => {
    it('matches any message with text', () => {
        assert.strictEqual(EchoHandler.match('message', { text: 'hello' }), true);
        assert.strictEqual(EchoHandler.match('e2eeMessage', { text: 'test' }), true);
    });

    it('does not match empty or missing text', () => {
        assert.strictEqual(EchoHandler.match('message', { text: '' }), false);
        assert.strictEqual(EchoHandler.match('message', {}), false);
    });

    it('echoes regular message', async () => {
        const adapter = { sendMessage: mock.fn(async () => { }) };
        const msg = { threadId: 456n, text: 'hello world' };

        await EchoHandler.handle('message', msg, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendMessage.mock.calls[0].arguments[0], 456n);
        assert.strictEqual(adapter.sendMessage.mock.calls[0].arguments[1], 'Echo: hello world');
    });

    it('echoes e2ee message', async () => {
        const adapter = { sendE2EEMessage: mock.fn(async () => { }) };
        const msg = { chatJid: '789@msgr.fb', text: 'secret' };

        await EchoHandler.handle('e2eeMessage', msg, adapter);

        assert.strictEqual(adapter.sendE2EEMessage.mock.callCount(), 1);
        assert.strictEqual(adapter.sendE2EEMessage.mock.calls[0].arguments[1], 'Echo: secret');
    });
});
