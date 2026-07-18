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

// Visitor tracking v2 (admin program M2): normalized beacon-driven analytics.
// The prod SPA is served statically by Apache, so page loads never reach
// Express - the client check-in beacon replaces the middleware as the tracking
// source of truth (the legacy flat `visits` log stays read-only history).
//
// - visitor_devices: one row per DISTINCT user agent (deduped by sha256 hash;
//   every known UA string is kept forever, per policy).
// - visitors: one identity per browser install (anon UUID from localStorage);
//   a signed-in check-in stamps user_id so one person's devices dedupe by
//   COALESCE(user_id, id) at read time. user_id is SET NULL on user deletion -
//   analytics history must survive account removal.
// - visit_sessions: one check-in..checkout span; duration is derived from
//   last_active_at (events double as heartbeats) or the checkout beacon.
//   session_key guards event ingestion (sids alone are guessable).
//   country/region/geo_status mirror `visits` so the geo backfill sweep works
//   on both tables through the same ip_geo cache.
// - visit_events: capped, name-validated feature interactions (no free text by
//   construction - see src/db/track-rules.js sanitizeEvents).
// All datetimes use the pinned +03:00 session tz (EAT wall-clock), matching
// the warehouse: DATE(started_at) = CURDATE() groups by local day.

export async function up(knex) {
    await knex.schema.createTable('visitor_devices', t => {
        t.bigIncrements('id').primary();
        t.string('ua_hash', 64).notNullable().unique();  // sha256 hex of user_agent
        t.string('user_agent', 512).notNullable();
        t.string('device_type', 16).nullable();          // mobile/tablet/desktop/bot
        t.string('browser', 64).nullable();
        t.string('os', 64).nullable();
        t.datetime('first_seen_at').notNullable().defaultTo(knex.fn.now());
        t.datetime('last_seen_at').notNullable().defaultTo(knex.fn.now());
        _base(knex, t);
    });

    await knex.schema.createTable('visitors', t => {
        t.bigIncrements('id').primary();
        t.string('anon_id', 36).notNullable().unique();  // client-generated UUID
        t.bigInteger('user_id').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.datetime('first_seen_at').notNullable().defaultTo(knex.fn.now());
        t.datetime('last_seen_at').notNullable().defaultTo(knex.fn.now());
        _base(knex, t);
        t.index(['user_id']);
    });

    await knex.schema.createTable('visit_sessions', t => {
        t.bigIncrements('id').primary();
        t.bigInteger('visitor_id').unsigned().notNullable()
            .references('id').inTable('visitors').onDelete('CASCADE');
        t.bigInteger('device_id').unsigned().notNullable()
            .references('id').inTable('visitor_devices').onDelete('CASCADE');
        t.string('session_key', 32).notNullable();       // random hex; event-ingest guard
        t.string('ip', 45).nullable().index();
        t.string('country', 64).nullable();              // resolved later (geo)
        t.string('region', 96).nullable();
        t.string('geo_status', 16).nullable().index();   // NULL=pending, resolved/unresolvable/private
        t.datetime('started_at').notNullable().defaultTo(knex.fn.now()).index();
        t.datetime('last_active_at').notNullable().defaultTo(knex.fn.now());
        t.datetime('ended_at').nullable();
        t.integer('duration_seconds').unsigned().nullable();
        t.string('entry_path', 512).nullable();
        t.string('referer', 512).nullable();
        t.integer('events_count').unsigned().notNullable().defaultTo(0);
        _base(knex, t);
        t.index(['visitor_id', 'started_at']);
    });

    await knex.schema.createTable('visit_events', t => {
        t.bigIncrements('id').primary();
        t.bigInteger('session_id').unsigned().notNullable()
            .references('id').inTable('visit_sessions').onDelete('CASCADE');
        t.string('name', 48).notNullable();
        t.string('value', 32).nullable();
        t.datetime('occurred_at').notNullable().defaultTo(knex.fn.now());
        _base(knex, t);
        t.index(['name', 'occurred_at']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('visit_events');
    await knex.schema.dropTableIfExists('visit_sessions');
    await knex.schema.dropTableIfExists('visitors');
    await knex.schema.dropTableIfExists('visitor_devices');
}
