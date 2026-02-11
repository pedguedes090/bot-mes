// Handler registry — order matters: first match wins
import { MediaHandler } from './media.mjs';
import { PingHandler } from './ping.mjs';
import { createCommandHandler } from './command.mjs';
import { createChatHandler } from './chat.mjs';
import { CommandRegistry } from '../commands/registry.mjs';
import { registerBuiltinCommands } from '../commands/definitions.mjs';

/**
 * Build the full handler list with command system enabled.
 * @param {Object} db - Database instance
 * @param {Object} metrics - Metrics instance
 * @param {import('../adapters/gemini.mjs').GeminiAdapter} [gemini] - Gemini adapter
 * @param {Object} [logger] - Logger instance
 * @returns {{ handlers: Object[], registry: import('../commands/registry.mjs').CommandRegistry }}
 */
export function buildHandlers(db, metrics, gemini, logger) {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const commandHandler = createCommandHandler(registry, db, metrics);

    const handlers = [
        commandHandler,  // Prefixed commands first (e.g. !help, !status)
        MediaHandler,    // Link detection
        PingHandler,     // Legacy bare "ping"
    ];

    // AI chat handler is last — catch-all for unhandled text messages
    if (gemini) {
        handlers.push(createChatHandler(gemini, db, metrics, logger));
    }

    return {
        handlers,
        registry,
    };
}
