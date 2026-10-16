// Rendered-view builder (engine-v2 Phase 2, spec 2026-08-06-0100): computes
// the EXACT dataset a signed-in browser renders, server-side. Possible
// because src/db/magic-rules.js is already imported verbatim by both server
// and web - one scorer, no drift - so replaying the client pipeline here
// (records -> strategy sort -> safe/sure/daily-slip flags -> view toggles)
// yields byte-equivalent ordering to the default table view. This closes the
// visual-vs-automated consumption gap: n8n and Claude read what the owner
// sees, tip justifications and AI reviews included.
import { queryRecords } from './db/records.js';
import { magicSortCached } from './magic.js';
import {
    STRATEGIES, magicSortRows, scoreTip, safeSelection, sureBetsSelection,
} from './db/magic-rules.js';
import { dailySlipPayload } from './daily-slip.js';

const DEFAULT_PROVIDER_ORDER = ['betpawa', 'betika'];

// The web's One-of-each: keep the highest-priority provider's row per
// canonical fixture (games only a lower-priority provider carries survive).
function _oneOfEach(rows, order = DEFAULT_PROVIDER_ORDER) {
    const rank = new Map(order.map((p, i) => [p, i]));
    const best = new Map();
    for (const r of rows) {
        const cur = best.get(r.api_id);
        if (!cur || (rank.get(r.provider) ?? 99) < (rank.get(cur.provider) ?? 99)) best.set(r.api_id, r);
    }
    const keep = new Set(best.values());
    return rows.filter(r => keep.has(r));
}

export function knownStrategy(id) {
    return STRATEGIES.some(s => s.id === id);
}

// access is deliberately full-tier (null): the route gates entry instead -
// this view exists to mirror the signed-in table, teasing it makes no sense.
// `access` (2026-10-16): the caller's accessFromUser() result, or null for the
// legacy full path (machine bearer, AUTH_ENABLED=0). Passed straight to
// queryRecords so a guest sees exactly what /api/records would show them -
// the same redaction and coarse buckets - never more.
// `features` (2026-10-16 security review): the caller's featureMap(), or null
// on the legacy full path. Each sibling payload follows its OWN registry
// feature, so re-locking one surface via GUEST_PREMIUM_EXCEPT re-locks it
// here too: safe_picks (Safe-only list, its policy, the safe_only param),
// sure_bets (Top picks membership and chances), daily_multibet (which games
// sit on the day's card; the teaser-level day summary stays, as on
// /api/daily-slip). A locked flag reads null, never a misleading false.
export async function renderedView({
    date, strategy = 'sure', safeOnly = false, oneEach = false, providers = null, access = null, features = null,
} = {}) {
    const allow = k => !features || features[k] === true;
    const [records, magic, slip] = await Promise.all([
        queryRecords({ date, per_page: 'all', providers, access }),
        magicSortCached(),
        dailySlipPayload(date),
    ]);
    const cal = magic.calibration;
    let rows = magicSortRows(records.data, strategy, cal);

    // Day-level memberships computed over the WHOLE loaded selection (the
    // web's Safe-only/Sure-bets discipline: toggles never change who wins
    // the per-day caps), keyed by canonical fixture id.
    const safeSet = new Set(allow('safe_picks') ? safeSelection(rows, cal, magic.safe).map(r => r.api_id) : []);
    const sureProb = new Map(allow('sure_bets') ? sureBetsSelection(rows, cal).map(({ row, prob }) => [row.api_id, prob]) : []);
    const daily = new Set(allow('daily_multibet') ? (slip?.legs ?? []).map(l => l.fixture_id) : []);

    if (oneEach) rows = _oneOfEach(rows, providers ?? DEFAULT_PROVIDER_ORDER);
    if (safeOnly && allow('safe_picks')) rows = rows.filter(r => safeSet.has(r.api_id));

    return {
        date,
        strategy,
        generated_at: new Date().toISOString(),
        strategies: ['sure', ...magic.strategies.map(s => s.id).filter(id => id !== 'sure')],
        safe_policy: allow('safe_picks') ? magic.safe : null,
        daily_slip: slip && { status: slip.status, mood: slip.mood, legs_total: slip.legs_total, outcome: slip.outcome },
        counts: {
            rows: rows.length,
            safe: allow('safe_picks') ? safeSet.size : null,
            sure: allow('sure_bets') ? sureProb.size : null,
            daily_slip_legs: allow('daily_multibet') ? daily.size : null,
        },
        rows: rows.map((r, i) => ({
            rank: i + 1,
            magic_score: scoreTip(r, strategy, cal),
            flags: {
                safe: allow('safe_picks') ? safeSet.has(r.api_id) : null,
                sure: allow('sure_bets') ? sureProb.has(r.api_id) : null,
                sure_prob: allow('sure_bets') ? (sureProb.get(r.api_id) ?? null) : null,
                daily_slip: allow('daily_multibet') ? daily.has(r.api_id) : null,
            },
            ...r,
        })),
    };
}
