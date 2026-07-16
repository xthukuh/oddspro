// EDGE HUNT — the value-vs-market probe. READ-ONLY: no writes, no API calls.
//
//   node scripts/probe-value-edge.js
//
// THE IDEA (and why it is new). Every sort this project has ever shipped —
// `sure`, Safe-only, the hot-pick gate, and the three precursor boosters —
// selects on HIGH STATS SUPPORT (or confidence). docs/precursor-patterns.md
// proved that region lands in the CHEAP sub-1.20 tail, where EV is worst, and
// closed with the one door left open:
//
//   "A future 'value' sort would target MID-priced X2/O 2.5, not high stats
//    support."  (precursor-patterns.md, line 167)
//
// VALUE != CONFIDENCE. A confident tip (stats 0.90, market devig 0.88) is
// priced ~1.13 — unbettable. A VALUE tip (stats 0.60, market devig 0.50) is
// priced ~1.9 — bettable, and it only pays if our stats know something the
// book's devigged price does not. So we define, per (fixture, market):
//
//   value = stats_support - devigged_market_probability
//
// and ask the only question that has never been answered here: is there ANY
// (market, value-threshold) slice, restricted to a bettable price (>= 1.20),
// whose flat-stake EV at REAL prices is positive with a day-clustered CI
// clear of zero — AFTER a Benjamini-Hochberg control for the many slices we
// sweep? If yes, it is the first bettable +EV signal the project has found
// (EXPLORATORY: pre-registered here, ship only after an independent OOS
// confirmation — the honesty contract in src/db/mine-rules.js). If no, it is
// the definitive nail: even the theoretically-best value region is -EV, so
// the vig is unbeatable on these books, exactly as every prior audit warned.
//
// PRE-REGISTERED HYPOTHESIS (committed in this header before reading output):
//   H-VALUE:  E[flat EV | value >= d, price >= 1.20] > 0  for some market/d.
//   H-CALIB:  higher `value` predicts a higher (realized - devig) residual,
//             i.e. our stats add information the market has not already priced.
// Both are EXPLORATORY. A survivor is a candidate for a future pre-registered
// OOS test, never an insta-ship.
//
// Regime/recency discipline (the M4.2 lesson): TIP_MIN_PRICE gates the tip
// ledger, NOT this surface (all finished fixtures with real odds), so the full
// ~15-day window is one population here; we still report a recent-half split so
// nothing rides on the early window alone.
//
// Reconstruction (teamShape/settle/full support/devigProb) MIRRORS the frozen
// scripts/mine-precursors.js — same "mirror the idiom" pattern the mine uses;
// the pure statistics are imported VERBATIM from src/db/mine-rules.js.
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { h2hOutcomeAggregates } from '../src/db/tip-rules.js';
import { marketKey } from '../src/markets.js';
import { dayClusteredBootstrap, benjaminiHochberg, flatEv, hitRate, BETTABLE_FLOOR } from '../src/db/mine-rules.js';

const WINDOW = 7;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const pct = v => (v == null ? ' n/a' : (100 * v).toFixed(1) + '%');
const ev = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + '%');
const _mean = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

function teamShape(rows, teamId, oppId, cutoff, window) {
    const recent = rows
        .filter(f => f.ft_home != null && f.ft_away != null && new Date(f.kickoff).getTime() < cutoff
            && !((f.home_team_id === teamId && f.away_team_id === oppId) || (f.home_team_id === oppId && f.away_team_id === teamId)))
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime())
        .slice(0, window);
    const n = recent.length;
    const totOver = {};
    for (const L of OU_LINES) totOver[L] = 0;
    if (!n) return { n: 0 };
    let win = 0, draw = 0, btts = 0;
    for (const f of recent) {
        const home = f.home_team_id === teamId;
        const g = home ? f.ft_home : f.ft_away, c = home ? f.ft_away : f.ft_home, tot = g + c;
        if (g > c) win++; else if (g === c) draw++;
        if (g > 0 && c > 0) btts++;
        for (const L of OU_LINES) if (tot > L) totOver[L]++;
    }
    for (const L of OU_LINES) totOver[L] /= n;
    const winRate = win / n, drawRate = draw / n, lossRate = (n - win - draw) / n;
    return { n, winRate, drawRate, lossRate, totOver, bttsRate: btts / n };
}

function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case '1X': return h >= a; case 'X2': return h <= a; case '12': return h !== a;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        default: {
            const m = /^([OU]) (\d\.5)$/.exec(market);
            if (!m) throw new Error('unknown market ' + market);
            const L = Number(m[2]);
            return m[1] === 'O' ? tot > L : tot < L;
        }
    }
}

// full per-market stats support (mirrors mine-precursors buildFeatures `sup`)
function buildSupport(f, byTeam) {
    const cutoff = new Date(f.kickoff).getTime();
    const H = teamShape(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, WINDOW);
    const A = teamShape(byTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id, cutoff, WINDOW);
    const cap = Math.min(H.n || 0, A.n || 0);
    if (cap < 1) return null;
    const hh = h2hOutcomeAggregates(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, 5);
    const s1 = _mean([H.winRate, A.lossRate, hh.n ? hh.homeWinRate : null]);
    const sX = _mean([H.drawRate, A.drawRate, hh.n ? hh.drawRate : null]);
    const s2 = _mean([H.lossRate, A.winRate, hh.n ? hh.awayWinRate : null]);
    const gg = _mean([H.bttsRate, A.bttsRate]);
    const sup = {
        '1': s1, 'X': sX, '2': s2,
        '1X': s2 == null ? null : 1 - s2, 'X2': s1 == null ? null : 1 - s1, '12': sX == null ? null : 1 - sX,
        'GG': gg, 'NG': gg == null ? null : 1 - gg,
    };
    for (const L of OU_LINES) {
        const o = _mean([H.totOver[L], A.totOver[L], hh.n ? hh.overRates?.[L] : null]);
        sup[`O ${L}`] = o; sup[`U ${L}`] = o == null ? null : 1 - o;
    }
    return { id: f.id, h: f.ft_home, a: f.ft_away, day: new Date(f.kickoff).toISOString().slice(0, 10), minN: cap, sup };
}

// devigged market probability of `market` from a fixture's own book
// (mirrors mine-precursors devigProb).
const _devig = ps => { const inv = ps.map(p => (Number(p) > 1 ? 1 / Number(p) : null)); if (inv.some(v => v == null)) return null; const s = inv.reduce((a, b) => a + b, 0); return inv.map(v => v / s); };
function devigProb(mp, market) {
    const t = _devig([mp['1'], mp['X'], mp['2']]);
    if (['1', 'X', '2'].includes(market) && t) return t[{ '1': 0, 'X': 1, '2': 2 }[market]];
    if (market === '1X') return t ? t[0] + t[1] : null;
    if (market === 'X2') return t ? t[1] + t[2] : null;
    if (market === '12') return t ? t[0] + t[2] : null;
    const ou = /^([OU]) (\d\.5)$/.exec(market);
    if (ou) { const d = _devig([mp['O ' + ou[2]], mp['U ' + ou[2]]]); return d ? d[ou[1] === 'O' ? 0 : 1] : null; }
    if (market === 'GG' || market === 'NG') { const d = _devig([mp['GG'], mp['NG']]); return d ? d[market === 'GG' ? 0 : 1] : null; }
    return null;
}

const MARKETS = ['1', 'X', '2', '1X', 'X2', '12', 'O 1.5', 'O 2.5', 'O 3.5', 'U 2.5', 'U 3.5', 'U 4.5', 'GG', 'NG'];
const THRESHOLDS = [0.0, 0.03, 0.05, 0.08, 0.12];   // value = support - devig >= d
const BTTS_NAMES = new Set(['BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score | Full Time', 'Both Teams to Score | Full Time']);

try {
    const fixtures = await db('fixtures as f')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .orderBy('f.kickoff')
        .select('f.id', 'f.home_team_id', 'f.away_team_id', 'f.ft_home', 'f.ft_away', 'f.kickoff');
    const byTeam = new Map();
    for (const f of fixtures) for (const t of [f.home_team_id, f.away_team_id]) { let l = byTeam.get(t); if (!l) byTeam.set(t, l = []); l.push(f); }
    const featById = new Map();
    for (const f of fixtures) { const r = buildSupport(f, byTeam); if (r) featById.set(f.id, r); }

    // price attach (max fresh price per fixture+key, + BTTS)
    const linkedRows = await db('matches as m')
        .join('odds_markets as om', 'om.match_id', 'm.id')
        .join('fixtures as f', 'f.id', 'm.fixture_id')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('m.fixture_id', 'om.type_name', 'om.name', 'om.handicap', 'om.price', 'om.is_stale');
    const price = new Map();
    const bump = (fid, key, p) => { if (key == null || !(Number(p) > 1)) return; let mp = price.get(fid); if (!mp) price.set(fid, mp = {}); if (mp[key] == null || Number(p) > mp[key]) mp[key] = Number(p); };
    for (const r of linkedRows) {
        if (r.is_stale) continue;
        const k = marketKey(r); if (k) { bump(r.fixture_id, k, r.price); continue; }
        if (BTTS_NAMES.has(r.type_name)) { const nm = String(r.name).toLowerCase(); if (/^(gg|yes)/.test(nm)) bump(r.fixture_id, 'GG', r.price); else if (/^(ng|no)/.test(nm)) bump(r.fixture_id, 'NG', r.price); }
    }

    // build the (fixture, market) value rows
    const rows = [];   // { day, market, support, devig, value, price, hit }
    for (const feat of featById.values()) {
        const mp = price.get(feat.id); if (!mp) continue;
        if (feat.minN < 5) continue;
        for (const market of MARKETS) {
            const support = feat.sup[market]; if (support == null) continue;
            const p = mp[market]; if (!(p > 1)) continue;
            const dv = devigProb(mp, market); if (dv == null) continue;
            const res = settle(market, feat.h, feat.a); if (res == null) continue;
            rows.push({ day: feat.day, market, support, devig: dv, value: support - dv, price: p, hit: !!res });
        }
    }
    const daysSorted = [...new Set(rows.map(r => r.day))].sort();
    const recencyCut = daysSorted[Math.floor(daysSorted.length / 2)];
    console.log(`Priced (fixture,market) rows: ${rows.length}  over ${daysSorted.length} days (${daysSorted[0]}..${daysSorted.at(-1)})`);
    console.log(`Recency split at ${recencyCut}\n`);

    // ---------- H-CALIB: does `value` predict the (realized - devig) residual? ----------
    // If our stats add nothing the market has not priced, residual is ~0 across
    // value bins. A monotone climb = our stats carry orthogonal information.
    console.log('############ H-CALIB — does value predict outcome beyond the market? ############');
    console.log('value bin        n     mean(realized-devig)   (a climbing column = stats add info)');
    const VBINS = [[-9, -0.05], [-0.05, 0], [0, 0.05], [0.05, 0.10], [0.10, 9]];
    for (const [lo, hi] of VBINS) {
        const slice = rows.filter(r => r.value >= lo && r.value < hi);
        if (!slice.length) { console.log(`  [${lo},${hi})`.padEnd(16) + '  0'); continue; }
        const resid = _mean(slice.map(r => (r.hit ? 1 : 0) - r.devig));
        const bar = resid == null ? '' : (resid >= 0 ? '+' : '') + (100 * resid).toFixed(2) + 'pp';
        console.log(`  [${String(lo).padStart(5)},${String(hi).padStart(5)})  ${String(slice.length).padStart(5)}   ${bar}`);
    }

    // ---------- H-VALUE: sweep market x threshold, day-clustered EV CI + BH-FDR ----------
    console.log('\n############ H-VALUE — bettable positive-value slices (price >= 1.20) ############');
    const oneSidedP = rowsSlice => {
        // bootstrap share of day-clustered resamples with EV <= 0
        const byDay = new Map();
        for (const r of rowsSlice) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
        const days = [...byDay.keys()]; if (days.length < 2) return 1;
        let a = 987654321 >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        let neg = 0, tot = 0;
        for (let i = 0; i < 2000; i++) { const s = []; for (let k = 0; k < days.length; k++) s.push(...byDay.get(days[Math.floor(rnd() * days.length)])); const e = flatEv(s); if (e != null) { tot++; if (e <= 0) neg++; } }
        return tot ? (neg + 1) / (tot + 1) : 1;
    };

    const slices = [];
    for (const market of MARKETS) {
        for (const d of THRESHOLDS) {
            const slice = rows.filter(r => r.market === market && r.value >= d && r.price >= BETTABLE_FLOOR);
            if (slice.length < 40) continue;                 // volume floor
            const e = flatEv(slice);
            const ci = dayClusteredBootstrap(slice, flatEv, { draws: 2000, seed: 11 });
            const recent = slice.filter(r => r.day >= recencyCut);
            slices.push({ market, d, n: slice.length, hit: hitRate(slice), ev: e, evLo: ci.lo, evHi: ci.hi, p: oneSidedP(slice), recentN: recent.length, recentEv: flatEv(recent) });
        }
    }
    // BH-FDR over all swept slices' one-sided EV<=0 p-values (many comparisons)
    const rej = benjaminiHochberg(slices.map(s => s.p), 0.10);
    slices.forEach((s, i) => { s.bh = rej[i]; });
    slices.sort((a, b) => (b.ev ?? -9) - (a.ev ?? -9));
    console.log('market  d>=   n    hit     flatEV   EV 95% CI            recent(n,EV)     bootP   BH?');
    for (const s of slices) {
        console.log(`  ${s.market.padEnd(6)} ${s.d.toFixed(2)} ${String(s.n).padStart(4)} ${pct(s.hit).padStart(6)}  ${ev(s.ev).padStart(6)}  [${ev(s.evLo)},${ev(s.evHi)}]`.padEnd(58)
            + ` (${s.recentN},${ev(s.recentEv)})`.padEnd(18) + ` ${s.p.toFixed(3)}  ${s.bh ? 'YES' : '-'}`);
    }
    const winners = slices.filter(s => s.ev > 0 && s.evLo != null && s.evLo > 0 && s.bh);
    console.log(`\nCI-positive AND BH-surviving slices: ${winners.length}`);
    for (const w of winners) console.log(`  *** ${w.market} value>=${w.d}: EV ${ev(w.ev)} CI[${ev(w.evLo)},${ev(w.evHi)}] n=${w.n} ***`);
    if (!winners.length) console.log('  => No bettable +EV value slice survives. The mid-price value region is -EV too.');

    mkdirSync('tmp/sure-win', { recursive: true });
    writeFileSync('tmp/value-edge.json', JSON.stringify({ recencyCut, calib: VBINS, slices }, null, 0));
    console.log('\nWrote tmp/value-edge.json');
} finally {
    await closeDb();
}
