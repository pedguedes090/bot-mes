// Built-in command definitions

/**
 * Register all built-in commands on a CommandRegistry.
 * @param {import('./registry.mjs').CommandRegistry} registry
 */
export function registerBuiltinCommands(registry) {
    registry.register({
        name: 'help',
        description: 'List available commands',
        usage: '!help [command]',
        permission: 'user',
        async execute(ctx) {
            const { args, isAdmin } = ctx;
            const permission = isAdmin ? 'admin' : 'user';
            const reg = ctx.registry;

            if (args.length > 0) {
                const cmd = reg.get(args[0].toLowerCase());
                if (!cmd) return `❌ Unknown command: ${args[0]}`;
                if (cmd.permission === 'admin' && !isAdmin) return `❌ Unknown command: ${args[0]}`;
                return `📖 ${cmd.name}\n${cmd.description}\nUsage: ${cmd.usage}`;
            }

            const cmds = reg.forPermission(permission);
            const lines = cmds.map(c => `  ${c.usage} — ${c.description}`);
            return `📋 Available commands:\n${lines.join('\n')}`;
        },
    });

    registry.register({
        name: 'ping',
        description: 'Check if the bot is alive',
        usage: '!ping',
        permission: 'user',
        async execute() {
            return 'pong 🏓';
        },
    });

    registry.register({
        name: 'status',
        description: 'Show bot status and uptime',
        usage: '!status',
        permission: 'user',
        async execute(ctx) {
            const { metrics, db } = ctx;
            const snapshot = metrics.snapshot();
            const dbStats = db ? db.stats() : null;

            const lines = [
                '📊 Bot Status',
                `⏱ Uptime: ${formatUptime(snapshot.uptime_seconds || 0)}`,
                `🧠 RAM: RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB / Heap ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                `📨 Messages processed: ${snapshot['events.processed'] || 0}`,
                `📤 Messages sent: ${snapshot['messages.sent'] || 0}`,
                `🖼 Media sent: ${snapshot['media.sent'] || 0}`,
                `⚠️ Errors: ${snapshot['errors.handler'] || 0}`,
            ];

            if (dbStats) {
                lines.push(`💾 DB: ${dbStats.messages} msgs, ${dbStats.threads} threads, ${dbStats.users} users`);
            }

            return lines.join('\n');
        },
    });

    registry.register({
        name: 'stats',
        description: 'Show detailed system statistics',
        usage: '!stats',
        permission: 'admin',
        async execute(ctx) {
            const { metrics, db } = ctx;
            const snapshot = metrics.snapshot();
            const dbStats = db ? db.stats() : null;

            const lines = [
                '📈 System Statistics',
                `⏱ Uptime: ${formatUptime(snapshot.uptime_seconds || 0)}`,
                '',
                '— Events —',
                `  Received: ${snapshot['events.received'] || 0}`,
                `  Processed: ${snapshot['events.processed'] || 0}`,
                `  Blocked: ${snapshot['events.blocked'] || 0}`,
                `  Deduplicated: ${snapshot['events.deduplicated'] || 0}`,
                `  Dropped: ${snapshot['events.dropped'] || 0}`,
                '',
                '— Messaging —',
                `  Sent: ${snapshot['messages.sent'] || 0}`,
                `  Media sent: ${snapshot['media.sent'] || 0}`,
                '',
                '— Errors —',
                `  Handler errors: ${snapshot['errors.handler'] || 0}`,
                `  Total errors: ${snapshot['errors.total'] || 0}`,
            ];

            if (dbStats) {
                lines.push('', '— Database —');
                lines.push(`  Messages: ${dbStats.messages}`);
                lines.push(`  Threads: ${dbStats.threads}`);
                lines.push(`  Users: ${dbStats.users}`);
            }

            return lines.join('\n');
        },
    });

    registry.register({
        name: 'block',
        description: 'Block a user from using the bot',
        usage: '!block <userId>',
        permission: 'admin',
        async execute(ctx) {
            const { args, db } = ctx;
            if (!db) return '❌ Database not available';
            if (args.length < 1) return '❌ Usage: !block <userId>';
            const userId = args[0];
            db.ensureUser(userId);
            db.setBlocked(userId, true);
            return `✅ User ${userId} has been blocked`;
        },
    });

    registry.register({
        name: 'unblock',
        description: 'Unblock a user',
        usage: '!unblock <userId>',
        permission: 'admin',
        async execute(ctx) {
            const { args, db } = ctx;
            if (!db) return '❌ Database not available';
            if (args.length < 1) return '❌ Usage: !unblock <userId>';
            const userId = args[0];
            const user = db.getUser(userId);
            if (!user) return `❌ User ${userId} not found`;
            db.setBlocked(userId, false);
            return `✅ User ${userId} has been unblocked`;
        },
    });

    registry.register({
        name: 'admin',
        description: 'Grant or revoke admin for a user',
        usage: '!admin <grant|revoke> <userId>',
        permission: 'admin',
        async execute(ctx) {
            const { args, db } = ctx;
            if (!db) return '❌ Database not available';
            if (args.length < 2) return '❌ Usage: !admin <grant|revoke> <userId>';
            const action = args[0].toLowerCase();
            const userId = args[1];
            if (action !== 'grant' && action !== 'revoke') {
                return '❌ Usage: !admin <grant|revoke> <userId>';
            }
            db.ensureUser(userId);
            db.setAdmin(userId, action === 'grant');
            return `✅ Admin ${action === 'grant' ? 'granted to' : 'revoked from'} user ${userId}`;
        },
    });
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}
