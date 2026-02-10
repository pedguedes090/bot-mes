import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from '../../src/commands/registry.mjs';

describe('CommandRegistry', () => {
    it('registers and retrieves a command', () => {
        const reg = new CommandRegistry();
        const cmd = { name: 'test', description: 'A test', usage: '!test', permission: 'user', execute: async () => 'ok' };
        reg.register(cmd);
        assert.strictEqual(reg.get('test'), cmd);
    });

    it('returns undefined for unregistered command', () => {
        const reg = new CommandRegistry();
        assert.strictEqual(reg.get('nonexistent'), undefined);
    });

    it('lists all commands', () => {
        const reg = new CommandRegistry();
        reg.register({ name: 'a', permission: 'user' });
        reg.register({ name: 'b', permission: 'admin' });
        assert.strictEqual(reg.all().length, 2);
    });

    it('filters commands by user permission', () => {
        const reg = new CommandRegistry();
        reg.register({ name: 'a', permission: 'user' });
        reg.register({ name: 'b', permission: 'admin' });
        const userCmds = reg.forPermission('user');
        assert.strictEqual(userCmds.length, 1);
        assert.strictEqual(userCmds[0].name, 'a');
    });

    it('shows all commands for admin permission', () => {
        const reg = new CommandRegistry();
        reg.register({ name: 'a', permission: 'user' });
        reg.register({ name: 'b', permission: 'admin' });
        const adminCmds = reg.forPermission('admin');
        assert.strictEqual(adminCmds.length, 2);
    });
});
