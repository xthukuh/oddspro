import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_ODDS_TIERS,
    parseOddsTiers,
    oddsRefreshDue,
    lightPassIdle,
} from '../src/db/odds-refresh-rules.js';

// Pure module - no .env/DB/axios. Kickoff-proximity decaying backoff for the
// per-game odds detail fetches + the idle-aware light pass. Clock injected
// as epoch ms throughout (auto-rules convention).

const MIN = 60_000;
const utc = iso => new Date(iso).getTime();

// --- parseOddsTiers -----------------------------------------------------------

test('parseOddsTiers: default CSV parses into ascending tiers with a catch-all', () => {
    const tiers = parseOddsTiers(DEFAULT_ODDS_TIERS);
    assert.deepEqual(tiers, [
        { upToMin: 90, maxAgeMin: 0 },
        { upToMin: 360, maxAgeMin: 30 },
        { upToMin: 1440, maxAgeMin: 120 },
        { upToMin: Infinity, maxAgeMin: 360 },
    ]);
});

test('parseOddsTiers: off/blank/invalid disable the backoff entirely (null = never skip)', () => {
    assert.equal(parseOddsTiers('off'), null);
    assert.equal(parseOddsTiers(''), null);
    assert.equal(parseOddsTiers(null), null);
    assert.equal(parseOddsTiers('junk'), null);
    assert.equal(parseOddsTiers('90:0,bad'), null, 'one bad entry poisons the whole config - fail-safe');
    assert.equal(parseOddsTiers('90:-5'), null, 'negative age is invalid');
    assert.equal(parseOddsTiers('360:30,90:0'), null, 'boundaries must ascend');
    assert.equal(parseOddsTiers('*:60,90:0'), null, 'catch-all must come last');
});

test('parseOddsTiers: catch-all is optional (beyond the last boundary = always refresh)', () => {
    assert.deepEqual(parseOddsTiers('90:0,360:30'), [
        { upToMin: 90, maxAgeMin: 0 },
        { upToMin: 360, maxAgeMin: 30 },
    ]);
});

// --- oddsRefreshDue -------------------------------------------------------------

const TIERS = parseOddsTiers(DEFAULT_ODDS_TIERS);
const now = utc('2026-07-17T12:00:00Z');

test('oddsRefreshDue: near kickoff (<=90 min) is ALWAYS due - the is_stale currency guarantee', () => {
    const kickoff = now + 60 * MIN;
    assert.equal(oddsRefreshDue(now, kickoff, now - 1 * MIN, TIERS), true, 'even refreshed 1 min ago');
});

test('oddsRefreshDue: mid tiers skip while the last refresh is younger than the tier age', () => {
    const kickoff4h = now + 240 * MIN; // tier <=360: max age 30
    assert.equal(oddsRefreshDue(now, kickoff4h, now - 29 * MIN, TIERS), false);
    assert.equal(oddsRefreshDue(now, kickoff4h, now - 30 * MIN, TIERS), true);
    const kickoff20h = now + 1200 * MIN; // tier <=1440: max age 120
    assert.equal(oddsRefreshDue(now, kickoff20h, now - 119 * MIN, TIERS), false);
    assert.equal(oddsRefreshDue(now, kickoff20h, now - 121 * MIN, TIERS), true);
});

test('oddsRefreshDue: far-future games fall to the catch-all tier', () => {
    const kickoff3d = now + 3 * 1440 * MIN; // catch-all: max age 360
    assert.equal(oddsRefreshDue(now, kickoff3d, now - 359 * MIN, TIERS), false);
    assert.equal(oddsRefreshDue(now, kickoff3d, now - 361 * MIN, TIERS), true);
});

test('oddsRefreshDue: without a catch-all, beyond the last boundary is always due', () => {
    const tiers = parseOddsTiers('90:0,360:30');
    assert.equal(oddsRefreshDue(now, now + 1200 * MIN, now - 1 * MIN, tiers), true);
});

test('oddsRefreshDue: fail-open - disabled tiers, missing stamps, junk and past kickoffs are all due', () => {
    const kickoff = now + 240 * MIN;
    assert.equal(oddsRefreshDue(now, kickoff, now - 1 * MIN, null), true, 'backoff disabled');
    assert.equal(oddsRefreshDue(now, kickoff, null, TIERS), true, 'never refreshed');
    assert.equal(oddsRefreshDue(now, NaN, now - 1 * MIN, TIERS), true, 'junk kickoff');
    assert.equal(oddsRefreshDue(now, now - 10 * MIN, now - 1 * MIN, TIERS), true, 'already kicked off');
});

// --- lightPassIdle ---------------------------------------------------------------

const m = (startOffsetMin, completed = false) => ({ startMs: now + startOffsetMin * MIN, completed });
const OPTS = { lookaheadMin: 120, inplayWindowMin: 240, idleEveryMin: 60, lastOddsPassMs: now - 15 * MIN };

test('lightPassIdle: an in-play match (started, not completed, within the window) forces a run', () => {
    const out = lightPassIdle(now, [m(-30)], OPTS);
    assert.equal(out.skip, false);
    assert.equal(out.reason, 'in-play');
});

test('lightPassIdle: a kickoff inside the lookahead forces a run', () => {
    const out = lightPassIdle(now, [m(90)], OPTS);
    assert.equal(out.skip, false);
    assert.equal(out.reason, 'kickoff-near');
});

test('lightPassIdle: free period skips - nothing in-play, next kickoff beyond the lookahead', () => {
    const out = lightPassIdle(now, [m(-300), m(-200, true), m(180)], OPTS);
    assert.equal(out.skip, true, 'old started game beyond the in-play window does not pin the pass');
    assert.equal(out.reason, 'idle');
});

test('lightPassIdle: idle periods still run every idleEveryMin (bounded discovery of new games)', () => {
    const out = lightPassIdle(now, [m(180)], { ...OPTS, lastOddsPassMs: now - 61 * MIN });
    assert.equal(out.skip, false);
    assert.equal(out.reason, 'idle-run-due');
    const noStamp = lightPassIdle(now, [m(180)], { ...OPTS, lastOddsPassMs: null });
    assert.equal(noStamp.skip, false, 'no last-pass stamp = run (fail-open)');
});

test('lightPassIdle: no known matches today = run (list discovery must not starve)', () => {
    const out = lightPassIdle(now, [], OPTS);
    assert.equal(out.skip, false);
    assert.equal(out.reason, 'no-known-matches');
});

test('lightPassIdle: lookahead 0 disables the idle feature entirely', () => {
    const out = lightPassIdle(now, [m(600)], { ...OPTS, lookaheadMin: 0 });
    assert.equal(out.skip, false);
    assert.equal(out.reason, 'disabled');
});
