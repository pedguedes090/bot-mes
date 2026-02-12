export class BotCore {
    #adapter;
    #handlers;
    #config;
    #logger;
    #metrics;
    #db;
    #activeHandlers = 0;
    #seenIds;
    #seenIdx = 0;
    #shuttingDown = false;

    constructor(adapter, handlers, config, logger, metrics, db = null) {
        this.#adapter = adapter;
        this.#handlers = handlers;
        this.#config = config;
        this.#logger = logger.child('core');
        this.#metrics = metrics;
        this.#db = db;
        // Fixed-size ring buffer for idempotency deduplication
        const cap = config.idempotencyCacheSize;
        this.#seenIds = { set: new Set(), buf: new Array(cap), cap };
        this.#seenIdx = 0;
    }

    start() {
        this.#adapter.on('message', (msg) => {
            // Schedule dispatch asynchronously so concurrent messages don't block each other
            setImmediate(() => this.#dispatch('message', msg));
        });
        this.#adapter.on('e2eeMessage', (msg) => {
            setImmediate(() => this.#dispatch('e2eeMessage', msg));
        });
        this.#logger.info('Bot core started', {
            handlers: this.#handlers.map(h => h.name),
            maxConcurrent: this.#config.maxConcurrentHandlers,
        });
    }

    async #dispatch(eventType, msg) {
        if (this.#shuttingDown) return;

        // Skip own messages
        const selfId = this.#adapter.currentUserId;
        if (selfId && msg.senderId === selfId) return;

        // DB: track user and thread, check blocked
        if (this.#db) {
            try {
                const senderId = String(msg.senderId || '');
                if (senderId) {
                    await this.#ensureUser(senderId);
                    if (this.#db.isBlocked(senderId)) {
                        this.#metrics.inc('events.blocked');
                        return;
                    }
                }
                const threadId = String(msg.threadId || msg.chatJid || '');
                if (threadId) this.#db.ensureThread(threadId);
            } catch { /* DB errors should not break dispatch */ }
        }

        // Idempotency: skip duplicate message IDs (ring buffer)
        const msgId = msg.messageId || msg.id;
        if (msgId) {
            const cache = this.#seenIds;
            if (cache.set.has(msgId)) {
                this.#metrics.inc('events.deduplicated');
                return;
            }
            // Evict oldest entry in ring buffer slot before inserting
            const evicted = cache.buf[this.#seenIdx];
            if (evicted !== undefined) cache.set.delete(evicted);
            cache.buf[this.#seenIdx] = msgId;
            cache.set.add(msgId);
            this.#seenIdx = (this.#seenIdx + 1) % cache.cap;
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
        const msgId = msg.messageId || msg.id || '';
        for (const handler of this.#handlers) {
            try {
                if (!handler.match(eventType, msg)) continue;

                // Execute with timeout; clear timer to avoid leaks
                let timer;
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`Handler '${handler.name}' timed out`)), this.#config.handlerTimeoutMs);
                });
                // Swallow rejections from the handler promise after timeout wins the race
                const result = Promise.resolve(handler.handle(eventType, msg, this.#adapter));
                result.catch(() => {});

                try {
                    await Promise.race([result, timeout]);
                } finally {
                    clearTimeout(timer);
                }
                break; // First matching handler wins
            } catch (err) {
                this.#metrics.inc('errors.handler');
                this.#logger.error('Handler error', {
                    handler: handler.name,
                    msgId,
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
    async #ensureUser(userId) {
        const user = this.#db.getUser(userId);
        if (user) return;

        // New user: fetch info from adapter
        try {
            const info = await this.#adapter.getUserInfo(userId);
            this.#db.ensureUser(userId, info.name, info.username, info.profilePictureUrl);
            this.#logger.info('Registered new user', { userId, name: info.name });
            this.#metrics.inc('users.registered');
        } catch (err) {
            this.#logger.warn('Failed to fetch user info', { userId, error: err.message });
            this.#db.ensureUser(userId, `User ${userId}`);
        }
    }
}
