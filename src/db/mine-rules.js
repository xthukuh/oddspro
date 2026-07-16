// M4.2 emergence-pattern mining rules. Pure module (imports only the equally
// pure perf-rules / magic-rules labelers) so tests run with no .env, no DB and
// no network - same idiom as magic-rules importing perf-rules.
//
// Reusing marketGroup/priceBand/tipAgreement is deliberate, not lazy: a second
// definition of "market family" or "price band" would silently diverge from
// what computeCalibration already buckets by, and two disagreeing taxonomies
// is how a mine invents a pattern that does not exist.
//
// Everything here is read-only analysis of the FROZEN ledger. Nothing in this
// module may influence bestTip, scoreTip, safeQualifies or any live ranking -
// that gate is M4.2b, and it is earned by replay, never by assertion.
import { marketGroup } from './perf-rules.js';
import { priceBand, tipAgreement } from './magic-rules.js';

// ---------------------------------------------------------------------------
// Statistics: the anti-false-positive controls.
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32). The bootstrap MUST be reproducible - a
// mine whose CI moves between runs cannot be audited, and re-running until a
// pattern looks good is exactly the sin this module is built to prevent.
function _rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Train on the oldest days, test on the newest. Split on whole DAYS, never
// rows: same-day tips share weather, rounds and our own daily cap, so a
// row-level split would leak the test days into training.
export function temporalSplit(days, trainFrac = 0.7) {
    const sorted = [...new Set(days)].sort();
    if (sorted.length < 2) return { train: sorted, test: [] };
    const cut = Math.max(1, Math.floor(sorted.length * trainFrac));
    return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

// Benjamini-Hochberg step-up FDR control. Mining many candidate patterns
// guarantees false positives at any fixed alpha; BH bounds the expected
// proportion of them among our rejections at q. Returns rejections in INPUT
// order (callers zip it back against their hypothesis list).
//
// Step-UP matters: we scan to the LARGEST rank that passes and reject
// everything at or below it. An interior rank may fail its own threshold and
// still be rejected. Stopping at the first failure is a different, wrong test.
export function benjaminiHochberg(pvalues, q = 0.10) {
    const m = pvalues.length;
    if (!m) return [];
    const ranked = pvalues
        .map((p, i) => ({ p: Number.isFinite(p) ? p : 1, i }))
        .sort((a, b) => a.p - b.p);
    let kMax = 0;
    for (let k = 1; k <= m; k++) {
        if (ranked[k - 1].p <= (k / m) * q) kMax = k;
    }
    const out = new Array(m).fill(false);
    for (let k = 0; k < kMax; k++) out[ranked[k].i] = true;
    return out;
}

// Cluster-robust CI: resample whole match-DAYS with replacement, not rows.
// Tips on one day are correlated (shared card, shared cap, correlated
// results), so row-level resampling reports a CI far tighter than the data
// earns. Every CI this project trusts is day-clustered.
export function dayClusteredBootstrap(rows, statFn, { draws = 1000, seed = 42 } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { point: null, lo: null, hi: null };

    const byDay = new Map();
    for (const r of list) {
        const d = r?.day ?? '?';
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(r);
    }
    const days = [...byDay.keys()];
    const rand = _rng(seed);
    const stats = [];
    for (let d = 0; d < draws; d++) {
        const sample = [];
        for (let k = 0; k < days.length; k++) {
            sample.push(...byDay.get(days[Math.floor(rand() * days.length)]));
        }
        const s = statFn(sample);
        if (s != null && Number.isFinite(s)) stats.push(s);
    }
    stats.sort((a, b) => a - b);
    const at = f => (stats.length ? stats[Math.min(stats.length - 1, Math.floor(f * stats.length))] : null);
    return { point: statFn(list), lo: at(0.025), hi: at(0.975) };
}

// ---------------------------------------------------------------------------
// Feature extractors. Every one is TOTAL: tip_breakdown is persisted JSON
// written by older code versions, so it is external data. Malformed input
// returns null/[]/false - it never throws. Prior art: tipHitSafe, the
// tolerant apisports-events parser.
// ---------------------------------------------------------------------------

export const LADDER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

const _overLine = market => {
    const m = /^O (\d+(?:\.\d+)?)$/.exec(String(market ?? ''));
    return m ? Number(m[1]) : null;
};
const _underLine = market => {
    const m = /^U (\d+(?:\.\d+)?)$/.exec(String(market ?? ''));
    return m ? Number(m[1]) : null;
};

// The runners-up the blend ranked behind the winning tip. Pre-phase-14 rows
// carry no runners_up at all and simply drop out of the population.
export function runnerUpMarkets(view) {
    const ru = view?.breakdown?.runners_up;
    if (!Array.isArray(ru)) return [];
    return ru.map(r => r?.market).filter(m => typeof m === 'string' && m.length > 0);
}

// The configuration signature: what the blend ranked 1st, 2nd, 3rd. The
// hypothesis (PR-2) is that this ORDERING encodes outcome signal the winning
// tip's own confidence does not.
export function configSignature(view) {
    const winner = view?.market;
    if (typeof winner !== 'string' || !winner.length) return null;
    const rus = runnerUpMarkets(view);
    if (!rus.length) return null;
    return [winner, ...rus].join('|');
}

// The user's observed precursor: O k and U k both sitting in the runners-up
// for the SAME line k means the blend is genuinely torn about that line -
// read as a high-variance game. Different lines (O 3.5 / U 2.5) are NOT a
// straddle; they are the blend agreeing the total lands in a middle band.
export function hasStraddle(view) {
    const rus = runnerUpMarkets(view);
    const overs = new Set(rus.map(_overLine).filter(v => v != null));
    return rus.map(_underLine).filter(v => v != null).some(u => overs.has(u));
}

// PR-1: for an Over tip, which lower lines did the fixture actually clear?
// The "ladder down" idea is that a laddered leg lands more often than the tip
// itself - true, but it only MATTERS if the lower line's real price still
// clears break-even, which is what evaluatePattern goes on to test.
export function cascadeLadder(view, fh, fa) {
    const tipLine = _overLine(view?.market);
    if (tipLine == null) return null;
    if (fh == null || fa == null) return null;
    const h = Number(fh); const a = Number(fa);
    if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
    const total = h + a;
    const cleared = {};
    for (const line of LADDER_LINES) cleared[String(line)] = total > line;
    return { tipLine, total, cleared };
}

// Minimum rolling sample per side before we call a tip's evidence sufficient.
// Mirrors DEFAULT_SAFE.minSamples (magic-rules) - kept as a local literal
// rather than an import because DEFAULT_SAFE is a live policy knob and this
// is a frozen analysis constant: if the policy moves, past mines must not
// silently re-classify.
const MINE_MIN_SAMPLES = 6;

// Same shape as magic-rules' _num, and the null guard is load-bearing:
// Number(null) is 0, not NaN, so without it a null api_prob would count as a
// present blend component and every 2-part tip would report as 3-part.
const _num = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// How many of the three blend components the tip actually carries. 2-part
// blends (no api_prob) are the majority - O/U tips carry no API percentage.
export function blendParts(view) {
    const b = view?.breakdown;
    if (!b) return 0;
    return [b.market_prob, b.stats_prob, b.api_prob].filter(v => _num(v) != null).length;
}

// PR-3: the shape of a settled pick, for locating where misses concentrate.
// group/band come from the SHARED labelers - computeCalibration already
// buckets by these, so a mined "avoid cell" maps onto a real calibration cell
// instead of a private one only this script understands.
export function missProfile(view) {
    if (!view || typeof view.market !== 'string' || !view.market.length) return null;
    const s = view.breakdown?.samples ?? null;
    const hn = _num(s?.home_n); const an = _num(s?.away_n);
    return {
        market: view.market,
        group: marketGroup(view.market),
        band: priceBand(_num(view.price)),
        parts: blendParts(view),
        // A sample-less row is thin: absent evidence is not evidence of
        // sufficiency. Matches hasSufficientStats' spirit, deliberately
        // stricter than its tolerance of null samples.
        thin: hn == null || an == null || hn < MINE_MIN_SAMPLES || an < MINE_MIN_SAMPLES,
    };
}

// PR-4: the contrarian / fade-the-consensus thesis, in its measurable forms.
//
//   spread = |market_prob - stats_prob|. LOW spread is the "consensus trap":
//   the bookmaker and our own stats agree, which is precisely the state the
//   user's thesis says underperforms its price. HIGH spread is our stats
//   dissenting from the market.
//
// The AI lens rides along but is pre-declared underpowered (n=61 settled).
export function consensusProxies(view) {
    if (!view || typeof view.market !== 'string' || !view.market.length) return null;
    const mp = _num(view.breakdown?.market_prob);
    const sp = _num(view.breakdown?.stats_prob);
    return {
        band: priceBand(_num(view.price)),
        agreement: tipAgreement(view),
        spread: mp == null || sp == null ? null : Math.abs(mp - sp),
        aiVerdict: view.vetoed ? 'veto' : null,
        parts: blendParts(view),
    };
}

// ---------------------------------------------------------------------------
// Evaluation: the honesty contract, in code.
// ---------------------------------------------------------------------------

// Closed vocabulary (spec S5). Never add a sixth without a spec change.
//   edge         survives every control AND flat EV > 0 at real prices.
//                None has ever been found in this warehouse.
//   booster      survives every control, lift CI clear of zero, EV <= 0.
//                Buys slip survival, not profit. Most findings land here.
//   refuted      adequately powered; lift CI includes zero, or fails OOS.
//   underpowered below the volume floor. NOT evidence of absence.
//   unbettable   real lift, but the price lives below the 1.20 floor, so it
//                cannot be acted on. Distinct from refuted ON PURPOSE: the
//                precursor mine's AU 2.5 hit 87% OOS and was worthless
//                because it prices at ~1.1. Collapsing this into "refuted"
//                would lose the single most important lesson we have.
export const CLASSES = ['edge', 'booster', 'refuted', 'underpowered', 'unbettable'];

export const MIN_TRAIN = 100;
export const MIN_TEST = 40;
export const BETTABLE_FLOOR = 1.20;
const OOS_TOLERANCE = 0.05; // test precision may sit at most 5pp below train

// Flat-stake EV: exactly 1 unit on every settled pick, won at (price - 1) or
// lost entirely. The only profit measure this project trusts, because it is
// the one the bettor actually experiences.
export function flatEv(rows) {
    if (!rows?.length) return null;
    let acc = 0;
    for (const r of rows) {
        const p = _num(r?.price);
        if (p == null) return null;
        acc += r.hit ? p - 1 : -1;
    }
    return acc / rows.length;
}

export function hitRate(rows) {
    if (!rows?.length) return null;
    return rows.reduce((s, r) => s + (r.hit ? 1 : 0), 0) / rows.length;
}

const _median = xs => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Order matters and encodes the project's hard-won priorities:
//   1. Power first - an unpowered result is not a result, however pretty.
//   2. OOS stability - an overfit pattern is refuted no matter its EV.
//   3. Lift CI clear of zero - else it is noise around the base rate.
//   4. Price floor - real lift you cannot bet is unbettable, not an edge.
//   5. Only then may EV decide edge vs booster.
export function classifyPattern({ nTrain, nTest, testPrecision, trainPrecision, liftLo, medPrice, flatEv: ev }) {
    if ((nTrain ?? 0) < MIN_TRAIN || (nTest ?? 0) < MIN_TEST) return 'underpowered';
    if (testPrecision == null || trainPrecision == null) return 'underpowered';
    if (testPrecision < trainPrecision - OOS_TOLERANCE) return 'refuted';
    if (liftLo == null || liftLo <= 0) return 'refuted';
    if (medPrice == null || medPrice < BETTABLE_FLOOR) return 'unbettable';
    if (ev == null) return 'refuted';
    return ev > 0 ? 'edge' : 'booster';
}

// Evaluate one pre-registered pattern end to end. Returns precision AND
// flatEv together, always - a caller cannot obtain the flattering number
// without the honest one.
export function evaluatePattern({ name, rows, baseRows, trainDays, testDays, seed = 42, draws = 1000 }) {
    const all = Array.isArray(rows) ? rows : [];
    const base = Array.isArray(baseRows) ? baseRows : [];
    const trainSet = new Set(trainDays ?? []);
    const testSet = new Set(testDays ?? []);
    const inTrain = all.filter(r => trainSet.has(r.day));
    const inTest = all.filter(r => testSet.has(r.day));

    const precision = hitRate(all);
    const baseRate = hitRate(base);
    const lift = precision != null && baseRate != null ? precision - baseRate : null;

    // Day-clustered CI on the LIFT, not on precision: "better than the base
    // rate" is the claim, so the base rate must be resampled on the same days.
    const byDayBase = new Map();
    for (const r of base) {
        if (!byDayBase.has(r.day)) byDayBase.set(r.day, []);
        byDayBase.get(r.day).push(r);
    }
    const liftStat = sample => {
        const p = hitRate(sample);
        if (p == null) return null;
        const b = hitRate(sample.flatMap(r => byDayBase.get(r.day) ?? []));
        return b == null ? null : p - b;
    };
    const ci = dayClusteredBootstrap(all, liftStat, { draws, seed });

    const ev = flatEv(all);
    const medPrice = _median(all.map(r => _num(r?.price)).filter(v => v != null));

    // One-sided bootstrap p: how often does the resampled lift fail to be
    // positive? Fed to benjaminiHochberg by the caller.
    let neg = 0; let tot = 0;
    const rand = _rng(seed + 1);
    const days = [...new Set(all.map(r => r.day))];
    const byDay = new Map(days.map(d => [d, all.filter(r => r.day === d)]));
    for (let i = 0; i < draws && days.length; i++) {
        const sample = [];
        for (let k = 0; k < days.length; k++) sample.push(...byDay.get(days[Math.floor(rand() * days.length)]));
        const l = liftStat(sample);
        if (l != null) { tot++; if (l <= 0) neg++; }
    }
    const p = tot ? (neg + 1) / (tot + 1) : 1;

    const trainPrecision = hitRate(inTrain);
    const testPrecision = hitRate(inTest);
    const klass = classifyPattern({
        nTrain: inTrain.length, nTest: inTest.length,
        testPrecision, trainPrecision, liftLo: ci.lo, medPrice, flatEv: ev,
    });

    return {
        name, n: all.length, nTrain: inTrain.length, nTest: inTest.length,
        precision, trainPrecision, testPrecision,
        base: baseRate, lift, liftLo: ci.lo, liftHi: ci.hi, p,
        medPrice, flatEv: ev, klass,
        note: klass === 'underpowered'
            ? `underpowered (train ${inTrain.length}/${MIN_TRAIN}, test ${inTest.length}/${MIN_TEST})`
            : null,
    };
}
