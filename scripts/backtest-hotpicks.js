// Hot-picks rule backtest: replay every finished fixture in the warehouse
// with a kickoff-time cutoff (exactly what the live pick writer sees) and
// grid the stats gates to measure precision (hit-rate among flagged) vs
// volume. No historical odds or API predictions exist, so the market and
// API gates are disabled here (requireMarket: false) - they only tighten
// selection go-forward, meaning live precision should be >= these numbers.
//
//   node scripts/backtest-hotpicks.js
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { DEFAULT_THRESHOLDS, teamGoalsAggregates, h2hGoalsAggregates, scoreOver25 } from '../src/db/goals-rules.js';

const WINDOWS = [5, 6, 7, 8];
const OVER_RATES = [0.5, 0.55, 0.6, 0.65, 0.7];
const AVG_TOTALS = [2.6, 2.8, 3.0, 3.2, 3.4];

try {
    const fixtures = await db('fixtures')
        .whereIn('status', FINAL_STATUSES)
        .whereNotNull('ft_home').whereNotNull('ft_away')
        .orderBy('kickoff')
        .select('id', 'home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff');

    const fixturesByTeam = new Map();
    for (const f of fixtures) {
        for (const team of [f.home_team_id, f.away_team_id]) {
            let list = fixturesByTeam.get(team);
            if (!list) fixturesByTeam.set(team, list = []);
            list.push(f);
        }
    }

    const baselineOver = fixtures.filter(f => f.ft_home + f.ft_away >= 3).length / fixtures.length;
    console.log(`Backtest pool: ${fixtures.length} finished fixtures, baseline over-2.5 rate ${(baselineOver * 100).toFixed(1)}%`);

    // Precompute per-fixture aggregates once per window; the threshold grid
    // then re-evaluates the cheap gates only.
    const prepared = fixtures.map(f => {
        const cutoff = new Date(f.kickoff).getTime();
        const homeRows = fixturesByTeam.get(f.home_team_id) ?? [];
        const perWindow = new Map(WINDOWS.map(w => [w, {
            home: teamGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, w),
            away: teamGoalsAggregates(fixturesByTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id, cutoff, w),
        }]));
        return {
            over: f.ft_home + f.ft_away >= 3,
            h2h: h2hGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, 5),
            perWindow,
        };
    });

    const results = [];
    for (const teamWindow of WINDOWS) {
        for (const minOverRate of OVER_RATES) {
            for (const minAvgTotal of AVG_TOTALS) {
                let flagged = 0, hits = 0;
                for (const p of prepared) {
                    const { home, away } = p.perWindow.get(teamWindow);
                    const { hot } = scoreOver25({ home, away, h2h: p.h2h, market: null, api: null }, {
                        ...DEFAULT_THRESHOLDS, teamWindow, minOverRate, minAvgTotal, requireMarket: false,
                    });
                    if (!hot) continue;
                    flagged++;
                    if (p.over) hits++;
                }
                results.push({
                    teamWindow, minOverRate, minAvgTotal, flagged, hits,
                    precision: flagged ? hits / flagged : null,
                });
            }
        }
    }

    const isDefault = r => r.teamWindow === DEFAULT_THRESHOLDS.teamWindow
        && r.minOverRate === DEFAULT_THRESHOLDS.minOverRate
        && r.minAvgTotal === DEFAULT_THRESHOLDS.minAvgTotal;
    const _row = r =>
        `${isDefault(r) ? '*' : ' '} window=${r.teamWindow} overRate>=${r.minOverRate.toFixed(2)} avgTotal>=${r.minAvgTotal.toFixed(1)}`
        + `  flagged=${String(r.flagged).padStart(5)}  hits=${String(r.hits).padStart(5)}`
        + `  precision=${r.precision == null ? '  n/a' : (r.precision * 100).toFixed(1) + '%'}`;

    console.log('\nTop combinations by precision (min 20 flagged), * = shipped defaults:');
    results
        .filter(r => r.flagged >= 20)
        .sort((a, b) => b.precision - a.precision || b.flagged - a.flagged)
        .slice(0, 20)
        .forEach(r => console.log(_row(r)));

    const def = results.find(isDefault);
    console.log('\nShipped defaults:');
    console.log(_row(def));
    console.log('\nNote: live picks additionally require the market gate (vig-removed'
        + ` P(over) >= ${DEFAULT_THRESHOLDS.minImpliedOver}) and no API-Football contradiction,`
        + ' so go-forward precision should meet or beat the number above.');
} finally {
    await closeDb();
}
