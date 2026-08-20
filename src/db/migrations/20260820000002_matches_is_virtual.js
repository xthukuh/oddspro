// Marks a bookmaker listing as a VIRTUAL (simulated) competition: Betika's
// `-Zoom` and `SRL` products, which are software-generated matches with no
// real-world counterpart.
//
// Why this needs a persisted column rather than a filter in the linker:
// API-Football will never cover a simulated fixture, so every one of these rows
// stays unlinked until the 4h completion fallback closes it - and the link pass
// runs every 10 minutes, re-scoring the whole open set each time. Measured on
// the warehouse 2026-08-20: 26,713 of 50,994 matches (52.4%) carry a virtual
// competition name, creation runs ~560/day, and each open row is re-scored
// against up to 84 candidate fixtures per pass. That is on the order of
// 15,000-17,000 wasted candidate queries and 1-1.5M similarity evaluations per
// day, plus the near-miss log noise that hides real correlation failures.
//
// The rows are NEVER deleted or hidden - they carry real bettable odds that the
// web layer still serves. The flag only tells the linker not to look for a
// canonical fixture that cannot exist.
//
// Classification is written at scrape time (src/db/store.js's `_matchRow`),
// because that is where the provider's own taxonomy is known, behind the pure
// `isVirtualCompetition` predicate in src/db/collector-rules.js. Indexed
// because the linker's open-row query filters on it.
//
// Specificity evidence at the time of writing: of 17,938 already-linked
// matches, ZERO carry a name the predicate matches, and no row in the canonical
// `leagues` table matches it either.
import { isVirtualCompetition } from '../collector-rules.js';

export async function up(knex) {
    await knex.schema.alterTable('matches', t => {
        t.boolean('is_virtual').notNullable().defaultTo(false)
            .comment('simulated competition (Betika -Zoom / SRL); linker skips it, it can have no canonical fixture');
        t.index(['is_virtual'], 'matches_is_virtual_index');
    });

    // Backfill through the SAME pure predicate the scrapers use, so the
    // historical rows and every future row can never be classified by two
    // different rules. Classify the 553 DISTINCT names rather than the 51k
    // rows, then apply as one windowed UPDATE per chunk.
    const names = (await knex('matches').distinct('competition_name'))
        .map(r => r.competition_name)
        .filter(n => isVirtualCompetition(n));
    for (let i = 0; i < names.length; i += 100) {
        await knex('matches')
            .whereIn('competition_name', names.slice(i, i + 100))
            .update({ is_virtual: true });
    }
}

export async function down(knex) {
    await knex.schema.alterTable('matches', t => {
        t.dropIndex(['is_virtual'], 'matches_is_virtual_index');
        t.dropColumn('is_virtual');
    });
}
