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
