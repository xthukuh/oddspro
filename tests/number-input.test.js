import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NUMBER_RE, clampNumber } from '../web/src/numberInput.js';

// NUMBER_RE gates keystrokes: every partial numeric entry a user can type
// through while composing a real number must pass; junk must not.
test('NUMBER_RE accepts valid partial numeric entries', () => {
    for (const s of ['', '.', '-', '0', '20', '20.', '.5', '.05', '20.34', '-3.1']) {
        assert.equal(NUMBER_RE.test(s), true, `should accept ${JSON.stringify(s)}`);
    }
});

test('NUMBER_RE rejects non-numeric / malformed entries', () => {
    for (const s of ['abc', '1.2.3', '1e3', '1,000', '5px', '- 3', '1 ']) {
        assert.equal(NUMBER_RE.test(s), false, `should reject ${JSON.stringify(s)}`);
    }
});

// clampNumber turns a raw entry into the committed number.
test('clampNumber parses blank and bare punctuation as 0', () => {
    assert.equal(clampNumber('', {}), 0);
    assert.equal(clampNumber('.', {}), 0);
    assert.equal(clampNumber('-', {}), 0);
});

test('clampNumber clamps to [min, max]', () => {
    assert.equal(clampNumber('0', { min: 1, max: 20 }), 1);
    assert.equal(clampNumber('99', { min: 1, max: 20 }), 20);
    assert.equal(clampNumber('7', { min: 1, max: 20 }), 7);
    // blank under a min floor lands on the floor (e.g. stake can't be 0)
    assert.equal(clampNumber('', { min: 1 }), 1);
    // blank with a zero floor stays 0 (e.g. max slips: 0 = unlimited)
    assert.equal(clampNumber('', { min: 0 }), 0);
});

test('clampNumber rounds when int', () => {
    assert.equal(clampNumber('3.7', { int: true }), 4);
    assert.equal(clampNumber('3.2', { int: true, min: 1, max: 20 }), 3);
    assert.equal(clampNumber('20.9', { int: true, max: 20 }), 20);
});

test('clampNumber keeps decimals when not int', () => {
    assert.equal(clampNumber('20.34', { min: 1 }), 20.34);
    assert.equal(clampNumber('2.5', {}), 2.5);
});
