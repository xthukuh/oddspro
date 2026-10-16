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
import { marketMenu, contradicts } from './db/ladder-rules.js';
import { makeCalibrator, cellKey } from './db/leg-calibration.js';
import {
    DEFAULT_GEN2, slipOutcomeRollup, slipStreaks,
} from './db/daily-slip-rules.js';
import {
    makeHuntState, observeHuntLeg,
} from './db/value-hunt.js';
import { tipMarketLabel, pickView } from './db/magic-rules.js';
import { DEFAULT_PICK, DEFAULT_SLIP, isPick, selectTopPicks, selectSlip, picksDayScore } from './db/pick-rules.js';
import { canonicalMarket } from './markets.js';
import { effective } from './settings.js';
import { debugLog } from './utils.js';
import { coverageFor } from './notices.js';
import { makeSharpCalibrator, sharpLegsFromRows } from './db/sharp-rules.js';

export const ALGO_VERSION = 'v3.0-picks-2026-10-16';   // Top-3 picks: singles at 1.50-2.20 ranked by our calibrated chance

const CALIBRATION_WINDOW_DAYS = 90;
const SETTLED_WINDOW_CHUNK = 200;   // fixtures per odds_markets fetch - _settledWindow AND buildDailySlip's target load
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

// Shared settled-window loader: final fixtures + their settled menus inside
// the window strictly before `beforeDate`. Feeds BOTH the leg calibrator and
// the value-hunt cell state (one query pass, two consumers).
export async function loadSettledWindow(beforeDate, windowDays) { return _settledWindow(beforeDate, windowDays); }

async function _settledWindow(beforeDate, windowDays) {
    const fixtures = await db('fixtures as f')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereIn('f.status', FINAL_STATUSES)
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .whereRaw('DATE(f.kickoff) < ?', [beforeDate])
        .whereRaw('DATE(f.kickoff) >= DATE_SUB(?, INTERVAL ? DAY)', [beforeDate, windowDays])
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.ft_home', 'f.ft_away', 'f.kickoff',
            db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') as day"),
            'l.name as league',
            'th.name as home_name', 'ta.name as away_name');
    if (!fixtures.length) return { fixtures, menus: new Map(), sharp: new Map(), preMenus: new Map() };
    const namesById = new Map(fixtures.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]));
    // Chunked on purpose (2026-08-23). A 90-day window is ~10k settled
    // fixtures and ~7M odds_markets rows; one IN (...) statement over all of
    // them is killed by the shared live host ("lost connection during query",
    // the exact error that failed the 2026-08-19 full sweep's daily-slip step)
    // and, where it does run, holds the whole result in memory at once (1.5 GB
    // RSS measured live). Per-chunk menus are folded as each chunk arrives, so
    // the output is identical and the peak is one chunk's rows.
    const menus = new Map();
    const sharp = new Map();   // fixture id -> BetPawa sharp legs (pre-kickoff prices only)
    const preMenus = new Map();   // fixture id -> menu from pre-kickoff prices only (the Pick calibrator feed)
    const kickoffById = new Map(fixtures.map(f => [f.id, new Date(f.kickoff).getTime()]));
    const ids = fixtures.map(f => f.id);
    for (let i = 0; i < ids.length; i += SETTLED_WINDOW_CHUNK) {
        const rows = await db('odds_markets as om')
            .join('matches as m', 'm.id', 'om.match_id')
            .whereIn('m.fixture_id', ids.slice(i, i + SETTLED_WINDOW_CHUNK))
            .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price',
                'om.probability', 'om.updated_at');
        const grouped = _menusByFixture(rows, namesById);
        for (const [id, menu] of grouped.menus) menus.set(id, menu);
        // Sharp legs and the Pick calibrator keep only prices last written
        // BEFORE kickoff: a row touched in-play carries an in-play price,
        // which would teach a calibrator with hindsight (2.2% of rows,
        // measured 2026-10-15).
        const preRows = [];
        for (const [id, fRows] of grouped.byFixture) {
            const ko = kickoffById.get(id);
            const pre = fRows.filter(r => new Date(r.updated_at).getTime() < ko);
            const names = namesById.get(id) ?? {};
            sharp.set(id, sharpLegsFromRows(pre, names.homeName, names.awayName));
            for (const r of pre) preRows.push(r);
        }
        for (const [id, menu] of _menusByFixture(preRows, namesById).menus) preMenus.set(id, menu);
    }
    return { fixtures, menus, sharp, preMenus };
}

// Calibration feed: every settled menu leg of the final fixtures inside the
// window strictly before `beforeDate` (EAT date string). All-prior-days
// evidence; the walk-forward property of the backfill lives in the script,
// which advances this cutoff day by day.
export async function loadCalibrator(beforeDate, windowDays = CALIBRATION_WINDOW_DAYS, window = null) {
    const { fixtures, menus } = window ?? await _settledWindow(beforeDate, windowDays);
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
    // Error backprop (gen-2, errorBoost): a PUBLISHED leg that missed
    // re-observes extra times, so the engine's own selection mistakes
    // depress their cells harder than mere menu observation - the next
    // day's generation avoids them sooner. Walk-forward safe: only slips
    // strictly before `beforeDate` feed.
    const boost = DEFAULT_GEN2.errorBoost ?? 0;
    if (boost > 0) {
        const slips = await db('daily_slips')
            .where('status', 'published')
            .whereRaw('slip_date < ?', [beforeDate])
            .whereRaw('slip_date >= DATE_SUB(?, INTERVAL ? DAY)', [beforeDate, windowDays])
            .select('legs', db.raw("DATE_FORMAT(slip_date, '%Y-%m-%d') as day"));
        for (const s of slips) {
            const legs = typeof s.legs === 'string' ? JSON.parse(s.legs) : (s.legs ?? []);
            for (const l of legs) {
                if (l.outcome !== 'miss') continue;
                for (let i = 0; i < boost; i++) {
                    cal.observe({ market: l.market, price: l.price, prob: l.prob, outcome: 'miss', day: s.day, league: l.league });
                }
            }
        }
    }
    return cal;
}

// Value-hunt cell state from the same settled window: legs feed in day-ASC
// order (walk-forward decay + streak tails). `window` lets the builder share
// one _settledWindow fetch between this and loadCalibrator.
export async function loadHuntState(beforeDate, windowDays = CALIBRATION_WINDOW_DAYS, window = null) {
    const { fixtures, menus } = window ?? await _settledWindow(beforeDate, windowDays);
    const state = makeHuntState();
    const byDayAsc = [...fixtures].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
    for (const f of byDayAsc) {
        const legs = menus.get(f.id) ?? [];
        const fx = { impliedOver: legs.find(l => l.market === 'O 2.5')?.prob ?? null };
        for (const leg of legs) {
            let outcome = null;
            try { outcome = tipOutcome(leg.market, f.ft_home, f.ft_away); } catch { continue; }
            observeHuntLeg(state, { ...leg, outcome }, fx, f.day);
        }
    }
    return state;
}

// Sharp 4x calibrator from the same settled window: every pre-kickoff BetPawa
// leg (market, price, BetPawa's own q) of every final fixture strictly before
// `beforeDate` teaches its group|band residual (src/db/sharp-rules.js).
export async function loadSharpCalibrator(beforeDate, windowDays = CALIBRATION_WINDOW_DAYS, window = null) {
    const { fixtures, sharp } = window ?? await _settledWindow(beforeDate, windowDays);
    const cal = makeSharpCalibrator();
    for (const f of fixtures) {
        for (const leg of sharp?.get(f.id) ?? []) {
            let outcome = null;
            try { outcome = tipOutcome(leg.market, f.ft_home, f.ft_away); } catch { continue; }
            cal.observe({ ...leg, outcome });
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

// pick: { market, price, prob (devig), calProb (ours) }.
function _pickReasoning(pick, rank, of) {
    return `Pick ${rank} of today's ${of}, ranked by our own win chance: ${tipMarketLabel(pick.market)} at ${pick.price.toFixed(2)}. `
        + `Our calibrated chance is ${_pct(pick.calProb)}, learned walk-forward from our settled results in its market and price group. `
        + 'A single stake: one miss never cancels the other picks. At 1.50+ odds no pick wins much more than 65% of the time.';
}

// l: a slip leg { market, price, calProb }; slip: selectSlip's result.
function _slipReasoning(l, slip) {
    return `Daily slip leg: ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}, our calibrated chance ${_pct(l.calProb)}. `
        + `The two legs were chosen together as the pair most likely to win among all 1.50-2.20 markets that reach ${slip.odds.toFixed(2)}x, `
        + `about ${_pct(slip.chance)} for the pair by our numbers. Replay: 2-leg 2.5x slips won 46.7% of training days and 56.3% of the untouched test month.`;
}

// Sharp 4x leg fields and wording - ONE definition shared by the builder and
// the backfill (sharpLegRecords). `l` is a taken leg: { market, price, prob
// (BetPawa q), calProb (ours), cell, sharp: { slipOdds, totalOdds, bonusPct } }.
function _sharpExtras(l) {
    return {
        book_prob: l.prob,
        slip_odds: +l.sharp.slipOdds.toFixed(2),
        bonus_odds: +l.sharp.totalOdds.toFixed(2),
        bonus_pct: l.sharp.bonusPct,
    };
}

function _sharpReasoning(l) {
    return `Sharp 4x leg (BetPawa): ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}. BetPawa's own model gives ${_pct(l.prob)}; `
        + `walk-forward evidence from ${l.cell ? `${l.cell.n} settled legs in its market/price cell` : 'its market/price cell (no history yet)'} says ${_pct(l.calProb)}. `
        + `The 3-leg slip pays ${l.sharp.slipOdds.toFixed(2)}x, ${l.sharp.totalOdds.toFixed(2)}x with BetPawa's Win Bonus. `
        + 'Replay: won 24 of 85 days (28%); a positive-expectation card, never a daily guarantee.';
}

// Stored leg records for a selectSharpCard() result (the backfill path; the
// builder maps its legs through the same helpers). `fxInfo`: Map(fixture id ->
// { home_name, away_name, league, kickoff }).
export function sharpLegRecords(card, cal, fxInfo, cardIndex, extra = {}) {
    const sharpMeta = { slipOdds: card.slipOdds, totalOdds: card.totalOdds, bonusPct: card.bonus.pct };
    return card.legs.map(leg => {
        const f = fxInfo.get(leg.fixture) ?? {};
        const l = { market: leg.market, price: leg.price, prob: leg.q, calProb: leg.P, cell: cal.cell(leg), sharp: sharpMeta };
        return {
            fixture_id: leg.fixture,
            home: f.home_name ?? null, away: f.away_name ?? null, league: f.league ?? null,
            kickoff: f.kickoff instanceof Date ? f.kickoff.toISOString() : (f.kickoff ?? null),
            market: l.market, label: tipMarketLabel(l.market),
            price: l.price, prices: { betpawa: l.price }, links: {},
            prob: l.prob, cal_prob: l.calProb, cell: l.cell, cell_key: cellKey(l),
            card: cardIndex, kind: 'sharp', tier_label: 'Sharp 4x (BetPawa)',
            ..._sharpExtras(l),
            reasoning: _sharpReasoning(l),
            outcome: null,
            ...extra,
        };
    });
}

// Build (or refresh) the slip for `date` (EAT date string, default today).
// Returns { date, frozen } | { date, slip } | { date, noSlip } | { date, dryRun, row }.
// dryRun: compute the row exactly as published but never write it (and skip
// the freeze check, which only guards writes) - for read-only verification.
//
// v3 (2026-10-16, owner directive): the card is the day's TOP 3 PICKS - the
// three games whose Pick (src/db/pick-rules.js, written by the sweep into
// fixture_predictions just before this step) carries the highest calibrated
// win chance, every one priced 1.50-2.20. Each pick is a single stake, shown
// in kickoff order as the day's path; the settle pass scores the day
// ("2 of 3 won, +0.04u"). The gen-2 ladder, Hunter singles and the Sharp 4x
// card are no longer built (their modules stay for the history rows and the
// restore path of scripts/backfill-sharp.js). `opts` passes through to
// selectTopPicks (e.g. { cardSize }).
export async function buildDailySlip(date = null, { opts = null, algoVersion = ALGO_VERSION, dryRun = false } = {}) {
    // DATE_FORMAT keeps the day a STRING inside the pinned +03:00 session
    // (the magic.js idiom) - a bare CURDATE() decodes to a JS Date that
    // toISOString() shifts back 3 hours, off-by-one-day before 03:00 EAT.
    const [{ today, now }] = (await db.raw(
        "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today, NOW() as now"))[0];
    const slipDate = date ?? today;

    // Freeze check: never rewrite a row whose day has started (any stored leg
    // kicked off) or that is already settled.
    const existing = dryRun ? null : await db('daily_slips').where('slip_date', slipDate).first();
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
        .join('fixture_predictions as fp', 'fp.fixture_id', 'f.id')
        .whereRaw('DATE(f.kickoff) = ?', [slipDate])
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereNotNull('fp.tip_banker_cal')
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.kickoff', 'l.name as league', 'th.name as home_name', 'ta.name as away_name',
            'fp.tip_banker_market', 'fp.tip_banker_price', 'fp.tip_banker_prob', 'fp.tip_banker_cal');

    const games = targets.map(f => {
        const v = pickView(f);
        return {
            id: f.id, kickoff: f.kickoff instanceof Date ? f.kickoff.toISOString() : f.kickoff, f,
            pick: v ? { market: v.market, price: v.price, prob: v.prob, calProb: v.cal } : null,
        };
    });
    const top = selectTopPicks(games, { ...DEFAULT_PICK, ...(opts ?? {}) });

    // Every non-stale price of the day's games, chunked by fixture (the
    // 2026-08-23 rule: one IN (...) over a whole slate is killed by the host).
    // Feeds the slip's candidate menus AND the per-provider display prices.
    const rowsByFixture = new Map();
    const targetIds = targets.map(f => f.id);
    const namesById = new Map(targets.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]));
    const menus = new Map();
    for (let i = 0; i < targetIds.length; i += SETTLED_WINDOW_CHUNK) {
        const chunk = await db('odds_markets as om')
            .join('matches as m', 'm.id', 'om.match_id')
            .whereIn('m.fixture_id', targetIds.slice(i, i + SETTLED_WINDOW_CHUNK))
            .where('om.is_stale', 0)
            .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price', 'om.probability');
        const grouped = _menusByFixture(chunk, namesById);
        for (const [id, menu] of grouped.menus) menus.set(id, menu);
        for (const [id, rows] of grouped.byFixture) rowsByFixture.set(id, rows);
    }

    // The daily slip (pick-rules selectSlip): 2 legs, one per game, 1.50-2.20
    // each, combined >= 2.5x, chosen by OUR calibrated chances. A leg may not
    // contradict its game's Pick (the table and the card must agree).
    // Dynamic import: picks.js imports this module, so a static import would
    // be a cycle.
    const { todaysPickCalibrator } = await import('./picks.js');
    const pickCal = await todaysPickCalibrator().catch(e => {
        console.error(`[daily-slip] pick calibrator unavailable, no slip today: ${e.message}`);
        return null;
    });
    const cands = [];
    if (pickCal) {
        for (const g of games) {
            for (const l of menus.get(g.id) ?? []) {
                if (!isPick(l.market, l.price) || !(l.prob > 0 && l.prob < 1)) continue;
                if (g.pick && contradicts(g.pick.market, l.market)) continue;
                cands.push({ fixture: g.id, game: g, market: l.market, price: Number(l.price), prob: Number(l.prob),
                    calProb: Math.round(pickCal.prob(l) * 10000) / 10000 });
            }
        }
    }
    const slip = selectSlip(cands, { ...DEFAULT_SLIP, ...(opts?.slip ?? {}) });
    const slipLegs = slip
        ? [...slip.legs].sort((a, b) => (Date.parse(a.game.kickoff) || 0) - (Date.parse(b.game.kickoff) || 0))
        : [];

    // Live match links (completed matches excluded) for every game on a card.
    const ids = [...new Set([...top.map(g => g.id), ...slipLegs.map(l => l.fixture)])];
    const linksByFixture = new Map();
    const linkRows = ids.length ? await db('matches').whereIn('fixture_id', ids).whereNull('completed_at')
        .select('fixture_id', 'provider', 'match_url') : [];
    for (const r of linkRows) {
        if (!r.match_url) continue;
        let m = linksByFixture.get(r.fixture_id);
        if (!m) linksByFixture.set(r.fixture_id, m = {});
        m[r.provider] = r.match_url;
    }

    const _leg = (g, l, extra) => ({
        fixture_id: g.id,
        home: g.f.home_name, away: g.f.away_name, league: g.f.league,
        kickoff: g.kickoff,
        market: l.market, label: tipMarketLabel(l.market),
        price: l.price, prices: _providerPrices(rowsByFixture.get(g.id), l.market),
        links: linksByFixture.get(g.id) ?? {},
        prob: l.prob, cal_prob: l.calProb, cell_key: cellKey(l),
        outcome: null,
        ...extra,
    });
    const legs = [
        ...top.map((g, i) => _leg(g, g.pick, {
            card: i, kind: 'pick', tier_label: 'Top picks', reasoning: _pickReasoning(g.pick, i + 1, top.length),
        })),
        ...slipLegs.map(l => _leg(l.game, l, {
            card: top.length, kind: 'slip', tier_label: `Daily slip ${slip.odds.toFixed(2)}x`,
            slip_odds: slip.odds, slip_chance: slip.chance,
            reasoning: _slipReasoning(l, slip),
        })),
    ];

    const size = { ...DEFAULT_PICK, ...(opts ?? {}) }.cardSize;
    const row = legs.length ? {
        slip_date: slipDate,
        status: 'published',
        mood: top.length >= size && slip ? 'green' : 'amber',
        legs: JSON.stringify(legs),
        // The slip's combined price; the Top picks are singles and carry none.
        combined_odds: slip ? slip.odds : null,
        legs_total: legs.length,
        cards_total: top.length + (slip ? 1 : 0),
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

    if (dryRun) return { date: slipDate, dryRun: true, row };

    // Explicit merge list (knex-on-MySQL onConflict trap): settle columns and
    // backfilled are deliberately absent.
    await db('daily_slips').insert(row).onConflict('slip_date')
        .merge(['status', 'mood', 'legs', 'combined_odds', 'legs_total', 'cards_total', 'algo_version', 'computed_at']);

    if (!legs.length) return { date: slipDate, noSlip: true, fixtures: targets.length };
    return { date: slipDate, slip: { mood: row.mood, picks: top.length, slip_odds: slip?.odds ?? null } };
}

// Settle pending slips from canonical final scores. Cheap (SQL + pure
// tipOutcome/rollup, no fetches), light-pass safe. Leg outcomes persist into
// the JSON; outcome/legs_hit/settled_at written exactly once per slip.
// A leg whose fixture never reaches a terminal status (postponed/cancelled/
// upstream zombie) VOIDS after this many days past kickoff - the bookmaker
// behavior (leg odds collapse to 1), and what lets a day with one dead
// fixture still resolve won/lost instead of hanging pending forever.
const LEG_RETIRE_DAYS = 7;

export async function settleDailySlips() {
    // Selection deliberately includes DECIDED days that still carry ungraded
    // legs: one early miss settles the day verdict (any miss = lost), but the
    // remaining legs must keep grading as their fixtures finalize - the
    // 2026-08-06/07 live rows froze at legs_hit=1 with true 7/10 legs (and a
    // true 2-cards-won day reported 0) because whereNull('outcome') excluded
    // them from every later pass.
    const pending = await db('daily_slips')
        .where('status', 'published')
        .where(q => q.whereNull('outcome').orWhere('legs', 'like', '%"outcome":null%'))
        .select('id', 'legs', 'outcome');
    if (!pending.length) return { settled: 0, pending: 0 };

    const legIds = new Set();
    const parsed = pending.map(r => ({
        id: r.id,
        outcome: r.outcome ?? null,
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
    const retireBefore = Date.now() - LEG_RETIRE_DAYS * 86_400_000;

    let settled = 0;
    for (const r of parsed) {
        let changed = false;
        for (const l of r.legs) {
            if (l.outcome != null) continue;
            const f = byId.get(l.fixture_id);
            if (!f) {
                const ko = Date.parse(l.kickoff);
                if (Number.isFinite(ko) && ko < retireBefore) { l.outcome = 'void'; changed = true; }
                continue;
            }
            try {
                l.outcome = tipOutcome(l.market, f.ft_home, f.ft_away);
                // The final score rides the leg (owner 2026-08-08): the UI
                // shows "2-1" beside hit/miss so the line-vs-outcome story
                // is visible on every slip line.
                l.score = `${f.ft_home}-${f.ft_away}`;
                changed = true;
            }
            catch (e) { debugLog(`daily-slip settle: unknown market key ${l.market} (${e.message})`); }
        }
        if (!changed) continue;
        // Day `outcome` = the ANCHOR card's strict result on v2 ladders (the
        // flagship 1.5x rung keeps the green-streak meaning); pre-v2 rows
        // fall back to the old safe-arm rule, and legacy/backfilled legs
        // carry no kind and all count. Other tiers ride cards_won only.
        // v3 Top-3 picks: singles, so the day is SCORED (picksDayScore) - won
        // when the settled picks made money, with the per-pick record in
        // legs_hit/cards_won - instead of rolled up as one parlay.
        // The 2-leg daily slip (kind 'slip', 2026-10-16) is one parlay card on
        // top: it adds to cards_won when both legs land, and decides the day
        // only on a day that published no picks.
        if (r.legs.some(l => l.kind === 'pick' || l.kind === 'slip')) {
            const pickLegs = r.legs.filter(l => l.kind === 'pick');
            const slipLegs = r.legs.filter(l => l.kind === 'slip');
            const score = picksDayScore(pickLegs);
            const slipRoll = slipLegs.length ? slipOutcomeRollup(slipLegs.map(l => l.outcome ?? null)).outcome : null;
            const patch = {
                legs: JSON.stringify(r.legs),
                legs_hit: r.legs.filter(l => l.outcome === 'hit').length,
                cards_won: score.won + (slipRoll === 'won' ? 1 : 0),
            };
            const dayOutcome = pickLegs.length ? score.outcome : slipRoll;
            if (r.outcome == null && dayOutcome != null) { patch.outcome = dayOutcome; patch.settled_at = db.fn.now(); settled++; }
            await db('daily_slips').where('id', r.id).update(patch);
            continue;
        }
        const anchorLegs = r.legs.filter(l => l.kind === 'anchor');
        const safeLegs = anchorLegs.length ? anchorLegs : r.legs.filter(l => l.kind !== 'value' && l.kind !== 'sharp');
        const roll = slipOutcomeRollup((safeLegs.length ? safeLegs : r.legs).map(l => l.outcome ?? null));
        const patch = {
            legs: JSON.stringify(r.legs),
            legs_hit: r.legs.filter(l => l.outcome === 'hit').length,
        };
        // Per-card rollups (v1.3): cards_won counts cards whose every leg
        // settled green; `outcome` keeps the STRICT all-cards meaning.
        const byCard = new Map();
        for (const l of r.legs) {
            if (l.kind === 'hunter') continue;   // singles: never a parlay rollup
            const k = l.card ?? 0;
            let list = byCard.get(k); if (!list) byCard.set(k, list = []);
            list.push(l.outcome ?? null);
        }
        patch.cards_won = [...byCard.values()]
            .filter(list => slipOutcomeRollup(list).outcome === 'won').length;
        // Stamp the day verdict exactly once; late leg grades on an already-
        // decided day update legs/legs_hit/cards_won without touching it.
        if (r.outcome == null && roll.outcome != null) { patch.outcome = roll.outcome; patch.settled_at = db.fn.now(); settled++; }
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
    coverage: coverageFor(r.day),
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
