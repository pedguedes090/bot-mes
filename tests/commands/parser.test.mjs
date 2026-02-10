import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/commands/parser.mjs';

describe('parseCommand', () => {
    it('parses a simple command', () => {
        const result = parseCommand('!help');
        assert.deepStrictEqual(result, { command: 'help', args: [], raw: '!help' });
    });

    it('parses a command with arguments', () => {
        const result = parseCommand('!block 12345');
        assert.deepStrictEqual(result, { command: 'block', args: ['12345'], raw: '!block 12345' });
    });

    it('parses a command with multiple arguments', () => {
        const result = parseCommand('!admin grant 12345');
        assert.deepStrictEqual(result, { command: 'admin', args: ['grant', '12345'], raw: '!admin grant 12345' });
    });

    it('normalizes command name to lowercase', () => {
        const result = parseCommand('!HELP');
        assert.strictEqual(result.command, 'help');
    });

    it('trims whitespace', () => {
        const result = parseCommand('  !help  ');
        assert.deepStrictEqual(result, { command: 'help', args: [], raw: '!help' });
    });

    it('handles extra whitespace between args', () => {
        const result = parseCommand('!block   12345   reason');
        assert.deepStrictEqual(result, { command: 'block', args: ['12345', 'reason'], raw: '!block   12345   reason' });
    });

    it('returns null for non-command text', () => {
        assert.strictEqual(parseCommand('hello world'), null);
    });

    it('returns null for empty text', () => {
        assert.strictEqual(parseCommand(''), null);
    });

    it('returns null for null/undefined', () => {
        assert.strictEqual(parseCommand(null), null);
        assert.strictEqual(parseCommand(undefined), null);
    });

    it('returns null for just the prefix', () => {
        assert.strictEqual(parseCommand('!'), null);
    });

    it('supports custom prefix', () => {
        const result = parseCommand('/help', '/');
        assert.deepStrictEqual(result, { command: 'help', args: [], raw: '/help' });
    });
});
