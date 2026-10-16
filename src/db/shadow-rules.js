// Shadow rules (owner wizard 2026-10-16: "shipped slip + stats shadow").
// Candidate leg rules logged every day on the daily_slips row as kind
// 'shadow' legs - graded by the settle pass, never shown, never counted in
// the day's cards - so their forward record accrues without risking the
// published card. Pure and zero-import.
//
// The one rule family that survived the 2026-10-16 analysis (tmp/analysis/
// c-stats.md, hindsight-free walk-forward over the synced warehouse):
// combined SHOTS-ON-TARGET VOLUME. Measured on the settled extract:
//   GG    when V >= 10.25: train 182 legs, 63.2% vs 57.6% implied, ROI +4.8%;
//                          test 135 legs, 70.4% vs 58.8%, ROI +13.8%
//   O 2.5 when V >= 10.13: train 176 legs, ROI +4.8%; test 135 legs, ROI +4.6%
// About 4 legs a day; only ~11-16% of games have the data. One finding,
// not two (the rules share most fixtures).
//
// ALGORITHM (inputs: each team's earlier stat games, newest first, as
// { total } = both sides' 'Shots on Goal' in that game; placeholder games
// with zero shots on both sides already dropped by the loader):
//   1. Take each team's last `lastN` games strictly before the kickoff.
//   2. V = (mean total of the home team's games + mean total of the away
//      team's games) / 2. Both teams need >= minGames games, else no signal:
//      a team without stats is never given a league average.
//   3. A rule fires when V >= its threshold and the market is priced
//      >= minPrice.
export const SHADOW_DEFAULTS = Object.freeze({ lastN: 8, minGames: 3, minPrice: 1.5 });

export const SHADOW_RULES = Object.freeze([
    Object.freeze({ id: 'sot-gg', market: 'GG', minV: 10.25 }),
    Object.freeze({ id: 'sot-o25', market: 'O 2.5', minV: 10.13 }),
]);

// homeGames / awayGames: [{ total }] newest first (already pre-kickoff).
// Returns { V, nh, na } | null.
export function sotVolume(homeGames, awayGames, opts = SHADOW_DEFAULTS) {
    const o = { ...SHADOW_DEFAULTS, ...opts };
    const H = (homeGames ?? []).filter(g => Number.isFinite(g?.total)).slice(0, o.lastN);
    const A = (awayGames ?? []).filter(g => Number.isFinite(g?.total)).slice(0, o.lastN);
    if (H.length < o.minGames || A.length < o.minGames) return null;
    const mean = G => G.reduce((s, g) => s + g.total, 0) / G.length;
    return { V: Math.round(((mean(H) + mean(A)) / 2) * 100) / 100, nh: H.length, na: A.length };
}

// menu: [{ market, price, prob }]. Returns the legs every rule fires for.
export function shadowLegs(volume, menu, opts = SHADOW_DEFAULTS) {
    const o = { ...SHADOW_DEFAULTS, ...opts };
    if (!volume) return [];
    const out = [];
    for (const r of SHADOW_RULES) {
        if (!(volume.V >= r.minV)) continue;
        const l = (menu ?? []).find(m => m.market === r.market);
        if (!l || !(Number(l.price) >= o.minPrice)) continue;
        out.push({ rule: r.id, market: r.market, price: Number(l.price), prob: l.prob ?? null, V: volume.V, nh: volume.nh, na: volume.na });
    }
    return out;
}
