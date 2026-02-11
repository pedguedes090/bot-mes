import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyGate, SENSITIVE_PATTERNS, BLOCKED_CONTENT_PATTERNS } from '../../src/pipeline/safety-gate.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

describe('SafetyGate', () => {
    it('allows normal messages', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('Chào bạn! Mình là Hoàng 😊');

        assert.strictEqual(result.allowed, true);
        assert.strictEqual(result.reason, null);
    });

    it('blocks messages containing phone numbers', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('Call me at 555-123-4567 for details');

        assert.strictEqual(result.allowed, false);
        assert.ok(result.reason.includes('sensitive'));
        assert.ok(result.safeAlternative);
    });

    it('blocks messages containing email addresses', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('Send it to user@example.com');

        assert.strictEqual(result.allowed, false);
    });

    it('blocks messages containing credit card numbers', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('My card is 4111-1111-1111-1111');

        assert.strictEqual(result.allowed, false);
    });

    it('blocks messages containing exposed passwords', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('The password: secret123');

        assert.strictEqual(result.allowed, false);
    });

    it('blocks messages containing API keys', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('api_key=sk-abc123def456');

        assert.strictEqual(result.allowed, false);
    });

    it('blocks harmful content', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('how to hack into a system');

        assert.strictEqual(result.allowed, false);
        assert.ok(result.reason.includes('prohibited'));
    });

    it('blocks excessively long messages', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const longMsg = 'a'.repeat(5001);
        const result = gate.check(longMsg);

        assert.strictEqual(result.allowed, false);
        assert.ok(result.reason.includes('length'));
    });

    it('blocks empty or null messages', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());

        assert.strictEqual(gate.check('').allowed, false);
        assert.strictEqual(gate.check(null).allowed, false);
    });

    it('increments safety_blocks_count metric when blocking', () => {
        const metrics = createMetrics();
        const gate = new SafetyGate(createLogger(), metrics);
        gate.check('password: mySecretPass');

        const incCalls = metrics.inc.mock.calls.map(c => c.arguments[0]);
        assert.ok(incCalls.includes('safety_blocks_count'));
    });

    it('provides Vietnamese safe alternative when blocking sensitive info', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const result = gate.check('token=abc123xyz');

        assert.ok(result.safeAlternative);
        assert.ok(result.safeAlternative.includes('không thể'));
    });

    it('allows messages at the max length boundary', () => {
        const gate = new SafetyGate(createLogger(), createMetrics());
        const exactLimitMsg = 'a'.repeat(5000);
        const result = gate.check(exactLimitMsg);

        assert.strictEqual(result.allowed, true);
    });
});
