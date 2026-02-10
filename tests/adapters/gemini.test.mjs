import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAdapter } from '../../src/adapters/gemini.mjs';

// Minimal logger mock
function createLogger() {
    return {
        child: () => createLogger(),
        debug() {},
        info() {},
        warn() {},
        error() {},
    };
}

describe('GeminiAdapter', () => {
    it('reports enabled=false when no API key', () => {
        const adapter = new GeminiAdapter('', 'gemini-2.0-flash', createLogger());
        assert.strictEqual(adapter.enabled, false);
    });

    it('reports enabled=true when API key is set', () => {
        const adapter = new GeminiAdapter('test-key', 'gemini-2.0-flash', createLogger());
        assert.strictEqual(adapter.enabled, true);
    });

    it('decide returns should_reply=false when no API key', async () => {
        const adapter = new GeminiAdapter('', 'gemini-2.0-flash', createLogger());
        const result = await adapter.decide('Hello');
        assert.strictEqual(result.should_reply, false);
        assert.strictEqual(result.need_search, false);
    });

    it('generateReply throws when no API key', async () => {
        const adapter = new GeminiAdapter('', 'gemini-2.0-flash', createLogger());
        await assert.rejects(() => adapter.generateReply('Hello'), /No API key configured/);
    });

    it('configure updates API key and model', () => {
        const adapter = new GeminiAdapter('', '', createLogger());
        assert.strictEqual(adapter.enabled, false);

        adapter.configure('new-key', 'gemini-pro');
        assert.strictEqual(adapter.enabled, true);
    });

    it('configure accepts partial updates', () => {
        const adapter = new GeminiAdapter('key1', 'model1', createLogger());
        assert.strictEqual(adapter.enabled, true);

        adapter.configure(undefined, 'model2');
        assert.strictEqual(adapter.enabled, true);

        adapter.configure('', undefined);
        assert.strictEqual(adapter.enabled, false);
    });
});
