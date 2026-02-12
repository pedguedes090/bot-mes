// ContextLoader — fetches and formats conversation history for a thread
// Loads 30–50 messages depending on availability, with an in-memory cache.

const DEFAULT_MIN_MESSAGES = 30;
const DEFAULT_MAX_MESSAGES = 50;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3-minute TTL
const MAX_CACHE_ENTRIES = 15; // Limit cache size to prevent unbounded growth
const MEMORY_PRESSURE_RATIO = 0.65; // Clear cache when heap exceeds 65% of allocated heap
const MEMORY_PRESSURE_COOLDOWN_MS = 15_000; // Minimum interval between pressure clears

/**
 * @typedef {Object} LoadedContext
 * @property {string} threadId
 * @property {Array<{senderId: string, text: string, timestamp: number}>} messages
 * @property {number} messageCount
 * @property {string} formatted - Pre-formatted chat string for prompts
 */

export class ContextLoader {
    #db;
    #logger;
    #metrics;
    #cache = new Map();
    #maxMessages;
    #minMessages;
    #lastPressureClearAt = 0;

    /**
     * @param {Object} db - Database instance
     * @param {Object} logger - Logger instance
     * @param {Object} metrics - Metrics instance
     * @param {Object} [options]
     * @param {number} [options.minMessages=30]
     * @param {number} [options.maxMessages=200]
     */
    constructor(db, logger, metrics, options = {}) {
        this.#db = db;
        this.#logger = logger.child('context-loader');
        this.#metrics = metrics;
        this.#minMessages = options.minMessages ?? DEFAULT_MIN_MESSAGES;
        this.#maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    }

    /**
     * Load conversation context for a thread.
     * @param {string} threadId
     * @param {string} [currentText] - Current message to append
     * @param {string} [senderId] - Current sender ID
     * @returns {LoadedContext}
     */
    load(threadId, currentText, senderId) {
        // Check cache
        const cached = this.#cache.get(threadId);
        if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
            this.#metrics.inc('context_loader.cache_hit');
            // Append current message to cached context
            if (currentText) {
                return this.#appendCurrent(cached.context, currentText, senderId);
            }
            return cached.context;
        }

        this.#metrics.inc('context_loader.cache_miss');

        // Under memory pressure (with cooldown), clear the entire cache to help GC
        if (this.#isMemoryPressure() && (Date.now() - this.#lastPressureClearAt) >= MEMORY_PRESSURE_COOLDOWN_MS) {
            this.#cache.clear();
            this.#lastPressureClearAt = Date.now();
            this.#logger.debug('Context cache cleared due to memory pressure');
            this.#metrics.inc('context_loader.memory_pressure_clear');
        }

        // Evict stale entries to prevent unbounded memory growth
        this.#evictStale();

        // Load base context (without current message) for caching
        const baseContext = this.#loadFromDb(threadId);
        this.#cache.set(threadId, {
            context: baseContext,
            loadedAt: Date.now(),
        });

        // Append current message if provided
        const context = currentText
            ? this.#appendCurrent(baseContext, currentText, senderId)
            : baseContext;

        this.#metrics.gauge('context_window_size', context.messageCount);
        return context;
    }

    /**
     * Invalidate cache for a thread (e.g. after sending a message).
     * @param {string} threadId
     */
    invalidate(threadId) {
        this.#cache.delete(threadId);
    }

    /**
     * Clear the entire cache.
     */
    clearCache() {
        this.#cache.clear();
    }

    /**
     * Destroy the loader — clears cache and releases internal references.
     * Call during graceful shutdown to assist garbage collection.
     */
    destroy() {
        this.#cache.clear();
    }

    /**
     * Check if the process is under memory pressure.
     * Compares heapUsed against heapTotal (currently allocated heap, not the
     * --max-old-space-size ceiling). When the ratio is high, V8 is close to
     * requesting more memory from the OS or hitting the configured limit.
     */
    #isMemoryPressure() {
        const mem = process.memoryUsage();
        return mem.heapUsed > MEMORY_PRESSURE_RATIO * mem.heapTotal;
    }

    /**
     * Evict expired entries and enforce max cache size.
     */
    #evictStale() {
        const now = Date.now();
        for (const [key, entry] of this.#cache) {
            if ((now - entry.loadedAt) >= CACHE_TTL_MS) {
                this.#cache.delete(key);
            }
        }
        // If still at or over limit, remove oldest entries until under limit
        while (this.#cache.size >= MAX_CACHE_ENTRIES) {
            let oldest = null;
            let oldestKey = null;
            for (const [key, entry] of this.#cache) {
                if (!oldest || entry.loadedAt < oldest) {
                    oldest = entry.loadedAt;
                    oldestKey = key;
                }
            }
            if (oldestKey) this.#cache.delete(oldestKey);
            else break;
        }
    }

    /**
     * Load messages from the database.
     * @param {string} threadId
     * @returns {LoadedContext}
     */
    #loadFromDb(threadId) {
        const messages = [];

        if (this.#db && threadId) {
            try {
                const raw = this.#db.getMessages(threadId, this.#maxMessages);
                // Messages come newest-first; reverse for chronological order
                for (let i = raw.length - 1; i >= 0; i--) {
                    const m = raw[i];
                    if (m.text) {
                        messages.push({
                            senderId: m.sender_id || 'unknown',
                            text: m.text,
                            timestamp: m.timestamp || 0,
                        });
                    }
                }
            } catch (err) {
                this.#logger.error('Failed to load messages from DB', { error: err.message });
            }
        }

        const formatted = messages
            .map(m => `[${m.senderId}]: ${m.text}`)
            .join('\n');

        this.#logger.debug('Context loaded', {
            threadId,
            messageCount: messages.length,
        });

        return {
            threadId,
            messages,
            messageCount: messages.length,
            formatted,
        };
    }

    /**
     * Append current message to an existing context.
     * Avoids spreading the full messages array; reuses the cached formatted string.
     */
    #appendCurrent(context, currentText, senderId) {
        const currentMsg = { senderId: senderId || 'user', text: currentText, timestamp: Date.now() };
        const currentLine = `[${currentMsg.senderId}]: ${currentMsg.text}`;

        // Append to the formatted string instead of rebuilding from scratch
        const formatted = context.formatted
            ? context.formatted + '\n' + currentLine
            : currentLine;

        return {
            threadId: context.threadId,
            messages: context.messages.concat(currentMsg),
            messageCount: context.messageCount + 1,
            formatted,
        };
    }
}

export { DEFAULT_MIN_MESSAGES, DEFAULT_MAX_MESSAGES, CACHE_TTL_MS, MAX_CACHE_ENTRIES, MEMORY_PRESSURE_RATIO, MEMORY_PRESSURE_COOLDOWN_MS };
