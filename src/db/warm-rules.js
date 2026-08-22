// Pure warm-keeper rules (zero imports, offline-tested). The decision math
// behind src/warm.js - the always-on service that precomputes the heavy read
// payloads (records/columns/hotpicks/performance) inside the serve process so
// no visitor ever pays a cold compute. Freshness is the whole point: a pass
// runs the moment the shared warehouse_version moves (a refresh landed new
// odds), plus an age-based re-warm so the response memo's TTL can never
// expire cold between version bumps.

// The date window worth keeping hot: yesterday..today+ahead by default -
// exactly the days the SPA's chevrons/prefetch reach first. Noon-anchored UTC
// date math so an offset can never shift the day (the CalendarPopover idiom).
export function warmDates(todayIso, back = 1, ahead = 2) {
    const base = Date.parse(`${todayIso}T12:00:00Z`);
    if (!Number.isFinite(base)) return [];
    const b = Math.max(0, Math.floor(Number(back) || 0));
    const a = Math.max(0, Math.floor(Number(ahead) || 0));
    const out = [];
    for (let i = -b; i <= a; i++) {
        out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
    }
    return out;
}

// Should a warm pass run this tick, and why. Reasons, in precedence order:
//   'boot'    - never ran in this process; pay the cold computes now.
//   'version' - warehouse_version moved since the last pass (a refresh landed
//               new data; every memo entry just went stale).
//   'age'     - the last pass is older than maxAgeMs. This forces a recompute
//               BEFORE the response memo's TTL expires, and doubles as the
//               staleness ceiling against out-of-process writers (a CLI sweep
//               against the same DB) that never bump the in-memory version.
// null while a pass is already running - passes never overlap.
export function warmPassDue({ running, lastRunAt, version, lastVersion, nowMs, maxAgeMs }) {
    if (running) return null;
    if (lastRunAt == null) return 'boot';
    if (version !== lastVersion) return 'version';
    if (Number(nowMs) - Number(lastRunAt) >= Number(maxAgeMs)) return 'age';
    return null;
}

// The (date, tier) matrix of /api/records slots to keep hot. Tiers arrive as
// [{tier, canFuture}] descriptors (the server enumerates which tiers are
// actually reachable under the live GUEST_PREMIUM/API_DETAILS policy);
// duplicates collapse - a premium guest and a signed-in user share the 'full'
// slot, warming it twice would be waste. A no-future tier skips dates past
// today: the route 403s those requests before the cache, so a warmed slot
// there could never be served. Today is ordered first - it is the slot the
// next visitor will actually hit.
export function recordsWarmTargets({ dates = [], todayIso, tiers = [] }) {
    const seen = new Set();
    const uniq = tiers.filter(t => t && t.tier && !seen.has(t.tier) && seen.add(t.tier));
    const ordered = [...dates].sort((x, y) =>
        x === todayIso ? -1 : y === todayIso ? 1 : (x < y ? -1 : x > y ? 1 : 0));
    const out = [];
    for (const date of ordered) {
        for (const t of uniq) {
            if (!t.canFuture && todayIso && date > todayIso) continue;
            out.push({ date, tier: t.tier });
        }
    }
    return out;
}

// Pass result rollup for the monitoring surface (GET /api/refresh `warm`
// block + the per-pass log line). `computed` counts entries actually rebuilt
// (a same-version young entry is a free no-op); errors are capped - the
// status payload rides a 60s client poll and must stay small.
export function summarizeWarmPass(results = []) {
    const rows = results.filter(Boolean);
    const failed = rows.filter(r => r.ok === false);
    return {
        targets: rows.length,
        computed: rows.filter(r => r.ok && r.computed).length,
        failed: failed.length,
        errors: failed.slice(0, 5).map(r => ({ key: r.key, error: r.error })),
    };
}
