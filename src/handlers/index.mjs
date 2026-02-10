// Handler registry — order matters: first match wins
import { MediaHandler } from './media.mjs';
import { PingHandler } from './ping.mjs';
import { createCommandHandler } from './command.mjs';
import { CommandRegistry } from '../commands/registry.mjs';
import { registerBuiltinCommands } from '../commands/definitions.mjs';

// Static handlers (no dependencies)
export const handlers = [
    MediaHandler,  // Link detection first
    PingHandler,   // Specific commands (legacy, bare "ping")
];

/**
 * Build the full handler list with command system enabled.
 * @param {Object} db - Database instance
 * @param {Object} metrics - Metrics instance
 * @returns {{ handlers: Object[], registry: import('../commands/registry.mjs').CommandRegistry }}
 */
export function buildHandlers(db, metrics) {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const commandHandler = createCommandHandler(registry, db, metrics);

    return {
        handlers: [
            commandHandler,  // Prefixed commands first (e.g. !help, !status)
            MediaHandler,    // Link detection
            PingHandler,     // Legacy bare "ping"
        ],
        registry,
    };
}
