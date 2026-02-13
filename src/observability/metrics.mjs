import { createServer } from 'node:http';

export class Metrics {
    #counters = new Map();
    #gauges = new Map();
    #server = null;
    #startTime = Date.now();
    #dashboardHandler = null;
    #memoryTimer = null;
    #memoryPressureCallbacks = [];

    inc(name, delta = 1) {
        this.#counters.set(name, (this.#counters.get(name) ?? 0) + delta);
    }

    gauge(name, value) {
        this.#gauges.set(name, value);
    }

    get(name) {
        return this.#counters.get(name) ?? this.#gauges.get(name) ?? 0;
    }

    snapshot() {
        const out = {};
        for (const [k, v] of this.#counters) out[k] = v;
        for (const [k, v] of this.#gauges) out[k] = v;
        out.uptime_seconds = Math.floor((Date.now() - this.#startTime) / 1000);
        // Memory metrics (bytes)
        const mem = process.memoryUsage();
        out.memory_rss = mem.rss;
        out.memory_heap_used = mem.heapUsed;
        out.memory_heap_total = mem.heapTotal;
        out.memory_external = mem.external;
        return out;
    }

    /**
     * Set the dashboard handler for API routes.
     * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean} handler
     */
    setDashboardHandler(handler) {
        this.#dashboardHandler = handler;
    }

    /**
     * Register a callback to be invoked when heap usage exceeds 85% of heap total.
     * @param {() => void} callback
     */
    onMemoryPressure(callback) {
        this.#memoryPressureCallbacks.push(callback);
    }

    // Minimal HTTP server for /health, /metrics, /dashboard, and /api/*
    startServer(port, logger) {
        this.#server = createServer((req, res) => {
            // Try dashboard handler first for /api/* and /dashboard routes
            if (this.#dashboardHandler && this.#dashboardHandler(req, res)) {
                return;
            }

            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - this.#startTime) / 1000) }));
            } else if (req.url === '/metrics') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this.snapshot()));
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.#server.listen(port, () => {
            logger?.info(`Metrics server listening on :${port}`);
        });
        this.#server.unref(); // Don't prevent shutdown

        // Periodic memory stats logging and pressure detection (every 60 seconds)
        this.#memoryTimer = setInterval(() => {
            const mem = process.memoryUsage();
            const rssMB = Math.round(mem.rss / 1024 / 1024);
            const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
            this.gauge('memory.rss_mb', rssMB);
            this.gauge('memory.heap_mb', heapMB);
            logger?.debug('Memory stats', { rss_mb: rssMB, heap_mb: heapMB });

            // Trigger memory pressure callbacks when heap usage exceeds 85%
            if (mem.heapTotal > 0 && mem.heapUsed / mem.heapTotal > 0.85) {
                logger?.warn('Memory pressure detected', { rss_mb: rssMB, heap_mb: heapMB, heapTotal_mb: Math.round(mem.heapTotal / 1024 / 1024) });
                this.inc('memory.pressure_events');
                for (const cb of this.#memoryPressureCallbacks) {
                    try { cb(); } catch { /* ignore callback errors */ }
                }
                // Attempt manual GC if exposed via --expose-gc
                if (typeof globalThis.gc === 'function') {
                    globalThis.gc();
                }
            }
        }, 60_000);
        this.#memoryTimer.unref();
    }

    async stop() {
        if (this.#memoryTimer) {
            clearInterval(this.#memoryTimer);
            this.#memoryTimer = null;
        }
        if (this.#server) {
            return new Promise(resolve => this.#server.close(resolve));
        }
    }
}
