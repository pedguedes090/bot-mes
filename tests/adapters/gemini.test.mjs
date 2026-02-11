import { describe, it, mock, afterEach } from 'node:test';
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

    it('sends API key via x-goog-api-key header, not in URL', async () => {
        const originalFetch = globalThis.fetch;
        let capturedUrl;
        let capturedOptions;

        globalThis.fetch = async (url, options) => {
            capturedUrl = url;
            capturedOptions = options;
            return {
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: '{"should_reply":true,"need_search":false,"reason":"test"}' }] } }],
                }),
            };
        };

        try {
            const adapter = new GeminiAdapter('test-api-key-123', 'gemini-2.0-flash', createLogger());
            await adapter.decide('Hello');

            // API key must NOT be in URL
            assert.ok(!capturedUrl.includes('test-api-key-123'), 'API key should not appear in URL');
            assert.ok(!capturedUrl.includes('key='), 'key= query param should not be in URL');

            // API key must be in x-goog-api-key header
            assert.strictEqual(capturedOptions.headers['x-goog-api-key'], 'test-api-key-123');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('decide parses JSON with extra text around the object', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'Here is the result:\n{"should_reply":true,"need_search":false,"reason":"test"}\nDone.' }] } }],
            }),
        });
        try {
            const adapter = new GeminiAdapter('key', 'gemini-2.0-flash', createLogger());
            const result = await adapter.decide('Hello');
            assert.strictEqual(result.should_reply, true);
            assert.strictEqual(result.reason, 'test');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('decide parses JSON with control characters in values', async () => {
        const originalFetch = globalThis.fetch;
        // Simulate a JSON string with a literal newline inside a value (invalid JSON)
        const malformed = '{"should_reply":true,"need_search":false,"reason":"line1\nline2"}';
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: malformed }] } }],
            }),
        });
        try {
            const adapter = new GeminiAdapter('key', 'gemini-2.0-flash', createLogger());
            const result = await adapter.decide('Hello');
            assert.strictEqual(result.should_reply, true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('decide parses JSON with trailing comma', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: '{"should_reply":true,"need_search":false,"reason":"test",}' }] } }],
            }),
        });
        try {
            const adapter = new GeminiAdapter('key', 'gemini-2.0-flash', createLogger());
            const result = await adapter.decide('Hello');
            assert.strictEqual(result.should_reply, true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('retries on 503 and succeeds on next attempt', async () => {
        const originalFetch = globalThis.fetch;
        let callCount = 0;
        globalThis.fetch = async () => {
            callCount++;
            if (callCount === 1) {
                return { ok: false, status: 503, text: async () => 'Unavailable' };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: '{"should_reply":true,"need_search":false,"reason":"retry worked"}' }] } }],
                }),
            };
        };
        try {
            const adapter = new GeminiAdapter('key', 'gemini-2.0-flash', createLogger());
            const result = await adapter.decide('Hello');
            assert.strictEqual(result.should_reply, true);
            assert.strictEqual(result.reason, 'retry worked');
            assert.strictEqual(callCount, 2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('retries on 429 and gives up after max retries', async () => {
        const originalFetch = globalThis.fetch;
        let callCount = 0;
        globalThis.fetch = async () => {
            callCount++;
            return { ok: false, status: 429, text: async () => 'Rate limited' };
        };
        try {
            const adapter = new GeminiAdapter('key', 'gemini-2.0-flash', createLogger());
            const result = await adapter.decide('Hello');
            // decide catches errors and returns fallback
            assert.strictEqual(result.should_reply, false);
            assert.strictEqual(callCount, 4); // 1 initial + 3 retries
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('sends correct request body structure to Gemini API', async () => {
        const originalFetch = globalThis.fetch;
        let capturedBody;

        globalThis.fetch = async (_url, options) => {
            capturedBody = JSON.parse(options.body);
            return {
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: 'Generated reply' }] } }],
                }),
            };
        };

        try {
            const adapter = new GeminiAdapter('test-key', 'gemini-2.0-flash', createLogger());
            await adapter.generateReply('Hello there');

            // Verify system_instruction structure
            assert.ok(capturedBody.system_instruction, 'body should include system_instruction');
            assert.ok(Array.isArray(capturedBody.system_instruction.parts), 'system_instruction should have parts array');

            // Verify contents structure
            assert.ok(Array.isArray(capturedBody.contents), 'body should include contents array');
            assert.strictEqual(capturedBody.contents[0].role, 'user');
            assert.ok(Array.isArray(capturedBody.contents[0].parts), 'contents entry should have parts array');

            // Verify generationConfig
            assert.ok(capturedBody.generationConfig, 'body should include generationConfig');
            assert.strictEqual(typeof capturedBody.generationConfig.temperature, 'number');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
