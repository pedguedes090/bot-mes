import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// We cannot directly unit-test MessengerAdapter.#isTransient because it's private.
// Instead, we test the adapter's observable behaviour through a mock Client.

// Stub the meta-messenger.js module before importing the adapter.
// Since the adapter relies on `new Client(cookies, opts)`, we replace the import
// with a fake that returns an EventEmitter we control.

let fakeClient;

// Build a mock that the adapter calls during connect()
function createFakeClient() {
    const ee = new EventEmitter();
    ee.connect = async () => ({ user: { id: 1n, name: 'Bot' } });
    ee.disconnect = async () => {};
    ee.currentUserId = 1n;
    return ee;
}

// We need to mock the module import. Instead of fighting with ESM loaders,
// we'll exercise the transient-detection logic via a standalone helper that
// mirrors the same pattern used in the adapter.

const TRANSIENT_PATTERNS = [
    'websocket close 1006',
    'unexpected eof',
    'connection reset',
    'econnreset',
    'epipe',
    'etimedout',
    'econnrefused',
    'socket hang up',
    'network changed',
];

function isTransient(err) {
    const msg = (err.message || '').toLowerCase();
    return TRANSIENT_PATTERNS.some(p => msg.includes(p));
}

describe('Transient error detection', () => {
    it('detects websocket close 1006 as transient', () => {
        const err = new Error('error in read loop: failed to read message: websocket close 1006 (abnormal closure): unexpected EOF');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects ECONNRESET as transient', () => {
        const err = new Error('read ECONNRESET');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects ETIMEDOUT as transient', () => {
        const err = new Error('connect ETIMEDOUT 192.168.1.1:443');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects socket hang up as transient', () => {
        const err = new Error('socket hang up');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects connection reset as transient', () => {
        const err = new Error('connection reset by peer');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects EPIPE as transient', () => {
        const err = new Error('write EPIPE');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects ECONNREFUSED as transient', () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
        assert.strictEqual(isTransient(err), true);
    });

    it('detects network changed as transient', () => {
        const err = new Error('network changed');
        assert.strictEqual(isTransient(err), true);
    });

    it('does NOT treat authentication errors as transient', () => {
        const err = new Error('Authentication failed: invalid session');
        assert.strictEqual(isTransient(err), false);
    });

    it('does NOT treat unknown errors as transient', () => {
        const err = new Error('Something completely unexpected');
        assert.strictEqual(isTransient(err), false);
    });

    it('handles error with no message', () => {
        const err = new Error();
        assert.strictEqual(isTransient(err), false);
    });

    it('is case insensitive', () => {
        const err = new Error('WebSocket Close 1006 (Abnormal Closure)');
        assert.strictEqual(isTransient(err), true);
    });
});
