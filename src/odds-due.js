import { effective } from './settings.js';
import { debugLog } from './utils.js';
import { saveMatches } from './db/store.js';
import { fetchBetpawaGamesByIds } from './betpawa.js';
import { fetchBetikaGamesByIds } from './betika.js';
import { planDueQueue, TARGET_OFFSET_MIN } from './db/odds-history-rules.js';
import { canonicalWindowMatches, dbNowMs, historyEnabled, lastObservations, materializeTargets } from './odds-history.js';

// The due-queue lane (spec docs/dev/specs/2026-10-10-1600-odds-history-
// targets.md, section D): between scheduled passes, fetch just the matches
// whose T-24h / T-3h / T-1h / closing target is about to pass, through each
// bookmaker's per-event detail endpoint, and save them through the normal
// saveMatches path (source 'due') so the change log, the observation ledger
// and the target snapshots see them like any other look. The decision is the
// pure planDueQueue; this module only loads, fetches and saves.
//
// Driven by src/auto-refresh.js's writer tick, never as a startJob job: it
// does not bump warehouse_version, write the job_state beacon, the run ledger
// or last_odds_at (those mean "a collection pass finished", and at a
// 30-second cadence they would also re-warm every cache each time).

const PLAN_MAX_AGE_MS = 5 * 60_000;
const EMPTY_RECHECK_MS = 30_000;
const LOOKAHEAD_MS = (TARGET_OFFSET_MIN.t24h + 60) * 60_000;

// In-memory plan cache: the DB is read again only once a window can have
// opened (nextOpenMs), the plan is older than PLAN_MAX_AGE_MS (new matches,
// reschedules), or right after the lane ran. A restart simply re-plans.
let _cache = { atMs: 0, nextOpenMs: null };

export function dueLaneEnabled() {
    return historyEnabled() && Boolean(effective('ODDS_DUE_ENABLED'));
}

// Upcoming, uncompleted, non-virtual matches (linked or not) with their
// canonical kickoff and newest logged look. Virtual (simulated) competitions
// are excluded from this lane only: they have no real-world target worth a
// dedicated fetch and could flood it; blanket passes still log them.
async function dueCandidates(nowMs) {
    const rows = await canonicalWindowMatches(nowMs, nowMs + LOOKAHEAD_MS, {
        columns: ['provider', 'provider_match_id', 'home_team_name', 'away_team_name', 'competition_name', 'category_name'],
        where: q => q.whereNull('m.completed_at').where('m.is_virtual', false),
    });
    const lastObs = await lastObservations(rows.map(r => r.id));
    return rows.map(r => ({ ...r, lastObsMs: lastObs.get(Number(r.id)) ?? null }));
}

// One due run. `shouldStop()` is polled between saves: a manual refresh
// started by a click while this runs is never refused - the lane yields
// before its next write. Returns a summary, or null when nothing was due (and
// skips the DB entirely while the cache says no window can have opened).
export async function runDueRefresh({ shouldStop = () => false } = {}) {
    if (!dueLaneEnabled()) return null;
    const wallMs = Date.now();
    const age = wallMs - _cache.atMs;
    if (_cache.nextOpenMs != null ? (wallMs < _cache.nextOpenMs && age < PLAN_MAX_AGE_MS) : age < EMPTY_RECHECK_MS) return null;
    const nowMs = await dbNowMs();
    const candidates = await dueCandidates(nowMs);
    const plan = planDueQueue(nowMs, candidates, {
        leadMin: Number(effective('ODDS_DUE_LEAD_MINUTES')),
        cap: Number(effective('ODDS_DUE_MAX_PER_TICK')),
    });
    // nextOpenMs is in DB-clock ms; the cache compares wall ms. The offset is
    // seconds at most, far inside the lead window, so the mix is harmless.
    _cache = { atMs: wallMs, nextOpenMs: plan.due.length ? null : plan.nextOpenMs };
    if (!plan.due.length) return null;

    const byId = new Map(candidates.map(c => [Number(c.id), c]));
    const picked = plan.due.map(d => byId.get(Number(d.id))).filter(Boolean);
    const summary = { due: plan.total, picked: picked.length, fetched: 0, saved: 0, failures: 0, changes: 0, stopped: false };
    for (const provider of ['betpawa', 'betika']) {
        const rows = picked.filter(r => r.provider === provider);
        if (!rows.length) continue;
        if (shouldStop()) { summary.stopped = true; break; }
        const res = provider === 'betpawa'
            ? await fetchBetpawaGamesByIds(rows.map(r => r.provider_match_id))
            : await fetchBetikaGamesByIds(rows);
        summary.fetched += res.games.length;
        summary.failures += res.failures;
        // One save per game so the lane can yield between matches; each save
        // is the ordinary per-match transaction and freezes its own targets.
        for (const g of res.games) {
            if (shouldStop()) { summary.stopped = true; break; }
            const c = await saveMatches([g], { source: 'due' });
            summary.saved += c.inserted + c.updated;
            summary.changes += c.changes;
        }
        if (summary.stopped) break;
    }
    _cache = { atMs: 0, nextOpenMs: null }; // re-plan on the next tick
    debugLog(`[due] ${JSON.stringify(summary)}`);
    return summary;
}

// The bounded target-freeze sweep the light pass runs (targets that passed
// with no later look - most closings).
export async function sweepTargets() {
    if (!historyEnabled()) return null;
    return materializeTargets({ cap: 500 });
}
