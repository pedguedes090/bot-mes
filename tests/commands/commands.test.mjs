import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from '../../src/commands/registry.mjs';
import { registerBuiltinCommands } from '../../src/commands/definitions.mjs';
import { createCommandHandler } from '../../src/handlers/command.mjs';

// Minimal mock metrics
function mockMetrics() {
    return {
        snapshot: () => ({
            uptime_seconds: 120,
            'events.processed': 50,
            'messages.sent': 30,
            'media.sent': 5,
            'errors.handler': 1,
            'events.received': 60,
            'events.blocked': 2,
            'events.deduplicated': 3,
            'events.dropped': 0,
            'errors.total': 1,
        }),
    };
}

// Minimal mock database
function mockDb(opts = {}) {
    const users = new Map();
    return {
        getUser: (id) => users.get(id) || null,
        ensureUser: (id, name) => {
            if (!users.has(id)) users.set(id, { id, name, is_admin: 0, is_blocked: 0 });
        },
        setBlocked: (id, blocked) => {
            const u = users.get(id);
            if (u) u.is_blocked = blocked ? 1 : 0;
        },
        setAdmin: (id, admin) => {
            const u = users.get(id);
            if (u) u.is_admin = admin ? 1 : 0;
        },
        stats: () => ({ messages: 100, threads: 10, users: 5, ...opts.stats }),
    };
}

describe('Built-in commands', () => {
    it('help command lists user commands', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('help');
        const result = await cmd.execute({
            args: [],
            isAdmin: false,
            registry,
        });

        assert.ok(result.includes('Available commands'));
        assert.ok(result.includes('!help'));
        assert.ok(result.includes('!ping'));
        assert.ok(result.includes('!status'));
        // Admin commands should not be shown to regular users
        assert.ok(!result.includes('!block'));
    });

    it('help command shows admin commands to admins', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('help');
        const result = await cmd.execute({
            args: [],
            isAdmin: true,
            registry,
        });

        assert.ok(result.includes('!block'));
        assert.ok(result.includes('!stats'));
    });

    it('help command shows details for a specific command', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('help');
        const result = await cmd.execute({
            args: ['ping'],
            isAdmin: false,
            registry,
        });

        assert.ok(result.includes('ping'));
        assert.ok(result.includes('Usage'));
    });

    it('help returns error for unknown command', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('help');
        const result = await cmd.execute({
            args: ['nonexistent'],
            isAdmin: false,
            registry,
        });

        assert.ok(result.includes('❌'));
    });

    it('ping command returns pong', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('ping');
        const result = await cmd.execute({});
        assert.ok(result.includes('pong'));
    });

    it('status command shows uptime and stats', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('status');
        const result = await cmd.execute({
            metrics: mockMetrics(),
            db: mockDb(),
        });

        assert.ok(result.includes('Bot Status'));
        assert.ok(result.includes('Uptime'));
        assert.ok(result.includes('50'));  // events.processed
    });

    it('block command blocks a user', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();

        const cmd = registry.get('block');
        const result = await cmd.execute({ args: ['user123'], db });

        assert.ok(result.includes('✅'));
        assert.ok(result.includes('blocked'));
        assert.strictEqual(db.getUser('user123').is_blocked, 1);
    });

    it('block command requires userId argument', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('block');
        const result = await cmd.execute({ args: [], db: mockDb() });
        assert.ok(result.includes('❌'));
    });

    it('unblock command unblocks a user', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();

        // First block, then unblock
        db.ensureUser('user123');
        db.setBlocked('user123', true);

        const cmd = registry.get('unblock');
        const result = await cmd.execute({ args: ['user123'], db });

        assert.ok(result.includes('✅'));
        assert.strictEqual(db.getUser('user123').is_blocked, 0);
    });

    it('unblock command returns error for unknown user', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('unblock');
        const result = await cmd.execute({ args: ['unknown'], db: mockDb() });
        assert.ok(result.includes('❌'));
    });

    it('admin grant command grants admin', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();

        const cmd = registry.get('admin');
        const result = await cmd.execute({ args: ['grant', 'user123'], db });

        assert.ok(result.includes('✅'));
        assert.ok(result.includes('granted'));
        assert.strictEqual(db.getUser('user123').is_admin, 1);
    });

    it('admin revoke command revokes admin', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();
        db.ensureUser('user123');
        db.setAdmin('user123', true);

        const cmd = registry.get('admin');
        const result = await cmd.execute({ args: ['revoke', 'user123'], db });

        assert.ok(result.includes('✅'));
        assert.ok(result.includes('revoked'));
        assert.strictEqual(db.getUser('user123').is_admin, 0);
    });

    it('admin command requires valid action', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);

        const cmd = registry.get('admin');
        const result = await cmd.execute({ args: ['invalid', 'user123'], db: mockDb() });
        assert.ok(result.includes('❌'));
    });
});

describe('CommandHandler integration', () => {
    it('matches prefixed commands', () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const handler = createCommandHandler(registry, mockDb(), mockMetrics());

        assert.strictEqual(handler.match('message', { text: '!help' }), true);
        assert.strictEqual(handler.match('message', { text: '!ping' }), true);
        assert.strictEqual(handler.match('message', { text: '!status' }), true);
    });

    it('does not match non-commands', () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const handler = createCommandHandler(registry, mockDb(), mockMetrics());

        assert.strictEqual(handler.match('message', { text: 'hello' }), false);
        assert.strictEqual(handler.match('message', { text: '!nonexistent' }), false);
        assert.strictEqual(handler.match('message', { text: '' }), false);
        assert.strictEqual(handler.match('message', {}), false);
    });

    it('sends reply for regular message', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();
        const handler = createCommandHandler(registry, db, mockMetrics());
        const adapter = { sendMessage: mock.fn(async () => {}) };

        await handler.handle('message', { threadId: '123', text: '!ping', senderId: 'user1' }, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.ok(adapter.sendMessage.mock.calls[0].arguments[1].includes('pong'));
    });

    it('sends reply for e2ee message', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const handler = createCommandHandler(registry, mockDb(), mockMetrics());
        const adapter = { sendE2EEMessage: mock.fn(async () => {}) };

        await handler.handle('e2eeMessage', { chatJid: '123@msgr.fb', text: '!ping', senderId: 'user1' }, adapter);

        assert.strictEqual(adapter.sendE2EEMessage.mock.callCount(), 1);
        assert.ok(adapter.sendE2EEMessage.mock.calls[0].arguments[1].includes('pong'));
    });

    it('denies admin commands to non-admin users', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();
        db.ensureUser('user1');  // non-admin user
        const handler = createCommandHandler(registry, db, mockMetrics());
        const adapter = { sendMessage: mock.fn(async () => {}) };

        await handler.handle('message', { threadId: '123', text: '!block user2', senderId: 'user1' }, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.ok(adapter.sendMessage.mock.calls[0].arguments[1].includes('admin'));
    });

    it('allows admin commands for admin users', async () => {
        const registry = new CommandRegistry();
        registerBuiltinCommands(registry);
        const db = mockDb();
        db.ensureUser('admin1');
        db.setAdmin('admin1', true);
        const handler = createCommandHandler(registry, db, mockMetrics());
        const adapter = { sendMessage: mock.fn(async () => {}) };

        await handler.handle('message', { threadId: '123', text: '!block user2', senderId: 'admin1' }, adapter);

        assert.strictEqual(adapter.sendMessage.mock.callCount(), 1);
        assert.ok(adapter.sendMessage.mock.calls[0].arguments[1].includes('✅'));
    });
});
