// Tier-A/Tier-B precursor mine, PROMOTED VERBATIM from tmp/precursor-mine.mjs
// (2026-07-14) - it was gitignored and one `git clean` from oblivion. This is
// the harness behind docs/precursor-patterns.md: 203 enumerated candidates
// over a leak-free warehouse reconstruction, temporal OOS + day-clustered
// bootstrap + BH-FDR at q=0.10, then a price-aware Tier B.
//
// Deliberately NOT refactored during the M4.2 promotion. Its numbers are
// published in docs/precursor-patterns.md; a rewrite would invalidate that
// provenance for zero gain. Read-only: no writes, no API calls.
//
// It mines the WAREHOUSE reconstruction (raw team aggregates). The companion
// scripts/mine-patterns.js mines the TIP LEDGER (tip_breakdown, runners-up,
// AI verdicts) - a surface this one never touches. See
// docs/emergence-patterns-findings.md.
//
//   node scripts/mine-precursors.js
//
// NB it writes its JSON output to tmp/ (gitignored), which must exist.
// READ-ONLY precursor-pattern mine for docs/precursor-patterns.md.
// Two tiers:
//   TIER A (deep, price-blind): 25,952 finished fixtures. Leak-free pre-kickoff
//     features -> candidate (market, condition) grid. Temporal 70/30 OOS split,
//     day-clustered bootstrap CIs, BH-FDR multiple-comparisons control.
//   TIER B (shallow, price-aware): the ~1,472 finished fixtures linked to a
//     bookmaker match with real odds. Attach median price, devigged market
//     baseline, bettable-slice (>=1.20) precision + flat-stake EV.
// Reuses the project's own leak-free reconstruction idioms (teamShape mirrors
// backtest-sure-tips; h2hOutcomeAggregates from src/db/tip-rules). No writes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { h2hOutcomeAggregates } from '../src/db/tip-rules.js';
import { TIP_CONTEXT_EXCLUDE } from '../src/db/tip-rules.js';
import { marketKey } from '../src/markets.js';

const WINDOW = 7;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const pct = v => (v == null ? ' n/a' : (100 * v).toFixed(1) + '%');

// ---- Wilson lower bound (honest "at least this good") -----------------------
function wilsonLower(hits, n, z = 1.96) {
    if (!n) return 0;
    const p = hits / n, z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (centre - margin) / (1 + z2 / n));
}

// ---- leak-free per-team shape (vs-others, strict kickoff cutoff) ------------
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
    return {
        n, winRate, drawRate, lossRate,
        ppg: 3 * winRate + drawRate,
        gfAvg: gf / n, gaAvg: ga / n, scoredRate: scored / n, bttsRate: btts / n, totOver, ownOver,
    };
}

const _mean = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const _min = arr => { const v = arr.filter(x => x != null); return v.length ? Math.min(...v) : null; };

// ---- settle any candidate market from a final score -------------------------
// true=win, false=lose, null=push/void (excluded from precision).
function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case '1X': return h >= a; case 'X2': return h <= a; case '12': return h !== a;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        case 'DNB1': return h === a ? null : h > a; case 'DNB2': return h === a ? null : a > h;
        default: {
            const m = /^(O|U|HO|HU|AO|AU) (\d\.5)$/.exec(market);
            if (!m) throw new Error('unknown market ' + market);
            const L = Number(m[2]);
            const side = (m[1] === 'O' || m[1] === 'U') ? tot : (m[1][0] === 'H' ? h : a);
            return (m[1].endsWith('O')) ? side > L : side < L;
        }
    }
}

// ---- build the per-fixture leak-free feature/support bundle -----------------
function buildFeatures(f, byTeam) {
    const cutoff = new Date(f.kickoff).getTime();
    const H = teamShape(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, WINDOW);
    const A = teamShape(byTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id, cutoff, WINDOW);
    const cap = Math.min(H.n || 0, A.n || 0);
    if (cap < 1) return null;
    const hh = h2hOutcomeAggregates(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, 5);

    const s1 = _mean([H.winRate, A.lossRate, hh.n ? hh.homeWinRate : null]);
    const sX = _mean([H.drawRate, A.drawRate, hh.n ? hh.drawRate : null]);
    const s2 = _mean([H.lossRate, A.winRate, hh.n ? hh.awayWinRate : null]);
    const c1 = _min([H.winRate, A.lossRate]);   // concurrence = weakest team stream
    const c2 = _min([H.lossRate, A.winRate]);
    const sO = {}, cO = {};
    for (const L of OU_LINES) {
        sO[L] = _mean([H.totOver[L], A.totOver[L], hh.n ? hh.overRates?.[L] : null]);
        cO[L] = _min([H.totOver[L], A.totOver[L]]);
    }
    const gg = _mean([H.bttsRate, A.bttsRate]);

    const sup = {
        '1': s1, 'X': sX, '2': s2,
        '1X': s2 == null ? null : 1 - s2, 'X2': s1 == null ? null : 1 - s1, '12': sX == null ? null : 1 - sX,
        'GG': gg, 'NG': gg == null ? null : 1 - gg,
    };
    const con = {
        '1': c1, '2': c2,
        '1X': c2 == null ? null : 1 - c2, 'X2': c1 == null ? null : 1 - c1, '12': null,
        'GG': _min([H.bttsRate, A.bttsRate]), 'NG': null,
    };
    for (const L of OU_LINES) {
        sup[`O ${L}`] = sO[L]; sup[`U ${L}`] = sO[L] == null ? null : 1 - sO[L];
        con[`O ${L}`] = cO[L]; con[`U ${L}`] = cO[L] == null ? null : 1 - cO[L];
        sup[`HU ${L}`] = 1 - H.ownOver[L]; sup[`AU ${L}`] = 1 - A.ownOver[L];
    }
    // H2H support for the result markets (home-perspective), only if meetings exist
    const h2hSup = hh.n >= 3 ? { '1X': 1 - (hh.awayWinRate ?? 0), 'X2': 1 - (hh.homeWinRate ?? 0), '12': 1 - (hh.drawRate ?? 0), '1': hh.homeWinRate, '2': hh.awayWinRate } : null;

    return {
        id: f.id, h: f.ft_home, a: f.ft_away, league: f.league_name, ko: cutoff,
        day: new Date(f.kickoff).toISOString().slice(0, 10),
        minN: cap, h2hN: hh.n || 0, sup, con, h2hSup,
        formGap: (H.ppg != null && A.ppg != null) ? H.ppg - A.ppg : null,
        homeOver25: H.totOver[2.5], awayOver25: A.totOver[2.5],
        homeTot35: H.totOver[3.5], awayTot35: A.totOver[3.5],
        friendly: f.league_name != null && TIP_CONTEXT_EXCLUDE.test(f.league_name),
    };
}

// ---- candidate pattern definitions ------------------------------------------
// Each candidate: { id, market, test(row)->bool }. We ENUMERATE and count them.
const THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8];
const BASE_MARKETS = ['1', 'X', '2', '1X', 'X2', '12', 'O 1.5', 'O 2.5', 'U 3.5', 'U 4.5', 'GG', 'NG', 'HU 2.5', 'AU 2.5'];
const CONC_MARKETS = ['1', '2', '1X', 'X2', 'O 1.5', 'O 2.5', 'U 3.5', 'U 4.5', 'GG'];
const H2H_MARKETS = ['1X', 'X2', '12', 'O 2.5', 'U 3.5'];
const CTX_MARKETS = ['1', '2', '1X', 'X2', 'O 2.5', 'U 3.5'];

const candidates = [];
const add = (id, market, minN, fn) => candidates.push({ id, market, minN, test: fn });
// (a) base support >= T, minN>=5
for (const m of BASE_MARKETS) for (const T of THRESHOLDS)
    add(`base:${m}>=${T}`, m, 5, r => r.sup[m] != null && r.sup[m] >= T);
// (b) support>=T AND concurrence>=Tc (both team streams agree)
for (const m of CONC_MARKETS) for (const T of THRESHOLDS) for (const Tc of [0.5, 0.6])
    add(`conc:${m}>=${T}&c>=${Tc}`, m, 5, r => r.sup[m] != null && r.sup[m] >= T && r.con[m] != null && r.con[m] >= Tc);
// (c) support>=T AND not friendly/youth
for (const m of CTX_MARKETS) for (const T of [0.7, 0.75, 0.8])
    add(`ctx:${m}>=${T}&comp`, m, 5, r => !r.friendly && r.sup[m] != null && r.sup[m] >= T);
// (d) support>=T AND H2H (>=3) agrees (h2hSup>=0.5)
for (const m of H2H_MARKETS) for (const T of [0.65, 0.7, 0.75])
    add(`h2h:${m}>=${T}&hh`, m, 5, r => r.h2hN >= 3 && r.h2hSup && r.h2hSup[m] != null && r.h2hSup[m] >= 0.5 && r.sup[m] != null && r.sup[m] >= T);
// (e) explicit form-gap (standings/form proxy) -> double chance
for (const g of [1.0, 1.5, 2.0]) {
    add(`formgap:H+${g}->1X`, '1X', 5, r => r.formGap != null && r.formGap >= g);
    add(`formgap:A+${g}->X2`, 'X2', 5, r => r.formGap != null && r.formGap <= -g);
}
// (f) explicit both-teams over/under (the hot-pick-style AND gate)
for (const th of [0.6, 0.7]) add(`bothover:${th}->O2.5`, 'O 2.5', 5, r => r.homeOver25 != null && r.awayOver25 != null && r.homeOver25 >= th && r.awayOver25 >= th);
for (const th of [0.4, 0.3]) add(`bothunder:${th}->U3.5`, 'U 3.5', 5, r => r.homeTot35 != null && r.awayTot35 != null && r.homeTot35 <= th && r.awayTot35 <= th);

// ---- day-clustered bootstrap -------------------------------------------------
// Given per-day {hits, n} for the pattern and per-day {baseHits, baseN} for the
// unconditional market rate, resample DAYS with replacement -> CI on precision
// and one-sided bootstrap p for (precision - baseRate) <= 0.
function dayBootstrap(dayStats, B = 1000, seed = 12345) {
    const days = Object.keys(dayStats);
    if (!days.length) return null;
    let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const precs = [], lifts = [];
    for (let b = 0; b < B; b++) {
        let hits = 0, n = 0, bHits = 0, bN = 0;
        for (let i = 0; i < days.length; i++) {
            const d = days[Math.floor(rnd() * days.length)];
            const st = dayStats[d];
            hits += st.hits; n += st.n; bHits += st.baseHits; bN += st.baseN;
        }
        if (n > 0 && bN > 0) { const p = hits / n, base = bHits / bN; precs.push(p); lifts.push(p - base); }
    }
    precs.sort((x, y) => x - y); lifts.sort((x, y) => x - y);
    const q = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(p * arr.length)))];
    const pOneSided = lifts.filter(l => l <= 0).length / lifts.length; // share of resamples with no lift
    return { precLo: q(precs, 0.025), precHi: q(precs, 0.975), liftLo: q(lifts, 0.025), liftHi: q(lifts, 0.975), pBoot: pOneSided };
}

// ---- Benjamini-Hochberg FDR --------------------------------------------------
function bhReject(items, q = 0.10) {
    const sorted = [...items].sort((a, b) => a.p - b.p);
    const mTot = sorted.length; let kMax = -1;
    for (let i = 0; i < mTot; i++) if (sorted[i].p <= (i + 1) / mTot * q) kMax = i;
    const thr = kMax >= 0 ? sorted[kMax].p : -1;
    for (const it of items) it.bhReject = it.p <= thr;
    return thr;
}

try {
    // ---------- load finished fixtures (+ league name) ----------
    const fixtures = await db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .orderBy('f.kickoff')
        .select('f.id', 'f.home_team_id', 'f.away_team_id', 'f.ft_home', 'f.ft_away', 'f.kickoff', 'f.league_id', 'l.name as league_name');
    console.log(`Finished-fixture pool: ${fixtures.length}`);

    const byTeam = new Map();
    for (const f of fixtures) for (const t of [f.home_team_id, f.away_team_id]) {
        let l = byTeam.get(t); if (!l) byTeam.set(t, l = []); l.push(f);
    }

    const rows = [];
    for (const f of fixtures) { const r = buildFeatures(f, byTeam); if (r) rows.push(r); }
    console.log(`Reconstructed leak-free evidence: ${rows.length} fixtures (both sides had history)\n`);

    // temporal split (rows are kickoff-ordered)
    const cut = Math.floor(rows.length * 0.7);
    const train = rows.slice(0, cut), test = rows.slice(cut);
    console.log(`TRAIN ${train.length} (${train[0].day}..${train[cut - 1].day})  |  TEST ${test.length} (${test[0].day}..${test[test.length - 1].day})`);

    // unconditional base rate per market on TEST + per-day base tallies
    const testDays = [...new Set(test.map(r => r.day))];
    const baseDayByMarket = {}; // market -> day -> {baseHits, baseN}
    const baseRate = {};
    const ALL_MARKETS = [...new Set(candidates.map(c => c.market))];
    for (const m of ALL_MARKETS) {
        baseDayByMarket[m] = {}; let bh = 0, bn = 0;
        for (const r of test) {
            const res = settle(m, r.h, r.a); if (res == null) continue;
            const d = baseDayByMarket[m][r.day] ?? (baseDayByMarket[m][r.day] = { baseHits: 0, baseN: 0 });
            d.baseN++; bn++; if (res) { d.baseHits++; bh++; }
        }
        baseRate[m] = bn ? bh / bn : null;
    }

    // ---------- evaluate every candidate ----------
    const MIN_TRAIN = 200, MIN_TEST = 80;
    const evalGate = (pool, c) => {
        let n = 0, hits = 0;
        for (const r of pool) {
            if (r.minN < c.minN) continue;
            if (!c.test(r)) continue;
            const res = settle(c.market, r.h, r.a); if (res == null) continue;
            n++; if (res) hits++;
        }
        return { n, hits, prec: n ? hits / n : null };
    };

    const evaluated = [];
    for (const c of candidates) {
        const tr = evalGate(train, c), te = evalGate(test, c);
        const row = { id: c.id, market: c.market, trainN: tr.n, trainPrec: tr.prec, testN: te.n, testHits: te.hits, testPrec: te.prec, base: baseRate[c.market] };
        evaluated.push(row);
        if (tr.n < MIN_TRAIN || te.n < MIN_TEST) { row.tested = false; continue; }
        row.tested = true;
        // per-day pattern stats on TEST, merged with base tallies
        const dayStats = {};
        for (const r of test) {
            if (r.minN < c.minN || !c.test(r)) continue;
            const res = settle(c.market, r.h, r.a); if (res == null) continue;
            const d = dayStats[r.day] ?? (dayStats[r.day] = { hits: 0, n: 0, baseHits: 0, baseN: 0 });
            d.n++; if (res) d.hits++;
        }
        // attach same-day base rate to each pattern-day
        for (const d of Object.keys(dayStats)) {
            const b = baseDayByMarket[c.market][d]; if (b) { dayStats[d].baseHits = b.baseHits; dayStats[d].baseN = b.baseN; }
        }
        const bs = dayBootstrap(dayStats);
        row.testWLo = wilsonLower(te.hits, te.n);
        row.precLo = bs?.precLo; row.precHi = bs?.precHi; row.liftLo = bs?.liftLo; row.liftHi = bs?.liftHi; row.pBoot = bs?.pBoot;
        row.lift = te.prec - baseRate[c.market];
        // OOS stability: test precision not materially below train
        row.oosHolds = te.prec != null && tr.prec != null && (te.prec >= tr.prec - 0.05);
    }

    // BH-FDR over tested candidates
    const testedRows = evaluated.filter(r => r.tested);
    const fdrThr = bhReject(testedRows.map(r => ({ ref: r, p: r.pBoot ?? 1 })), 0.10);
    for (const r of testedRows) r.bhReject = (r.pBoot ?? 1) <= fdrThr;

    // survivor: OOS holds AND lift CI lower bound > 0 AND passes BH-FDR
    for (const r of testedRows) r.survivor = r.oosHolds && (r.liftLo != null && r.liftLo > 0) && r.bhReject;

    console.log(`\nCandidates enumerated: ${candidates.length}`);
    console.log(`Candidates clearing volume floor (train>=${MIN_TRAIN}, test>=${MIN_TEST}) and tested: ${testedRows.length}`);
    console.log(`BH-FDR (q=0.10) rejection threshold p<=${fdrThr < 0 ? 'none' : fdrThr.toFixed(4)}`);

    // ---------- TIER A results table ----------
    console.log('\n=== TIER A SURVIVORS (OOS holds + lift CI>0 + BH-FDR) ===');
    console.log('id                         market  base   train   test   testWLo  lift[CI]                 pBoot');
    const survivors = testedRows.filter(r => r.survivor).sort((a, b) => b.lift - a.lift);
    for (const r of survivors) {
        console.log(`  ${r.id.padEnd(26)} ${r.market.padEnd(6)} ${pct(r.base).padStart(5)} ${pct(r.trainPrec).padStart(6)} ${pct(r.testPrec).padStart(6)} ${pct(r.testWLo).padStart(6)}  +${(100 * r.lift).toFixed(1)}pp [${(100 * r.liftLo).toFixed(1)},${(100 * r.liftHi).toFixed(1)}]  ${(r.pBoot).toFixed(3)}  n=${r.testN}`);
    }
    console.log(`\n  ${survivors.length} survivors.`);

    // show near-misses (tested, OOS holds, lift>0 but failed CI or FDR) for honesty
    const nearMiss = testedRows.filter(r => !r.survivor && r.oosHolds && r.lift > 0.02 && r.testN >= 100).sort((a, b) => b.lift - a.lift).slice(0, 12);
    console.log('\n=== NEAR-MISSES (positive lift but failed CI-lower>0 or FDR) ===');
    for (const r of nearMiss) {
        console.log(`  ${r.id.padEnd(26)} ${r.market.padEnd(6)} base ${pct(r.base)} test ${pct(r.testPrec)} lift +${(100 * r.lift).toFixed(1)}pp liftLo ${(100 * (r.liftLo ?? 0)).toFixed(1)}pp pBoot ${(r.pBoot ?? 1).toFixed(3)} fdr=${r.bhReject} n=${r.testN}`);
    }

    mkdirSync('tmp/sure-win', { recursive: true });
    writeFileSync('tmp/precursor-tierA.json', JSON.stringify({ pool: rows.length, enumerated: candidates.length, tested: testedRows.length, fdrThr, evaluated }, null, 0));
    console.log('\nWrote tmp/precursor-tierA.json');

    // ==================== TIER B: PRICE ATTACH ====================
    // Real offered prices exist only for finished fixtures linked to a scraped
    // bookmaker match (odds_markets), i.e. the ~13-day Jul 2-14 window.
    console.log('\n\n========== TIER B: PRICE-AWARE (linked-with-odds slice) ==========');
    const linkedRows = await db('matches as m')
        .join('odds_markets as om', 'om.match_id', 'm.id')
        .join('fixtures as f', 'f.id', 'm.fixture_id')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price', 'om.is_stale');
    // best (max) fresh price per (fixture, canonical key); BTTS handled specially
    const price = new Map(); // fid -> { key -> maxPrice }
    const bump = (fid, key, p) => {
        if (key == null || !(Number(p) > 1)) return;
        let mp = price.get(fid); if (!mp) price.set(fid, mp = {});
        if (mp[key] == null || Number(p) > mp[key]) mp[key] = Number(p);
    };
    const BTTS_NAMES = new Set(['BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score | Full Time', 'Both Teams to Score | Full Time']);
    for (const r of linkedRows) {
        if (r.is_stale) continue;
        const k = marketKey(r);
        if (k) { bump(r.fixture_id, k, r.price); continue; }
        if (BTTS_NAMES.has(r.type_name)) {
            const nm = String(r.name).toLowerCase();
            if (/^(gg|yes)/.test(nm)) bump(r.fixture_id, 'GG', r.price);
            else if (/^(ng|no)/.test(nm)) bump(r.fixture_id, 'NG', r.price);
        }
    }
    console.log(`Fixtures with any fresh canonical price: ${price.size}`);

    const _devig = ps => { const inv = ps.map(p => (Number(p) > 1 ? 1 / Number(p) : null)); if (inv.some(v => v == null)) return null; const s = inv.reduce((a, b) => a + b, 0); return inv.map(v => v / s); };
    // devigged market prob of `market` from a fixture's own book
    function devigProb(mp, market) {
        const t = _devig([mp['1'], mp['X'], mp['2']]);
        if (['1', 'X', '2'].includes(market) && t) return t[{ '1': 0, 'X': 1, '2': 2 }[market]];
        if (market === '1X') return t ? t[0] + t[1] : (_devig([mp['1X'], mp['X2'], mp['12']]) || [])[0] ?? null;
        if (market === 'X2') return t ? t[1] + t[2] : (_devig([mp['1X'], mp['X2'], mp['12']]) || [])[1] ?? null;
        if (market === '12') return t ? t[0] + t[2] : (_devig([mp['1X'], mp['X2'], mp['12']]) || [])[2] ?? null;
        const ou = /^([OU]) (\d\.5)$/.exec(market);
        if (ou) { const d = _devig([mp['O ' + ou[2]], mp['U ' + ou[2]]]); return d ? d[ou[1] === 'O' ? 0 : 1] : null; }
        if (market === 'GG' || market === 'NG') { const d = _devig([mp['GG'], mp['NG']]); return d ? d[market === 'GG' ? 0 : 1] : null; }
        return null;
    }

    // linked reconstructed rows (features), keyed by presence of a price map
    const linkedFeat = rows.filter(r => price.has(r.id));
    console.log(`Reconstructed + priced fixtures: ${linkedFeat.length}\n`);

    // pattern families to price (bettable markets among Tier A survivors)
    const FAMILIES = [
        ['1X sup>=0.8', '1X', r => r.sup['1X'] != null && r.sup['1X'] >= 0.8],
        ['1X formgap H+1', '1X', r => r.formGap != null && r.formGap >= 1.0],
        ['X2 sup>=0.8', 'X2', r => r.sup['X2'] != null && r.sup['X2'] >= 0.8],
        ['X2 formgap A+1', 'X2', r => r.formGap != null && r.formGap <= -1.0],
        ['1 sup>=0.65', '1', r => r.sup['1'] != null && r.sup['1'] >= 0.65],
        ['2 sup>=0.65', '2', r => r.sup['2'] != null && r.sup['2'] >= 0.65],
        ['12 sup>=0.8', '12', r => r.sup['12'] != null && r.sup['12'] >= 0.8],
        ['O 2.5 sup>=0.75 comp', 'O 2.5', r => !r.friendly && r.sup['O 2.5'] != null && r.sup['O 2.5'] >= 0.75],
        ['O 2.5 both>=0.7', 'O 2.5', r => r.homeOver25 >= 0.7 && r.awayOver25 >= 0.7],
        ['U 3.5 sup>=0.7', 'U 3.5', r => r.sup['U 3.5'] != null && r.sup['U 3.5'] >= 0.7],
        ['U 4.5 sup>=0.8', 'U 4.5', r => r.sup['U 4.5'] != null && r.sup['U 4.5'] >= 0.8],
        ['GG sup>=0.6', 'GG', r => r.sup['GG'] != null && r.sup['GG'] >= 0.6],
    ];
    const med = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    console.log('family                  market  n   prec    medPr  mktDevig  lift/mkt   bettable(>=1.20): n prec  flatEV   allEV');
    const tierB = [];
    for (const [name, market, testFn] of FAMILIES) {
        let n = 0, hits = 0; const prices = [], devigs = []; let bn = 0, bh = 0, bEvSum = 0, allEvSum = 0, allN = 0;
        for (const r of linkedFeat) {
            if (r.minN < 5 || !testFn(r)) continue;
            const mp = price.get(r.id); const p = mp[market];
            if (!(p > 1)) continue;                 // not offered / unbettable
            const res = settle(market, r.h, r.a); if (res == null) continue;
            n++; if (res) hits++; prices.push(p);
            const dv = devigProb(mp, market); if (dv != null) devigs.push(dv);
            allN++; allEvSum += (res ? p - 1 : -1);
            if (p >= 1.20) { bn++; if (res) bh++; bEvSum += (res ? p - 1 : -1); }
        }
        if (!n) { console.log(`  ${name.padEnd(22)} ${market.padEnd(6)} 0`); continue; }
        const prec = hits / n, medPr = med(prices), mdev = devigs.length ? devigs.reduce((a, b) => a + b, 0) / devigs.length : null;
        const rec = { name, market, n, prec, wLo: wilsonLower(hits, n), medPr, mktDevig: mdev, liftVsMkt: mdev != null ? prec - mdev : null, bettN: bn, bettPrec: bn ? bh / bn : null, bettEV: bn ? bEvSum / bn : null, allEV: allN ? allEvSum / allN : null };
        tierB.push(rec);
        console.log(`  ${name.padEnd(22)} ${market.padEnd(6)} ${String(n).padStart(3)} ${pct(prec).padStart(6)} ${medPr.toFixed(2).padStart(6)}  ${pct(mdev).padStart(6)}   ${mdev != null ? ((prec - mdev >= 0 ? '+' : '') + (100 * (prec - mdev)).toFixed(1) + 'pp').padStart(7) : '  n/a '}   ${String(bn).padStart(3)} ${pct(bn ? bh / bn : null).padStart(6)}  ${bn ? ((bEvSum / bn >= 0 ? '+' : '') + (100 * bEvSum / bn).toFixed(1) + '%').padStart(6) : '  n/a'}  ${allN ? ((allEvSum / allN >= 0 ? '+' : '') + (100 * allEvSum / allN).toFixed(1) + '%') : ''}`);
    }

    // Live settled-tip hit-rate + flat ROI by market (real prices, the only ROI ground truth)
    const liveTips = await db('fixture_predictions as p').join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome').select('p.tip_market', 'p.tip_price', 'p.tip_outcome');
    const lm = {};
    for (const t of liveTips) { const b = lm[t.tip_market] ?? (lm[t.tip_market] = { n: 0, h: 0, ev: 0 }); b.n++; if (t.tip_outcome === 'hit') { b.h++; b.ev += Number(t.tip_price) - 1; } else b.ev -= 1; }
    console.log('\n=== LIVE SETTLED TIPS by market (real prices, flat 1u) ===');
    for (const m of Object.keys(lm).sort((a, b) => lm[b].n - lm[a].n)) {
        const b = lm[m];
        console.log(`  ${m.padEnd(8)} ${pct(b.h / b.n).padStart(6)} (${b.h}/${b.n})  flatEV ${((b.ev / b.n >= 0 ? '+' : '') + (100 * b.ev / b.n).toFixed(1))}%`);
    }

    writeFileSync('tmp/precursor-tierB.json', JSON.stringify({ priced: linkedFeat.length, tierB, live: lm }, null, 0));
    console.log('\nWrote tmp/precursor-tierB.json');
} finally {
    await closeDb();
}
