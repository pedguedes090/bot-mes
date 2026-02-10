import { loadConfig } from './config/index.mjs';
import { Logger } from './observability/logger.mjs';
import { Metrics } from './observability/metrics.mjs';
import { Database } from './adapters/database.mjs';
import { MessengerAdapter } from './adapters/messenger.mjs';
import { BotCore } from './bot/core.mjs';
import { buildHandlers } from './handlers/index.mjs';

const config = loadConfig();
const logger = new Logger('main', config.logLevel);
const metrics = new Metrics();

logger.info('Starting bot', {
    e2ee: config.enableE2EE,
    autoReconnect: config.autoReconnect,
    maxConcurrent: config.maxConcurrentHandlers,
    sendRate: config.sendRatePerSec,
});

// Start metrics/health server
metrics.startServer(config.metricsPort, logger);

// Init database
const db = new Database(config.dbPath, logger);

// Build handlers with command system
const { handlers } = buildHandlers(db, metrics);

// Create adapter and bot core
const adapter = new MessengerAdapter(config, logger, metrics);
const bot = new BotCore(adapter, handlers, config, logger, metrics, db);

// Connect
try {
    await adapter.connect();
    bot.start();
} catch (err) {
    logger.error('Failed to connect', { error: err.message });
    process.exit(1);
}

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown signal received', { signal });

    try {
        await bot.shutdown();
        await adapter.disconnect();
        await metrics.stop();
        db.close();
    } catch (err) {
        logger.error('Error during shutdown', { error: err.message });
    }

    logger.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
});
