// Pure betting-performance calculations shared by the CLI `performance`
// action and GET /api/performance. Zero imports (like goals-rules.js /
// tip-rules.js) so tests run without .env/DB.
//
// Honesty first: hit-rate alone cannot prove profit - a 73% rate at average
// price 1.30 loses money (break-even rate = 1/avg price). Every block
// therefore reports flat-stake ROI (1 unit per settled pick with a known
// price) beside the hit-rate, and the buckets slice by confidence band,
// market group and EDGE (confidence x price - 1, the expected-value proxy)
// so false positives can be located, not just counted.
//
// AI vetoes never clear a pick (the outcome still settles), so the vetoed
// set is reported separately: a negative vetoed profit means the AI's vetoes
// saved money.

const WINDOW_DAYS = { '7d': 7, '30d': 30, all: null };
const DAY_MS = 86_400_000;

const _round = v => Math.round(v * 10000) / 10000 + 0; // + 0 normalizes -0

// Canonical tip market key -> reporting group
export function marketGroup(market) {
    if (['1', 'X', '2'].includes(market)) return '1X2';
    if (['1X', 'X2', '12'].includes(market)) return 'double_chance';
    if (/^[OU] /.test(String(market))) return 'over_under';
    if (['GG', 'NG'].includes(market)) return 'btts';
    if (['DNB1', 'DNB2'].includes(market)) return 'dnb';
    if (/^TT:/.test(String(market))) return 'team_total';
    if (['ODD', 'EVEN'].includes(market)) return 'odd_even';
    return 'other';
}

// Confidence band label for bucketing (tips floor at 0.5 by config)
export function confidenceBand(confidence) {
    if (confidence == null) return 'unknown';
    if (confidence >= 0.8) return '0.80+';
    if (confidence >= 0.7) return '0.70-0.79';
    if (confidence >= 0.6) return '0.60-0.69';
    if (confidence >= 0.5) return '0.50-0.59';
    return '<0.50';
}

// Expected-value proxy: blended probability x decimal price - 1
export function edgeOf(confidence, price) {
    return confidence == null || price == null ? null : _round(confidence * price - 1);
}

// Flat-stake stats over one bet list [{ price, outcome }]:
// outcome 'hit'|'miss'|'void'|null(pending); profit/roi only over settled
// bets carrying a price (1 unit staked each). 'void' (a DNB push) is the
// ledger's stake-returned outcome: counted separately, excluded from
// settled/staked/profit entirely (no win, no loss, nothing bet nets to zero).
function _stats(bets) {
    const s = { picks: bets.length, hits: 0, misses: 0, voids: 0, pending: 0 };
    let profit = 0, staked = 0, priceSum = 0;
    for (const b of bets) {
        if (b.outcome === 'void') { s.voids++; continue; }
        if (b.outcome === 'hit') s.hits++;
        else if (b.outcome === 'miss') s.misses++;
        else { s.pending++; continue; }
        if (b.price != null) {
            staked++;
            priceSum += b.price;
            profit += b.outcome === 'hit' ? b.price - 1 : -1;
        }
    }
    const settled = s.hits + s.misses;
    s.rate = settled ? _round(s.hits / settled) : null;
    s.avg_price = staked ? _round(priceSum / staked) : null;
    s.break_even = s.avg_price ? _round(1 / s.avg_price) : null;
    s.staked = staked;
    s.profit = _round(profit);
    s.roi = staked ? _round(profit / staked) : null;
    return s;
}

const _byWindow = (bets, now) => Object.fromEntries(
    Object.entries(WINDOW_DAYS).map(([label, days]) => [
        label,
        _stats(days == null ? bets : bets.filter(b => b.t >= now - days * DAY_MS)),
    ]),
);

// Group + stat one bet list by a labeling function (bucket insertion order
// follows first occurrence; callers sort for display).
function _buckets(bets, labelOf) {
    const groups = new Map();
    for (const b of bets) {
        const label = labelOf(b);
        let list = groups.get(label);
        if (!list) groups.set(label, list = []);
        list.push(b);
    }
    return Object.fromEntries([...groups].map(([label, list]) => [label, _stats(list)]));
}

const _aiImpact = vetoedBets => {
    const vetoed = _stats(vetoedBets);
    // What following the vetoes was worth: the profit NOT made on them
    return { vetoed, saved: _round(-vetoed.profit) };
};

// rows: fixture_predictions x fixtures ledger entries
//   { kickoff, hot, score, outcome, over_price, ai_verdict,
//     tip_market, tip_price, tip_confidence, tip_outcome, tip_ai_verdict }
// (DECIMAL columns may arrive as strings - coerced here.)
export function summarizePerformance(rows, now = Date.now()) {
    const tips = [], tipsVetoed = [], hot = [], hotVetoed = [];
    for (const r of rows) {
        const t = new Date(r.kickoff).getTime();
        // Hot picks stake the O 2.5 at the price recorded at compute time.
        // ai_verdict 'veto' rows were rule-hot picks the AI overturned.
        if (r.hot || r.ai_verdict === 'veto') {
            const bet = {
                t,
                price: r.over_price == null ? null : Number(r.over_price),
                outcome: r.outcome ?? null,
                confidence: r.score == null ? null : Number(r.score),
            };
            (r.hot ? hot : hotVetoed).push(bet);
        }
        if (r.tip_market != null) {
            const bet = {
                t,
                price: r.tip_price == null ? null : Number(r.tip_price),
                outcome: r.tip_outcome ?? null,
                confidence: r.tip_confidence == null ? null : Number(r.tip_confidence),
                market: r.tip_market,
            };
            (r.tip_ai_verdict === 'veto' ? tipsVetoed : tips).push(bet);
        }
    }
    const _edgeLabel = b => {
        const e = edgeOf(b.confidence, b.price);
        return e == null ? 'unknown' : e >= 0 ? 'positive' : 'negative';
    };
    return {
        generated_at: new Date(now).toISOString(),
        tips: {
            windows: _byWindow(tips, now),
            buckets: {
                confidence: _buckets(tips, b => confidenceBand(b.confidence)),
                market: _buckets(tips, b => marketGroup(b.market)),
                // Per-line O/U slice: the 2026-07-05 failure analysis localized
                // tip losses to specific lines (near-Unders, tail-Overs); this
                // keeps each line's ROI measurable after the gates.
                ou_line: _buckets(tips.filter(b => /^[OU] /.test(String(b.market ?? ''))), b => b.market),
                edge: _buckets(tips, _edgeLabel),
            },
            ai_impact: _aiImpact(tipsVetoed),
        },
        hotpicks: {
            windows: _byWindow(hot, now),
            buckets: {
                confidence: _buckets(hot, b => confidenceBand(b.confidence)),
                edge: _buckets(hot, _edgeLabel),
            },
            ai_impact: _aiImpact(hotVetoed),
        },
    };
}
