// Pinnacle reference odds + the Sharp-anchored Pick shadow (2026-10-18).
// Thin knex shell around the pure src/apisports-odds.js (parse) and
// src/db/anchor-rules.js (devig, eligibility, card, due moments).
//
// Capture: the full sweep pages GET /odds?date=D&bookmaker=4 for today..+2,
// and the writer tick fetches one fixture at its T-3h and T-1h moments.
// API-Football purges odds about 7 days after a fixture, so the line exists
// for a forward test only if it is captured here, daily.
//
// Freeze discipline (the odds-history rule): reference_odds rows are written
// only for fixtures whose CANONICAL kickoff is still ahead, and never
// updated; an unchanged line is an INSERT IGNORE no-op on its upstream
// `update` stamp. anchored_picks rows are re-derived only while their fixture
// is upcoming; once it kicks off the row (and its card membership) stands,
// and only settleAnchoredPicks writes outcome/score/settled_at, exactly once.
// The shadow is never shown and never touches the live Pick or daily card.
import { db } from './db/connection.js';
import { effective } from './settings.js';
import { debugLog } from './utils.js';
import { withRetry } from './db/retry-rules.js';
import { fetchBookmakerOdds, FINAL_STATUSES, TERMINAL_STATUSES } from './apisports.js';
import { buildReferenceRows, PINNACLE_BOOKMAKER_ID } from './apisports-odds.js';
import { tipBookKey, tipOutcome } from './db/tip-rules.js';
import {
    DEFAULT_ANCHOR, ANCHOR_MARKETS, REFERENCE_MOMENTS_MIN,
    bestKenyanPrices, anchorLeg, selectAnchorCard, planReferenceDue,
} from './db/anchor-rules.js';
import { parseEatMs } from './db/odds-history-rules.js';
import { dbNowMs } from './odds-history.js';

const ID_CHUNK = 200;
const INSERT_CHUNK = 500;
const LEG_RETIRE_DAYS = 7;   // same as the daily slip: a fixture that never finalizes voids
const isoS = col => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s')`;
const _markets = new Set(ANCHOR_MARKETS);

export function referenceEnabled() {
    return Boolean(effective('REFERENCE_ODDS_ENABLED'));
}

// Persist parsed rows for fixtures we hold whose canonical kickoff is still
// ahead (checked immediately before the insert; nothing kicks off within the
// milliseconds between, and a due capture runs an hour or more early).
async function _saveReferenceRows(rows, source) {
    const ids = [...new Set(rows.map(r => r.fixture_id))];
    const open = new Set();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const got = await db('fixtures').whereIn('id', ids.slice(i, i + ID_CHUNK))
            .where('kickoff', '>', db.raw('NOW()')).select('id');
        for (const r of got) open.add(r.id);
    }
    const keep = rows.filter(r => open.has(r.fixture_id))
        .map(r => ({ ...r, source, captured_at: db.raw('NOW(3)') }));
    for (let i = 0; i < keep.length; i += INSERT_CHUNK) {
        const chunk = keep.slice(i, i + INSERT_CHUNK);
        await withRetry(() => db('reference_odds').insert(chunk)
            .onConflict(['fixture_id', 'bookmaker_id', 'market', 'source_updated_at']).ignore());
    }
    return { lines: keep.length, fixtures: new Set(keep.map(r => r.fixture_id)).size, skipped_closed: ids.length - open.size };
}

// One date's Pinnacle page set -> reference_odds. Returns counts.
export async function captureReferenceDate(date, { source = 'full' } = {}) {
    const items = await fetchBookmakerOdds({ date });
    const { rows, skipped } = buildReferenceRows(items);
    if (skipped.length) console.warn(`[reference] ${date}: ${skipped.length} odds item(s) skipped (unparseable)`);
    const saved = await _saveReferenceRows(rows, source);
    return { date, items: items.length, skipped: skipped.length, ...saved };
}

// Specific fixtures (the due moments, or the CLI). Returns counts.
export async function captureReferenceFixtures(ids, { source = 'due', shouldStop = () => false } = {}) {
    const rows = [];
    let fetched = 0, skipped = 0;
    for (const id of ids) {
        if (shouldStop()) break;
        const parsed = buildReferenceRows(await fetchBookmakerOdds({ fixture: id }));
        fetched++;
        skipped += parsed.skipped.length;
        rows.push(...parsed.rows);
    }
    const saved = await _saveReferenceRows(rows, source);
    return { fetched, skipped, ...saved };
}

// --- the due moments (T-3h, T-1h) ---

const PLAN_EVERY_MS = 60_000;
const _attempted = new Map();   // fixture id -> attempt ms (a fixture with no line is not refetched every tick)
let _lastPlanMs = 0;

// Upcoming correlated fixtures inside the T-3h horizon with their newest
// capture; plan the moments; fetch each due fixture once; rebuild the shadow
// for the touched days. Writer tick only (src/auto-refresh.js). Returns a
// summary, or null when nothing was due.
export async function runReferenceDue({ shouldStop = () => false } = {}) {
    if (!referenceEnabled()) return null;
    const wall = Date.now();
    if (wall - _lastPlanMs < PLAN_EVERY_MS) return null;
    _lastPlanMs = wall;
    const leadMin = Number(effective('ODDS_DUE_LEAD_MINUTES'));
    const horizonMin = REFERENCE_MOMENTS_MIN.t3h + leadMin + 1;
    const rows = await db('fixtures as f')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .where('f.kickoff', '<=', db.raw('NOW() + INTERVAL ? MINUTE', [horizonMin]))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', db.raw(`${isoS('f.kickoff')} AS kickoff_iso`),
            db.raw(`(SELECT ${isoS('MAX(r.captured_at)')} FROM reference_odds r WHERE r.fixture_id = f.id) AS last_iso`));
    if (!rows.length) return null;
    const nowMs = await dbNowMs();
    for (const [id, ms] of _attempted) if (nowMs - ms > 4 * 3_600_000) _attempted.delete(id);
    const fixtures = rows.map(r => {
        const dbLast = parseEatMs(r.last_iso);
        const tried = _attempted.get(r.id);
        const last = Math.max(Number.isFinite(dbLast) ? dbLast : -Infinity, tried ?? -Infinity);
        return { id: r.id, kickoffMs: parseEatMs(r.kickoff_iso), lastMs: Number.isFinite(last) ? last : null };
    });
    const plan = planReferenceDue(nowMs, fixtures, { leadMin, cap: Number(effective('ODDS_DUE_MAX_PER_TICK')) });
    if (!plan.due.length) return null;
    const ids = plan.due.map(d => d.id);
    for (const id of ids) _attempted.set(id, nowMs);
    const res = await captureReferenceFixtures(ids, { source: 'due', shouldStop });
    const kickById = new Map(rows.map(r => [r.id, r.kickoff_iso]));
    const days = [...new Set(ids.map(id => String(kickById.get(id) ?? '').slice(0, 10)).filter(Boolean))];
    for (const d of days) await buildAnchoredPicks(d);
    const summary = { due: plan.total, ...res, days };
    debugLog(`[reference due] ${JSON.stringify(summary)}`);
    return summary;
}

// --- the shadow card ---

// Each team's finished games inside the evidence window ending now.
async function _teamGameCounts(teamIds, days) {
    const out = new Map();
    const fin = FINAL_STATUSES.map(() => '?').join(',');
    for (let i = 0; i < teamIds.length; i += ID_CHUNK) {
        const ids = teamIds.slice(i, i + ID_CHUNK);
        const ph = ids.map(() => '?').join(',');
        const [rows] = await db.raw(
            `SELECT t.team_id, COUNT(*) AS n FROM (
                SELECT home_team_id AS team_id FROM fixtures
                 WHERE home_team_id IN (${ph}) AND status IN (${fin})
                   AND kickoff < NOW() AND kickoff >= NOW() - INTERVAL ? DAY
                UNION ALL
                SELECT away_team_id AS team_id FROM fixtures
                 WHERE away_team_id IN (${ph}) AND status IN (${fin})
                   AND kickoff < NOW() AND kickoff >= NOW() - INTERVAL ? DAY
             ) t GROUP BY t.team_id`,
            [...ids, ...FINAL_STATUSES, days, ...ids, ...FINAL_STATUSES, days]);
        for (const r of rows) out.set(r.team_id, Number(r.n));
    }
    return out;
}

// Latest Pinnacle line per fixture: the rows of its newest upstream stamp.
async function _latestReference(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await db('reference_odds')
            .whereIn('fixture_id', ids.slice(i, i + ID_CHUNK))
            .where('bookmaker_id', PINNACLE_BOOKMAKER_ID)
            .select('fixture_id', 'market', 'price', db.raw(`${isoS('source_updated_at')} AS upd`));
        const newest = new Map();
        for (const r of rows) if (!newest.has(r.fixture_id) || r.upd > newest.get(r.fixture_id)) newest.set(r.fixture_id, r.upd);
        for (const r of rows) {
            if (r.upd !== newest.get(r.fixture_id)) continue;
            let e = out.get(r.fixture_id);
            if (!e) out.set(r.fixture_id, e = { upd: r.upd, prices: {} });
            e.prices[r.market] = Number(r.price);
        }
    }
    return out;
}

// Current Kenyan prices per fixture in canonical orientation: a match whose
// sides API-Football reversed after linking (matches.sides_swapped) lists the
// canonical away team as its '1', so 1 and 2 swap; totals are symmetric.
async function _kenyanRows(ids) {
    const out = new Map();
    const swap = { 1: '2', 2: '1' };
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await db('odds_markets as om')
            .join('matches as m', 'm.id', 'om.match_id')
            .whereIn('m.fixture_id', ids.slice(i, i + ID_CHUNK))
            .whereNull('m.completed_at')
            .where('om.is_stale', 0)
            .select('m.fixture_id', 'm.provider', 'm.sides_swapped', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
        for (const r of rows) {
            let key = null;
            try { key = tipBookKey(r); } catch { continue; }
            if (!_markets.has(key)) continue;
            if (r.sides_swapped && swap[key]) key = swap[key];
            let list = out.get(r.fixture_id);
            if (!list) out.set(r.fixture_id, list = []);
            list.push({ provider: r.provider, market: key, price: r.price });
        }
    }
    return out;
}

// Build (or refresh) the shadow rows for one EAT date. Returns counts.
export async function buildAnchoredPicks(date, { opts = DEFAULT_ANCHOR } = {}) {
    const o = { ...DEFAULT_ANCHOR, ...opts };
    const fixtures = await db('fixtures as f')
        .whereRaw('DATE(f.kickoff) = ?', [date])
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.home_team_id', 'f.away_team_id', db.raw('f.kickoff > NOW() AS upcoming'));
    const upcoming = fixtures.filter(f => Number(f.upcoming) === 1);
    const upIds = upcoming.map(f => f.id);

    const ref = upIds.length ? await _latestReference(upIds) : new Map();
    const withRef = upcoming.filter(f => ref.has(f.id));
    const kenyan = withRef.length ? await _kenyanRows(withRef.map(f => f.id)) : new Map();
    const games = withRef.length
        ? await _teamGameCounts([...new Set(withRef.flatMap(f => [f.home_team_id, f.away_team_id]))], o.evidenceDays)
        : new Map();

    const legs = new Map();
    for (const f of withRef) {
        const leg = anchorLeg({
            kenyan: bestKenyanPrices(kenyan.get(f.id)),
            reference: ref.get(f.id).prices,
            homeGames: games.get(f.home_team_id) ?? 0,
            awayGames: games.get(f.away_team_id) ?? 0,
        }, o);
        if (leg) legs.set(f.id, { ...leg, refUpd: ref.get(f.id).upd });
    }

    // Card: committed (kicked-off) rows of this day as stored, plus today's
    // upcoming eligible legs.
    const frozen = await db('anchored_picks as a').join('fixtures as f', 'f.id', 'a.fixture_id')
        .where('a.pick_date', date).where('f.kickoff', '<=', db.raw('NOW()'))
        .select('a.fixture_id', 'a.ratio', 'a.fair_prob', 'a.strong', 'a.on_card');
    const card = selectAnchorCard([
        ...frozen.map(r => ({ fixtureId: r.fixture_id, ratio: Number(r.ratio), fair: Number(r.fair_prob), strong: !!r.strong, frozen: true, onCard: !!r.on_card })),
        ...[...legs].map(([id, l]) => ({ fixtureId: id, ratio: l.ratio, fair: l.fair, strong: l.strong, frozen: false, onCard: false })),
    ], o);

    const rows = [...legs].map(([id, l]) => ({
        pick_date: date, fixture_id: id, market: l.market, price: l.price, provider: l.provider,
        ref_price: l.refPrice, fair_prob: l.fair, ratio: l.ratio, strong: l.strong,
        on_card: card.has(id), ref_updated_at: l.refUpd.replace('T', ' '), computed_at: db.fn.now(),
    }));
    await withRetry(() => db.transaction(async trx => {
        // Upcoming rows of this day that are no longer eligible, or whose
        // fixture moved to another day, are not yet committed: remove them.
        // (Selected, then deleted by id: knex's aliased DELETE ... JOIN is
        // invalid SQL on MariaDB.)
        const open = await trx('anchored_picks as a').join('fixtures as f', 'f.id', 'a.fixture_id')
            .where('f.kickoff', '>', db.raw('NOW()')).whereNull('a.settled_at')
            .where(q => q.where('a.pick_date', date).orWhereRaw('DATE(f.kickoff) = ?', [date]))
            .select('a.id', 'a.fixture_id', db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') AS day"));
        const drop = open.filter(r => r.day !== date || !legs.has(r.fixture_id)).map(r => r.id);
        for (let i = 0; i < drop.length; i += ID_CHUNK) {
            await trx('anchored_picks').whereIn('id', drop.slice(i, i + ID_CHUNK)).del();
        }
        if (rows.length) {
            await trx('anchored_picks').insert(rows).onConflict('fixture_id').merge([
                'pick_date', 'market', 'price', 'provider', 'ref_price', 'fair_prob', 'ratio',
                'strong', 'on_card', 'ref_updated_at', 'computed_at',
            ]);
        }
    }));
    return {
        date, fixtures: fixtures.length, upcoming: upcoming.length, with_line: withRef.length,
        eligible: legs.size, strong: [...legs.values()].filter(l => l.strong).length, card: card.size,
    };
}

// Grade pending shadow rows from canonical finals (exactly once per row).
// A fixture ending terminal without play, or never finalizing within
// LEG_RETIRE_DAYS of kickoff, voids. Cheap, light-pass safe.
export async function settleAnchoredPicks() {
    const pending = await db('anchored_picks as a').join('fixtures as f', 'f.id', 'a.fixture_id')
        .whereNull('a.outcome').where('f.kickoff', '<=', db.raw('NOW()'))
        .select('a.id', 'a.market', 'f.status', 'f.ft_home', 'f.ft_away',
            db.raw('f.kickoff < NOW() - INTERVAL ? DAY AS retired', [LEG_RETIRE_DAYS]));
    let settled = 0;
    for (const r of pending) {
        let patch = null;
        if (FINAL_STATUSES.includes(r.status) && r.ft_home != null && r.ft_away != null) {
            patch = { outcome: tipOutcome(r.market, r.ft_home, r.ft_away), score: `${r.ft_home}-${r.ft_away}` };
        } else if (TERMINAL_STATUSES.includes(r.status) || Number(r.retired) === 1) {
            patch = { outcome: 'void' };
        }
        if (!patch) continue;
        await db('anchored_picks').where('id', r.id).whereNull('outcome').update({ ...patch, settled_at: db.fn.now() });
        settled++;
    }
    return { settled, pending: pending.length };
}
