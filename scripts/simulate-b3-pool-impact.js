// M4.2b — does the B3 gate (U 3.5 support >= 0.7) actually improve the LIVE
// Safe pool? READ-ONLY: no writes, no API calls.
//
//   node scripts/simulate-b3-pool-impact.js
//
// The market-level validation said U 3.5 support >= 0.7 lifts U 3.5 leg
// survival +8.5pp (powered) / +10.9pp on recent tips. But a market-level lift
// is worthless if U 3.5 legs rarely SURVIVE into the top-3 Safe slots anyway.
// This simulates the REAL Safe pool - the live src/db/magic-rules.js
// safeSelection - over the settled ledger, baseline vs the B3 gate, and reports
// the pool-level leg-survival / picks-per-day delta. We ship magic-rules only
// if the POOL number (not just the market number) moves.
//
// Rigour reused verbatim from the live engine:
//   - safeSelection / safeQualifies / tipView / DEFAULT_SAFE : the exact live
//     Safe pool, so the sim cannot drift from production behaviour.
//   - Per-day LEAVE-ONE-DAY-OUT calibration (simulateStrategies' idiom): each
//     day is selected with calibration built from every OTHER day, so a
//     calibrated ranker never grades its own answers.
// The B3 gate is applied as a HARD eligibility filter (drop U 3.5 legs whose
// reconstructed support < 0.7 BEFORE selection) so a freed slot goes to the
// next-best leg - the strongest form, and the one the +10.9pp came from.
//
// Regime/recency: TIP_MIN_PRICE broke the ledger at 2026-07-11; results are
// reported for the RECENT regime (headline) and the full window (higher power,
// mixed regime) so nothing rides on one window.
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { h2hOutcomeAggregates } from '../src/db/tip-rules.js';
import { computeCalibration, safeSelection, tipView, DEFAULT_SAFE } from '../src/db/magic-rules.js';

const WINDOW = 7, GATE = 0.70;
const pct = v => (v == null ? ' n/a' : (100 * v).toFixed(1) + '%');
const pp = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + 'pp');
const _mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };

// reconstructed blended U 3.5 support (leak-free, mirrors mine-precursors)
function u35Support(f, byTeam) {
    const cutoff = new Date(f.kickoff).getTime();
    const shape = (rows, teamId, oppId) => {
        const recent = rows.filter(g => g.ft_home != null && g.ft_away != null && new Date(g.kickoff).getTime() < cutoff
            && !((g.home_team_id === teamId && g.away_team_id === oppId) || (g.home_team_id === oppId && g.away_team_id === teamId)))
            .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime()).slice(0, WINDOW);
        if (!recent.length) return null;
        let over = 0;
        for (const g of recent) { const tot = g.ft_home + g.ft_away; if (tot > 3.5) over++; }
        return over / recent.length;
    };
    const ho = shape(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id);
    const ao = shape(byTeam.get(f.away_team_id) ?? [], f.away_team_id, f.home_team_id);
    if (ho == null || ao == null) return null;                 // no leak-free history both sides
    const hh = h2hOutcomeAggregates(byTeam.get(f.home_team_id) ?? [], f.home_team_id, f.away_team_id, cutoff, 5);
    const over = _mean([ho, ao, hh.n ? hh.overRates?.[3.5] : null]);
    return over == null ? null : 1 - over;                     // U 3.5 support = 1 - over-3.5 rate
}

// ---- pool metrics over a selected leg set ----
function poolStats(selected, perDay) {
    let hit = 0, miss = 0, voidN = 0;
    for (const r of selected) {
        if (r.tip_outcome === 'hit') hit++; else if (r.tip_outcome === 'miss') miss++; else voidN++;
    }
    const legSurvival = (hit + miss) ? hit / (hit + miss) : null;
    // slip survival: a day's slip "wins" if it has no miss and >=1 settled hit
    let slipDays = 0, slipWon = 0;
    for (const d of perDay) {
        const legs = d.picks.filter(r => r.tip_outcome === 'hit' || r.tip_outcome === 'miss');
        if (!legs.length) continue;
        slipDays++;
        if (legs.every(r => r.tip_outcome === 'hit')) slipWon++;
    }
    return { legs: selected.length, hit, miss, voidN, legSurvival,
        picksPerDay: perDay.length ? selected.length / perDay.length : 0,
        slipDays, slipWon, slipSurvival: slipDays ? slipWon / slipDays : null };
}

// run the real Safe pool over a set of days with per-day LODO calibration.
// `gate(row)->bool` optionally drops rows before selection (B3 = hard filter).
function runPool(rows, days, gate) {
    const selected = [], perDay = [];
    for (const d of days) {
        const cal = computeCalibration(rows.filter(r => r.day !== d).map(tipView), 10);   // LODO
        const dayRows = rows.filter(r => r.day === d && (!gate || gate(r)));
        const picks = safeSelection(dayRows, cal, DEFAULT_SAFE);
        selected.push(...picks); perDay.push({ day: d, picks });
    }
    return { selected, perDay };
}

try {
    // reconstruct U 3.5 support per fixture
    const fixtures = await db('fixtures as f')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .orderBy('f.kickoff')
        .select('f.id', 'f.home_team_id', 'f.away_team_id', 'f.ft_home', 'f.ft_away', 'f.kickoff');
    const byTeam = new Map();
    for (const f of fixtures) for (const t of [f.home_team_id, f.away_team_id]) { let l = byTeam.get(t); if (!l) byTeam.set(t, l = []); l.push(f); }
    const sup35 = new Map();
    for (const f of fixtures) { const s = u35Support(f, byTeam); if (s != null) sup35.set(f.id, s); }

    // settled tips with fixture_id (=api_id for the pool dedup)
    const rows = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome')
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"),
            db.raw('f.id as fixture_id'), db.raw('f.id as api_id'),
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_outcome', 'p.tip_breakdown', 'p.tip_ai_verdict');

    // regime break (per-day min tip price jump >= 0.10)
    const dayMin = new Map();
    for (const r of rows) dayMin.set(r.day, Math.min(dayMin.get(r.day) ?? Infinity, Number(r.tip_price)));
    const allDays = [...dayMin.keys()].sort();
    const floor0 = dayMin.get(allDays[0]);
    let breakDay = null;
    for (const d of allDays) if (dayMin.get(d) >= floor0 + 0.10) { breakDay = d; break; }
    const recentDays = allDays.filter(d => breakDay && d >= breakDay);
    console.log(`Ledger: ${rows.length} settled tips over ${allDays.length} days. Regime break at ${breakDay ?? 'none'}.`);
    console.log(`U 3.5 support reconstructed for ${sup35.size} fixtures.\n`);

    // the B3 hard gate: keep every non-U3.5 row; keep a U3.5 row only if its
    // reconstructed support >= 0.70. Unreconstructable U3.5 support => drop
    // (we can't confirm >=0.7, and the booster's claim is "admit only at >=0.7").
    const b3gate = r => {
        if (r.tip_market !== 'U 3.5') return true;
        const s = sup35.get(r.fixture_id);
        return s != null && s >= GATE;
    };

    const report = (label, days) => {
        if (!days.length) { console.log(`\n### ${label}: no days`); return; }
        const base = runPool(rows, days, null);
        const gated = runPool(rows, days, b3gate);
        const b = poolStats(base.selected, base.perDay);
        const g = poolStats(gated.selected, gated.perDay);
        // how many U3.5 legs did each pool select, and did the gate change days?
        const u35 = sel => sel.filter(r => r.tip_market === 'U 3.5');
        const baseU = u35(base.selected), gateU = u35(gated.selected);
        const dayKey = d => d.picks.map(r => r.api_id).sort().join(',');
        let changedDays = 0;
        for (let i = 0; i < base.perDay.length; i++) if (dayKey(base.perDay[i]) !== dayKey(gated.perDay[i])) changedDays++;
        console.log(`\n### ${label}  (${days.length} days: ${days[0]}..${days.at(-1)})`);
        console.log(`               legs  picks/day  leg-survival        slip-survival   U3.5 legs (survival)`);
        console.log(`  baseline     ${String(b.legs).padStart(4)}   ${b.picksPerDay.toFixed(2)}      ${pct(b.legSurvival).padStart(6)} (${b.hit}/${b.hit + b.miss})   ${pct(b.slipSurvival).padStart(6)} (${b.slipWon}/${b.slipDays})   ${baseU.length} (${pct(u35(base.selected).filter(r => r.tip_outcome === 'hit').length / (u35(base.selected).filter(r => r.tip_outcome !== 'void').length || 1))})`);
        console.log(`  B3-gated     ${String(g.legs).padStart(4)}   ${g.picksPerDay.toFixed(2)}      ${pct(g.legSurvival).padStart(6)} (${g.hit}/${g.hit + g.miss})   ${pct(g.slipSurvival).padStart(6)} (${g.slipWon}/${g.slipDays})   ${gateU.length} (${pct(u35(gated.selected).filter(r => r.tip_outcome === 'hit').length / (u35(gated.selected).filter(r => r.tip_outcome !== 'void').length || 1))})`);
        console.log(`  delta        leg-survival ${pp(b.legSurvival != null && g.legSurvival != null ? g.legSurvival - b.legSurvival : null)}   slip-survival ${pp(b.slipSurvival != null && g.slipSurvival != null ? g.slipSurvival - b.slipSurvival : null)}   days changed by gate: ${changedDays}/${days.length}`);
        // how many U3.5 legs were dropped and what replaced their day-slots
        const droppedU = baseU.filter(r => !gateU.some(x => x.api_id === r.api_id));
        console.log(`  gate dropped ${droppedU.length} U3.5 leg(s) from the baseline pool` + (droppedU.length ? ` (outcomes: ${droppedU.map(r => r.tip_outcome).join(', ')})` : ''));
    };

    report('RECENT regime (abides to trajectory)', recentDays);
    report('FULL window (higher power, mixed regime)', allDays);
} finally {
    await closeDb();
}
