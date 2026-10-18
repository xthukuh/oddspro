import { z } from 'zod';

// One API-Football /odds response item (a fixture's lines from one
// bookmaker) + its row-shaping. Pure (zod-only, no config/db) so the parse
// contract is offline-testable, mirroring src/apisports-standings.js.
//
// Shape observed live 2026-10-18 (GET /odds?date=D&bookmaker=4&page=N):
//   { fixture: { id, date }, update: '2026-10-11T20:01:17+00:00',
//     bookmakers: [{ id: 4, name: 'Pinnacle', bets: [
//       { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.50' }, ...] },
//       { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.41' }, ...] } ] }] }
// Only bet 1 (Home/Draw/Away -> '1'/'X'/'2') and bet 5 at the .5 lines the
// engine prices (1.5, 2.5, 3.5) are kept; quarter and whole lines, halves
// and every other bet are ignored. Odds arrive as strings.

export const PINNACLE_BOOKMAKER_ID = 4;
const BET_MATCH_WINNER = 1;
const BET_GOALS_OU = 5;
const OU_LINES = new Set(['1.5', '2.5', '3.5']);
const WINNER = { Home: '1', Draw: 'X', Away: '2' };

const _odd = z.union([z.string(), z.number()]);

export const OddsItem = z.object({
    fixture: z.object({ id: z.number() }),
    update: z.string(),
    bookmakers: z.array(z.object({
        id: z.number(),
        bets: z.array(z.object({
            id: z.number(),
            values: z.array(z.object({ value: z.union([z.string(), z.number()]).nullable(), odd: _odd.nullable() })).nullable().optional(),
        })).nullable().optional(),
    })),
});

// ISO stamp with offset -> EAT wall-clock 'YYYY-MM-DD HH:mm:ss' (the
// warehouse stores every datetime as EAT wall clock); null when unreadable.
export function isoToEat(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

// One bet value -> engine market key, or null when the engine has no use for it.
export function marketKeyOf(betId, value) {
    const v = String(value ?? '').trim();
    if (betId === BET_MATCH_WINNER) return WINNER[v] ?? null;
    if (betId === BET_GOALS_OU) {
        const m = /^(Over|Under) (\d+\.5)$/.exec(v);
        return m && OU_LINES.has(m[2]) ? `${m[1] === 'Over' ? 'O' : 'U'} ${m[2]}` : null;
    }
    return null;
}

// Raw /odds items -> reference_odds rows for one bookmaker.
// A raw item zod cannot parse (or with an unreadable `update`) is skipped and
// reported, never thrown: one bad item must not abort the capture.
// Returns { rows: [{ fixture_id, bookmaker_id, market, price, source_updated_at }], skipped }.
export function buildReferenceRows(items, { bookmakerId = PINNACLE_BOOKMAKER_ID } = {}) {
    const byKey = new Map(), skipped = [];
    for (const raw of Array.isArray(items) ? items : []) {
        let it;
        try { it = OddsItem.parse(raw); } catch (error) { skipped.push({ raw, error }); continue; }
        const updated = isoToEat(it.update);
        if (!updated) { skipped.push({ raw, error: new Error('unreadable update stamp') }); continue; }
        const book = it.bookmakers.find(b => b.id === bookmakerId);
        for (const bet of book?.bets ?? []) {
            for (const v of bet.values ?? []) {
                const market = marketKeyOf(bet.id, v.value);
                const price = Number(v.odd);
                if (!market || !(price > 1) || !Number.isFinite(price)) continue;
                byKey.set(`${it.fixture.id}|${market}`, {
                    fixture_id: it.fixture.id, bookmaker_id: bookmakerId, market,
                    price: Math.round(price * 100) / 100, source_updated_at: updated,
                });
            }
        }
    }
    return { rows: [...byKey.values()], skipped };
}
