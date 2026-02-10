import { Client, Utils } from 'meta-messenger.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// Token-bucket rate limiter
class RateLimiter {
    #tokens;
    #maxTokens;
    #refillRate;
    #lastRefill;

    constructor(ratePerSec) {
        this.#maxTokens = ratePerSec;
        this.#tokens = ratePerSec;
        this.#refillRate = ratePerSec;
        this.#lastRefill = Date.now();
    }

    async acquire() {
        this.#refill();
        if (this.#tokens >= 1) {
            this.#tokens -= 1;
            return;
        }
        // Wait until a token is available
        const waitMs = Math.ceil((1 - this.#tokens) / this.#refillRate * 1000);
        await new Promise(r => setTimeout(r, waitMs));
        this.#refill();
        this.#tokens = Math.max(0, this.#tokens - 1);
    }

    #refill() {
        const now = Date.now();
        const elapsed = (now - this.#lastRefill) / 1000;
        this.#tokens = Math.min(this.#maxTokens, this.#tokens + elapsed * this.#refillRate);
        this.#lastRefill = now;
    }
}

export class MessengerAdapter extends EventEmitter {
    #client;
    #config;
    #logger;
    #metrics;
    #limiter;
    #reconnectAttempts = 0;
    #maxReconnectDelay = 60_000;

    constructor(config, logger, metrics) {
        super();
        this.#config = config;
        this.#logger = logger.child('adapter');
        this.#metrics = metrics;
        this.#limiter = new RateLimiter(config.sendRatePerSec);
    }

    get currentUserId() {
        return this.#client?.currentUserId ?? null;
    }

    async connect() {
        // Build cookies object (filter empty values)
        const cookies = Object.fromEntries(
            Object.entries(this.#config.cookies).filter(([, v]) => v)
        );

        // Load device data if exists
        let deviceData;
        if (existsSync(this.#config.deviceDataPath)) {
            try {
                deviceData = readFileSync(this.#config.deviceDataPath, 'utf-8');
                this.#logger.info('Loaded device data', { path: this.#config.deviceDataPath });
            } catch { /* ignore */ }
        }

        this.#client = new Client(cookies, {
            enableE2EE: this.#config.enableE2EE,
            autoReconnect: this.#config.autoReconnect,
            logLevel: this.#config.logLevel === 'debug' ? 'debug' : 'none',
            deviceData,
        });

        this.#wireEvents();

        const { user } = await this.#client.connect();
        this.#reconnectAttempts = 0;
        this.#logger.info('Connected', { userId: user.id.toString(), name: user.name });
        return user;
    }

    #wireEvents() {
        const c = this.#client;

        c.on('fullyReady', () => {
            this.#logger.info('Fully ready');
            this.#metrics.inc('adapter.fully_ready');
            this.emit('ready');
        });

        c.on('message', (msg) => {
            this.#metrics.inc('events.received');
            this.emit('message', msg);
        });

        c.on('e2eeMessage', (msg) => {
            this.#metrics.inc('events.received');
            this.emit('e2eeMessage', msg);
        });

        c.on('reconnected', () => {
            this.#reconnectAttempts = 0;
            this.#metrics.inc('adapter.reconnected');
            this.#logger.info('Reconnected');
        });

        c.on('disconnected', (data) => {
            this.#metrics.inc('adapter.disconnected');
            this.#logger.warn('Disconnected', data);
        });

        c.on('error', (err) => {
            this.#metrics.inc('errors.total');
            this.#logger.error('Client error', { error: err.message });
            this.emit('error', err);
        });

        // Persist device data on change
        c.on('deviceDataChanged', ({ deviceData }) => {
            try {
                writeFileSync(this.#config.deviceDataPath, deviceData);
                this.#logger.debug('Device data saved');
            } catch (e) {
                this.#logger.warn('Failed to save device data', { error: e.message });
            }
        });
    }

    // Rate-limited send
    async sendMessage(threadId, options) {
        await this.#limiter.acquire();
        this.#metrics.inc('messages.sent');
        return this.#client.sendMessage(threadId, options);
    }

    async sendE2EEMessage(chatJid, text, options) {
        await this.#limiter.acquire();
        this.#metrics.inc('messages.sent');
        return this.#client.sendE2EEMessage(chatJid, text, options);
    }

    async sendReaction(threadId, messageId, emoji) {
        await this.#limiter.acquire();
        return this.#client.sendReaction(threadId, messageId, emoji);
    }

    async sendImage(threadId, data, filename, caption) {
        await this.#limiter.acquire();
        this.#metrics.inc('media.sent');
        return this.#client.sendImage(threadId, data, filename, caption);
    }

    async sendVideo(threadId, data, filename, caption) {
        await this.#limiter.acquire();
        this.#metrics.inc('media.sent');
        return this.#client.sendVideo(threadId, data, filename, caption);
    }

    // No rate-limit delay — for batch sends so Messenger groups media together
    async sendImageDirect(threadId, data, filename, caption) {
        this.#metrics.inc('media.sent');
        return this.#client.sendImage(threadId, data, filename, caption);
    }

    async sendVideoDirect(threadId, data, filename, caption) {
        this.#metrics.inc('media.sent');
        return this.#client.sendVideo(threadId, data, filename, caption);
    }

    async sendTypingIndicator(threadId, isTyping, isGroup) {
        return this.#client.sendTypingIndicator(threadId, isTyping, isGroup);
    }

    async disconnect() {
        if (this.#client) {
            this.#logger.info('Disconnecting');
            await this.#client.disconnect();
        }
    }
}
