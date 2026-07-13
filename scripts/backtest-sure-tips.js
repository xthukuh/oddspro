// Phase 2 - full-warehouse sure-tip pattern search (read-only). Replays every
// finished fixture with a strict kickoff cutoff (leak-free, exactly what the
// live writer sees) and measures, per candidate market and per stats gate, the
// realized precision vs volume. No historical odds exist, so this is STATS-ONLY
// - it isolates which stats patterns are genuinely predictive, which is exactly
// what a "sure-win" gate must be built on. Market blend + ROI are validated
// separately on the live sample (analyze-safe-tips.js).
//
// Output feeds docs/sure-win-analysis.md and the Phase 4 gate choices. Writes a
// machine-readable dump to tmp/sure-win/backtest.json for the analysis agents.
//
//   node scripts/backtest-sure-tips.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { h2hOutcomeAggregates } from '../src/db/tip-rules.js';

// Wilson score lower bound (95%) - the honest "at least this good" precision,
// resists thin-cell overfitting. (Inlined; importing recon-warehouse.js would
// run its top-level queries + closeDb on import.)
function wilsonLower(hits, n, z = 1.96) {
    if (!n) return 0;
    const p = hits / n, z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (centre - margin) / (1 + z2 / n));
}

const WINDOW = 7;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const MIN_VOL = 150;               // volume floor - thin cells don't earn a verdict
const pct = v => (v == null ? '  n/a' : (100 * v).toFixed(1) + '%');

// Leak-free per-team shape over the last-`window` games vs opponents OTHER than
// oppId (vs-others semantics, mirrors teamGoalsAggregates/_qualifying). Superset
// of the shared aggregates: adds own-goal over-rates (team totals), scored/CS/
// BTTS rates, and total-goal over-rates per line.
function teamShape(rows, teamId, oppId, cutoff, window) {
    const recent = rows
        .filter(f => f.ft_home != null && f.ft_away != null && new Date(f.kickoff).getTime() < cutoff
            && !((f.home_team_id === teamId && f.away_team_id === oppId) || (f.home_team_id === oppId && f.away_team_id === teamId)))
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime())
        .slice(0, window);
    const n = recent.length;
    const ownOver = {}, totOver = {};
    for (const L of OU_LINES) { ownOver[L] = 0; totOver[L] = 0; }
    if (!n) return { n: 0 };
    let win = 0, draw = 0, gf = 0, ga = 0, scored = 0, btts = 0;
    for (const f of recent) {
        const home = f.home_team_id === teamId;
        const g = home ? f.ft_home : f.ft_away, c = home ? f.ft_away : f.ft_home, tot = g + c;
        if (g > c) win++; else if (g === c) draw++;
        gf += g; ga += c; if (g > 0) scored++; if (g > 0 && c > 0) btts++;
        for (const L of OU_LINES) { if (g > L) ownOver[L]++; if (tot > L) totOver[L]++; }
    }
    for (const L of OU_LINES) { ownOver[L] /= n; totOver[L] /= n; }
    return {
        n, winRate: win / n, drawRate: draw / n, lossRate: (n - win - draw) / n,
        gfAvg: gf / n, gaAvg: ga / n, scoredRate: scored / n, bttsRate: btts / n, ownOver, totOver,
    };
}

const _mean = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const _min = arr => { const v = arr.filter(x => x != null); return v.length ? Math.min(...v) : null; };

// Settle any candidate market from a final score. true=win, false=lose,
// null=push/void (DNB draw - excluded from precision, stake returned).
function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case '1X': return h >= a; case 'X2': return h <= a; case '12': return h !== a;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        case 'DNB1': return h === a ? null : h > a;
        case 'DNB2': return h === a ? null : a > h;
        default: {
            const m = /^(O|U|HO|HU|AO|AU) (\d\.5)$/.exec(market);
            if (!m) throw new Error('unknown market ' + market);
            const L = Number(m[2]);
            const side = m[1] === 'O' || m[1] === 'U' ? tot : (m[1][0] === 'H' ? h : a);
            return m[1].endsWith('O') || m[1] === 'O' ? side > L : side < L;
        }
    }
}

try {
    const fixtures = await db('fixtures')
        .whereIn('status', FINAL_STATUSES).whereNotNull('ft_home').whereNotNull('ft_away')
        .orderBy('kickoff').select('id', 'home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff', 'league_id');
    console.log(`Sure-tip backtest pool: ${fixtures.length} finished fixtures\n`);

    const byTeam = new Map();
    for (const f of fixtures) for (const t of [f.home_team_id, f.away_team_id]) {
        let l = byTeam.get(t); if (!l) byTeam.set(t, l = []); l.push(f);
    }

    // Per-fixture: reconstruct support for every candidate market + sufficiency.
    const rowsF = [];
    for (const f of fixtures) {
        const cutoff = new Date(f.kickoff).getTime();
        const H = teamShape(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, WINDOW);
        const A = teamShape(byTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id, cutoff, WINDOW);
        const cap = Math.min(H.n || 0, A.n || 0);
        if (cap < 1) continue; // no evidence either side
        const hh = h2hOutcomeAggregates(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, 5);

        const s1 = _mean([H.winRate, A.lossRate, hh.n ? hh.homeWinRate : null]);
        const sX = _mean([H.drawRate, A.drawRate, hh.n ? hh.drawRate : null]);
        const s2 = _mean([H.lossRate, A.winRate, hh.n ? hh.awayWinRate : null]);
        const c1 = _min([H.winRate, A.lossRate, hh.n ? hh.homeWinRate : null]);   // concurrence (weakest signal)
        const c2 = _min([H.lossRate, A.winRate, hh.n ? hh.awayWinRate : null]);
        const sO = {}, cO = {};
        for (const L of OU_LINES) {
            sO[L] = _mean([H.totOver[L], A.totOver[L], hh.n ? hh.overRates?.[L] : null]);
            cO[L] = _min([H.totOver[L], A.totOver[L], hh.n ? hh.overRates?.[L] : null]);
        }
        const gg = _mean([H.bttsRate, A.bttsRate]);

        // support & concurrence (weakest present component) per market
        const sup = {
            '1X': s2 == null ? null : 1 - s2, 'X2': s1 == null ? null : 1 - s1, '12': sX == null ? null : 1 - sX,
            'GG': gg, 'NG': gg == null ? null : 1 - gg,
            'DNB1': s1 == null || s2 == null ? null : s1 / (s1 + s2 || 1),
            'DNB2': s1 == null || s2 == null ? null : s2 / (s1 + s2 || 1),
        };
        const con = {
            '1X': c2 == null ? null : 1 - c2, 'X2': c1 == null ? null : 1 - c1, '12': null,
            'GG': _min([H.bttsRate, A.bttsRate]), 'NG': null, 'DNB1': null, 'DNB2': null,
        };
        for (const L of OU_LINES) {
            sup[`O ${L}`] = sO[L]; sup[`U ${L}`] = sO[L] == null ? null : 1 - sO[L];
            con[`O ${L}`] = cO[L]; con[`U ${L}`] = cO[L] == null ? null : 1 - cO[L];
            sup[`HU ${L}`] = 1 - H.ownOver[L]; sup[`AU ${L}`] = 1 - A.ownOver[L];
            sup[`HO ${L}`] = H.ownOver[L]; sup[`AO ${L}`] = A.ownOver[L];
        }
        rowsF.push({ h: f.ft_home, a: f.ft_away, league: f.league_id, minN: cap, h2hN: hh.n || 0, sup, con, ko: cutoff });
    }
    console.log(`Reconstructed evidence for ${rowsF.length} fixtures (both sides had history)\n`);

    // Candidate markets to grid. (Overs like O 1.5 kept for completeness; the
    // safe zone is expected to be double-chance + high Unders + team-total Unders.)
    const MARKETS = ['1X', 'X2', '12', 'DNB1', 'DNB2', 'GG', 'NG',
        'O 1.5', 'O 2.5', 'U 3.5', 'U 4.5', 'HU 1.5', 'HU 2.5', 'AU 1.5', 'AU 2.5'];
    const THRESH = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
    // Sufficiency variants: how strict the "sufficient stats" gate is.
    const SUFF = {
        'none      ': r => true,
        'minN>=5   ': r => r.minN >= 5,
        'minN>=6   ': r => r.minN >= 6,
        'minN>=6,h2h>=3': r => r.minN >= 6 && r.h2hN >= 3,
    };

    const results = [];
    for (const market of MARKETS) {
        for (const suffName of Object.keys(SUFF)) {
            const suff = SUFF[suffName];
            for (const T of THRESH) {
                let n = 0, hits = 0, push = 0;
                for (const r of rowsF) {
                    if (!suff(r)) continue;
                    const s = r.sup[market];
                    if (s == null || s < T) continue;
                    const res = settle(market, r.h, r.a);
                    if (res == null) { push++; continue; }
                    n++; if (res) hits++;
                }
                if (n >= MIN_VOL) results.push({ market, suff: suffName.trim(), T, n, hits, push, prec: hits / n, wLo: wilsonLower(hits, n) });
            }
        }
    }

    // Best gate per market (highest wilson-lower at volume) + global leaderboard.
    console.log('=== BEST STATS GATE PER MARKET (ranked by Wilson lower bound, min ' + MIN_VOL + ' picks) ===');
    const bestPer = new Map();
    for (const r of results) { const b = bestPer.get(r.market); if (!b || r.wLo > b.wLo) bestPer.set(r.market, r); }
    for (const [market, r] of [...bestPer.entries()].sort((a, b) => b[1].wLo - a[1].wLo)) {
        console.log(`  ${market.padEnd(6)} sup>=${r.T}  ${r.suff.padEnd(14)}  ${pct(r.prec).padStart(6)}  wLo ${pct(r.wLo).padStart(6)}  (${r.hits}/${r.n}${r.push ? ', ' + r.push + ' push' : ''})`);
    }

    console.log('\n=== GLOBAL LEADERBOARD (highest Wilson lower bound, min ' + MIN_VOL + ' picks) ===');
    results.sort((a, b) => b.wLo - a.wLo).slice(0, 25).forEach(r =>
        console.log(`  ${r.market.padEnd(6)} sup>=${r.T} ${r.suff.padEnd(14)} prec ${pct(r.prec).padStart(6)} wLo ${pct(r.wLo).padStart(6)}  (${r.hits}/${r.n})`));

    // Does the sufficiency gate actually help? Compare the same (market,T) at
    // 'none' vs 'minN>=6,h2h>=3' where both clear volume.
    console.log('\n=== SUFFICIENCY GATE LIFT (same market+threshold: strict vs none) ===');
    const key = r => `${r.market}@${r.T}`;
    const none = new Map(results.filter(r => r.suff === 'none').map(r => [key(r), r]));
    const strict = results.filter(r => r.suff === 'minN>=6,h2h>=3');
    const lifts = [];
    for (const s of strict) { const b = none.get(key(s)); if (b) lifts.push({ market: s.market, T: s.T, base: b.prec, strict: s.prec, dPrec: s.prec - b.prec, sN: s.n, bN: b.n }); }
    lifts.sort((a, b) => b.dPrec - a.dPrec);
    for (const l of [...lifts.slice(0, 6), ...lifts.slice(-4)]) {
        console.log(`  ${l.market.padEnd(6)} sup>=${l.T}  none ${pct(l.base)} (${l.bN}) -> strict ${pct(l.strict)} (${l.sN})  ${(l.dPrec >= 0 ? '+' : '') + (100 * l.dPrec).toFixed(1)}pp`);
    }

    // === Robustness: temporal out-of-sample split + league concentration ===
    // The real overfitting test - a pattern that only holds in-sample is noise.
    // rowsF is already in kickoff order, so the array index IS temporal order.
    const cut = Math.floor(rowsF.length * 0.7);
    const train = rowsF.slice(0, cut), test = rowsF.slice(cut);
    const evalGate = (pool, market, T, suffFn) => {
        let n = 0, hits = 0;
        for (const r of pool) {
            if (!suffFn(r)) continue;
            const s = r.sup[market]; if (s == null || s < T) continue;
            const res = settle(market, r.h, r.a); if (res == null) continue;
            n++; if (res) hits++;
        }
        return { n, hits, prec: n ? hits / n : null, wLo: wilsonLower(hits, n) };
    };
    // The elite gates worth shipping (wLo >= ~76% at volume above).
    const ELITE = [
        ['AU 2.5', 0.85, SUFF['minN>=5   ']], ['U 4.5', 0.85, SUFF['minN>=6   ']],
        ['HU 2.5', 0.85, SUFF['minN>=5   ']], ['O 1.5', 0.85, SUFF['minN>=5   ']],
        ['1X', 0.85, SUFF['minN>=6   ']], ['12', 0.85, SUFF['minN>=5   ']],
        ['U 3.5', 0.85, SUFF['minN>=5   ']], ['DNB1', 0.8, SUFF['minN>=6   ']],
    ];
    console.log('\n=== TEMPORAL OUT-OF-SAMPLE (train = oldest 70%, TEST = newest 30%) ===');
    console.log('  A pattern that holds on TEST is real; a big train->test drop is overfit.');
    for (const [m, T, sf] of ELITE) {
        const tr = evalGate(train, m, T, sf), te = evalGate(test, m, T, sf);
        console.log(`  ${m.padEnd(6)} sup>=${T}  train ${pct(tr.prec)} (${tr.n})  ->  TEST ${pct(te.prec)} wLo ${pct(te.wLo)} (${te.n})`);
    }
    // League concentration for the headline pattern (AU 2.5).
    const byLeague = new Map();
    for (const r of rowsF) {
        if (!(r.minN >= 5) || (r.sup['AU 2.5'] ?? 0) < 0.85) continue;
        const res = settle('AU 2.5', r.h, r.a); const b = byLeague.get(r.league) ?? (byLeague.set(r.league, { n: 0, h: 0 }).get(r.league));
        b.n++; if (res) b.h++;
    }
    const leagues = [...byLeague.values()];
    const totN = leagues.reduce((s, b) => s + b.n, 0);
    const topShare = Math.max(...leagues.map(b => b.n)) / totN;
    console.log(`\n=== LEAGUE CONCENTRATION (AU 2.5 sup>=0.85 gate) ===`);
    console.log(`  ${leagues.length} distinct leagues, top league = ${(100 * topShare).toFixed(1)}% of picks (not one-league-driven if low)`);

    mkdirSync('tmp/sure-win', { recursive: true });
    writeFileSync('tmp/sure-win/backtest.json', JSON.stringify({ pool: rowsF.length, results }, null, 0));
    console.log('\nWrote tmp/sure-win/backtest.json (' + results.length + ' gate cells)');
} finally {
    await closeDb();
}
