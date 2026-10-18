// The warm keeper: the always-on service inside `npm run serve` that
// precomputes every heavy read payload AHEAD of demand, so no visitor (nor
// the owner's own next visit) ever pays a cold compute. It replaces the old
// visitor-wakes-the-cache behavior: previously only /api/columns and the
// magic-sort day memo were kept warm on a fixed 30s tick, while /api/records
// - the exact payload behind the table spinner - went cold on every
// warehouse_version bump (each 10-minute light pass) and recomputed on the
// first human to arrive.
//
// Freshness contract (the reason this can never serve stale data): the
// response memo (src/http-cache.js) is keyed on the shared warehouse_version
// (src/meta.js), so a successful refresh invalidates every entry atomically.
// The keeper only decides WHEN to recompute: the moment the version moves
// (writer: bumped in-process; follower: seen via the 5s meta poll), plus an
// age-based re-warm below the memo's TTL so a slot can never expire cold
// between bumps. Decision math is pure src/db/warm-rules.js (offline-tested).
//
// Multi-instance: the memo is per-process, so the keeper runs in EVERY
// instance (writer and followers alike), and every instance loads the SAME
// way - /api/columns reads the catalog persisted in shared meta rather than
// re-running the odds_markets scan (see the target's own note below).
// Passes run one target at a time - DB_POOL_MAX is small on the live host,
// and a parallel warm would starve real requests.
//
// Deliberately NOT quiesced during a maintenance window: warming is local DB
// reads (never billed/outbound work), and the caches should be hot the
// moment the window ends - the same reasoning that keeps the light refresh
// pass running (src/maintenance.js).

import { config } from './config.js';
import { effective } from './settings.js';
import { columnCatalogFromMeta, marketSelection } from './db/records.js';
import { hotpicksSummary, performanceSummary } from './hotpicks.js';
import { magicSortCached, magicSortKey } from './magic.js';
import { warehouseVersion } from './meta.js';
import { accessFromUser } from './db/access-rules.js';
import { featureMap } from './db/feature-rules.js';
import { rankedAllow, leanRecordsKey, leanRecordsBody } from './records-lean.js';
import { warmDates, warmPassDue, recordsWarmTargets, summarizeWarmPass } from './db/warm-rules.js';
import { _dtime } from './utils.js';

const TICK_MS = 5_000;

// What a pass is due on: the warehouse version, plus the inputs of the ranked
// and magic-sort slots that are not in the data (today's calibration landing,
// a new day, an admin SAFE_* edit - all carried by magicSortKey). Without the
// second half, the lean records slots warmed while the calibration was still
// computing would only be replaced on the next age pass, minutes later.
const warmVersion = () => `${warehouseVersion()}|${magicSortKey()}`;

const state = {
    cache: null,
    timer: null,
    running: false,
    lastRunAt: null,
    lastVersion: null,
    last: null,             // summarized result of the most recent pass
    lastMagicError: null,   // log a persistent magic-sort failure once, not per pass
};

// Which access tiers are actually reachable under the LIVE policy - the same
// expression the /api/records route uses to build its cache key, so the
// warmed slots are byte-for-byte the ones real requests will hit. Duplicate
// tiers (premium guest == signed-in 'full') collapse in recordsWarmTargets.
function reachableTiers() {
    if (!config.AUTH_ENABLED) return [{ tier: 'full', canFuture: true, access: null, allow: rankedAllow(null) }];
    const opts = { guestPremium: effective('GUEST_PREMIUM'), guestExcept: effective('GUEST_PREMIUM_EXCEPT') };
    const slim = !effective('API_DETAILS');
    return [{ role: 'user' }, null].map(user => {
        const access = accessFromUser(user, opts);
        return {
            tier: !access.fullDetail ? 'guest' : (slim ? 'slim' : 'full'),
            canFuture: access.canFuture,
            access,
            // The ranked block's gates, resolved exactly as the route does.
            allow: rankedAllow(featureMap(user, opts)),
        };
    });
}

// The pass target list: /api/columns first (the SPA boot needs the catalog),
// then /api/records with today leading (the slot the next visitor hits),
// then the ledger scans, then /api/magic-sort. Each target's `key` is EXACTLY
// the route's memo key - the default SPA request (since 2026-10-18) is the
// LEAN one: date + per_page=all + lean=1 + the catalog's default market
// columns, everything else absent - so a warmed slot is a guaranteed memo
// hit, never a near-miss. The legacy full shape (machine consumers, ?lean
// absent) is no longer warmed: no browser asks for it.
function buildTargets() {
    const todayIso = _dtime(new Date()).slice(0, 10);
    const tiers = reachableTiers();
    const byTier = new Map(tiers.map(t => [t.tier, t]));
    const slimDetails = !effective('API_DETAILS');
    const dates = warmDates(todayIso, effective('WARM_DATES_BACK'), effective('WARM_DATES_AHEAD'));
    const targets = [{
        key: '/api/columns',
        label: '/api/columns',
        // FIX (2026-08-28): EVERY instance - the writer included - serves the
        // catalog persisted in shared meta. The writer used to call the raw
        // columnCatalog() here, which re-ran the odds_markets aggregate on
        // every warm pass: measured on the live host at ~15s over 12.9M rows
        // / 3.5GB, returning 213k tuples, and a pass is due on every
        // warehouse_version bump (each 15-minute light pass) plus every
        // WARM_MAX_AGE_MINUTES (default 5). That is ~288 full scans a day of
        // a catalog that changes when a bookmaker adds a market family, and
        // under load the scan was being killed mid-flight - 175 of 297
        // stderr lines were this one query, and meta.column_catalog had gone
        // 6 days stale as a result.
        //
        // The scan still happens, exactly where it was always designed to:
        // src/auto-refresh.js's _storeColumnCatalog, writer-only and
        // throttled to once per 30 minutes (always on a full sweep). See the
        // multi-instance note on columnCatalogFromMeta in src/db/records.js.
        loader: () => columnCatalogFromMeta(),
    }];
    for (const { date, tier } of recordsWarmTargets({ dates, todayIso, tiers })) {
        const { access, allow } = byTier.get(tier);
        targets.push({
            key: leanRecordsKey({ day: date, tier, markets: 'default', allow, params: { per_page: 'all' } }),
            label: `/api/records ${date} ${tier}`,
            loader: async () => leanRecordsBody({
                date,
                per_page: 'all',
                sort: [],
                filters: [],
                completed: true,
                providers: null,
                access,
                markets: (await marketSelection('default')).allow,
                slimDetails,
            }, allow),
        });
    }
    targets.push(
        { key: '/api/hotpicks', label: '/api/hotpicks', loader: () => hotpicksSummary() },
        { key: '/api/performance', label: '/api/performance', loader: () => performanceSummary() },
        // Last: on a cold boot it awaits the day's calibration (the early
        // non-awaited kickoff in runPass started it), and nothing behind it
        // should wait on that.
        { key: magicSortKey(), label: '/api/magic-sort', loader: () => magicSortCached() },
    );
    return targets;
}

async function runPass(reason) {
    state.running = true;
    const startedMs = Date.now();
    const versionAtStart = warmVersion();
    // The magic-sort day memo feeds two warmed slots (its own body, last in
    // the list, and the lean records' ranked block) and its cold compute is
    // the worst first-visitor stall in the app (287.9 s measured locally
    // before the leg cells moved to meta). Kick it off WITHOUT awaiting - it
    // must not block the records warm behind it; magicSortCached shares one
    // in-flight promise per day, so repeated pass-time calls are free.
    magicSortCached()
        .then(() => { state.lastMagicError = null; })
        .catch(e => {
            const message = e?.message ?? String(e);
            if (message !== state.lastMagicError) {
                state.lastMagicError = message;
                console.warn(`[warm] magic-sort failed: ${message}`);
            }
        });
    const maxAgeMs = Math.max(1, Number(effective('WARM_MAX_AGE_MINUTES')) || 5) * 60_000;
    const results = [];
    for (const t of buildTargets()) {
        const t0 = Date.now();
        try {
            const { computed } = await state.cache.warm(t.key, t.loader, { maxAgeMs });
            results.push({ key: t.label, ok: true, computed, ms: Date.now() - t0 });
        } catch (e) {
            results.push({ key: t.label, ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) });
        }
    }
    const ms = Date.now() - startedMs;
    const summary = summarizeWarmPass(results);
    state.last = { reason, started_at: _dtime(new Date(startedMs)), ms, ...summary };
    // Stamp the pass even when targets failed: a broken loader must retry at
    // the next due pass (age/version), never in a 5s tight loop against a
    // struggling DB.
    state.lastRunAt = startedMs;
    state.lastVersion = versionAtStart;
    state.running = false;
    if (summary.computed > 0 || summary.failed > 0) {
        console.debug(`[warm] ${reason} pass: ${summary.computed}/${summary.targets} computed in ${ms}ms`
            + (summary.failed ? `, ${summary.failed} FAILED` : ''));
        for (const err of summary.errors) console.warn(`[warm] ${err.key} failed: ${err.error}`);
    }
}

function tick() {
    if (!state.cache || !effective('WARM_ENABLED')) return;
    const maxAgeMs = Math.max(1, Number(effective('WARM_MAX_AGE_MINUTES')) || 5) * 60_000;
    const reason = warmPassDue({
        running: state.running,
        lastRunAt: state.lastRunAt,
        version: warmVersion(),
        lastVersion: state.lastVersion,
        nowMs: Date.now(),
        maxAgeMs,
    });
    if (reason) runPass(reason).catch(e => console.error(`[warm] pass crashed: ${e?.message ?? e}`));
}

// The monitoring surface: rides GET /api/refresh (the endpoint the web
// already polls every 60s), so keeper health is observable from any browser
// or curl without a new route. Kept small - errors are capped upstream.
export function warmStatus() {
    return {
        enabled: Boolean(effective('WARM_ENABLED')),
        running: state.running,
        version: state.lastVersion,
        last: state.last,
    };
}

export function startWarmKeeper({ cache }) {
    if (state.timer) return;
    state.cache = cache;
    state.timer = setInterval(tick, TICK_MS);
    state.timer.unref?.();
    tick(); // boot: pay every cold compute now, not on the first user request
}

export function stopWarmKeeper() {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
}
