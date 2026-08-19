import { z } from 'zod';

// One API-Football /fixtures response item + its row-shaping. Pure (zod-only,
// no config/db) so the parse + aggregation contract is offline-testable,
// mirroring src/apisports-events.js and src/apisports-standings.js.

// Consumed fields of a /fixtures response item
export const FixtureItem = z.object({
    fixture: z.object({
        id: z.number(),
        date: z.string(), // ISO with TZ offset (requested timezone)
        referee: z.string().nullable().optional(),
        venue: z.object({ name: z.string().nullable().optional() }).partial().nullable().optional(),
        status: z.object({ short: z.string(), elapsed: z.number().nullable().optional() }),
    }),
    league: z.object({
        id: z.number(),
        name: z.string(),
        type: z.string().optional(),
        country: z.string().optional(),
        logo: z.string().nullable().optional(),
        season: z.number(),
        round: z.string().nullable().optional(),
    }),
    teams: z.object({
        home: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
        away: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
    }),
    goals: z.object({
        home: z.number().nullable(),
        away: z.number().nullable(),
    }),
    score: z.object({
        halftime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
        fulltime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
        extratime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
        penalty: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
    }),
});

// "2026-07-02T15:00:00+03:00" -> "2026-07-02 15:00:00" (requested-TZ wall time)
export function _isoToDatetime(iso) {
    return String(iso).substring(0, 19).replace('T', ' ');
}

// Map a validated fixture item to upsert rows
export function _fixtureRows(item) {
    const f = item.fixture, l = item.league, t = item.teams;
    return {
        league: { id: l.id, name: l.name, type: l.type ?? null, country: l.country ?? null, logo: l.logo ?? null },
        teams: [
            { id: t.home.id, name: t.home.name, logo: t.home.logo ?? null },
            { id: t.away.id, name: t.away.name, logo: t.away.logo ?? null },
        ],
        fixture: {
            id: f.id,
            league_id: l.id,
            season: l.season,
            round: l.round ?? null,
            kickoff: _isoToDatetime(f.date),
            home_team_id: t.home.id,
            away_team_id: t.away.id,
            status: f.status.short,
            elapsed: f.status.elapsed ?? null,
            goals_home: item.goals.home,
            goals_away: item.goals.away,
            ht_home: item.score.halftime.home,
            ht_away: item.score.halftime.away,
            ft_home: item.score.fulltime.home,
            ft_away: item.score.fulltime.away,
            et_home: item.score.extratime.home,
            et_away: item.score.extratime.away,
            pen_home: item.score.penalty.home,
            pen_away: item.score.penalty.away,
            venue: f.venue?.name ?? null,
            referee: f.referee ?? null,
            metadata: JSON.stringify(item),
        },
    };
}

// Validate + aggregate a batch of raw /fixtures response items into
// upsert-ready rows (leagues/teams deduped by id, fixtures as a flat array).
// A raw item that fails FixtureItem.parse is skipped and reported in
// `skipped`, never thrown - one malformed fixture must not discard every
// other well-formed one in the same batch (the apisports-standings lesson;
// this is the same failure class as the 2026-08-16 production outage, where
// one throw cascaded into three days of lost data).
export function buildFixtureItemRows(items) {
    const leagues = new Map(), teams = new Map(), fixtures = [], skipped = [];
    for (const raw of items) {
        let item;
        try {
            item = FixtureItem.parse(raw);
        } catch (error) {
            skipped.push({ raw, error });
            continue;
        }
        const { league, teams: tt, fixture } = _fixtureRows(item);
        leagues.set(league.id, league);
        for (const t of tt) teams.set(t.id, t);
        fixtures.push(fixture);
    }
    return { leagues, teams, fixtures, skipped };
}
