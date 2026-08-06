// Walk-forward leg calibration: per-cell (market group x price band) realized
// hit rates, beta-shrunk toward the book's devigged probability. Extracted
// VERBATIM from scripts/replay-daily2x.js (2026-08-04 showcase, where feeding
// this layer into leg selection nearly doubled the green-day rate, 33% -> 62%
// at 1.5x) so the simulation harness, the production daily-slip builder and
// the web share ONE definition. Pure and zero-import by design (offline
// tests, browser import both possible).
//
// Why cells and not per-market rates: the naive construction trusted the
// book's devigged prob and went 33% green - the broken legs were almost all
// cheap Over-type shorts (O 0.5 @1.01, TT U 2.5 @1.01), exactly the trap the
// 2026-08-04 calibration audit mapped (devig OVERSTATES cheap Overs; 0-0 days
// happen far more often than 1.01 implies). The cell estimate is the realized
// hit rate of (market group x price band) measured over days STRICTLY BEFORE
// the day being predicted (hindsight-free), shrunk toward the devig prob with
// shrinkK pseudo-counts so thin cells start at the book's number and only
// move as evidence accumulates. Walk-forward by construction: estimates
// tighten automatically as the settled ledger grows, no re-tuning needed.

export const DEFAULT_SHRINK_K = 50;   // a-priori pseudo-count, not tuned

export const bandOf = p => p <= 1.02 ? '1.02' : p <= 1.05 ? '1.05' : p <= 1.10 ? '1.10'
    : p <= 1.20 ? '1.20' : p <= 1.35 ? '1.35' : p <= 1.60 ? '1.60' : p <= 2.20 ? '2.20'
    : p <= 3.50 ? '3.50' : 'long';

// KEPT UNSPLIT after a real experiment (owner-spotted pattern, 2026-08-06):
// near-Unders (U 3.5/4.5 at 1.20-1.35) DO run below break-even (76.1-76.3%
// vs 78.4%) and break the most slips - but splitting them into their own
// cell made every replay metric WORSE (strict 51.4% -> 45.7%, value cards
// +9.5% -> -1.6%; floor retune could not recover it), because the
// replacement legs at that price band realize 73.3% - near-Unders are the
// LEAST-BAD shorts. Same lesson as the refuted league layer: taxonomy
// refinement needs sample mass. Re-test the split when the ledger has
// months, not weeks (scripts/simulate-daily-slip.js round 9, git history).
export const groupOf = m => /^O 0\.5$/.test(m) ? 'O0.5'            // its own cell - the known trap
    : /^O /.test(m) ? 'over' : /^U /.test(m) ? 'under'
    : /^TT:.:O/.test(m) ? 'tt-over' : /^TT:.:U/.test(m) ? 'tt-under'
    : /^(GG|NG)$/.test(m) ? 'btts' : /^DNB/.test(m) ? 'dnb'
    : /^(1X|X2|12)$/.test(m) ? 'dc' : /^(ODD|EVEN)$/.test(m) ? 'oe' : '1x2';

export const cellKey = l => `${groupOf(l.market)}|${bandOf(Number(l.price))}`;

// makeCalibrator({ shrinkK, cells }) - both optional. `cells` rehydrates a
// prior export() (plain JSON, storable on a slip row for audit/reuse).
// Legs: { market, price, prob, outcome } - outcome anything but 'hit'/'miss'
// is ignored (voids and unsettled legs carry no calibration information).
//
// v2 error-feedback options (owner directive 2026-08-06: "stereotype patterns
// from past outcomes; heal from bad picks" - both OFF by default, byte-compat,
// baked only if the hindsight-free grid beats the incumbent):
// - halfLifeDays: observations decay with age (leg.day 'YYYY-MM-DD' stamps;
//   decay is projected to the newest observed day), so a RECENT miss drags its
//   cell harder than stale history and the estimate heals as evidence renews.
// - leagueK: a hierarchical league layer - (league|group|band) cells shrunk
//   with leagueK pseudo-counts toward the global cell's estimate, which is
//   itself shrunk toward the devig. A league that keeps missing (friendlies,
//   youth, chaotic comps) earns its own discounted stereotype; leagues the
//   engine has never erred in inherit the global cell untouched.
const _dayNum = d => (d ? Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000 : null);

export function makeCalibrator({
    shrinkK = DEFAULT_SHRINK_K, cells = null,
    halfLifeDays = 0, leagueK = 0, league_cells = null,
} = {}) {
    const map = new Map(cells ? Object.entries(cells).map(([k, c]) => [k, { ...c }]) : []);
    const lmap = new Map(league_cells ? Object.entries(league_cells).map(([k, c]) => [k, { ...c }]) : []);
    let asOf = null;   // newest observed day number - the decay reference
    const _decayTo = (c, day) => {
        if (!halfLifeDays || day == null || c.day == null || day <= c.day) return c;
        const f = 0.5 ** ((day - c.day) / halfLifeDays);
        return { n: c.n * f, hit: c.hit * f, day };
    };
    const _bump = (m, k, hit, day) => {
        let c = m.get(k) ?? { n: 0, hit: 0, day: null };
        c = _decayTo(c, day);
        c.n++; if (hit) c.hit++;
        if (day != null) c.day = Math.max(c.day ?? day, day);
        m.set(k, c);
    };
    const _read = (m, k) => {
        const c = m.get(k);
        return c && c.n > 0 ? _decayTo(c, asOf) : null;
    };
    return {
        observe(leg) {
            if (leg.outcome !== 'hit' && leg.outcome !== 'miss') return;
            const day = halfLifeDays ? _dayNum(leg.day) : null;
            if (day != null) asOf = Math.max(asOf ?? day, day);
            const k = cellKey(leg);
            _bump(map, k, leg.outcome === 'hit', day);
            if (leagueK > 0 && leg.league != null) _bump(lmap, `${leg.league}|${k}`, leg.outcome === 'hit', day);
        },
        prob(leg) {
            const devig = Number(leg.prob);
            const k = cellKey(leg);
            const c = _read(map, k);
            const p0 = c ? (c.hit + shrinkK * devig) / (c.n + shrinkK) : devig;
            if (!(leagueK > 0) || leg.league == null) return p0;
            const lc = _read(lmap, `${leg.league}|${k}`);
            return lc ? (lc.hit + leagueK * p0) / (lc.n + leagueK) : p0;
        },
        cell(leg) {
            const c = _read(map, cellKey(leg));
            return c ? { n: c.n, hit: c.hit } : null;
        },
        export() {
            const dump = m => Object.fromEntries([...m].map(([k, c]) => [k, { ...c }]));
            return {
                shrinkK, halfLifeDays, leagueK,
                cells: dump(map),
                ...(leagueK > 0 ? { league_cells: dump(lmap) } : {}),
            };
        },
    };
}
