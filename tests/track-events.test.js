import test from 'node:test';
import assert from 'node:assert/strict';
import { EV, onOff } from '../web/src/trackEvents.js';
import { EVENT_NAME_RE, sanitizeEvents } from '../src/db/track-rules.js';

// M3 contract: the client event vocabulary must pass the server's closed name
// grammar - a constant that fails EVENT_NAME_RE would be silently dropped by
// sanitizeEvents, so the mismatch has to fail HERE, offline.

test('every feature-event constant matches EVENT_NAME_RE', () => {
    const names = Object.values(EV);
    assert.ok(names.length >= 14, `expected the full vocabulary, got ${names.length}`);
    for (const name of names) {
        assert.match(name, EVENT_NAME_RE, `event name rejected by grammar: ${name}`);
    }
});

test('event names are unique', () => {
    const names = Object.values(EV);
    assert.equal(new Set(names).size, names.length);
});

test('sanitizeEvents accepts the whole vocabulary verbatim', () => {
    const batch = Object.values(EV).map(name => ({ name, value: 'x' }));
    const out = sanitizeEvents(batch);
    assert.deepEqual(out.map(e => e.name), Object.values(EV));
});

test('onOff folds truthiness to the on|off value shape', () => {
    assert.equal(onOff(true), 'on');
    assert.equal(onOff(false), 'off');
    assert.equal(onOff(1), 'on');
    assert.equal(onOff(undefined), 'off');
});
