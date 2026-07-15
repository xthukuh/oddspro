const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// v1.1.0 dynamic settings + cross-device preference sync.
//   settings   - admin-editable overrides for a CURATED subset of operational
//                env knobs (SAFE_*, thresholds, cadences, feature flags). Only
//                overridden keys have rows; the effective value = override over
//                the config default, merged late per request (src/settings.js,
//                mirroring magic.js#safePolicy). `key` = the env var name.
//   user_prefs - one JSON blob per user of their oddspro.* preferences (magic
//                sort, betslip, filters, display, sorts), synced across devices
//                with last-write-wins by `version` then updated_at.

export async function up(knex) {
    await knex.schema.createTable('settings', t => {
        t.string('key', 64).primary();                          // = env var name
        t.text('value').notNullable();                          // stored as string, typed by the catalog
        t.bigInteger('updated_by').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        _base(knex, t);
    });

    await knex.schema.createTable('user_prefs', t => {
        t.bigInteger('user_id').unsigned().notNullable().primary()
            .references('id').inTable('users').onDelete('CASCADE');
        t.json('data').notNullable();                           // collectConfig() map (device keys excluded)
        t.integer('version').unsigned().notNullable().defaultTo(1); // monotonic LWW clock
        _base(knex, t);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('user_prefs');
    await knex.schema.dropTableIfExists('settings');
}
