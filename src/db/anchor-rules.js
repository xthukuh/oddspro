// Sharp-anchored Pick (2026-10-18): the shadow strategy that prices our
// Kenyan books against Pinnacle's devigged line. Pure and zero-import; the
// knex shell is src/reference-odds.js. Named "anchor" so it never collides
// with the retired Sharp 4x files (sharp-rules.js, scripts/sharp-*.js).
//
// Why (memory pinnacle-sharp-line-edge): our walk-forward calibration
// converges on the Kenyan price, so every leg returns about -6% flat. Over
// 1,933 fixtures 2026-10-11..10-17 in the 1.50-2.20 band, legs whose best
// Kenyan price beat Pinnacle's fair price returned +8.0% (ratio >= 1.00,
// n 271), +19.8% (>= 1.02, n 133), +30.8% (>= 1.04, n 75). Seven days is
// suggestive, not proof: this module only feeds a SHADOW card that
// accumulates forward days against the pass bar below.
//
// ALGORITHM (one fixture; inputs: the latest Pinnacle line per market, every
// Kenyan provider's prices per market, each team's finished-game count in the
// evidence window before kickoff):
//   1. Evidence gate: both teams need >= minTeamGames finished games in the
//      last evidenceDays days, else the fixture is dropped silently.
//   2. Devig Pinnacle multiplicatively per complete group (1/X/2, and each
//      O/U pair at 1.5 / 2.5 / 3.5): fair_i = (1/p_i) / sum_j (1/p_j).
//      A group with any price missing yields nothing.
//   3. Kenyan price per market = the best (highest) provider price, each
//      provider contributing its lowest listing (the tip-book convention).
//   4. A leg is eligible when its Kenyan price is in [minPrice, maxPrice]
//      and ratio = price x fair >= minRatio; strong when ratio >= strongRatio.
//      O 0.5 is never in the vocabulary.
//   5. The fixture's leg = the eligible leg with the highest ratio (ties:
//      higher fair, then market key). No eligible leg -> dropped silently.
// DAILY CARD (one EAT day): at most cardSize legs, one per game, strong
// first, then ratio desc. A leg's card membership is committed at its
// kickoff: committed legs keep their slots and only the open slots are
// re-chosen from games still upcoming, so no card decision ever uses
// information from after the kickoff it commits.

export const DEFAULT_ANCHOR = Object.freeze({
    minPrice: 1.5, maxPrice: 2.2,
    minRatio: 1.02, strongRatio: 1.04,
    minTeamGames: 10, evidenceDays: 400,
    cardSize: 3,
});

export const ANCHOR_GROUPS = Object.freeze([
    Object.freeze(['1', 'X', '2']),
    Object.freeze(['O 1.5', 'U 1.5']),
    Object.freeze(['O 2.5', 'U 2.5']),
    Object.freeze(['O 3.5', 'U 3.5']),
]);
export const ANCHOR_MARKETS = Object.freeze(ANCHOR_GROUPS.flat());

const _r4 = v => Math.round(v * 10000) / 10000;

// prices: { market: decimal price } -> { market: fair probability } for every
// complete group (multiplicative devig).
export function devigReference(prices) {
    const out = {};
    for (const group of ANCHOR_GROUPS) {
        const p = group.map(m => Number(prices?.[m]));
        if (!p.every(x => Number.isFinite(x) && x > 1)) continue;
        const sum = p.reduce((s, x) => s + 1 / x, 0);
        group.forEach((m, i) => { out[m] = (1 / p[i]) / sum; });
    }
    return out;
}

// rows: [{ provider, market, price }] -> { market: { price, provider } }.
// Per provider the lowest listing of a market counts (duplicates inside one
// book are taken conservatively); across providers the best price wins.
export function bestKenyanPrices(rows) {
    const perProvider = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
        const price = Number(r?.price);
        if (!r?.market || !r?.provider || !(price > 1)) continue;
        let bag = perProvider.get(r.provider);
        if (!bag) perProvider.set(r.provider, bag = {});
        if (bag[r.market] == null || price < bag[r.market]) bag[r.market] = price;
    }
    const out = {};
    for (const [provider, bag] of perProvider) {
        for (const [market, price] of Object.entries(bag)) {
            if (out[market] == null || price > out[market].price) out[market] = { price, provider };
        }
    }
    return out;
}

// Both teams carry enough finished games in the evidence window.
export function hasEvidence(homeGames, awayGames, opts = DEFAULT_ANCHOR) {
    const min = { ...DEFAULT_ANCHOR, ...opts }.minTeamGames;
    return Number(homeGames) >= min && Number(awayGames) >= min;
}

// One fixture -> its anchored leg or null (silently dropped).
// input: { kenyan: bestKenyanPrices(...), reference: { market: price },
//          homeGames, awayGames }
// Returns { market, price, provider, refPrice, fair, ratio, strong } | null.
export function anchorLeg({ kenyan, reference, homeGames, awayGames } = {}, opts = DEFAULT_ANCHOR) {
    const o = { ...DEFAULT_ANCHOR, ...opts };
    if (!hasEvidence(homeGames, awayGames, o)) return null;
    const fair = devigReference(reference);
    let best = null;
    for (const market of ANCHOR_MARKETS) {
        const f = fair[market], k = kenyan?.[market];
        if (f == null || !k) continue;
        const price = Number(k.price);
        if (!(price >= o.minPrice && price <= o.maxPrice)) continue;
        const ratio = price * f;
        if (ratio < o.minRatio) continue;
        const leg = {
            market, price, provider: k.provider, refPrice: Number(reference[market]),
            fair: _r4(f), ratio: _r4(ratio), strong: ratio >= o.strongRatio,
        };
        if (!best || leg.ratio > best.ratio || (leg.ratio === best.ratio && leg.fair > best.fair)) best = leg;
    }
    return best;
}

// Card order: strong first, then ratio desc, fair desc, fixture id asc.
export function anchorOrder(a, b) {
    if (a.strong !== b.strong) return a.strong ? -1 : 1;
    if (a.ratio !== b.ratio) return b.ratio - a.ratio;
    if (a.fair !== b.fair) return b.fair - a.fair;
    return Number(a.fixtureId) - Number(b.fixtureId);
}

// legs: one day's [{ fixtureId, ratio, fair, strong, frozen, onCard }] where
// frozen = kicked off (its stored onCard is final). Returns the Set of
// fixture ids on the card.
export function selectAnchorCard(legs, opts = DEFAULT_ANCHOR) {
    const size = { ...DEFAULT_ANCHOR, ...opts }.cardSize;
    const list = Array.isArray(legs) ? legs : [];
    const committed = list.filter(l => l.frozen && l.onCard).sort(anchorOrder).slice(0, size);
    const open = list.filter(l => !l.frozen).sort(anchorOrder).slice(0, Math.max(0, size - committed.length));
    return new Set([...committed, ...open].map(l => l.fixtureId));
}

// Due-queue moments for the Pinnacle capture, minutes before kickoff.
export const REFERENCE_MOMENTS_MIN = Object.freeze({ t3h: 180, t1h: 60 });

// fixtures: [{ id, kickoffMs, lastMs }] (lastMs = newest capture or attempt).
// A moment is due while now is within leadMin either side of it and nothing
// was captured since its window opened. Never at or after kickoff.
// Returns { due: [{ id, target }], total } most urgent first, capped.
export function planReferenceDue(nowMs, fixtures, { leadMin = 5, cap = 40 } = {}) {
    const now = Number(nowMs), lead = Number(leadMin) * 60_000;
    if (!Number.isFinite(now) || !(lead > 0)) return { due: [], total: 0 };
    const due = [];
    for (const f of Array.isArray(fixtures) ? fixtures : []) {
        const kick = Number(f?.kickoffMs);
        if (!Number.isFinite(kick) || kick <= now) continue;
        const last = f.lastMs == null ? NaN : Number(f.lastMs);
        for (const [target, min] of Object.entries(REFERENCE_MOMENTS_MIN)) {
            const at = kick - min * 60_000;
            if (now < at - lead || now >= Math.min(at + lead, kick)) continue;
            if (Number.isFinite(last) && last >= at - lead) continue;
            due.push({ id: f.id, target, atMs: at });
            break;
        }
    }
    due.sort((a, b) => a.atMs - b.atMs);
    const c = Math.max(0, Math.floor(Number(cap)) || 0);
    return { due: due.slice(0, c).map(({ id, target }) => ({ id, target })), total: due.length };
}

// Flat-stake units of one settled single.
export function legUnits(leg) {
    if (leg?.outcome === 'hit') return Number(leg.price) - 1;
    if (leg?.outcome === 'miss') return -1;
    return 0;
}

// legs: [{ price, fair, outcome }]. Void and unsettled legs are excluded.
// Returns { n, hits, hitRate, claim, units, roi, se, lo95 } (rates null at n 0).
export function anchorSummary(legs) {
    const s = (Array.isArray(legs) ? legs : []).filter(l => l?.outcome === 'hit' || l?.outcome === 'miss');
    const n = s.length;
    if (!n) return { n: 0, hits: 0, hitRate: null, claim: null, units: 0, roi: null, se: null, lo95: null };
    const u = s.map(legUnits);
    const units = u.reduce((a, b) => a + b, 0);
    const roi = units / n;
    const varS = n > 1 ? u.reduce((a, x) => a + (x - roi) ** 2, 0) / (n - 1) : 0;
    const se = n > 1 ? Math.sqrt(varS / n) : null;
    return {
        n,
        hits: s.filter(l => l.outcome === 'hit').length,
        hitRate: s.filter(l => l.outcome === 'hit').length / n,
        claim: s.reduce((a, l) => a + Number(l.fair), 0) / n,
        units, roi, se,
        lo95: se == null ? null : roi - 1.96 * se,
    };
}

// The forward pass bar (owner, 2026-10-18 findings page).
export const ANCHOR_PASS_BAR = Object.freeze({ minDays: 30, minLegs: 400, minRoi: 0, minLo95: -0.02, maxHitGap: 0.02 });

// summary: anchorSummary(...); days: distinct settled forward days.
// Returns { pass, checks: [{ name, ok, value, need }] }.
export function anchorPassBar(summary, days, bar = ANCHOR_PASS_BAR) {
    const b = { ...ANCHOR_PASS_BAR, ...bar };
    const gap = summary?.hitRate == null ? null : Math.abs(summary.hitRate - summary.claim);
    const checks = [
        { name: 'forward days', ok: days >= b.minDays, value: days, need: `>= ${b.minDays}` },
        { name: 'legs', ok: (summary?.n ?? 0) >= b.minLegs, value: summary?.n ?? 0, need: `>= ${b.minLegs}` },
        { name: 'flat ROI', ok: summary?.roi != null && summary.roi > b.minRoi, value: summary?.roi ?? null, need: `> ${(100 * b.minRoi).toFixed(1)}%` },
        { name: 'ROI lower 95%', ok: summary?.lo95 != null && summary.lo95 > b.minLo95, value: summary?.lo95 ?? null, need: `> ${(100 * b.minLo95).toFixed(1)}%` },
        { name: 'hit vs Pinnacle claim', ok: gap != null && gap <= b.maxHitGap, value: gap, need: `<= ${(100 * b.maxHitGap).toFixed(1)} pts` },
    ];
    return { pass: checks.every(c => c.ok), checks };
}
