import { createServer } from 'node:http';

export class Metrics {
    #counters = new Map();
    #gauges = new Map();
    #server = null;
    #startTime = Date.now();

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
        return out;
    }

    // Minimal HTTP server for /health and /metrics
    startServer(port, logger) {
        this.#server = createServer((req, res) => {
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
    }

    async stop() {
        if (this.#server) {
            return new Promise(resolve => this.#server.close(resolve));
        }
    }
}
