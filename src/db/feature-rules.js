// Premium feature registry - THE single place the "who gets what" decision
// lives (engine-v2 spec decision 3, generalized 2026-08-19 at owner request:
// "premium features should be easy to toggle so in the future they can be easy
// to gate to users or a subscription").
//
// Pure, zero imports, so BOTH sides consume it verbatim: src/server.js gates
// the routes and the payload shape, web/src/details.js gates what renders.
// One registry, no client/server drift - the magic-rules idiom.
//
// Adding a premium surface = one FEATURES entry. Gating one later = change its
// minTier here, or (no deploy needed) name it in the GUEST_PREMIUM_EXCEPT
// setting. Nothing else in the codebase should branch on isGuest/signedIn for
// a premium decision again.

// Access tiers, least to most privileged. A user's tier comes from the session
// (or 'guest' for none); a feature's minTier is the floor it demands.
export const TIERS = ['guest', 'user', 'admin'];
const RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

// minTier      - the floor this feature demands.
// accountBound - structurally impossible without a real session (it reads or
//                writes rows owned by a user id). GUEST_PREMIUM must NEVER
//                open these, however the settings are configured: there is no
//                account to hang the data on. Enforced below, not by comment.
// label        - admin-facing name (the settings hint enumerates these).
export const FEATURES = {
    // --- Datatable surfaces (the main focus area) ---
    tip_reasoning: { minTier: 'guest', label: 'Tip reasoning (blend, runners-up, AI double-check, exact confidence)' },
    future_dates: { minTier: 'guest', label: 'Upcoming (future-dated) fixtures' },
    sure_bets: { minTier: 'guest', label: 'Sure bets list' },
    safe_picks: { minTier: 'guest', label: 'Safe-only selection' },
    methodology: { minTier: 'guest', label: 'Magic-sort methodology + backtest numbers' },
    // --- Cards / timeline ---
    daily_multibet: { minTier: 'guest', label: 'Daily MultiBet full card + timeline' },
    // --- Account-bound: a session is a data requirement, not a paywall ---
    slip_sharing: { minTier: 'user', accountBound: true, label: 'Saved + shareable slips' },
    prefs_sync: { minTier: 'user', accountBound: true, label: 'Cross-device settings sync' },
};

// Guest-openable features: everything the GUEST_PREMIUM master switch governs.
export const GUEST_FEATURES = Object.keys(FEATURES)
    .filter(k => FEATURES[k].minTier === 'guest' && !FEATURES[k].accountBound);

// Session user (or null/undefined) -> tier string.
export function userTier(user) {
    if (!user) return 'guest';
    return user.role === 'admin' ? 'admin' : 'user';
}

// The floor a feature actually demands right now, after the runtime settings.
// GUEST_PREMIUM off lifts every guest-tier feature to 'user' (the pre-2026-08
// behavior); on, it leaves them at 'guest' EXCEPT any key named in
// GUEST_PREMIUM_EXCEPT, which is the per-feature clawback that lets an admin
// re-gate one surface without a deploy. accountBound features ignore both.
export function effectiveMinTier(feature, opts = {}) {
    const spec = FEATURES[feature];
    if (!spec) throw new Error(`unknown feature: ${feature}`);
    if (spec.accountBound || spec.minTier !== 'guest') return spec.minTier;
    if (!opts.guestPremium) return 'user';
    return parseFeatureList(opts.guestExcept).includes(feature) ? 'user' : 'guest';
}

// CSV / array / null -> array of trimmed non-empty feature keys. Total: the
// value is admin-typed free text, so junk must degrade to "no exceptions"
// rather than throw on a request path.
export function parseFeatureList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (value == null) return [];
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

// Is this user allowed this feature? Unknown keys throw loudly - a typo'd gate
// must never fail open. opts: { guestPremium, guestExcept }.
export function featureAllowed(user, feature, opts = {}) {
    return RANK[userTier(user)] >= RANK[effectiveMinTier(feature, opts)];
}

// Every feature resolved for one user - what the web client gates on, so the
// browser and the server reach their answers through the same function.
export function featureMap(user, opts = {}) {
    return Object.fromEntries(Object.keys(FEATURES).map(k => [k, featureAllowed(user, k, opts)]));
}
