// M4.2 emergence-pattern mine: replay every PRE-REGISTERED hypothesis against
// the settled tip ledger with temporal-OOS + day-clustered CIs + BH-FDR, and
// price every survivor at its REAL stored odds. Read-only: no writes, no API
// calls, no AI calls.
//
//   node scripts/mine-patterns.js
//
// Reuses settledTipRows() VERBATIM from src/magic.js - the same loader
// scripts/analyze-safe-tips.js uses - so the two harnesses can never disagree
// about what "a settled tip" is. This script adds ZERO new DB code.
//
// Read docs/emergence-patterns-findings.md for the interpretation, and
// docs/superpowers/specs/2026-07-16-m4.2-pattern-mining-design.md for why
// certain hypotheses are absent (H5, the golden-longshot spotter, is refuted:
// >=10x went 2-for-153, about -79% EV).
import { closeDb } from '../src/db/connection.js';
import { settledTipRows } from '../src/magic.js';
import { tipView } from '../src/db/magic-rules.js';
import {
    PRE_REGISTERED, temporalSplit, benjaminiHochberg, evaluatePattern,
    cascadeLadder, CLASSES,
} from '../src/db/mine-rules.js';

const Q = 0.10;
const DRAWS = 1000;

const _pct = v => (v == null ? '   n/a' : `${(v * 100).toFixed(1)}%`);
const _pp = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`);
const _ev = v => (v == null ? '   n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

function hitOf(rows) {
    return rows.length ? rows.reduce((s, r) => s + r.hit, 0) / rows.length : null;
}

try {
    const raw = await settledTipRows();
    // One row per settled tip: the view carries market/price/confidence/
    // breakdown; day + final score ride along from the loader.
    const tips = raw
        .map(r => ({ ...tipView(r), day: r.day, fh: r.fh, fa: r.fa }))
        .filter(t => t?.market && (t.outcome === 'hit' || t.outcome === 'miss'));

    const days = [...new Set(tips.map(t => t.day))].sort();
    const { train, test } = temporalSplit(days, 0.7);
    const baseRows = tips.map(t => ({ day: t.day, hit: t.outcome === 'hit' ? 1 : 0, price: t.price }));

    console.log(`M4.2 pattern mine - ${tips.length} settled tips over ${days.length} days `
        + `(train ${train.length}d / test ${test.length}d), base hit rate ${_pct(hitOf(baseRows))}`);
    console.log(`BH-FDR q=${Q}, ${DRAWS} day-clustered bootstrap draws`);
    console.log(`Base flat EV ${_ev(baseRows.length ? baseRows.reduce((s, r) => s + (r.hit ? r.price - 1 : -1), 0) / baseRows.length : null)} `
        + '(the vig - every pattern is measured against THIS, not against zero)\n');

    // POLICY-REGIME PRE-FLIGHT. The tip ledger is NOT a homogeneous
    // population: TIP_MIN_PRICE is a live config knob, and moving it changes
    // which tips can exist at all. It moved 1.20 -> 1.35 on 2026-07-10, which
    // partitions this ledger almost exactly on the temporal-OOS boundary - so
    // for any price-correlated pattern, "train" is the old policy and "test"
    // is the new one, and a naive OOS verdict would be measuring the config
    // change rather than the hypothesis. Print the evidence on every run: a
    // future knob change must never silently confound a mine again.
    const floorByDay = days.map(d => {
        const ps = tips.filter(t => t.day === d).map(t => t.price).filter(p => p != null);
        return { day: d, min: ps.length ? Math.min(...ps) : null, n: ps.length };
    });
    const floors = [...new Set(floorByDay.map(f => f.min).filter(v => v != null))];
    if (floors.length > 1) {
        const lo = Math.min(...floors); const hi = Math.max(...floors);
        if (hi - lo >= 0.05) {
            console.log(`!! POLICY-REGIME WARNING: the per-day minimum tip price ranges ${lo.toFixed(2)}..${hi.toFixed(2)}.`);
            console.log('   TIP_MIN_PRICE (a live .env knob) evidently changed inside this window, so the');
            console.log('   ledger is NOT one population. Any price-correlated pattern whose OOS split');
            console.log('   straddles the change is measuring the CONFIG, not the hypothesis.');
            console.log('   Per-day minimum price:');
            for (const f of floorByDay) {
                console.log(`     ${f.day}  n=${String(f.n).padStart(4)}  min=${f.min == null ? 'n/a' : f.min.toFixed(2)}`);
            }
            console.log('');
        }
    }

    const results = [];
    for (const h of PRE_REGISTERED) {
        const sel = tips.filter(t => {
            try { return h.select(t); } catch { return false; }
        });
        const rows = sel.map(t => ({ day: t.day, hit: t.outcome === 'hit' ? 1 : 0, price: t.price }));
        results.push({
            h,
            ...evaluatePattern({
                name: h.id, rows, baseRows, trainDays: train, testDays: test, draws: DRAWS,
            }),
        });
    }

    // BH across every pre-registered test at once. Mining eight hypotheses
    // guarantees false positives at any fixed alpha.
    const rejected = benjaminiHochberg(results.map(r => r.p), Q);

    console.log('id                       n  train test    prec    base    lift   lift-CI                 p    medP   flatEV   BH  class');
    console.log('-'.repeat(126));
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ci = r.liftLo == null ? 'n/a'.padEnd(22) : `[${_pp(r.liftLo)}, ${_pp(r.liftHi)}]`.padEnd(22);
        console.log(
            `${r.name.padEnd(22)} ${String(r.n).padStart(4)} `
            + `${String(r.nTrain).padStart(5)} ${String(r.nTest).padStart(4)}  `
            + `${_pct(r.precision)} ${_pct(r.base)} ${_pp(r.lift).padStart(7)}  ${ci} `
            + `${r.p.toFixed(3)}  ${(r.medPrice ?? 0).toFixed(2)}  ${_ev(r.flatEv)}  `
            + `${rejected[i] ? ' Y ' : ' n '}  ${r.klass}${r.h.ship_eligible ? '' : ' (ship-ineligible)'}`,
        );
        if (r.note) console.log(`${' '.repeat(23)}^ ${r.note}`);
    }

    console.log(`\nClasses: ${CLASSES.join(' | ')}`);
    console.log('  edge = clears break-even at real prices (none has ever been found)');
    console.log('  booster = real lift, EV <= 0: buys slip survival, NOT profit');
    console.log('  unbettable = real lift but priced under 1.20 - cannot be acted on');

    // PR-1 needs its own shape: the claim is about a DIFFERENT market (O 1.5)
    // than the tip (O 2.5), so it cannot ride the generic tip-hit path.
    const o25 = tips.filter(t => t.market === 'O 2.5');
    const ladders = o25.map(t => ({ t, l: cascadeLadder(t, t.fh, t.fa) })).filter(x => x.l);
    const tipHits = o25.filter(t => t.outcome === 'hit').length;
    const cleared15 = ladders.filter(x => x.l.cleared['1.5']).length;
    console.log(`\nPR-1 cascade detail: of ${o25.length} O 2.5 tips, the tip landed `
        + `${_pct(tipHits / (o25.length || 1))} but the fixture cleared O 1.5 `
        + `${_pct(cleared15 / (ladders.length || 1))} (n=${ladders.length}).`);
    console.log('  NB: a laddered leg only pays if O 1.5\'s REAL price clears break-even at');
    console.log('  that rate. O 1.5 is a live -5.4% loser (docs/precursor-patterns.md), so');
    console.log('  treat this as a survival booster unless its priced EV says otherwise.');
    console.log('  The generic PR-1 row above measures the O 2.5 TIP, not the ladder.');
} finally {
    await closeDb();
}
