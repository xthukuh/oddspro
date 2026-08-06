// Ladder + coherence rules: the market LATTICE the tip engine was missing.
//
// Everything here answers one of three questions a punter asks and the old
// engine could not:
//   1. "Can these two tips both win?"        -> marketRelation / contradicts
//   2. "What is the SAFEST bet on offer?"    -> marketMenu / bankerPick
//   3. "Same call, less risk?"               -> safestRung
//
// WHY THIS EXISTS (2026-07-26 study, docs/research/2026-07-26-banker-ladder.md):
// `DEFAULT_TIP.minPrice` (1.20) was doing two incompatible jobs. A safe market
// is priced UNDER the floor precisely on the fixtures where it is most likely to
// win, so the floor removed it from candidacy exactly there and admitted it only
// where the book had priced it long - i.e. where it was least likely. Measured
// selection skill went NEGATIVE on the highest-volume markets (U 4.5 -9.4pp,
// O 1.5 -3.5pp, 12 -3.1pp): the engine was worse than picking fixtures at random.
// 94.3% of settled tips had a safer market available under the floor; on those
// fixtures the tip hit 70.4% while the blocked safest market would have hit 92.9%.
//
// The fix is NOT to move the floor - it is to stop asking one number to express
// both "worth betting" and "safe". The Tip keeps its floor and stays the value
// pick; the Banker is a separate output with its own (much lower) floor.
//
// Pure module. Imports only tipOutcome from tip-rules (itself pure, and the
// single authority on how a market settles - deriving the lattice from the SAME
// settle function is what guarantees the relation table can never drift from
// reality). Direction is one-way: tip-rules must never import this file.
import { tipOutcome } from './tip-rules.js';

export const DEFAULT_LADDER = {
    // Banker price floor. 1.01 excludes unbettable/degenerate quotes and nothing
    // else - deliberately NOT 1.20. Swept 1.01..1.30 over 1,199 settled tips:
    // 1.01 gave 92.1% hit-rate at -3.6% ROI and was the only setting to clear
    // 80% on all 14 replay days (worst day 85.4%, median 93.5%).
    bankerFloor: 1.01,
    // Markets barred from BOTH tip and banker. Only these two have a flat-stake
    // ROI whose day-clustered 95% CI excludes zero on the losing side:
    // 12 -8.8% CI[-16.9,-1.7] (n=220), U 3.5 -8.7% CI[-15.6,-1.6] (n=164).
    // Every other market's CI spans zero - absence of evidence, so they stay.
    exclude: ['12', 'U 3.5'],
    // Goal-rich ladder signal (see reachesUpTheLadder below). ladderMinLine is
    // the Over rung the candidate set must reach for the signal to fire;
    // ladderRung is the bottom rung actually bet.
    ladderMinLine: 2.5,
    ladderRung: 'O 1.5',
};

// Scorelines the lattice is derived over. 0-6 each side covers >99.9% of real
// football results; every market in the vocabulary resolves inside it, so the
// relations below are exact for all practical purposes.
const _GRID = (() => {
    const g = [];
    for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) g.push([h, a]);
    return g;
})();

const _satCache = new Map();

// The set of scorelines a market wins on ("satisfying set"), as a Set of 'h-a'
// keys. Null for an unknown/unparseable market key - callers degrade to
// 'unknown' rather than throwing, because tip_market is persisted data written
// by older code versions (external data, by the project's own convention).
export function satisfyingSet(market) {
    const key = String(market);
    if (_satCache.has(key)) return _satCache.get(key);
    let out = new Set();
    for (const [h, a] of _GRID) {
        let o;
        try { o = tipOutcome(key, h, a); } catch { out = null; break; }
        if (o === 'hit') out.add(`${h}-${a}`);
    }
    _satCache.set(key, out);
    return out;
}

// How two markets relate:
//   'contradictory' - no scoreline satisfies both (betting both guarantees a loss)
//   'identical'     - exactly the same bet under two names
//   'nested'        - one strictly implies the other (same call, different risk rung)
//   'overlapping'   - genuinely different bets that can both win
//   'unknown'       - either key is unparseable
// Total: never throws.
export function marketRelation(a, b) {
    const A = satisfyingSet(a), B = satisfyingSet(b);
    if (!A || !B) return 'unknown';
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    if (inter === 0) return 'contradictory';
    if (inter === A.size && inter === B.size) return 'identical';
    if (inter === A.size || inter === B.size) return 'nested';
    return 'overlapping';
}

export const contradicts = (a, b) => marketRelation(a, b) === 'contradictory';
// True when `a` cannot win without `b` also winning (a is the harder rung).
export function implies(a, b) {
    const A = satisfyingSet(a), B = satisfyingSet(b);
    if (!A || !B || !A.size) return false;
    for (const x of A) if (!B.has(x)) return false;
    return true;
}

// --- families + rungs -------------------------------------------------------
// A "family" is a directional call (more goals / fewer goals / home side / ...).
// Its rungs are ordered SAFEST FIRST, so laddering is a left-to-right scan.
export const MARKET_FAMILY = {
    'O 0.5': 'over', 'O 1.5': 'over', 'O 2.5': 'over', 'O 3.5': 'over',
    'O 4.5': 'over', 'O 5.5': 'over', 'O 6.5': 'over', GG: 'over',
    'U 1.5': 'under', 'U 2.5': 'under', 'U 3.5': 'under', 'U 4.5': 'under',
    'U 5.5': 'under', 'U 6.5': 'under', NG: 'under',
    1: 'home', '1X': 'home', DNB1: 'home',
    2: 'away', X2: 'away', DNB2: 'away',
    12: 'nodraw', X: 'draw', ODD: 'odd', EVEN: 'even',
    'TT:H:O 0.5': 'tt_h_over', 'TT:H:O 1.5': 'tt_h_over', 'TT:H:O 2.5': 'tt_h_over', 'TT:H:O 3.5': 'tt_h_over',
    'TT:A:O 0.5': 'tt_a_over', 'TT:A:O 1.5': 'tt_a_over', 'TT:A:O 2.5': 'tt_a_over', 'TT:A:O 3.5': 'tt_a_over',
    'TT:H:U 1.5': 'tt_h_under', 'TT:H:U 2.5': 'tt_h_under', 'TT:H:U 3.5': 'tt_h_under', 'TT:H:U 4.5': 'tt_h_under',
    'TT:A:U 1.5': 'tt_a_under', 'TT:A:U 2.5': 'tt_a_under', 'TT:A:U 3.5': 'tt_a_under', 'TT:A:U 4.5': 'tt_a_under',
};

export const LADDER_RUNGS = {
    over: ['O 0.5', 'O 1.5', 'O 2.5', 'O 3.5', 'O 4.5'],
    under: ['U 6.5', 'U 5.5', 'U 4.5', 'U 3.5', 'U 2.5'],
    home: ['1X', 'DNB1', '1'],
    away: ['X2', 'DNB2', '2'],
    nodraw: ['12'], draw: ['X'], odd: ['ODD'], even: ['EVEN'],
    tt_h_over: ['TT:H:O 0.5', 'TT:H:O 1.5', 'TT:H:O 2.5', 'TT:H:O 3.5'],
    tt_a_over: ['TT:A:O 0.5', 'TT:A:O 1.5', 'TT:A:O 2.5', 'TT:A:O 3.5'],
    tt_h_under: ['TT:H:U 4.5', 'TT:H:U 3.5', 'TT:H:U 2.5', 'TT:H:U 1.5'],
    tt_a_under: ['TT:A:U 4.5', 'TT:A:U 3.5', 'TT:A:U 2.5', 'TT:A:U 1.5'],
};

export const familyOf = market => MARKET_FAMILY[String(market)] ?? null;

// --- the market menu --------------------------------------------------------
const _round = v => Math.round(v * 10000) / 10000;
const _num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 1 ? n : null;
};

// Vig-removed probabilities for a complete group of decimal prices; null when
// any price is missing or degenerate. (Local twin of tip-rules' internal
// helper - kept here so this module stays importable on its own.)
function _devig(prices) {
    const inv = prices.map(p => (Number(p) > 1 ? 1 / Number(p) : null));
    if (inv.some(v => v == null)) return null;
    const sum = inv.reduce((a, b) => a + b, 0);
    return inv.map(v => v / sum);
}

// Flatten buildTipBooks() output into { market: { price, prob } }.
// `prob` is the DEVIGGED probability whenever the market's full group is on the
// books, else the raw implied 1/price. The distinction matters: raw implied
// probabilities carry the bookmaker's margin and would systematically overstate
// every leg's survival in a slip.
export function marketMenu(books) {
    const menu = {};
    const put = (market, price, prob) => {
        const p = _num(price);
        if (p == null) return;
        if (menu[market] == null || p < menu[market].price) {
            menu[market] = { price: p, prob: _round(prob ?? 1 / p) };
        }
    };
    if (books?.x12) {
        const d = _devig([books.x12['1'], books.x12.X, books.x12['2']]);
        ['1', 'X', '2'].forEach((k, i) => put(k, books.x12[k], d?.[i]));
        if (d) {                       // double chance derived from one consistent book
            put('1X', books.dc?.['1X'], d[0] + d[1]);
            put('X2', books.dc?.X2, d[1] + d[2]);
            put('12', books.dc?.['12'], d[0] + d[2]);
        }
    }
    if (books?.dc) {
        const d = _devig([books.dc['1X'], books.dc.X2, books.dc['12']]);
        ['1X', 'X2', '12'].forEach((k, i) => put(k, books.dc[k], d?.[i]));
    }
    for (const [line, pair] of Object.entries(books?.ou ?? {})) {
        const d = _devig([pair.over, pair.under]);
        put(`O ${line}`, pair.over, d?.[0]);
        put(`U ${line}`, pair.under, d?.[1]);
    }
    if (books?.btts) {
        const d = _devig([books.btts.GG, books.btts.NG]);
        put('GG', books.btts.GG, d?.[0]);
        put('NG', books.btts.NG, d?.[1]);
    }
    if (books?.dnb) {
        const d = _devig([books.dnb.DNB1, books.dnb.DNB2]);
        put('DNB1', books.dnb.DNB1, d?.[0]);
        put('DNB2', books.dnb.DNB2, d?.[1]);
    }
    if (books?.oddEven) {
        const d = _devig([books.oddEven.ODD, books.oddEven.EVEN]);
        put('ODD', books.oddEven.ODD, d?.[0]);
        put('EVEN', books.oddEven.EVEN, d?.[1]);
    }
    for (const side of ['H', 'A']) {
        for (const [line, pair] of Object.entries(books?.tt?.[side] ?? {})) {
            const d = _devig([pair.over, pair.under]);
            put(`TT:${side}:O ${line}`, pair.over, d?.[0]);
            put(`TT:${side}:U ${line}`, pair.under, d?.[1]);
        }
    }
    return menu;
}

// --- the banker -------------------------------------------------------------
// The safest market the book offers on this fixture at or above `bankerFloor`.
// Safety is read off the PRICE, not off our stats: the price is the market's
// consensus probability and, measured over 1,199 settled tips, it is well
// calibrated (0.7-0.8 bucket predicted 74.9% vs realized 74.6%). Our own stats
// add nothing on top of it - so for a pure safety product, do not pretend they do.
//
// Returns { market, price, prob } | null.
export function bankerPick(menu, opts = {}) {
    const o = { ...DEFAULT_LADDER, ...opts };
    const excluded = new Set(o.exclude ?? []);
    let best = null;
    for (const [market, v] of Object.entries(menu ?? {})) {
        if (excluded.has(market)) continue;
        if (!(v.price >= o.bankerFloor)) continue;
        if (best && !(v.price < best.price)) continue;
        best = { market, price: v.price, prob: v.prob };
    }
    return best;
}

// The safest rung of `market`'s OWN family that the book offers at or above the
// floor - i.e. keep the directional call, take less risk. Falls back to the
// market itself when no safer rung is on offer. Null for an unfamilied market.
export function safestRung(menu, market, opts = {}) {
    const o = { ...DEFAULT_LADDER, ...opts };
    const fam = familyOf(market);
    if (!fam) return null;
    const excluded = new Set(o.exclude ?? []);
    let best = null;
    for (const rung of LADDER_RUNGS[fam] ?? []) {
        if (excluded.has(rung)) continue;
        const v = menu?.[rung];
        if (!v || !(v.price >= o.bankerFloor)) continue;
        if (best && !(v.price < best.price)) continue;
        best = { market: rung, price: v.price, prob: v.prob };
    }
    return best;
}

// Distance between what we tipped and the safest bet available - the strongest
// non-trivial hit/miss discriminator found in the 2026-07-26 study (-0.20 sd:
// misses sit further above the safest price than hits do). Null when either
// side is unavailable.
export function rungGap(tipPrice, menu, opts = {}) {
    const banker = bankerPick(menu, opts);
    // Number(null) is 0 and Number('') is 0 - guard explicitly, or a tipless
    // row would report a confident negative gap instead of "unknown".
    if (tipPrice == null || tipPrice === '') return null;
    const p = Number(tipPrice);
    if (!banker || !Number.isFinite(p)) return null;
    return _round(p - banker.price);
}

// --- the goal-rich signal (2026-07-26 investigation) --------------------------
// A user-reported observation, verified across 14 days: when the engine's own
// CANDIDATE SET reaches UP the Over ladder - i.e. it seriously considered
// "O 2.5" or "O 3.5" - the fixture goes over 1.5 goals far more often than the
// base rate, EVEN WHEN THE ENGINE DID NOT TIP AN OVER.
//
//   candidate set contains O 2.5 / O 3.5 : over 1.5 in 84.1% (424/504)
//   it does not                          : over 1.5 in 71.1% (494/695)
//
// The signal lives in the RUNNERS-UP, not the pick: a set that reaches for a
// higher rung and then settles elsewhere is describing a goal-rich fixture. The
// engine was already computing this and throwing it away.
//
// Betting the bottom rung on that signal (current-engine regime, 07-04 excluded):
//   O 1.5 blind on every tipped fixture   74.8%, ROI -5.0%  (CI excludes zero)
//   O 1.5 when the set reaches up         83.1%, ROI -2.3%
//   ...and O 1.5 not itself a candidate   84.6%, ROI -2.5%
//   O 1.5 when the set does NOT reach up  68.7%, ROI -7.0%  (CI excludes zero)
//
// HONESTY: +10pp of accuracy and +2.5pp of ROI over betting O 1.5 blind, but the
// ROI confidence interval still spans zero - this is a reliability gain, not a
// proven edge. The INVERSE is the firmer half: when the set does not reach up,
// an Over is a confidently bad bet.
const _OVER_RUNG = /^O (\d+(?:\.\d+)?)$/;

// True when any market in the set is an Over rung at or above `minLine`.
// Reading the set, not the pick - that is where the signal was found.
export function reachesUpTheLadder(markets, minLine = 2.5) {
    for (const m of Array.isArray(markets) ? markets : []) {
        const mm = _OVER_RUNG.exec(String(m ?? ''));
        if (mm && Number(mm[1]) >= minLine) return true;
    }
    return false;
}

// The bottom-rung Over the set implied but did not pick. Null when the signal
// does not fire or the rung is not offered. `markets` is the full candidate set
// (tip + runners-up).
export function ladderPick(menu, markets, opts = {}) {
    const o = { ...DEFAULT_LADDER, ...opts };
    if (!reachesUpTheLadder(markets, o.ladderMinLine ?? 2.5)) return null;
    const v = menu?.[o.ladderRung ?? 'O 1.5'];
    if (!v || !(v.price >= o.bankerFloor)) return null;
    return { market: o.ladderRung ?? 'O 1.5', price: v.price, prob: v.prob };
}

// --- coherence --------------------------------------------------------------
// Filter a candidate list down to genuine ALTERNATIVES to `chosen`. Drops:
//   - the chosen market itself and anything identical to it
//   - anything that CONTRADICTS it (shown together they guarantee one loser -
//     the "O 2.5 and U 2.5 on the same fixture" confusion)
//   - anything NESTED with it (same call at a different risk rung - that is the
//     ladder's job, surfaced separately as the banker, not a "close alternative")
//   - later candidates that are contradictory/nested with an already-kept one
// Order is preserved (callers pass candidates already ranked).
export function coherentAlternatives(chosen, candidates, limit = 2) {
    const out = [];
    const kept = [String(chosen)];
    for (const c of Array.isArray(candidates) ? candidates : []) {
        if (out.length >= limit) break;
        const m = c?.market;
        if (m == null) continue;
        let ok = true;
        for (const k of kept) {
            const rel = marketRelation(m, k);
            if (rel === 'contradictory' || rel === 'nested' || rel === 'identical') { ok = false; break; }
        }
        if (!ok) continue;
        kept.push(String(m));
        out.push(c);
    }
    return out;
}

// True when a candidate set is internally contradictory - the engine's own
// signals do not resolve. Measured on 1,199 settled tips: such fixtures ran
// 65.9% vs 71.2% for coherent ones, so this is a genuine low-confidence marker,
// not just cosmetics.
export function candidateSetIncoherent(markets) {
    const list = (Array.isArray(markets) ? markets : []).filter(m => m != null);
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            if (marketRelation(list[i], list[j]) === 'contradictory') return true;
        }
    }
    return false;
}
