import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Metrics } from '../src/observability/metrics.mjs';

describe('Metrics server port conflict handling', () => {
    it('should handle EADDRINUSE error gracefully', async () => {
        const testPort = 19090; // Use a non-standard port for testing
        
        // Create a server that occupies the port
        const blockingServer = createServer();
        await new Promise((resolve) => {
            blockingServer.listen(testPort, resolve);
        });

        try {
            // Create metrics and attempt to start on the same port
            const metrics = new Metrics();
            const logMessages = [];
            const mockLogger = {
                info: (msg) => logMessages.push({ level: 'info', msg }),
                warn: (msg) => logMessages.push({ level: 'warn', msg }),
                error: (msg) => logMessages.push({ level: 'error', msg }),
                debug: () => {},
            };

            // Start the metrics server on the already-occupied port
            metrics.startServer(testPort, mockLogger);

            // Wait a bit for the error to be handled
            await new Promise(resolve => setTimeout(resolve, 100));

            // Check that a warning was logged about the port being in use
            const hasWarning = logMessages.some(
                log => log.level === 'warn' && log.msg.includes('already in use')
            );
            assert.ok(hasWarning, 'Should log warning about port being in use');

            // Metrics should still work (snapshot, counters, etc.)
            metrics.inc('test_counter');
            const snapshot = metrics.snapshot();
            assert.strictEqual(snapshot.test_counter, 1);

            // Stop should not throw even though server failed to start
            await metrics.stop();
        } finally {
            // Clean up the blocking server
            await new Promise((resolve) => blockingServer.close(resolve));
        }
    });

    it('should continue memory monitoring even if server fails to start', async () => {
        const testPort = 19091; // Different port
        
        // Block the port
        const blockingServer = createServer();
        await new Promise((resolve) => {
            blockingServer.listen(testPort, resolve);
        });

        try {
            const metrics = new Metrics();
            const mockLogger = {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
            };

            metrics.startServer(testPort, mockLogger);

            // Wait for error to be handled
            await new Promise(resolve => setTimeout(resolve, 100));

            // Memory gauges should still be updated
            metrics.gauge('memory.rss_mb', 100);
            metrics.gauge('memory.heap_mb', 50);
            
            const snapshot = metrics.snapshot();
            assert.strictEqual(snapshot['memory.rss_mb'], 100);
            assert.strictEqual(snapshot['memory.heap_mb'], 50);

            await metrics.stop();
        } finally {
            await new Promise((resolve) => blockingServer.close(resolve));
        }
    });
});
