// GET /api/columns rebuilds the market catalog with a
// GROUP BY (type_name, name, handicap) + COUNT(DISTINCT match_id) over
// odds_markets. That table is now 2.4M rows / 17k distinct type_names (the
// Betika dynamic tail) and carried no index on those columns - only
// (match_id, type_id) - so MySQL full-scanned and filesorted it on every call
// (EXPLAIN: type=ALL, key=NULL, Using filesort). The request did not return
// inside 3 minutes, which starved BOTH the settings modal and the table's
// dynamic market columns.
//
// match_id comes last so COUNT(DISTINCT match_id) is answered from the index
// as well, making the whole aggregation covering: type=index / Using index.
// Measured on the live warehouse: >180,000ms (never completed) -> 866ms.
export async function up(knex) {
    await knex.raw('CREATE INDEX odds_markets_catalog_index ON odds_markets (type_name, name, handicap, match_id)');
}

export async function down(knex) {
    await knex.raw('DROP INDEX odds_markets_catalog_index ON odds_markets');
}
