import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { HALT_FILE, haltRequested } from '../src/halt.js';

// External kill-switch (.HALT in the app root): cPanel's Stop action
// sometimes fails, so the file's mere existence must stop the serve process.
// The exists check is injectable so these tests never touch the real fs.

test('HALT_FILE anchors to the process working directory (the app root under Passenger and npm scripts)', () => {
    assert.equal(HALT_FILE, resolve(process.cwd(), '.HALT'));
});

test('haltRequested reflects the injected existence check', () => {
    const seen = [];
    assert.equal(haltRequested(p => { seen.push(p); return true; }), true);
    assert.equal(haltRequested(() => false), false);
    assert.deepEqual(seen, [HALT_FILE], 'checks exactly the app-root .HALT path');
});

test('haltRequested fails open (no halt) when the existence check itself throws', () => {
    assert.equal(haltRequested(() => { throw new Error('EACCES'); }), false,
        'a broken fs probe must not take the server down');
});
