import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('loadConfig', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Set minimum required env
        process.env.FB_C_USER = 'test_user';
        process.env.FB_XS = 'test_xs';
    });

    afterEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
    });

    it('loads with defaults', async () => {
        const { loadConfig } = await import('../src/config/index.mjs');
        const cfg = loadConfig();

        assert.strictEqual(cfg.cookies.c_user, 'test_user');
        assert.strictEqual(cfg.cookies.xs, 'test_xs');
        assert.strictEqual(cfg.logLevel, 'info');
        assert.strictEqual(cfg.enableE2EE, true);
        assert.strictEqual(cfg.maxConcurrentHandlers, 50);
        assert.strictEqual(cfg.handlerTimeoutMs, 30_000);
        assert.strictEqual(cfg.sendRatePerSec, 5);
        assert.strictEqual(cfg.metricsPort, 9090);
        assert.strictEqual(cfg.autoRestartMinutes, 60);
    });

    it('respects env overrides', async () => {
        process.env.LOG_LEVEL = 'debug';
        process.env.MAX_CONCURRENT_HANDLERS = '20';
        process.env.ENABLE_E2EE = 'false';
        process.env.AUTO_RESTART_MINUTES = '120';

        // Dynamic import to re-run module
        const mod = await import(`../src/config/index.mjs?t=${Date.now()}`);
        const cfg = mod.loadConfig();

        assert.strictEqual(cfg.logLevel, 'debug');
        assert.strictEqual(cfg.maxConcurrentHandlers, 20);
        assert.strictEqual(cfg.enableE2EE, false);
        assert.strictEqual(cfg.autoRestartMinutes, 120);
    });

    it('throws on missing required cookies', async () => {
        delete process.env.FB_C_USER;
        delete process.env.FB_XS;

        const mod = await import(`../src/config/index.mjs?t=${Date.now()}`);
        assert.throws(() => mod.loadConfig(), /Missing required env/);
    });
});
