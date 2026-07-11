// User-agent bot blocklist (src/bot-rules.js). Blocks known AI scrapers /
// aggressive crawlers / raw HTTP clients while leaving real browsers and
// general search engines alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedUserAgent, BOT_UA_PATTERNS, AI_ROBOTS_TXT } from '../src/bot-rules.js';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

test('blocks known AI scrapers and crawlers', () => {
    for (const ua of [
        'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)',
        'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
        'CCBot/2.0 (https://commoncrawl.org/faq/)',
        'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
        'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
        'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    ]) {
        assert.equal(isBlockedUserAgent(ua), true, `expected blocked: ${ua}`);
    }
});

test('blocks raw HTTP clients and headless automation', () => {
    for (const ua of ['python-requests/2.31.0', 'curl/8.4.0', 'Wget/1.21', 'Go-http-client/2.0',
        'Scrapy/2.11 (+https://scrapy.org)', 'axios/1.7.2', 'HeadlessChrome/120.0', 'node-fetch/1.0']) {
        assert.equal(isBlockedUserAgent(ua), true, `expected blocked: ${ua}`);
    }
});

test('allows real browsers and general search engines', () => {
    for (const ua of [CHROME, SAFARI, GOOGLEBOT, 'Mozilla/5.0 (compatible; bingbot/2.0)']) {
        assert.equal(isBlockedUserAgent(ua), false, `expected allowed: ${ua}`);
    }
});

test('empty or missing UA is not blocked here (handled by the token gate)', () => {
    assert.equal(isBlockedUserAgent(''), false);
    assert.equal(isBlockedUserAgent(undefined), false);
    assert.equal(isBlockedUserAgent(null), false);
});

test('BOT_UA_EXTRA adds patterns; BOT_UA_ALLOW exempts them', () => {
    assert.equal(isBlockedUserAgent('MyCustomBot/1.0', { extra: ['mycustombot'] }), true);
    // allow wins even over a built-in pattern (operator override)
    assert.equal(isBlockedUserAgent('curl/8.4.0', { allow: ['curl/'] }), false);
});

test('AI_ROBOTS_TXT disallows AI crawlers and the API', () => {
    assert.match(AI_ROBOTS_TXT, /User-agent: GPTBot\nDisallow: \//);
    assert.match(AI_ROBOTS_TXT, /User-agent: \*\nDisallow: \/api\//);
    assert.ok(BOT_UA_PATTERNS.includes('gptbot'));
});
