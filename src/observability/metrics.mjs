import { createServer } from 'node:http';
import v8 from 'node:v8';

export class Metrics {
    #counters = new Map();
    #gauges = new Map();
    #server = null;
    #startTime = Date.now();
    #dashboardHandler = null;
    #gcTimer = null;
    #memoryTimer = null;

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
        out.memory_heap_limit = v8.getHeapStatistics().heap_size_limit;
        return out;
    }

    /**
     * Set the dashboard handler for API routes.
     * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean} handler
     */
    setDashboardHandler(handler) {
        this.#dashboardHandler = handler;
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

        // Periodic memory stats logging (every 5 minutes)
        this.#memoryTimer = setInterval(() => {
            const mem = process.memoryUsage();
            const rssMB = Math.round(mem.rss / 1024 / 1024);
            const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
            this.gauge('memory.rss_mb', rssMB);
            this.gauge('memory.heap_mb', heapMB);
            logger?.debug('Memory stats', { rss_mb: rssMB, heap_mb: heapMB });
        }, 5 * 60 * 1000);
        this.#memoryTimer.unref();

        // Periodic idle memory reclamation (every 30s)
        if (typeof global.gc === 'function') {
            this.#gcTimer = setInterval(() => {
                const active = this.#gauges.get('handlers.active') ?? 0;
                const mem = process.memoryUsage();
                const { heap_size_limit } = v8.getHeapStatistics();
                const heapPressure = mem.heapUsed > 0.65 * heap_size_limit;
                if (active === 0 || heapPressure) {
                    global.gc();
                    logger?.debug('GC triggered', { idle: active === 0, heapPressure });
                }
            }, 30_000);
            this.#gcTimer.unref();
        }
    }

    async stop() {
        if (this.#memoryTimer) {
            clearInterval(this.#memoryTimer);
            this.#memoryTimer = null;
        }
        if (this.#gcTimer) {
            clearInterval(this.#gcTimer);
            this.#gcTimer = null;
        }
        if (this.#server) {
            return new Promise(resolve => this.#server.close(resolve));
        }
    }
}
