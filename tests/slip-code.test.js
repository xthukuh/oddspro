import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, generateSlipCode, normalizeSlipCode } from '../src/slip-code.js';

test('codes are 6 chars from the Crockford alphabet, random', () => {
    const a = generateSlipCode(), b = generateSlipCode();
    for (const c of [a, b]) {
        assert.equal(c.length, 6);
        for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
    }
    assert.notEqual(a, b);   // 1 in 1e9 flake tolerated
});

test('normalization: case, ambiguous glyphs, separators; junk rejected', () => {
    assert.equal(normalizeSlipCode('ab-c1 23'.replace('1', 'l')), 'ABC123');
    assert.equal(normalizeSlipCode('oI2345'), '012345');
    assert.equal(normalizeSlipCode('ABC12'), null);       // too short
    assert.equal(normalizeSlipCode('ABC12U'), null);      // U not in alphabet
    assert.equal(normalizeSlipCode(null), null);
});
