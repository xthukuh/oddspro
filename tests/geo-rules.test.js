import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, classifyIp, parseGeoResult, planGeoBatch } from '../src/db/geo-rules.js';

test('isPrivateIp flags loopback / private / reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '172.31.1.1',
        '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '', null, undefined]) {
        assert.equal(isPrivateIp(ip), true, `expected ${ip} private`);
    }
});

test('isPrivateIp treats routable addresses as public', () => {
    for (const ip of ['203.0.113.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2001:db8::1']) {
        assert.equal(isPrivateIp(ip), false, `expected ${ip} public`);
    }
    assert.equal(classifyIp('8.8.8.8'), 'public');
    assert.equal(classifyIp('10.0.0.1'), 'private');
});

test('parseGeoResult maps a successful lookup', () => {
    const out = parseGeoResult({ status: 'success', country: 'Kenya', regionName: 'Nairobi County', query: '203.0.113.9' });
    assert.deepEqual(out, { status: 'resolved', country: 'Kenya', region: 'Nairobi County' });
});

test('parseGeoResult marks failures + junk as unresolvable', () => {
    assert.equal(parseGeoResult({ status: 'fail', message: 'reserved range' }).status, 'unresolvable');
    assert.equal(parseGeoResult(null).status, 'unresolvable');
    assert.equal(parseGeoResult({}).status, 'unresolvable');
});

test('parseGeoResult tolerates a success with blank names', () => {
    const out = parseGeoResult({ status: 'success' });
    assert.equal(out.status, 'resolved');
    assert.equal(out.country, null);
    assert.equal(out.region, null);
});

test('planGeoBatch splits public/private, dedupes and caps the public batch', () => {
    const { publicIps, privateIps } = planGeoBatch(
        ['8.8.8.8', '8.8.8.8', '127.0.0.1', '203.0.113.9', '10.0.0.1', '', null], 100,
    );
    assert.deepEqual(publicIps, ['8.8.8.8', '203.0.113.9']); // deduped, blanks dropped
    assert.deepEqual(privateIps, ['127.0.0.1', '10.0.0.1']);
});

test('planGeoBatch caps public IPs at max (private ones are uncapped)', () => {
    const many = Array.from({ length: 250 }, (_, i) => `203.0.${Math.floor(i / 256)}.${i % 256}`);
    const { publicIps } = planGeoBatch([...many, '192.168.1.1'], 100);
    assert.equal(publicIps.length, 100);
});
