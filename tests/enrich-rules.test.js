// M4.1 enrichment selection rules. The leakage assertion here is the
// highest-severity guard in the milestone: a grounded call on a played fixture
// google-searches the final score, and the failure is SILENT and FLATTERS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    selectEnrichable, capFixtures, KICKOFF_SQL_EXPR, CORRELATION_GUARDS, insightIsFresh,
} from '../src/db/ai-rules.js';

const NOW = new Date('2026-07-16T12:00:00Z').getTime();

test('selectEnrichable rejects every past-kickoff fixture (LEAKAGE GUARD)', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-16T11:59:00Z' }, // 1 min ago - still leakage
        { id: 2, kickoff: '2026-07-16T12:00:00Z' }, // exactly now - not future
        { id: 3, kickoff: '2026-07-16T12:01:00Z' }, // future - the only legal one
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3]);
});

test('selectEnrichable takes soonest-kickoff first', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-18T12:00:00Z' },
        { id: 2, kickoff: '2026-07-17T12:00:00Z' },
        { id: 3, kickoff: '2026-07-16T18:00:00Z' },
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3, 2, 1]);
});

test('capFixtures bounds FIXTURES, never truncating one mid-set', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepEqual(capFixtures(rows, 2).map(r => r.id), [1, 2]);
    assert.equal(capFixtures(rows, 0).length, 0);
    assert.equal(capFixtures(rows, 99).length, 3);
});

// --- Finding 1: TZ HAZARD -------------------------------------------------
// fixtures.kickoff is a naive EAT wall-clock DATETIME. mysql2 decodes a bare
// DATETIME column into a JS Date using the NODE PROCESS's local timezone
// (NOT the session's pinned +03:00, which only governs server-side SQL
// functions like NOW()). Off-EAT, `new Date(r.kickoff).getTime()` above then
// reads a DIFFERENT instant than the true kickoff - up to 3h off on a UTC
// host - and could admit an already-started fixture. `_loadTargets` closes
// this by projecting KICKOFF_SQL_EXPR (an explicit-offset STRING) instead of
// a bare column. Production input never looks like the 'Z'-suffixed strings
// above; it looks like what this expression produces.

test('KICKOFF_SQL_EXPR bakes an absolute +03:00 offset into the projected kickoff (TZ HAZARD GUARD)', () => {
    // Pins the exact SQL projection _loadTargets now uses so nobody can
    // "simplify" it back to a bare `f.kickoff` select without this test
    // catching the regression.
    assert.equal(KICKOFF_SQL_EXPR, "DATE_FORMAT(f.kickoff, '%Y-%m-%dT%H:%i:%s+03:00')");

    // Real fixture: kicks off 15:00 EAT == 12:00 UTC on 2026-07-16.
    const trueKickoffUtcMs = Date.UTC(2026, 6, 16, 12, 0, 0);
    const now = trueKickoffUtcMs + 60_000; // 1 minute after kickoff - already started

    // What _loadTargets now actually hands selectEnrichable: the
    // offset-qualified string parses to the TRUE instant on ANY host, so the
    // already-started fixture is correctly excluded.
    const offsetQualified = '2026-07-16T15:00:00+03:00';
    assert.equal(new Date(offsetQualified).getTime(), trueKickoffUtcMs);
    assert.deepEqual(
        selectEnrichable([{ id: 1, kickoff: offsetQualified }], now).map(r => r.id),
        [],
    );
});

test('a naive (no-zone) kickoff is TZ-ambiguous and can admit an already-started fixture (TZ HAZARD REPRO)', () => {
    // This is the hazard the fix above closes, reproduced deterministically
    // (independent of whatever timezone this test suite happens to run in)
    // via the concrete example the finding names: a UTC host. mysql2 on a
    // UTC host decodes the naive EAT wall-clock string '2026-07-16 15:00:00'
    // (no zone) by reading its digits as UTC - exactly what Date.UTC(2026,
    // 6, 16, 15, 0, 0) represents. We build that Date directly rather than
    // relying on `new Date('2026-07-16 15:00:00')`, whose parse is THIS
    // process's own local timezone, not a UTC host's - the point is to pin
    // the UTC-host failure mode itself, not whatever this machine happens
    // to be set to.
    const naive = '2026-07-16 15:00:00'; // production-shaped: no zone
    const trueKickoffUtcMs = Date.UTC(2026, 6, 16, 12, 0, 0); // true instant: 15:00 EAT
    const utcHostDecodeMs = Date.UTC(2026, 6, 16, 15, 0, 0); // naive's digits misread as UTC
    assert.notEqual(utcHostDecodeMs, trueKickoffUtcMs, `sanity: ${naive} must misdecode on a UTC host`);

    const now = trueKickoffUtcMs + 60_000; // 1 minute after the TRUE kickoff
    // WRONGLY admitted: selectEnrichable trusts its input, and a naive/
    // skewed kickoff is exactly what used to make it past the leakage guard
    // up to 3h after a real kickoff - the invariant this milestone protects.
    assert.deepEqual(
        selectEnrichable([{ id: 1, kickoff: new Date(utcHostDecodeMs) }], now).map(r => r.id),
        [1],
    );
});

// --- Finding 3: correlation guards (cap-slot waste) -----------------------

test('CORRELATION_GUARDS mirrors hotpicks.js EXISTS guards verbatim (CAP-WASTE GUARD)', () => {
    assert.deepEqual(CORRELATION_GUARDS, [
        'EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)',
        'EXISTS (SELECT 1 FROM fixture_prematch p WHERE p.fixture_id = f.id)',
    ]);
});

// --- Finding 2: tip-identity reuse gate ------------------------------------
// bestTip re-updates on every hotpicks run, so a stale anchored row (same
// model_tag, DIFFERENT tip) must be treated as NOT fresh, or the stored
// payload silently measures anchoring against a tip the model never saw.

test('insightIsFresh: blind is governed by model_tag alone (tip is irrelevant)', () => {
    const stored = { model_tag: 'gpt-4o#e1', tip: null };
    assert.equal(insightIsFresh('blind', 'gpt-4o#e1', stored, { market: '1X', price: '1.85' }), true);
    assert.equal(insightIsFresh('blind', 'gpt-4o#e1', stored, null), true);
    assert.equal(insightIsFresh('blind', 'other-model#e1', stored, null), false);
});

test('insightIsFresh: anchored requires model_tag AND matching tip identity', () => {
    const stored = { model_tag: 'gemini-2.5-flash#e1', tip: { market: '1X', price: '1.85' } };
    // Same tip, same tag -> fresh.
    assert.equal(insightIsFresh('anchored', 'gemini-2.5-flash#e1', stored, { market: '1X', price: '1.85' }), true);
    // Changed market, same tag -> a genuinely different tip was made, must re-fire.
    assert.equal(insightIsFresh('anchored', 'gemini-2.5-flash#e1', stored, { market: 'X2', price: '1.85' }), false);
    // Changed price, same market/tag -> re-fires (bestTip moved on odds shift).
    assert.equal(insightIsFresh('anchored', 'gemini-2.5-flash#e1', stored, { market: '1X', price: '1.95' }), false);
    // Changed model_tag -> re-fires regardless of tip.
    assert.equal(insightIsFresh('anchored', 'gemini-2.5-pro#e1', stored, { market: '1X', price: '1.85' }), false);
});

test('insightIsFresh: price identity compares numerically (DECIMAL column returns as a string)', () => {
    const stored = { model_tag: 'm#e1', tip: { market: '1X', price: '1.85' } };
    assert.equal(insightIsFresh('anchored', 'm#e1', stored, { market: '1X', price: 1.85 }), true);
    assert.equal(insightIsFresh('anchored', 'm#e1', stored, { market: '1X', price: '1.850' }), true);
});

test('insightIsFresh: a legacy anchored row with no recorded tip is treated as stale, not trusted', () => {
    // Pre-fix rows never persisted `tip` inside the payload at all.
    const stored = { model_tag: 'm#e1', tip: null };
    assert.equal(insightIsFresh('anchored', 'm#e1', stored, { market: '1X', price: '1.85' }), false);
});

test('insightIsFresh: no stored row at all is never fresh', () => {
    assert.equal(insightIsFresh('blind', 'm#e1', undefined, null), false);
    assert.equal(insightIsFresh('anchored', 'm#e1', undefined, { market: '1X', price: '1.85' }), false);
});
