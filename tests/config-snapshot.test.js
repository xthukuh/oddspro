import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildEnvelope,
    parseEnvelope,
    migrateEnvelope,
    SNAPSHOT_FORMAT,
    SNAPSHOT_VERSION,
} from '../web/src/configSnapshot.js';

// The .oddspro portability standard: a versioned envelope whose parse path stays
// backwards-compatible. Only the PURE core is covered here (the gzip/localStorage
// IO needs a browser).

test('buildEnvelope wraps data in the current format + version', () => {
    const env = buildEnvelope({ 'oddspro.theme': 'dark' }, '1.0.2');
    assert.equal(env.format, SNAPSHOT_FORMAT);
    assert.equal(env.version, SNAPSHOT_VERSION);
    assert.equal(env.app, '1.0.2');
    assert.deepEqual(env.data, { 'oddspro.theme': 'dark' });
    assert.equal(typeof env.savedAt, 'string');
});

test('buildEnvelope copies the data (no shared reference)', () => {
    const src = { 'oddspro.a': '1' };
    const env = buildEnvelope(src);
    env.data['oddspro.b'] = '2';
    assert.deepEqual(src, { 'oddspro.a': '1' }); // source untouched
    assert.equal(env.app, null);
});

test('parseEnvelope round-trips a valid snapshot', () => {
    const env = buildEnvelope({ 'oddspro.sort': '[]' }, '1.0.2');
    const out = parseEnvelope(JSON.parse(JSON.stringify(env)));
    assert.deepEqual(out.data, { 'oddspro.sort': '[]' });
    assert.equal(out.version, SNAPSHOT_VERSION);
    assert.equal(out.app, '1.0.2');
});

test('parseEnvelope tolerates a missing app/savedAt', () => {
    const out = parseEnvelope({ format: SNAPSHOT_FORMAT, version: 1, data: { 'oddspro.x': '1' } });
    assert.equal(out.app, null);
    assert.equal(out.savedAt, null);
    assert.deepEqual(out.data, { 'oddspro.x': '1' });
});

test('parseEnvelope rejects a non-object / wrong format', () => {
    assert.throws(() => parseEnvelope(null), /valid Odds Pro config/);
    assert.throws(() => parseEnvelope([]), /valid Odds Pro config/);
    assert.throws(() => parseEnvelope({ format: 'something-else', version: 1, data: {} }), /Unrecognized file/);
});

test('parseEnvelope rejects a bad or future version', () => {
    assert.throws(() => parseEnvelope({ format: SNAPSHOT_FORMAT, version: 0, data: {} }), /invalid version/);
    assert.throws(() => parseEnvelope({ format: SNAPSHOT_FORMAT, version: 1.5, data: {} }), /invalid version/);
    assert.throws(
        () => parseEnvelope({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION + 1, data: {} }),
        /newer app/,
    );
});

test('parseEnvelope rejects a missing/invalid data payload', () => {
    assert.throws(() => parseEnvelope({ format: SNAPSHOT_FORMAT, version: 1 }), /no settings payload/);
    assert.throws(() => parseEnvelope({ format: SNAPSHOT_FORMAT, version: 1, data: [] }), /no settings payload/);
});

test('migrateEnvelope is identity for the current version', () => {
    const env = buildEnvelope({ 'oddspro.a': '1' });
    assert.deepEqual(migrateEnvelope(env), env);
});
