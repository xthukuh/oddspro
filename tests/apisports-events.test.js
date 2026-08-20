// /fixtures/events parsing + row-shaping (src/apisports-events.js): schema
// tolerance for the observed `type: null` payload that once aborted the whole
// deep-stats sweep, plus the typeless-event skip and field mapping. Pure module
// - no .env / DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { EventItem, buildEventRows } from '../src/apisports-events.js';

// A well-formed goal event
const goal = {
    time: { elapsed: 23, extra: null },
    team: { id: 33 },
    player: { id: 874, name: 'Cristiano Ronaldo' },
    assist: { id: 762, name: 'B. Fernandes' },
    type: 'Goal',
    detail: 'Normal Goal',
    comments: null,
};

test('EventItem tolerates type: null (the payload that aborted the sweep)', () => {
    // Regression: this exact shape previously threw "expected string, received null".
    const parsed = EventItem.parse({ time: { elapsed: 90 }, type: null });
    assert.equal(parsed.type, null);
});

test('buildEventRows drops typeless events, keeps valid ones', () => {
    const { rows } = buildEventRows([
        goal,
        { time: { elapsed: 90 }, type: null },      // typeless -> skipped
        { time: { elapsed: 5 }, type: undefined },  // missing type -> skipped
        { time: { elapsed: 5 }, type: '' },         // empty type -> skipped
    ], 123456);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'Goal');
});

test('buildEventRows maps every column, coalescing absent nested fields to null', () => {
    const { rows: [row] } = buildEventRows([goal], 987);
    assert.deepEqual(row, {
        fixture_id: 987,
        team_id: 33,
        elapsed: 23,
        extra: null,
        type: 'Goal',
        detail: 'Normal Goal',
        comments: null,
        player_id: 874,
        player_name: 'Cristiano Ronaldo',
        assist_id: 762,
        assist_name: 'B. Fernandes',
    });
});

test('buildEventRows tolerates absent team/player/assist objects', () => {
    const { rows: [row] } = buildEventRows([{ time: { elapsed: 45, extra: 2 }, type: 'Card', detail: 'Yellow Card' }], 1);
    assert.equal(row.team_id, null);
    assert.equal(row.player_id, null);
    assert.equal(row.player_name, null);
    assert.equal(row.assist_id, null);
    assert.equal(row.extra, 2);
});

test('buildEventRows skips (not throws) an item zod cannot parse, keeping good events - one bad event must never abort the fixture', () => {
    // elapsed is required (fixture_events needs the minute) - a missing/NaN time
    // previously surfaced as a ZodError that discarded every OTHER event for the
    // same fixture. It must now be isolated per item, mirroring buildStandingRows.
    const { rows, skipped } = buildEventRows([
        goal,
        { time: {}, type: 'Goal' }, // elapsed missing -> unparseable, skipped
    ], 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'Goal');
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0].error instanceof z.ZodError);
});

test('buildEventRows returns empty (not throws) when every item is unparseable', () => {
    const { rows, skipped } = buildEventRows([
        { time: {}, type: 'Goal' },
        { time: { elapsed: 'ninety' }, type: 'Card' },
    ], 1);
    assert.deepEqual(rows, []);
    assert.equal(skipped.length, 2);
});
