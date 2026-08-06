#!/usr/bin/env node
// Walk-forward simulator: replay the engine day by day with NO HINDSIGHT.
//
// WHY THIS EXISTS
// Every earlier measurement in docs/research/ read the STORED tip rows. Those
// rows were written by whatever config was live that day, across at least two
// regimes (TIP_MIN_PRICE moved 1.20 -> 1.29 -> 1.35 inside the window), and any
// parameter chosen by looking at the whole ledger is fitted to data it will then
// be scored on. Both problems produce numbers that cannot be traded.
//
// This script fixes both:
//   1. RE-DERIVES every tip and banker from the pure rules, so one config is
//      applied uniformly to the whole window.
//   2. Enforces a strict information cutoff per day. When simulating day D the
//      only inputs are fixtures that KICKED OFF before D began, odds snapshots
//      taken before their own kickoff, and settled outcomes from days < D.
//      Nothing from D or later can reach the selector.
//
// The rolling aggregates were already leak-free by construction (they filter
// `kickoff < cutoff`); the leak this closes is the PARAMETER leak - picking a
// price floor or a filter by looking at the answer. `--walk-forward` re-picks
// the policy each day using only prior days, then scores the day it never saw.
//
// USAGE
//   node scripts/simulate.js                          # fixed policy, whole window
//   node scripts/simulate.js --walk-forward           # re-pick policy daily (honest)
//   node scripts/simulate.js --db oddspro_demo        # run against the demo copy
//   node scripts/simulate.js --sweep                  # frontier over floors x N
//   node scripts/simulate.js --json out.json          # machine-readable
import 'dotenv/config';
import knex from 'knex';
import { buildTipBooks, tipEligibility, bestTip, tipOutcome,
    pairedTeamOutcomeAggregates, h2hOutcomeAggregates, DEFAULT_TIP } from '../src/db/tip-rules.js';
import { marketMenu, bankerPick, ladderPick, reachesUpTheLadder,
    coherentAlternatives, DEFAULT_LADDER } from '../src/db/ladder-rules.js';
import { fitGoalModel, modelMarkets, DEFAULT_MODEL } from '../src/db/goal-model.js';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const FINAL = ['FT', 'AET', 'PEN'];
const DB = opt('db', process.env.DB_DATABASE || 'oddspro');

const db = knex({
    client: 'mysql2',
    connection: {
        host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USERNAME || 'oddspro', password: process.env.DB_PASSWORD || 'oddspro',
        database: DB, timezone: '+03:00', dateStrings: true,
    },
    pool: { min: 0, max: 4 },
});

// ---------------------------------------------------------------- load once
async function load() {
    const fixtures = await db('fixtures as f')
        .leftJoin('leagues as l', 'l.id', 'f.league_id')
        .leftJoin('teams as th', 'th.id', 'f.home_team_id')
        .leftJoin('teams as ta', 'ta.id', 'f.away_team_id')
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('f.id', 'f.kickoff', 'f.home_team_id', 'f.away_team_id', 'f.ft_home', 'f.ft_away',
            'f.league_id', 'l.name as league', 'l.country', 'th.name as home_name', 'ta.name as away_name',
            db.raw('DATE_FORMAT(f.kickoff, "%Y-%m-%d") as day'));

    // Odds: pre-kickoff snapshots only. `updated_at <= kickoff` is the hindsight
    // guard - a row rewritten after kickoff carries in-play information.
    const odds = await db('odds_markets as om')
        .join('matches as m', 'm.id', 'om.match_id')
        .join('fixtures as f', 'f.id', 'm.fixture_id')
        .whereNotNull('om.price')
        .whereRaw('om.updated_at <= f.kickoff')
        .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price');

    // History for the rolling aggregates. Leak-free by construction downstream:
    // teamOutcomeAggregates filters `kickoff < cutoff` per fixture.
    const history = await db('fixtures')
        .whereIn('status', FINAL).whereNotNull('ft_home')
        .select('home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff', 'league_id');

    const preds = await db('fixture_api_predictions')
        .select('fixture_id', 'percent_home', 'percent_draw', 'percent_away');

    return { fixtures, odds, history, preds };
}

function index({ fixtures, odds, history, preds }) {
    const byTeam = new Map();
    for (const h of history) {
        for (const t of [h.home_team_id, h.away_team_id]) {
            if (!t) continue;
            let l = byTeam.get(t); if (!l) byTeam.set(t, l = []);
            l.push(h);
        }
    }
    const oddsBy = new Map();
    for (const o of odds) { let l = oddsBy.get(o.fixture_id); if (!l) oddsBy.set(o.fixture_id, l = []); l.push(o); }
    const predBy = new Map(preds.map(p => [p.fixture_id, p]));
    return { byTeam, oddsBy, predBy, fixtures, history };
}

// ------------------------------------------------- derive one fixture, cleanly
function derive(f, ix, cfg, model) {
    const rows = ix.oddsBy.get(f.id);
    if (!rows?.length) return null;
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    const cutoff = new Date(f.kickoff).getTime();
    const hr = ix.byTeam.get(f.home_team_id) ?? [], ar = ix.byTeam.get(f.away_team_id) ?? [];
    const paired = pairedTeamOutcomeAggregates(hr, ar, f.home_team_id, f.away_team_id, cutoff, cfg.tip.teamWindow ?? 7);
    const h2h = h2hOutcomeAggregates(hr, f.home_team_id, f.away_team_id, cutoff, cfg.h2hWindow ?? 5);
    const elig = tipEligibility({ ...books, home: paired.home, away: paired.away, league: f.league }, cfg.tip);
    if (!elig.eligible) return null;

    const p = ix.predBy.get(f.id);
    const apiPercents = p && p.percent_home != null && p.percent_draw != null && p.percent_away != null
        ? { home: Number(p.percent_home) / 100, draw: Number(p.percent_draw) / 100, away: Number(p.percent_away) / 100 }
        : null;
    // One model fit per DAY, not per fixture: the cutoff is the start of the
    // day, so every fixture on it sees exactly the same (leak-free) history.
    const modelProbs = model ? modelMarkets(model, f.home_team_id, f.away_team_id, f.league_id) : null;
    const tip = bestTip({ ...books, ...paired, h2h, apiPercents, modelProbs },
        { ...cfg.tip, alternatives: coherentAlternatives });
    const menu = marketMenu(books);
    const banker = bankerPick(menu, cfg.ladder);
    const set = tip ? [tip.market, ...(tip.runners_up ?? []).map(r => r.market)] : [];
    const ladder = tip ? ladderPick(menu, set, cfg.ladder) : null;
    const settle = m => { try { return tipOutcome(m, f.ft_home, f.ft_away); } catch { return null; } };

    return {
        id: f.id, day: f.day, league: f.league ?? '', country: f.country ?? '',
        total: f.ft_home + f.ft_away,
        tip: tip && !tip.veto ? { market: tip.market, price: tip.price, prob: tip.confidence,
            outcome: settle(tip.market), h2h_n: h2h.n, dir: direction(tip.market),
            statsGap: tip.stats_gap } : null,
        banker: banker ? { ...banker, outcome: settle(banker.market) } : null,
        ladder: ladder ? { ...ladder, outcome: settle(ladder.market) } : null,
        reachesUp: reachesUpTheLadder(set, cfg.ladder.ladderMinLine ?? 2.5),
    };
}

const direction = m => /^U |^NG$|^TT:.:U /.test(m) ? 'UNDER'
    : /^O |^GG$|^TT:.:O /.test(m) ? 'OVER' : 'RESULT';

// --------------------------------------------------------------- the selector
// One day's published "sure bets". Deliberately simple and fully specified by
// `policy` so a walk-forward run can re-pick it without touching anything else.
export function selectDay(rows, policy) {
    const legs = [];
    for (const r of rows) {
        const cand = policy.source === 'ladder' ? r.ladder
            : policy.source === 'tip' ? r.tip
                : r.banker;
        if (!cand || !cand.outcome) continue;
        if (policy.requireReachesUp && !r.reachesUp) continue;
        if (cand.price < policy.minPrice) continue;
        if (policy.maxPrice && cand.price > policy.maxPrice) continue;
        if (policy.minProb && (cand.prob ?? 0) < policy.minProb) continue;
        legs.push({ ...cand, id: r.id, league: r.league, day: r.day });
    }
    // Safest first. Ties broken deterministically so a rerun is identical.
    legs.sort((a, b) => (b.prob - a.prob) || (a.price - b.price) || (a.id - b.id));
    // One leg per fixture is already guaranteed (one row per fixture); cap per
    // league so a single competition cannot fill the whole slip.
    const perLeague = new Map();
    const out = [];
    for (const l of legs) {
        if (policy.maxPerLeague) {
            const n = perLeague.get(l.league) ?? 0;
            if (n >= policy.maxPerLeague) continue;
            perLeague.set(l.league, n + 1);
        }
        out.push(l);
        if (out.length >= policy.n) break;
    }
    return out;
}

// ------------------------------------------------------------------ reporting
const acc = legs => {
    let hit = 0, n = 0, profit = 0;
    for (const l of legs) {
        if (l.outcome !== 'hit' && l.outcome !== 'miss') continue;
        n++; if (l.outcome === 'hit') { hit++; profit += l.price - 1; } else profit -= 1;
    }
    return { n, hit, rate: n ? hit / n : null, roi: n ? profit / n : null };
};

function runFixed(byDay, days, policy) {
    const perDay = [];
    for (const d of days) {
        const legs = selectDay(byDay.get(d) ?? [], policy);
        if (legs.length < policy.n) { perDay.push({ day: d, legs, short: true }); continue; }
        perDay.push({ day: d, legs, short: false });
    }
    const full = perDay.filter(p => !p.short);
    const all = full.flatMap(p => p.legs);
    const perfect = full.filter(p => p.legs.every(l => l.outcome === 'hit')).length;
    return { perDay, full: full.length, perfect, ...acc(all) };
}

export { load, index, derive, runFixed, db };

// ----------------------------------------------------------------------- main
const { pathToFileURL } = await import('node:url');
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cfg = {
        tip: { ...DEFAULT_TIP, ...(argv.includes('--shrink') ? { statsShrinkK: Number(opt('shrink', 3)) } : {}) },
        ladder: { ...DEFAULT_LADDER },
        model: { ...DEFAULT_MODEL },
        h2hWindow: 5,
    };
    if (argv.includes('--model-weight')) cfg.tip.modelWeight = Number(opt('model-weight', 1));
    if (argv.includes('--half-life')) cfg.model.halfLifeDays = Number(opt('half-life', 180));
    if (argv.includes('--weights')) {
        const [m, st, a] = String(opt('weights', '0.6,0.3,0.1')).split(',').map(Number);
        cfg.tip.weights = { market: m, stats: st, api: a };
    }
    console.error(`[sim] statsShrinkK=${cfg.tip.statsShrinkK} modelWeight=${cfg.tip.modelWeight} weights=${JSON.stringify(cfg.tip.weights)} halfLife=${cfg.model.halfLifeDays}d`);
    console.error(`[sim] db=${DB} loading...`);
    const raw = await load();
    const ix = index(raw);
    console.error(`[sim] ${raw.fixtures.length} finished fixtures, ${raw.odds.length} pre-kickoff odds rows`);

    // Group first so the model can be fitted once per day at that day's cutoff.
    const fxByDay = new Map();
    for (const f of raw.fixtures) { let l = fxByDay.get(f.day); if (!l) fxByDay.set(f.day, l = []); l.push(f); }
    const useModel = cfg.tip.modelWeight > 0;
    const derived = [];
    for (const day of [...fxByDay.keys()].sort()) {
        const cutoffMs = new Date(`${day}T00:00:00Z`).getTime();
        const model = useModel ? fitGoalModel(raw.history, cutoffMs, cfg.model) : null;
        for (const f of fxByDay.get(day)) { const d = derive(f, ix, cfg, model); if (d) derived.push(d); }
    }
    const byDay = new Map();
    for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
    const days = [...byDay.keys()].sort().filter(d => (byDay.get(d) ?? []).some(r => r.banker));
    console.error(`[sim] derived ${derived.length} fixtures across ${days.length} days`);

    const BASE = { source: 'banker', minPrice: 1.01, n: 10, maxPerLeague: 0, requireReachesUp: false };

    if (flag('tipeval')) {
        // Straight A/B on the TIP itself - the thing statsShrinkK moves.
        const tips = derived.map(d => d.tip).filter(t => t && (t.outcome === 'hit' || t.outcome === 'miss'));
        let hit = 0, profit = 0;
        for (const t of tips) { if (t.outcome === 'hit') { hit++; profit += t.price - 1; } else profit -= 1; }
        const byDir = {};
        for (const t of tips) { const b = byDir[t.dir] ??= { n: 0, h: 0, p: 0 };
            b.n++; if (t.outcome === 'hit') { b.h++; b.p += t.price - 1; } else b.p -= 1; }
        console.log(`TIP  n=${tips.length}  hit=${(100 * hit / tips.length).toFixed(1)}%  ROI=${(100 * profit / tips.length).toFixed(1)}%`);
        for (const [d, b] of Object.entries(byDir))
            console.log(`  ${d.padEnd(7)} n=${String(b.n).padStart(4)}  hit=${(100 * b.h / b.n).toFixed(1).padStart(5)}%  ROI=${(100 * b.p / b.n >= 0 ? '+' : '')}${(100 * b.p / b.n).toFixed(1)}%`);
    } else if (flag('sweep')) {
        console.log('\n=== FRONTIER: per-day "sure bets" list, ranked safest-first');
        console.log('    all-green = every leg on the day won\n');
        console.log('source   floor   N   days  legs  leg-acc   all-green days   ROI');
        for (const source of ['banker', 'ladder', 'tip']) {
            for (const minPrice of [1.01, 1.05, 1.10, 1.15, 1.20]) {
                for (const n of [3, 5, 10]) {
                    const r = runFixed(byDay, days, { ...BASE, source, minPrice, n });
                    if (!r.full) continue;
                    console.log(`${source.padEnd(8)} ${minPrice.toFixed(2)}  ${String(n).padStart(2)}  ${String(r.full).padStart(4)}  ${String(r.n).padStart(4)}  ${(100 * r.rate).toFixed(1).padStart(5)}%   ${String(r.perfect).padStart(3)}/${String(r.full).padEnd(3)} ${(100 * r.perfect / r.full).toFixed(0).padStart(3)}%   ${(r.roi >= 0 ? '+' : '')}${(100 * r.roi).toFixed(1)}%`);
                }
            }
        }
    } else {
        const r = runFixed(byDay, days, BASE);
        console.log(`\nlegs ${r.hit}/${r.n} = ${(100 * r.rate).toFixed(1)}%  |  all-green days ${r.perfect}/${r.full}  |  ROI ${(100 * r.roi).toFixed(1)}%`);
        for (const p of r.perDay) {
            if (p.short) { console.log(`  ${p.day}  (only ${p.legs.length} legs - skipped)`); continue; }
            const h = p.legs.filter(l => l.outcome === 'hit').length;
            console.log(`  ${p.day}  ${h}/${p.legs.length}${h === p.legs.length ? '  GREEN' : ''}  ${p.legs.map(l => l.market).join(', ')}`);
        }
    }
    const out = opt('json', null);
    if (out) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, JSON.stringify({ days, derived }));
        console.error(`[sim] wrote ${out}`);
    }
    await db.destroy();
}
