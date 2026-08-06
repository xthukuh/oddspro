// Daily MultiBet orchestrator (engine-v2 final touches, spec 2026-08-06-0100):
// thin knex shell around the pure daily-slip-rules + leg-calibration modules,
// the hotpicks.js loader idiom. One slip row per EAT day in `daily_slips`.
//
// Ownership split (the settle-columns idiom): buildDailySlip owns
// status/mood/legs/combined_odds/legs_total/algo_version/computed_at while
// the day is still fully pre-kickoff; settleDailySlips alone owns
// legs_hit/outcome/settled_at (plus leg-level outcomes inside the JSON).
// Freeze discipline: once ANY leg of the stored slip has kicked off the
// builder never rewrites the row - the published card stands, honest by
// construction, exactly like fixture_prematch/fixture_predictions.
import { db } from './db/connection.js';
import { FINAL_STATUSES } from './apisports.js';
import { buildTipBooks, tipOutcome } from './db/tip-rules.js';
import { marketMenu } from './db/ladder-rules.js';
import { makeCalibrator } from './db/leg-calibration.js';
import {
    DEFAULT_DAILY_SLIP, DEFAULT_GROUPING, DEFAULT_VALUE_CARDS,
    selectDailyLegs, groupCards, valueCards, dayMood,
    slipOutcomeRollup, slipStreaks,
} from './db/daily-slip-rules.js';
import { tipMarketLabel } from './db/magic-rules.js';
import { canonicalMarket } from './markets.js';
import { effective } from './settings.js';
import { debugLog } from './utils.js';

export const ALGO_VERSION = 'v1.3-cards-2026-08-06';   // multi-card grouping champion (see daily-slip-rules.js)

const CALIBRATION_WINDOW_DAYS = 90;
// Recency decay (grid round 4, owner's error-feedback directive): identical
// green rate to the flat calibrator at n=35 days (26/30, streak 8, P&L +0.01u)
// - adopted for the HEALING property (recent misses outweigh stale history as
// the ledger grows), re-measure monthly. The league-stereotype layer was
// REFUTED in the same round (75.8% vs 86.7%: thin per-league samples admit
// legs the global evidence would not) and stays off.
const CALIBRATION_HALF_LIFE_DAYS = 30;

function _bookCfg() {
    return {
        minOverround: effective('TIP_MIN_OVERROUND'),
        maxOverround: effective('TIP_MAX_OVERROUND'),
        maxBookDivergence: effective('TIP_MAX_BOOK_DIVERGENCE'),
    };
}

// Group odds rows per fixture and flatten each fixture's family books into
// menu legs [{ market, price, prob }]. Shared by the builder (upcoming, non-
// stale rows) and the calibration feed (settled, stale INCLUDED - a stale
// price is the last-seen pre-completion price, i.e. the historical price).
function _menusByFixture(rows, namesById) {
    const byFixture = new Map();
    for (const r of rows) {
        let list = byFixture.get(r.fixture_id);
        if (!list) byFixture.set(r.fixture_id, list = []);
        list.push(r);
    }
    const cfg = _bookCfg();
    const menus = new Map();
    for (const [fixtureId, fixtureRows] of byFixture) {
        const books = buildTipBooks(fixtureRows, namesById?.get(fixtureId) ?? {}, cfg);
        const menu = marketMenu(books);
        menus.set(fixtureId, Object.entries(menu)
            .map(([market, l]) => ({ market, price: l.price, prob: l.prob }))
            .filter(l => Number(l.price) > 1 && l.prob != null));
    }
    return { menus, byFixture };
}

// Calibration feed: every settled menu leg of the final fixtures inside the
// window strictly before `beforeDate` (EAT date string). All-prior-days
// evidence; the walk-forward property of the backfill lives in the script,
// which advances this cutoff day by day.
export async function loadCalibrator(beforeDate, windowDays = CALIBRATION_WINDOW_DAYS) {
    const fixtures = await db('fixtures as f')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereIn('f.status', FINAL_STATUSES)
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .whereRaw('DATE(f.kickoff) < ?', [beforeDate])
        .whereRaw('DATE(f.kickoff) >= DATE_SUB(?, INTERVAL ? DAY)', [beforeDate, windowDays])
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.ft_home', 'f.ft_away',
            db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') as day"),
            'l.name as league',
            'th.name as home_name', 'ta.name as away_name');
    if (!fixtures.length) return makeCalibrator({ halfLifeDays: CALIBRATION_HALF_LIFE_DAYS });
    const namesById = new Map(fixtures.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]));
    const rows = await db('odds_markets as om')
        .join('matches as m', 'm.id', 'om.match_id')
        .whereIn('m.fixture_id', fixtures.map(f => f.id))
        .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
    const { menus } = _menusByFixture(rows, namesById);
    const cal = makeCalibrator({ halfLifeDays: CALIBRATION_HALF_LIFE_DAYS });
    for (const f of fixtures) {
        for (const leg of menus.get(f.id) ?? []) {
            let outcome = null;
            try { outcome = tipOutcome(leg.market, f.ft_home, f.ft_away); } catch { continue; }
            // day/league ride each observation for the decay (and any future
            // re-test of the refuted league layer - inert while leagueK is 0).
            cal.observe({ ...leg, outcome, day: f.day, league: f.league });
        }
    }
    return cal;
}

// Per-provider prices for one canonical market key, from the fixture's raw
// odds rows (display data for the one-per-provider toggle; the chosen price
// stays the family-book one the selection was made on).
function _providerPrices(fixtureRows, marketKey) {
    const prices = {};
    for (const r of fixtureRows ?? []) {
        let key = null;
        try { key = canonicalMarket(r).key; } catch { continue; }
        if (key !== marketKey) continue;
        const p = Number(r.price);
        if (!(p > 1)) continue;
        if (prices[r.provider] == null || p < prices[r.provider]) prices[r.provider] = p;
    }
    return prices;
}

const _pct = p => `${(100 * p).toFixed(1)}%`;

function _reasoning(leg) {
    const ev = leg.cell
        ? `calibrated ${_pct(leg.calProb)} from ${leg.cell.n} settled legs in its price/market cell (${leg.cell.hit} hit)`
        : `no settled evidence in its price/market cell yet, so the book's own ${_pct(leg.calProb)} stands`;
    return `Safest qualifying pick of this fixture: ${tipMarketLabel(leg.market)} at ${leg.price.toFixed(2)}, `
        + `${ev}; bookmaker devig says ${_pct(leg.prob)}.`;
}

// Build (or refresh) the slip for `date` (EAT date string, default today).
// Returns { date, frozen } | { date, slip } | { date, noSlip }.
export async function buildDailySlip(date = null, { opts = null, algoVersion = ALGO_VERSION } = {}) {
    // DATE_FORMAT keeps the day a STRING inside the pinned +03:00 session
    // (the magic.js idiom) - a bare CURDATE() decodes to a JS Date that
    // toISOString() shifts back 3 hours, off-by-one-day before 03:00 EAT.
    const [{ today, now }] = (await db.raw(
        "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today, NOW() as now"))[0];
    const slipDate = date ?? today;

    // Freeze check: never rewrite a row whose day has started (any stored leg
    // kicked off) or that is already settled.
    const existing = await db('daily_slips').where('slip_date', slipDate).first();
    if (existing) {
        const legs = typeof existing.legs === 'string' ? JSON.parse(existing.legs) : existing.legs;
        const started = (legs ?? []).some(l => l.kickoff && new Date(l.kickoff) <= new Date(now));
        if (existing.settled_at || existing.outcome || started) {
            debugLog(`daily-slip ${slipDate}: frozen (started/settled), not rebuilt`);
            return { date: slipDate, frozen: true };
        }
    }

    const targets = await db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .whereRaw('DATE(f.kickoff) = ?', [slipDate])
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.kickoff', 'l.name as league',
            'th.name as home_name', 'ta.name as away_name');

    const o = { ...DEFAULT_DAILY_SLIP, ...(opts ?? {}) };
    let slip = null;
    let byFixture = new Map();
    let fxById = new Map();
    const linksByFixture = new Map();
    if (targets.length) {
        fxById = new Map(targets.map(f => [f.id, f]));
        const namesById = new Map(targets.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]));
        const oddsRows = await db('odds_markets as om')
            .join('matches as m', 'm.id', 'om.match_id')
            .whereIn('m.fixture_id', targets.map(f => f.id))
            .where('om.is_stale', 0)
            .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
        const grouped = _menusByFixture(oddsRows, namesById);
        byFixture = grouped.byFixture;
        // Per-provider match links for legs whose markets are still live
        // (completed matches excluded at capture; the client additionally
        // hides links once a leg settles).
        const linkRows = await db('matches')
            .whereIn('fixture_id', targets.map(f => f.id))
            .whereNull('completed_at')
            .select('fixture_id', 'provider', 'match_url');
        for (const r of linkRows) {
            if (!r.match_url) continue;
            let m = linksByFixture.get(r.fixture_id);
            if (!m) linksByFixture.set(r.fixture_id, m = {});
            m[r.provider] = r.match_url;
        }
        const cal = await loadCalibrator(slipDate);
        const fixtures = targets.map(f => ({ id: f.id, league: f.league, menuLegs: grouped.menus.get(f.id) ?? [] }));
        // v1.3: the day's top legs deal into MULTIPLE small cards (legs carry
        // `card: i`); one bad leg kills one card, not the day (35/35 any-green
        // in the replay). Mood still reads the whole qualifying pool.
        const pool = selectDailyLegs(fixtures, cal, o);
        const cards = groupCards(pool, DEFAULT_GROUPING);
        // Value arm (owner ship order 2026-08-06): eff-ranked pool, cards
        // close at the 1.5x target, indices continue after the safe cards.
        // A day can ship value cards even when the safe pool is thin.
        const vPool = selectDailyLegs(fixtures, cal, DEFAULT_VALUE_CARDS);
        const vCards = valueCards(vPool, DEFAULT_VALUE_CARDS, cards.length);
        const safeTaken = cards.flat().map(l => ({ ...l, kind: 'safe' }));
        const taken = [...safeTaken, ...vCards.flat()];
        slip = taken.length >= o.minLegs ? {
            legs: taken, pool: pool.length, cards: cards.length + vCards.length,
            // Headline combined odds stay the SAFE arm's product; value cards
            // carry their own products in the legs/cards view.
            combinedOdds: safeTaken.length ? safeTaken.reduce((p, l) => p * l.price, 1) : 1,
            mood: dayMood(pool, o),
        } : null;
    }

    const row = slip ? {
        slip_date: slipDate,
        status: 'published',
        mood: slip.mood,
        legs: JSON.stringify(slip.legs.map(l => {
            const f = fxById.get(l.id);
            return {
                fixture_id: l.id,
                home: f.home_name, away: f.away_name, league: l.league,
                kickoff: f.kickoff instanceof Date ? f.kickoff.toISOString() : f.kickoff,
                market: l.market, label: tipMarketLabel(l.market),
                price: l.price, prices: _providerPrices(byFixture.get(l.id), l.market),
                links: linksByFixture.get(l.id) ?? {},
                prob: l.prob, cal_prob: l.calProb, cell: l.cell, cell_key: l.cellKey,
                card: l.card ?? 0,
                kind: l.kind ?? 'safe',
                reasoning: _reasoning(l),
                outcome: null,
            };
        })),
        combined_odds: Math.round(slip.combinedOdds * 100) / 100,
        legs_total: slip.legs.length,
        cards_total: slip.cards,
        algo_version: algoVersion,
        backfilled: false,
        computed_at: db.fn.now(),
    } : {
        slip_date: slipDate,
        status: 'no_slip',
        mood: 'red',
        legs: '[]',
        combined_odds: null,
        legs_total: 0,
        cards_total: 0,
        algo_version: algoVersion,
        backfilled: false,
        computed_at: db.fn.now(),
    };

    // Explicit merge list (knex-on-MySQL onConflict trap): settle columns and
    // backfilled are deliberately absent.
    await db('daily_slips').insert(row).onConflict('slip_date')
        .merge(['status', 'mood', 'legs', 'combined_odds', 'legs_total', 'cards_total', 'algo_version', 'computed_at']);

    if (!slip) return { date: slipDate, noSlip: true, fixtures: targets.length };
    return {
        date: slipDate,
        slip: { mood: slip.mood, legs: slip.legs.length, combined_odds: row.combined_odds },
    };
}

// Settle pending slips from canonical final scores. Cheap (SQL + pure
// tipOutcome/rollup, no fetches), light-pass safe. Leg outcomes persist into
// the JSON; outcome/legs_hit/settled_at written exactly once per slip.
export async function settleDailySlips() {
    const pending = await db('daily_slips')
        .whereNull('outcome').where('status', 'published')
        .select('id', 'legs');
    if (!pending.length) return { settled: 0, pending: 0 };

    const legIds = new Set();
    const parsed = pending.map(r => ({
        id: r.id,
        legs: typeof r.legs === 'string' ? JSON.parse(r.legs) : (r.legs ?? []),
    }));
    for (const r of parsed) for (const l of r.legs) legIds.add(l.fixture_id);
    if (!legIds.size) return { settled: 0, pending: pending.length };

    const finals = await db('fixtures')
        .whereIn('id', [...legIds])
        .whereIn('status', FINAL_STATUSES)
        .whereNotNull('ft_home').whereNotNull('ft_away')
        .select('id', 'ft_home', 'ft_away');
    const byId = new Map(finals.map(f => [f.id, f]));

    let settled = 0;
    for (const r of parsed) {
        let changed = false;
        for (const l of r.legs) {
            if (l.outcome != null) continue;
            const f = byId.get(l.fixture_id);
            if (!f) continue;
            try { l.outcome = tipOutcome(l.market, f.ft_home, f.ft_away); changed = true; }
            catch (e) { debugLog(`daily-slip settle: unknown market key ${l.market} (${e.message})`); }
        }
        // Day `outcome` = the SAFE recommendation's strict result (the green-
        // streak metric keeps its meaning); value cards ride cards_won only.
        // Legacy/backfilled legs carry no kind and all count (unchanged).
        const safeLegs = r.legs.filter(l => l.kind !== 'value');
        const roll = slipOutcomeRollup((safeLegs.length ? safeLegs : r.legs).map(l => l.outcome ?? null));
        if (!changed && roll.outcome == null) continue;
        const patch = {
            legs: JSON.stringify(r.legs),
            legs_hit: r.legs.filter(l => l.outcome === 'hit').length,
        };
        // Per-card rollups (v1.3): cards_won counts cards whose every leg
        // settled green; `outcome` keeps the STRICT all-cards meaning.
        const byCard = new Map();
        for (const l of r.legs) {
            const k = l.card ?? 0;
            let list = byCard.get(k); if (!list) byCard.set(k, list = []);
            list.push(l.outcome ?? null);
        }
        patch.cards_won = [...byCard.values()]
            .filter(list => slipOutcomeRollup(list).outcome === 'won').length;
        if (roll.outcome != null) { patch.outcome = roll.outcome; patch.settled_at = db.fn.now(); settled++; }
        await db('daily_slips').where('id', r.id).update(patch);
    }
    return { settled, pending: pending.length };
}

const _rowOut = r => ({
    date: r.day,
    status: r.status,
    mood: r.mood,
    legs: typeof r.legs === 'string' ? JSON.parse(r.legs) : r.legs,
    combined_odds: r.combined_odds == null ? null : Number(r.combined_odds),
    legs_total: r.legs_total,
    legs_hit: r.legs_hit,
    cards_total: r.cards_total ?? 0,
    cards_won: r.cards_won,
    outcome: r.outcome,
    algo_version: r.algo_version,
    backfilled: !!r.backfilled,
    computed_at: r.computed_at,
    settled_at: r.settled_at,
});

const SLIP_COLS = ['status', 'mood', 'legs', 'combined_odds', 'legs_total',
    'legs_hit', 'cards_total', 'cards_won', 'outcome', 'algo_version', 'backfilled',
    'computed_at', 'settled_at'];
const _dayCol = db.raw("DATE_FORMAT(slip_date, '%Y-%m-%d') as day");

export async function dailySlipPayload(date) {
    const row = await db('daily_slips').where('slip_date', date)
        .select(_dayCol, ...SLIP_COLS).first();
    return row ? _rowOut(row) : null;
}

// Timeline: latest `days` entries (date desc) + streak stats over the WHOLE
// history (streaks need every settled day, and the table is one row per day).
export async function dailyTimelinePayload(days = 30) {
    const all = await db('daily_slips').orderBy('slip_date', 'asc')
        .select(_dayCol, ...SLIP_COLS);
    const streaks = slipStreaks(all.map(r => ({ status: r.status, outcome: r.outcome })));
    return { streaks, days: all.slice(-Math.max(1, days)).reverse().map(_rowOut) };
}
