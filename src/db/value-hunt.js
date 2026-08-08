// Value-hunt scoring core (2026-08-08, scripts/hunt-value-lines.js run-2
// champion - 257 walk-forward generations, both-windows rule): the HIGH-ODDS
// singles engine behind the daily "Hunter" card.
//
//   p_hat = sigmoid( logit(devig)
//                    + wModel * (logit(poissonP) - logit(devig))
//                    + wCells * clamp(SUM_d correction_d, +-1.5) )
//   EV    = p_hat * price - 1
//
// correction_d = shrunk cell hit-rate vs the cell's own devig expectation in
// three dimensions (group|band, group|devig, dir|ou - the dims that survived
// the 156-generation vector-memory search), with a bounded STREAK-WEAPON
// bonus on unbroken cells (owner directive) and 60-day half-life decay.
// Replay verdict (37 days): mid band [2.0,3.5) +21.4% train / +32.3% test /
// +24.9% full ROI at 1 pick/day, best streak 5; high band [3.5,6.0) positive
// full-window but unstable across configs - shipped at reduced trust; the
// [6,15) moonshot band FAILED out-of-sample everywhere and is not offered.
// Pure: imports only pure siblings. Offline-testable.
import { bandOf, groupOf } from './leg-calibration.js';
import { contradicts } from './ladder-rules.js';

export const DEFAULT_HUNT = {
    wModel: 0.25, wCells: 0.5, k: 50, minN: 60, halfLife: 60,
    evFloor: 0, cascade: [0.25, 0.15, 0],   // crazy first, then lower-but-high
    weaponTail: 25, weaponBonus: 0.2,
    bands: { mid: [2.0, 3.5], high: [3.5, 6.0] },
    perBand: 1,
};

const dirOf = m => /^U |^NG$|^TT:.:U /.test(m) ? 'UNDER' : /^O |^GG$|^TT:.:O /.test(m) ? 'OVER' : 'RESULT';
const probBand = p => (Math.floor(p * 20) / 20).toFixed(2);
const ouBand = p => p == null ? 'na' : p >= 0.62 ? 'goals-heavy' : p >= 0.5 ? 'goals-lean' : p >= 0.38 ? 'tight' : 'defensive';
export const HUNT_DIMS = {
    'group|band': (l) => `${groupOf(l.market)}|${bandOf(l.price)}`,
    'group|devig': (l) => `${groupOf(l.market)}|${probBand(l.prob)}`,
    'dir|ou': (l, fx) => `${dirOf(l.market)}|${ouBand(fx?.impliedOver)}`,
};
const logit = p => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))));
const sigmoid = x => 1 / (1 + Math.exp(-x));
export const huntDayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;

// Mutable walk-forward state: per-dimension cell maps.
export function makeHuntState() {
    return new Map(Object.keys(HUNT_DIMS).map(d => [d, new Map()]));
}

function _cell(state, d, v) {
    let c = state.get(d).get(v);
    if (!c) state.get(d).set(v, c = { n: 0, hit: 0, devig: 0, day: null, tail: 0 });
    return c;
}
function _decayed(c, dn, halfLife) {
    if (!halfLife || c.day == null || dn <= c.day) return c;
    const f = 0.5 ** ((dn - c.day) / halfLife);
    return { ...c, n: c.n * f, hit: c.hit * f, devig: c.devig * f };
}

// Feed one settled leg (walk-forward: call only with strictly-prior days).
export function observeHuntLeg(state, leg, fx, day, cfg = DEFAULT_HUNT) {
    if (leg.outcome !== 'hit' && leg.outcome !== 'miss') return;
    const dn = huntDayNum(day);
    for (const d of Object.keys(HUNT_DIMS)) {
        const c = _cell(state, d, HUNT_DIMS[d](leg, fx));
        const dec = _decayed(c, dn, cfg.halfLife);
        c.n = dec.n + 1;
        c.hit = dec.hit + (leg.outcome === 'hit' ? 1 : 0);
        c.devig = dec.devig + leg.prob;
        c.day = Math.max(c.day ?? dn, dn);
        c.tail = leg.outcome === 'hit' ? (c.tail ?? 0) + 1 : 0;
    }
}

// Calibrated-corrected probability for one candidate leg.
export function scoreHuntLeg(leg, fx, modelP, state, dn, cfg = DEFAULT_HUNT) {
    let x = logit(leg.prob);
    if (modelP != null) x += cfg.wModel * (logit(modelP) - logit(leg.prob));
    let corr = 0;
    for (const d of Object.keys(HUNT_DIMS)) {
        const rawCell = _cell(state, d, HUNT_DIMS[d](leg, fx));
        const c = _decayed(rawCell, dn, cfg.halfLife);
        if (c.n < cfg.minN) continue;
        const exp = c.devig / Math.max(c.n, 1e-9);
        const rate = (c.hit + cfg.k * exp) / (c.n + cfg.k);
        corr += logit(rate) - logit(exp);
        if (rawCell.tail >= cfg.weaponTail) corr += cfg.weaponBonus;
    }
    x += cfg.wCells * Math.max(-1.5, Math.min(1.5, corr));
    const p = sigmoid(x);
    return { p, ev: p * leg.price - 1 };
}

// Pick the day's Hunter singles: per band, the reliability cascade admits the
// best EV pick whose floor clears (crazy first). One leg per fixture; never a
// fixture already used by the ladder; never a leg contradicting the fixture's
// published tip. rows: [{ id, league, menuLegs, eligible, tipMarket, fx,
// modelProbs }] - modelProbs is the fixture's Dixon-Coles market map or null.
export function selectHunterPicks(rows, state, dn, cfg = DEFAULT_HUNT, usedFixtures = new Set()) {
    const safeContradicts = (a, b) => { try { return contradicts(a, b); } catch { return true; } };
    const cands = [];
    for (const r of rows) {
        if (!r.eligible) continue;
        if (usedFixtures.has(r.id)) continue;
        for (const l of r.menuLegs) {
            const price = Number(l.price);
            if (!(price >= 2.0) || price >= 6.0) continue;
            if (r.tipMarket && r.tipMarket !== l.market && safeContradicts(r.tipMarket, l.market)) continue;
            const { p, ev } = scoreHuntLeg(l, r.fx, r.modelProbs?.[l.market] ?? null, state, dn, cfg);
            cands.push({ fixture: r.id, league: r.league ?? '', market: l.market, price, prob: l.prob, p, ev });
        }
    }
    const picks = [];
    const used = new Set(usedFixtures);
    for (const [band, [lo, hi]] of Object.entries(cfg.bands)) {
        const floors = [...cfg.cascade];
        let taken = 0;
        for (const fl of floors) {
            if (taken >= cfg.perBand) break;
            const pool = cands.filter(c => c.price >= lo && c.price < hi && c.ev >= fl && !used.has(c.fixture))
                .sort((a, b) => (b.ev - a.ev) || (a.fixture - b.fixture));
            for (const c of pool) {
                if (taken >= cfg.perBand) break;
                used.add(c.fixture);
                picks.push({ ...c, band });
                taken++;
            }
        }
    }
    return picks;
}
