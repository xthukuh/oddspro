const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// Geo backfill support (src/geo.js). `visits.geo_status` marks each row's
// resolution state so a processed row is never re-scanned:
//   NULL         - pending (new visit, not yet backfilled)
//   'resolved'   - country/region filled from ip_geo
//   'unresolvable' - the geo provider couldn't place the IP (or the IP is null)
//   'private'    - a private/reserved/loopback IP (never sent to the provider)
// `ip_geo` caches one lookup per distinct IP so an IP is resolved at most once
// ever; unresolvable/private IPs stay cached and are skipped in later sweeps.

export async function up(knex) {
    await knex.schema.alterTable('visits', t => {
        t.string('geo_status', 16).nullable().index(); // NULL = pending backfill
    });

    await knex.schema.createTable('ip_geo', t => {
        t.string('ip', 45).primary();
        t.string('country', 64).nullable();
        t.string('region', 96).nullable();
        t.string('status', 16).notNullable(); // resolved | unresolvable | private
        t.datetime('resolved_at').notNullable();
        _base(knex, t);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('ip_geo');
    await knex.schema.alterTable('visits', t => {
        t.dropColumn('geo_status');
    });
}
