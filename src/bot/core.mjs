export class BotCore {
    #adapter;
    #handlers;
    #config;
    #logger;
    #metrics;
    #db;
    #activeHandlers = 0;
    #seenIds;
    #shuttingDown = false;

    constructor(adapter, handlers, config, logger, metrics, db = null) {
        this.#adapter = adapter;
        this.#handlers = handlers;
        this.#config = config;
        this.#logger = logger.child('core');
        this.#metrics = metrics;
        this.#db = db;
        // LRU-style idempotency set (simple ring buffer)
        this.#seenIds = new Set();
    }

    start() {
        this.#adapter.on('message', (msg) => this.#dispatch('message', msg));
        this.#adapter.on('e2eeMessage', (msg) => this.#dispatch('e2eeMessage', msg));
        this.#logger.info('Bot core started', {
            handlers: this.#handlers.map(h => h.name),
            maxConcurrent: this.#config.maxConcurrentHandlers,
        });
    }

    #dispatch(eventType, msg) {
        if (this.#shuttingDown) return;

        // Skip own messages
        const selfId = this.#adapter.currentUserId;
        if (selfId && msg.senderId === selfId) return;

        // DB: track user and thread, check blocked
        if (this.#db) {
            try {
                const senderId = String(msg.senderId || '');
                if (senderId) {
                    this.#db.ensureUser(senderId);
                    if (this.#db.isBlocked(senderId)) {
                        this.#metrics.inc('events.blocked');
                        return;
                    }
                }
                const threadId = String(msg.threadId || msg.chatJid || '');
                if (threadId) this.#db.ensureThread(threadId);
            } catch { /* DB errors should not break dispatch */ }
        }

        // Idempotency: skip duplicate message IDs
        const msgId = msg.messageId || msg.id;
        if (msgId) {
            if (this.#seenIds.has(msgId)) {
                this.#metrics.inc('events.deduplicated');
                return;
            }
            this.#seenIds.add(msgId);
            // Evict oldest when exceeding cache size
            if (this.#seenIds.size > this.#config.idempotencyCacheSize) {
                const first = this.#seenIds.values().next().value;
                this.#seenIds.delete(first);
            }
        }

        // Backpressure: drop if too many in-flight
        if (this.#activeHandlers >= this.#config.maxConcurrentHandlers) {
            this.#metrics.inc('events.dropped');
            this.#logger.warn('Handler concurrency limit reached, dropping event', { eventType, msgId });
            return;
        }

        // DB: save message
        if (this.#db) {
            try { this.#db.saveMessage(msg, eventType === 'e2eeMessage'); } catch { /* ignore */ }
        }

        this.#metrics.inc('events.processed');
        this.#activeHandlers++;
        this.#metrics.gauge('handlers.active', this.#activeHandlers);

        // Run matching handlers with timeout
        this.#runHandlers(eventType, msg).finally(() => {
            this.#activeHandlers--;
            this.#metrics.gauge('handlers.active', this.#activeHandlers);
        });
    }

    async #runHandlers(eventType, msg) {
        for (const handler of this.#handlers) {
            try {
                if (!handler.match(eventType, msg)) continue;

                // Execute with timeout
                const result = Promise.resolve(handler.handle(eventType, msg, this.#adapter));
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Handler '${handler.name}' timed out`)), this.#config.handlerTimeoutMs)
                );

                await Promise.race([result, timeout]);
                break; // First matching handler wins
            } catch (err) {
                this.#metrics.inc('errors.handler');
                this.#logger.error('Handler error', {
                    handler: handler.name,
                    error: err.message,
                });
            }
        }
    }

    async shutdown() {
        this.#shuttingDown = true;
        this.#logger.info('Shutting down, draining handlers', { active: this.#activeHandlers });

        // Wait up to 10s for in-flight handlers
        const deadline = Date.now() + 10_000;
        while (this.#activeHandlers > 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 200));
        }

        if (this.#activeHandlers > 0) {
            this.#logger.warn('Forced shutdown with active handlers', { active: this.#activeHandlers });
        }
    }
}
