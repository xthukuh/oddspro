import { db } from './db/connection.js';
import { effective } from './settings.js';
import { debugLog } from './utils.js';
import {
    parseEatMs, eatWallClock, planTargetFreezes, targetsPossiblyDue, asOfChangeId, replayState, kickoffMoved, TARGETS,
} from './db/odds-history-rules.js';

// Odds history, the DB half (spec docs/dev/specs/2026-10-10-1600-odds-history-
// targets.md; the decisions live in the pure src/db/odds-history-rules.js and
// src/db/odds-diff.js#diffOddsChanges):
//   - the database clock (observations are stamped from it, so they compare
//     honestly with the TIMESTAMPs MySQL writes into odds_markets),
//   - the observation + change write used INSIDE store.js's odds transaction,
//   - materializeTargets(): freezing target snapshots, once each,
//   - oddsHistoryPayload(): the read surface behind GET /api/odds-history.
// Every datetime is read through DATE_FORMAT and parsed as EAT (the
// TZ-decode hazard, see ai-rules.js#KICKOFF_SQL_EXPR).

const ID_CHUNK = 500;
const CHANGES_CHUNK = 200;
const CLOCK_TTL_MS = 5 * 60_000;
const TARGET_SET = new Set(TARGETS);

const isoMs = col => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.%f')`;
const isoS = col => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s')`;
const KICKOFF_SQL = 'COALESCE(f.kickoff, m.start_time)';

// 'YYYY-MM-DDTHH:mm:ss.SSS+03:00' for API payloads (EAT, offset explicit).
export function eatIso(ms) {
    const s = eatWallClock(ms);
    return s ? `${s.replace(' ', 'T')}+03:00` : null;
}

export function historyEnabled() {
    return Boolean(effective('ODDS_HISTORY_ENABLED'));
}

// Database "now" in epoch ms: one NOW(3) probe, kept as an offset from the
// process clock for CLOCK_TTL_MS. A failed probe keeps the last offset (0 at
// boot) - the baseline tolerance absorbs ordinary skew.
let _clock = { offsetMs: 0, atMs: 0 };
export async function dbNowMs() {
    const t0 = Date.now();
    if (t0 - _clock.atMs > CLOCK_TTL_MS) {
        try {
            const [rows] = await db.raw(`SELECT ${isoMs('NOW(3)')} AS n`);
            const dbMs = parseEatMs(rows?.[0]?.n);
            _clock = { offsetMs: Number.isFinite(dbMs) ? dbMs - Date.now() : _clock.offsetMs, atMs: t0 };
        } catch (e) {
            _clock = { ..._clock, atMs: t0 };
            console.warn('[odds-history] db clock probe failed, using the process clock:', e?.message ?? e);
        }
    }
    return Date.now() + _clock.offsetMs;
}

// match id -> epoch ms of its newest logged observation (absent = never).
export async function lastObservations(matchIds) {
    const out = new Map();
    const ids = [...new Set((matchIds ?? []).map(Number).filter(Number.isFinite))];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await db('odds_observations')
            .whereIn('match_id', ids.slice(i, i + ID_CHUNK))
            .groupBy('match_id')
            .select('match_id', db.raw(`${isoMs('MAX(observed_at)')} AS last_iso`));
        for (const r of rows) {
            const ms = parseEatMs(r.last_iso);
            if (Number.isFinite(ms)) out.set(Number(r.match_id), ms);
        }
    }
    return out;
}

// SQL projection store.js adds to its per-match odds_markets read: the newest
// write MySQL itself stamped on that match's rows (insert or stale flag).
export const TOUCHED_SQL = `${isoS('GREATEST(created_at, updated_at)')} AS touched_iso`;

// Write one observation and its change rows. MUST be called with the odds
// transaction (`trx`) so the log and odds_markets can never disagree.
export async function writeObservation(trx, { matchId, observedMs, kickoffMs, kind, source = null, markets = 0, changes = [] }) {
    const observed_at = eatWallClock(observedMs);
    await trx('odds_observations').insert({
        match_id: matchId,
        observed_at,
        kind,
        source,
        kickoff_at: eatWallClock(kickoffMs).slice(0, 19),
        markets,
        changes: changes.length,
    });
    if (changes.length) {
        const rows = changes.map(c => ({
            match_id: matchId, type_name: c.type_name, name: c.name, handicap: c.handicap,
            odds: c.odds, prev_odds: c.prev_odds, event: c.event, observed_at,
        }));
        await db.batchInsert('odds_changes', rows, CHANGES_CHUNK).transacting(trx);
    }
    return changes.length;
}

// Canonical kickoff for a set of match ids -> Map id -> ms.
async function _kickoffsFor(matchIds) {
    const out = new Map();
    const ids = [...new Set((matchIds ?? []).map(Number).filter(Number.isFinite))];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await db('matches as m')
            .leftJoin('fixtures as f', 'f.id', 'm.fixture_id')
            .whereIn('m.id', ids.slice(i, i + ID_CHUNK))
            .select('m.id', db.raw(`${isoS(KICKOFF_SQL)} AS kickoff_iso`));
        for (const r of rows) out.set(Number(r.id), parseEatMs(r.kickoff_iso));
    }
    return out;
}

// Matches whose CANONICAL kickoff falls in [fromMs, toMs]. Two indexed
// queries (bookmaker start_time, and linked fixtures' kickoff) merged by id:
// a linked match whose stored start_time went stale on a reschedule is still
// found through its fixture, without an OR that would defeat both indexes.
// `columns` are extra matches columns to select; `start_local` is always the
// stored bookmaker start_time as EAT wall-clock text. Returns
// [{ ...row, kickoffMs }].
export async function canonicalWindowMatches(fromMs, toMs, { columns = [], where = null } = {}) {
    const from = eatWallClock(fromMs).slice(0, 19), to = eatWallClock(toMs).slice(0, 19);
    const cols = ['m.id', ...columns.map(c => `m.${c}`),
        db.raw(`${isoS(KICKOFF_SQL)} AS kickoff_iso`),
        db.raw("DATE_FORMAT(m.start_time, '%Y-%m-%d %H:%i:%s') AS start_local")];
    const a = db('matches as m').leftJoin('fixtures as f', 'f.id', 'm.fixture_id')
        .whereBetween('m.start_time', [from, to]).select(cols);
    const b = db('matches as m').join('fixtures as f', 'f.id', 'm.fixture_id')
        .whereBetween('f.kickoff', [from, to]).select(cols);
    if (where) { where(a); where(b); }
    const byId = new Map();
    for (const r of [...await a, ...await b]) {
        const kickoffMs = parseEatMs(r.kickoff_iso);
        if (Number.isFinite(kickoffMs) && kickoffMs >= fromMs && kickoffMs <= toMs) byId.set(Number(r.id), { ...r, kickoffMs });
    }
    return [...byId.values()];
}

// Freeze every target that is due and not yet stored. `matchIds` = the
// matches a save just logged (post-save path); omitted = the bounded sweep
// over kickoffs in [now - 3d, now + 2d] (targets that passed with no later
// look - most closings). Written with INSERT IGNORE on (match_id, target): a
// row that already exists is left exactly as it was, never updated. Values
// are a cutoff into the append-only change log (as_of_change_id), so the
// replay of a frozen row can never change. Best-effort by contract: callers
// catch; a failure just means the next call or sweep freezes it, with the
// same deterministic result.
export async function materializeTargets({ matchIds = null, nowMs = null, cap = 500 } = {}) {
    const counts = { candidates: 0, matches: 0, frozen: 0 };
    if (!historyEnabled()) return counts;
    const now = nowMs ?? await dbNowMs();
    let kickoffs;
    if (Array.isArray(matchIds)) {
        if (!matchIds.length) return counts;
        kickoffs = await _kickoffsFor(matchIds);
    } else {
        const rows = await canonicalWindowMatches(now - 3 * 86_400_000, now + 2 * 86_400_000);
        kickoffs = new Map(rows.map(r => [Number(r.id), r.kickoffMs]));
    }
    const ids = [...kickoffs.keys()];
    counts.candidates = ids.length;
    if (!ids.length) return counts;

    const frozen = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await db('odds_target_snapshots').whereIn('match_id', ids.slice(i, i + ID_CHUNK)).select('match_id', 'target');
        for (const r of rows) {
            const id = Number(r.match_id);
            if (!frozen.has(id)) frozen.set(id, new Set());
            frozen.get(id).add(r.target);
        }
    }
    const needy = ids.filter(id => (frozen.get(id)?.size ?? 0) < TARGET_SET.size
        && targetsPossiblyDue({ nowMs: now, kickoffMs: kickoffs.get(id), frozen: frozen.get(id) ?? [] }));
    const observations = new Map();
    for (let i = 0; i < needy.length; i += ID_CHUNK) {
        const rows = await db('odds_observations').whereIn('match_id', needy.slice(i, i + ID_CHUNK))
            .orderBy(['match_id', 'observed_at'])
            .select('match_id', 'kind', db.raw(`${isoMs('observed_at')} AS observed_iso`));
        for (const r of rows) {
            const id = Number(r.match_id);
            if (!observations.has(id)) observations.set(id, []);
            observations.get(id).push({ ms: parseEatMs(r.observed_iso), kind: r.kind });
        }
    }

    const maxLagMs = Number(effective('ODDS_TARGET_MAX_LAG_MINUTES')) * 60_000;
    const work = [];
    for (const id of needy) {
        const plans = planTargetFreezes({
            nowMs: now, kickoffMs: kickoffs.get(id), observations: observations.get(id) ?? [],
            frozen: frozen.get(id) ?? [], maxLagMs,
        });
        if (plans.length) work.push({ id, kickoffMs: kickoffs.get(id), plans });
    }
    work.sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));
    for (const w of work.slice(0, Math.max(1, Number(cap) || 1))) {
        const cutoffs = w.plans.map(p => p.observed_at_ms).filter(ms => ms != null);
        let changeRows = [];
        if (cutoffs.length) {
            changeRows = (await db('odds_changes')
                .where('match_id', w.id)
                .where('observed_at', '<=', eatWallClock(Math.max(...cutoffs)))
                .orderBy('id')
                .select('id', 'type_name', 'name', 'handicap', 'odds', 'event', db.raw(`${isoMs('observed_at')} AS observed_iso`)))
                .map(r => ({ ...r, observed_ms: parseEatMs(r.observed_iso) }));
        }
        const kickoff_at = Number.isFinite(w.kickoffMs) ? eatWallClock(w.kickoffMs).slice(0, 19) : null;
        if (!kickoff_at) continue;
        const rows = w.plans.map(p => {
            const asOf = p.observed_at_ms == null ? null : asOfChangeId(changeRows, p.observed_at_ms);
            return {
                match_id: w.id,
                target: p.target,
                kickoff_at,
                target_at: eatWallClock(p.target_at_ms),
                observed_at: p.observed_at_ms == null ? null : eatWallClock(p.observed_at_ms),
                lag_seconds: p.lag_seconds,
                quality: p.quality,
                markets: asOf == null ? 0 : replayState(changeRows, asOf).length,
                as_of_change_id: asOf,
            };
        });
        // INSERT IGNORE: an existing (match_id, target) row is never touched.
        await db('odds_target_snapshots').insert(rows).onConflict(['match_id', 'target']).ignore();
        counts.matches += 1;
        counts.frozen += rows.length;
    }
    if (counts.frozen) debugLog(`[odds-history] froze ${counts.frozen} target(s) over ${counts.matches} match(es)`);
    return counts;
}

// GET /api/odds-history/:matchId payload, or null for an unknown match.
// `limit` caps the change TIMELINE in the response (newest rows kept, in
// chronological order); the target replays always use the full log.
export async function oddsHistoryPayload(matchId, { limit = 2000 } = {}) {
    const id = Number(matchId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const m = await db('matches as m').leftJoin('fixtures as f', 'f.id', 'm.fixture_id')
        .where('m.id', id)
        .first('m.id', 'm.provider', 'm.provider_match_id', 'm.home_team_name', 'm.away_team_name',
            'm.competition_name', 'm.fixture_id',
            db.raw(`${isoS('m.start_time')} AS start_iso`),
            db.raw(`${isoS(KICKOFF_SQL)} AS kickoff_iso`),
            db.raw(`${isoS('m.completed_at')} AS completed_iso`));
    if (!m) return null;
    const kickoffMs = parseEatMs(m.kickoff_iso);
    // Sequential on purpose: the live pool is 3 connections, and one read
    // request must not take all of them.
    const observations = await db('odds_observations').where('match_id', id).orderBy('observed_at')
        .select('kind', 'source', 'markets', 'changes', db.raw(`${isoMs('observed_at')} AS observed_iso`));
    const changes = await db('odds_changes').where('match_id', id).orderBy('id')
        .select('id', 'type_name', 'name', 'handicap', 'odds', 'prev_odds', 'event', db.raw(`${isoMs('observed_at')} AS observed_iso`));
    const targets = await db('odds_target_snapshots').where('match_id', id)
        .select('target', 'quality', 'lag_seconds', 'markets', 'as_of_change_id',
            db.raw(`${isoS('kickoff_at')} AS kickoff_iso`),
            db.raw(`${isoMs('target_at')} AS target_iso`),
            db.raw(`${isoMs('observed_at')} AS observed_iso`));
    const cap = Math.min(Math.max(Number(limit) || 2000, 1), 20000);
    const num = v => (v == null ? null : Number(v));
    const order = t => TARGETS.indexOf(t);
    return {
        match: {
            id: Number(m.id), provider: m.provider, provider_match_id: String(m.provider_match_id),
            home: m.home_team_name, away: m.away_team_name, competition: m.competition_name,
            fixture_id: m.fixture_id, start_time: eatIso(parseEatMs(m.start_iso)),
            kickoff: eatIso(kickoffMs), completed_at: m.completed_iso ? eatIso(parseEatMs(m.completed_iso)) : null,
        },
        observations: {
            count: observations.length,
            first: observations.length ? eatIso(parseEatMs(observations[0].observed_iso)) : null,
            last: observations.length ? eatIso(parseEatMs(observations.at(-1).observed_iso)) : null,
            list: observations.map(o => ({
                observed_at: eatIso(parseEatMs(o.observed_iso)), kind: o.kind, source: o.source,
                markets: Number(o.markets), changes: Number(o.changes),
            })),
        },
        changes: {
            count: changes.length,
            truncated: changes.length > cap,
            list: changes.slice(-cap).map(c => ({
                id: Number(c.id), observed_at: eatIso(parseEatMs(c.observed_iso)), event: c.event,
                type_name: c.type_name, name: c.name, handicap: num(c.handicap), odds: num(c.odds), prev_odds: num(c.prev_odds),
            })),
        },
        targets: targets.sort((a, b) => order(a.target) - order(b.target)).map(t => {
            const frozenKick = parseEatMs(t.kickoff_iso);
            return {
                target: t.target,
                target_at: eatIso(parseEatMs(t.target_iso)),
                observed_at: t.observed_iso ? eatIso(parseEatMs(t.observed_iso)) : null,
                lag_seconds: num(t.lag_seconds),
                quality: t.quality,
                kickoff_at: eatIso(frozenKick),
                kickoff_moved: kickoffMoved(frozenKick, kickoffMs),
                markets_count: Number(t.markets),
                markets: t.as_of_change_id == null ? [] : replayState(changes, t.as_of_change_id)
                    .map(({ type_name, name, handicap, odds }) => ({ type_name, name, handicap, odds })),
            };
        }),
    };
}
