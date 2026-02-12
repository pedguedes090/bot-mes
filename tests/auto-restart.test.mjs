import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('auto-restart spawn', () => {
    it('spawns a new process that outlives the parent', () => {
        // Create a tiny script that mimics the restart logic:
        // It spawns a child that writes a marker file, proving the child ran.
        const tmp = mkdtempSync(join(tmpdir(), 'bot-restart-'));
        const marker = join(tmp, 'restarted.txt');
        const child = join(tmp, 'child.mjs');
        const parent = join(tmp, 'parent.mjs');

        writeFileSync(child, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ok');
`);

        writeFileSync(parent, `
import { spawn } from 'node:child_process';
const c = spawn(process.execPath, [${JSON.stringify(child)}], {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: true,
});
c.unref();
process.exit(0);
`);

        // Run the parent, which should spawn the child and exit
        execFileSync(process.execPath, [parent], { timeout: 5000 });

        // Give child a moment to finish writing
        const start = Date.now();
        let found = false;
        while (Date.now() - start < 3000) {
            try {
                const content = readFileSync(marker, 'utf-8');
                if (content === 'ok') { found = true; break; }
            } catch { /* not yet */ }
        }

        assert.ok(found, 'Child process should have written the marker file after parent exited');

        // Cleanup
        try { unlinkSync(marker); } catch {}
        try { unlinkSync(child); } catch {}
        try { unlinkSync(parent); } catch {}
    });
});
