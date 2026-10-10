// Pure odds-history rules: the EAT clock helpers, the pre-match gate, the
// observation kind (first / baseline / update), target-snapshot planning,
// change-log replay and the due-queue plan. Spec:
// docs/dev/specs/2026-10-10-1600-odds-history-targets.md.
//
// One sanctioned cross-pure import (odds-diff.js, itself zero-import) so the
// replay keys identities exactly the way the diff does - the access-rules ->
// feature-rules idiom. Clock always injected as epoch ms (auto-rules
// convention); every function is total over junk input.

import { oddsIdentity, priceCents } from './odds-diff.js';

export const EAT_OFFSET_MS = 3 * 3600_000;

// Target vocabulary. opening = first logged observation; the rest are
// anchored to the CANONICAL kickoff (minutes before it).
export const TARGETS = ['opening', 't24h', 't3h', 't1h', 'closing'];
export const TARGET_OFFSET_MIN = { t24h: 1440, t3h: 180, t1h: 60, closing: 0 };
export const TIMED_TARGETS = ['t24h', 't3h', 't1h', 'closing'];

// A timed target freezes only this long after target_at, so an observation
// stamped just before target_at whose transaction is still in flight has
// committed by the time the replay cutoff is read.
export const FREEZE_MARGIN_MS = 120_000;

// odds_markets moved this much later than the last logged observation =>
// something wrote odds the log never saw => the next look re-baselines.
// Generous on purpose: a normal logged write lands within the same
// transaction (milliseconds), and a false baseline costs only log volume.
export const BASELINE_TOLERANCE_MS = 60_000;

// Epoch ms -> 'YYYY-MM-DD HH:mm:ss.SSS' EAT wall-clock (a DATETIME(3) literal).
export function eatWallClock(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return null;
    return new Date(n + EAT_OFFSET_MS).toISOString().replace('T', ' ').replace('Z', '');
}

// EAT wall-clock (or offset-bearing ISO) -> epoch ms; NaN for junk. Accepts a
// Date, a number, 'YYYY-MM-DD HH:mm', ':ss', '.f' up to 6 digits (MySQL %f),
// 'T' or space separator, optional 'Z'/'+HH:MM'. No offset means EAT.
export function parseEatMs(value) {
    if (value == null || value === '') return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(String(value).trim());
    if (!m) return NaN;
    const ms = (m[4] ?? '').padEnd(3, '0').slice(0, 3) || '000';
    let off = m[5] ?? '+03:00';
    if (off !== 'Z' && !off.includes(':')) off = `${off.slice(0, 3)}:${off.slice(3)}`;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}.${ms}${off}`);
    return Number.isFinite(t) ? t : NaN;
}

// Pre-match only: history is written while the clock is strictly before the
// canonical kickoff and the match is not completed. Unknown kickoff fails
// CLOSED - writing past kickoff would break the freeze semantics, while a
// skipped look costs one observation.
export function historyGateOpen({ nowMs, kickoffMs, completed = false } = {}) {
    if (completed) return false;
    const now = Number(nowMs), kick = Number(kickoffMs);
    if (!Number.isFinite(now) || !Number.isFinite(kick)) return false;
    return now < kick;
}

// What kind of look is this? `first` - nothing on file and never logged;
// `baseline` - odds on file the log never saw (no logged look yet, or
// odds_markets moved after the last one); `update` - the normal case.
export function observationKind({ existingCount = 0, lastObsMs = null, touchedMaxMs = null, toleranceMs = BASELINE_TOLERANCE_MS } = {}) {
    const last = lastObsMs == null ? NaN : Number(lastObsMs);
    if (!(Number(existingCount) > 0)) return Number.isFinite(last) ? 'update' : 'first';
    if (!Number.isFinite(last)) return 'baseline';
    const touched = touchedMaxMs == null ? NaN : Number(touchedMaxMs);
    if (Number.isFinite(touched) && touched > last + Number(toleranceMs)) return 'baseline';
    return 'update';
}

// Target instant in epoch ms (NaN when its anchor is unknown).
export function targetAt(target, { kickoffMs = null, firstObsMs = null } = {}) {
    if (target === 'opening') return firstObsMs == null ? NaN : Number(firstObsMs);
    const off = TARGET_OFFSET_MIN[target];
    if (off == null || kickoffMs == null) return NaN;
    const kick = Number(kickoffMs);
    return Number.isFinite(kick) ? kick - off * 60_000 : NaN;
}

// Which targets of one match can be frozen now, with the row data each one
// gets. `observations` = [{ ms, kind }] in any order; `frozen` = targets
// already stored. Returns [{ target, target_at_ms, observed_at_ms, lag_seconds,
// quality }] - observed_at_ms null + quality 'missing' when no logged look
// exists at or before target_at (never filled from a later look).
export function planTargetFreezes({
    nowMs, kickoffMs = null, observations = [], frozen = [], maxLagMs = 15 * 60_000, marginMs = FREEZE_MARGIN_MS,
} = {}) {
    const done = new Set(frozen instanceof Set ? frozen : Array.isArray(frozen) ? frozen : []);
    const obs = (Array.isArray(observations) ? observations : [])
        .filter(o => Number.isFinite(Number(o?.ms)))
        .map(o => ({ ms: Number(o.ms), kind: o.kind ?? 'update' }))
        .sort((a, b) => a.ms - b.ms);
    const now = Number(nowMs);
    const out = [];
    if (!Number.isFinite(now)) return out;
    if (obs.length && !done.has('opening')) {
        out.push({
            target: 'opening', target_at_ms: obs[0].ms, observed_at_ms: obs[0].ms, lag_seconds: 0,
            quality: obs[0].kind === 'baseline' ? 'baseline' : 'ok',
        });
    }
    if (!obs.length) return out; // never logged: nothing to say about any target
    for (const target of TIMED_TARGETS) {
        if (done.has(target)) continue;
        const at = targetAt(target, { kickoffMs });
        if (!Number.isFinite(at) || now < at + Number(marginMs)) continue;
        let last = null;
        for (const o of obs) { if (o.ms <= at) last = o.ms; else break; }
        if (last == null) {
            out.push({ target, target_at_ms: at, observed_at_ms: null, lag_seconds: null, quality: 'missing' });
            continue;
        }
        const lagMs = at - last;
        out.push({
            target, target_at_ms: at, observed_at_ms: last, lag_seconds: Math.round(lagMs / 1000),
            quality: lagMs > Number(maxLagMs) ? 'lagged' : 'ok',
        });
    }
    return out;
}

// Cheap pre-filter before loading a match's observations: can ANY target be
// frozen now? Opening whenever it is not stored yet (whether a look exists is
// what the load answers); a timed target only once its target_at + margin has
// passed. Keeps the light-pass sweep from reloading every upcoming match that
// only has its opening so far.
export function targetsPossiblyDue({ nowMs, kickoffMs = null, frozen = [], marginMs = FREEZE_MARGIN_MS } = {}) {
    const done = new Set(frozen instanceof Set ? frozen : Array.isArray(frozen) ? frozen : []);
    if (!done.has('opening')) return true;
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return false;
    return TIMED_TARGETS.some(t => {
        if (done.has(t)) return false;
        const at = targetAt(t, { kickoffMs });
        return Number.isFinite(at) && now >= at + Number(marginMs);
    });
}

// Highest change id of a match at or before an observation instant (the
// snapshot cutoff). `changeRows` = [{ id, observed_ms }].
export function asOfChangeId(changeRows, observedAtMs) {
    const at = Number(observedAtMs);
    if (!Number.isFinite(at)) return null;
    let best = null;
    for (const r of Array.isArray(changeRows) ? changeRows : []) {
        const id = Number(r?.id);
        if (Number.isFinite(id) && Number(r.observed_ms) <= at && (best == null || id > best)) best = id;
    }
    return best;
}

// Replay the change log up to a cutoff id: per identity, its last event at or
// before the cutoff; a `stale` last event means "not offered". Returns the
// offered markets ordered by type_name, name, handicap.
export function replayState(changeRows, cutoffId) {
    const cut = Number(cutoffId);
    if (cutoffId == null || !Number.isFinite(cut)) return [];
    const rows = (Array.isArray(changeRows) ? changeRows : [])
        .filter(r => Number(r?.id) <= cut)
        .sort((a, b) => Number(a.id) - Number(b.id));
    const state = new Map();
    for (const r of rows) state.set(oddsIdentity(r), r);
    const out = [];
    for (const r of state.values()) {
        if (r.event === 'stale') continue;
        const cents = priceCents(r.odds);
        out.push({
            type_name: r.type_name,
            name: r.name,
            handicap: r.handicap == null ? null : Number(r.handicap),
            odds: Number.isFinite(cents) ? cents / 100 : null,
            change_id: Number(r.id),
        });
    }
    return out.sort((a, b) => String(a.type_name).localeCompare(String(b.type_name))
        || String(a.name).localeCompare(String(b.name))
        || (a.handicap ?? -Infinity) - (b.handicap ?? -Infinity));
}

// A frozen row is never rewritten; the read surface says when the canonical
// kickoff it was frozen under has since moved (minute resolution - the
// bookmaker side stores minutes).
export function kickoffMoved(storedKickoffMs, currentKickoffMs) {
    if (storedKickoffMs == null || currentKickoffMs == null) return false;
    const a = Number(storedKickoffMs), b = Number(currentKickoffMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) >= 60_000;
}

// Due-queue plan. `matches` = [{ id, kickoffMs, lastObsMs }] (upcoming,
// uncompleted). Each timed target opens a window [target_at - lead,
// target_at); a match is due while the clock is inside a window and it has
// not been looked at since the window opened. Returns { due, total,
// nextOpenMs }: `due` ordered by target_at (most urgent first) and capped,
// `nextOpenMs` the earliest window still to open (lets the caller skip the DB
// until something can become due).
export function planDueQueue(nowMs, matches, { leadMin = 5, cap = 40 } = {}) {
    const now = Number(nowMs);
    const lead = Number(leadMin) * 60_000;
    const empty = { due: [], total: 0, nextOpenMs: null };
    if (!Number.isFinite(now) || !(lead > 0)) return empty;
    const due = [];
    let nextOpenMs = null;
    for (const m of Array.isArray(matches) ? matches : []) {
        const kick = Number(m?.kickoffMs);
        if (!Number.isFinite(kick) || kick <= now) continue;
        const last = m.lastObsMs == null ? NaN : Number(m.lastObsMs);
        let picked = null;
        for (const target of TIMED_TARGETS) {
            const at = kick - TARGET_OFFSET_MIN[target] * 60_000;
            const open = at - lead;
            if (now < open) {
                if (nextOpenMs == null || open < nextOpenMs) nextOpenMs = open;
                continue;
            }
            if (now >= at) continue; // window closed - the freeze records the lag
            if (picked == null && (!Number.isFinite(last) || last < open)) picked = { id: m.id, target, target_at_ms: at };
        }
        if (picked) due.push(picked);
    }
    due.sort((a, b) => a.target_at_ms - b.target_at_ms);
    const c = Math.max(0, Math.floor(Number(cap)) || 0);
    return { due: due.slice(0, c), total: due.length, nextOpenMs };
}

// Full-sweep steps during which the due lane may run alongside the sweep:
// they write only fixtures / fixture_* / standings / fixture_predictions /
// daily slips and read odds, so they share no rows or gap ranges with the
// lane's matches / odds_markets / history writes. An ALLOW-list on purpose:
// an unknown or renamed step fails closed (the lane waits).
export const SWEEP_DUE_SAFE_STEPS = [
    /^deep stats/, /^standings/, /^team history/, /^pre-match snapshots/,
    /^API predictions/, /^hot picks/, /^daily multibet/, /^AI enrichment/,
];

export function sweepStepAllowsDue(step) {
    if (typeof step !== 'string' || !step) return false;
    return SWEEP_DUE_SAFE_STEPS.some(re => re.test(step));
}
