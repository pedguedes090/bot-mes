// Handler: dispatches prefixed commands (e.g. !help, !status, !block)
import { parseCommand } from '../commands/parser.mjs';

export function createCommandHandler(registry, db, metrics) {
    return {
        name: 'command',

        match(eventType, msg) {
            const text = msg.text?.trim();
            if (!text) return false;
            const parsed = parseCommand(text);
            return parsed !== null && registry.get(parsed.command) !== undefined;
        },

        async handle(eventType, msg, adapter) {
            const text = msg.text.trim();
            const parsed = parseCommand(text);
            if (!parsed) return;

            const cmdDef = registry.get(parsed.command);
            if (!cmdDef) return;

            const senderId = String(msg.senderId || '');
            const isAdmin = db ? (db.getUser(senderId)?.is_admin === 1) : false;

            // Permission check
            if (cmdDef.permission === 'admin' && !isAdmin) {
                const reply = '🔒 This command requires admin permissions';
                await sendReply(eventType, msg, adapter, reply);
                return;
            }

            try {
                const ctx = {
                    args: parsed.args,
                    senderId,
                    threadId: String(msg.threadId || msg.chatJid || ''),
                    db,
                    metrics,
                    isAdmin,
                    registry,
                };

                const reply = await cmdDef.execute(ctx);
                if (reply) {
                    await sendReply(eventType, msg, adapter, reply);
                }
            } catch (err) {
                const reply = `❌ Command error: ${err.message || 'Unknown error'}`;
                await sendReply(eventType, msg, adapter, reply);
            }
        },
    };
}

async function sendReply(eventType, msg, adapter, text) {
    if (eventType === 'e2eeMessage') {
        await adapter.sendE2EEMessage(msg.chatJid, text);
    } else {
        await adapter.sendMessage(msg.threadId, text);
    }
}
