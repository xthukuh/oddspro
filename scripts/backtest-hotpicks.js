// Hot-picks rule backtest: replay every finished fixture in the warehouse
// with a kickoff-time cutoff (exactly what the live pick writer sees) and
// grid the stats gates to measure precision (hit-rate among flagged) vs
// volume. No historical odds or API predictions exist, so the market and
// API gates are disabled here (requireMarket: false) - they only tighten
// selection go-forward, meaning live precision should be >= these numbers.
//
//   node scripts/backtest-hotpicks.js                 # default sweep 1.5,2.5,3.5
//   node scripts/backtest-hotpicks.js --line 2.5      # a single line
//   node scripts/backtest-hotpicks.js --line 1.5,3.5  # a custom sweep
//
// M3 (Task 10): the --line sweep replays scoreOverLine over each O/U line's
// per-line overRates and reports precision/recall PER threshold grid, so we can
// decide whether any line OTHER than 2.5 clears the shipped ~73% stats-only
// precision bar and therefore earns a LINE_THRESHOLDS entry (a line with no
// entry can never fire hot). Honest "no expansion" (keep HOTPICK_LINES=2.5) is
// an expected, valid outcome.
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { DEFAULT_THRESHOLDS, pairedTeamGoalsAggregates, h2hGoalsAggregates, scoreOverLine } from '../src/db/goals-rules.js';

const WINDOWS = [5, 6, 7, 8];
const OVER_RATES = [0.5, 0.55, 0.6, 0.65, 0.7];
const AVG_TOTALS = [2.6, 2.8, 3.0, 3.2, 3.4];
const MIN_FLAGGED = 50;         // volume floor a gate must clear to earn a verdict
const BAR = 0.73;               // the shipped 2.5 stats-only precision bar to beat

// --line parsing: `--line 1.5,3.5` or `--line=2.5`; default sweep 1.5,2.5,3.5.
function parseLines(argv) {
    const i = argv.findIndex(a => a === '--line' || a.startsWith('--line='));
    if (i < 0) return [1.5, 2.5, 3.5];
    const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
    const lines = String(raw ?? '').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
    return lines.length ? lines : [1.5, 2.5, 3.5];
}
const LINES = parseLines(process.argv.slice(2));
const pct = v => (v == null ? '  n/a' : (v * 100).toFixed(1) + '%');

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
    console.log(`Backtest pool: ${fixtures.length} finished fixtures; lines swept: ${LINES.join(', ')}`);

    // Precompute per-fixture aggregates once per window; the threshold grid then
    // re-evaluates the cheap gates only. `total` lets us settle any line's over.
    const prepared = fixtures.map(f => {
        const cutoff = new Date(f.kickoff).getTime();
        const homeRows = fixturesByTeam.get(f.home_team_id) ?? [];
        const awayRows = fixturesByTeam.get(f.away_team_id) ?? [];
        // Paired windows mirror the live writer: both sides judged over the
        // same (min-capped) sample per fixture.
        const perWindow = new Map(WINDOWS.map(w => {
            const { home, away } = pairedTeamGoalsAggregates(homeRows, awayRows,
                f.home_team_id, f.away_team_id, cutoff, w);
            return [w, { home, away }];
        }));
        return {
            total: f.ft_home + f.ft_away,
            h2h: h2hGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, 5),
            perWindow,
        };
    });

    const isDefault = r => r.teamWindow === DEFAULT_THRESHOLDS.teamWindow
        && r.minOverRate === DEFAULT_THRESHOLDS.minOverRate
        && r.minAvgTotal === DEFAULT_THRESHOLDS.minAvgTotal;
    const _row = (r, best) =>
        `${isDefault(r) ? '*' : ' '}${r === best ? '#' : ' '} window=${r.teamWindow} overRate>=${r.minOverRate.toFixed(2)} avgTotal>=${r.minAvgTotal.toFixed(1)}`
        + `  flagged=${String(r.flagged).padStart(5)}  hits=${String(r.hits).padStart(5)}`
        + `  precision=${pct(r.precision).padStart(6)}  recall=${pct(r.recall).padStart(6)}  score~${r.avgScore == null ? ' n/a' : r.avgScore.toFixed(3)}`;

    const verdicts = [];
    for (const line of LINES) {
        // Per-line outcome + baseline (the marginal a blind over-`line` bet realizes).
        const overCount = prepared.filter(p => p.total > line).length;
        const baseline = overCount / prepared.length;

        const results = [];
        for (const teamWindow of WINDOWS) {
            for (const minOverRate of OVER_RATES) {
                for (const minAvgTotal of AVG_TOTALS) {
                    let flagged = 0, hits = 0, scoreSum = 0;
                    for (const p of prepared) {
                        const { home, away } = p.perWindow.get(teamWindow);
                        const { hot, score } = scoreOverLine({ home, away, h2h: p.h2h, market: null, api: null }, line, {
                            ...DEFAULT_THRESHOLDS, teamWindow, minOverRate, minAvgTotal, requireMarket: false,
                        });
                        if (!hot) continue;
                        flagged++; scoreSum += score;
                        if (p.total > line) hits++;
                    }
                    results.push({
                        teamWindow, minOverRate, minAvgTotal, flagged, hits,
                        precision: flagged ? hits / flagged : null,
                        recall: overCount ? hits / overCount : null,
                        avgScore: flagged ? scoreSum / flagged : null,
                    });
                }
            }
        }

        // Best gate at volume = highest precision among gates clearing MIN_FLAGGED.
        const atVol = results.filter(r => r.flagged >= MIN_FLAGGED);
        const best = atVol.slice().sort((a, b) => b.precision - a.precision || b.flagged - a.flagged)[0] ?? null;
        const def = results.find(isDefault);

        console.log(`\n${'='.repeat(72)}`);
        console.log(`LINE ${line}  (over-${line} baseline ${pct(baseline)} = ${overCount}/${prepared.length})`);
        console.log(`Top gates by precision (min ${MIN_FLAGGED} flagged), * = 2.5 defaults, # = best-at-volume:`);
        atVol.sort((a, b) => b.precision - a.precision || b.flagged - a.flagged)
            .slice(0, 12)
            .forEach(r => console.log(_row(r, best)));
        console.log(`Default-threshold gate at this line:\n${_row(def, best)}`);

        if (best) {
            const lift = best.precision - baseline;
            const beats = best.precision >= BAR;
            verdicts.push({ line, baseline, best, lift, beats });
            console.log(`  -> best-at-volume precision ${pct(best.precision)} vs ${pct(BAR)} bar `
                + `(${beats ? 'CLEARS' : 'below'}); lift over baseline ${(lift >= 0 ? '+' : '') + (lift * 100).toFixed(1)}pp; `
                + `recall ${pct(best.recall)}; flagged ${best.flagged}`);
        } else {
            console.log(`  -> no gate cleared ${MIN_FLAGGED} flagged; no verdict`);
        }
    }

    console.log(`\n${'='.repeat(72)}\n=== LINE-SWEEP VERDICT (vs the ${pct(BAR)} 2.5 bar) ===`);
    for (const v of verdicts) {
        console.log(`  line ${v.line}: best ${pct(v.best.precision)} (${v.best.hits}/${v.best.flagged}, recall ${pct(v.best.recall)}, `
            + `lift ${(v.lift >= 0 ? '+' : '') + (v.lift * 100).toFixed(1)}pp) -> ${v.beats ? 'CLEARS bar' : 'below bar'}`);
    }
    const winners = verdicts.filter(v => v.line !== 2.5 && v.beats);
    console.log('\nNOTE: `score` is NOT comparable across lines (a lower line scores higher on the same');
    console.log('fixture because its over-rate is higher), so the hotpicks loop\'s strictly-higher-score');
    console.log('replacement of the 2.5 baseline is only meaningful WITHIN a line - see report.');
    if (winners.length) {
        console.log(`\nCandidate lines clearing the bar (review lift + odds before adding a LINE_THRESHOLDS entry):`);
        for (const v of winners) console.log(`  line ${v.line}: precision ${pct(v.best.precision)}, lift ${(v.lift * 100).toFixed(1)}pp`);
    } else {
        console.log('\nNo non-2.5 line cleared the bar at volume -> keep HOTPICK_LINES=2.5 (no LINE_THRESHOLDS additions).');
    }
} finally {
    await closeDb();
}
