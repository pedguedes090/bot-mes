// Command parser: extracts command name and arguments from prefixed messages
// Example: "!help" → { command: "help", args: [] }
// Example: "!block 12345 spam" → { command: "block", args: ["12345", "spam"] }

const DEFAULT_PREFIX = '!';

/**
 * Parse a message text into a command object.
 * @param {string} text - The raw message text
 * @param {string} [prefix] - The command prefix (default: "!")
 * @returns {{ command: string, args: string[], raw: string } | null}
 */
export function parseCommand(text, prefix = DEFAULT_PREFIX) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith(prefix)) return null;

    const withoutPrefix = trimmed.slice(prefix.length);
    if (!withoutPrefix) return null;

    const parts = withoutPrefix.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    return { command, args, raw: trimmed };
}
