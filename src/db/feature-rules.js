// Premium feature seam (engine-v2 final touches, spec decision 3):
// STRUCTURAL ONLY. Daily MultiBet and slip sharing are future premium
// subscription features; this module is the single place that decision will
// live so the eventual billing work changes one file (plus a users.tier
// column) instead of hunting route guards. v1 semantics: any signed-in user
// is allowed, guests get the teaser path. Pure, zero imports.

export const FEATURES = {
    daily_multibet: { minTier: 'user' },
    slip_sharing: { minTier: 'user' },
};

// user: the resolved session user (or null/undefined for guests). Unknown
// feature keys throw loudly: a typo'd gate must never fail open.
export function featureAllowed(user, feature) {
    if (!FEATURES[feature]) throw new Error(`unknown feature: ${feature}`);
    return user != null;
}
