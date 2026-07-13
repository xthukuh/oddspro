import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseUserAgent,
    classifyDevice,
    classifyBrowser,
    classifyOs,
    normalizeIp,
    pickIp,
    shouldLogVisit,
    buildVisitRow,
} from '../src/db/visit-rules.js';

const UA = {
    chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1',
    androidPhone: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
    googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};

test('classifyDevice covers desktop / mobile / tablet / bot', () => {
    assert.equal(classifyDevice(UA.chromeWin), 'desktop');
    assert.equal(classifyDevice(UA.iphone), 'mobile');
    assert.equal(classifyDevice(UA.androidPhone), 'mobile');
    assert.equal(classifyDevice(UA.ipad), 'tablet');
    assert.equal(classifyDevice(UA.androidTablet), 'tablet'); // Android without "Mobile"
    assert.equal(classifyDevice(UA.googlebot), 'bot');
    assert.equal(classifyDevice(''), 'unknown');
});

test('classifyBrowser disambiguates Chrome-family UAs', () => {
    assert.equal(classifyBrowser(UA.chromeWin), 'Chrome');
    assert.equal(classifyBrowser(UA.edge), 'Edge');       // Edg/ before Chrome
    assert.equal(classifyBrowser(UA.firefoxLinux), 'Firefox');
    assert.equal(classifyBrowser(UA.macSafari), 'Safari'); // Safari without Chrome
    assert.equal(classifyBrowser(UA.iphone), 'Safari');
});

test('classifyOs picks Android over Linux and detects iOS/macOS/Windows', () => {
    assert.equal(classifyOs(UA.chromeWin), 'Windows');
    assert.equal(classifyOs(UA.androidPhone), 'Android'); // not Linux
    assert.equal(classifyOs(UA.iphone), 'iOS');
    assert.equal(classifyOs(UA.ipad), 'iOS');
    assert.equal(classifyOs(UA.macSafari), 'macOS');
    assert.equal(classifyOs(UA.firefoxLinux), 'Linux');
});

test('parseUserAgent bundles the three', () => {
    assert.deepEqual(parseUserAgent(UA.edge), { deviceType: 'desktop', browser: 'Edge', os: 'Windows' });
});

test('normalizeIp strips IPv6-mapped IPv4 and ports', () => {
    assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(normalizeIp('203.0.113.9:54211'), '203.0.113.9');
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(normalizeIp(''), null);
    assert.equal(normalizeIp(null), null);
});

test('pickIp prefers the first X-Forwarded-For hop, else the socket ip', () => {
    assert.equal(pickIp('203.0.113.9, 10.0.0.1', '10.0.0.1'), '203.0.113.9');
    assert.equal(pickIp('  198.51.100.7  ', '10.0.0.1'), '198.51.100.7');
    assert.equal(pickIp('', '::ffff:192.0.2.5'), '192.0.2.5');
    assert.equal(pickIp(undefined, null), null);
});

test('shouldLogVisit accepts HTML navigations only', () => {
    const html = 'text/html,application/xhtml+xml';
    assert.equal(shouldLogVisit({ method: 'GET', path: '/', accept: html }), true);
    assert.equal(shouldLogVisit({ method: 'GET', path: '/2026-07-13', accept: html }), true);
    assert.equal(shouldLogVisit({ method: 'GET', path: '/assets/index-abc.js', accept: html }), false); // asset
    assert.equal(shouldLogVisit({ method: 'GET', path: '/api/records', accept: html }), false);
    assert.equal(shouldLogVisit({ method: 'GET', path: '/admin', accept: html }), false);
    assert.equal(shouldLogVisit({ method: 'GET', path: '/robots.txt', accept: html }), false);
    assert.equal(shouldLogVisit({ method: 'POST', path: '/', accept: html }), false);
    assert.equal(shouldLogVisit({ method: 'GET', path: '/', accept: 'application/json' }), false); // XHR
});

test('buildVisitRow parses UA, trims fields and omits geo', () => {
    const now = new Date('2026-07-13T09:00:00Z');
    const row = buildVisitRow({ ip: '203.0.113.9', ua: UA.iphone, referer: 'https://t.co/x', path: '/', now });
    assert.equal(row.device_type, 'mobile');
    assert.equal(row.browser, 'Safari');
    assert.equal(row.os, 'iOS');
    assert.equal(row.ip, '203.0.113.9');
    assert.equal(row.referer, 'https://t.co/x');
    assert.equal(row.path, '/');
    assert.equal(row.visited_at, now);
    assert.equal('country' in row, false); // geo resolved later
});

test('buildVisitRow trims overlong strings and nulls empties', () => {
    const row = buildVisitRow({ ip: '', ua: 'x'.repeat(600), referer: null, path: '/' });
    assert.equal(row.ip, null);
    assert.equal(row.user_agent.length, 512);
    assert.equal(row.referer, null);
});
