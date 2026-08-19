// /fixtures parsing + row-shaping (src/apisports-fixtures.js): per-item
// isolation so one malformed fixture in a batch can't discard every other
// well-formed item - the same failure class as the 2026-08-16 production
// outage (one throw cascaded into three days of lost data). Mirrors
// tests/apisports-standings.test.js / tests/apisports-events.test.js. Pure
// module - no .env / DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureItem, _isoToDatetime, _fixtureRows, buildFixtureItemRows } from '../src/apisports-fixtures.js';

// A well-formed /fixtures response item
const item = (over = {}) => ({
    fixture: {
        id: 1556592,
        date: '2026-07-02T15:00:00+03:00',
        referee: 'M. Oliver',
        venue: { name: 'Old Trafford' },
        status: { short: 'FT', elapsed: 90 },
    },
    league: {
        id: 39,
        name: 'Premier League',
        type: 'League',
        country: 'England',
        logo: 'https://x/39.png',
        season: 2026,
        round: 'Regular Season - 1',
    },
    teams: {
        home: { id: 33, name: 'Manchester United', logo: 'https://x/33.png' },
        away: { id: 34, name: 'Newcastle', logo: 'https://x/34.png' },
    },
    goals: { home: 2, away: 1 },
    score: {
        halftime: { home: 1, away: 0 },
        fulltime: { home: 2, away: 1 },
        extratime: { home: null, away: null },
        penalty: { home: null, away: null },
    },
    ...over,
});

test('_isoToDatetime converts requested-TZ ISO to wall-clock datetime', () => {
    assert.equal(_isoToDatetime('2026-07-02T15:00:00+03:00'), '2026-07-02 15:00:00');
});

test('FixtureItem parses a well-formed item', () => {
    const parsed = FixtureItem.parse(item());
    assert.equal(parsed.fixture.id, 1556592);
    assert.equal(parsed.league.id, 39);
});

test('_fixtureRows maps a validated item to league/teams/fixture rows', () => {
    const parsed = FixtureItem.parse(item());
    const { league, teams, fixture } = _fixtureRows(parsed);
    assert.deepEqual(league, { id: 39, name: 'Premier League', type: 'League', country: 'England', logo: 'https://x/39.png' });
    assert.deepEqual(teams, [
        { id: 33, name: 'Manchester United', logo: 'https://x/33.png' },
        { id: 34, name: 'Newcastle', logo: 'https://x/34.png' },
    ]);
    assert.equal(fixture.id, 1556592);
    assert.equal(fixture.kickoff, '2026-07-02 15:00:00');
    assert.equal(fixture.status, 'FT');
    assert.equal(fixture.goals_home, 2);
    assert.equal(fixture.ht_home, 1);
    assert.equal(fixture.venue, 'Old Trafford');
});

test('buildFixtureItemRows parses a clean batch fully', () => {
    const { leagues, teams, fixtures, skipped } = buildFixtureItemRows([
        item(),
        item({ fixture: { ...item().fixture, id: 1556593 }, teams: { home: { id: 50, name: 'Arsenal' }, away: { id: 51, name: 'Chelsea' } } }),
    ]);
    assert.equal(fixtures.length, 2);
    assert.equal(skipped.length, 0);
    assert.equal(leagues.size, 1); // both fixtures share league id 39
    assert.equal(teams.size, 4); // 33,34,50,51
});

test('buildFixtureItemRows keeps every good item and reports the bad one when one item is malformed', () => {
    const bad = item({ fixture: { ...item().fixture, id: undefined } }); // id required
    const { fixtures, skipped } = buildFixtureItemRows([item(), bad, item({ fixture: { ...item().fixture, id: 999 } })]);
    assert.equal(fixtures.length, 2);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].raw, bad);
    assert.ok(skipped[0].error);
});

test('buildFixtureItemRows never throws on an all-malformed batch, returns empty collections', () => {
    const bad1 = item({ fixture: { ...item().fixture, id: undefined } });
    const bad2 = { not: 'a fixture item at all' };
    const { leagues, teams, fixtures, skipped } = buildFixtureItemRows([bad1, bad2]);
    assert.equal(fixtures.length, 0);
    assert.equal(leagues.size, 0);
    assert.equal(teams.size, 0);
    assert.equal(skipped.length, 2);
});

test('buildFixtureItemRows dedups leagues and teams by id', () => {
    const a = item();
    const b = item({ fixture: { ...item().fixture, id: 2 } }); // same league + teams
    const { leagues, teams, fixtures } = buildFixtureItemRows([a, b]);
    assert.equal(fixtures.length, 2);
    assert.equal(leagues.size, 1);
    assert.equal(teams.size, 2);
    assert.equal(leagues.get(39).name, 'Premier League');
});
