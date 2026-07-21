// Deployed-version detection + stale-store cleanup. The pure decisions live
// here (offline-tested); the DOM/storage effects are the two thin exported
// helpers at the bottom.
//
// NOTE the distinction from `data_version`, which already rides the same
// /api/refresh payload: data_version tracks WAREHOUSE freshness and drives the
// silent table reload. This tracks the deployed BUNDLE, which is a different
// question with a different remedy (the user must reload to get new assets;
// no amount of refetching data fixes a stale bundle).

// Baked in at build time by vite.config.js; undefined under plain node (tests).
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : null;
export const CLIENT_BUILD = BUILD_ID;

// Is the loaded bundle older than what the server is now serving?
//
// TOTAL and conservative: any missing/blank/non-string value on EITHER side
// answers false. The server returns null when web/dist has no build stamp (a
// dev run, or a backend deployed without a frontend build), and a false
// positive here nags every user to reload forever - much worse than missing
// one upgrade prompt, since the next real deploy catches it anyway.
export function isStaleBuild(clientBuild, serverBuild) {
    if (typeof clientBuild !== 'string' || !clientBuild) return false;
    if (typeof serverBuild !== 'string' || !serverBuild) return false;
    return clientBuild !== serverBuild;
}

// --- Stale localStorage cleanup ---------------------------------------------
// Keys this build knows about. Anything else under the `oddspro.` prefix is a
// leftover from a retired feature and is pruned after an upgrade.
export const KNOWN_EXACT = Object.freeze([
    'oddspro.session', 'oddspro.prefs.sync', 'oddspro.maintenance', 'oddspro.visitor',
    'oddspro.theme', 'oddspro.sort', 'oddspro.filters', 'oddspro.betslips',
    'oddspro.cols', 'oddspro.cols.order', 'oddspro.stats', 'oddspro.providers.visible',
    'oddspro.providers.order', 'oddspro.show.oneEach', 'oddspro.show.safeOnly',
    'oddspro.show.sureBets', 'oddspro.show.hideHits', 'oddspro.show.hideMiss',
    'oddspro.show.noMiss', 'oddspro.show.completed', 'oddspro.show.riskGate',
    'oddspro.safe.overrides', 'oddspro.help.seen',
]);
export const KNOWN_PREFIXES = Object.freeze(['oddspro.select.d.']);

// Keys that must NEVER be pruned even if they somehow fall outside the list
// above. `oddspro.session` is the sign-in token - pruning it logs the user out,
// which is a spectacular way for a "cleanup" to present itself. The rest are
// device-local state whose loss is silently confusing rather than visible.
export const NEVER_PRUNE = Object.freeze([
    'oddspro.session', 'oddspro.prefs.sync', 'oddspro.visitor', 'oddspro.maintenance',
]);

export function isKnownKey(key) {
    if (typeof key !== 'string') return false;
    if (KNOWN_EXACT.includes(key) || NEVER_PRUNE.includes(key)) return true;
    return KNOWN_PREFIXES.some(p => key.startsWith(p));
}

// Which keys should this build remove? Pure: takes the key list, returns the
// subset to delete.
//
// THE GUARD THAT MAKES "prune unknown" SAFE: pruning only ever runs when the
// loaded bundle IS the currently deployed one (clientBuild === serverBuild).
// Without that, the danger is backwards from how it first reads - it is the
// OLD build that does the damage. An outdated tab has an outdated key registry,
// so every key a newer build legitimately added looks "unknown" to it; pruning
// there would delete real settings and, because prefs sync pushes the whole
// map last-write-wins, propagate that deletion to every other device. A stale
// client is exactly the one already being told to reload - it must not also be
// the one deciding what is obsolete.
export function keysToPrune(allKeys, { clientBuild, serverBuild } = {}) {
    if (!clientBuild || !serverBuild || clientBuild !== serverBuild) return [];
    return (Array.isArray(allKeys) ? allKeys : [])
        .filter(k => typeof k === 'string' && k.startsWith('oddspro.'))
        .filter(k => !isKnownKey(k));
}

// --- effects ----------------------------------------------------------------

// Remove this build's obsolete keys. Returns the pruned list (for logging).
// Storage access is wrapped: a Safari private-mode / quota error here must
// never break app start-up.
export function pruneStaleStorage({ clientBuild, serverBuild, storage = null } = {}) {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return [];
    let keys;
    try {
        keys = Object.keys(store);
    } catch {
        return [];
    }
    const doomed = keysToPrune(keys, { clientBuild, serverBuild });
    for (const k of doomed) {
        try { store.removeItem(k); } catch { /* ignore - best effort */ }
    }
    if (doomed.length) console.debug('[version] pruned stale keys:', doomed.join(', '));
    return doomed;
}

// Hard reload that also defeats a cached index.html. The SPA shell is served
// no-cache, so a plain reload is normally enough; the query bust is the belt
// for an intermediary that ignored the header.
export function reloadForUpgrade() {
    if (typeof location === 'undefined') return;
    const url = new URL(location.href);
    url.searchParams.set('_v', Date.now().toString(36));
    location.replace(url.toString());
}
