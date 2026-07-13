const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// Common table setup: charset + created_at/updated_at maintained by MySQL.
function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// Visitor traffic log: one row per page navigation (the SPA index served to a
// browser). IP + user-agent are captured raw; device/browser/os are parsed from
// the UA at log time (src/db/visit-rules.js). country/region are nullable - the
// current policy is "store IP now, resolve geo later", so a later pass can
// backfill them from the IP without touching the write path. `visited_at` uses
// the pinned +03:00 session tz (EAT wall-clock), so DATE(visited_at)=CURDATE()
// groups by the local day like every other table.

export async function up(knex) {
    await knex.schema.createTable('visits', t => {
        t.bigIncrements('id').primary();
        t.datetime('visited_at').notNullable().defaultTo(knex.fn.now()).index();
        t.string('ip', 45).nullable();               // IPv4/IPv6 (raw)
        t.string('user_agent', 512).nullable();
        t.string('device_type', 16).nullable();      // mobile/tablet/desktop/bot
        t.string('browser', 64).nullable();
        t.string('os', 64).nullable();
        t.string('referer', 512).nullable();
        t.string('path', 512).nullable();            // landing path
        t.string('country', 64).nullable();          // resolved later (geo)
        t.string('region', 96).nullable();           // resolved later (geo)
        _base(knex, t);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('visits');
}
