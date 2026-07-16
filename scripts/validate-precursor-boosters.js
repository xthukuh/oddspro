// M4.2b — live-ledger validation of the three precursor-pattern boosters from
// docs/precursor-patterns.md Verdict §(i), the best-evidenced-but-never-shipped
// candidates in the project. READ-ONLY: no writes, no API calls.
//
//   node scripts/validate-precursor-boosters.js
//
// WHY this exists. The three boosters were derived on the WAREHOUSE (16.5k
// leak-free fixtures, Tier-A OOS). But warehouse precision is PRICE-BLIND and
// has proven anti-correlated with live ROI once (the "precise-but-sub-1.20"
// trap: AU 2.5 hit 87% OOS and was worthless at ~1.1). So before wiring any of
// them into DEFAULT_SAFE / hasSufficientStats we re-test them on the LIVE data,
// with the recency/regime discipline M4.2 paid for in blood:
//
//   TIP_MIN_PRICE moved 1.20 -> 1.35 on 2026-07-10, splitting the settled-tip
//   ledger into two populations. A validation that POOLS across that break is
//   measuring the config change, not the booster. This script detects the
//   break, headlines the RECENT regime for the tip-ledger lens, and leans on
//   the linked-with-odds surface (which TIP_MIN_PRICE does NOT gate) for power.
//
// Two lenses per booster:
//   Lens A (well-powered, price-robust): every finished fixture linked to a
//     scraped bookmaker match. Gate -> settle the booster's OWN market ->
//     day-clustered lift CI + real-price flat-EV CI + leave-one-day-out
//     jackknife + a recency split. Answers "does the underlying signal hold
//     live, and can it be bet?"
//   Lens B (decision-relevant, thin, regime-aware): the settled-tip ledger,
//     RESTRICTED to the recent regime. Among tips of the booster's market,
//     does the gate discriminate hit-rate? Answers "does the gate improve the
//     tips we actually make now?"
//
// Reuse discipline: the pure statistics (dayClusteredBootstrap, hitRate,
// flatEv, BETTABLE_FLOOR) are imported VERBATIM from src/db/mine-rules.js so
// this harness cannot invent a second, kinder taxonomy. The leak-free
// reconstruction (teamShape/buildFeatures/settle/devig/price-attach) MIRRORS
// scripts/mine-precursors.js — which is deliberately frozen (published
// provenance behind docs/precursor-patterns.md) and does not export its
// internals, so the same "mirror the idiom" pattern the mine itself uses
// (teamShape mirrors backtest-sure-tips) is applied here.
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { h2hOutcomeAggregates, TIP_CONTEXT_EXCLUDE } from '../src/db/tip-rules.js';
import { marketKey } from '../src/markets.js';
import { dayClusteredBootstrap, hitRate, flatEv, BETTABLE_FLOOR } from '../src/db/mine-rules.js';

const WINDOW = 7;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const pct = v => (v == null ? '  n/a' : (100 * v).toFixed(1) + '%');
const pp = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + 'pp');
const ev = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + '%');

// ---- leak-free per-team shape (vs-others, strict kickoff cutoff) ------------
// Mirrors scripts/mine-precursors.js:teamShape verbatim.
function teamShape(rows, teamId, oppId, cutoff, window) {
    const recent = rows
        .filter(f => f.ft_home != null && f.ft_away != null && new Date(f.kickoff).getTime() < cutoff
            && !((f.home_team_id === teamId && f.away_team_id === oppId) || (f.home_team_id === oppId && f.away_team_id === teamId)))
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime())
        .slice(0, window);
    const n = recent.length;
    const totOver = {}, ownOver = {};
    for (const L of OU_LINES) { totOver[L] = 0; ownOver[L] = 0; }
    if (!n) return { n: 0 };
    let win = 0, draw = 0, gf = 0, ga = 0, scored = 0, btts = 0;
    for (const f of recent) {
        const home = f.home_team_id === teamId;
        const g = home ? f.ft_home : f.ft_away, c = home ? f.ft_away : f.ft_home, tot = g + c;
        if (g > c) win++; else if (g === c) draw++;
        gf += g; ga += c; if (g > 0) scored++; if (g > 0 && c > 0) btts++;
        for (const L of OU_LINES) { if (tot > L) totOver[L]++; if (g > L) ownOver[L]++; }
    }
    for (const L of OU_LINES) { totOver[L] /= n; ownOver[L] /= n; }
    const winRate = win / n, drawRate = draw / n, lossRate = (n - win - draw) / n;
    return { n, winRate, drawRate, lossRate, ppg: 3 * winRate + drawRate, totOver, ownOver, bttsRate: btts / n };
}

const _mean = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ---- settle any candidate market from a final score (mirrors mine-precursors)
// true=win, false=lose, null=push/void.
function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case '1X': return h >= a; case 'X2': return h <= a; case '12': return h !== a;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        default: {
            const m = /^(O|U|HO|HU|AO|AU) (\d\.5)$/.exec(market);
            if (!m) throw new Error('unknown market ' + market);
            const L = Number(m[2]);
            const side = (m[1] === 'O' || m[1] === 'U') ? tot : (m[1][0] === 'H' ? h : a);
            return (m[1].endsWith('O')) ? side > L : side < L;
        }
    }
}

// ---- per-fixture leak-free feature bundle (subset of mine-precursors) --------
function buildFeatures(f, byTeam) {
    const cutoff = new Date(f.kickoff).getTime();
    const H = teamShape(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, WINDOW);
    const A = teamShape(byTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id, cutoff, WINDOW);
    const cap = Math.min(H.n || 0, A.n || 0);
    if (cap < 1) return null;
    const hh = h2hOutcomeAggregates(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, 5);

    const s1 = _mean([H.winRate, A.lossRate, hh.n ? hh.homeWinRate : null]);   // home-win support
    const s2 = _mean([H.lossRate, A.winRate, hh.n ? hh.awayWinRate : null]);   // away-win support
    const sup = {
        '1X': s2 == null ? null : 1 - s2,
        'U 3.5': null,
        'O 2.5': _mean([H.totOver[2.5], A.totOver[2.5], hh.n ? hh.overRates?.[2.5] : null]),
    };
    const sO35 = _mean([H.totOver[3.5], A.totOver[3.5], hh.n ? hh.overRates?.[3.5] : null]);
    sup['U 3.5'] = sO35 == null ? null : 1 - sO35;

    return {
        id: f.id, h: f.ft_home, a: f.ft_away,
        day: new Date(f.kickoff).toISOString().slice(0, 10),
        minN: cap, h2hN: hh.n || 0, sup,
        formGap: (H.ppg != null && A.ppg != null) ? H.ppg - A.ppg : null,
        homeOver25: H.totOver[2.5], awayOver25: A.totOver[2.5],
        friendly: f.league_name != null && TIP_CONTEXT_EXCLUDE.test(f.league_name),
    };
}

// ---- the three boosters (docs/precursor-patterns.md Verdict §i) -------------
// Each: primary gate = the exact condition behind the published OOS number;
// `variant` = the prose's alternate phrasing, reported alongside for honesty.
const BOOSTERS = [
    {
        id: 'B1-home-fav-1X',
        name: 'Strong-home-favourite -> 1X  (form-gap >= 1.0)',
        market: '1X',
        oos: '83.2% OOS (n=475), +15.5pp base / +3.6pp mkt',
        gate: r => r.formGap != null && r.formGap >= 1.0,
        variant: { name: '1X blended support >= 0.8', gate: r => r.sup['1X'] != null && r.sup['1X'] >= 0.8 },
    },
    {
        id: 'B2-comp-O25',
        name: 'Competitive-league -> O 2.5  (blended O2.5 support >= 0.75, not friendly)',
        market: 'O 2.5',
        oos: '73.4% OOS (n=590), +14.9pp base',
        gate: r => !r.friendly && r.sup['O 2.5'] != null && r.sup['O 2.5'] >= 0.75,
        variant: { name: 'both teams over-2.5 rate >= 0.75, not friendly', gate: r => !r.friendly && r.homeOver25 != null && r.awayOver25 != null && r.homeOver25 >= 0.75 && r.awayOver25 >= 0.75 },
    },
    {
        id: 'B3-deep-under-U35',
        name: 'Deep-Under -> U 3.5  (blended U3.5 support >= 0.7)',
        market: 'U 3.5',
        oos: '71.2% OOS (n=1892), +9.7pp base / +2.8pp mkt',
        gate: r => r.sup['U 3.5'] != null && r.sup['U 3.5'] >= 0.7,
        variant: null,
    },
];

// ---- leave-one-day-out jackknife: drop each day, recompute lift. A booster
// whose lift sign survives every single-day removal is not a one-lucky-day
// artifact. Returns the min/max lift across removals and whether the sign held.
function lodoJackknife(gated, baseByDay) {
    const days = [...new Set(gated.map(r => r.day))];
    if (days.length < 2) return { days: days.length, minLift: null, maxLift: null, signHolds: null };
    const liftWithout = d => {
        const g = gated.filter(r => r.day !== d);
        if (!g.length) return null;
        const gr = hitRate(g);
        const bRows = g.flatMap(r => baseByDay.get(r.day) ?? []);
        const br = hitRate(bRows);
        return gr == null || br == null ? null : gr - br;
    };
    const lifts = days.map(liftWithout).filter(v => v != null);
    if (!lifts.length) return { days: days.length, minLift: null, maxLift: null, signHolds: null };
    const minLift = Math.min(...lifts), maxLift = Math.max(...lifts);
    const full = (() => { const gr = hitRate(gated); const br = hitRate(gated.flatMap(r => baseByDay.get(r.day) ?? [])); return gr - br; })();
    return { days: days.length, minLift, maxLift, signHolds: (full >= 0) ? minLift > 0 : maxLift < 0 };
}

// Live classification, adapted from mine-rules.classifyPattern for a fixed
// pre-registered gate on a single live window (there is no warehouse train
// split here — the warehouse WAS the train; this is the fresh live test).
function classifyLive({ n, liftLo, medPrice, flatEv: e }) {
    if (n < 40) return 'underpowered';
    if (liftLo == null || liftLo <= 0) return 'refuted';           // lift CI includes 0
    if (medPrice == null || medPrice < BETTABLE_FLOOR) return 'unbettable';
    if (e == null) return 'refuted';
    return e > 0 ? 'edge' : 'booster';
}

try {
    // ---------- load finished fixtures + reconstruct features ----------
    const fixtures = await db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .orderBy('f.kickoff')
        .select('f.id', 'f.home_team_id', 'f.away_team_id', 'f.ft_home', 'f.ft_away', 'f.kickoff', 'l.name as league_name');
    const byTeam = new Map();
    for (const f of fixtures) for (const t of [f.home_team_id, f.away_team_id]) {
        let l = byTeam.get(t); if (!l) byTeam.set(t, l = []); l.push(f);
    }
    const featById = new Map();
    for (const f of fixtures) { const r = buildFeatures(f, byTeam); if (r) featById.set(f.id, r); }
    console.log(`Finished fixtures: ${fixtures.length};  leak-free reconstructed: ${featById.size}`);

    // ---------- price attach (mirrors mine-precursors Tier B) ----------
    const linkedRows = await db('matches as m')
        .join('odds_markets as om', 'om.match_id', 'm.id')
        .join('fixtures as f', 'f.id', 'm.fixture_id')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('m.fixture_id', 'om.type_name', 'om.name', 'om.handicap', 'om.price', 'om.is_stale');
    const price = new Map(); // fid -> { key -> maxFreshPrice }
    const bump = (fid, key, p) => {
        if (key == null || !(Number(p) > 1)) return;
        let mp = price.get(fid); if (!mp) price.set(fid, mp = {});
        if (mp[key] == null || Number(p) > mp[key]) mp[key] = Number(p);
    };
    for (const r of linkedRows) {
        if (r.is_stale) continue;
        const k = marketKey(r); if (k) bump(r.fixture_id, k, r.price);
    }
    console.log(`Fixtures with any fresh canonical price: ${price.size}`);

    // ---------- detect the TIP_MIN_PRICE regime break on the settled ledger ----------
    const ledger = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome')
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"),
            'p.fixture_id', 'p.tip_market', 'p.tip_price', 'p.tip_outcome');
    const dayMin = new Map();
    for (const t of ledger) {
        const p = Number(t.tip_price);
        dayMin.set(t.day, Math.min(dayMin.get(t.day) ?? Infinity, p));
    }
    const ledgerDays = [...dayMin.keys()].sort();
    // regime break = first day whose per-day min price jumps >= 0.10 above the running floor
    let breakDay = null, floor0 = dayMin.get(ledgerDays[0]);
    for (const d of ledgerDays) { if (dayMin.get(d) >= floor0 + 0.10) { breakDay = d; break; } }
    const recentDays = new Set(breakDay ? ledgerDays.filter(d => d >= breakDay) : ledgerDays);
    console.log('\n================= POLICY-REGIME NOTICE =================');
    if (breakDay) {
        console.log(`Detected a tip price-floor break at ${breakDay} (per-day min price`);
        console.log(`jumped from ~${floor0.toFixed(2)} to >=${dayMin.get(breakDay).toFixed(2)}). This is the`);
        console.log(`TIP_MIN_PRICE 1.20->1.35 change. RECENT regime = ${[...recentDays].sort()[0]}..${[...recentDays].sort().at(-1)}`);
        console.log(`(${recentDays.size} days). Lens B headlines this regime; Lens A (linked-with-`);
        console.log(`odds) is NOT gated by TIP_MIN_PRICE and uses the full window.`);
    } else {
        console.log('No price-floor break detected; the ledger is one regime.');
    }
    console.log('=======================================================');

    // ================= LENS A: linked-with-odds finished fixtures =================
    // Well-powered, price-robust. For each booster: gated rows {day,hit,price},
    // base rows = ALL priced fixtures offering that market (unconditional live
    // rate on the same days), lift CI, EV CI, LODO jackknife, recency split.
    console.log('\n\n############ LENS A — linked-with-odds fixtures (price-robust, well-powered) ############');
    const linkedFeat = [...featById.values()].filter(r => price.has(r.id));
    const linkedDaysSorted = [...new Set(linkedFeat.map(r => r.day))].sort();
    const recencyCut = linkedDaysSorted[Math.floor(linkedDaysSorted.length / 2)]; // split window in half by days
    console.log(`Reconstructed + priced fixtures: ${linkedFeat.length}  over ${linkedDaysSorted.length} days`);
    console.log(`Recency split at ${recencyCut} (early < cut <= recent)\n`);

    const results = [];
    const runGateLensA = (market, gate) => {
        const gated = [], base = [];
        for (const r of linkedFeat) {
            const p = price.get(r.id)?.[market];
            if (!(p > 1)) continue;                    // market must be offered/priced
            const res = settle(market, r.h, r.a); if (res == null) continue;
            const row = { day: r.day, hit: !!res, price: p };
            base.push(row);
            if (r.minN >= 5 && gate(r)) gated.push(row);
        }
        if (!gated.length) return null;
        const baseByDay = new Map();
        for (const b of base) { if (!baseByDay.has(b.day)) baseByDay.set(b.day, []); baseByDay.get(b.day).push(b); }
        // lift = gated hit-rate - unconditional base hit-rate, day-clustered CI on the SAME days
        const liftStat = sample => {
            const p = hitRate(sample); if (p == null) return null;
            const b = hitRate(sample.flatMap(r => baseByDay.get(r.day) ?? [])); return b == null ? null : p - b;
        };
        const liftCi = dayClusteredBootstrap(gated, liftStat, { draws: 2000, seed: 42 });
        const evCi = dayClusteredBootstrap(gated, flatEv, { draws: 2000, seed: 7 });
        const bettable = gated.filter(r => r.price >= BETTABLE_FLOOR);
        const prices = gated.map(r => r.price).sort((a, b) => a - b);
        const medPrice = prices[Math.floor(prices.length / 2)];
        const jack = lodoJackknife(gated, baseByDay);
        // recency split
        const gRecent = gated.filter(r => r.day >= recencyCut), gEarly = gated.filter(r => r.day < recencyCut);
        return {
            n: gated.length, hit: hitRate(gated), base: hitRate(base),
            lift: liftCi.point, liftLo: liftCi.lo, liftHi: liftCi.hi,
            medPrice, flatEv: flatEv(gated), evLo: evCi.lo, evHi: evCi.hi,
            bettN: bettable.length, bettHit: hitRate(bettable), bettEv: flatEv(bettable),
            jack, recent: { n: gRecent.length, hit: hitRate(gRecent) }, early: { n: gEarly.length, hit: hitRate(gEarly) },
        };
    };

    for (const B of BOOSTERS) {
        console.log(`\n--- ${B.id}: ${B.name}`);
        console.log(`    warehouse: ${B.oos}`);
        const variants = [{ name: 'PRIMARY', gate: B.gate }, ...(B.variant ? [{ name: 'variant: ' + B.variant.name, gate: B.variant.gate }] : [])];
        for (const v of variants) {
            const a = runGateLensA(B.market, v.gate);
            if (!a) { console.log(`    [${v.name}] no gated fixtures offered ${B.market}`); continue; }
            const klass = classifyLive({ n: a.n, liftLo: a.liftLo, medPrice: a.medPrice, flatEv: a.flatEv });
            console.log(`    [${v.name}]  n=${a.n}  hit ${pct(a.hit)}  vs base ${pct(a.base)}  lift ${pp(a.lift)} CI[${pp(a.liftLo)},${pp(a.liftHi)}]`);
            console.log(`        medPrice ${a.medPrice?.toFixed(2)}  flatEV ${ev(a.flatEv)} CI[${ev(a.evLo)},${ev(a.evHi)}]  bettable(>=1.20) n=${a.bettN} hit ${pct(a.bettHit)} EV ${ev(a.bettEv)}`);
            console.log(`        LODO jackknife: ${a.jack.days} days, lift range [${pp(a.jack.minLift)},${pp(a.jack.maxLift)}], sign holds: ${a.jack.signHolds}`);
            console.log(`        recency: early n=${a.early.n} hit ${pct(a.early.hit)}  |  recent n=${a.recent.n} hit ${pct(a.recent.hit)}`);
            console.log(`        => CLASS: ${klass.toUpperCase()}`);
            if (v.name === 'PRIMARY') results.push({ booster: B.id, market: B.market, lensA: a, klass });
        }
    }

    // ================= LENS B: settled-tip ledger, RECENT REGIME =================
    // Decision-relevant: among tips of the booster's market, does the gate
    // discriminate hit-rate? Headlines the recent regime (abides to trajectory).
    console.log('\n\n############ LENS B — settled-tip ledger, RECENT regime (abides to trajectory) ############');
    const tipHitBool = o => o === 'hit';                 // void excluded below
    const lensB = (market, gate, dayset) => {
        const pool = ledger.filter(t => t.tip_market === market && t.tip_outcome !== 'void' && dayset.has(t.day) && featById.has(t.fixture_id));
        const gated = pool.filter(t => { const f = featById.get(t.fixture_id); return f.minN >= 5 && gate(f); });
        const ungated = pool.filter(t => !gated.includes(t));
        const hr = arr => arr.length ? arr.reduce((s, t) => s + (tipHitBool(t.tip_outcome) ? 1 : 0), 0) / arr.length : null;
        return { poolN: pool.length, gatedN: gated.length, gatedHit: hr(gated), ungatedHit: hr(ungated), poolHit: hr(pool) };
    };
    for (const B of BOOSTERS) {
        const rec = lensB(B.market, B.gate, recentDays);
        const full = lensB(B.market, B.gate, new Set(ledgerDays));
        console.log(`\n--- ${B.id} (${B.market} tips)`);
        console.log(`    RECENT regime: pool n=${rec.poolN} (${pct(rec.poolHit)}) | gated n=${rec.gatedN} hit ${pct(rec.gatedHit)} vs ungated n=${rec.poolN - rec.gatedN} hit ${pct(rec.ungatedHit)}  disc ${pp(rec.gatedHit != null && rec.ungatedHit != null ? rec.gatedHit - rec.ungatedHit : null)}`);
        console.log(`    FULL window:   pool n=${full.poolN} (${pct(full.poolHit)}) | gated n=${full.gatedN} hit ${pct(full.gatedHit)} vs ungated hit ${pct(full.ungatedHit)}  disc ${pp(full.gatedHit != null && full.ungatedHit != null ? full.gatedHit - full.ungatedHit : null)}`);
        const r = results.find(x => x.booster === B.id); if (r) { r.lensBRecent = rec; r.lensBFull = full; }
    }

    // ---------- verdict ----------
    console.log('\n\n############ VERDICT ############');
    for (const r of results) {
        const a = r.lensA;
        console.log(`${r.booster.padEnd(20)} ${r.klass.toUpperCase().padEnd(12)} lift ${pp(a.lift)} CI[${pp(a.liftLo)},${pp(a.liftHi)}]  EV ${ev(a.flatEv)}  recent-lens-B gated n=${r.lensBRecent?.gatedN ?? 0} disc ${pp(r.lensBRecent && r.lensBRecent.gatedHit != null && r.lensBRecent.ungatedHit != null ? r.lensBRecent.gatedHit - r.lensBRecent.ungatedHit : null)}`);
    }

    mkdirSync('tmp/sure-win', { recursive: true });
    writeFileSync('tmp/booster-validation.json', JSON.stringify({ breakDay, recentDays: [...recentDays], results }, null, 0));
    console.log('\nWrote tmp/booster-validation.json');
} finally {
    await closeDb();
}
