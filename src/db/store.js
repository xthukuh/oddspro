import { db } from './connection.js';
import { diffOddsRows } from './odds-diff.js';
import { withRetry } from './retry-rules.js';

// Bulk insert chunk size for odds market rows
const MARKETS_CHUNK = 200;

// Map a standardized fetcher record to a `matches` row.
// Note: `completed_at` and `fixture_id` are intentionally excluded - they are
// owned by the results/link actions and must survive odds refreshes.
function _matchRow(g) {
    return {
        provider: g.provider,
        provider_match_id: g.match_id,
        match_url: g.match_url,
        start_time: g.start_time,
        home_team_id: g.home_team_id,
        home_team_name: g.home_team_name,
        away_team_id: g.away_team_id,
        away_team_name: g.away_team_name,
        home_score_first_half: g.home_score_first_half,
        home_score_second_half: g.home_score_second_half,
        home_score_fulltime: g.home_score_fulltime,
        away_score_first_half: g.away_score_first_half,
        away_score_second_half: g.away_score_second_half,
        away_score_fulltime: g.away_score_fulltime,
        region_id: g.region_id,
        region_name: g.region_name,
        category_id: g.category_id,
        category_name: g.category_name,
        competition_id: g.competition_id,
        competition_name: g.competition_name,
        metadata: g.metadata,
    };
}

// Map standardized market entries to `odds_markets` rows (drops invalid prices)
function _marketRows(match_id, markets) {
    const rows = [];
    for (const m of Array.isArray(markets) ? markets : []) {
        if (!Number.isFinite(m.price)) {
            console.warn(`[store] dropped market with invalid price (match ${match_id}): ${m.type_name} / ${m.name}`);
            continue;
        }
        rows.push({
            match_id,
            type_id: Number.isFinite(m.type_id) ? m.type_id : null,
            type_name: m.type_name,
            type_explainer: m.type_explainer ?? null,
            name: m.name,
            price: m.price,
            handicap: Number.isFinite(m.handicap) ? m.handicap : null,
            probability: Number.isFinite(m.probability) ? m.probability : null,
        });
    }
    return rows;
}

// Provider match ids already marked completed (from `from_start_time` onward).
// Scrapers use this to skip per-game detail requests for matches whose odds
// refreshes would be discarded anyway (fetch throttle rule).
export async function completedMatchIds(provider, from_start_time = null) {
    const query = db('matches')
        .select('provider_match_id')
        .where('provider', provider)
        .whereNotNull('completed_at');
    if (from_start_time) query.where('start_time', '>=', from_start_time);
    return new Set((await query).map(r => Number(r.provider_match_id)));
}

// Persist fetched provider games: upsert `matches` by (provider, provider_match_id),
// then refresh each match's `odds_markets` rows: markets present in the latest
// snapshot are replaced (delete + insert), markets that vanished are kept and
// flagged stale (last-seen price survives for display; see odds-diff.js).
// Matches already marked completed are skipped entirely (fetch throttle rule).
export async function saveMatches(games) {
    const counts = { inserted: 0, updated: 0, skipped: 0, markets: 0 };
    if (!Array.isArray(games) || !games.length) return counts;
    const provider = games[0].provider;
    const existing = await db('matches')
        .select('id', 'provider_match_id', 'completed_at')
        .where('provider', provider)
        .whereIn('provider_match_id', games.map(g => g.match_id));
    const byPid = new Map(existing.map(r => [Number(r.provider_match_id), r]));
    for (const g of games) {
        const found = byPid.get(Number(g.match_id));
        if (found?.completed_at) {
            counts.skipped++;
            continue;
        }
        // The per-match odds refresh is a delete+insert on odds_markets - the
        // classic InnoDB index-gap-lock deadlock site when a concurrent process
        // (another serve/CLI/cron) writes the same match's odds. The whole
        // transaction is idempotent (recomputes the diff), so retry it
        // transiently rather than aborting the refresh (see retry-rules.js).
        // `counts` is bumped inside so a retried attempt starts from a fresh diff.
        let inserted = false, updated = false, markets = 0;
        await withRetry(() => db.transaction(async trx => {
            inserted = updated = false;
            markets = 0;
            let match_id;
            if (found) {
                match_id = found.id;
                // Explicit bump: ON UPDATE CURRENT_TIMESTAMP skips no-op updates,
                // but updated_at must reflect every odds refresh (UI freshness).
                await trx('matches').where('id', match_id).update({ ..._matchRow(g), updated_at: db.fn.now() });
                updated = true;
            } else {
                const [id] = await trx('matches').insert(_matchRow(g));
                match_id = id;
                inserted = true;
            }
            const rows = _marketRows(match_id, g.markets);
            const existingOdds = await trx('odds_markets').where('match_id', match_id)
                .select('id', 'type_name', 'name', 'handicap', 'is_stale');
            const { staleIds, deleteIds } = diffOddsRows(existingOdds, rows);
            if (staleIds.length) await trx('odds_markets').whereIn('id', staleIds).update({ is_stale: true });
            if (deleteIds.length) await trx('odds_markets').whereIn('id', deleteIds).del();
            if (rows.length) await db.batchInsert('odds_markets', rows, MARKETS_CHUNK).transacting(trx);
            markets = rows.length;
        }));
        if (inserted) counts.inserted++;
        if (updated) counts.updated++;
        counts.markets += markets;
    }
    return counts;
}
