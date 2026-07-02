import { config } from './config.js';
import { db } from './db/connection.js';
import { FINAL_STATUSES } from './apisports.js';
import { computePrematch } from './db/prematch-calc.js';

// Historical pre-match snapshots (fixture_prematch): rank/form, H2H and
// rolling-goals aggregates captured per fixture so later matches never alter
// an old fixture's pre-match view. Upserted on every run while the fixture
// is upcoming; the `kickoff > NOW()` selection IS the freeze - past fixtures
// are never selected again, so their last pre-kickoff snapshot stands.

// Everything in fixture_prematch except the fixture_id key
const SNAPSHOT_COLUMNS = [
    'home_rank', 'home_form', 'away_rank', 'away_form',
    'h2h', 'h2h_count', 'h2h_n', 'h2h_home_goals', 'h2h_away_goals',
    'home_oth_n', 'home_oth_gf', 'home_oth_ga',
    'away_oth_n', 'away_oth_gf', 'away_oth_ga',
    'computed_at',
];

// Upsert pre-match snapshots for all upcoming correlated fixtures.
export async function updatePrematchSnapshots() {
    const targets = await db('fixtures as f')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.kickoff', 'f.league_id', 'f.season', 'f.home_team_id', 'f.away_team_id');
    console.debug(`Pre-match - ${targets.length} upcoming correlated fixtures to snapshot...`);
    if (!targets.length) return { fixtures: 0, written: 0 };

    const teamIds = [...new Set(targets.flatMap(f => [f.home_team_id, f.away_team_id]))];

    // Standings (rank/form) per league+season+team - same keying as records.js
    const standings = await db('standings').whereIn('team_id', teamIds)
        .select('league_id', 'season', 'team_id', 'rank', 'form');
    const standing = new Map(standings.map(s => [`${s.league_id}:${s.season}:${s.team_id}`, s]));

    // Finished fixtures involving any target team, grouped per team. Status is
    // filtered here in SQL; the calc enforces scores + kickoff cutoff per row.
    const history = await db('fixtures')
        .whereIn('status', FINAL_STATUSES)
        .where(q => q.whereIn('home_team_id', teamIds).orWhereIn('away_team_id', teamIds))
        .select('home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff');
    const targetTeams = new Set(teamIds);
    const fixturesByTeam = new Map();
    for (const f of history) {
        for (const team of [f.home_team_id, f.away_team_id]) {
            if (!targetTeams.has(team)) continue;
            let list = fixturesByTeam.get(team);
            if (!list) fixturesByTeam.set(team, list = []);
            list.push(f);
        }
    }

    const rows = targets.map(f => ({
        fixture_id: f.id,
        ...computePrematch({
            fixture: f,
            fixturesByTeam,
            homeStanding: standing.get(`${f.league_id}:${f.season}:${f.home_team_id}`),
            awayStanding: standing.get(`${f.league_id}:${f.season}:${f.away_team_id}`),
            teamWindow: config.PREMATCH_TEAM_WINDOW,
            h2hWindow: config.PREMATCH_H2H_WINDOW,
        }),
        computed_at: db.fn.now(),
    }));

    // Single-statement upsert per chunk: no delete+insert, no deadlock exposure
    for (let i = 0; i < rows.length; i += 200) {
        await db('fixture_prematch').insert(rows.slice(i, i + 200))
            .onConflict('fixture_id').merge(SNAPSHOT_COLUMNS);
    }
    return { fixtures: targets.length, written: rows.length };
}
