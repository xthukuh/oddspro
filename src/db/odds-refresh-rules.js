// Pure odds-refresh scheduling rules (zero imports so tests skip
// config/.env): kickoff-proximity decaying backoff for the per-game odds
// DETAIL fetches, and the idle-aware light pass. Consumed by
// src/db/store.js#oddsExcludeIds and src/auto-refresh.js#lightRefresh;
// clock always injected as epoch ms (auto-rules convention).
//
// Semantics: a tier `upToMin:maxAgeMin` means "with kickoff at most upToMin
// minutes away, refresh only when the last odds write is at least maxAgeMin
// minutes old". maxAgeMin 0 = refresh every pass - the FIRST tier is the
// near-kickoff always-refresh guarantee that keeps is_stale detection
// current (vanished markets are only ever flagged on an actual refresh).
// Every failure mode is fail-open toward refreshing: bad config, missing
// stamps or junk inputs must degrade to today's behavior (fetch), never to
// silently frozen odds.

export const DEFAULT_ODDS_TIERS = '90:0,360:30,1440:120,*:360';

// CSV -> ascending [{ upToMin, maxAgeMin }] (catch-all `*` = Infinity, last
// only, optional - beyond the last boundary means "always refresh").
// 'off'/blank/any invalid entry -> null = backoff disabled (never skip).
export function parseOddsTiers(value) {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s || s === 'off' || s === '0') return null;
    const tiers = [];
    for (const part of s.split(',')) {
        const m = /^\s*(\*|\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
        if (!m) return null;
        const upToMin = m[1] === '*' ? Infinity : Number(m[1]);
        const maxAgeMin = Number(m[2]);
        if (!Number.isFinite(maxAgeMin) || maxAgeMin < 0) return null;
        tiers.push({ upToMin, maxAgeMin });
    }
    for (let i = 1; i < tiers.length; i++) {
        if (!(tiers[i].upToMin > tiers[i - 1].upToMin)) return null; // must strictly ascend; '*' only last
    }
    if (tiers.slice(0, -1).some(t => t.upToMin === Infinity)) return null;
    return tiers.length ? tiers : null;
}

// Should this game's detail fetch run now? true = refresh, false = skip.
export function oddsRefreshDue(nowMs, kickoffMs, updatedAtMs, tiers) {
    if (!Array.isArray(tiers) || !tiers.length) return true; // backoff disabled
    const nowN = Number(nowMs), kick = Number(kickoffMs), upd = Number(updatedAtMs);
    if (!Number.isFinite(nowN) || !Number.isFinite(kick) || updatedAtMs == null || !Number.isFinite(upd)) return true;
    const minsToKickoff = (kick - nowN) / 60_000;
    if (minsToKickoff <= 0) return true; // started/past: not this policy's call
    const tier = tiers.find(t => minsToKickoff <= t.upToMin);
    if (!tier) return true; // beyond the last boundary with no catch-all
    const ageMin = (nowN - upd) / 60_000;
    return ageMin >= tier.maxAgeMin;
}

// Idle-aware light pass: skip the whole odds+link scrape during free periods
// (nothing in-play, next kickoff far), while still running every
// idleEveryMin so newly published games are discovered within a bounded
// window - a skipped list fetch can't see them at all.
// `matches` = today's known matches: [{ startMs, completed }].
// Returns { skip, reason } (reason feeds the log line).
export function lightPassIdle(nowMs, matches, {
    lookaheadMin = 120, inplayWindowMin = 240, idleEveryMin = 60, lastOddsPassMs = null,
} = {}) {
    const look = Number(lookaheadMin);
    if (!Number.isFinite(look) || look <= 0) return { skip: false, reason: 'disabled' };
    const nowN = Number(nowMs);
    const list = Array.isArray(matches) ? matches.filter(x => Number.isFinite(Number(x?.startMs))) : [];
    if (!list.length) return { skip: false, reason: 'no-known-matches' };
    const inplayCutoff = nowN - Number(inplayWindowMin) * 60_000;
    if (list.some(x => !x.completed && Number(x.startMs) <= nowN && Number(x.startMs) >= inplayCutoff)) {
        return { skip: false, reason: 'in-play' };
    }
    const nextKick = list.map(x => Number(x.startMs)).filter(t => t > nowN).sort((a, b) => a - b)[0] ?? null;
    if (nextKick != null && nextKick - nowN <= look * 60_000) {
        return { skip: false, reason: 'kickoff-near' };
    }
    // Idle. Still run on a slow cadence so new games get discovered.
    const every = Number(idleEveryMin);
    if (every > 0) {
        const last = Number(lastOddsPassMs);
        if (lastOddsPassMs == null || !Number.isFinite(last) || nowN - last >= every * 60_000) {
            return { skip: false, reason: 'idle-run-due' };
        }
    }
    return { skip: true, reason: 'idle' };
}
